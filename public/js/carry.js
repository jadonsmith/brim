// A glass on screen: the drink sim, its renderer and the sabotage effects acting on
// it. GlassActor is shared by the runner's own glass and the copies other screens
// draw from telemetry. Carry wraps one actor with the phone's sensors.
import { Liquid, RIM_H } from "./liquid.js";
import { GlassView, Scene, BASE_H, pourState } from "./glass.js";
import { LIQUID, FILLS, CARDS, LEAK_PER_S, FILL_TARGET, glassScale } from "./rules.js";
import { quakeDrive, swellDrive, iceSpot } from "./effects.js";
import { S, specific, GlassFrame, checkSign } from "./sensors.js";
import { sfx, buzz } from "./audio.js";

export const POUR_K = 2.2;
export const POUR_MAX = 0.45; // fraction of the glass per second, at most
export const POUR_GAIN = 1.4;  // on-screen tip per real tip

export class GlassActor {
  constructor(drink, fillId = "brim") {
    this.L = new Liquid(LIQUID);
    this.view = new GlassView(drink);
    this.fillId = fillId;
    this.kappa = (FILLS[fillId] || FILLS.brim).kappa;
    this.capMl = 350;
    this.fx = [];        // effects: {card, land, end, seed, from, done}
    this.tiltVis = 0;    // swell: how far the room appears to roll (deg)
    this.shake = 0;      // quake: screen shake (0..1)
    this.frost = null;   // {land, end}
    this.acc = 0;
  }
  setFill(fillId) {
    this.fillId = fillId;
    this.kappa = (FILLS[fillId] || FILLS.brim).kappa;
  }
  get ml() { return (this.L.vol / this.L.capacity) * this.capMl; }
  set ml(v) { this.L.vol = Math.max(0, (v / this.capMl) * this.L.capacity); }
  mlToVol(ml) { return (ml / this.capMl) * this.L.capacity; }

  addFx(f) {
    const def = CARDS[f.card];
    if (!def || this.fx.some((x) => x.id === f.id)) return;
    this.fx.push({ id: f.id, card: f.card, land: f.land, end: f.land + def.dur, seed: f.seed, from: f.from, started: false });
  }
  clearFx() { this.fx.length = 0; this.tiltVis = 0; this.shake = 0; this.frost = null; }

  // Sabotage acting on the drink right now: extra raw acceleration (m/s², pre-kappa).
  fxStep(now) {
    let x = 0, z = 0, v = 0, tilt = 0, shake = 0;
    for (const f of this.fx) {
      if (now < f.land) continue;
      const t = (now - f.land) / 1000;
      if (!f.started) {
        f.started = true;
        this.onLand(f);
      }
      if (f.card === "quake") {
        const q = quakeDrive(t, f.seed);
        x += q.x; z += q.z; v += q.v; shake = Math.max(shake, q.e);
      } else if (f.card === "swell") {
        const s = swellDrive(t, f.seed);
        x += s.x; z += s.z; tilt += s.ang;
      }
    }
    for (let i = this.fx.length - 1; i >= 0; i--) if (now > this.fx[i].end + 2500) this.fx.splice(i, 1);
    this.tiltVis = tilt;
    this.shake = shake;
    return { x, z, v };
  }
  onLand(f) {
    const L = this.L;
    if (f.card === "ice") {
      const s = iceSpot(f.seed);
      L.dropIce(s.x, s.z, s.s, s.rot);
    } else if (f.card === "fizz") {
      L.foamTarget = Math.min(0.5, L.foamTarget + 0.42);
    } else if (f.card === "lid") {
      L.lid = CARDS.lid.dur / 1000;
    } else if (f.card === "frost") {
      this.frost = { land: f.land, end: f.end };
    }
    this.landed && this.landed(f);
  }
  // who to blame for drink spilled right now
  culprits(now) {
    const out = [];
    for (const f of this.fx) {
      if (CARDS[f.card].kind !== "hit" || f.from == null) continue;
      if (now >= f.land && now <= f.end + 2200) out.push(f.from);
    }
    return out;
  }

  // drive: raw effective gravity in the glass frame (pre-kappa), dt in seconds
  step(dt, now, drive, { fx = true } = {}) {
    const e = fx ? this.fxStep(now) : { x: 0, z: 0, v: 0 };
    const k = this.kappa;
    const gx = k * (drive.gx + e.x), gz = k * (drive.gz + e.z), gv = drive.gv + e.v;
    const n = 2;
    for (let i = 0; i < n; i++) this.L.step(dt / n, gx, gz, gv);
  }

  // Fit the glass in a box (x, y, w, h). Smaller glasses keep their base on the
  // same counter line as a full-size one would.
  layout(x, y, w, h, scale = 1, widthK = 0.34) {
    const avail = Math.max(60, h);
    const S0 = Math.min(w * widthK, avail / 3.25);
    const S = S0 * scale;
    const phi = 0.33;
    const cp = Math.cos(phi), sp = Math.sin(phi);
    const baseFront = y + avail / 2 + (3.25 * S0) / 2 - S0 * sp * 0.6;
    const by = baseFront - BASE_H * S * cp - S * sp;
    return { cx: x + w / 2, by, S, S0, phi, counterY: baseFront - BASE_H * S0 * cp - S0 * sp * 3.6, top: by - RIM_H * S * cp - S * sp, bottom: baseFront };
  }
}

// ─────────────────────────── the runner's own glass ───────────────────────────
export class Carry {
  constructor(canvas, { drink, fillId = "brim", hooks = {} } = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.actor = new GlassActor(drink, fillId);
    this.scene = new Scene();
    this.frame = new GlassFrame();
    this.hooks = hooks;
    this.mode = "idle";
    this.fillId = fillId;
    this.box = { top: 120, bottom: 120 };
    this.scale = 1;
    this.scaleVis = 1;
    this.startMl = 0;
    this.leakMl = 0;
    this.spillMl = 0;
    this.by = {};          // ml spilled per saboteur pid
    this.pourOut = 0;      // ml poured out, not yet sent
    this.pourTotal = 0;
    this.pourStartMl = 0;
    this.pourAng = 0;
    this.pourVis = null;
    this.flow = 0;
    this.incoming = [];    // catch: [{ml, at}]
    this.streamW = 0;
    this.streamX = 0;
    this.fillGoal = 0;
    this.dangerK = 0;
    this.last = performance.now();
    this.lastDraw = performance.now();
    this.stopped = false;
    this.drive = { gx: 0, gz: 0, gv: 9.81 };
    this.shakeT = 0;
    this.fxEnabled = true;
    this.frozen = false;
    this.actor.landed = (f) => this.hooks.landed && this.hooks.landed(f);
    this.tickTimer = setInterval(() => this.tick(), 1000 / 60);
    this.raf = requestAnimationFrame((t) => this.draw(t));
    this.resize();
    this.onResize = () => this.resize();
    window.addEventListener("resize", this.onResize);
  }

  get L() { return this.actor.L; }
  get ml() { return this.actor.ml; }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.cv.clientWidth || 360, h = this.cv.clientHeight || 640;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    this.w = w; this.h = h; this.dpr = dpr;
  }

  setBox(top, bottom) { this.box = { top, bottom }; }
  setFill(fillId) { this.fillId = fillId; this.actor.setFill(fillId); }

  // capMl: the glass's size; ml: what's in it now
  setGlass(capMl, ml = 0) {
    this.actor.capMl = Math.max(1, capMl);
    this.actor.L.reset(0);
    this.actor.ml = ml;
    this.scale = glassScale(capMl, this.fillId);
    this.actor.view.clearMess();
    this.actor.clearFx();
  }

  setMode(mode, o = {}) {
    const prev = this.mode;
    this.mode = mode;
    const L = this.L;
    if (mode === "fill") {
      // the bartender pours from above until the drink reaches the start line
      this.fillGoal = FILL_TARGET(this.fillId) * L.capacity;
      this.fillRate = this.fillGoal / Math.max(0.6, (o.ms || 2200) / 1000);
      this.streamX = 0;
      this.frame.reset();
    }
    if (mode === "ready" || mode === "catch") this.frame.reset();
    if (mode === "run") {
      this.startMl = this.ml;
      this.leakMl = 0;
      this.spillMl = 0;
      this.by = {};
      this.runStart = performance.now();
      L.spilled = 0;
      S.steps = 0;
      S.stepOn = true;
      checkSign();
    } else {
      S.stepOn = false;
    }
    if (mode === "pour") {
      this.pourOut = 0;
      this.pourTotal = 0;
      this.pourStartMl = this.ml;
      this.pourT0 = performance.now();
      this.flow = 0;
      this.actor.clearFx();
      L.foam = L.foamTarget = 0;
    }
    if (mode === "preview") {
      this.actor.capMl = 300;
      L.reset(0);
      L.fill = 0.84;
      this.scale = 0.92;
      this.frame.reset();
    }
    if (mode !== "run" && prev === "run") this.actor.clearFx();
  }

  // a chunk of drink poured in by the previous runner
  addIncoming(ml) {
    this.incoming.push({ ml, left: ml, t: 0 });
    this.streamW = Math.min(1, this.streamW + ml / Math.max(20, this.actor.capMl * 0.06));
  }

  tick() {
    if (this.stopped) return;
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    const A = this.actor, L = this.L;
    const F = specific();
    const tau = this.mode === "run" ? 6 : this.mode === "pour" ? Infinity : this.mode === "preview" ? 1.2 : 0.35;
    const g = this.frame.update(F, dt, tau);
    this.drive.gx = g.gx; this.drive.gz = g.gz; this.drive.gv = g.gv;
    const volBefore = L.vol;
    if (this.mode === "pour") {
      this.tickPour(dt, g);
    } else if (this.mode !== "idle" && this.mode !== "hold") {
      A.step(dt, now, this.drive, { fx: this.mode === "run" && this.fxEnabled });
    } else if (this.mode === "hold") {
      // set down on the counter: settles, nothing more is lost
      A.step(dt, now, { gx: 0, gz: 0, gv: 9.81 }, { fx: false });
      L.vol = volBefore;
      L.spilled = 0;
      L.spills.length = 0;
    }
    if (this.mode === "fill" && L.vol < this.fillGoal) {
      const add = Math.min(this.fillGoal - L.vol, this.fillRate * dt);
      L.addVolume(add);
      this.streamW = 1;
      if (Math.random() < 0.5) L.impulse(this.streamX + (Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1, -0.025, 0.2);
    } else if (this.mode === "fill") this.streamW = Math.max(0, this.streamW - dt * 4);
    if (this.mode === "catch") this.tickCatch(dt);
    if (this.mode === "preview") {
      // the lobby toy never runs dry
      if (L.fill < 0.8) L.addVolume(L.capacity * 0.05 * dt);
    }
    // spills, leak, blame
    if (this.mode === "run") {
      const lost = L.spilled;
      if (lost > 0) {
        const ml = (lost / L.capacity) * A.capMl;
        L.spilled = 0;
        this.spillMl += ml;
        const who = A.culprits(now);
        if (who.length) for (const p of who) this.by[p] = (this.by[p] || 0) + ml / who.length;
        this.hooks.spill && this.hooks.spill(ml);
      }
      const leak = LEAK_PER_S * this.startMl * dt;
      if (A.ml > 0.5) {
        A.ml = Math.max(0, A.ml - leak);
        this.leakMl += leak;
      }
    } else if (this.mode === "catch") {
      const lost = L.spilled;
      if (lost > 0) {
        L.spilled = 0;
        this.catchSpill = (this.catchSpill || 0) + (lost / L.capacity) * A.capMl;
      }
    } else {
      L.spilled = 0;
    }
    const peak = L.wallPeak();
    this.dangerK += ((peak > -0.05 ? Math.min(1, (peak + 0.05) / 0.07) : 0) - this.dangerK) * Math.min(1, dt * 10);
    this.hooks.tick && this.hooks.tick(dt, now);
  }

  tickCatch(dt) {
    const L = this.L;
    let rate = 0;
    for (let i = this.incoming.length - 1; i >= 0; i--) {
      const c = this.incoming[i];
      // spread each chunk over ~0.2 s so the stream looks continuous
      const take = Math.min(c.left, Math.max(c.ml * dt * 5, 0.2));
      c.left -= take;
      rate += take / dt;
      this.actor.ml = this.actor.ml + take;
      if (c.left <= 1e-6) this.incoming.splice(i, 1);
    }
    if (rate > 0) {
      const k = rate / Math.max(30, this.actor.capMl * 0.45);
      this.streamW += (Math.min(1, 0.25 + k) - this.streamW) * Math.min(1, dt * 12);
      this.streamX = Math.sin(performance.now() / 700) * 0.18;
      // the stream punches a little crater where it lands
      if (Math.random() < 0.6) L.impulse(this.streamX, 0.05, -0.04 * Math.min(1.5, k), 0.2);
    } else this.streamW = Math.max(0, this.streamW - dt * 3);
  }

  tickPour(dt, g) {
    const A = this.actor, L = this.L;
    // tip angle: how far the phone has turned from how it was held when the pour began
    // (a little exaggerated: a phone held at a reading angle never tips quite as far
    // as a glass would)
    const target = Math.max(-2.6, Math.min(2.6, g.ang * POUR_GAIN));
    this.pourAng += (target - this.pourAng) * Math.min(1, dt * 14);
    const fill = L.vol / L.capacity;
    const st = pourState(this.pourAng, fill);
    let q = st.over > 0 ? POUR_K * Math.pow(st.over, 1.5) : 0;
    if (Math.abs(this.pourAng) > 1.9) q += 0.3;
    q = Math.min(POUR_MAX, q);
    const elapsed = (performance.now() - this.pourT0) / 1000;
    // after a while the rest glugs out by itself
    if (elapsed > 8) q = Math.max(q, 0.6);
    const dv = Math.min(L.vol, q * L.capacity * dt);
    L.vol -= dv;
    const ml = (dv / L.capacity) * A.capMl;
    this.pourOut += ml;
    this.pourTotal += ml;
    this.flow += ((q / POUR_MAX) - this.flow) * Math.min(1, dt * 10);
    this.pourVis = pourState(this.pourAng, L.vol / L.capacity);
    if (this.pourOut > 0 && (this.pourOut >= Math.max(4, A.capMl * 0.03) || performance.now() - (this.pourSentAt || 0) > 110)) {
      this.pourSentAt = performance.now();
      const out = this.pourOut;
      this.pourOut = 0;
      this.hooks.pour && this.hooks.pour(out);
    }
    if (L.vol <= L.capacity * 0.015 || this.ml < 0.6) {
      if (!this.pourDoneSent) {
        this.pourDoneSent = true;
        const rest = this.ml;
        L.vol = 0;
        if (rest + this.pourOut > 0) this.hooks.pour && this.hooks.pour(rest + this.pourOut);
        this.pourOut = 0;
        this.hooks.pourDone && this.hooks.pourDone(this.pourTotal + rest);
      }
    } else this.pourDoneSent = false;
  }

  draw(now) {
    if (this.stopped) return;
    this.raf = requestAnimationFrame((t) => this.draw(t));
    const dt = Math.min(0.05, Math.max(0, (now - this.lastDraw) / 1000));
    this.lastDraw = now;
    const { ctx, w, h, dpr } = this;
    const A = this.actor;
    this.scaleVis += (this.scale - this.scaleVis) * Math.min(1, dt * 3);
    A.view.takeSpills(A.L);
    A.view.update(dt, A.L);
    const lay = A.layout(0, this.box.top, w, h - this.box.top - this.box.bottom, this.scaleVis);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let sx = 0, sy = 0;
    if (A.shake > 0.01) {
      sx = (Math.random() - 0.5) * 16 * A.shake;
      sy = (Math.random() - 0.5) * 10 * A.shake;
    }
    this.scene.draw(ctx, w, h, lay.counterY, now / 1000, dpr, -A.tiltVis * 0.6);
    ctx.save();
    ctx.translate(sx, sy);
    if (this.mode === "pour") {
      const st = this.pourVis || pourState(this.pourAng, A.L.vol / A.L.capacity);
      A.view.drawPour(ctx, { cx: lay.cx, by: lay.by, S: lay.S }, { ang: this.pourAng, fill: A.L.vol / A.L.capacity, poly: st.poly, surf: st.surf, lip: st.lip, flow: this.flow });
    } else {
      const stream = (this.mode === "fill" || this.mode === "catch") && this.streamW > 0.01 ? { x: this.streamX, z: 0.05, w: this.streamW } : null;
      A.view.draw(ctx, A.L, { ...lay, streamTop: -10 }, {
        danger: this.mode === "run" || this.mode === "preview" ? this.dangerK : 0,
        crack: this.mode === "run" || this.mode === "ready" || this.mode === "hold",
        leak: this.mode === "run" ? 0.75 : 0,
        stream,
      });
    }
    ctx.restore();
    this.hooks.frame && this.hooks.frame(ctx, lay, now);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    S.stepOn = false;
    clearInterval(this.tickTimer);
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
  }
}

export { RIM_H };
