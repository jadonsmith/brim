// Draws a glass of drink on a bar counter, in a 3/4 view from slightly above.
// The drink's surface comes from a Liquid sim; this file only paints it, plus the
// splashes, puddles, drips, bubbles, ice, foam, lid and pour streams around it.
import { RIM_H } from "./liquid.js";

const TAU = Math.PI * 2;
export const BASE_H = 0.36;  // solid glass base under the floor (radii)
const WALL = 0.075;          // wall thickness
const TAPER = 0.87;          // floor radius / rim radius
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const radiusAt = (y) => TAPER + (1 - TAPER) * clamp(y / RIM_H, 0, 1.15);

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c, k) => [clamp(c[0] * k, 0, 255) | 0, clamp(c[1] * k, 0, 255) | 0, clamp(c[2] * k, 0, 255) | 0];
const lighten = (c, t) => mix(c, [255, 255, 255], t);

// ─────────────────────────── background ───────────────────────────
export class Scene {
  constructor() {
    this.cv = null;
    this.key = "";
  }
  bake(w, h, dpr) {
    const key = `${w}x${h}@${dpr}`;
    if (this.key === key) return;
    this.key = key;
    const cv = (this.cv = document.createElement("canvas"));
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const c = cv.getContext("2d");
    c.scale(dpr, dpr);
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "#0c0a17");
    g.addColorStop(0.55, "#120d1d");
    g.addColorStop(1, "#08070d");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // warm bar lights, out of focus
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const cols = ["#ffb35c", "#ff6f91", "#ffd27a", "#45d6c8", "#9c7bff", "#ff9a3c"];
    const n = Math.round(14 + (w * h) / 26000);
    for (let i = 0; i < n; i++) {
      const x = rnd() * w, y = rnd() * h * 0.68;
      const r = (12 + rnd() * 52) * Math.max(0.7, Math.min(1.6, w / 420));
      const col = hexRgb(cols[(rnd() * cols.length) | 0]);
      const a = 0.05 + rnd() * 0.16;
      const rg = c.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, rgba(col, a));
      rg.addColorStop(0.62, rgba(col, a * 0.75));
      rg.addColorStop(1, rgba(col, 0));
      c.fillStyle = rg;
      c.beginPath();
      c.arc(x, y, r, 0, TAU);
      c.fill();
    }
    // a soft vignette
    const v = c.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.2, w / 2, h * 0.5, Math.max(w, h) * 0.8);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.55)");
    c.fillStyle = v;
    c.fillRect(0, 0, w, h);
  }
  // counterY: screen y where the bar top meets the back wall
  draw(ctx, w, h, counterY, t, dpr, tilt = 0) {
    this.bake(w, h, dpr);
    ctx.save();
    if (tilt) {
      ctx.translate(w / 2, counterY);
      ctx.rotate((tilt * Math.PI) / 180);
      ctx.translate(-w / 2, -counterY);
    }
    const ox = Math.sin(t * 0.07) * 6, oy = Math.cos(t * 0.05) * 4;
    ctx.drawImage(this.cv, -12 + ox, -12 + oy, w + 24, h + 24);
    // the bar top
    const pad = tilt ? Math.max(w, h) : 0;
    const g = ctx.createLinearGradient(0, counterY, 0, h);
    g.addColorStop(0, "#241a30");
    g.addColorStop(0.08, "#191223");
    g.addColorStop(1, "#060509");
    ctx.fillStyle = g;
    ctx.fillRect(-pad, counterY, w + pad * 2, h - counterY + pad);
    const e = ctx.createLinearGradient(0, counterY - 1, 0, counterY + 10);
    e.addColorStop(0, "rgba(255,226,190,0.0)");
    e.addColorStop(0.15, "rgba(255,226,190,0.16)");
    e.addColorStop(1, "rgba(255,226,190,0)");
    ctx.fillStyle = e;
    ctx.fillRect(-pad, counterY - 1, w + pad * 2, 11);
    ctx.restore();
  }
}

// ─────────────────────────── the glass ───────────────────────────
export class GlassView {
  constructor(drink) {
    this.setDrink(drink);
    this.drops = [];     // droplets in flight (3D, glass coords)
    this.runs = [];      // rivulets running down the outside
    this.puddles = [];   // on the counter
    this.splats = [];    // splash crowns at ice impacts
    this.bubbles = [];
    for (let i = 0; i < 26; i++) this.bubbles.push(this.newBubble(true));
    this.dripT = 0;
    this.lidK = 0;
    this.t = 0;
    this.last = 0;
    this.fizzK = 0;
  }
  setDrink(d) {
    this.drink = d;
    this.cDeep = hexRgb(d.deep);
    this.cMid = hexRgb(d.mid);
    this.cTop = hexRgb(d.top);
    this.cGlow = hexRgb(d.glow);
  }
  newBubble(anyY) {
    const a = Math.random() * Math.PI;
    return { a, r: 0.35 + Math.random() * 0.6, y: anyY ? Math.random() * 2 : 0, sp: 0.18 + Math.random() * 0.5, sz: 0.6 + Math.random() * 1.5, ph: Math.random() * 6 };
  }
  clearMess() {
    this.drops.length = this.runs.length = this.puddles.length = this.splats.length = 0;
  }

  // Turn the sim's overflow events into flying droplets and runs down the glass,
  // on a budget: one droplet per ~0.05% of the glass, one run per ~0.3%.
  takeSpills(L) {
    const sp = L.spills;
    if (!sp.length) return;
    const dropEvery = L.capacity * 0.0005;
    const runEvery = L.capacity * 0.003;
    for (const e of sp) {
      if (e.splash) {
        const n = Math.min(22, 8 + Math.round((e.dv / L.capacity) * 600));
        for (let i = 0; i < n; i++) {
          const a = Math.random() * TAU;
          const v = 1.2 + Math.random() * 2.2;
          this.drops.push({ x: e.x, y: L.level + 0.05, z: e.z, vx: Math.cos(a) * v * 0.55, vy: 2.6 + Math.random() * 3.2, vz: Math.sin(a) * v * 0.55, r: 0.014 + Math.random() * 0.018, inside: true });
        }
        continue;
      }
      this.accD = (this.accD || 0) + e.dv;
      this.accR = (this.accR || 0) + e.dv;
      while (this.accD > dropEvery) {
        this.accD -= dropEvery;
        if (this.drops.length > 110) { this.accD = 0; break; }
        const ang = e.ang + (Math.random() - 0.5) * 0.25;
        const out = 0.25 + Math.random() * 0.8;
        const tang = (Math.random() - 0.5) * 0.5;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        this.drops.push({
          x: ca * 1.05, y: RIM_H + 0.02, z: sa * 1.05,
          vx: ca * out - sa * tang, vy: 0.2 + Math.random() * 0.9, vz: sa * out + ca * tang,
          r: (e.foam ? 0.022 : 0.012) + Math.random() * 0.016, foam: !!e.foam,
        });
      }
      while (this.accR > runEvery) {
        this.accR -= runEvery;
        if (this.runs.length > 30) { this.accR = 0; break; }
        this.runs.push({ ang: e.ang + (Math.random() - 0.5) * 0.12, y: RIM_H, v: 0.12 + Math.random() * 0.3, len: 0, foam: !!e.foam, w: 0.6 + Math.random() * 0.8 });
      }
    }
    sp.length = 0;
  }

  update(dt, L) {
    this.t += dt;
    // droplets fly, land on the counter, leave puddles
    const g = 11;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.vy -= g * dt;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      if (d.inside) {
        // splash droplets falling back into the glass vanish; ones that cross the rim keep going
        const r = Math.hypot(d.x, d.z);
        if (r > 1.02 && d.y > RIM_H) d.inside = false;
        else if (d.vy < 0 && d.y < L.level) { this.drops.splice(i, 1); continue; }
        if (r > 1 && d.y < RIM_H) { d.vx *= -0.3; d.vz *= -0.3; }
      }
      if (!d.inside && d.y < -BASE_H) {
        const rr = Math.hypot(d.x, d.z);
        if (rr > 1.0) this.addPuddle(d.x, d.z, d.r * (2.4 + Math.random() * 1.6), d.foam);
        this.drops.splice(i, 1);
      }
    }
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const r = this.runs[i];
      r.v += 0.5 * dt;
      r.y -= r.v * dt;
      r.len = Math.min(0.9, r.len + r.v * dt);
      if (r.y < -BASE_H + 0.02) {
        this.addPuddle(Math.cos(r.ang) * 1.12, Math.sin(r.ang) * 1.12, 0.08 + Math.random() * 0.06, r.foam);
        this.runs.splice(i, 1);
      }
    }
    for (let i = this.puddles.length - 1; i >= 0; i--) {
      const p = this.puddles[i];
      p.age += dt;
      p.r += (p.rMax - p.r) * Math.min(1, dt * 5);
      if (p.age > 16) this.puddles.splice(i, 1);
    }
    for (let i = this.splats.length - 1; i >= 0; i--) {
      this.splats[i].age += dt;
      if (this.splats[i].age > 0.5) this.splats.splice(i, 1);
    }
    for (const c of L.ice) {
      if (c.splash) {
        c.splash = 0;
        this.splats.push({ x: c.x, z: c.z, age: 0, s: c.s });
        if (!L.spills.some((e) => e.splash)) {
          // a cube in a half-empty glass: small splash that falls back in
          for (let i = 0; i < 10; i++) {
            const a = Math.random() * TAU, v = 0.8 + Math.random() * 1.4;
            this.drops.push({ x: c.x, y: L.level + 0.05, z: c.z, vx: Math.cos(a) * v * 0.5, vy: 1.8 + Math.random() * 2, vz: Math.sin(a) * v * 0.5, r: 0.02 + Math.random() * 0.03, inside: true });
          }
        }
      }
    }
    // carbonation
    const lvl = L.level;
    for (let i = 0; i < this.bubbles.length; i++) {
      const b = this.bubbles[i];
      b.y += b.sp * dt * (1 + this.fizzK * 3);
      if (b.y > lvl - 0.04) this.bubbles[i] = this.newBubble(false);
    }
    this.fizzK += ((L.foam > 0.02 ? 1 : 0) - this.fizzK) * Math.min(1, dt * 3);
    this.lidK += ((L.lid > 0 ? 1 : 0) - this.lidK) * Math.min(1, dt * 9);
  }

  addPuddle(x, z, r, foam) {
    // merge into a nearby puddle
    for (const p of this.puddles) {
      if (Math.hypot(p.x - x, p.z - z) < p.rMax * 0.9) {
        p.rMax = Math.min(0.75, Math.sqrt(p.rMax * p.rMax + r * r * 0.6));
        p.age = Math.min(p.age, 2);
        return;
      }
    }
    if (this.puddles.length > 28) this.puddles.shift();
    this.puddles.push({ x, z, r: r * 0.3, rMax: r, age: 0, foam, sq: 0.8 + Math.random() * 0.4 });
  }

  // opts: { leak (0..1 drip intensity), danger (0..1), stream: {x, z, w}, crack, alpha, shadowOnly }
  draw(ctx, L, lay, opts = {}) {
    const { cx, by, S } = lay;
    const phi = lay.phi != null ? lay.phi : 0.32;
    const cp = Math.cos(phi), sp = Math.sin(phi);
    const PX = (x) => cx + x * S;
    const PY = (y, z) => by - y * S * cp + z * S * sp;
    const lvl = Math.min(L.level, RIM_H + 0.35);
    const foam = L.foam;
    const hasDrink = L.vol > L.capacity * 0.004;
    const rimR = 1 + WALL;
    const yBot = -BASE_H;
    const ellipse = (y, r, z0 = 0) => {
      ctx.beginPath();
      ctx.ellipse(PX(0), PY(y, z0), r * S, Math.max(0.5, r * S * sp), 0, 0, TAU);
    };
    const halfArc = (y, r, front) => {
      ctx.ellipse(PX(0), PY(y, 0), r * S, Math.max(0.5, r * S * sp), 0, front ? 0 : Math.PI, front ? Math.PI : TAU);
    };

    // ── shadow + reflection on the counter
    const sh = ctx.createRadialGradient(PX(0), PY(yBot, 0.05), 0, PX(0), PY(yBot, 0.05), S * 1.6);
    sh.addColorStop(0, "rgba(0,0,0,0.55)");
    sh.addColorStop(0.6, "rgba(0,0,0,0.18)");
    sh.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.ellipse(PX(0.05), PY(yBot, 0.05), S * 1.6, S * 1.6 * sp * 1.2, 0, 0, TAU);
    ctx.fill();
    if (hasDrink) {
      // the drink's glow reflected in the glossy bar top
      ctx.save();
      ctx.translate(PX(0), PY(yBot, 0.9));
      ctx.scale(1, 0.42);
      const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, S * 1.25);
      rg.addColorStop(0, rgba(this.cMid, 0.34));
      rg.addColorStop(0.5, rgba(this.cMid, 0.12));
      rg.addColorStop(1, rgba(this.cMid, 0));
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(0, 0, S * 1.25, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // ── puddles
    for (const p of this.puddles) {
      const a = clamp(1 - (p.age - 10) / 6, 0, 1) * (p.foam ? 0.6 : 0.85);
      const px = PX(p.x), py = PY(yBot, p.z);
      const rx = p.r * S, ry = p.r * S * sp * p.sq;
      const pg = ctx.createRadialGradient(px - rx * 0.3, py - ry * 0.4, 0, px, py, rx);
      const base = p.foam ? [255, 246, 232] : this.cMid;
      pg.addColorStop(0, rgba(lighten(base, 0.45), a));
      pg.addColorStop(0.55, rgba(base, a * 0.85));
      pg.addColorStop(1, rgba(shade(base, 0.55), a * 0.6));
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.ellipse(px, py, rx, Math.max(1, ry), 0, 0, TAU);
      ctx.fill();
    }

    // ── base (solid glass, tinted by the drink above it)
    {
      const r0 = TAPER + WALL;
      ctx.beginPath();
      ctx.ellipse(PX(0), PY(yBot, 0), r0 * S, r0 * S * sp, 0, 0, Math.PI);
      ctx.lineTo(PX(-r0), PY(0, 0));
      ctx.lineTo(PX(-TAPER), PY(0, 0));
      ctx.ellipse(PX(0), PY(0, 0), TAPER * S, TAPER * S * sp, 0, Math.PI, 0, true);
      ctx.lineTo(PX(r0), PY(0, 0));
      ctx.closePath();
      const bg = ctx.createLinearGradient(PX(-r0), 0, PX(r0), 0);
      const tint = hasDrink ? this.cMid : [180, 200, 230];
      bg.addColorStop(0, rgba(lighten(tint, 0.2), 0.32));
      bg.addColorStop(0.3, rgba(lighten(tint, 0.55), 0.38));
      bg.addColorStop(0.55, rgba(tint, 0.22));
      bg.addColorStop(1, rgba(shade(tint, 0.6), 0.34));
      ctx.fillStyle = bg;
      ctx.fill();
      // caustic line along the bottom
      ctx.strokeStyle = rgba(lighten(tint, 0.6), 0.55);
      ctx.lineWidth = Math.max(1, S * 0.018);
      ctx.beginPath();
      ctx.ellipse(PX(0), PY(yBot + 0.03, 0), r0 * S * 0.96, r0 * S * sp * 0.96, 0, 0.15, Math.PI - 0.15);
      ctx.stroke();
    }

    // ── back inner wall
    {
      const r1 = 1, r0 = TAPER;
      ctx.beginPath();
      ctx.ellipse(PX(0), PY(RIM_H, 0), r1 * S, r1 * S * sp, 0, Math.PI, TAU);
      ctx.lineTo(PX(r0), PY(0, 0));
      ctx.ellipse(PX(0), PY(0, 0), r0 * S, r0 * S * sp, 0, 0, Math.PI, true);
      ctx.closePath();
      const wg = ctx.createLinearGradient(PX(-1), 0, PX(1), 0);
      wg.addColorStop(0, "rgba(255,255,255,0.07)");
      wg.addColorStop(0.25, "rgba(255,255,255,0.025)");
      wg.addColorStop(0.7, "rgba(255,255,255,0.045)");
      wg.addColorStop(1, "rgba(255,255,255,0.08)");
      ctx.fillStyle = wg;
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      halfArc(RIM_H, 1, false);
      ctx.stroke();
    }
    // droplets falling behind the glass
    this.drawDrops(ctx, PX, PY, S, false);

    if (hasDrink) this.drawDrink(ctx, L, lay, PX, PY, cp, sp, lvl, foam, opts);

    // ── ice
    if (L.ice.length) this.drawIce(ctx, L, PX, PY, S, sp, cp);

    // ── foam on top
    if (foam > 0.015 && hasDrink) this.drawFoam(ctx, L, PX, PY, S, sp, lvl, foam);

    // ── stream pouring in
    if (opts.stream && opts.stream.w > 0.01) this.drawStreamIn(ctx, L, PX, PY, S, lvl, opts.stream, lay);

    // ── the glass itself, front
    this.drawFrontGlass(ctx, PX, PY, S, sp, opts);

    // ── runs down the outside
    for (const r of this.runs) {
      const ca = Math.cos(r.ang), sa = Math.sin(r.ang);
      if (sa < -0.15) continue; // behind the glass
      const rr = radiusAt(r.y) + WALL;
      const x = PX(ca * rr), y0 = PY(r.y, sa * rr), y1 = PY(Math.min(RIM_H, r.y + r.len), sa * rr);
      const gr = ctx.createLinearGradient(0, y1, 0, y0);
      const col = r.foam ? [255, 248, 236] : lighten(this.cMid, 0.25);
      gr.addColorStop(0, rgba(col, 0));
      gr.addColorStop(1, rgba(col, 0.75));
      ctx.strokeStyle = gr;
      ctx.lineWidth = Math.max(1.2, S * 0.022 * r.w);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y0);
      ctx.stroke();
      ctx.fillStyle = rgba(lighten(col, 0.3), 0.9);
      ctx.beginPath();
      ctx.arc(x, y0, Math.max(1.4, S * 0.02 * r.w), 0, TAU);
      ctx.fill();
    }

    // ── crack + leak drips
    if (opts.crack) this.drawCrack(ctx, PX, PY, S, opts.leak || 0, L);

    // ── lid
    if (this.lidK > 0.01) {
      const k = this.lidK;
      const y = RIM_H + 0.05 + (1 - k) * 0.9;
      ctx.globalAlpha = k;
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ellipse(RIM_H + 0.01, 1.12);
      ctx.fill();
      const lg = ctx.createLinearGradient(PX(-1.1), 0, PX(1.1), 0);
      lg.addColorStop(0, "#3a2e4c");
      lg.addColorStop(0.45, "#6a5a86");
      lg.addColorStop(1, "#2a2138");
      ctx.fillStyle = lg;
      ellipse(y, 1.14);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ellipse(y + 0.01, 0.7);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // ── splash crowns
    for (const s of this.splats) {
      const k = s.age / 0.5;
      const px = PX(s.x), py = PY(L.level, s.z);
      ctx.strokeStyle = `rgba(255,255,255,${0.7 * (1 - k)})`;
      ctx.lineWidth = Math.max(1, S * 0.02 * (1 - k));
      ctx.beginPath();
      ctx.ellipse(px, py, S * s.s * (0.4 + k * 0.9), S * s.s * sp * (0.4 + k * 0.9), 0, 0, TAU);
      ctx.stroke();
    }

    // ── droplets in flight (in front of the glass)
    this.drawDrops(ctx, PX, PY, S, true);
  }

  drawDrops(ctx, PX, PY, S, front) {
    const col = rgba(lighten(this.cTop, 0.15), 0.95);
    for (const d of this.drops) {
      const isFront = d.inside || d.z >= -0.1;
      if (isFront !== front) continue;
      const px = PX(d.x), py = PY(d.y, d.z);
      const r = Math.max(1, d.r * S);
      const stretch = 1 + Math.min(1.6, Math.abs(d.vy) * 0.12);
      ctx.fillStyle = d.foam ? "rgba(255,248,236,0.92)" : col;
      ctx.beginPath();
      ctx.ellipse(px, py, r, r * stretch, 0, 0, TAU);
      ctx.fill();
      if (r > 1.8) {
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.beginPath();
        ctx.arc(px - r * 0.3, py - r * 0.35 * stretch, r * 0.32, 0, TAU);
        ctx.fill();
      }
    }
  }

  drawDrink(ctx, L, lay, PX, PY, cp, sp, lvl, foam, opts) {
    const S = lay.S;
    const M = 34;
    const H = (x, z) => L.heightAt(x, z);
    // the drink's surface, front and back edges (where it meets the wall)
    const fx = new Float32Array(M), fy = new Float32Array(M), bx = new Float32Array(M), byy = new Float32Array(M);
    const hy = new Float32Array(M);
    let topY = 1e9;
    for (let k = 0; k < M; k++) {
      const x = -Math.cos((Math.PI * k) / (M - 1));
      const z = Math.sqrt(Math.max(0, 1 - x * x));
      const yf = Math.min(RIM_H + 0.06, lvl + H(x * 0.97, z * 0.97));
      const yb = Math.min(RIM_H + 0.06, lvl + H(x * 0.97, -z * 0.97));
      const rf = radiusAt(yf), rb = radiusAt(yb);
      fx[k] = PX(x * rf); fy[k] = PY(yf, z * rf);
      bx[k] = PX(x * rb); byy[k] = PY(yb, -z * rb);
      hy[k] = yf;
      if (byy[k] < topY) topY = byy[k];
    }

    // ── surface, painted back to front in strips with slope shading
    const K = 9, MM = 15;
    const rowsX = [], rowsY = [];
    const light = [-0.42, 0.78, -0.46];
    const view = [0, sp, cp];
    const half3 = (l) => {
      const v = [l[0] + view[0], l[1] + view[1], l[2] + view[2]];
      const n = Math.hypot(v[0], v[1], v[2]);
      return [v[0] / n, v[1] / n, v[2] / n];
    };
    // two lamps behind the bar: a warm one to the left, a cool one to the right
    const hv = half3([-0.5, 0.42, -0.76]);
    const hv2 = half3([0.62, 0.36, -0.7]);
    const surfBase = mix(this.cMid, this.cTop, 0.62);
    for (let r = 0; r < K; r++) {
      const z = -1 + (2 * r) / (K - 1);
      const zz = z * 0.985;
      const half = Math.sqrt(Math.max(0, 1 - zz * zz));
      const xs = new Float32Array(MM), ys = new Float32Array(MM);
      for (let m = 0; m < MM; m++) {
        const x = (-1 + (2 * m) / (MM - 1)) * half * 0.985;
        const y = Math.min(RIM_H + 0.06, lvl + H(x, zz));
        const rr = radiusAt(y);
        xs[m] = PX(x * rr);
        ys[m] = PY(y, zz * rr);
      }
      rowsX.push(xs);
      rowsY.push(ys);
    }
    const e = 0.06;
    for (let r = 0; r < K - 1; r++) {
      const zMid = -1 + (2 * (r + 0.5)) / (K - 1);
      const half = Math.sqrt(Math.max(0.02, 1 - zMid * zMid));
      const A = rowsX[r], Ay = rowsY[r], B = rowsX[r + 1], By = rowsY[r + 1];
      ctx.beginPath();
      ctx.moveTo(A[0], Ay[0]);
      for (let m = 1; m < MM; m++) ctx.lineTo(A[m], Ay[m]);
      for (let m = MM - 1; m >= 0; m--) ctx.lineTo(B[m], By[m]);
      ctx.closePath();
      const gx0 = Math.min(A[0], B[0]), gx1 = Math.max(A[MM - 1], B[MM - 1]);
      const grad = ctx.createLinearGradient(gx0, 0, Math.max(gx0 + 1, gx1), 0);
      // toward the back the surface mirrors the dark room (Fresnel); toward the front
      // you see down into the drink
      const back = 1 - (r + 0.5) / (K - 1);
      for (let s = 0; s <= 6; s++) {
        const x = (-1 + (2 * s) / 6) * half * 0.92;
        const hx = (H(x + e, zMid) - H(x - e, zMid)) / (2 * e);
        const hz = (H(x, zMid + e) - H(x, zMid - e)) / (2 * e);
        const amp = 3.2;
        let nx = -hx * amp, ny = 1, nz = -hz * amp;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl; ny /= nl; nz /= nl;
        const diff = nx * light[0] + ny * light[1] + nz * light[2];
        const spec = Math.pow(Math.max(0, nx * hv[0] + ny * hv[1] + nz * hv[2]), 38);
        const spec2 = Math.pow(Math.max(0, nx * hv2[0] + ny * hv2[1] + nz * hv2[2]), 60);
        let c = shade(surfBase, 0.7 + 0.42 * diff - back * 0.08);
        c = mix(c, [255, 240, 214], Math.min(0.92, spec * 1.7));
        c = mix(c, [205, 238, 255], Math.min(0.75, spec2 * 1.5));
        grad.addColorStop(s / 6, rgba(c, 1));
      }
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    // a soft sheen across the far half of the surface
    {
      ctx.beginPath();
      ctx.moveTo(bx[0], byy[0]);
      for (let k = 1; k < M; k++) ctx.lineTo(bx[k], byy[k]);
      for (let k = M - 1; k >= 0; k--) ctx.lineTo(fx[k], fy[k]);
      ctx.closePath();
      const yb0 = PY(lvl, -1), yf0 = PY(lvl, 1);
      const sg = ctx.createLinearGradient(0, yb0, 0, yf0);
      sg.addColorStop(0, "rgba(255,244,228,0.1)");
      sg.addColorStop(0.35, "rgba(255,244,228,0.03)");
      sg.addColorStop(0.6, "rgba(255,255,255,0)");
      sg.addColorStop(1, rgba(this.cGlow, 0.12));
      ctx.fillStyle = sg;
      ctx.fill();
    }

    // ── the body of drink you see through the front of the glass
    const bodyPath = () => {
      ctx.beginPath();
      ctx.moveTo(fx[0], fy[0]);
      for (let k = 1; k < M; k++) ctx.lineTo(fx[k], fy[k]);
      // down the right wall, along the front of the floor, up the left wall
      ctx.lineTo(PX(TAPER), PY(0, 0));
      ctx.ellipse(PX(0), PY(0, 0), TAPER * S, TAPER * S * sp, 0, 0, Math.PI, false);
      ctx.closePath();
    };
    bodyPath();
    const yTop = Math.min(...fy), yFloor = PY(0, TAPER);
    const vg = ctx.createLinearGradient(0, yFloor, 0, yTop);
    vg.addColorStop(0, rgba(shade(this.cDeep, 0.8), 1));
    vg.addColorStop(0.55, rgba(this.cMid, 1));
    vg.addColorStop(1, rgba(lighten(this.cTop, 0.08), 1));
    ctx.fillStyle = vg;
    ctx.fill();
    ctx.save();
    ctx.clip();
    // cylinder shading across the front
    const hg = ctx.createLinearGradient(PX(-1), 0, PX(1), 0);
    hg.addColorStop(0, "rgba(0,0,0,0.45)");
    hg.addColorStop(0.16, "rgba(0,0,0,0.08)");
    hg.addColorStop(0.32, "rgba(255,255,255,0.09)");
    hg.addColorStop(0.5, "rgba(0,0,0,0)");
    hg.addColorStop(0.82, "rgba(0,0,0,0.12)");
    hg.addColorStop(1, "rgba(0,0,0,0.5)");
    ctx.fillStyle = hg;
    ctx.fillRect(PX(-1.1), yTop - 4, S * 2.2, yFloor - yTop + 8 + S * 0.4);
    // light scattering just under the surface
    ctx.strokeStyle = rgba(this.cGlow, 0.32);
    ctx.lineWidth = S * 0.2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(fx[0], fy[0] + S * 0.08);
    for (let k = 1; k < M; k++) ctx.lineTo(fx[k], fy[k] + S * 0.08);
    ctx.stroke();
    // slow caustic shimmer
    const t = this.t;
    for (let i = 0; i < 3; i++) {
      const xx = Math.sin(t * (0.35 + i * 0.13) + i * 2.1) * 0.55;
      const cg = ctx.createRadialGradient(PX(xx), PY(0.5 + i * 0.45, 0.9), 0, PX(xx), PY(0.5 + i * 0.45, 0.9), S * 0.55);
      cg.addColorStop(0, rgba(lighten(this.cTop, 0.4), 0.12));
      cg.addColorStop(1, rgba(this.cTop, 0));
      ctx.fillStyle = cg;
      ctx.fillRect(PX(xx) - S * 0.6, PY(0.5 + i * 0.45, 0.9) - S * 0.6, S * 1.2, S * 1.2);
    }
    // bubbles
    ctx.lineWidth = 1;
    for (const b of this.bubbles) {
      if (b.y > lvl - 0.05) continue;
      const rr = radiusAt(b.y) * b.r;
      const x = Math.cos(b.a) * rr + Math.sin(this.t * 3 + b.ph) * 0.02;
      const z = Math.sin(b.a) * rr;
      const px = PX(x), py = PY(b.y, z);
      const r = Math.max(0.8, b.sz * S * 0.012 * (1 + this.fizzK));
      ctx.strokeStyle = `rgba(255,255,255,${0.22 + this.fizzK * 0.25})`;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();

    // meniscus: the bright line where the drink meets the front of the glass
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = Math.max(1, S * 0.012);
    ctx.beginPath();
    ctx.moveTo(fx[0], fy[0]);
    for (let k = 1; k < M; k++) ctx.lineTo(fx[k], fy[k]);
    ctx.stroke();
    ctx.strokeStyle = rgba(lighten(this.cTop, 0.5), 0.35);
    ctx.lineWidth = Math.max(1, S * 0.008);
    ctx.beginPath();
    ctx.moveTo(bx[0], byy[0]);
    for (let k = 1; k < M; k++) ctx.lineTo(bx[k], byy[k]);
    ctx.stroke();
  }

  drawIce(ctx, L, PX, PY, S, sp, cp) {
    const cubes = L.ice.slice().sort((a, b) => a.z - b.z);
    for (const c of cubes) {
      const h = c.s / 2;
      const ca = Math.cos(c.rot), sa = Math.sin(c.rot);
      const corner = (dx, dy, dz) => {
        const x = c.x + dx * ca - dz * sa;
        const z = c.z + dx * sa + dz * ca;
        return [PX(x), PY(c.y + dy, z), z];
      };
      const top = [corner(-h, h, -h), corner(h, h, -h), corner(h, h, h), corner(-h, h, h)];
      const bot = [corner(-h, -h, -h), corner(h, -h, -h), corner(h, -h, h), corner(-h, -h, h)];
      // sides facing the viewer (+z)
      const sides = [];
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        const nz = (top[i][2] + top[j][2]) / 2 - c.z;
        if (nz > 0.001) sides.push([top[i], top[j], bot[j], bot[i], nz]);
      }
      const poly = (pts) => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
      };
      ctx.lineJoin = "round";
      for (const s of sides) {
        poly(s);
        ctx.fillStyle = `rgba(200,228,255,${0.34 + s[4] * 0.6})`;
        ctx.fill();
        ctx.strokeStyle = "rgba(235,248,255,0.55)";
        ctx.lineWidth = Math.max(2, S * 0.03);
        ctx.stroke();
      }
      poly(top);
      const tg = ctx.createLinearGradient(top[0][0], top[0][1], top[2][0], top[2][1]);
      tg.addColorStop(0, "rgba(245,252,255,0.92)");
      tg.addColorStop(1, "rgba(190,222,250,0.75)");
      ctx.fillStyle = tg;
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = Math.max(2, S * 0.032);
      ctx.stroke();
      // a frosty glint
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = Math.max(1, S * 0.01);
      ctx.beginPath();
      ctx.moveTo(top[0][0] * 0.7 + top[2][0] * 0.3, top[0][1] * 0.7 + top[2][1] * 0.3);
      ctx.lineTo(top[0][0] * 0.45 + top[1][0] * 0.55, top[0][1] * 0.45 + top[1][1] * 0.55);
      ctx.stroke();
      // the part under the surface takes on the drink's colour
      if (c.state !== "fall") {
        const wy = PY(L.level + L.heightAt(c.x, c.z), c.z);
        ctx.save();
        ctx.beginPath();
        ctx.rect(PX(c.x) - S, wy, S * 2, S * 2);
        ctx.clip();
        for (const s of sides) {
          poly(s);
          ctx.fillStyle = rgba(this.cMid, 0.62);
          ctx.fill();
        }
        ctx.restore();
        ctx.strokeStyle = "rgba(255,255,255,0.45)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(PX(c.x), wy, S * c.s * 0.72, S * c.s * 0.72 * sp, 0, 0, Math.PI);
        ctx.stroke();
      }
    }
  }

  drawFoam(ctx, L, PX, PY, S, sp, lvl, foam) {
    const M = 30;
    const pts = [];
    for (let k = 0; k <= M; k++) {
      const a = Math.PI * (k / M); // front half, right to left
      const x = Math.cos(a), z = Math.sin(a);
      const y = Math.min(RIM_H + 0.22, lvl + L.heightAt(x * 0.95, z * 0.95) + foam * (0.85 + 0.15 * Math.sin(k * 1.7 + this.t * 3)));
      const r = radiusAt(y);
      pts.push([PX(x * r), PY(y, z * r)]);
    }
    for (let k = M; k >= 0; k--) {
      const a = Math.PI + Math.PI * ((M - k) / M);
      const x = Math.cos(a), z = Math.sin(a);
      const y = Math.min(RIM_H + 0.22, lvl + L.heightAt(x * 0.95, z * 0.95) + foam);
      const r = radiusAt(y);
      pts.push([PX(x * r), PY(y, z * r)]);
    }
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    const a = Math.min(1, foam / 0.08);
    const fg = ctx.createLinearGradient(0, PY(lvl + foam, -1), 0, PY(lvl, 1));
    fg.addColorStop(0, `rgba(255,252,246,${0.95 * a})`);
    fg.addColorStop(1, `rgba(255,236,214,${0.9 * a})`);
    ctx.fillStyle = fg;
    ctx.fill();
    // foam band down the front, with bubbly edge
    ctx.fillStyle = `rgba(255,247,236,${0.92 * a})`;
    for (let k = 0; k <= M; k += 1) {
      const p = pts[k];
      const r = S * (0.045 + 0.03 * Math.abs(Math.sin(k * 2.3))) * (0.5 + a * 0.5);
      ctx.beginPath();
      ctx.arc(p[0], p[1] + r * 0.6, r, 0, TAU);
      ctx.fill();
    }
  }

  drawStreamIn(ctx, L, PX, PY, S, lvl, st, lay) {
    const x = st.x || 0, z = st.z || 0;
    const sy = PY(lvl + L.heightAt(x, z), z);
    const top = lay.streamTop != null ? lay.streamTop : -20;
    const w = Math.max(2, S * 0.09 * Math.sqrt(st.w));
    const t = this.t;
    const px = PX(x);
    ctx.beginPath();
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const k = i / steps;
      const yy = top + (sy - top) * k;
      const wob = Math.sin(t * 14 + k * 9) * w * 0.12;
      const ww = w * (0.75 + 0.35 * k);
      ctx[i ? "lineTo" : "moveTo"](px + wob - ww / 2, yy);
    }
    for (let i = steps; i >= 0; i--) {
      const k = i / steps;
      const yy = top + (sy - top) * k;
      const wob = Math.sin(t * 14 + k * 9) * w * 0.12;
      const ww = w * (0.75 + 0.35 * k);
      ctx.lineTo(px + wob + ww / 2, yy);
    }
    ctx.closePath();
    const g = ctx.createLinearGradient(px - w, 0, px + w, 0);
    g.addColorStop(0, rgba(this.cDeep, 0.95));
    g.addColorStop(0.45, rgba(lighten(this.cTop, 0.2), 0.98));
    g.addColorStop(1, rgba(this.cMid, 0.95));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = Math.max(1, w * 0.12);
    ctx.beginPath();
    ctx.moveTo(px - w * 0.18, top);
    ctx.lineTo(px - w * 0.18 + Math.sin(t * 14 + 9) * w * 0.12, sy);
    ctx.stroke();
    // churn where it lands
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    for (let i = 0; i < 6; i++) {
      const a = t * 9 + i * 1.05;
      const rr = w * (0.6 + 0.5 * Math.abs(Math.sin(a * 1.7)));
      ctx.beginPath();
      ctx.arc(px + Math.cos(a) * rr, sy + Math.sin(a) * rr * 0.3, Math.max(1, w * 0.12), 0, TAU);
      ctx.fill();
    }
  }

  drawFrontGlass(ctx, PX, PY, S, sp, opts) {
    const rimR = 1 + WALL;
    const r0 = TAPER + WALL;
    // outer silhouette edges
    const edge = (side) => {
      ctx.beginPath();
      ctx.moveTo(PX(side * r0), PY(0, 0));
      ctx.lineTo(PX(side * rimR), PY(RIM_H, 0));
    };
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = Math.max(1.4, S * 0.022);
    edge(-1);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    edge(1);
    ctx.stroke();
    // inner edge lines (the wall's thickness)
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PX(-TAPER), PY(0, 0));
    ctx.lineTo(PX(-1), PY(RIM_H, 0));
    ctx.moveTo(PX(TAPER), PY(0, 0));
    ctx.lineTo(PX(1), PY(RIM_H, 0));
    ctx.stroke();
    // reflections on the front
    const band = (u0, u1, a) => {
      const yA = 0.18, yB = RIM_H - 0.12;
      const xA0 = u0 * radiusAt(yA), xA1 = u1 * radiusAt(yA), xB0 = u0 * radiusAt(yB), xB1 = u1 * radiusAt(yB);
      const zA = Math.sqrt(Math.max(0, 1 - u0 * u0));
      ctx.beginPath();
      ctx.moveTo(PX(xB0 * 1.07), PY(yB, zA));
      ctx.lineTo(PX(xB1 * 1.07), PY(yB, zA));
      ctx.lineTo(PX(xA1 * 1.07), PY(yA, zA));
      ctx.lineTo(PX(xA0 * 1.07), PY(yA, zA));
      ctx.closePath();
      const g = ctx.createLinearGradient(PX(xB0 * 1.07), 0, PX(xB1 * 1.07), 0);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.5, `rgba(255,255,255,${a})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fill();
    };
    band(-0.8, -0.56, 0.2);
    band(-0.5, -0.42, 0.13);
    band(0.42, 0.62, 0.09);
    // rim
    const danger = opts.danger || 0;
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = Math.max(1, S * 0.012);
    ctx.beginPath();
    ctx.ellipse(PX(0), PY(RIM_H, 0), rimR * S, rimR * S * sp, 0, Math.PI, TAU);
    ctx.stroke();
    if (danger > 0.02) {
      ctx.strokeStyle = `rgba(255,${(200 - danger * 140) | 0},${(160 - danger * 120) | 0},${0.25 * danger})`;
      ctx.lineWidth = S * 0.09;
      ctx.beginPath();
      ctx.ellipse(PX(0), PY(RIM_H, 0), rimR * S, rimR * S * sp, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.strokeStyle = danger > 0.02 ? `rgba(255,${(235 - danger * 120) | 0},${(225 - danger * 150) | 0},0.9)` : "rgba(255,255,255,0.78)";
    ctx.lineWidth = Math.max(1.4, S * 0.02);
    ctx.beginPath();
    ctx.ellipse(PX(0), PY(RIM_H, 0), rimR * S, rimR * S * sp, 0, 0, Math.PI);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(PX(0), PY(RIM_H, 0), 1 * S, 1 * S * sp, 0, 0, Math.PI);
    ctx.stroke();
    // base outline
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = Math.max(1, S * 0.014);
    ctx.beginPath();
    ctx.ellipse(PX(0), PY(-BASE_H, 0), r0 * S, r0 * S * sp, 0, 0, Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(PX(-r0), PY(0, 0));
    ctx.lineTo(PX(-r0), PY(-BASE_H, 0));
    ctx.moveTo(PX(r0), PY(0, 0));
    ctx.lineTo(PX(r0), PY(-BASE_H, 0));
    ctx.stroke();
  }

  drawCrack(ctx, PX, PY, S, leak, L) {
    const a = 0.62; // front right
    const x = Math.cos(a), z = Math.sin(a);
    const pts = [[0.05, 0], [0.2, 0.03], [0.32, -0.02], [0.46, 0.035], [0.6, 0.0], [0.7, 0.02]];
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = Math.max(1, S * 0.008);
    ctx.beginPath();
    pts.forEach(([y, dx], i) => {
      const r = radiusAt(y) + WALL;
      const px = PX(x * r + dx), py = PY(y, z * r);
      ctx[i ? "lineTo" : "moveTo"](px, py);
    });
    ctx.stroke();
    ctx.beginPath();
    const r1 = radiusAt(0.32) + WALL;
    ctx.moveTo(PX(x * r1 - 0.02), PY(0.32, z * r1));
    ctx.lineTo(PX(x * r1 - 0.09), PY(0.4, z * r1));
    ctx.stroke();
    // drips
    if (leak > 0 && L.vol > 0.01 * L.capacity) {
      this.dripT += leak * 0.016 * 60;
      const ph = this.dripT % 1;
      const r = radiusAt(0.05) + WALL;
      const px = PX(x * r + 0.05);
      const y0 = PY(0.05, z * r);
      const yEnd = PY(-BASE_H, z * r) + 2;
      const yy = ph < 0.55 ? y0 + (ph / 0.55) * 3 : y0 + 3 + Math.pow((ph - 0.55) / 0.45, 2) * (yEnd - y0);
      ctx.fillStyle = rgba(lighten(this.cMid, 0.2), 0.9);
      ctx.beginPath();
      ctx.ellipse(px, yy, Math.max(1.5, S * 0.022), Math.max(2, S * 0.03), 0, 0, TAU);
      ctx.fill();
      if (ph > 0.97 && !this._dripped) {
        this._dripped = true;
        this.addPuddle(x * 1.2, z * 1.2, 0.07, false);
      } else if (ph < 0.5) this._dripped = false;
    }
  }

  // Flat side view while pouring: the glass stays put on the screen and the drink
  // stays level with the real world, so tipping the phone pours it out of the lip.
  // st: { ang (rad, + = tipped right), fill (0..1), flow (0..1) }
  drawPour(ctx, lay, st) {
    const { cx, by, S } = lay;
    const P = (x, y) => [cx + x * S, by - y * S];
    const rimR = 1 + WALL;
    const r0 = TAPER + WALL;
    // interior polygon (trapezoid), clipped by the level surface
    const quad = [[-TAPER, 0], [TAPER, 0], [1, RIM_H], [-1, RIM_H]];
    const ux = -Math.sin(st.ang), uy = Math.cos(st.ang);
    const poly = st.poly || pourPolygon(quad, ux, uy, st.fill);
    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath();
    const [sx, sy] = P(0, -BASE_H);
    ctx.ellipse(sx, sy + 4, S * 1.3, S * 0.18, 0, 0, TAU);
    ctx.fill();
    // base
    ctx.fillStyle = rgba(lighten(this.cMid, 0.4), 0.28);
    ctx.beginPath();
    let p = P(-r0, 0); ctx.moveTo(p[0], p[1]);
    p = P(r0, 0); ctx.lineTo(p[0], p[1]);
    p = P(r0, -BASE_H); ctx.lineTo(p[0], p[1]);
    p = P(-r0, -BASE_H); ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.fill();
    // back wall tint
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.beginPath();
    quad.forEach(([x, y], i) => { const q = P(x, y); ctx[i ? "lineTo" : "moveTo"](q[0], q[1]); });
    ctx.closePath();
    ctx.fill();
    // drink
    if (poly.length > 2) {
      ctx.beginPath();
      poly.forEach(([x, y], i) => { const q = P(x, y); ctx[i ? "lineTo" : "moveTo"](q[0], q[1]); });
      ctx.closePath();
      const g = ctx.createLinearGradient(...P(-ux * 1.2, -uy * 1.2), ...P(ux * 1.2, uy * 1.2 + 1));
      g.addColorStop(0, rgba(shade(this.cDeep, 0.8), 1));
      g.addColorStop(0.6, rgba(this.cMid, 1));
      g.addColorStop(1, rgba(lighten(this.cTop, 0.1), 1));
      ctx.fillStyle = g;
      ctx.fill();
      // surface line
      const surf = st.surf;
      if (surf) {
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.lineWidth = Math.max(1.5, S * 0.018);
        ctx.beginPath();
        const a = P(surf[0][0], surf[0][1]), b = P(surf[1][0], surf[1][1]);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
    }
    // stream off the low lip
    if (st.flow > 0.01 && st.lip) {
      const [lx, ly] = P(st.lip[0], st.lip[1]);
      const w = Math.max(2.5, S * 0.12 * Math.sqrt(st.flow));
      // world-down in screen coords is -u
      const dx = -ux, dy = uy; // screen y grows downward
      const side = st.lip[0] > 0 ? 1 : -1;
      const v0x = side * 0.9 * S * Math.cos(st.ang) * 0.6, v0y = side * 0.9 * S * Math.sin(st.ang) * 0.6;
      ctx.strokeStyle = rgba(lighten(this.cTop, 0.1), 0.95);
      ctx.lineWidth = w;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      for (let i = 1; i <= 16; i++) {
        const tt = i / 16 * 0.9;
        const x = lx + v0x * tt + 0.5 * dx * S * 9 * tt * tt;
        const y = ly + v0y * tt + 0.5 * dy * S * 9 * tt * tt;
        ctx.lineTo(x + Math.sin(this.t * 20 + i) * w * 0.08, y);
      }
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = Math.max(1, w * 0.18);
      ctx.stroke();
    }
    // glass outline
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = Math.max(1.5, S * 0.022);
    ctx.lineJoin = "round";
    ctx.beginPath();
    p = P(-rimR, RIM_H); ctx.moveTo(p[0], p[1]);
    p = P(-r0, 0); ctx.lineTo(p[0], p[1]);
    p = P(-r0, -BASE_H); ctx.lineTo(p[0], p[1]);
    p = P(r0, -BASE_H); ctx.lineTo(p[0], p[1]);
    p = P(r0, 0); ctx.lineTo(p[0], p[1]);
    p = P(rimR, RIM_H); ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = Math.max(2, S * 0.03);
    ctx.beginPath();
    p = P(-rimR, RIM_H); ctx.moveTo(p[0], p[1]);
    p = P(-1, RIM_H); ctx.lineTo(p[0], p[1]);
    p = P(1, RIM_H); ctx.moveTo(p[0], p[1]);
    p = P(rimR, RIM_H); ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    // reflection
    const g2 = ctx.createLinearGradient(...P(-0.75, 1), ...P(-0.5, 1));
    g2.addColorStop(0, "rgba(255,255,255,0)");
    g2.addColorStop(0.5, "rgba(255,255,255,0.16)");
    g2.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g2;
    ctx.beginPath();
    p = P(-0.72, RIM_H - 0.12); ctx.moveTo(p[0], p[1]);
    p = P(-0.52, RIM_H - 0.12); ctx.lineTo(p[0], p[1]);
    p = P(-0.48, 0.2); ctx.lineTo(p[0], p[1]);
    p = P(-0.66, 0.2); ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.fill();
  }
}

// ─────────────────────────── pour geometry ───────────────────────────
function clipHalf(poly, ux, uy, d) {
  // keep points with p·u <= d
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = a[0] * ux + a[1] * uy - d, db = b[0] * ux + b[1] * uy - d;
    if (da <= 0) out.push(a);
    if ((da <= 0) !== (db <= 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
function area(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}
export const POUR_QUAD = [[-TAPER, 0], [TAPER, 0], [1, RIM_H], [-1, RIM_H]];
export const POUR_AREA = area(POUR_QUAD);

// The level at which a tipped glass holding `fill` (fraction of the trapezoid) sits.
export function pourLevel(ux, uy, fill) {
  const q = POUR_QUAD;
  const ds = q.map(([x, y]) => x * ux + y * uy);
  let lo = Math.min(...ds), hi = Math.max(...ds);
  const want = clamp(fill, 0, 1) * POUR_AREA;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (area(clipHalf(q, ux, uy, mid)) < want) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function pourPolygon(quad, ux, uy, fill) {
  const d = pourLevel(ux, uy, fill);
  return clipHalf(quad, ux, uy, d);
}

// Pour state for a tip angle: the drink's polygon, the surface line, the low lip and
// how far the drink stands above it (>0 means it's flowing out).
export function pourState(ang, fill) {
  const ux = -Math.sin(ang), uy = Math.cos(ang);
  const q = POUR_QUAD;
  const dNeed = pourLevel(ux, uy, fill);
  const lipL = [-1, RIM_H], lipR = [1, RIM_H];
  const dl = lipL[0] * ux + lipL[1] * uy, dr = lipR[0] * ux + lipR[1] * uy;
  const lip = dl < dr ? lipL : lipR;
  const dLip = Math.min(dl, dr);
  const d = Math.min(dNeed, dLip + 0.02);
  const poly = clipHalf(q, ux, uy, d);
  // surface segment: the clip edge
  let surf = null;
  const onLine = poly.filter((p) => Math.abs(p[0] * ux + p[1] * uy - d) < 1e-6);
  if (onLine.length >= 2) surf = [onLine[0], onLine[onLine.length - 1]];
  return { poly, surf, lip, over: dNeed - dLip, ux, uy };
}
