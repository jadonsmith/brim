// The drink: a 2D shallow-water height field on a disc (the glass seen from above),
// plus floating ice cubes and a foam head. Units: the glass radius is 1 and the
// glass is RIM_H tall; accelerations are in m/s², in the glass's own frame:
//   gx  sideways (screen right), gz  front/back (+ toward the person holding it),
//   gv  along the glass axis (normally ~9.81, pulling the drink to the bottom).
// Liquid that rises over the rim flows out (weir law) and is gone. This file has no
// DOM code, so the server-side tuning tools can import it too.

export const RIM_H = 2.3; // interior height of the glass, in radii

export class Liquid {
  constructor({ N = 22, depth = 2.0, damp = 0.85, diffuse = 0.012, weir = 2.4 } = {}) {
    this.N = N;
    this.dx = 2 / N;
    this.depth = depth;   // shallow-water depth: sets wave speed (sloshing frequency)
    this.damp = damp;     // velocity damping per second
    this.diffuse = diffuse; // surface smoothing, kills grid-scale chop
    this.weir = weir;     // overflow coefficient
    const NN = N * N;
    this.eta = new Float32Array(NN);       // surface height relative to the mean level
    this.tmp = new Float32Array(NN);
    this.u = new Float32Array((N + 1) * N); // x-face velocities
    this.w = new Float32Array(N * (N + 1)); // z-face velocities
    this.mask = new Uint8Array(NN);
    this.uOpen = new Uint8Array((N + 1) * N);
    this.wOpen = new Uint8Array(N * (N + 1));
    this.near = new Int32Array(NN);

    let count = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -1 + (i + 0.5) * this.dx;
        const z = -1 + (j + 0.5) * this.dx;
        if (x * x + z * z <= 1) { this.mask[j * N + i] = 1; count++; }
      }
    }
    this.cells = count;
    this.area = count * this.dx * this.dx; // ≈ π
    for (let j = 0; j < N; j++) {
      for (let i = 1; i < N; i++) if (this.mask[j * N + i] && this.mask[j * N + i - 1]) this.uOpen[j * (N + 1) + i] = 1;
    }
    for (let j = 1; j < N; j++) {
      for (let i = 0; i < N; i++) if (this.mask[j * N + i] && this.mask[(j - 1) * N + i]) this.wOpen[j * N + i] = 1;
    }
    // wall cells: inside the disc with a neighbour outside it
    this.walls = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = j * N + i;
        if (!this.mask[c]) continue;
        const out = (ii, jj) => ii < 0 || jj < 0 || ii >= N || jj >= N || !this.mask[jj * N + ii];
        if (out(i - 1, j) || out(i + 1, j) || out(i, j - 1) || out(i, j + 1)) {
          const x = -1 + (i + 0.5) * this.dx;
          const z = -1 + (j + 0.5) * this.dx;
          this.walls.push({ c, ang: Math.atan2(z, x), x, z });
        }
      }
    }
    this.wallLen = (2 * Math.PI) / this.walls.length;
    // nearest in-disc cell for every cell (for extrapolating to the rim)
    for (let c = 0; c < NN; c++) {
      if (this.mask[c]) { this.near[c] = c; continue; }
      const i = c % N, j = (c / N) | 0;
      let best = -1, bd = 1e9;
      for (let cc = 0; cc < NN; cc++) {
        if (!this.mask[cc]) continue;
        const di = (cc % N) - i, dj = ((cc / N) | 0) - j;
        const d = di * di + dj * dj;
        if (d < bd) { bd = d; best = cc; }
      }
      this.near[c] = best;
    }

    this.capacity = this.area * RIM_H;
    this.vol = 0;            // liquid volume (same units as capacity)
    this.ice = [];           // floating cubes
    this.foam = 0;           // foam head height (radii)
    this.foamTarget = 0;
    this.lid = 0;            // seconds of lid left: nothing can spill
    this.spilled = 0;        // total volume lost over the rim
    this.spills = [];        // recent overflow events for the renderer {ang, dv}
    this.t = 0;
    this.gv = 9.81;
  }

  // ---------- volume ----------
  get fill() { return this.vol / this.capacity; }
  set fill(f) { this.vol = Math.max(0, f) * this.capacity; }
  displaced() {
    let d = 0;
    for (const c of this.ice) if (c.state !== "fall") d += 0.86 * c.s * c.s * c.s;
    return d;
  }
  // mean surface height above the glass floor
  get level() { return (this.vol + this.displaced()) / this.area; }

  addVolume(dv) {
    this.vol = Math.max(0, this.vol + dv);
  }

  reset(fill = 0) {
    this.eta.fill(0); this.u.fill(0); this.w.fill(0);
    this.ice.length = 0;
    this.foam = this.foamTarget = 0;
    this.lid = 0;
    this.spilled = 0;
    this.spills.length = 0;
    this.fill = fill;
  }

  // ---------- disturbances ----------
  // Gaussian bump (amp > 0) or crater (amp < 0) at (x, z); volume-neutral.
  impulse(x, z, amp, rad = 0.28) {
    const { N, dx, eta, mask } = this;
    const r2 = rad * rad;
    for (let j = 0; j < N; j++) {
      const zz = -1 + (j + 0.5) * dx - z;
      for (let i = 0; i < N; i++) {
        const c = j * N + i;
        if (!mask[c]) continue;
        const xx = -1 + (i + 0.5) * dx - x;
        const d2 = xx * xx + zz * zz;
        if (d2 < r2 * 6) eta[c] += amp * Math.exp(-d2 / r2);
      }
    }
    this.recenter();
  }

  // A shove of the whole body of liquid (sideways velocity kick).
  kick(vx, vz) {
    const { u, w, uOpen, wOpen } = this;
    for (let k = 0; k < u.length; k++) if (uOpen[k]) u[k] += vx;
    for (let k = 0; k < w.length; k++) if (wOpen[k]) w[k] += vz;
  }

  dropIce(x, z, s = 0.58, rot = 0) {
    if (this.ice.length >= 5) return null;
    const cube = { x, z, vx: 0, vz: 0, s, y: RIM_H + 1.6, vy: 0, rot, vr: (rot % 1 - 0.5) * 1.6, state: "fall", bob: rot * 4, age: 0 };
    this.ice.push(cube);
    return cube;
  }

  recenter() {
    const { eta, mask, cells } = this;
    let s = 0;
    for (let c = 0; c < eta.length; c++) if (mask[c]) s += eta[c];
    const m = s / cells;
    if (Math.abs(m) < 1e-7) return;
    for (let c = 0; c < eta.length; c++) if (mask[c]) eta[c] -= m;
  }

  // ---------- simulation ----------
  step(dt, gx, gz, gv) {
    const { N, dx, eta, u, w, uOpen, wOpen, mask } = this;
    gv = Math.min(30, Math.max(2.5, gv));
    this.gv = gv;
    this.t += dt;
    const keep = Math.max(0, 1 - this.damp * dt);
    const k = (dt * gv) / dx;
    // momentum
    for (let j = 0; j < N; j++) {
      const row = j * (N + 1);
      const crow = j * N;
      for (let i = 1; i < N; i++) {
        const f = row + i;
        if (!uOpen[f]) continue;
        u[f] = (u[f] - k * (eta[crow + i] - eta[crow + i - 1]) + dt * gx) * keep;
      }
    }
    for (let j = 1; j < N; j++) {
      const row = j * N;
      for (let i = 0; i < N; i++) {
        const f = row + i;
        if (!wOpen[f]) continue;
        w[f] = (w[f] - k * (eta[row + i] - eta[row - N + i]) + dt * gz) * keep;
      }
    }
    // continuity (flux form: conserves volume exactly with closed walls)
    const H = this.depth;
    const kc = (dt * H) / dx;
    const lvl = this.level;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = j * N + i;
        if (!mask[c]) continue;
        const div = u[j * (N + 1) + i + 1] - u[j * (N + 1) + i] + w[(j + 1) * N + i] - w[j * N + i];
        eta[c] -= kc * div;
        if (eta[c] < -lvl + 0.02) eta[c] = -lvl + 0.02; // never below the glass floor
      }
    }
    // gentle smoothing of the surface (mass-conserving Laplacian over open faces)
    const a = this.diffuse;
    if (a > 0) {
      const tmp = this.tmp;
      tmp.set(eta);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const c = j * N + i;
          if (!mask[c]) continue;
          let s = 0;
          if (uOpen[j * (N + 1) + i]) s += tmp[c - 1] - tmp[c];
          if (uOpen[j * (N + 1) + i + 1]) s += tmp[c + 1] - tmp[c];
          if (wOpen[j * N + i]) s += tmp[c - N] - tmp[c];
          if (wOpen[(j + 1) * N + i]) s += tmp[c + N] - tmp[c];
          eta[c] += a * s;
        }
      }
    }
    this.stepFoam(dt);
    this.stepIce(dt, gx, gz);
    this.overflow(dt);
    if (this.lid > 0) this.lid = Math.max(0, this.lid - dt);
  }

  stepFoam(dt) {
    // foam rises fast toward its target and the target decays
    const r = this.foamTarget > this.foam ? 3.2 : 0.9;
    this.foam += (this.foamTarget - this.foam) * Math.min(1, r * dt);
    this.foamTarget *= Math.exp(-dt / 2.6);
    if (this.foam < 0.002 && this.foamTarget < 0.002) this.foam = this.foamTarget = 0;
  }

  stepIce(dt, gx, gz) {
    const ice = this.ice;
    if (!ice.length) return;
    const lvl = this.level;
    for (const c of ice) {
      c.age += dt;
      c.rot += c.vr * dt;
      c.vr *= Math.exp(-1.4 * dt);
      if (c.state === "fall") {
        c.vy -= 16 * dt;
        c.y += c.vy * dt;
        const surf = lvl + this.heightAt(c.x, c.z);
        if (c.y - 0.5 * c.s <= surf) {
          // c.y is the cube's centre; it plunges in, then bobs back up
          c.state = "float";
          c.y = surf - 0.5 * c.s;
          // the plop: a crater, a ring of waves, and a splash that flies out of the
          // glass if the drink is near the rim
          const hit = Math.min(1.8, -c.vy * 0.11) * c.s;
          this.impulse(c.x, c.z, -hit * 0.9, 0.24 + c.s * 0.25);
          c.splash = 1;
          c.vy = c.vy * 0.15;
          const near = Math.min(1, Math.max(0, (lvl - (RIM_H - 0.55)) / 0.55));
          const out = this.lid > 0 ? 0 : 0.028 * this.capacity * Math.pow(c.s / 0.58, 3) * near * near;
          if (out > 0) {
            const take = Math.min(out, this.vol);
            this.vol -= take;
            this.spilled += take;
            this.spills.push({ ang: Math.atan2(c.z, c.x), dv: take, splash: true, x: c.x, z: c.z });
          }
        }
        continue;
      }
      // float: bob around the local surface, drift with the drink
      const surf = lvl + this.heightAt(c.x, c.z);
      const target = surf - 0.36 * c.s + Math.sin(this.t * 2.4 + c.bob) * 0.015;
      c.vy += ((target - c.y) * 60 - c.vy * 7) * dt;
      c.y += c.vy * dt;
      const [fu, fw] = this.velAt(c.x, c.z);
      c.vx += ((fu * 0.9 - c.vx) * 3.2 + gx * 0.02) * dt;
      c.vz += ((fw * 0.9 - c.vz) * 3.2 + gz * 0.02) * dt;
      c.x += c.vx * dt;
      c.z += c.vz * dt;
      const lim = 1 - c.s * 0.62;
      const r = Math.hypot(c.x, c.z);
      if (r > lim) {
        const nx = c.x / r, nz = c.z / r;
        c.x = nx * lim; c.z = nz * lim;
        const vn = c.vx * nx + c.vz * nz;
        if (vn > 0) { c.vx -= 1.6 * vn * nx; c.vz -= 1.6 * vn * nz; c.vr += vn * 2 * (Math.random() - 0.5); }
      }
    }
    // cubes shove each other apart
    for (let a = 0; a < ice.length; a++) {
      for (let b = a + 1; b < ice.length; b++) {
        const A = ice[a], B = ice[b];
        if (A.state === "fall" || B.state === "fall") continue;
        const dx = B.x - A.x, dz = B.z - A.z;
        const d = Math.hypot(dx, dz) || 1e-4;
        const min = (A.s + B.s) * 0.62;
        if (d < min) {
          const push = (min - d) / 2;
          const nx = dx / d, nz = dz / d;
          A.x -= nx * push; A.z -= nz * push;
          B.x += nx * push; B.z += nz * push;
        }
      }
    }
  }

  overflow(dt) {
    const rim = RIM_H;
    const lvl = this.level;
    const foamH = this.foam;
    const { eta, walls, dx } = this;
    const cellA = dx * dx;
    let lost = 0;
    for (const wc of walls) {
      const s = lvl + eta[wc.c];
      // foam is mostly air: it spills when it crests the rim, but carries little drink
      const e = s - rim;
      const ef = s + foamH - rim;
      let dv = 0;
      if (e > 0) dv += this.weir * Math.pow(e, 1.5) * Math.sqrt(this.gv) * this.wallLen * dt;
      if (ef > 0 && foamH > 0) dv += 0.22 * this.weir * Math.pow(Math.min(ef, foamH), 1.5) * Math.sqrt(this.gv) * this.wallLen * dt;
      if (dv <= 0) continue;
      if (this.lid > 0) continue;
      dv = Math.min(dv, Math.max(0, e) * cellA * 0.8 + (ef > 0 ? 0.004 * dt * 60 : 0));
      if (dv <= 0) continue;
      eta[wc.c] -= dv / cellA;
      lost += dv;
      this.spills.push({ ang: wc.ang, dv, foam: e <= 0 });
    }
    if (lost > 0) {
      const take = Math.min(lost, this.vol);
      this.vol -= take;
      this.spilled += take;
      this.recenter();
    }
    if (this.spills.length > 120) this.spills.splice(0, this.spills.length - 120);
    return lost;
  }

  // ---------- sampling ----------
  // Bilinear sample of the surface height (relative to the mean level). Cells outside
  // the disc read their nearest inside cell, so sampling right at the rim is safe.
  heightAt(x, z) {
    const { N, dx, eta, near } = this;
    const fx = Math.min(N - 1.0001, Math.max(0, (x + 1) / dx - 0.5));
    const fz = Math.min(N - 1.0001, Math.max(0, (z + 1) / dx - 0.5));
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const c = j * N + i;
    const h00 = eta[near[c]];
    const h10 = eta[near[c + 1]];
    const h01 = eta[near[c + N]];
    const h11 = eta[near[c + N + 1]];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }
  velAt(x, z) {
    const { N, dx, u, w } = this;
    let i = Math.floor((x + 1) / dx), j = Math.floor((z + 1) / dx);
    i = Math.min(N - 1, Math.max(0, i));
    j = Math.min(N - 1, Math.max(0, j));
    const uc = 0.5 * (u[j * (N + 1) + i] + u[j * (N + 1) + i + 1]);
    const wc = 0.5 * (w[j * N + i] + w[(j + 1) * N + i]);
    return [uc, wc];
  }
  // how close the highest point at the wall is to the rim (>0 means spilling)
  wallPeak() {
    const lvl = this.level;
    let m = -1e9;
    for (const wc of this.walls) { const s = lvl + this.eta[wc.c]; if (s > m) m = s; }
    return m - RIM_H;
  }
  energy() {
    let e = 0;
    for (let c = 0; c < this.eta.length; c++) if (this.mask[c]) e += this.eta[c] * this.eta[c];
    return e / this.cells;
  }
}
