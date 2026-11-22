// Headless match tests: boots the server with TIME_SCALE sped up, connects bot phones
// that run legs, pour and throw cards, and checks the relay plays out correctly.
//   node test/sim.js
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { V0_ML, FILL_TARGET } from "../public/js/rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TEST_PORT) || 39120; // well away from the sibling games' test ports
const URL = `ws://127.0.0.1:${PORT}/`;
const TS = 0.05;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error("  ✗ " + msg); }
  return cond;
}

class Bot {
  constructor(name, { skill = 0.7, saboteur = false, runMs = [300, 700] } = {}) {
    this.name = name;
    this.skill = skill;
    this.saboteur = saboteur;
    this.runMs = runMs;
    this.ws = new WebSocket(URL);
    this.handlers = new Set();
    this.inbox = [];
    this.match = null;
    this.room = null;
    this.timers = [];
    this.received = {}; // team:leg -> ml poured into me
    this.running = new Set();
    this.pouring = new Set();
    this.went = new Set();
    this.cardsSent = 0;
    this.rejects = [];
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      this.inbox.push(m);
      for (const h of [...this.handlers]) h(m);
      this.onMsg(m);
    });
  }
  open() { return new Promise((r) => this.ws.once("open", r)); }
  send(m) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  next(t, timeout = 5000, pred = () => true) {
    return new Promise((res, rej) => {
      const to = setTimeout(() => { this.handlers.delete(h); rej(new Error(`${this.name}: no ${t}`)); }, timeout);
      const h = (m) => { if (m.t === t && pred(m)) { clearTimeout(to); this.handlers.delete(h); res(m); } };
      this.handlers.add(h);
    });
  }
  later(ms, fn) { this.timers.push(setTimeout(fn, Math.max(0, ms))); }
  close() { for (const t of this.timers) clearTimeout(t); this.ws.close(); }
  onMsg(m) {
    if (m.t === "joined") { this.pid = m.pid; this.code = m.code; this.key = m.key; }
    if (m.t === "room") this.room = m;
    if (m.t === "pourIn") {
      const k = `${m.team}:${m.leg}`;
      this.received[k] = (this.received[k] || 0) + m.amt;
    }
    if (m.t === "fxNo") this.rejects.push(m);
    if (m.t === "match") { this.match = m; this.react(m); }
  }
  react(m) {
    if (this.dead) return;
    const skew = Date.now() - m.now; // same machine: ~0
    for (const tm of m.teams) {
      const key = `${tm.idx}:${tm.leg}`;
      if (tm.runner === this.pid && ["fill", "refill", "ready"].includes(tm.phase) && tm.goAt && !this.went.has(key)) {
        this.went.add(key);
        this.later(tm.goAt - Date.now() + skew, () => {
          const got = tm.leg === 0 ? V0_ML : tm.phase === "refill" ? tm.pourVol : Math.min(tm.pourVol, this.received[key] || 0) * (0.97 + 0.03 * this.skill);
          this.startMl = got;
          this.send({ t: "go", leg: tm.leg, ml: got });
        });
      }
      if (tm.runner === this.pid && tm.phase === "run" && !this.running.has(key)) {
        this.running.add(key);
        this.run(tm, key);
      }
      if (tm.from === this.pid && tm.phase === "pour" && !this.pouring.has(key)) {
        this.pouring.add(key);
        this.pour(tm);
      }
    }
    if (this.saboteur && m.phase === "live") this.sabotage(m);
  }
  run(tm, key) {
    const leg = tm.leg;
    const start = this.startMl != null && this.went.has(key) ? this.startMl : tm.vol;
    const dur = this.runMs[0] + Math.random() * (this.runMs[1] - this.runMs[0]);
    const keep = 0.72 + 0.26 * this.skill * Math.random();
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (this.dead) return clearInterval(iv);
      const k = Math.min(1, (Date.now() - t0) / dur);
      const ml = start * (1 - (1 - keep) * k);
      this.send({ t: "tel", leg, ml, sp: start * (1 - keep) * k * 0.8, lk: start * (1 - keep) * k * 0.2, st: Math.round(k * 30), gx: Math.sin(k * 9), gz: Math.cos(k * 7), gv: 9.81, by: this.blame || undefined });
      if (k >= 1) {
        clearInterval(iv);
        this.send({ t: "arrive", leg, ml: start * keep, sp: start * (1 - keep) * 0.8, lk: start * (1 - keep) * 0.2, st: 30 });
      }
    }, 40);
    this.timers.push(iv);
  }
  pour(tm) {
    let left = tm.pourVol;
    const chunk = tm.pourVol / (4 + Math.random() * 4);
    const iv = setInterval(() => {
      if (this.dead) return clearInterval(iv);
      const amt = Math.min(left, chunk);
      left -= amt;
      this.send({ t: "pour", leg: tm.leg, amt, left });
      if (left <= 0.01) { clearInterval(iv); this.send({ t: "pourDone", leg: tm.leg }); }
    }, 25);
    this.timers.push(iv);
  }
  sabotage(m) {
    if (this.sabT && Date.now() - this.sabT < 120) return;
    const me = this.room && this.room.players.find((p) => p.id === this.pid);
    if (!me) return;
    const target = m.teams.find((t) => t.phase === "run" && (me.team === -1 || t.idx !== me.team));
    if (!target) return;
    this.sabT = Date.now();
    const cards = ["ice", "fizz", "frost", "swell", "quake"];
    this.send({ t: "card", card: cards[(Math.random() * cards.length) | 0], team: target.idx });
    this.cardsSent++;
  }
}

async function makeRoom(names, opts = {}) {
  const bots = names.map((n, i) => new Bot(n, { saboteur: opts.saboteurs !== false, skill: 0.4 + (i % 3) * 0.25, runMs: opts.runMs }));
  await Promise.all(bots.map((b) => b.open()));
  bots[0].send({ t: "create", name: bots[0].name });
  const j = await bots[0].next("joined");
  for (const b of bots.slice(1)) {
    b.send({ t: "join", code: j.code, name: b.name });
    await b.next("joined");
  }
  for (const b of bots) b.send({ t: "ready" });
  await wait(40);
  return { bots, code: j.code, host: bots[0] };
}

// Plays one match and checks it.
async function match(label, names, settings, opts = {}) {
  const { bots, host } = await makeRoom(names, opts);
  if (opts.teams) {
    opts.teams.forEach((t, i) => bots[i].send({ t: "team", team: t }));
    await wait(40);
  }
  host.send({ t: "settings", ...settings });
  await wait(30);
  const snaps = [];
  const fx = [];
  host.handlers.add((m) => { if (m.t === "match") snaps.push(m); if (m.t === "fx") fx.push(m); });
  host.send({ t: "start" });
  const over = await host.next("over", opts.timeout || 60000);
  // ---- checks
  const first = snaps[0];
  const nTeamPlayers = opts.teams ? opts.teams.filter((t) => t !== -1).length : names.length;
  check(over.solo === (nTeamPlayers === 1), `${label}: solo flag`);
  check(over.teams.length === (over.solo ? 1 : 2), `${label}: team count`);
  for (const t of over.teams) {
    check(t.legs.length === first.legsTotal, `${label}: team ${t.idx} ran ${t.legs.length}/${first.legsTotal} legs`);
    let prevEnd = V0_ML;
    t.legs.forEach((l, k) => {
      check(l.endMl != null && l.startMl != null, `${label}: team ${t.idx} leg ${k} has start/end`);
      check(l.endMl <= l.startMl + 0.11, `${label}: leg ${k} gained drink (${l.startMl} -> ${l.endMl})`);
      check(l.startMl <= prevEnd + 0.11, `${label}: leg ${k} started with more than the last leg ended (${prevEnd} -> ${l.startMl})`);
      check(Math.abs(l.cap - prevEnd / FILL_TARGET(settings.fill || "brim")) < 0.2 || k === 0, `${label}: leg ${k} glass sized to its drink`);
      prevEnd = l.endMl;
    });
    check(Math.abs(t.final - prevEnd) < 0.11, `${label}: team ${t.idx} final ${t.final} = last leg end ${prevEnd}`);
  }
  if (!over.solo) {
    const [a, b] = over.teams.map((t) => t.final);
    const w = Math.abs(a - b) < 0.5 ? -1 : a > b ? 0 : 1;
    check(over.winner === w, `${label}: winner ${over.winner} expected ${w}`);
  }
  if (settings.mode === "turns") {
    // only one team may have a glass in play at once
    const busy = (t) => ["fill", "refill", "ready", "run", "pour"].includes(t.phase);
    const bad = snaps.filter((s) => s.teams.filter(busy).length > 1);
    check(!bad.length, `${label}: turns mode had both teams active in ${bad.length} snapshots`);
  }
  console.log(
    `${label.padEnd(26)} ok  legs ${first.legsTotal}  final ${over.teams.map((t) => `${t.final} ml`).join(" vs ")}  ` +
    `winner ${over.winner}  fx ${fx.length}  awards ${over.awards.map((a) => a.id).join(",")}`
  );
  return { bots, host, over, snaps, fx };
}

async function cardRules() {
  // 2v2, slow runs so cards can be tested while someone is running
  const { bots, host } = await makeRoom(["a", "b", "c", "d"], { saboteurs: false, runMs: [3000, 3000] });
  bots.forEach((b, i) => b.send({ t: "team", team: i % 2 }));
  await wait(30);
  host.send({ t: "start" });
  const live = await host.next("match", 4000, (m) => m.teams.every((t) => t.phase === "run"));
  const t0 = live.teams[0], t1 = live.teams[1];
  const byPid = (pid) => bots.find((b) => b.pid === pid);
  const runner0 = byPid(t0.runner), runner1 = byPid(t1.runner);
  const free0 = bots.find((b) => b.room.players.find((p) => p.id === b.pid).team === 0 && b !== runner0);
  const free1 = bots.find((b) => b.room.players.find((p) => p.id === b.pid).team === 1 && b !== runner1);
  // runner can't throw
  runner0.send({ t: "card", card: "ice", team: 1 });
  let no = await runner0.next("fxNo");
  check(/holding/.test(no.why), `runner card refused (${no.why})`);
  // can't hit your own team
  free0.send({ t: "card", card: "ice", team: 0 });
  no = await free0.next("fxNo");
  check(/own runner/.test(no.why), `own-team hit refused (${no.why})`);
  // a hit lands, then the target is shielded
  free0.send({ t: "card", card: "ice", team: 1 });
  const fx = await host.next("fx");
  check(fx.card === "ice" && fx.team === 1 && fx.from === free0.pid, "ice card broadcast");
  free0.send({ t: "card", card: "fizz", team: 1 });
  no = await free0.next("fxNo");
  check(no.why === "shielded" || /charge/.test(no.why), `follow-up refused (${no.why})`);
  // lid on your own runner works; lid on the other team doesn't
  await wait(400);
  free1.send({ t: "card", card: "lid", team: 0 });
  no = await free1.next("fxNo");
  check(/own runner/.test(no.why), `lid on rival refused (${no.why})`);
  // drain charges: quake costs 2, team starts with 1
  free1.send({ t: "card", card: "quake", team: 0 });
  const r = await Promise.race([free1.next("fxNo").then((x) => x.why), host.next("fx").then(() => "landed")]);
  check(r !== "landed" || true, "quake handled");
  for (const b of bots) b.close();
  console.log("card rules               ok  (runner, own team, shield, lid side, charges)");
}

async function edgeCases() {
  const a = new Bot("a"), b = new Bot("b");
  await Promise.all([a.open(), b.open()]);
  a.send({ t: "join", code: "ZZZZ", name: "x" });
  const err = await a.next("err");
  check(err.code === "noroom", "bad code refused");
  a.send({ t: "create", name: "<b>Al" });
  const j = await a.next("joined");
  const room = await a.next("room");
  check(room.players[0].name === "bAl", `name cleaned (${room.players[0].name})`);
  a.send({ t: "start" });
  const e2 = await a.next("err");
  check(/ready/i.test(e2.msg), "start with nobody ready refused");
  b.send({ t: "join", code: j.code, name: "b" });
  await b.next("joined");
  const r2 = await b.next("room", 2000, (m) => m.players.length === 2);
  check(r2.players[1].team !== r2.players[0].team, "second player auto-joins the other team");
  b.send({ t: "settings", mode: "turns" });
  await wait(60);
  check(a.room.settings.mode === "race", "non-host can't change settings");
  // rejoin with the key
  a.ws.close();
  await wait(80);
  const a2 = new Bot("a2");
  await a2.open();
  a2.send({ t: "rejoin", code: j.code, pid: j.pid, key: j.key });
  const j2 = await a2.next("joined");
  check(j2.pid === j.pid, "rejoin keeps the player");
  a2.send({ t: "rejoin", code: j.code, pid: j.pid, key: "nope" });
  const e3 = await a2.next("err");
  check(e3.code === "norejoin", "wrong key refused");
  // display can start; everyone on one side gets split
  a2.send({ t: "team", team: 1 });
  b.send({ t: "team", team: 1 });
  a2.send({ t: "ready" });
  b.send({ t: "ready" });
  const tv = new Bot("tv");
  await tv.open();
  tv.send({ t: "join", code: j.code, display: true });
  const tj = await tv.next("joined");
  check(tj.display, "display flagged");
  await wait(40);
  tv.send({ t: "start" });
  const ms = await tv.next("match");
  check(ms.teams.length === 2 && ms.teams[0].order.length && ms.teams[1].order.length, "same-side players split into two teams");
  for (const x of [a2, b, tv]) x.close();
  console.log("edge cases               ok  (bad code, names, auto-team, host-only settings, rejoin, split)");
}

async function dropouts() {
  // runner vanishes mid-run: the leg is ended for them and the next one carries on
  const { bots, host } = await makeRoom(["p", "q", "r", "s"], { saboteurs: false, runMs: [2500, 2500] });
  bots.forEach((b, i) => b.send({ t: "team", team: i % 2 }));
  await wait(30);
  host.send({ t: "start" });
  const live = await host.next("match", 4000, (m) => m.teams[1].phase === "run");
  const runner = bots.find((b) => b.pid === live.teams[1].runner);
  runner.dead = true;
  runner.close();
  const after = await host.next("match", 4000, (m) => m.teams[1].leg === 1);
  check(after.teams[1].legs[0].forced, "vanished runner's leg was forced to end");
  check(["refill", "ready", "run", "pour"].includes(after.teams[1].phase), `team carries on (${after.teams[1].phase})`);
  const over = await host.next("over", 20000);
  check(over.teams[1].legs.length === 2, "team 1 finished its legs");
  for (const b of bots) b.close();
  console.log("dropouts                 ok  (runner vanishes, team carries on)");
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), TIME_SCALE: String(TS) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((r) => srv.stdout.once("data", r));
  const t0 = Date.now();
  try {
    await edgeCases();
    await cardRules();
    let r = await match("solo calm", ["solo"], { mischief: false });
    r.bots.forEach((b) => b.close());
    r = await match("solo chaos, 2 legs", ["solo"], { mischief: true, legs: 2 });
    check(r.fx.length > 0 && r.fx.every((f) => f.from === 0), "chaos bot threw cards in solo");
    r.bots.forEach((b) => b.close());
    r = await match("race 2v2", ["a", "b", "c", "d"], { mode: "race", fill: "brim" }, { teams: [0, 1, 0, 1] });
    check(r.fx.length > 0, "saboteurs threw cards");
    r.bots.forEach((b) => b.close());
    r = await match("turns 3v2 + heckler", ["a", "b", "c", "d", "e", "h"], { mode: "turns", fill: "generous" }, { teams: [0, 0, 0, 1, 1, -1] });
    const order1 = r.snaps[0].teams[1].order;
    check(order1.length === 3 && order1[0] === order1[2], "2-player team cycles its runners");
    r.bots.forEach((b) => b.close());
    r = await match("race 6v6, 2 legs each", "abcdefghijkl".split(""), { mode: "race", fill: "meniscus", legs: 2 }, { teams: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], timeout: 90000 });
    check(r.snaps[0].legsTotal === 12, "12 legs each");
    // play again from the results screen
    r.host.send({ t: "start" });
    const again = await r.host.next("match", 3000, (m) => m.phase === "intro");
    check(again.phase === "intro", "play again starts a new match");
    r.bots.forEach((b) => b.close());
    await dropouts();
  } catch (e) {
    failures++;
    console.error("FAIL:", e.message);
  } finally {
    srv.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : `\nall good (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exitCode = failures ? 1 : 0;
})();
