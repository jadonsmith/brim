// DOM helpers shared by the phone and big-screen views.
import { TEAMS, HECKLER_COLOR, SOLO_DRINK } from "./rules.js";

export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function teamColor(t, solo = false) {
  if (solo) return SOLO_DRINK.color;
  return t === 0 || t === 1 ? TEAMS[t].color : HECKLER_COLOR;
}

export function avatar(p, team = p ? p.team : -1, extra = "") {
  const ch = (p && p.name ? p.name.trim()[0] : "?") || "?";
  return `<span class="av ${extra}" style="--pc:${teamColor(team)}">${esc(ch.toUpperCase())}</span>`;
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  t.style.animation = "none";
  void t.offsetWidth;
  t.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function showScreen(el) {
  const parent = el.parentElement;
  for (const s of parent.children) {
    if (s.classList.contains("screen") || s.classList.contains("tv-screen")) {
      const on = s === el;
      s.classList.toggle("on", on);
      if (s.classList.contains("tv-screen")) s.hidden = !on;
    }
  }
}

export function restartAnim(el, cls) {
  if (!el) return;
  if (cls) el.classList.remove(cls);
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
  if (cls) el.classList.add(cls);
}

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export const fmtMl = (ml) => `${Math.max(0, Math.round(ml))}`;
export const fmtPct = (x) => `${Math.max(0, Math.round(x * 100))}%`;
export function fmtTime(ms) {
  const s = Math.max(0, ms / 1000);
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function joinUrl(code) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  return code ? `${base}?room=${code}` : base;
}

export function qrSvg(text) {
  if (!window.qrcode) return "";
  const q = window.qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const pad = 1;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  const s = n + pad * 2;
  return `<svg viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="img" aria-label="QR code to join"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#120d1d"/></svg>`;
}

export const CARD_COLORS = { quake: "#ff9a3c", ice: "#9fe3ff", fizz: "#ffe27a", frost: "#cfe8ff", swell: "#5cc8ff", lid: "#c3a8ff" };

// A cheer emoji floating up the screen.
export function floatCheer(e, host) {
  if (!host) return;
  const el = document.createElement("span");
  el.className = "cheer-float";
  el.textContent = e;
  el.style.left = `${10 + Math.random() * 80}%`;
  el.style.setProperty("--dx", `${(Math.random() - 0.5) * 60}px`);
  host.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

// 24×24 stroke icons for the mischief cards
export const ICONS = {
  quake: '<path d="M2.5 15.5l3.6-3.8 2.8 3 3.6-6.4 2.9 4.6 3.2-4.4 2.9 3.4"/><path d="M2 20h20"/><path d="M6 4l1.5 2.5M12 2.5V5M18 4l-1.5 2.5" opacity=".6"/>',
  ice: '<path d="M12 3.2l7.8 4.4v8.8L12 20.8l-7.8-4.4V7.6z"/><path d="M12 12l7.8-4.4M12 12v8.8M12 12L4.2 7.6"/><path d="M8 9.6l1.8-1" opacity=".6"/>',
  fizz: '<circle cx="8.2" cy="15.4" r="3.4"/><circle cx="15.6" cy="9.2" r="4"/><circle cx="17.2" cy="18.4" r="2"/><circle cx="7" cy="5.8" r="1.6"/>',
  frost: '<path d="M12 2.5v19M3.8 7.2l16.4 9.6M3.8 16.8L20.2 7.2"/><path d="M9.4 4.2L12 6l2.6-1.8M9.4 19.8L12 18l2.6 1.8"/>',
  swell: '<path d="M2 8.5c2.6-2.2 5.2-2.2 7.6 0s5 2.2 7.6 0c1.6-1.4 3.2-1.8 4.8-1.2"/><path d="M2 15c2.6-2.2 5.2-2.2 7.6 0s5 2.2 7.6 0c1.6-1.4 3.2-1.8 4.8-1.2"/><path d="M5 20.5h14" opacity=".55"/>',
  lid: '<path d="M2.8 13.2h18.4"/><path d="M5 13.2c.4-4 3.4-6.4 7-6.4s6.6 2.4 7 6.4"/><path d="M10.8 4.6h2.4"/><path d="M6.5 17.2h11"/>',
};
export const icon = (id, cls = "ic") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[id] || ""}</svg>`;

// Bursting confetti on a full-screen canvas; returns a stop function.
export function confetti(canvas, colors = ["#ff8a1f", "#ffc94a", "#2fb8ff", "#58e6ff", "#ff6f91", "#fff3d6"]) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let w = 0, h = 0;
  const fit = () => {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  };
  fit();
  const ps = [];
  const spawn = (n) => {
    for (let i = 0; i < n; i++) {
      ps.push({
        x: Math.random() * w, y: -20 - Math.random() * h * 0.5,
        vx: (Math.random() - 0.5) * 120, vy: 110 + Math.random() * 220,
        r: 4 + Math.random() * 6, a: Math.random() * 6, va: (Math.random() - 0.5) * 10,
        c: colors[(Math.random() * colors.length) | 0], drop: Math.random() < 0.35,
      });
    }
  };
  spawn(150);
  let last = performance.now();
  let raf = 0;
  let stopped = false;
  const t0 = last;
  const frame = (now) => {
    if (stopped) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (now - t0 < 2400 && ps.length < 380) spawn(3);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const p of ps) {
      p.vy += 40 * dt;
      p.x += (p.vx + Math.sin(p.a) * 40) * dt;
      p.y += p.vy * dt;
      p.a += p.va * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.fillStyle = p.c;
      if (p.drop) {
        ctx.beginPath();
        ctx.moveTo(0, -p.r * 1.3);
        ctx.quadraticCurveTo(p.r * 0.9, 0, 0, p.r * 0.8);
        ctx.quadraticCurveTo(-p.r * 0.9, 0, 0, -p.r * 1.3);
        ctx.fill();
      } else {
        ctx.rotate(p.a);
        ctx.fillRect(-p.r, -p.r * 0.4, p.r * 2, p.r * 0.8);
      }
      ctx.restore();
    }
    for (let i = ps.length - 1; i >= 0; i--) if (ps[i].y > h + 30) ps.splice(i, 1);
    if (ps.length || now - t0 < 2400) raf = requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, w, h);
  };
  raf = requestAnimationFrame(frame);
  window.addEventListener("resize", fit);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", fit);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
}
