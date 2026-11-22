// Watching other people's glasses: a Replica is a copy of a runner's glass driven by
// their telemetry (and by the same sabotage), and a Stage draws several of them on
// one canvas, on one bar counter. Used by the big screen and by phones between legs.
import { GlassActor } from "./carry.js";
import { Scene } from "./glass.js";
import { FILL_TARGET, glassScale, V0_ML, TIMING } from "./rules.js";

// Bring a replica in line with its team's state in a match snapshot. Returns true if
// the glass changed phase.
export function syncReplica(rep, tm, m, toPerf) {
  rep.setFill(m.fill);
  const key = `${m.id}:${tm.leg}:${tm.phase}`;
  if (rep.key === key) return false;
  rep.key = key;
  const legKey = `${m.id}:${tm.idx}:${tm.leg}`;
  const sameLeg = rep.legKey === legKey;
  const fresh = (ml) => { rep.legKey = legKey; rep.received = 0; rep.setGlass(Math.max(1, tm.cap || V0_ML / FILL_TARGET(m.fill)), ml); };
  rep.dim = tm.phase === "wait" ? 0.85 : tm.phase === "hold" ? 0.4 : tm.phase === "done" ? 0.2 : 0;
  const msLeft = (at) => Math.max(400, toPerf(at) - performance.now() - TIMING.count);
  switch (tm.phase) {
    case "wait":
      rep.legKey = "";
      rep.setGlass(V0_ML / FILL_TARGET(m.fill), 0);
      rep.setMode("idle");
      break;
    case "fill":
      fresh(0);
      rep.setMode("fill", { ms: msLeft(tm.goAt) });
      break;
    case "refill":
      fresh(0);
      rep.setMode("fill", { goalMl: tm.pourVol, ms: msLeft(tm.goAt) });
      break;
    case "pour":
      if (!sameLeg) fresh(Math.min(tm.poured || 0, tm.pourVol || 0));
      rep.received = rep.received || 0;
      rep.setMode("catch");
      break;
    case "ready":
      if (!sameLeg) fresh(tm.poured || 0);
      else if ((tm.poured || 0) > (rep.received || 0) + 0.5) rep.pourIn(tm.poured - rep.received);
      rep.received = tm.poured || 0;
      rep.setMode("catch");
      break;
    case "run":
      if (!sameLeg) fresh(tm.vol);
      rep.setMode("run");
      rep.targetMl = tm.vol;
      break;
    case "hold":
      if (!sameLeg) fresh(tm.vol);
      rep.setMode("calm");
      rep.actor.ml = tm.vol;
      break;
    case "done": {
      const ml = tm.final != null ? tm.final : tm.vol;
      if (!sameLeg) fresh(ml);
      rep.setMode("calm");
      rep.actor.ml = ml;
      break;
    }
  }
  return true;
}

export class Replica {
  constructor(drink, fillId = "brim") {
    this.actor = new GlassActor(drink, fillId);
    this.fillId = fillId;
    this.mode = "idle"; // idle | fill | run | catch | calm
    this.target = { gx: 0, gz: 0, gv: 9.81 };
    this.drive = { gx: 0, gz: 0, gv: 9.81 };
    this.targetMl = null;
    this.incoming = [];
    this.streamW = 0;
    this.streamX = 0;
    this.fillGoal = 0;
    this.fillRate = 0;
    this.scale = 1;
    this.scaleVis = 1;
    this.key = "";
    this.dim = 0;      // 0..1: greyed out (team waiting or done)
    this.dimVis = 0;
    this.leak = 0;
  }
  get L() { return this.actor.L; }
  get ml() { return this.actor.ml; }
  setFill(fillId) { this.fillId = fillId; this.actor.setFill(fillId); }
  setGlass(capMl, ml = 0) {
    const A = this.actor;
    A.capMl = Math.max(1, capMl);
    A.L.reset(0);
    A.ml = ml;
    A.view.clearMess();
    A.clearFx();
    this.scale = glassScale(capMl, this.fillId);
    this.incoming.length = 0;
    this.targetMl = null;
  }
  setMode(mode, o = {}) {
    this.mode = mode;
    if (mode === "fill") {
      const L = this.L;
      this.fillGoal = Math.min(L.capacity, (o.goalMl != null ? o.goalMl / this.actor.capMl : FILL_TARGET(this.fillId)) * L.capacity);
      this.fillRate = Math.max(0, this.fillGoal - L.vol) / Math.max(0.5, (o.ms || 2200) / 1000);
    }
    if (mode !== "run") this.target = { gx: 0, gz: 0, gv: 9.81 };
  }
  tel(ml, gx, gz, gv) {
    this.targetMl = ml;
    this.target.gx = gx; this.target.gz = gz; this.target.gv = gv || 9.81;
  }
  pourIn(amt) {
    if (!(amt > 0)) return;
    this.incoming.push({ ml: amt, left: amt });
    this.received = (this.received || 0) + amt;
  }
  tick(dt, now) {
    const A = this.actor, L = this.L;
    const k = 1 - Math.exp(-dt / 0.07);
    this.drive.gx += (this.target.gx - this.drive.gx) * k;
    this.drive.gz += (this.target.gz - this.drive.gz) * k;
    this.drive.gv += (this.target.gv - this.drive.gv) * k;
    const before = L.vol;
    A.step(dt, now, this.mode === "run" ? this.drive : { gx: 0, gz: 0, gv: 9.81 }, { fx: this.mode === "run" });
    if (this.mode === "calm" || this.mode === "idle") { L.vol = before; L.spills.length = 0; }
    if (this.mode === "fill") {
      if (L.vol < this.fillGoal) {
        L.addVolume(Math.min(this.fillGoal - L.vol, this.fillRate * dt));
        this.streamW = 1;
        if (Math.random() < 0.5) L.impulse((Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1, -0.025, 0.2);
      } else this.streamW = Math.max(0, this.streamW - dt * 4);
    }
    if (this.mode === "catch") {
      let rate = 0;
      for (let i = this.incoming.length - 1; i >= 0; i--) {
        const c = this.incoming[i];
        const take = Math.min(c.left, Math.max(c.ml * dt * 5, 0.2));
        c.left -= take;
        rate += take / dt;
        A.ml = A.ml + take;
        if (c.left <= 1e-6) this.incoming.splice(i, 1);
      }
      if (rate > 0) {
        const kk = rate / Math.max(30, A.capMl * 0.45);
        this.streamW += (Math.min(1, 0.25 + kk) - this.streamW) * Math.min(1, dt * 12);
        this.streamX = Math.sin(now / 700) * 0.18;
        if (Math.random() < 0.6) L.impulse(this.streamX, 0.05, -0.04 * Math.min(1.5, kk), 0.2);
      } else this.streamW = Math.max(0, this.streamW - dt * 3);
    }
    if (this.mode === "run" && this.targetMl != null) {
      // the runner's phone is the truth about how much is left
      const diff = this.targetMl - A.ml;
      A.ml = A.ml + diff * Math.min(1, dt * 5);
    }
    L.spilled = 0;
    this.dimVis += (this.dim - this.dimVis) * Math.min(1, dt * 4);
  }
}

export class Stage {
  constructor(canvas, { onFrame } = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.scene = new Scene();
    this.slots = [];
    this.onFrame = onFrame;
    this.stopped = false;
    this.last = performance.now();
    this.lastDraw = performance.now();
    this.resize();
    this.onResize = () => this.resize();
    window.addEventListener("resize", this.onResize);
    this.tickTimer = setInterval(() => this.tick(), 1000 / 60);
    this.raf = requestAnimationFrame((t) => this.draw(t));
  }
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.cv.clientWidth || 360, h = this.cv.clientHeight || 640;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    this.w = w; this.h = h; this.dpr = dpr;
  }
  // slots: [{ rep, box: [x, y, w, h] as fractions of the canvas, widthK? }]
  setSlots(slots) { this.slots = slots; }
  tick() {
    if (this.stopped) return;
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    for (const s of this.slots) s.rep.tick(dt, now);
  }
  draw(now) {
    if (this.stopped) return;
    this.raf = requestAnimationFrame((t) => this.draw(t));
    if (this.cv.clientWidth !== this.w || this.cv.clientHeight !== this.h) this.resize();
    const dt = Math.min(0.05, Math.max(0, (now - this.lastDraw) / 1000));
    this.lastDraw = now;
    const { ctx, w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const lays = this.slots.map((s) => {
      const [bx, by, bw, bh] = s.box;
      s.rep.scaleVis += (s.rep.scale - s.rep.scaleVis) * Math.min(1, dt * 3);
      return s.rep.actor.layout(bx * w, by * h, bw * w, bh * h, s.rep.scaleVis, s.widthK || 0.34);
    });
    const counterY = lays.length ? Math.min(...lays.map((l) => l.counterY)) : h * 0.62;
    const tilt = this.slots.reduce((a, s) => a + s.rep.actor.tiltVis, 0);
    this.scene.draw(ctx, w, h, counterY, now / 1000, dpr, -tilt * 0.3);
    this.slots.forEach((s, i) => {
      const A = s.rep.actor;
      A.view.takeSpills(A.L);
      A.view.update(dt, A.L);
      const lay = lays[i];
      ctx.save();
      if (A.shake > 0.01) ctx.translate((Math.random() - 0.5) * 10 * A.shake, (Math.random() - 0.5) * 6 * A.shake);
      const a = 1 - 0.55 * s.rep.dimVis;
      ctx.globalAlpha = a;
      A.view.draw(ctx, A.L, { ...lay, streamTop: lay.top - lay.S * 2.2 }, {
        danger: s.rep.mode === "run" ? Math.max(0, Math.min(1, (A.L.wallPeak() + 0.05) / 0.07)) : 0,
        crack: s.rep.mode === "run" || s.rep.mode === "calm",
        leak: s.rep.mode === "run" ? 0.75 : 0,
        stream: (s.rep.mode === "fill" || s.rep.mode === "catch") && s.rep.streamW > 0.01 ? { x: s.rep.streamX, z: 0.05, w: s.rep.streamW } : null,
      });
      ctx.globalAlpha = 1;
      ctx.restore();
    });
    this.onFrame && this.onFrame(ctx, lays, now);
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.tickTimer);
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
  }
}
