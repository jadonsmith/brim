// Headless tuning: how much of a brim-full glass survives different walking styles,
// and what each sabotage card costs a runner standing still.
//   node tools/tune.mjs            # all fills
//   node tools/tune.mjs brim       # one fill
import { Liquid, RIM_H } from "../public/js/liquid.js";
import { FILLS, LEAK_PER_S, LIQUID } from "../public/js/rules.js";
import { quakeDrive, swellDrive } from "../public/js/effects.js";

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

// band-limited noise: sum of a few random sines
function noise(r, fLo, fHi, n = 5) {
  const parts = [];
  for (let i = 0; i < n; i++) parts.push([fLo + (fHi - fLo) * r(), r() * 6.28, 0.5 + r()]);
  const norm = Math.sqrt(parts.reduce((s, p) => s + p[2] * p[2] / 2, 0));
  return (t) => parts.reduce((s, [f, ph, a]) => s + a * Math.sin(6.283 * f * t + ph), 0) / norm;
}

const PROFILES = {
  careful: { f: 1.35, Af: 0.45, Al: 0.22, Av: 1.1, tilt: 2.0, ev: 0.55, dur: 24 },
  normal: { f: 1.8, Af: 1.15, Al: 0.5, Av: 2.2, tilt: 3.5, ev: 1.0, dur: 16 },
  hurried: { f: 2.2, Af: 2.3, Al: 0.95, Av: 3.4, tilt: 5.0, ev: 1.6, dur: 10 },
  reckless: { f: 2.6, Af: 3.6, Al: 1.5, Av: 5.0, tilt: 8.0, ev: 2.3, dur: 7 },
};

// a pulse: half-sine of duration d starting at t0
const pulse = (t, t0, d, a) => (t >= t0 && t < t0 + d ? a * Math.sin((Math.PI * (t - t0)) / d) : 0);

function walk(fillId, prof, seed) {
  const F = FILLS[fillId];
  const L = new Liquid(LIQUID);
  L.reset(1 - F.freeboard / RIM_H);
  const r = rng(seed);
  const tiltN = noise(r, 0.15, 0.9), latN = noise(r, 0.3, 1.2), trem = noise(r, 5, 11), trem2 = noise(r, 5, 11);
  const start = L.vol;
  const leak = LEAK_PER_S * start;
  const p = prof;
  const T = p.dur;
  for (let t = 0; t < T; t += DT) {
    // forward/back: step rhythm + start, turn-around and stop
    let az = p.Af * Math.sin(6.283 * p.f * t) + 0.35 * p.Af * Math.sin(12.566 * p.f * t + 1.1);
    az += pulse(t, 0.2, 0.7, 1.6 * p.ev) - pulse(t, T * 0.45, 0.8, 2.0 * p.ev) + pulse(t, T * 0.55, 0.7, 1.7 * p.ev) - pulse(t, T - 0.9, 0.7, 2.0 * p.ev);
    let ax = p.Al * Math.sin(3.1416 * p.f * t + 0.5) + 0.4 * p.Al * latN(t) + pulse(t, T * 0.47, 1.0, 1.5 * p.ev);
    const th = (p.tilt * Math.PI) / 180;
    ax += 9.81 * Math.sin(th * tiltN(t));
    az += 9.81 * Math.sin(th * 0.8 * tiltN(t + 7.3));
    ax += 0.15 * trem(t); az += 0.15 * trem2(t);
    const gv = 9.81 + p.Av * Math.sin(6.283 * p.f * t + 0.4);
    L.step(DT, F.kappa * ax, F.kappa * az, gv);
    L.addVolume(-leak * DT);
  }
  return { kept: L.vol / start, spill: L.spilled / start, leak: (leak * T) / start };
}

function still(fillId, effect, seed) {
  const F = FILLS[fillId];
  const L = new Liquid(LIQUID);
  L.reset(1 - F.freeboard / RIM_H);
  const start = L.vol;
  const r = rng(seed);
  const tr = noise(r, 4, 9), tr2 = noise(r, 4, 9);
  for (let t = 0; t < 7; t += DT) {
    let ax = 0.12 * tr(t), az = 0.12 * tr2(t), gv = 9.81;
    if (effect === "quake" && t > 0.5) { const q = quakeDrive(t - 0.5, seed); ax += q.x; az += q.z; gv += q.v; }
    if (effect === "swell" && t > 0.5) { const s = swellDrive(t - 0.5, seed); ax += s.x; az += s.z; }
    if (effect === "ice" && Math.abs(t - 0.5) < DT / 2) L.dropIce((r() - 0.5) * 0.6, (r() - 0.5) * 0.6);
    if (effect === "ice3" && [0.5, 2, 3.5].some((x) => Math.abs(t - x) < DT / 2)) L.dropIce((r() - 0.5) * 0.8, (r() - 0.5) * 0.8);
    if (effect === "fizz" && Math.abs(t - 0.5) < DT / 2) L.foamTarget = 0.42;
    L.step(DT, F.kappa * ax, F.kappa * az, gv);
  }
  return { kept: L.vol / start, spill: L.spilled / start };
}

function mode(fillId) {
  // first sloshing mode: tilt, release, time the zero crossings of the wall height
  const L = new Liquid(LIQUID);
  L.reset(0.5);
  for (let t = 0; t < 1.5; t += DT) L.step(DT, 1.2, 0, 9.81);
  const wc = L.walls.reduce((a, b) => (b.x > a.x ? b : a));
  let last = L.eta[wc.c], cross = [], peak = 0, peaks = [];
  for (let t = 0; t < 8; t += DT) {
    L.step(DT, 0, 0, 9.81);
    const h = L.eta[wc.c];
    if (last < 0 && h >= 0) cross.push(t);
    if (Math.abs(h) > peak) peak = Math.abs(h);
    if (last > 0 && h <= 0) { peaks.push(peak); peak = 0; }
    last = h;
  }
  const per = cross.length > 2 ? (cross[cross.length - 1] - cross[0]) / (cross.length - 1) : NaN;
  const decay = peaks.length > 3 ? Math.log(peaks[0] / peaks[3]) / (3 * per) : NaN;
  return { hz: 1 / per, tau: 1 / decay };
}

const pct = (x) => `${(x * 100).toFixed(1).padStart(5)}%`;
const fills = process.argv[2] ? [process.argv[2]] : Object.keys(FILLS);
const m = mode();
console.log(`first mode ${m.hz.toFixed(2)} Hz, amplitude decay time ${m.tau.toFixed(2)} s`);
for (const f of fills) {
  console.log(`\n== ${f}  (freeboard ${FILLS[f].freeboard}, kappa ${FILLS[f].kappa})`);
  for (const [name, prof] of Object.entries(PROFILES)) {
    const runs = [1, 2, 3, 4, 5, 6].map((s) => walk(f, prof, s * 97));
    const avg = (k) => runs.reduce((s, x) => s + x[k], 0) / runs.length;
    const min = Math.min(...runs.map((x) => x.kept)), max = Math.max(...runs.map((x) => x.kept));
    console.log(`${name.padEnd(9)} ${String(prof.dur).padStart(2)}s  kept ${pct(avg("kept"))}  (spill ${pct(avg("spill"))}, leak ${pct(avg("leak"))})  range ${pct(min)}..${pct(max)}`);
  }
  for (const e of ["quake", "ice", "ice3", "fizz", "swell"]) {
    const runs = [1, 2, 3, 4].map((s) => still(f, e, s * 31));
    const sp = runs.reduce((s, x) => s + x.spill, 0) / runs.length;
    console.log(`still + ${e.padEnd(6)} spill ${pct(sp)}`);
  }
}
