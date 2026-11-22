// Fill a real room with bot phones for manual testing.
//   node test/bots.js <CODE> [count=3] [url=ws://localhost:3120/]
// Bots pick the smaller team (or heckle with BOT_HECKLE=1), run legs at human-ish
// speeds, pour into the next runner over a couple of seconds, and throw cards.
import WebSocket from "ws";

const [code, count = "3", url = "ws://localhost:3120/"] = process.argv.slice(2);
if (!code) {
  console.error("usage: node test/bots.js CODE [count] [url]");
  process.exit(1);
}
const NAMES = ["Mira", "Theo", "Juno", "Ravi", "Lou", "Kai", "Nell", "Otto", "Pia", "Sol", "Wren", "Zed"];
const CARDS = ["ice", "fizz", "quake", "frost", "swell", "ice"];
const RUN = (process.env.BOT_RUN || "7000,12000").split(",").map(Number);

for (let i = 0; i < Number(count); i++) {
  const name = NAMES[i % NAMES.length];
  const skill = 0.5 + Math.random() * 0.45;
  const ws = new WebSocket(url);
  const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  let pid = null;
  let room = null;
  const done = new Set();
  const received = {};
  let lastCard = 0;
  ws.on("open", () => send({ t: "join", code: code.toUpperCase(), name }));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.t === "joined") {
      pid = m.pid;
      setTimeout(() => {
        if (process.env.BOT_HECKLE) send({ t: "team", team: -1 });
        send({ t: "ready" });
      }, 300 + i * 250);
    }
    if (m.t === "room") room = m;
    if (m.t === "pourIn") received[`${m.team}:${m.leg}`] = (received[`${m.team}:${m.leg}`] || 0) + m.amt;
    if (m.t === "err") console.log(`${name}: ${m.msg}`);
    if (m.t !== "match") return;
    for (const tm of m.teams) {
      const key = `${m.id}:${tm.idx}:${tm.leg}`;
      if (tm.runner === pid && ["fill", "refill", "ready"].includes(tm.phase) && !done.has("go" + key)) {
        done.add("go" + key);
        setTimeout(() => {
          const got = tm.leg === 0 ? 330 : tm.phase === "refill" ? tm.pourVol : Math.min(tm.pourVol, received[`${tm.idx}:${tm.leg}`] || tm.pourVol) * (0.96 + 0.04 * skill);
          send({ t: "go", leg: tm.leg, ml: got });
          run(tm.leg, got);
        }, Math.max(0, tm.goAt - Date.now()));
      }
      if (tm.from === pid && tm.phase === "pour" && !done.has("pour" + key)) {
        done.add("pour" + key);
        let left = tm.pourVol;
        const iv = setInterval(() => {
          const amt = Math.min(left, tm.pourVol / 22);
          left -= amt;
          send({ t: "pour", leg: tm.leg, amt, left });
          if (left <= 0.01) { clearInterval(iv); send({ t: "pourDone", leg: tm.leg }); }
        }, 110);
      }
    }
    // mischief, now and then
    const meP = room && room.players.find((p) => p.id === pid);
    if (m.phase === "live" && m.mischief && meP && Date.now() - lastCard > 2500 + Math.random() * 4000) {
      const busy = m.teams.some((t) => (t.runner === pid && ["fill", "refill", "ready", "run", "pour"].includes(t.phase)) || (t.from === pid && t.phase === "pour"));
      const target = m.teams.find((t) => t.phase === "run" && (meP.team === -1 || t.idx !== meP.team));
      if (!busy && target && Math.random() < 0.5) {
        lastCard = Date.now();
        send({ t: "card", card: CARDS[(Math.random() * CARDS.length) | 0], team: target.idx });
      }
    }
  });
  function run(leg, start) {
    const dur = RUN[0] + Math.random() * (RUN[1] - RUN[0]);
    const keep = 0.75 + 0.22 * skill * Math.random();
    const t0 = Date.now();
    const iv = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / dur);
      const ml = start * (1 - (1 - keep) * k);
      const tt = (Date.now() - t0) / 1000;
      send({ t: "tel", leg, ml, sp: start * (1 - keep) * k * 0.8, lk: start * (1 - keep) * k * 0.2, st: Math.round(tt * 1.7), gx: 1.2 * Math.sin(tt * 6.3), gz: 1.6 * Math.sin(tt * 11.3 + 1), gv: 9.81 + 2 * Math.sin(tt * 11.3) });
      if (k >= 1) {
        clearInterval(iv);
        send({ t: "arrive", leg, ml: start * keep, sp: start * (1 - keep) * 0.8, lk: start * (1 - keep) * 0.2, st: Math.round(tt * 1.7) });
      }
    }, 90);
  }
  ws.on("close", () => console.log(`${name} disconnected`));
}
console.log(`${count} bots joining ${code}`);
