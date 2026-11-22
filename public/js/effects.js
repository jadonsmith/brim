// Deterministic sabotage waveforms: the runner, the big screen and spectator phones
// all compute the same shaking from the same seed. No DOM in here.

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map();
function partsFor(kind, seed, n, fLo, fHi) {
  const key = kind + seed;
  let p = cache.get(key);
  if (!p) {
    const r = mulberry(seed * 7919 + kind.length);
    p = [];
    for (let i = 0; i < n; i++) p.push({ f: fLo + (fHi - fLo) * r(), ph: r() * 6.283, a: 0.6 + r() * 0.8, ax: r() * 6.283 });
    cache.set(key, p);
    if (cache.size > 64) cache.delete(cache.keys().next().value);
  }
  return p;
}

export const QUAKE_AMP = 3.6;

const env = (t, dur, atk, rel) => (t < 0 || t > dur ? 0 : Math.min(1, t / atk, (dur - t) / rel));

// Earthquake: 1.8 s of rumbling, mostly sideways with vertical jolts. m/s², raw.
export function quakeDrive(t, seed, dur = 1.8) {
  const e = env(t, dur, 0.12, 0.45);
  if (!e) return { x: 0, z: 0, v: 0, e: 0 };
  // low rumble near the drink's sloshing frequency, plus a rattle on top
  const P = partsFor("q", seed, 4, 0.9, 2.2);
  const R = partsFor("r", seed, 3, 3.5, 7.5);
  let x = 0, z = 0, v = 0;
  for (const p of P) {
    const s = Math.sin(6.283 * p.f * t + p.ph) * p.a;
    x += s * Math.cos(p.ax);
    z += s * Math.sin(p.ax);
  }
  for (const p of R) {
    const s = Math.sin(6.283 * p.f * t + p.ph) * p.a;
    x += 0.5 * s * Math.cos(p.ax);
    z += 0.5 * s * Math.sin(p.ax);
    v += Math.sin(6.283 * p.f * 1.37 * t + p.ph * 2) * p.a;
  }
  const A = QUAKE_AMP * e;
  return { x: x * A * 0.5, z: z * A * 0.5, v: v * 2.6 * e, e };
}

// Swell: the floor rolls like a ship's deck for ~5 s. Expressed as a phantom tilt.
export function swellDrive(t, seed, dur = 5.2) {
  const e = env(t, dur, 0.9, 1.1);
  if (!e) return { x: 0, z: 0, e: 0, ang: 0 };
  const r = mulberry(seed * 31 + 5);
  const dir = r() * 6.283;
  const per = 2.3 + r() * 0.6;
  const tiltDeg = 19 * e * Math.sin((6.283 * t) / per);
  const g = 9.81 * Math.sin((tiltDeg * Math.PI) / 180);
  return { x: g * Math.cos(dir), z: g * Math.sin(dir), e, ang: tiltDeg, dir };
}

// Where an ice cube lands (glass coords), from the card's seed.
export function iceSpot(seed) {
  const r = mulberry(seed * 13 + 3);
  const a = r() * 6.283, d = Math.sqrt(r()) * 0.42;
  return { x: Math.cos(a) * d, z: Math.sin(a) * d, s: 0.56 + r() * 0.06, rot: r() * 1.57 };
}

export { mulberry };
