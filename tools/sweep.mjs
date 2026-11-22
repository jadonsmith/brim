// Parameter sweep: average spill for each walking style and each card, per config.
//   node tools/sweep.mjs '[{"fb":0.14,"k":0.6},{"fb":0.11,"k":0.8,"liq":{"damp":0.6}}]'
import { Liquid, RIM_H } from "../public/js/liquid.js";
import { LIQUID } from "../public/js/rules.js";
import { quakeDrive, swellDrive, iceSpot } from "../public/js/effects.js";

const DT = 1 / 120;
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function noise(r, fLo, fHi, n = 5) {
  const parts = [];
  for (let i = 0; i < n; i++) parts.push([fLo + (fHi - fLo) * r(), r() * 6.28, 0.5 + r()]);
  const norm = Math.sqrt(parts.reduce((s, p) => s + (p[2] * p[2]) / 2, 0));
  return (t) => parts.reduce((s, [f, ph, a]) => s + a * Math.sin(6.283 * f * t + ph), 0) / norm;
}
const pulse = (t, t0, d, a) => (t >= t0 && t < t0 + d ? a * Math.sin((Math.PI * (t - t0)) / d) : 0);
export const PROFILES = {
  careful: { f: 1.35, Af: 0.45, Al: 0.22, Av: 1.1, tilt: 2.0, ev: 0.55, dur: 24 },
  normal: { f: 1.8, Af: 1.15, Al: 0.5, Av: 2.2, tilt: 3.5, ev: 1.0, dur: 16 },
  hurried: { f: 2.2, Af: 2.3, Al: 0.95, Av: 3.4, tilt: 5.0, ev: 1.6, dur: 10 },
  jog: { f: 2.6, Af: 3.6, Al: 1.5, Av: 5.0, tilt: 8.0, ev: 2.3, dur: 7 },
};
function walk(fb, kappa, p, seed, liq) {
  const L = new Liquid(liq);
  L.reset(1 - fb / RIM_H);
  const r = rng(seed);
  const tiltN = noise(r, 0.15, 0.9), latN = noise(r, 0.3, 1.2), trem = noise(r, 5, 11), trem2 = noise(r, 5, 11);
  const start = L.vol;
  const T = p.dur;
  for (let t = 0; t < T; t += DT) {
    let az = p.Af * Math.sin(6.283 * p.f * t) + 0.35 * p.Af * Math.sin(12.566 * p.f * t + 1.1);
    az += pulse(t, 0.2, 0.7, 1.6 * p.ev) - pulse(t, T * 0.45, 0.8, 2.0 * p.ev) + pulse(t, T * 0.55, 0.7, 1.7 * p.ev) - pulse(t, T - 0.9, 0.7, 2.0 * p.ev);
    let ax = p.Al * Math.sin(3.1416 * p.f * t + 0.5) + 0.4 * p.Al * latN(t) + pulse(t, T * 0.47, 1.0, 1.5 * p.ev);
    const th = (p.tilt * Math.PI) / 180;
    ax += 9.81 * Math.sin(th * tiltN(t));
    az += 9.81 * Math.sin(th * 0.8 * tiltN(t + 7.3));
    ax += 0.15 * trem(t);
    az += 0.15 * trem2(t);
    const gv = 9.81 + p.Av * Math.sin(6.283 * p.f * t + 0.4);
    L.step(DT, kappa * ax, kappa * az, gv);
  }
  return L.spilled / start;
}
function still(fb, kappa, effect, seed, liq) {
  const L = new Liquid(liq);
  L.reset(1 - fb / RIM_H);
  const start = L.vol;
  for (let t = 0; t < 7; t += DT) {
    let ax = 0, az = 0, gv = 9.81;
    if (effect === "quake" && t > 0.5) { const q = quakeDrive(t - 0.5, seed); ax += q.x; az += q.z; gv += q.v; }
    if (effect === "swell" && t > 0.5) { const s = swellDrive(t - 0.5, seed); ax += s.x; az += s.z; }
    if (effect === "ice" && Math.abs(t - 0.5) < DT / 2) { const s = iceSpot(seed); L.dropIce(s.x, s.z, s.s); }
    if (effect === "ice3" && [0.5, 2, 3.5].some((x) => Math.abs(t - x) < DT / 2)) { const s = iceSpot(seed + Math.round(t * 10)); L.dropIce(s.x, s.z, s.s); }
    if (effect === "fizz" && Math.abs(t - 0.5) < DT / 2) L.foamTarget = 0.42;
    L.step(DT, kappa * ax, kappa * az, gv);
  }
  return L.spilled / start;
}
const pct = (x) => `${(x * 100).toFixed(1).padStart(5)}%`;
const configs = JSON.parse(process.argv[2] || '[{"fb":0.14,"k":0.6}]');
for (const c of configs) {
  const liq = { ...LIQUID, ...(c.liq || {}) };
  let line = `fb ${c.fb} k ${c.k} ${JSON.stringify(c.liq || {})} |`;
  for (const [n, p] of Object.entries(PROFILES)) {
    const s = [1, 2, 3, 4].map((sd) => walk(c.fb, c.k, p, sd * 97, liq));
    line += ` ${n} ${pct(s.reduce((a, b) => a + b, 0) / 4)}`;
  }
  line += " |";
  for (const e of ["quake", "ice", "ice3", "fizz", "swell"]) {
    const s = [1, 2, 3, 4].map((sd) => still(c.fb, c.k, e, sd * 31, liq));
    line += ` ${e} ${pct(s.reduce((a, b) => a + b, 0) / 4)}`;
  }
  console.log(line);
}
