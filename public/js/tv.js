// The big screen (TV or laptop): join QR and teams in the lobby, both teams' glasses
// live during the relay, and the results. It never carries a glass.
import { Net } from "./net.js";
import { Replica, Stage, syncReplica } from "./stage.js";
import { sfx, say, audioCtx, setMuted } from "./audio.js";
import { TEAMS, SOLO_DRINK, CARDS, CHARGE, FILLS, MODES, V0_ML, grade } from "./rules.js";
import { $, esc, avatar, toast, showScreen, joinUrl, qrSvg, confetti, icon, fmtMl, fmtPct, fmtTime, restartAnim, CARD_COLORS, floatCheer } from "./ui.js";

const params = new URLSearchParams(location.search);
const TVKEY = "brim-tv";

const st = {
  code: null, room: null, match: null, over: null,
  stage: null, reps: [], stageKey: "", sound: false, stopConfetti: null,
  said: new Set(), lastPhase: [],
};
const scr = { lobby: $("tv-lobby"), game: $("tv-game"), over: $("tv-over") };
const net = new Net({ onMsg, onOpen });
const toPerf = (t) => net.toPerf(t);
const serverNow = () => Date.now() + net.offset;

export function startTv() {
  $("phone").hidden = true;
  $("tv").hidden = false;
  document.body.classList.add("show-hub", "is-tv");
  setMuted(true);
  // reuse the phone's animated logo, with its own ids (duplicate ids would point the
  // clip path at the hidden phone copy)
  $("tv-lobby").querySelector(".tvlogo").innerHTML = document.querySelector("#scr-home .logo").innerHTML.replace(/lg-/g, "tvlg-");
  showScreen(scr.lobby);
  $("tv-start").addEventListener("click", () => { soundOn(); net.send({ t: "start" }); });
  $("tv-again").addEventListener("click", () => { soundOn(); net.send({ t: "start" }); });
  $("tv-tolobby").addEventListener("click", () => net.send({ t: "toLobby" }));
  $("tv-sound").addEventListener("click", () => (st.sound ? soundOff() : soundOn()));
  $("tv-join").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = $("tv-join-code").value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    if (code.length !== 4) return toast("Room codes are 4 letters.");
    net.send({ t: "join", code, display: true });
  });
  for (const seg of document.querySelectorAll("#tv-settings .seg")) {
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      let v = b.dataset.v;
      if (seg.dataset.k === "legs") v = Number(v);
      if (seg.dataset.k === "mischief") v = v === "true";
      net.send({ t: "settings", [seg.dataset.k]: v });
    });
  }
  net.connect();
  setInterval(tick, 100);
}

function soundOn() {
  audioCtx();
  setMuted(false);
  st.sound = true;
  $("tv-sound").textContent = "Sound on";
}
function soundOff() {
  setMuted(true);
  st.sound = false;
  $("tv-sound").textContent = "Turn sound on";
}

function onOpen() {
  const code = st.code || (params.get("room") || "").toUpperCase().slice(0, 4) || sessionStorage.getItem(TVKEY);
  if (code) net.send({ t: "join", code, display: true });
  else net.send({ t: "create", display: true });
}

function onMsg(m) {
  switch (m.t) {
    case "joined":
      st.code = m.code;
      sessionStorage.setItem(TVKEY, m.code);
      history.replaceState(null, "", `${location.pathname}?tv&room=${m.code}`);
      $("tv-code").textContent = m.code;
      $("tv-codechip").textContent = m.code;
      $("tv-url").textContent = joinUrl().replace(/^https?:\/\//, "").replace(/\/$/, "");
      $("tv-qr").innerHTML = qrSvg(joinUrl(m.code));
      return;
    case "room": return onRoom(m);
    case "match": return onMatch(m);
    case "tels": return onTels(m);
    case "pourIn": {
      const rep = st.reps[m.team];
      if (rep) rep.pourIn(m.amt);
      if (st.match && st.match.teams[m.team]) st.match.teams[m.team].poured = m.total;
      return;
    }
    case "fx": return onFx(m);
    case "over": return onOver(m);
    case "cheer": return floatCheer(m.e, $("tv-floaters"));
    case "lobby":
      st.match = st.over = null;
      stopStage();
      showScreen(scr.lobby);
      document.body.classList.add("show-hub");
      return;
    case "err":
      if (m.code === "noroom") {
        st.code = null;
        sessionStorage.removeItem(TVKEY);
        net.send({ t: "create", display: true });
        return;
      }
      toast(m.msg || "Something went wrong.");
  }
}

const nameOf = (id) => {
  if (id === 0) return "The bar";
  const p = st.room && st.room.players.find((x) => x.id === id);
  return p ? p.name : "Someone";
};
const playerOf = (id) => (st.room && st.room.players.find((x) => x.id === id)) || { id, name: "Player", team: -1 };
const teamName = (i) => (st.match && st.match.solo ? "Solo carry" : TEAMS[i] ? TEAMS[i].name : "");

function onRoom(m) {
  st.room = m;
  if (m.phase === "lobby" && !st.match && !scr.lobby.classList.contains("on")) showScreen(scr.lobby);
  for (const t of [0, 1]) {
    const ps = m.players.filter((p) => p.team === t);
    $(`tv-tc${t}`).textContent = ps.length ? `· ${ps.length}` : "";
    $(`tv-tl${t}`).innerHTML = ps.map((p) => `<li class="${p.connected ? "" : "off"}">${avatar(p, t)}<span>${esc(p.name)}<small>${p.ready ? "ready" : "picking up their glass…"}</small></span></li>`).join("");
  }
  const heck = m.players.filter((p) => p.team !== 0 && p.team !== 1);
  $("tv-heck").textContent = heck.length ? `Heckling: ${heck.map((p) => p.name).join(", ")}` : "";
  $("tv-empty").hidden = m.players.length > 0;
  const s = m.settings;
  for (const seg of document.querySelectorAll("#tv-settings .seg")) {
    for (const b of seg.children) b.classList.toggle("on", String(s[seg.dataset.k]) === b.dataset.v);
  }
  const ready = m.players.filter((p) => p.ready && p.connected && (p.team === 0 || p.team === 1)).length;
  const btn = $("tv-start");
  btn.disabled = ready === 0;
  btn.textContent = ready === 1 ? "Start a solo carry" : ready ? `Start · ${ready} ready` : "Start";
}

// ───────────────────────────── the relay ─────────────────────────────
function onMatch(m) {
  const first = !st.match || st.match.id !== m.id;
  const prev = st.match;
  st.match = m;
  if (first) {
    st.over = null;
    st.said.clear();
    if (st.stopConfetti) { st.stopConfetti(); st.stopConfetti = null; }
  }
  if (m.phase === "done" && st.over) return;
  if (!scr.game.classList.contains("on")) {
    showScreen(scr.game);
    document.body.classList.remove("show-hub");
  }
  ensureStage();
  m.teams.forEach((tm, i) => {
    const changed = st.reps[i] && syncReplica(st.reps[i], tm, m, toPerf);
    if (changed) announce(tm, prev && prev.id === m.id ? prev.teams[i] : null);
  });
  $("tv-title").textContent = m.solo ? (m.mischief ? "Solo carry · chaos" : "Solo carry") : `${MODES[m.mode].label} · ${FILLS[m.fill].label} · ${m.legsTotal} leg${m.legsTotal > 1 ? "s" : ""} each`;
  renderIntro();
  renderPanels();
}

function ensureStage() {
  const m = st.match;
  const key = `${m.id}`;
  if (st.stage && st.stageKey === key) return;
  stopStage();
  st.stageKey = key;
  st.stage = new Stage($("tv-stage"));
  st.reps = m.teams.map((tm) => {
    const r = new Replica(m.solo ? SOLO_DRINK : TEAMS[tm.idx], m.fill);
    r.actor.landed = (f) => landSound(f.card);
    return r;
  });
  st.stage.setSlots(m.teams.length === 1
    ? [{ rep: st.reps[0], box: [0.25, 0.06, 0.5, 0.66], widthK: 0.3 }]
    : [{ rep: st.reps[0], box: [0.04, 0.07, 0.42, 0.64], widthK: 0.3 }, { rep: st.reps[1], box: [0.54, 0.07, 0.42, 0.64], widthK: 0.3 }]);
  $("tv-panels").classList.toggle("one", m.teams.length === 1);
}
function stopStage() {
  if (st.stage) st.stage.stop();
  st.stage = null;
  st.stageKey = "";
  st.reps = [];
}

function landSound(card) {
  switch (card) {
    case "quake": sfx.quake(); break;
    case "ice": sfx.clink(); setTimeout(() => sfx.plop(), 160); break;
    case "fizz": sfx.fizz(); break;
    case "frost": sfx.frost(); break;
    case "swell": sfx.swell(); break;
    case "lid": sfx.lid(); break;
  }
}

function announce(tm, before) {
  const m = st.match;
  const key = `${tm.idx}:${tm.leg}:${tm.phase}`;
  if (st.said.has(key)) return;
  st.said.add(key);
  const who = nameOf(tm.runner);
  const team = teamName(tm.idx);
  if (tm.phase === "run") { sfx.go(); say(m.solo ? `Go, ${who}!` : `${who}, go!`); }
  else if (tm.phase === "pour") say(`${nameOf(tm.from)}, pour it into ${who}'s glass!`);
  else if (tm.phase === "done" && before && before.phase !== "done") {
    sfx.win();
    say(`${m.solo ? who : team} delivers ${Math.round(tm.final)} millilitres!`);
  }
}

function onTels(m) {
  for (const [team, leg, ml, , st2, gx, gz, gv] of m.d) {
    const rep = st.reps[team];
    const tm = st.match && st.match.teams[team];
    if (!rep || !tm || tm.leg !== leg) continue;
    rep.tel(ml, gx, gz, gv);
    tm.vol = ml;
    tm.steps = st2;
  }
}

function onFx(f) {
  const m = st.match;
  if (!m) return;
  const rep = st.reps[f.team];
  if (rep) rep.actor.addFx({ id: f.id, card: f.card, land: toPerf(f.landAt), seed: f.seed, from: f.from });
  const tm = m.teams[f.team];
  const def = CARDS[f.card];
  const from = nameOf(f.from);
  const to = nameOf(tm.runner);
  const text = def.kind === "help" ? `${from} puts a lid on ${to}'s glass` : f.from === 0 ? `The bar sends ${def.name.toLowerCase()} at ${to}` : `${from} → ${def.name.toLowerCase()} → ${to}`;
  feed(text, f.card);
  sfx.card();
  const line = { quake: `Earthquake for ${to}!`, ice: `Ice cube for ${to}!`, fizz: `${to}'s drink is fizzing!`, frost: `Frost on ${to}'s glass!`, swell: `Rough seas for ${to}!`, lid: `${to} gets a lid!` }[f.card];
  if (line) say(line, { rate: 1.12 });
}

const feedQ = [];
function feed(text, card) {
  const el = document.createElement("div");
  el.className = "feed-item";
  el.style.setProperty("--cc", CARD_COLORS[card] || "#fff");
  el.innerHTML = `${icon(card)}<span>${esc(text)}</span>`;
  $("tv-feed").prepend(el);
  feedQ.push(el);
  while (feedQ.length > 4) feedQ.shift().remove();
  setTimeout(() => { el.remove(); const i = feedQ.indexOf(el); if (i >= 0) feedQ.splice(i, 1); }, 2600);
}

function renderIntro() {
  const m = st.match;
  const box = $("tv-intro");
  if (m.phase !== "intro") { box.hidden = true; return; }
  if (box.hidden) {
    say(m.solo ? "Solo carry. Get ready!" : "Get ready! First runners, to the start line.");
    sfx.tick();
  }
  box.hidden = false;
  const title = m.solo ? (m.mischief ? "Chaos carry" : "Carry it round the room") : m.mode === "race" ? "Both teams run at once" : "One runner at a time";
  const sub = m.solo
    ? `${nameOf(m.teams[0].runner)} carries a brim-full glass round the room and back. ${m.mischief ? "The bar will throw things at it." : "Every drop counts."}`
    : "Carry your glass round the course and back, then pour it into the next runner's phone. Everyone else: throw cards at the other team. Most drink at the end wins.";
  const html = `<p class="kicker">${esc(m.solo ? "Solo" : `${MODES[m.mode].label} · ${FILLS[m.fill].label}`)}</p><h2>${esc(title)}</h2><p>${esc(sub)}</p>` +
    (m.solo ? "" : `<div class="in-order">${m.teams.map((tm) => `<div class="io t${tm.idx}"><h4>${esc(teamName(tm.idx))}</h4><ol>${tm.order.map((id) => `<li>${esc(nameOf(id))}</li>`).join("")}</ol></div>`).join("")}</div>`) +
    `<p class="in-count" id="tv-in-count"></p>`;
  if (box.dataset.k !== html) { box.dataset.k = html; box.innerHTML = html; }
}

function chargesNow(tm) {
  let c = tm.charges, at = tm.chargeAt;
  const now = serverNow();
  while (c < CHARGE.teamMax && now >= at) { c++; at += CHARGE.teamMs; }
  return c;
}

function renderPanels() {
  const m = st.match;
  if (!m) return;
  const html = m.teams.map((tm) => {
    const rep = st.reps[tm.idx];
    const p = playerOf(tm.phase === "pour" ? tm.from : tm.runner);
    const ml = tm.phase === "done" ? tm.final : rep ? rep.ml : tm.vol;
    const leg = tm.legs[tm.leg];
    const nowT = performance.now();
    let status = "";
    switch (tm.phase) {
      case "wait": status = "Waiting for their turn"; break;
      case "fill": status = "The bartender is pouring…"; break;
      case "refill": status = "Into a fresh glass…"; break;
      case "pour": status = `Pouring into ${esc(nameOf(tm.runner))}'s phone`; break;
      case "ready": { const left = Math.ceil((toPerf(tm.goAt) - nowT) / 1000); status = `${esc(nameOf(tm.runner))} caught ${fmtMl(tm.poured)} ml · go in ${Math.max(1, left)}`; break; }
      case "run": {
        const start = leg && leg.startMl ? leg.startMl : tm.vol;
        status = `Running · ${fmtTime(Math.max(0, serverNow() - tm.at))} · kept ${fmtPct(start > 0 ? (rep ? rep.ml : tm.vol) / start : 1)}${tm.steps ? ` · ${tm.steps} steps` : ""}`;
        break;
      }
      case "hold": status = "Glass set down, waiting"; break;
      case "done": status = `Delivered: ${grade(tm.final / V0_ML)}`; break;
    }
    const legs = m.legsTotal > 1 || !m.solo ? `<div class="tvp-legs">${tm.order.map((_, k) => `<i class="${k < tm.leg || tm.phase === "done" || (k === tm.leg && tm.phase === "hold") ? "done" : k === tm.leg && tm.phase !== "wait" ? "now" : ""}"></i>`).join("")}</div>` : "";
    let pips = "";
    if (m.mischief && !m.solo) {
      const c = chargesNow(tm);
      for (let i = 0; i < CHARGE.teamMax; i++) pips += `<i class="${i < c ? "on" : ""}"></i>`;
      pips = `<span class="charges" title="Mischief">${pips}</span>`;
    }
    return `<div class="tvp t${m.solo ? "s" : tm.idx}"><div class="tvp-top"><h3>${esc(teamName(tm.idx))}</h3>${pips}</div>` +
      `<div class="tvp-top"><span class="tvp-run">${tm.phase === "done" ? "" : avatar(p, m.solo ? 0 : tm.idx)}${tm.phase === "done" ? "Finished" : esc(p.name)}</span><span class="tvp-ml">${fmtMl(ml)}<small> ml</small></span></div>` +
      `<span class="tvp-st">${status}</span>${legs}</div>`;
  }).join("");
  if ($("tv-panels").dataset.k !== html) { $("tv-panels").dataset.k = html; $("tv-panels").innerHTML = html; }
}

function tick() {
  if (!st.match || !scr.game.classList.contains("on")) return;
  renderPanels();
  const m = st.match;
  const c = $("tv-in-count");
  if (c && m.phase === "intro") {
    const left = Math.max(0, toPerf(m.introEnd) - performance.now());
    c.textContent = left > 0 ? `Starting in ${Math.ceil(left / 1000)}` : "";
  }
}

// ───────────────────────────── results ─────────────────────────────
function onOver(o) {
  st.over = o;
  stopStage();
  showScreen(scr.over);
  document.body.classList.add("show-hub");
  if (o.solo) {
    const t = o.teams[0];
    const kept = t.final / V0_ML;
    const runner = t.legs[0] ? nameOf(t.legs[0].runner) : "";
    $("tv-over-kicker").textContent = `Solo carry · ${runner}`;
    $("tv-winner").textContent = `${fmtPct(kept)} · ${grade(kept)}`;
    $("tv-winner").style.setProperty("--tc", SOLO_DRINK.color);
    $("tv-score").innerHTML = "";
    say(`${runner} kept ${Math.round(kept * 100)} percent. ${grade(kept)}!`);
  } else if (o.winner === -1) {
    $("tv-over-kicker").textContent = "Dead heat";
    $("tv-winner").textContent = "It's a tie!";
    $("tv-winner").style.setProperty("--tc", "#fff");
    say("It's a tie!");
  } else {
    $("tv-over-kicker").textContent = "Winner";
    $("tv-winner").textContent = `${TEAMS[o.winner].name} wins`;
    $("tv-winner").style.setProperty("--tc", TEAMS[o.winner].color);
    say(`${TEAMS[o.winner].name} wins, with ${Math.round(o.teams[o.winner].final)} millilitres!`);
  }
  restartAnim($("tv-winner"));
  if (!o.solo) {
    $("tv-score").innerHTML = o.teams.map((t) => {
      const k = Math.cbrt(Math.max(1, t.final) / V0_ML);
      return `<div class="sc t${t.idx} ${o.winner === t.idx ? "win" : ""}"><span class="sc-glass" style="--k:${(t.final / V0_ML).toFixed(3)};--s:${k.toFixed(3)}"><i></i></span><b>${fmtMl(t.final)}<small> ml</small></b><span>${esc(TEAMS[t.idx].name)}</span></div>`;
    }).join("");
  }
  $("tv-awards").innerHTML = o.awards.map((a) => `<div class="aw"><span class="aw-l">${esc(a.label)}</span><b>${esc(nameOf(a.pid))}</b><small>${esc(a.value)}</small></div>`).join("");
  sfx.fanfare();
  if (st.stopConfetti) st.stopConfetti();
  const col = o.solo ? SOLO_DRINK : TEAMS[Math.max(0, o.winner)];
  st.stopConfetti = confetti($("tv-confetti"), [col.color, col.top, "#fff3d6", col.glow]);
}
