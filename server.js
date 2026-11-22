// Brim: static files + the WebSocket game server, in one Node process.
//
// A room is a party: phones join with a 4-letter code (or the QR on a big screen) and
// pick a team. A match is a relay: each leg, one runner per team carries a phone-glass
// of drink around the room and back, then pours what's left into the next runner's
// phone. The drink simulation runs on the runner's phone, which reports how much is
// left; the server keeps the relay's clock and order, relays the pours, and referees
// the mischief cards everyone else throws at the runners.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { WebSocketServer, WebSocket } from "ws";
import { V0_ML, FILLS, MODES, CARDS, CHARGE, TELEGRAPH_MS, IMMUNE_MS, TIMING, FILL_TARGET } from "./public/js/rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT) || 3120;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const QR_JS = require.resolve("qrcode-generator/qrcode.js");

const MAX_PLAYERS = 16;
const MAX_DISPLAYS = 4;
const MAX_ROOMS = 300;
const NAME_MAX = 14;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOBBY_DROP_MS = 45000;
const EMPTY_ROOM_MS = 120000;
const TEL_EVERY_MS = 100;

// TIME_SCALE < 1 speeds every phase up; only the headless test harness sets it.
const TS = Math.min(1, Math.max(0.02, Number(process.env.TIME_SCALE) || 1));
const T = Object.fromEntries(Object.entries(TIMING).map(([k, v]) => [k, Math.round(v * TS)]));
const CH = {
  teamMs: CHARGE.teamMs * TS, teamMax: CHARGE.teamMax, teamStart: CHARGE.teamStart,
  heckMs: CHARGE.heckMs * TS, heckMax: CHARGE.heckMax, heckStart: CHARGE.heckStart,
};
const TELE = TELEGRAPH_MS * TS;
const IMMUNE = IMMUNE_MS * TS;
const CD = Object.fromEntries(Object.entries(CARDS).map(([k, v]) => [k, v.cd * TS]));

// ---------- static files ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function sendFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const mtime = st.mtime.toUTCString();
    if (req.headers["if-modified-since"] === mtime) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Content-Length": st.size,
      "Last-Modified": mtime,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(filePath).pipe(res);
  });
}

function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  if (urlPath === "/vendor/qrcode.js") return sendFile(req, res, QR_JS);
  if (urlPath.endsWith("/")) urlPath += "index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  sendFile(req, res, filePath);
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, maxPayload: 4096 });

// ---------- helpers ----------
function sendRaw(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1 << 18) ws.send(data);
}
function send(ws, msg) { sendRaw(ws, JSON.stringify(msg)); }
function bcast(room, msg, except = null) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.connected && p.ws !== except) sendRaw(p.ws, data);
  for (const ws of room.displays) if (ws !== except) sendRaw(ws, data);
}
function cleanName(s) {
  return String(s || "").replace(/[\u0000-\u001f\u007f<>&"]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}
function num(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
const r1 = (x) => Math.round(x * 10) / 10;
function randomCode() {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
}

// ---------- rooms ----------
const rooms = new Map();

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.displays = new Set();
    this.leader = null;
    this.phase = "lobby"; // lobby | match | over
    this.settings = { mode: "race", fill: "brim", legs: 1, mischief: true };
    this.match = null;
    this.last = null;
    this.nextId = 1;
    this.emptySince = null;
    this.timers = new Map();
    this.rosterQueued = false;
    this.matchQueued = false;
    this.telTimer = null;
  }
  connected() { return [...this.players.values()].filter((p) => p.connected); }
  hasAnyone() { return this.displays.size > 0 || this.connected().length > 0; }
  teamOf(t) { return [...this.players.values()].filter((p) => p.team === t); }
}

function makeRoom() {
  if (rooms.size >= MAX_ROOMS) return null;
  let code;
  do code = randomCode(); while (rooms.has(code));
  const room = new Room(code);
  rooms.set(code, room);
  return room;
}

function timer(room, key, ms, fn) {
  clearTimeout(room.timers.get(key));
  room.timers.set(key, setTimeout(() => {
    room.timers.delete(key);
    if (rooms.get(room.code) === room) fn();
  }, Math.max(0, ms)));
}
function clearTimers(room) {
  for (const t of room.timers.values()) clearTimeout(t);
  room.timers.clear();
  clearInterval(room.telTimer);
  room.telTimer = null;
}
function dropRoom(room) {
  clearTimers(room);
  rooms.delete(room.code);
}

function roomMsg(room) {
  return {
    t: "room",
    code: room.code,
    phase: room.phase,
    leader: room.leader,
    displays: room.displays.size,
    settings: room.settings,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, ready: p.ready, connected: p.connected })),
  };
}
function rosterChanged(room) {
  if (room.rosterQueued) return;
  room.rosterQueued = true;
  setImmediate(() => {
    room.rosterQueued = false;
    if (rooms.get(room.code) === room) bcast(room, roomMsg(room));
  });
}
function pickLeader(room) {
  const cur = room.players.get(room.leader);
  if (cur && cur.connected) return;
  const next = room.connected()[0] || [...room.players.values()][0] || null;
  room.leader = next ? next.id : null;
}
function smallerTeam(room) {
  const a = room.teamOf(0).length, b = room.teamOf(1).length;
  return a <= b ? 0 : 1;
}

// ---------- match state ----------
function budget(ms, max, start) {
  return { charges: start, chargeAt: Date.now() + ms, cd: {}, ms, max };
}
function refresh(b, now = Date.now()) {
  if (b.charges >= b.max) { b.chargeAt = now + b.ms; return b; }
  while (b.charges < b.max && now >= b.chargeAt) { b.charges++; b.chargeAt += b.ms; }
  if (b.charges >= b.max) b.chargeAt = now + b.ms;
  return b;
}

function newTeam(idx, order) {
  return {
    idx, order, leg: 0, phase: "wait", runner: order[0], from: null,
    at: 0, goAt: 0, endsAt: 0,
    vol: V0_ML, cap: 0, pourVol: 0, poured: 0, pourLeft: 0,
    legs: [], final: null, doneAt: null,
    b: budget(CH.teamMs, CH.teamMax, CH.teamStart),
    immuneUntil: 0, tel: null, telDirty: false, lostAt: 0,
  };
}

function teamPub(m, tm) {
  refresh(tm.b);
  return {
    idx: tm.idx, order: tm.order, leg: tm.leg, phase: tm.phase, runner: tm.runner, from: tm.from,
    at: tm.at, goAt: tm.goAt, endsAt: tm.endsAt,
    vol: r1(tm.vol), cap: r1(tm.cap), pourVol: r1(tm.pourVol), poured: r1(tm.poured),
    charges: tm.b.charges, chargeAt: tm.b.chargeAt, cd: tm.b.cd, immuneUntil: tm.immuneUntil,
    final: tm.final == null ? null : r1(tm.final), doneAt: tm.doneAt,
    legs: tm.legs.map(legPub),
  };
}
function legPub(l) {
  return {
    runner: l.runner, cap: r1(l.cap), startMl: l.startMl == null ? null : r1(l.startMl), endMl: l.endMl == null ? null : r1(l.endMl),
    ms: l.ms, steps: l.steps, spill: r1(l.spill), leak: r1(l.leak), handoff: r1(l.handoff), forced: l.forced, skipped: l.skipped,
  };
}
function matchMsg(room) {
  const m = room.match;
  const heck = {};
  for (const [pid, b] of m.heck) { refresh(b); heck[pid] = { charges: b.charges, chargeAt: b.chargeAt, cd: b.cd }; }
  return {
    t: "match", id: m.id, solo: m.solo, mode: m.mode, fill: m.fill, mischief: m.mischief, legsTotal: m.legsTotal,
    phase: m.phase, introEnd: m.introEnd, now: Date.now(),
    teams: m.teams.map((tm) => teamPub(m, tm)), heck,
  };
}
function matchChanged(room) {
  if (room.matchQueued || !room.match) return;
  room.matchQueued = true;
  setImmediate(() => {
    room.matchQueued = false;
    if (rooms.get(room.code) === room && room.match) bcast(room, matchMsg(room));
  });
}

// Who is tied up with a glass right now (and so can't throw cards)?
function busyIn(m, pid) {
  for (const tm of m.teams) {
    if (tm.phase === "done" || tm.phase === "wait") continue;
    if (tm.runner === pid && ["fill", "refill", "ready", "run", "pour"].includes(tm.phase)) return tm;
    if (tm.from === pid && tm.phase === "pour") return tm;
  }
  return null;
}

function startMatch(room) {
  const ps = room.connected().filter((p) => p.ready);
  const teamPs = ps.filter((p) => p.team === 0 || p.team === 1);
  if (!teamPs.length) return "Nobody's ready: tap “Pick up your glass” first.";
  const s = room.settings;
  const solo = teamPs.length === 1;
  let teams;
  if (solo) {
    if (teamPs[0].team !== 0) { teamPs[0].team = 0; rosterChanged(room); }
    teams = [[teamPs[0].id]];
  } else {
    let a = teamPs.filter((p) => p.team === 0), b = teamPs.filter((p) => p.team === 1);
    if (!a.length || !b.length) {
      // everyone picked the same side: split them by join order
      const all = [...a, ...b].sort((x, y) => x.id - y.id);
      a = all.filter((_, i) => i % 2 === 0);
      b = all.filter((_, i) => i % 2 === 1);
      for (const p of a) p.team = 0;
      for (const p of b) p.team = 1;
      rosterChanged(room);
    }
    // a fresh running order every match
    const mix = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
    teams = [mix(a.map((p) => p.id)), mix(b.map((p) => p.id))];
  }
  const legsTotal = Math.min(12, Math.max(...teams.map((t) => t.length)) * (s.legs === 2 ? 2 : 1));
  const m = {
    id: crypto.randomInt(1, 2 ** 31 - 1),
    solo,
    mode: solo ? "race" : s.mode,
    fill: s.fill,
    mischief: !!s.mischief,
    legsTotal,
    phase: "intro",
    introEnd: Date.now() + (solo ? Math.round(T.intro * 0.6) : T.intro),
    teams: [],
    heck: new Map(),
    fxSeq: 0,
    chaosAt: 0,
    cards: {},
    seen: new Set(teamPs.map((p) => p.id)),
  };
  teams.forEach((ids, i) => {
    // the running order cycles through the team until every leg has a runner
    const order = [];
    for (let k = 0; k < legsTotal; k++) order.push(ids[k % ids.length]);
    m.teams.push(newTeam(i, order));
  });
  // everyone not running in this match (hecklers, latecomers, the unready) heckles
  for (const p of room.players.values()) {
    if (!m.teams.some((tm) => tm.order.includes(p.id))) m.heck.set(p.id, budget(CH.heckMs, CH.heckMax, CH.heckStart));
  }
  room.match = m;
  room.phase = "match";
  room.last = null;
  clearTimers(room);
  matchChanged(room);
  rosterChanged(room);
  timer(room, "intro", m.introEnd - Date.now(), () => beginLive(room));
  room.telTimer = setInterval(() => fanTel(room), TEL_EVERY_MS);
  return null;
}

function beginLive(room) {
  const m = room.match;
  if (!m || m.phase !== "intro") return;
  m.phase = "live";
  if (m.mode === "turns") beginLeg(room, m.teams[0], 0);
  else for (const tm of m.teams) beginLeg(room, tm, 0);
  if (m.solo && m.mischief) m.chaosAt = Date.now() + 7000 * TS;
  if (m.solo && m.mischief) timer(room, "chaos", 500 * TS, () => chaosTick(room));
  matchChanged(room);
}

function isOn(room, pid) {
  const p = room.players.get(pid);
  return !!(p && p.connected);
}

// The first leg starts with the bartender pouring; later legs start with a pour from
// the previous runner (or a refill if they're the same person, or gone).
function beginLeg(room, tm, k) {
  const m = room.match;
  const now = Date.now();
  tm.leg = k;
  tm.at = now;
  tm.immuneUntil = 0;
  tm.tel = null;
  // a runner who isn't here hands over to the next teammate who is
  if (!isOn(room, tm.order[k])) {
    const ids = [...new Set(tm.order)];
    const sub = ids.find((id) => isOn(room, id));
    if (!sub) return teamOut(room, tm);
    tm.order[k] = sub;
  }
  tm.runner = tm.order[k];
  if (k === 0) {
    tm.cap = V0_ML / FILL_TARGET(m.fill);
    tm.vol = V0_ML;
    tm.from = null;
    tm.phase = "fill";
    tm.goAt = now + T.fill + T.count;
    tm.legs[k] = newLeg(tm.runner, tm.cap);
    timer(room, `t${tm.idx}`, tm.goAt - now, () => startRun(room, tm, k));
  } else {
    const prev = tm.order[k - 1];
    tm.cap = Math.max(1, tm.vol / FILL_TARGET(m.fill));
    tm.pourVol = tm.vol;
    tm.poured = 0;
    tm.pourLeft = tm.vol;
    tm.legs[k] = newLeg(tm.runner, tm.cap);
    if (prev === tm.runner || !isOn(room, prev)) {
      // nobody to pour: it goes straight into a fresh glass
      tm.from = null;
      tm.phase = "refill";
      tm.goAt = now + T.refill + T.count;
      tm.poured = tm.pourVol;
      timer(room, `t${tm.idx}`, tm.goAt - now, () => startRun(room, tm, k));
    } else {
      tm.from = prev;
      tm.phase = "pour";
      tm.endsAt = now + T.pourMax;
      tm.goAt = 0;
      timer(room, `t${tm.idx}`, T.pourMax, () => finishPour(room, tm, k, "timeout"));
    }
  }
  matchChanged(room);
}

function newLeg(runner, cap) {
  return { runner, cap, startMl: null, endMl: null, ms: null, steps: 0, spill: 0, leak: 0, handoff: 0, by: {}, forced: false, skipped: false, goAt: 0 };
}

function finishPour(room, tm, k, why) {
  if (tm.phase !== "pour" || tm.leg !== k) return;
  const rest = tm.pourVol - tm.poured;
  if (rest > 0.05) {
    // whatever didn't make it across glugs in by itself
    tm.poured = tm.pourVol;
    const msg = { t: "pourIn", team: tm.idx, leg: k, amt: r1(rest), total: r1(tm.poured), left: 0, auto: true };
    bcast(room, msg);
  }
  tm.phase = "ready";
  tm.pourLeft = 0;
  tm.goAt = Date.now() + T.ready;
  tm.endsAt = 0;
  timer(room, `t${tm.idx}`, T.ready, () => startRun(room, tm, k));
  matchChanged(room);
}

function startRun(room, tm, k) {
  if (tm.leg !== k || !["fill", "refill", "ready"].includes(tm.phase)) return;
  const now = Date.now();
  tm.phase = "run";
  tm.at = now;
  tm.endsAt = now + T.legMax;
  tm.lostAt = isOn(room, tm.runner) ? 0 : now;
  const leg = tm.legs[k];
  leg.goAt = now;
  if (leg.startMl == null) leg.startMl = k === 0 ? V0_ML : tm.pourVol;
  tm.vol = leg.startMl;
  timer(room, `t${tm.idx}`, T.legMax, () => endRun(room, tm, k, null, { forced: true }));
  matchChanged(room);
}

function endRun(room, tm, k, data, { forced = false, skipped = false } = {}) {
  if (tm.phase !== "run" || tm.leg !== k) return;
  const m = room.match;
  const now = Date.now();
  const leg = tm.legs[k];
  const start = leg.startMl == null ? tm.vol : leg.startMl;
  let end = tm.vol;
  if (data && Number.isFinite(Number(data.ml))) end = Math.min(end, num(data.ml, 0, start, end));
  end = Math.max(0, Math.min(start, end));
  leg.endMl = end;
  leg.ms = now - (leg.goAt || tm.at);
  leg.forced = forced;
  leg.skipped = skipped;
  if (data) {
    leg.steps = Math.round(num(data.st, 0, 5000, leg.steps));
    leg.spill = num(data.sp, 0, start, leg.spill);
    leg.leak = num(data.lk, 0, start, leg.leak);
    if (data.by && typeof data.by === "object") leg.by = cleanBy(m, data.by, start);
  } else if (tm.tel) {
    leg.steps = tm.tel.st;
    leg.spill = tm.tel.sp;
    leg.leak = tm.tel.lk;
  }
  tm.vol = end;
  tm.tel = null;
  clearTimeout(room.timers.get(`t${tm.idx}`));
  if (k >= m.legsTotal - 1) {
    tm.phase = "done";
    tm.final = end;
    tm.doneAt = now;
    tm.endsAt = 0;
    matchChanged(room);
    afterTeamDone(room);
    return;
  }
  if (m.mode === "turns") {
    tm.phase = "hold";
    tm.endsAt = 0;
    matchChanged(room);
    nextTurn(room, tm);
  } else {
    beginLeg(room, tm, k + 1);
  }
}

function cleanBy(m, by, cap) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(by)) {
    const pid = Number(k);
    if (!Number.isInteger(pid) || n++ > 20) continue;
    if (pid !== 0 && !m.seen.has(pid) && !m.heck.has(pid)) continue;
    out[pid] = r1(num(v, 0, cap, 0));
  }
  return out;
}

// turns mode: hand the floor to the other team if it still has legs to run
function nextTurn(room, justRan) {
  const m = room.match;
  const other = m.teams.find((t) => t !== justRan && t.phase !== "done");
  const pick = other || (justRan.phase !== "done" ? justRan : null);
  if (!pick) return finishMatch(room);
  if (pick.phase === "wait") beginLeg(room, pick, 0);
  else if (pick.phase === "hold") beginLeg(room, pick, pick.leg + 1);
}

function teamOut(room, tm) {
  // nobody left to run for this team: it banks what it has
  tm.phase = "done";
  tm.final = tm.vol;
  tm.doneAt = Date.now();
  for (let k = tm.leg; k < room.match.legsTotal; k++) {
    if (!tm.legs[k]) tm.legs[k] = newLeg(tm.order[k], tm.cap);
    const l = tm.legs[k];
    if (l.endMl == null) { l.skipped = true; l.startMl = l.startMl == null ? tm.vol : l.startMl; l.endMl = tm.vol; }
  }
  matchChanged(room);
  afterTeamDone(room);
}

function afterTeamDone(room) {
  const m = room.match;
  if (m.teams.every((t) => t.phase === "done")) {
    m.phase = "done";
    timer(room, "over", T.overDelay, () => finishMatch(room));
    matchChanged(room);
  } else if (m.mode === "turns") {
    const next = m.teams.find((t) => t.phase !== "done");
    if (next.phase === "wait") beginLeg(room, next, 0);
    else if (next.phase === "hold") beginLeg(room, next, next.leg + 1);
  }
}

function finishMatch(room) {
  const m = room.match;
  if (!m || room.phase !== "match") return;
  clearTimers(room);
  m.phase = "done";
  const teams = m.teams.map((tm) => ({ idx: tm.idx, final: r1(tm.final == null ? tm.vol : tm.final), legs: tm.legs.map(legPub) }));
  let winner = null;
  if (!m.solo) {
    const a = teams[0].final, b = teams[1].final;
    winner = Math.abs(a - b) < 0.5 ? -1 : a > b ? 0 : 1;
  }
  // awards
  const chaos = {};
  for (const tm of m.teams) for (const l of tm.legs) for (const [pid, ml] of Object.entries(l.by || {})) chaos[pid] = r1((chaos[pid] || 0) + ml);
  const awards = [];
  const legsAll = [];
  m.teams.forEach((tm) => tm.legs.forEach((l, k) => {
    if (l && !l.skipped && !l.forced && l.startMl > 0 && l.endMl != null) legsAll.push({ ...l, team: tm.idx, k, kept: l.endMl / l.startMl });
  }));
  if (legsAll.length >= 2 && !m.solo) {
    const best = legsAll.reduce((a, b) => (b.kept > a.kept ? b : a));
    awards.push({ id: "steady", pid: best.runner, label: "Steadiest hands", value: `kept ${Math.round(best.kept * 100)}%` });
    if (legsAll.length >= 3) {
      const worst = legsAll.reduce((a, b) => (b.kept < a.kept ? b : a));
      if (worst.runner !== best.runner || worst.k !== best.k) awards.push({ id: "butter", pid: worst.runner, label: "Butterfingers", value: `kept ${Math.round(worst.kept * 100)}%` });
    }
    const fast = legsAll.reduce((a, b) => (b.ms < a.ms ? b : a));
    if (!m.solo) awards.push({ id: "fast", pid: fast.runner, label: "Quickest leg", value: `${(fast.ms / 1000).toFixed(1)} s` });
  }
  const top = Object.entries(chaos).filter(([pid]) => pid !== "0").sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 1) awards.push({ id: "chaos", pid: Number(top[0]), label: "Chief saboteur", value: `${Math.round(top[1])} ml spilled` });
  const pours = [];
  m.teams.forEach((tm) => tm.legs.forEach((l, k) => { if (k > 0 && l && !l.skipped && tm.order[k - 1] !== l.runner && l.handoff != null) pours.push({ pid: tm.order[k - 1], loss: l.handoff }); }));
  if (pours.length >= 2) {
    const sm = pours.reduce((a, b) => (b.loss < a.loss ? b : a));
    awards.push({ id: "pour", pid: sm.pid, label: "Smoothest pour", value: sm.loss < 0.5 ? "not a drop" : `lost ${r1(sm.loss)} ml` });
  }
  room.phase = "over";
  for (const pl of room.players.values()) if (pl.late) { pl.late = false; pl.team = smallerTeam(room); }
  room.last = { t: "over", solo: m.solo, mode: m.mode, fill: m.fill, legsTotal: m.legsTotal, teams, winner, awards, chaos, cards: m.cards, id: m.id };
  bcast(room, matchMsg(room));
  bcast(room, room.last);
  rosterChanged(room);
}

// ---------- telemetry fan-out ----------
function fanTel(room) {
  const m = room.match;
  if (!m || room.phase !== "match") return;
  const d = [];
  for (const tm of m.teams) {
    if (!tm.telDirty || !tm.tel) continue;
    tm.telDirty = false;
    const t = tm.tel;
    d.push([tm.idx, tm.leg, t.ml, t.sp, t.st, t.gx, t.gz, t.gv]);
  }
  if (d.length) bcast(room, { t: "tels", d });
  // housekeeping for vanished runners and pourers
  const now = Date.now();
  for (const tm of m.teams) {
    if (tm.phase === "run") {
      if (isOn(room, tm.runner)) tm.lostAt = 0;
      else if (!tm.lostAt) tm.lostAt = now;
      else if (now - tm.lostAt > T.drop) endRun(room, tm, tm.leg, null, { forced: true });
    } else if (tm.phase === "pour") {
      if (!isOn(room, tm.from)) {
        if (!tm.lostAt) tm.lostAt = now;
        else if (now - tm.lostAt > 2500 * TS + 400) { tm.lostAt = 0; finishPour(room, tm, tm.leg, "gone"); }
      } else tm.lostAt = 0;
    }
  }
}

// ---------- mischief ----------
function playCard(room, p, cardId, teamIdx, isBot = false) {
  const m = room.match;
  const def = CARDS[cardId];
  if (!m || m.phase !== "live" || !def) return "Not now.";
  if (!m.mischief && !isBot) return "Mischief is off this game.";
  const tm = m.teams[teamIdx];
  if (!tm) return "No such team.";
  if (tm.phase !== "run") return "They're not running right now.";
  const now = Date.now();
  let b;
  if (isBot) {
    b = null;
  } else {
    if (busyIn(m, p.id)) return "You're holding a glass!";
    const onTeam = (p.team === 0 || p.team === 1) && !!m.teams[p.team] && m.teams[p.team].order.includes(p.id);
    if (def.kind === "help") {
      if (!onTeam || p.team !== teamIdx) return "Lids are for your own runner.";
    } else if (p.team === teamIdx && !m.solo) return "That's your own runner!";
    if (onTeam) b = m.teams[p.team].b;
    else {
      if (!m.heck.has(p.id)) m.heck.set(p.id, budget(CH.heckMs, CH.heckMax, CH.heckStart));
      b = m.heck.get(p.id);
      if (def.kind === "help") return "Hecklers don't get lids.";
    }
    refresh(b, now);
    if ((b.cd[cardId] || 0) > now) return "Still recharging.";
    if (b.charges < def.cost) return "Not enough charge.";
  }
  const landAt = now + TELE;
  if (def.kind === "hit" && landAt < tm.immuneUntil) return { why: "shielded", until: tm.immuneUntil };
  if (b) {
    const wasFull = b.charges >= b.max;
    b.charges -= def.cost;
    if (wasFull) b.chargeAt = now + b.ms;
    b.cd[cardId] = now + CD[cardId];
  }
  if (def.kind === "hit") tm.immuneUntil = landAt + IMMUNE;
  const fx = { t: "fx", id: ++m.fxSeq, card: cardId, from: isBot ? 0 : p.id, team: tm.idx, leg: tm.leg, landAt, seed: crypto.randomInt(1, 2 ** 31 - 1) };
  if (!isBot) m.cards[p.id] = (m.cards[p.id] || 0) + 1;
  bcast(room, fx);
  matchChanged(room);
  return null;
}

const CHAOS_CARDS = ["quake", "ice", "fizz", "frost", "swell", "ice"];
function chaosTick(room) {
  const m = room.match;
  if (!m || m.phase !== "live" || room.phase !== "match") return;
  const now = Date.now();
  const tm = m.teams[0];
  if (tm.phase === "run" && now >= m.chaosAt && now - tm.at > 2500 * TS) {
    const card = CHAOS_CARDS[crypto.randomInt(CHAOS_CARDS.length)];
    const r = playCard(room, null, card, 0, true);
    m.chaosAt = now + (r ? 900 : 6500 + crypto.randomInt(3500)) * TS;
  }
  timer(room, "chaos", 400 * TS, () => chaosTick(room));
}

// ---------- joining ----------
function newPlayer(room, ws, name) {
  const id = room.nextId++;
  const p = {
    id, key: crypto.randomBytes(9).toString("base64url"), name: name || `Player ${id}`,
    ws, connected: true, discAt: 0, ready: false, left: false,
    // joining mid-relay: heckle now, get a team when it's over
    team: room.phase === "match" ? -1 : smallerTeam(room),
    late: room.phase === "match",
  };
  room.players.set(id, p);
  if (!room.leader) room.leader = id;
  if (room.match && room.phase === "match" && p.team === -1) room.match.heck.set(id, budget(CH.heckMs, CH.heckMax, CH.heckStart));
  return p;
}
function attach(ws, room, p, display) {
  ws.room = room;
  ws.player = p || null;
  ws.isDisplay = display;
  if (display) room.displays.add(ws);
  room.emptySince = null;
  send(ws, { t: "joined", code: room.code, pid: p ? p.id : null, key: p ? p.key : null, display });
  send(ws, roomMsg(room));
  if (room.match) send(ws, matchMsg(room));
  if (room.phase === "over" && room.last) send(ws, room.last);
  rosterChanged(room);
}
function detach(ws, { forGood = false } = {}) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  if (ws.isDisplay) {
    room.displays.delete(ws);
  } else if (ws.player) {
    const p = ws.player;
    ws.player = null;
    if (p.ws === ws) {
      p.ws = null;
      p.connected = false;
      p.discAt = Date.now();
    }
    if (forGood) {
      const inMatch = room.match && room.phase === "match" && room.match.teams.some((tm) => tm.order.includes(p.id));
      if (inMatch) p.left = true;
      else room.players.delete(p.id);
    }
    pickLeader(room);
  }
  if (!room.hasAnyone()) room.emptySince = Date.now();
  rosterChanged(room);
}

function canHost(ws) {
  const room = ws.room;
  return !!room && (ws.isDisplay || (ws.player && room.leader === ws.player.id));
}

// ---------- sockets ----------
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.player = null;
  ws.isDisplay = false;
  ws.win = Date.now();
  ws.count = 0;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    const now = Date.now();
    if (now - ws.win > 1000) { ws.win = now; ws.count = 0; }
    if (++ws.count > 70) return; // flood guard
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;
    const room = ws.room;
    const p = ws.player;
    const m = room && room.match;

    switch (msg.t) {
      case "ping":
        send(ws, { t: "pong", c: msg.c, s: Date.now() });
        break;

      case "create": {
        detach(ws, { forGood: true });
        const r = makeRoom();
        if (!r) { send(ws, { t: "err", msg: "The server is full right now. Try again in a minute." }); return; }
        if (msg.display) attach(ws, r, null, true);
        else attach(ws, r, newPlayer(r, ws, cleanName(msg.name)), false);
        break;
      }

      case "join": {
        const code = String(msg.code || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
        const r = rooms.get(code);
        if (!r) { send(ws, { t: "err", code: "noroom", msg: "No room with that code. Check it and try again." }); return; }
        if (ws.room === r) return;
        detach(ws, { forGood: true });
        if (msg.display) {
          if (r.displays.size >= MAX_DISPLAYS) { send(ws, { t: "err", msg: "That room already has enough big screens." }); return; }
          attach(ws, r, null, true);
        } else {
          if (r.players.size >= MAX_PLAYERS) { send(ws, { t: "err", msg: `That room is full (${MAX_PLAYERS} players).` }); return; }
          attach(ws, r, newPlayer(r, ws, cleanName(msg.name)), false);
        }
        break;
      }

      case "rejoin": {
        const code = String(msg.code || "").toUpperCase().slice(0, 4);
        const r = rooms.get(code);
        const pl = r && r.players.get(Number(msg.pid));
        if (!pl || pl.left || pl.key !== msg.key) { send(ws, { t: "err", code: "norejoin", msg: "That game has ended." }); return; }
        if (ws.room && ws.room !== r) detach(ws, { forGood: true });
        if (pl.ws && pl.ws !== ws) {
          const old = pl.ws;
          old.room = null;
          old.player = null;
          try { old.close(4000, "replaced"); } catch {}
        }
        pl.ws = ws;
        pl.connected = true;
        pl.discAt = 0;
        pickLeader(r);
        attach(ws, r, pl, false);
        break;
      }

      case "ready": {
        if (!p) return;
        p.ready = true;
        rosterChanged(room);
        break;
      }

      case "name": {
        if (!p || room.phase === "match") return;
        const n = cleanName(msg.name);
        if (n) { p.name = n; rosterChanged(room); }
        break;
      }

      case "team": {
        if (!p || room.phase === "match") return;
        const t = msg.team === 0 || msg.team === 1 ? msg.team : -1;
        p.team = t;
        p.late = false;
        rosterChanged(room);
        break;
      }

      case "shuffle": {
        if (!canHost(ws) || room.phase === "match") return;
        const ps = [...room.players.values()].filter((x) => x.team === 0 || x.team === 1);
        for (let i = ps.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ps[i], ps[j]] = [ps[j], ps[i]]; }
        ps.forEach((x, i) => { x.team = i % 2; });
        rosterChanged(room);
        break;
      }

      case "settings": {
        if (!canHost(ws) || room.phase === "match") return;
        const s = room.settings;
        if (MODES[msg.mode]) s.mode = msg.mode;
        if (FILLS[msg.fill]) s.fill = msg.fill;
        if (msg.legs === 1 || msg.legs === 2) s.legs = msg.legs;
        if (typeof msg.mischief === "boolean") s.mischief = msg.mischief;
        rosterChanged(room);
        break;
      }

      case "start": {
        if (!canHost(ws) || room.phase === "match") return;
        const err = startMatch(room);
        if (err) send(ws, { t: "err", msg: err });
        break;
      }

      case "toLobby": {
        if (!canHost(ws) || room.phase !== "over") return;
        room.phase = "lobby";
        room.match = null;
        for (const [id, pl] of room.players) if (!pl.connected || pl.left) room.players.delete(id);
        pickLeader(room);
        bcast(room, { t: "lobby" });
        rosterChanged(room);
        break;
      }

      // ---- the runner's phone ----
      case "go": {
        if (!p || !m) return;
        const tm = m.teams.find((x) => x.runner === p.id && x.leg === msg.leg && ["fill", "refill", "ready", "run"].includes(x.phase));
        if (!tm) return;
        const leg = tm.legs[tm.leg];
        if (!leg || leg.endMl != null) return;
        const want = tm.leg === 0 ? V0_ML : tm.pourVol;
        const ml = num(msg.ml, 0, want + 0.5, want);
        if (leg.startMl == null || tm.phase !== "run" || now - (leg.goAt || now) < 3000) {
          leg.startMl = Math.min(want, ml);
          if (tm.leg > 0) leg.handoff = Math.max(0, tm.pourVol - leg.startMl);
          tm.vol = leg.startMl;
          matchChanged(room);
        }
        break;
      }

      case "tel": {
        if (!p || !m) return;
        const tm = m.teams.find((x) => x.runner === p.id && x.phase === "run" && x.leg === msg.leg);
        if (!tm) return;
        const ml = num(msg.ml, 0, tm.vol, tm.vol);
        tm.vol = ml;
        tm.tel = {
          ml: r1(ml), sp: r1(num(msg.sp, 0, 1e4, 0)), lk: r1(num(msg.lk, 0, 1e4, 0)), st: Math.round(num(msg.st, 0, 5000, 0)),
          gx: Math.round(num(msg.gx, -40, 40, 0) * 100) / 100, gz: Math.round(num(msg.gz, -40, 40, 0) * 100) / 100, gv: Math.round(num(msg.gv, -40, 40, 9.81) * 100) / 100,
        };
        tm.telDirty = true;
        if (msg.by && typeof msg.by === "object") tm.legs[tm.leg].by = cleanBy(m, msg.by, tm.legs[tm.leg].startMl || tm.vol);
        break;
      }

      case "arrive": {
        if (!p || !m) return;
        const tm = m.teams.find((x) => x.runner === p.id && x.phase === "run" && x.leg === msg.leg);
        if (!tm) return;
        endRun(room, tm, tm.leg, msg);
        break;
      }

      case "pour": {
        if (!p || !m) return;
        const tm = m.teams.find((x) => x.from === p.id && x.phase === "pour" && x.leg === msg.leg);
        if (!tm) return;
        const amt = num(msg.amt, 0, tm.pourVol - tm.poured, 0);
        if (amt <= 0) return;
        tm.poured += amt;
        tm.pourLeft = num(msg.left, 0, tm.pourVol, Math.max(0, tm.pourVol - tm.poured));
        bcast(room, { t: "pourIn", team: tm.idx, leg: tm.leg, amt: Math.round(amt * 100) / 100, total: r1(tm.poured), left: r1(tm.pourLeft) }, ws);
        if (tm.pourVol - tm.poured < 0.05) finishPour(room, tm, tm.leg, "done");
        break;
      }

      case "pourDone": {
        if (!p || !m) return;
        const tm = m.teams.find((x) => x.from === p.id && x.phase === "pour" && x.leg === msg.leg);
        if (tm) finishPour(room, tm, tm.leg, "done");
        break;
      }

      case "card": {
        if (!p || !m) return;
        const res = playCard(room, p, String(msg.card || ""), Number(msg.team));
        if (res) send(ws, { t: "fxNo", card: msg.card, team: msg.team, why: typeof res === "string" ? res : res.why, until: res.until || 0 });
        break;
      }

      case "cheer": {
        if (!room) return;
        const e = ["👏", "🔥", "😱", "🍹", "🧊", "🙈"].includes(msg.e) ? msg.e : null;
        if (!e) return;
        if (ws.lastCheer && now - ws.lastCheer < 450) return;
        ws.lastCheer = now;
        bcast(room, { t: "cheer", from: p ? p.id : 0, e });
        break;
      }

      case "leave":
        detach(ws, { forGood: true });
        send(ws, { t: "left" });
        break;
    }
  });

  ws.on("close", () => detach(ws));
  ws.on("error", () => {});
});

// ---------- housekeeping ----------
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase !== "match") {
      let changed = false;
      for (const [id, p] of room.players) {
        if (!p.connected && now - p.discAt > LOBBY_DROP_MS) { room.players.delete(id); changed = true; }
      }
      if (changed) { pickLeader(room); rosterChanged(room); }
    } else if (room.match && room.match.phase !== "done" && !room.connected().length && now - Math.max(...[...room.players.values()].map((p) => p.discAt || 0)) > 60000) {
      // everyone vanished mid-match: wrap it up
      finishMatch(room);
    }
    if (!room.hasAnyone() && room.emptySince && now - room.emptySince > EMPTY_ROOM_MS) dropRoom(room);
  }
}, 5000);

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`Brim listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const ws of wss.clients) { try { ws.close(1001, "server restarting"); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
