// The phone: join a room, pick a team, then carry, pour, catch, or make mischief,
// depending on where the relay is.
import { Net } from "./net.js";
import { S, enableMotion, startSim, screenAngle } from "./sensors.js";
import { sfx, buzz, audioCtx, pour as pourSound } from "./audio.js";
import { Carry } from "./carry.js";
import { Replica, Stage, syncReplica } from "./stage.js";
import { TEAMS, SOLO_DRINK, CARDS, CARD_ORDER, CHARGE, FILLS, MODES, V0_ML, TIMING, TELEGRAPH_MS, grade } from "./rules.js";
import { $, esc, avatar, toast, showScreen, joinUrl, qrSvg, confetti, icon, fmtMl, fmtPct, fmtTime, restartAnim, CARD_COLORS, floatCheer } from "./ui.js";

const params = new URLSearchParams(location.search);
const DEV = params.has("dev");
const NS = (params.get("ns") || "").replace(/[^a-z0-9]/gi, "").slice(0, 8);
const SESSION = "brim-session" + NS; // ?ns= lets test phones share one browser tab
const extra = () => `${DEV ? "&dev" : ""}${NS ? `&ns=${NS}` : ""}`;
const NAME = "brim-name";
const PBKEY = "brim-pb";
const CARRY_ROLES = ["runner", "pourer", "catcher", "holder"];

const st = {
  code: null, pid: null, key: null,
  room: null, match: null, over: null,
  wantSolo: false,
  role: { kind: "none" }, roleKey: "",
  carry: null, carryLeg: "", stage: null, reps: [], lobCarry: null,
  goTimer: null, telTimer: null, uiTimer: null, wake: null,
  received: {}, lastDigit: -1, verdictUntil: 0,
  holding: false, holdStart: 0, holdRaf: 0,
  frost: null, heckTarget: 0, bannerTimer: null,
  spillSfxAt: 0, lastStage: "", phaseShown: "",
};

const scr = { home: $("scr-home"), lobby: $("scr-lobby"), game: $("scr-game"), over: $("scr-over") };
const net = new Net({ onMsg, onOpen });
const toPerf = (t) => net.toPerf(t);
const serverNow = () => Date.now() + net.offset;

export function startPhone() {
  document.body.classList.add("show-hub");
  if (DEV) {
    startSim();
    window.__brim = { st, net, S, auto: null };
  }
  $("in-name").value = localStorage.getItem(NAME) || "";
  const code = (params.get("room") || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  if (code) {
    $("in-code").value = code;
    $("btn-join").classList.replace("ghost", "primary");
    $("btn-join").textContent = `Join ${code}`;
    $("btn-create").classList.replace("primary", "ghost");
    $("btn-create").classList.remove("big");
    $("f-home").classList.add("has-code");
  }
  showScreen(scr.home);
  wire();
  buildDeck();
  net.connect();
  st.uiTimer = setInterval(uiTick, 100);
}

// ───────────────────────────── wiring ─────────────────────────────
function wire() {
  $("f-home").addEventListener("submit", (e) => {
    e.preventDefault();
    if ($("f-home").classList.contains("has-code")) join();
    else create(false);
  });
  $("btn-join").addEventListener("click", join);
  $("in-code").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); join(); } });
  $("btn-solo").addEventListener("click", () => create(true));
  $("btn-motion").addEventListener("click", onMotionButton);
  for (const b of document.querySelectorAll(".join-team")) b.addEventListener("click", () => net.send({ t: "team", team: Number(b.dataset.team) }));
  $("btn-heckle").addEventListener("click", () => net.send({ t: "team", team: -1 }));
  $("btn-shuffle").addEventListener("click", () => net.send({ t: "shuffle" }));
  for (const seg of document.querySelectorAll("#settings .seg")) {
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || !isHost()) return;
      let v = b.dataset.v;
      if (seg.dataset.k === "legs") v = Number(v);
      if (seg.dataset.k === "mischief") v = v === "true";
      net.send({ t: "settings", [seg.dataset.k]: v });
    });
  }
  $("btn-start").addEventListener("click", () => { audioCtx(); net.send({ t: "start" }); });
  $("btn-leave").addEventListener("click", leave);
  $("btn-exit").addEventListener("click", leave);
  $("btn-again").addEventListener("click", () => { audioCtx(); net.send({ t: "start" }); });
  $("btn-tolobby").addEventListener("click", () => net.send({ t: "toLobby" }));
  $("btn-mode").addEventListener("click", () => {
    audioCtx();
    const chaos = !(st.room && st.room.settings.mischief);
    net.send({ t: "settings", mischief: chaos });
    setTimeout(() => net.send({ t: "start" }), 120);
  });
  $("btn-share").addEventListener("click", share);
  $("btn-qr").addEventListener("click", () => {
    const box = $("qr-box");
    box.hidden = !box.hidden;
    $("btn-qr").setAttribute("aria-expanded", String(!box.hidden));
    if (!box.hidden) $("lob-qr").innerHTML = qrSvg(joinUrl(st.code));
  });
  // hold to pour / finish
  const hb = $("btn-hold");
  hb.addEventListener("pointerdown", (e) => { e.preventDefault(); holdStart(); });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) hb.addEventListener(ev, holdEnd);
  hb.addEventListener("contextmenu", (e) => e.preventDefault());
  if (DEV) {
    window.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.repeat && st.role.kind === "runner") holdStart(); });
    window.addEventListener("keyup", (e) => { if (e.key === "Enter") holdEnd(); });
  }
  $("deck").addEventListener("click", (e) => {
    const b = e.target.closest(".card");
    if (b) playCard(b.dataset.card);
  });
  $("target").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    st.heckTarget = Number(b.dataset.team);
    renderSpec();
  });
  $("cheers").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) net.send({ t: "cheer", e: b.dataset.e }, { queue: false });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && st.match && st.match.phase !== "done") keepAwake();
  });
  window.addEventListener("resize", applyDeviceFrame);
  window.addEventListener("orientationchange", () => setTimeout(applyDeviceFrame, 60));
  if (screen.orientation) screen.orientation.addEventListener?.("change", () => setTimeout(applyDeviceFrame, 60));
  st.frost = new Frost($("frost"));
}

function myName() {
  const n = $("in-name").value.trim().slice(0, 14);
  if (n) localStorage.setItem(NAME, n);
  return n;
}
function create(solo) {
  audioCtx();
  st.wantSolo = solo;
  net.send({ t: "create", name: myName() });
}
function join() {
  audioCtx();
  const code = $("in-code").value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  if (code.length !== 4) { toast("Room codes are 4 letters."); $("in-code").focus(); return; }
  st.wantSolo = false;
  net.send({ t: "join", code, name: myName() });
}
function leave() {
  net.send({ t: "leave" });
  sessionStorage.removeItem(SESSION);
  stopGame();
  stopLobbyGlass();
  st.code = st.pid = st.key = null;
  st.room = st.match = st.over = null;
  document.body.classList.add("show-hub");
  history.replaceState(null, "", location.pathname + extra().replace(/^&/, "?"));
  showScreen(scr.home);
}
async function share() {
  const url = joinUrl(st.code);
  const text = `Join my Brim room: ${st.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: "Brim", text, url }); return; } catch (e) { if (e && e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(url); toast("Invite link copied"); } catch { toast(url, 5000); }
}
const isHost = () => st.room && st.room.leader === st.pid;
const me = () => (st.room ? st.room.players.find((p) => p.id === st.pid) : null);
const nameOf = (id) => {
  if (id === 0) return "The bar";
  const p = st.room && st.room.players.find((x) => x.id === id);
  return p ? p.name : "Someone";
};

// ───────────────────────────── motion ─────────────────────────────
async function onMotionButton() {
  audioCtx();
  const btn = $("btn-motion");
  btn.disabled = true;
  btn.textContent = "Reaching for it…";
  let caps;
  try { caps = DEV ? { motion: true, orient: true } : await enableMotion(); } catch { caps = { motion: false, orient: false, denied: true }; }
  btn.disabled = false;
  const note = $("gc-note");
  if (!caps.motion && !caps.orient) {
    btn.textContent = "Try again";
    note.hidden = false;
    note.textContent = caps.denied
      ? "Motion access was blocked. On iPhone: close the tab, reopen it, and tap Allow. You can still heckle."
      : "No motion sensors here (a laptop?). You can still join a team as a heckler, or open the big screen.";
    sfx.denied();
    return;
  }
  note.hidden = !caps.denied;
  if (caps.denied) note.textContent = "Some motion access was blocked; tilt still works.";
  net.send({ t: "ready" });
  sfx.win();
  buzz(30);
  startLobbyGlass();
  if (st.wantSolo) {
    // the Solo button means a calm carry; chaos is one tap away on the results
    st.wantSolo = false;
    net.send({ t: "settings", mischief: false, legs: 1 });
    setTimeout(() => net.send({ t: "start" }), 300);
  }
}

function startLobbyGlass() {
  if (st.lobCarry) return;
  const team = me() ? me().team : 0;
  const drink = team === 1 ? TEAMS[1] : team === 0 ? TEAMS[0] : SOLO_DRINK;
  const c = new Carry($("lob-glass"), { drink, fillId: (st.room && st.room.settings.fill) || "brim" });
  c.setBox(6, 2);
  c.setMode("preview");
  st.lobCarry = c;
  $("glass-card").classList.add("live");
}
function stopLobbyGlass() {
  if (st.lobCarry) { st.lobCarry.stop(); st.lobCarry = null; }
  $("glass-card").classList.remove("live");
}

// ───────────────────────────── network ─────────────────────────────
function onOpen() {
  const saved = JSON.parse(sessionStorage.getItem(SESSION) || "null");
  if (st.pid && st.code) net.send({ t: "rejoin", code: st.code, pid: st.pid, key: st.key });
  else if (saved) net.send({ t: "rejoin", code: saved.code, pid: saved.pid, key: saved.key });
}

function onMsg(m) {
  switch (m.t) {
    case "joined": return onJoined(m);
    case "room": return onRoom(m);
    case "match": return onMatch(m);
    case "tels": return onTels(m);
    case "pourIn": return onPourIn(m);
    case "fx": return onFx(m);
    case "fxNo": return onFxNo(m);
    case "over": return onOver(m);
    case "cheer": return floatCheer(m.e, $("floaters"));
    case "lobby":
      st.match = null;
      st.over = null;
      stopGame();
      toLobbyScreen();
      return;
    case "left": return;
    case "err":
      if (m.code === "norejoin") {
        sessionStorage.removeItem(SESSION);
        st.code = st.pid = st.key = null;
        if (!scr.home.classList.contains("on")) { toast("That game has ended."); stopGame(); showScreen(scr.home); document.body.classList.add("show-hub"); }
        return;
      }
      toast(m.msg || "Something went wrong.");
  }
}

function onJoined(m) {
  st.code = m.code;
  st.pid = m.pid;
  st.key = m.key;
  sessionStorage.setItem(SESSION, JSON.stringify({ code: m.code, pid: m.pid, key: m.key }));
  history.replaceState(null, "", `${location.pathname}?room=${m.code}${extra()}`);
  $("lob-code").textContent = m.code;
  $("qr-box").hidden = true;
  $("btn-motion").textContent = st.wantSolo ? "Pick up your glass & go" : "Pick up your glass";
  if (S.enabled && !DEV) net.send({ t: "ready" });
  if (DEV && S.enabled && st.pid) {
    // dev sim: sensors are always "on"
    setTimeout(() => { if (me() && !me().ready) $("btn-motion").click(); }, 50);
  }
  if (!st.match) toLobbyScreen();
}

function toLobbyScreen() {
  if (!scr.lobby.classList.contains("on")) {
    showScreen(scr.lobby);
    document.body.classList.remove("show-hub");
  }
  releaseWake();
  if (me() && me().ready) startLobbyGlass();
  renderLobby();
}

function onRoom(m) {
  st.room = m;
  if (!me()) return;
  if (m.phase === "lobby" && !st.match && !scr.lobby.classList.contains("on") && !scr.home.classList.contains("on")) toLobbyScreen();
  renderLobby();
  if (scr.over.classList.contains("on")) renderOverActions();
  if (st.lobCarry) {
    const t = me().team;
    st.lobCarry.actor.view.setDrink(t === 1 ? TEAMS[1] : t === 0 ? TEAMS[0] : SOLO_DRINK);
    st.lobCarry.setFill(m.settings.fill);
  }
}

function renderLobby() {
  const m = st.room;
  if (!m || !me()) return;
  const mine = me();
  const solo = m.players.length === 1;
  for (const t of [0, 1]) {
    const ps = m.players.filter((p) => p.team === t);
    $(`tc${t}`).textContent = ps.length ? `${ps.length}` : "";
    $(`tl${t}`).innerHTML = ps.length
      ? ps.map((p) => `<li class="${p.id === st.pid ? "me" : ""} ${p.connected ? "" : "off"}">${avatar(p, t)}<span class="pname">${esc(p.name)}${p.id === m.leader ? '<span class="crown" title="Host">♛</span>' : ""}</span><span class="ptag ${p.ready ? "ok" : ""}">${p.ready ? "ready" : "…"}</span></li>`).join("")
      : `<li class="empty">Nobody yet</li>`;
  }
  for (const b of document.querySelectorAll(".join-team")) b.hidden = mine.team === Number(b.dataset.team);
  const heck = m.players.filter((p) => p.team !== 0 && p.team !== 1);
  $("heck-list").innerHTML = heck.length ? `<span class="lbl">Heckling:</span> ${heck.map((p) => esc(p.name)).join(", ")}` : "";
  $("btn-heckle").hidden = mine.team === -1 || solo;
  $("teams").classList.toggle("solo", solo);
  // settings
  const s = m.settings;
  const host = isHost();
  $("settings").classList.toggle("ro", !host);
  for (const seg of document.querySelectorAll("#settings .seg")) {
    const k = seg.dataset.k;
    for (const b of seg.children) {
      b.classList.toggle("on", String(s[k]) === b.dataset.v);
      b.disabled = !host;
    }
  }
  const segM = document.querySelector('#settings .seg[data-k="mischief"]');
  segM.children[0].textContent = solo ? "Chaos" : "Mischief on";
  segM.children[1].textContent = solo ? "Calm" : "Off";
  document.querySelector('#settings .seg[data-k="mode"]').hidden = solo;
  document.querySelector('#settings .seg[data-k="legs"]').children[0].textContent = solo ? "One lap" : "Run once each";
  document.querySelector('#settings .seg[data-k="legs"]').children[1].textContent = solo ? "Two laps" : "Twice each";
  $("note-mode").textContent = solo ? "" : MODES[s.mode].blurb;
  $("note-fill").textContent = `${FILLS[s.fill].label}: ${FILLS[s.fill].blurb.toLowerCase()}.`;
  $("btn-shuffle").hidden = !host || solo;
  // footer
  const ready = m.players.filter((p) => p.ready && p.connected && (p.team === 0 || p.team === 1));
  const btn = $("btn-start");
  btn.hidden = !host || m.phase === "match";
  btn.disabled = ready.length === 0;
  btn.textContent = solo || ready.length === 1 ? "Start solo carry" : `Start · ${ready.length} ready`;
  const wait = $("lob-wait");
  if (m.phase === "match") wait.textContent = "A relay is on. You'll be in the next one.";
  else if (!mine.ready) wait.textContent = "Pick up your glass to play.";
  else if (host) wait.textContent = m.displays ? "Big screen connected. Start when everyone's ready." : ready.length < m.players.filter((p) => p.team !== -1).length ? "Waiting for everyone to pick up their glass…" : "Everyone's ready.";
  else wait.textContent = `Waiting for ${nameOf(m.leader)} to start…`;
  $("gc-title").textContent = mine.ready ? "Your glass" : "Pick up your glass";
  $("gc-sub").textContent = mine.ready ? "Tilt and shake your phone to feel how it sloshes." : "Brim sloshes the drink with your phone's motion sensors. Nothing leaves your phone.";
  $("btn-motion").hidden = mine.ready;
}

// ───────────────────────────── the match ─────────────────────────────
function myTeamIdx(m = st.match) {
  if (!m) return -1;
  return m.teams.findIndex((t) => t.order.includes(st.pid));
}

function computeRole(m) {
  if (m.phase === "intro") return { kind: "intro", key: `intro:${m.id}` };
  for (const tm of m.teams) {
    if (tm.phase === "pour" && tm.from === st.pid) return { kind: "pourer", tm, key: `pour:${m.id}:${tm.idx}:${tm.leg}` };
    if (tm.runner !== st.pid) continue;
    if (tm.phase === "pour") return { kind: "catcher", tm, key: `catch:${m.id}:${tm.idx}:${tm.leg}` };
    if (["fill", "refill", "ready", "run"].includes(tm.phase)) return { kind: "runner", tm, key: `run:${m.id}:${tm.idx}:${tm.leg}:${tm.phase}` };
    if (tm.phase === "hold") return { kind: "holder", tm, key: `hold:${m.id}:${tm.idx}:${tm.leg}` };
  }
  return { kind: "spec", key: `spec:${m.id}` };
}

function onMatch(m) {
  const first = !st.match || st.match.id !== m.id;
  if (m.phase === "done" && st.liveSeen !== m.id) {
    // joined after that relay finished: it's not ours, stay in the lobby
    if (first) toLobbyScreen();
    return;
  }
  st.liveSeen = m.id;
  st.match = m;
  if (first) {
    st.over = null;
    st.received = {};
    st.carryLeg = "";
    stopLobbyGlass();
    if (st.stopConfetti) { st.stopConfetti(); st.stopConfetti = null; }
  }
  if (m.phase === "done" && st.over) return;
  if (!scr.game.classList.contains("on") && m.phase !== "done") {
    showScreen(scr.game);
    document.body.classList.remove("show-hub");
    keepAwake();
  }
  syncRole();
  syncReplicas();
  renderGameUI();
}

function syncRole() {
  const m = st.match;
  if (!m) return;
  const r = computeRole(m);
  const changed = r.key !== st.roleKey;
  const prevKind = st.role.kind;
  st.role = r;
  if (changed) {
    st.roleKey = r.key;
    enterRole(r, prevKind);
  }
}

function drinkFor(teamIdx) {
  return st.match && st.match.solo ? SOLO_DRINK : TEAMS[teamIdx] || SOLO_DRINK;
}

function ensureCarry(teamIdx) {
  if (st.stage) { st.stage.stop(); st.stage = null; st.lastStage = ""; }
  if (!st.carry) {
    st.carry = new Carry($("stage"), {
      drink: drinkFor(teamIdx),
      fillId: st.match.fill,
      hooks: {
        spill: onSpill,
        pour: (ml) => {
          const r = st.role;
          if (r.kind === "pourer") net.send({ t: "pour", leg: r.tm.leg, amt: Math.round(ml * 100) / 100, left: Math.round(st.carry.ml * 10) / 10 });
        },
        pourDone: () => {
          const r = st.role;
          if (r.kind === "pourer") net.send({ t: "pourDone", leg: r.tm.leg });
        },
        landed: onLanded,
        tick: () => {
          const c = st.carry;
          if (!c) return;
          pourSound(c.mode === "pour" ? c.flow : c.mode === "catch" || c.mode === "fill" ? c.streamW * 0.7 : 0);
        },
      },
    });
    st.carry.fxEnabled = true;
  }
  st.carry.actor.view.setDrink(drinkFor(teamIdx));
  st.carry.setFill(st.match.fill);
  layoutCarry();
  return st.carry;
}
function layoutCarry() {
  if (!st.carry) return;
  const h = $("stage").clientHeight || innerHeight;
  st.carry.setBox(Math.min(150, h * 0.17), Math.min(190, h * 0.22));
}

function ensureStage() {
  stopTel();
  pourSound(0);
  if (st.carry) { st.carry.stop(); st.carry = null; st.carryLeg = ""; }
  if (!st.stage) st.stage = new Stage($("stage"));
  const m = st.match;
  const key = `${m.id}:${m.teams.length}`;
  if (st.lastStage !== key) {
    st.lastStage = key;
    st.reps = m.teams.map((tm) => new Replica(drinkFor(tm.idx), m.fill));
    st.stage.setSlots(m.teams.length === 1
      ? [{ rep: st.reps[0], box: [0.15, 0.12, 0.7, 0.44] }]
      : [{ rep: st.reps[0], box: [0, 0.14, 0.5, 0.42], widthK: 0.33 }, { rep: st.reps[1], box: [0.5, 0.14, 0.5, 0.42], widthK: 0.33 }]);
  }
  return st.stage;
}

function syncReplicas() {
  const m = st.match;
  if (!m || !st.reps.length) return;
  m.teams.forEach((tm, i) => { if (st.reps[i]) syncReplica(st.reps[i], tm, m, toPerf); });
}

function enterRole(r, prevKind) {
  const m = st.match;
  clearTimeout(st.goTimer);
  hideCenter();
  $("ov-intro").hidden = r.kind !== "intro";
  if (r.kind !== "runner") st.frost.stop(true);
  if (r.kind === "intro" || r.kind === "spec") {
    st.frost.stop();
    ensureStage();
    syncReplicas();
    applyDeviceFrame();
    if (r.kind === "intro") showIntro();
    return;
  }
  const tm = r.tm;
  const legKey = (leg) => `${m.id}:${tm.idx}:${leg}`;
  const c = ensureCarry(tm.idx);
  applyDeviceFrame();
  if (r.kind === "runner") {
    if (tm.phase === "fill" || tm.phase === "refill") {
      st.carryLeg = legKey(tm.leg);
      c.setGlass(tm.cap, 0);
      c.setMode("fill", { ms: Math.max(500, toPerf(tm.goAt) - performance.now() - TIMING.count) });
      scheduleGo(tm);
    } else if (tm.phase === "ready") {
      const k = `${tm.idx}:${tm.leg}`;
      if (st.carryLeg !== legKey(tm.leg)) {
        st.carryLeg = legKey(tm.leg);
        c.setGlass(tm.cap, 0);
        st.received[k] = 0;
      }
      if (c.mode !== "catch") c.setMode("catch");
      const missing = (tm.poured || 0) - (st.received[k] || 0);
      if (missing > 0.4) { c.addIncoming(missing); st.received[k] = tm.poured; }
      scheduleGo(tm);
    } else if (tm.phase === "run") {
      if (st.carryLeg !== legKey(tm.leg)) {
        // came back mid-run: carry on with what the server last heard
        st.carryLeg = legKey(tm.leg);
        c.setGlass(tm.cap, tm.vol);
      }
      if (c.mode !== "run") go(tm.idx, tm.leg, true);
    }
  } else if (r.kind === "catcher") {
    const k = `${tm.idx}:${tm.leg}`;
    if (st.carryLeg !== legKey(tm.leg)) {
      st.carryLeg = legKey(tm.leg);
      st.received[k] = Math.min(tm.poured || 0, tm.pourVol);
      c.setGlass(tm.cap, st.received[k]);
    }
    c.setMode("catch");
    sfx.pop();
    buzz([30, 40, 30]);
  } else if (r.kind === "pourer") {
    if (st.carryLeg !== legKey(tm.leg - 1)) {
      st.carryLeg = legKey(tm.leg - 1);
      const prevLeg = tm.legs[tm.leg - 1];
      c.setGlass(prevLeg ? prevLeg.cap : tm.cap, Math.max(0, tm.pourVol - tm.poured));
    }
    stopTel();
    c.pourDoneSent = false;
    c.setMode("pour");
    buzz(40);
  } else if (r.kind === "holder") {
    if (st.carryLeg !== legKey(tm.leg)) {
      st.carryLeg = legKey(tm.leg);
      const l = tm.legs[tm.leg];
      c.setGlass(l ? l.cap : tm.cap, tm.vol);
    }
    stopTel();
    c.setMode("hold");
  }
}

function scheduleGo(tm) {
  clearTimeout(st.goTimer);
  const wait = toPerf(tm.goAt) - performance.now();
  st.goTimer = setTimeout(() => go(tm.idx, tm.leg), Math.max(0, wait));
}

function go(teamIdx, leg, resumed = false) {
  const m = st.match;
  const tm = m && m.teams[teamIdx];
  const c = st.carry;
  if (!tm || !c || tm.runner !== st.pid || tm.leg !== leg) return;
  if (!["fill", "refill", "ready", "run"].includes(tm.phase)) return;
  if (c.mode === "run") return;
  if (c.mode === "catch") {
    // anything still in flight lands now
    for (const inc of c.incoming) { c.actor.ml = c.actor.ml + inc.left; inc.left = 0; }
    c.incoming.length = 0;
  }
  c.setMode("run");
  if (resumed) {
    c.startMl = tm.legs[leg] && tm.legs[leg].startMl != null ? tm.legs[leg].startMl : c.ml;
    c.runStart = toPerf(tm.at);
  } else {
    net.send({ t: "go", leg, ml: Math.round(c.ml * 10) / 10 });
    sfx.go();
    buzz(45);
    showCenter("", "GO!", "", 700, "go");
  }
  st.runLeg = leg;
  startTel(teamIdx, leg);
}

function startTel(teamIdx, leg) {
  stopTel();
  st.telTimer = setInterval(() => {
    const c = st.carry;
    if (!c || c.mode !== "run") return;
    const d = c.drive;
    const r2 = (x) => Math.round(x * 100) / 100;
    const by = {};
    for (const [k, v] of Object.entries(c.by)) by[k] = Math.round(v * 10) / 10;
    net.send({ t: "tel", leg, ml: Math.round(c.ml * 10) / 10, sp: Math.round(c.spillMl * 10) / 10, lk: Math.round(c.leakMl * 10) / 10, st: S.steps, gx: r2(d.gx), gz: r2(d.gz), gv: r2(d.gv), by }, { queue: false });
  }, 80);
}
function stopTel() { clearInterval(st.telTimer); st.telTimer = null; }

function arrive() {
  const r = st.role;
  const c = st.carry;
  if (r.kind !== "runner" || !c || c.mode !== "run") return;
  const tm = r.tm;
  stopTel();
  const by = {};
  for (const [k, v] of Object.entries(c.by)) by[k] = Math.round(v * 10) / 10;
  const ms = performance.now() - c.runStart;
  const kept = c.startMl > 0 ? c.ml / c.startMl : 0;
  net.send({ t: "arrive", leg: tm.leg, ml: Math.round(c.ml * 10) / 10, sp: Math.round(c.spillMl * 10) / 10, lk: Math.round(c.leakMl * 10) / 10, st: S.steps, by });
  c.setMode("hold");
  st.frost.stop(true);
  $("banner").hidden = true;
  showVerdict(kept, c.ml, c.startMl, ms, S.steps);
  kept >= 0.9 ? sfx.win() : sfx.pop();
  buzz([30, 50, 30]);
}

function showVerdict(kept, ml, start, ms, steps) {
  $("v-grade").textContent = grade(kept);
  $("v-pct").textContent = fmtPct(kept);
  $("v-stat").textContent = `Kept ${fmtMl(ml)} of ${fmtMl(start)} ml · ${fmtTime(ms)}${steps ? ` · ${steps} steps` : ""}`;
  const v = $("ov-verdict");
  v.hidden = false;
  restartAnim($("v-pct"));
  st.verdictUntil = performance.now() + 2600;
}

// ───────────────────────────── hold button ─────────────────────────────
const HOLD_MS = 650;
function holdStart() {
  if (st.role.kind !== "runner" || !st.carry || st.carry.mode !== "run" || st.holding) return;
  st.holding = true;
  st.holdStart = performance.now();
  $("btn-hold").classList.add("down");
  const step = () => {
    if (!st.holding) return;
    const k = Math.min(1, (performance.now() - st.holdStart) / HOLD_MS);
    $("btn-hold").style.setProperty("--p", k);
    if (k >= 1) { holdEnd(); arrive(); return; }
    st.holdRaf = requestAnimationFrame(step);
  };
  // rAF can be throttled; a timer makes sure it still fires
  st.holdTimer = setTimeout(() => { if (st.holding) { holdEnd(); arrive(); } }, HOLD_MS + 40);
  step();
}
function holdEnd() {
  st.holding = false;
  clearTimeout(st.holdTimer);
  cancelAnimationFrame(st.holdRaf);
  $("btn-hold").classList.remove("down");
  $("btn-hold").style.setProperty("--p", 0);
}

// ───────────────────────────── telemetry from others ─────────────────────────────
function onTels(m) {
  if (!st.reps.length) return;
  for (const [team, leg, ml, , , gx, gz, gv] of m.d) {
    const rep = st.reps[team];
    const tm = st.match && st.match.teams[team];
    if (!rep || !tm || tm.leg !== leg) continue;
    rep.tel(ml, gx, gz, gv);
    tm.vol = ml;
  }
}

function onPourIn(m) {
  const r = st.role;
  const k = `${m.team}:${m.leg}`;
  const mine = st.carry && st.carryLeg.endsWith(`:${m.team}:${m.leg}`) && st.match && st.match.teams[m.team].runner === st.pid;
  if (mine && (r.kind === "catcher" || r.kind === "runner")) {
    st.carry.addIncoming(m.amt);
    st.received[k] = (st.received[k] || 0) + m.amt;
  }
  const rep = st.reps[m.team];
  if (rep && !mine) rep.pourIn(m.amt);
  if (st.match) {
    const tm = st.match.teams[m.team];
    if (tm && tm.leg === m.leg) tm.poured = m.total;
  }
}

// ───────────────────────────── mischief ─────────────────────────────
function onFx(f) {
  const m = st.match;
  if (!m) return;
  const tm = m.teams[f.team];
  const fx = { id: f.id, card: f.card, land: toPerf(f.landAt), seed: f.seed, from: f.from };
  const r = st.role;
  const mineRunning = r.kind === "runner" && r.tm.idx === f.team && r.tm.leg === f.leg && st.carry;
  if (mineRunning) {
    st.carry.actor.addFx(fx);
    showBanner(f);
    if (CARDS[f.card].kind === "hit") { sfx.warn(); buzz([60, 40, 60]); } else { sfx.pop(); }
  } else if (st.reps[f.team]) {
    st.reps[f.team].actor.addFx(fx);
    if (f.from === st.pid) sfx.card();
  }
  if (tm && f.from !== st.pid && !mineRunning && r.kind === "spec") {
    feed(`${nameOf(f.from)} → ${CARDS[f.card].name.toLowerCase()} → ${nameOf(tm.runner)}`, f.card);
  }
}

function onFxNo(m) {
  sfx.denied();
  if (m.why === "shielded") toast("Too soon: they're shielded for a moment.", 1600);
  else toast(m.why || "Can't play that now.", 1800);
}

function onLanded(f) {
  switch (f.card) {
    case "quake": sfx.quake(); buzz([90, 40, 120, 40, 90, 40, 140]); break;
    case "ice": sfx.clink(); setTimeout(() => sfx.plop(), 160); buzz(40); break;
    case "fizz": sfx.fizz(); buzz([20, 30, 20, 30, 20]); break;
    case "frost": sfx.frost(); st.frost.start(CARDS.frost.dur); buzz(60); break;
    case "swell": sfx.swell(); buzz([200, 200, 200]); break;
    case "lid": sfx.lid(); buzz(30); break;
  }
}

function onSpill(ml) {
  const now = performance.now();
  if (now - st.spillSfxAt > 160 && ml > 0.15) {
    st.spillSfxAt = now;
    sfx.splash(Math.min(1.5, ml / 3));
    buzz(Math.min(40, 8 + ml * 6));
  }
}

function showBanner(f) {
  const def = CARDS[f.card];
  $("b-ic").innerHTML = icon(f.card);
  $("b-ic").style.setProperty("--cc", CARD_COLORS[f.card]);
  $("b-what").textContent = def.kind === "help" ? `${def.name} on!` : `${def.name} incoming!`;
  $("b-who").textContent = def.kind === "help" ? `from ${nameOf(f.from)}` : f.from === 0 ? "the bar is restless" : `from ${nameOf(f.from)}`;
  const b = $("banner");
  b.hidden = false;
  b.className = `banner ${def.kind}`;
  restartAnim(b);
  clearTimeout(st.bannerTimer);
  st.bannerTimer = setTimeout(() => { b.hidden = true; }, TELEGRAPH_MS + 1800);
}

function chargesNow(b) {
  if (!b) return { charges: 0, next: 0 };
  const ms = b.max === CHARGE.heckMax ? CHARGE.heckMs : CHARGE.teamMs;
  let c = b.charges, at = b.chargeAt;
  const now = serverNow();
  while (c < b.max && now >= at) { c++; at += ms; }
  return { charges: c, next: c >= b.max ? 1 : 1 - Math.max(0, at - now) / ms };
}

function myBudget() {
  const m = st.match;
  const t = myTeamIdx(m);
  if (t >= 0) { const tm = m.teams[t]; return { charges: tm.charges, chargeAt: tm.chargeAt, cd: tm.cd, max: CHARGE.teamMax }; }
  const h = m.heck[st.pid];
  return h ? { ...h, max: CHARGE.heckMax } : null;
}

function hitTarget() {
  const m = st.match;
  if (!m) return -1;
  if (m.solo) return 0;
  const t = myTeamIdx(m);
  if (t >= 0) return 1 - t;
  return st.heckTarget;
}

function buildDeck() {
  $("deck").innerHTML = CARD_ORDER.map((id) => {
    const d = CARDS[id];
    return `<button class="card ${d.kind}" type="button" data-card="${id}" style="--cc:${CARD_COLORS[id]}"><span class="cd"></span>${icon(id)}<b>${d.name}</b><small>${d.blurb}</small><i class="cost">${"●".repeat(d.cost)}</i></button>`;
  }).join("");
}

function cardState(id) {
  const m = st.match;
  if (!m || m.phase !== "live") return { ok: false, why: "wait" };
  if (!m.mischief && !m.solo) return { ok: false, why: "off" };
  const def = CARDS[id];
  const myT = myTeamIdx(m);
  const tIdx = def.kind === "hit" ? hitTarget() : myT;
  if (def.kind === "help" && (myT < 0 || m.solo)) return { ok: false, why: "na" };
  const tm = m.teams[tIdx];
  if (!tm || tm.phase !== "run") return { ok: false, why: "idle", tIdx };
  if (CARRY_ROLES.includes(st.role.kind)) return { ok: false, why: "busy" };
  const b = myBudget();
  if (!b) return { ok: false, why: "na" };
  const { charges } = chargesNow(b);
  const now = serverNow();
  const cd = (b.cd && b.cd[id]) || 0;
  if (cd > now) return { ok: false, why: "cd", left: (cd - now) / (def.cd || 1), tIdx };
  if (charges < def.cost) return { ok: false, why: "cost", tIdx };
  if (def.kind === "hit" && now + TELEGRAPH_MS < tm.immuneUntil) return { ok: false, why: "shield", tIdx };
  return { ok: true, tIdx };
}

function playCard(id) {
  audioCtx();
  const s = cardState(id);
  if (!s.ok) {
    sfx.denied();
    const msg = { idle: "Nobody to aim at right now.", cd: "Still recharging.", cost: "Not enough charge yet.", shield: "They're shielded for a moment.", off: "Mischief is off this game.", busy: "You're holding a glass!", wait: "Wait for the relay to start." }[s.why];
    if (msg) toast(msg, 1400);
    return;
  }
  net.send({ t: "card", card: id, team: s.tIdx });
  buzz(25);
  const b = document.querySelector(`.card[data-card="${id}"]`);
  restartAnim(b, "thrown");
}

// ───────────────────────────── UI ─────────────────────────────
function renderGameUI() {
  const r = st.role;
  const m = st.match;
  if (!m) return;
  const carryRole = CARRY_ROLES.includes(r.kind);
  $("spec").hidden = carryRole || r.kind === "intro";
  $("hud").hidden = !(r.kind === "runner" || r.kind === "pourer" || r.kind === "catcher" || r.kind === "holder");
  $("actions").hidden = !(r.kind === "runner");
  if (!carryRole) renderSpec();
  if (carryRole) renderHud();
}

function teamName(i) {
  const m = st.match;
  return m && m.solo ? "Solo carry" : TEAMS[i] ? TEAMS[i].name : "";
}

function renderHud() {
  const r = st.role;
  const m = st.match;
  const c = st.carry;
  if (!r.tm || !c) return;
  const tm = r.tm;
  const legNo = r.kind === "pourer" ? tm.leg : tm.leg + 1;
  $("hud-team").textContent = teamName(tm.idx);
  $("hud-team").style.setProperty("--tc", m.solo ? SOLO_DRINK.color : TEAMS[tm.idx].color);
  $("hud-leg").textContent = m.legsTotal > 1 ? `Leg ${legNo} of ${m.legsTotal}` : "";
  $("hud-ml").textContent = fmtMl(c.ml);
  const running = r.kind === "runner" && c.mode === "run";
  $("hud-kept").textContent = running && c.startMl > 0 ? fmtPct(c.ml / c.startMl) : "";
  $("hud-clock").textContent = running ? fmtTime(performance.now() - c.runStart) : "";
  // the hold button
  if (r.kind === "runner") {
    const last = tm.leg >= m.legsTotal - 1;
    const next = !last ? tm.order[tm.leg + 1] : null;
    const self = next === st.pid;
    $("hold-txt").textContent = last ? "Hold to finish" : self ? "Hold to refill" : `Hold to pour`;
    $("hold-sub").textContent = last ? "when you're back at the start" : self ? "into a fresh glass, when you're back" : `into ${nameOf(next)}'s phone, when you're back`;
    $("btn-hold").disabled = c.mode !== "run";
  }
  // centre messages per role
  const now = performance.now();
  if (performance.now() < st.verdictUntil) { hideCenter(); return; }
  $("ov-verdict").hidden = true;
  if (r.kind === "runner" && tm.phase !== "run" && c.mode !== "run") {
    const left = toPerf(tm.goAt) - now;
    const digit = left <= 1500 ? Math.max(1, Math.ceil(left / 500)) : 0;
    if (digit !== st.lastDigit) {
      st.lastDigit = digit;
      if (digit) { sfx.tick(); buzz(15); }
    }
    if (tm.phase === "fill") showCenter(m.solo ? (m.mischief ? "Chaos carry" : "Solo carry") : `Leg ${legNo} · ${teamName(tm.idx)}`, digit ? String(digit) : "Hold still", digit ? "" : "The bartender is filling your glass to the brim.", 0, digit ? "count" : "");
    else if (tm.phase === "refill") showCenter("Fresh glass", digit ? String(digit) : "Hold still", digit ? "" : "Your drink goes into a glass its size: brim-full again.", 0, digit ? "count" : "");
    else showCenter(`${fmtMl(c.ml)} ml caught`, digit ? String(digit) : "Steady…", digit ? "" : "Then off you go.", 0, digit ? "count" : "");
  } else if (r.kind === "catcher") {
    showCenter("Catch!", `${nameOf(tm.from)} is pouring`, "Hold your phone level and still under theirs. Splashes count against you.", 0, "");
  } else if (r.kind === "pourer") {
    const poured = tm.pourVol > 0 ? 1 - c.ml / tm.pourVol : 1;
    showCenter("Pour it on", `Tip it over ${nameOf(tm.runner)}'s phone`, poured > 0.03 ? `${fmtPct(Math.min(1, poured))} poured` : "Slow and steady: a gentle pour splashes less.", 0, "");
  } else if (r.kind === "holder") {
    showCenter("Set it down", "Nice carry", `You'll pour it into ${nameOf(tm.order[tm.leg + 1])}'s phone when ${teamName(tm.idx)} is up again.`, 0, "");
  } else if (!$("center").classList.contains("go")) hideCenter();
}

let centerUntil = 0;
function showCenter(kick, big, sub, ms = 0, cls = "") {
  const c = $("center");
  if ($("c-big").textContent !== big) restartAnim($("c-big"));
  $("c-kick").textContent = kick;
  $("c-big").textContent = big;
  $("c-sub").textContent = sub;
  c.className = `center ${cls}`;
  c.hidden = false;
  if (ms) {
    centerUntil = performance.now() + ms;
    setTimeout(() => { if (performance.now() >= centerUntil - 5) { c.hidden = true; c.classList.remove("go"); } }, ms);
  }
}
function hideCenter() {
  const c = $("center");
  if (performance.now() < centerUntil) return;
  c.hidden = true;
  c.className = "center";
}

function renderSpec() {
  const m = st.match;
  if (!m) return;
  // labels over each glass
  const labels = m.teams.map((tm) => {
    const rep = st.reps[tm.idx];
    const runner = tm.phase === "pour" ? `${nameOf(tm.from)} → ${nameOf(tm.runner)}` : nameOf(tm.runner);
    const ml = tm.phase === "done" ? tm.final : rep ? rep.ml : tm.vol;
    const status = { wait: "waiting", fill: "filling up", refill: "fresh glass", pour: "pouring", ready: "steady…", run: "running", hold: "set down", done: "delivered" }[tm.phase] || "";
    const legNo = Math.min(m.legsTotal, tm.leg + 1);
    return `<div class="sl t${m.solo ? "s" : tm.idx}"><b>${esc(teamName(tm.idx))}</b><span class="sl-run">${esc(runner)}</span><span class="sl-ml">${fmtMl(ml)}<small> ml</small></span><span class="sl-st">${status}${m.legsTotal > 1 && tm.phase !== "done" ? ` · leg ${legNo}/${m.legsTotal}` : ""}</span></div>`;
  });
  const key = labels.join("");
  if ($("spec-labels").dataset.key !== key) {
    $("spec-labels").dataset.key = key;
    $("spec-labels").innerHTML = key;
  }
  $("spec-labels").classList.toggle("one", m.teams.length === 1);
  // status line
  const myT = myTeamIdx(m);
  let status = "";
  if (m.phase === "done") status = "That's the relay! Results coming up…";
  else if (myT >= 0) {
    const tm = m.teams[myT];
    // the first leg that hasn't started yet
    const from = tm.phase === "wait" ? 0 : tm.leg + 1;
    const nextK = tm.phase === "done" ? -1 : tm.order.findIndex((id, k) => k >= from && id === st.pid);
    if (tm.phase === "done") status = `${teamName(myT)} delivered ${fmtMl(tm.final)} ml. Keep making mischief!`;
    else if (nextK === from && from === 0) status = `<b>You run first!</b> Get to the start line.`;
    else if (nextK === from) status = `<b>You're up next!</b> Get to the start, ready to catch.`;
    else if (nextK > 0) status = `You run leg ${nextK + 1} of ${m.legsTotal}. Until then: mischief.`;
    else status = `You've run your leg${m.legsTotal > 1 && tm.order.filter((id) => id === st.pid).length > 1 ? "s" : ""}. Make the other team spill!`;
  } else status = m.solo ? "Heckling a solo carry. Make them spill!" : "You're heckling. Pick a runner and make them spill.";
  $("spec-status").innerHTML = status;
  // heckler target
  const showTarget = myT < 0 && !m.solo && m.teams.length === 2;
  $("target").hidden = !showTarget;
  if (showTarget) {
    $("target").innerHTML = m.teams.map((tm) => `<button type="button" data-team="${tm.idx}" class="t${tm.idx} ${st.heckTarget === tm.idx ? "on" : ""}">Aim at ${esc(teamName(tm.idx))}</button>`).join("");
  }
  renderDeck();
}

function renderDeck() {
  const m = st.match;
  if (!m) return;
  const off = !m.mischief && !(m.solo && myTeamIdx(m) < 0);
  $("deck").classList.toggle("off", off);
  const b = myBudget();
  const { charges, next } = chargesNow(b);
  const max = b ? b.max : CHARGE.teamMax;
  let pips = "";
  for (let i = 0; i < max; i++) pips += `<i class="${i < charges ? "on" : i === charges ? "fill" : ""}" style="--k:${i === charges ? next : 0}"></i>`;
  if ($("charges").dataset.k !== pips) { $("charges").dataset.k = pips; $("charges").innerHTML = pips; }
  $("charges-lbl").textContent = off ? "Mischief is off this game" : myTeamIdx(m) >= 0 && !m.solo ? `${teamName(myTeamIdx(m))}'s mischief` : "Your mischief";
  for (const el of $("deck").children) {
    const s = cardState(el.dataset.card);
    el.classList.toggle("ok", s.ok);
    el.dataset.why = s.why || "";
    el.style.setProperty("--cd", s.why === "cd" ? Math.max(0, Math.min(1, s.left)) : 0);
    el.hidden = CARDS[el.dataset.card].kind === "help" && (myTeamIdx(m) < 0 || m.solo);
  }
}

function uiTick() {
  if (!st.match || !scr.game.classList.contains("on")) return;
  const r = st.role;
  if (CARRY_ROLES.includes(r.kind)) renderHud();
  else renderSpec();
  if (r.kind === "intro") renderIntroCount();
}

// ───────────────────────────── intro ─────────────────────────────
function showIntro() {
  const m = st.match;
  const t = myTeamIdx(m);
  $("in-kick").textContent = m.solo ? "Solo carry" : `${MODES[m.mode].label} · ${FILLS[m.fill].label}`;
  $("in-title").textContent = m.solo ? (m.mischief ? "Chaos carry" : "Carry it round the room") : m.mode === "race" ? "Both teams run at once" : "One runner at a time";
  let mine = "";
  if (t >= 0) {
    const k = m.teams[t].order.indexOf(st.pid);
    mine = m.solo
      ? `Walk your glass round the room and back, then hold the button. ${m.mischief ? "The bar will throw things at you." : ""}`
      : k === 0 ? `You run first for ${teamName(t)}. Get to the start line!` : `You run leg ${k + 1} for ${teamName(t)}. Make mischief until then.`;
  } else mine = "You're heckling: throw cards at the runners.";
  $("in-me").textContent = mine;
  $("in-order").innerHTML = m.solo ? "" : m.teams.map((tm) => `<div class="io t${tm.idx}"><h4>${esc(teamName(tm.idx))}</h4><ol>${tm.order.map((id) => `<li class="${id === st.pid ? "me" : ""}">${esc(nameOf(id))}</li>`).join("")}</ol></div>`).join("");
  $("ov-intro").hidden = false;
  renderIntroCount();
}
function renderIntroCount() {
  const m = st.match;
  const left = Math.max(0, toPerf(m.introEnd) - performance.now());
  $("in-count").textContent = left > 0 ? `Starting in ${Math.ceil(left / 1000)}` : "";
}

// ───────────────────────────── results ─────────────────────────────
function onOver(o) {
  if (st.liveSeen !== o.id) {
    if (o.winner != null && o.winner >= 0) toast(`Last relay: ${TEAMS[o.winner].name} won, ${fmtMl(o.teams[o.winner].final)} to ${fmtMl(o.teams[1 - o.winner].final)} ml`, 3500);
    toLobbyScreen();
    return;
  }
  st.over = o;
  st.match && (st.match.phase = "done");
  stopGame();
  releaseWake();
  showScreen(scr.over);
  document.body.classList.add("show-hub");
  const myT = o.teams.findIndex((t) => t.legs.some((l) => l.runner === st.pid));
  let kicker, title, sub = "";
  if (o.solo) {
    const t = o.teams[0];
    const kept = t.final / V0_ML;
    kicker = o.legsTotal > 1 ? `Solo carry · ${o.legsTotal} laps` : "Solo carry";
    title = fmtPct(kept);
    const pbKey = `${PBKEY}:${o.fill}:${o.legsTotal}`;
    let pb = 0;
    try { pb = Number(localStorage.getItem(pbKey)) || 0; } catch {}
    const mineRun = t.legs.some((l) => l.runner === st.pid);
    const isPb = mineRun && kept > pb + 1e-6;
    if (isPb) { try { localStorage.setItem(pbKey, String(kept)); } catch {} }
    sub = `${grade(kept)}. You kept ${fmtMl(t.final)} of ${V0_ML} ml.${isPb ? " New personal best!" : pb ? ` Best: ${fmtPct(pb)}.` : ""}`;
    if (isPb || kept >= 0.85) st.stopConfetti = confetti($("ov-confetti"), [SOLO_DRINK.color, SOLO_DRINK.top, "#fff3d6", "#58e6ff"]);
  } else if (o.winner === -1) {
    kicker = "Dead heat";
    title = "It's a tie!";
    sub = `Both teams delivered ${fmtMl(o.teams[0].final)} ml.`;
  } else {
    const w = o.teams[o.winner];
    const l = o.teams[1 - o.winner];
    kicker = myT === o.winner ? "You win!" : myT >= 0 ? "So close" : "Winner";
    title = `${TEAMS[o.winner].name} wins`;
    sub = `${fmtMl(w.final)} ml to ${fmtMl(l.final)} ml.`;
    if (myT === o.winner || myT < 0) st.stopConfetti = confetti($("ov-confetti"), [TEAMS[o.winner].color, TEAMS[o.winner].top, "#fff3d6", TEAMS[o.winner].glow]);
  }
  $("ov-kicker").textContent = kicker;
  $("ov-title").textContent = title;
  $("ov-title").style.setProperty("--tc", o.solo ? SOLO_DRINK.color : o.winner >= 0 ? TEAMS[o.winner].color : "#fff");
  restartAnim($("ov-title"));
  $("ov-sub").textContent = sub;
  if ((o.solo && o.teams[0].final / V0_ML >= 0.85) || myT === o.winner) { sfx.fanfare(); buzz([40, 60, 40, 60, 120]); }
  else if (!o.solo && myT >= 0) sfx.sad();
  $("ov-score").innerHTML = o.solo ? "" : o.teams.map((t) => {
    const k = Math.cbrt(Math.max(1, t.final) / V0_ML);
    return `<div class="sc t${t.idx} ${o.winner === t.idx ? "win" : ""}"><span class="sc-glass" style="--k:${(t.final / V0_ML).toFixed(3)};--s:${k.toFixed(3)}"><i></i></span><b>${fmtMl(t.final)}<small> ml</small></b><span>${esc(TEAMS[t.idx].name)}</span></div>`;
  }).join("");
  if (o.solo) {
    const l = o.teams[0].legs;
    const sum = (k) => l.reduce((a, x) => a + (x[k] || 0), 0);
    const ms = sum("ms"), steps = sum("steps");
    $("ov-awards").innerHTML = [["Time", fmtTime(ms)], ["Spilled", `${fmtMl(sum("spill"))} ml`], ["Leaked", `${fmtMl(sum("leak"))} ml`], steps ? ["Steps", String(steps)] : null]
      .filter(Boolean).map(([k, v]) => `<div class="aw"><span class="aw-l">${k}</span><b>${v}</b></div>`).join("");
  } else $("ov-awards").innerHTML = o.awards.map((a) => `<div class="aw"><span class="aw-l">${esc(a.label)}</span><b>${esc(nameOf(a.pid))}</b><small>${esc(a.value)}</small></div>`).join("");
  $("ov-legs").innerHTML = o.teams.map((t) => `<div class="legs t${o.solo ? "s" : t.idx}">${o.solo ? "" : `<h4>${esc(TEAMS[t.idx].name)}</h4>`}<ol>${t.legs.map((l, k) => {
    const kept = l.startMl > 0 ? l.endMl / l.startMl : 0;
    const note = l.skipped ? "skipped" : l.forced ? "timed out" : `${fmtTime(l.ms)}${l.handoff >= 1 ? ` · splashed ${fmtMl(l.handoff)} ml catching` : ""}`;
    return `<li class="${l.runner === st.pid ? "me" : ""}"><span class="lg-n">${k + 1}</span><span class="lg-who">${esc(nameOf(l.runner))}</span><span class="lg-pct" style="--k:${kept.toFixed(3)}">${fmtPct(kept)}</span><small>${note}</small></li>`;
  }).join("")}</ol></div>`).join("");
  renderOverActions();
}
function renderOverActions() {
  const host = isHost();
  const solo = !!(st.over && st.over.solo) && st.room && st.room.players.length === 1;
  $("btn-again").hidden = !host;
  $("btn-again").textContent = solo ? (st.room.settings.mischief ? "Another chaos carry" : "Carry another") : "Play again";
  $("btn-mode").hidden = !host || !solo;
  $("btn-mode").textContent = st.room && st.room.settings.mischief ? "Back to a calm carry" : "Try a chaos carry";
  $("btn-tolobby").hidden = !host;
  $("btn-tolobby").textContent = solo ? "Settings, or invite friends" : "Change teams or settings";
  $("ov-wait").hidden = host;
}

// ───────────────────────────── odds and ends ─────────────────────────────
function stopGame() {
  clearTimeout(st.goTimer);
  stopTel();
  pourSound(0);
  if (st.carry) { st.carry.stop(); st.carry = null; }
  if (st.stage) { st.stage.stop(); st.stage = null; }
  st.lastStage = "";
  st.reps = [];
  st.carryLeg = "";
  st.roleKey = "";
  st.role = { kind: "none" };
  st.frost.stop();
  $("banner").hidden = true;
  $("ov-intro").hidden = true;
  $("ov-verdict").hidden = true;
  hideCenter();
  applyDeviceFrame();
}

function keepAwake() {
  if (!("wakeLock" in navigator) || st.wake) return;
  navigator.wakeLock.request("screen").then((l) => {
    st.wake = l;
    l.addEventListener("release", () => { st.wake = null; });
  }).catch(() => {});
}
function releaseWake() {
  if (st.wake) { st.wake.release().catch(() => {}); st.wake = null; }
}

// Keep the glass upright relative to the phone even if the OS rotates the page
// (tipping a phone sideways to pour can flip it to landscape).
function applyDeviceFrame() {
  const wrap = $("stage-wrap");
  const holding = CARRY_ROLES.includes(st.role.kind) && scr.game.classList.contains("on");
  // only when a phone's page has actually flipped to landscape (tablets and desktops,
  // whose natural orientation differs, report angles too)
  const a = holding && innerWidth > innerHeight * 1.15 && innerHeight < 600 ? screenAngle() : 0;
  if (a !== 90 && a !== 270) {
    if (wrap.style.transform) { wrap.style.cssText = ""; st.carry && st.carry.resize(); }
    layoutCarry();
    return;
  }
  const W = innerWidth, H = innerHeight;
  if (a === 90) wrap.style.cssText = `width:${H}px;height:${W}px;transform-origin:0 0;transform:translate(0px,${H}px) rotate(-90deg)`;
  else wrap.style.cssText = `width:${H}px;height:${W}px;transform-origin:0 0;transform:translate(${W}px,0px) rotate(90deg)`;
  if (st.carry) { st.carry.resize(); layoutCarry(); }
}

const feedQ = [];
function feed(text, card) {
  const el = document.createElement("div");
  el.className = "feed-item";
  el.style.setProperty("--cc", CARD_COLORS[card] || "#fff");
  el.innerHTML = `${icon(card)}<span>${esc(text)}</span>`;
  $("floaters").appendChild(el);
  feedQ.push(el);
  while (feedQ.length > 3) feedQ.shift().remove();
  setTimeout(() => { el.remove(); const i = feedQ.indexOf(el); if (i >= 0) feedQ.splice(i, 1); }, 2600);
}

// Frost: the screen ices over; rub it off with a finger.
class Frost {
  constructor(cv) {
    this.cv = cv;
    this.ctx = cv.getContext("2d");
    this.until = 0;
    this.timer = null;
    const erase = (e) => {
      if (this.cv.hidden) return;
      const x = e.offsetX, y = e.offsetY;
      const c = this.ctx;
      c.save();
      c.globalCompositeOperation = "destination-out";
      const g = c.createRadialGradient(x, y, 0, x, y, 46);
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(0.7, "rgba(0,0,0,0.8)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, 46, 0, Math.PI * 2);
      c.fill();
      c.restore();
    };
    cv.addEventListener("pointerdown", (e) => { this.down = true; erase(e); e.preventDefault(); });
    cv.addEventListener("pointermove", (e) => { if (this.down || e.pointerType === "touch") erase(e); });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) cv.addEventListener(ev, () => { this.down = false; });
  }
  start(ms) {
    const cv = this.cv;
    const w = cv.clientWidth || innerWidth, h = cv.clientHeight || innerHeight;
    cv.hidden = false;
    cv.width = w; cv.height = h;
    const c = this.ctx;
    c.clearRect(0, 0, w, h);
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "rgba(232,244,255,0.94)");
    g.addColorStop(0.5, "rgba(206,228,250,0.9)");
    g.addColorStop(1, "rgba(236,246,255,0.95)");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // frost ferns growing in from the edges
    c.strokeStyle = "rgba(255,255,255,0.75)";
    c.lineCap = "round";
    const fern = (x, y, a, len, depth) => {
      if (depth <= 0 || len < 4) return;
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      c.lineWidth = Math.max(0.6, depth * 0.55);
      c.beginPath(); c.moveTo(x, y); c.lineTo(x2, y2); c.stroke();
      fern(x2, y2, a + (Math.random() - 0.5) * 0.5, len * 0.78, depth - 1);
      if (Math.random() < 0.8) fern(x + (x2 - x) * 0.5, y + (y2 - y) * 0.5, a - 0.9 + Math.random() * 0.3, len * 0.5, depth - 2);
      if (Math.random() < 0.8) fern(x + (x2 - x) * 0.5, y + (y2 - y) * 0.5, a + 0.9 - Math.random() * 0.3, len * 0.5, depth - 2);
    };
    for (let i = 0; i < 16; i++) {
      const side = i % 4;
      const x = side === 0 ? 0 : side === 1 ? w : Math.random() * w;
      const y = side === 2 ? 0 : side === 3 ? h : Math.random() * h;
      const a = Math.atan2(h / 2 - y, w / 2 - x) + (Math.random() - 0.5) * 0.9;
      fern(x, y, a, 40 + Math.random() * 50, 6);
    }
    for (let i = 0; i < 260; i++) {
      c.fillStyle = `rgba(255,255,255,${0.3 + Math.random() * 0.5})`;
      c.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    }
    c.fillStyle = "rgba(60,90,130,0.55)";
    c.font = "700 15px Manrope, system-ui, sans-serif";
    c.textAlign = "center";
    c.fillText("Frosted! Rub it clear", w / 2, h * 0.5);
    cv.classList.remove("melt");
    restartAnim(cv, "freeze");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(true), ms);
  }
  stop(melt = false) {
    clearTimeout(this.timer);
    if (this.cv.hidden) return;
    if (melt) {
      this.cv.classList.add("melt");
      this.timer = setTimeout(() => { this.cv.hidden = true; this.cv.classList.remove("melt"); }, 900);
    } else this.cv.hidden = true;
  }
}

// dev: an autopilot that plays whatever role this phone has
if (DEV) {
  window.__brimAuto = (on = true) => {
    clearInterval(window.__brimAutoT);
    if (!on) return;
    let runStart = 0;
    window.__brimAutoT = setInterval(() => {
      const r = st.role;
      const sim = S.sim && S.sim.st;
      if (!sim) return;
      if (r.kind === "runner" && st.carry && st.carry.mode === "run") {
        if (!runStart) runStart = performance.now();
        sim.walk = 0.8;
        sim.tg = 0;
        if (performance.now() - runStart > 5000 + Math.random() * 3000) {
          sim.walk = 0;
          runStart = 0;
          arrive();
        }
      } else if (r.kind === "pourer") {
        sim.walk = 0;
        sim.tg = 75;
        sim.tb = 30;
      } else {
        sim.walk = 0;
        sim.tg = 0;
        sim.tb = 55;
        runStart = 0;
        if (r.kind === "spec" && Math.random() < 0.08) {
          const ok = CARD_ORDER.filter((id) => cardState(id).ok);
          if (ok.length) playCard(ok[(Math.random() * ok.length) | 0]);
        }
      }
    }, 250);
  };
}
