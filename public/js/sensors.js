// Motion sensors: devicemotion (accelerometer incl. gravity) + deviceorientation,
// the iOS permission flow, a sign check between platforms, the glass's own frame,
// step counting, and a ?dev keyboard simulation. Everything stays on the phone.

export const S = {
  enabled: false,
  caps: { motion: false, orient: false },
  raw: { x: 0, y: 0, z: 0 },   // accelerationIncludingGravity as the browser reports it
  sign: 1,                      // raw * sign = specific force (W3C convention: +9.81 up)
  signKnown: false,
  ori: { a: 0, b: 0, g: 0 },
  oriAt: 0,
  motionAt: 0,
  samples: 0,
  steps: 0,
  stepOn: false,
  sim: null,
};

const subs = new Set();
export function onMotion(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

// ---------- step counter ----------
let magLP = 9.81, lastStep = 0, armed = true;
function countStep(F, now) {
  const m = Math.hypot(F.x, F.y, F.z);
  magLP += (m - magLP) * 0.04;
  const hp = m - magLP;
  if (!S.stepOn) return;
  if (armed && hp > 1.35 && now - lastStep > 290) {
    S.steps++;
    lastStep = now;
    armed = false;
  } else if (hp < 0.3) armed = true;
}

function ingest(rx, ry, rz, now) {
  S.raw.x = rx; S.raw.y = ry; S.raw.z = rz;
  S.motionAt = now;
  S.samples++;
  S.caps.motion = true;
  const F = specific();
  countStep(F, now);
  for (const fn of subs) fn(F, now);
}

function onDeviceMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  ingest(a.x, a.y, a.z, performance.now());
}

function onDeviceOrientation(e) {
  if (e.beta == null) return;
  S.ori.a = e.alpha || 0;
  S.ori.b = e.beta;
  S.ori.g = e.gamma || 0;
  S.oriAt = performance.now();
  S.caps.orient = true;
}

// Specific force the orientation angles imply, W3C convention (face-up flat = +z).
export function expectedF() {
  const d = Math.PI / 180;
  const b = S.ori.b * d, g = S.ori.g * d;
  return { x: -Math.cos(b) * Math.sin(g) * 9.81, y: Math.sin(b) * 9.81, z: Math.cos(b) * Math.cos(g) * 9.81 };
}

// Current specific force in device coordinates (m/s², W3C convention). If there's no
// accelerometer but there is orientation, tilt still works (no shoves, though).
export function specific() {
  if (S.caps.motion) return { x: S.raw.x * S.sign, y: S.raw.y * S.sign, z: S.raw.z * S.sign };
  if (S.caps.orient) return expectedF();
  return { x: 0, y: 9.81, z: 0 };
}

// Some platforms have reported accelerationIncludingGravity with the opposite sign.
// While the phone is held fairly still, compare it with what orientation implies.
export function checkSign() {
  if (!S.caps.motion || !S.caps.orient || performance.now() - S.oriAt > 500) return S.signKnown;
  const r = S.raw, e = expectedF();
  const rm = Math.hypot(r.x, r.y, r.z);
  if (rm < 7 || rm > 12.5) return S.signKnown; // moving too much to tell
  const dot = (r.x * e.x + r.y * e.y + r.z * e.z) / (rm * 9.81);
  if (dot > 0.6) { S.sign = 1; S.signKnown = true; }
  else if (dot < -0.6) { S.sign = -1; S.signKnown = true; }
  return S.signKnown;
}

// Must be called from a tap: iOS only shows its permission prompt during a gesture.
export async function enableMotion() {
  const DM = window.DeviceMotionEvent;
  const DO = window.DeviceOrientationEvent;
  let denied = false;
  if (DM && typeof DM.requestPermission === "function") {
    try { if ((await DM.requestPermission()) !== "granted") denied = true; } catch { denied = true; }
  }
  if (DO && typeof DO.requestPermission === "function") {
    try { await DO.requestPermission(); } catch {}
  }
  if (!S.listening) {
    S.listening = true;
    window.addEventListener("devicemotion", onDeviceMotion);
    window.addEventListener("deviceorientation", onDeviceOrientation);
  }
  const t0 = performance.now();
  while (performance.now() - t0 < 1200 && !(S.caps.motion && S.caps.orient)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  checkSign();
  S.enabled = S.caps.motion || S.caps.orient;
  return { ...S.caps, denied };
}

// Screen rotation relative to the phone's natural portrait orientation, in degrees.
export function screenAngle() {
  const so = screen.orientation;
  let a = so && typeof so.angle === "number" ? so.angle : typeof window.orientation === "number" ? window.orientation : 0;
  a = ((a % 360) + 360) % 360;
  return a;
}

// ---------- the glass's own frame ----------
// Reference "down" is set while the phone is held still, then drifts slowly toward
// however it's being held (so a slow change of grip is forgiven but a tip isn't).
export class GlassFrame {
  constructor() {
    this.down = null;
    this.lp = null;
    this.out = { gx: 0, gz: 0, gv: 9.81, ang: 0, tilt: 0, hx: 0, hz: 0 };
  }
  reset() { this.down = null; this.lp = null; }
  // F: specific force in device coords. tau: seconds for the reference to follow
  // the phone (Infinity freezes it).
  update(F, dt, tau) {
    const gx = -F.x, gy = -F.y, gz = -F.z; // effective gravity felt by the drink
    if (!this.lp) this.lp = { x: gx, y: gy, z: gz };
    const kl = Math.min(1, dt / 0.25);
    this.lp.x += (gx - this.lp.x) * kl; this.lp.y += (gy - this.lp.y) * kl; this.lp.z += (gz - this.lp.z) * kl;
    const lm = Math.hypot(this.lp.x, this.lp.y, this.lp.z) || 1;
    if (!this.down) this.down = { x: this.lp.x / lm, y: this.lp.y / lm, z: this.lp.z / lm };
    else if (tau !== Infinity) {
      const k = Math.min(1, dt / Math.max(0.02, tau));
      const d = this.down;
      d.x += (this.lp.x / lm - d.x) * k; d.y += (this.lp.y / lm - d.y) * k; d.z += (this.lp.z / lm - d.z) * k;
      const m = Math.hypot(d.x, d.y, d.z) || 1;
      d.x /= m; d.y /= m; d.z /= m;
    }
    const d = this.down;
    const gv = gx * d.x + gy * d.y + gz * d.z;
    const hx = gx - gv * d.x, hy = gy - gv * d.y, hz = gz - gv * d.z;
    // glass x axis: the phone's x axis laid flat; z axis: toward the person holding it
    let ex = { x: 1 - d.x * d.x, y: -d.x * d.y, z: -d.x * d.z };
    let em = Math.hypot(ex.x, ex.y, ex.z);
    if (em < 0.35) {
      // phone on its side: use its y axis instead
      ex = { x: -d.y * d.x, y: 1 - d.y * d.y, z: -d.y * d.z };
      em = Math.hypot(ex.x, ex.y, ex.z) || 1;
    }
    ex.x /= em; ex.y /= em; ex.z /= em;
    const up = { x: -d.x, y: -d.y, z: -d.z };
    const ez = { x: ex.y * up.z - ex.z * up.y, y: ex.z * up.x - ex.x * up.z, z: ex.x * up.y - ex.y * up.x };
    const o = this.out;
    o.gx = hx * ex.x + hy * ex.y + hz * ex.z;
    o.gz = hx * ez.x + hy * ez.y + hz * ez.z;
    o.gv = gv;
    const hm = Math.hypot(o.gx, o.gz);
    o.tilt = Math.atan2(hm, Math.max(-50, gv));
    // signed in-screen tip for pouring: sideways part decides the side
    o.ang = (o.gx >= -0.3 ? 1 : -1) * o.tilt;
    return o;
  }
}

// ---------- keyboard simulation (?dev) ----------
// Arrows tilt · W/S shove forward/back · A/D shove sideways · Space footstep
// G toggle walking · Q shake · T / Y tip right / left to pour
export function startSim() {
  const keys = new Set();
  const st = {
    beta: 55, gamma: 0,       // pose, degrees
    tb: 55, tg: 0,            // targets
    walk: 0,                  // walking amplitude 0..1 (autopilot sets it)
    shove: { x: 0, y: 0 },    // extra world accel m/s² (autopilot)
    jolt: 0,
    t: 0,
  };
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
    keys.add(k);
    if (e.repeat) return;
    if (k === " ") st.jolt = 0.14;
    if (k === "g") st.walk = st.walk ? 0 : 1;
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => keys.clear());
  S.caps = { motion: true, orient: true };
  S.enabled = true;
  S.signKnown = true;
  S.sim = { keys, st };
  const d = Math.PI / 180;
  setInterval(() => {
    const dt = 1 / 60;
    st.t += dt;
    let tb = st.tb, tg = st.tg;
    if (keys.has("arrowup")) tb -= 18;
    if (keys.has("arrowdown")) tb += 18;
    if (keys.has("arrowleft")) tg -= 18;
    if (keys.has("arrowright")) tg += 18;
    if (keys.has("t")) tg = 108;
    if (keys.has("y")) tg = -108;
    st.beta += (tb - st.beta) * 0.12;
    st.gamma += (tg - st.gamma) * 0.1;
    // world accel: x right, y forward (away from you), z up
    let ax = st.shove.x, ay = st.shove.y, az = 0;
    if (keys.has("w")) ay += 3.4;
    if (keys.has("s")) ay -= 3.4;
    if (keys.has("a")) ax -= 3.4;
    if (keys.has("d")) ax += 3.4;
    if (st.walk) {
      const f = 1.8, w = st.walk;
      ay += w * (1.1 * Math.sin(6.283 * f * st.t) + 0.35 * Math.sin(12.566 * f * st.t + 1.1));
      ax += w * 0.5 * Math.sin(3.1416 * f * st.t + 0.5);
      az += w * 2.2 * Math.sin(6.283 * f * st.t + 0.4);
    }
    if (keys.has("q")) { ax += (Math.random() - 0.5) * 9; ay += (Math.random() - 0.5) * 9; az += (Math.random() - 0.5) * 5; }
    if (st.jolt > 0) { az += st.jolt > 0.07 ? 6 : -3; st.jolt -= dt; }
    ax += (Math.random() - 0.5) * 0.12; ay += (Math.random() - 0.5) * 0.12; az += (Math.random() - 0.5) * 0.12;
    // world -> device: F_dev = Ry(γ)^T Rx(β)^T (a + g up)
    const b = st.beta * d, g = st.gamma * d;
    const Fx = ax, Fy = ay, Fz = az + 9.81;
    const v1x = Fx, v1y = Math.cos(b) * Fy + Math.sin(b) * Fz, v1z = -Math.sin(b) * Fy + Math.cos(b) * Fz;
    const fx = Math.cos(g) * v1x - Math.sin(g) * v1z, fy = v1y, fz = Math.sin(g) * v1x + Math.cos(g) * v1z;
    S.ori.b = st.beta;
    S.ori.g = Math.max(-90, Math.min(90, st.gamma));
    S.oriAt = performance.now();
    ingest(fx, fy, fz, performance.now());
  }, 1000 / 60);
}
