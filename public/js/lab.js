// ?lab: a glass on its own, no server. For tuning the look and feel.
// Keys (with ?dev sim): arrows tilt, W/A/S/D shove, G walk, Space step, Q shake, T/Y pour.
import { Carry } from "./carry.js";
import { S, startSim, enableMotion } from "./sensors.js";
import { TEAMS, SOLO_DRINK, V0_ML, FILL_TARGET } from "./rules.js";
import { audioCtx } from "./audio.js";

export function startLab() {
  document.body.classList.add("lab");
  const params = new URLSearchParams(location.search);
  if (params.has("dev")) startSim();
  const cv = document.createElement("canvas");
  cv.className = "lab-cv";
  document.body.appendChild(cv);
  const bar = document.createElement("div");
  bar.className = "lab-bar";
  bar.innerHTML = ["fill", "run", "pour", "catch", "preview", "|", "quake", "ice", "fizz", "frost", "swell", "lid", "|", "sunrise", "lagoon", "lime", "|", "motion"]
    .map((b) => (b === "|" ? "<i></i>" : `<button data-b="${b}">${b}</button>`))
    .join("");
  document.body.appendChild(bar);
  const info = document.createElement("pre");
  info.className = "lab-info";
  document.body.appendChild(info);
  const drink = params.get("drink") === "lagoon" ? TEAMS[1] : params.get("drink") === "lime" ? SOLO_DRINK : TEAMS[0];
  const fillId = params.get("fill") || "brim";
  const c = new Carry(cv, { drink, fillId });
  c.setBox(70, 60);
  const cap = V0_ML / FILL_TARGET(fillId);
  c.setGlass(cap, 0);
  c.setMode("fill", { ms: 1800 });
  setTimeout(() => c.mode === "fill" && c.setMode("run"), 2400);
  let seed = 1;
  bar.addEventListener("click", async (e) => {
    const b = e.target.dataset && e.target.dataset.b;
    if (!b) return;
    audioCtx();
    if (b === "motion") { const caps = await enableMotion(); info.dataset.caps = JSON.stringify(caps); return; }
    if (["fill", "run", "pour", "catch", "preview"].includes(b)) {
      if (b === "fill") { c.setGlass(cap, 0); c.setMode("fill", { ms: 1800 }); }
      else if (b === "catch") { c.setGlass(cap * 0.8, 0); c.setMode("catch"); let n = 0; const iv = setInterval(() => { c.addIncoming(12); if (++n > 20) clearInterval(iv); }, 100); }
      else c.setMode(b);
      return;
    }
    if (["sunrise", "lagoon", "lime"].includes(b)) {
      c.actor.view.setDrink(b === "sunrise" ? TEAMS[0] : b === "lagoon" ? TEAMS[1] : SOLO_DRINK);
      return;
    }
    c.actor.addFx({ id: "lab" + seed, card: b, land: performance.now() + 300, seed: seed++, from: 99 });
  });
  window.__lab = { c, S };
  setInterval(() => {
    const L = c.L;
    info.textContent = `${c.mode}  ${c.ml.toFixed(1)} / ${c.actor.capMl.toFixed(0)} ml  fill ${(L.fill * 100).toFixed(1)}%  spilled ${c.spillMl.toFixed(1)} leak ${c.leakMl.toFixed(1)}\n` +
      `gx ${c.drive.gx.toFixed(2)} gz ${c.drive.gz.toFixed(2)} gv ${c.drive.gv.toFixed(2)}  peak ${L.wallPeak().toFixed(3)}  steps ${S.steps}  ice ${L.ice.length} foam ${L.foam.toFixed(2)}  ang ${(c.pourAng * 57.3).toFixed(0)}°`;
  }, 200);
}
