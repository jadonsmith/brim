// Synth sound effects (all generated, no samples), vibration, and a big-screen voice.

let ctx = null;
let master = null;
let muted = false;
let noiseBuf = null;

export function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.6;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

export function setMuted(m) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.6;
  if (m && window.speechSynthesis) speechSynthesis.cancel();
}
export const isMuted = () => muted;

function tone(freq, dur, { type = "sine", vol = 0.25, at = 0, slide = 0, attack = 0.005, dest = null } = {}) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(dest || master);
  o.start(t);
  o.stop(t + dur + 0.03);
}

function noise(dur, { vol = 0.2, at = 0, freq = 1200, q = 0.8, type = "bandpass", slide = 0, attack = 0.004 } = {}) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (slide) f.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random());
  src.stop(t + dur + 0.05);
}

export const sfx = {
  tick() { tone(880, 0.07, { type: "triangle", vol: 0.12 }); },
  go() {
    tone(660, 0.1, { type: "triangle", vol: 0.16 });
    tone(990, 0.22, { type: "triangle", vol: 0.16, at: 0.07 });
  },
  splash(k = 1) {
    noise(0.22 + 0.1 * k, { vol: 0.14 + 0.1 * Math.min(1, k), freq: 900, q: 0.7, slide: -500 });
    tone(520 + Math.random() * 200, 0.08, { vol: 0.05, slide: 500, at: 0.02 });
  },
  drip() { tone(1300 + Math.random() * 300, 0.07, { vol: 0.07, slide: -700 }); },
  clink() {
    tone(2650, 0.25, { vol: 0.11 });
    tone(3980, 0.18, { vol: 0.07, at: 0.005 });
    tone(2650 * 1.5, 0.12, { vol: 0.05, at: 0.09 });
  },
  plop() {
    tone(340, 0.16, { vol: 0.2, slide: -210, attack: 0.002 });
    noise(0.2, { vol: 0.1, freq: 700, q: 1.2, at: 0.03 });
  },
  fizz() {
    if (!ctx || muted) return;
    for (let i = 0; i < 14; i++) noise(0.18, { vol: 0.05 + Math.random() * 0.04, freq: 4200 + Math.random() * 3500, q: 3, type: "bandpass", at: i * 0.11 + Math.random() * 0.05 });
    noise(1.6, { vol: 0.06, freq: 6000, q: 0.5, type: "highpass" });
  },
  quake() {
    noise(1.9, { vol: 0.42, freq: 110, q: 0.9, type: "lowpass", attack: 0.12 });
    for (let i = 0; i < 9; i++) tone(70 + Math.random() * 50, 0.14, { type: "sawtooth", vol: 0.07, at: i * 0.18 + Math.random() * 0.06 });
    for (let i = 0; i < 6; i++) tone(2200 + Math.random() * 900, 0.05, { type: "square", vol: 0.025, at: 0.2 + i * 0.25 });
  },
  swell() {
    tone(62, 1.6, { type: "sawtooth", vol: 0.06, slide: 20, attack: 0.5 });
    noise(2.2, { vol: 0.12, freq: 380, q: 0.6, slide: -200, attack: 0.6 });
    tone(330, 0.5, { type: "triangle", vol: 0.03, slide: -90, at: 0.8 });
  },
  frost() {
    for (let i = 0; i < 10; i++) tone(3200 + Math.random() * 2800, 0.09, { type: "triangle", vol: 0.04, at: i * 0.07 });
    noise(0.7, { vol: 0.07, freq: 5000, q: 2, at: 0.05 });
  },
  lid() {
    tone(150, 0.16, { vol: 0.25, slide: -60 });
    noise(0.06, { vol: 0.12, freq: 2500, q: 1.5 });
  },
  warn() {
    tone(988, 0.1, { type: "square", vol: 0.07 });
    tone(740, 0.14, { type: "square", vol: 0.07, at: 0.12 });
  },
  card() {
    noise(0.28, { vol: 0.12, freq: 900, q: 0.6, slide: 1800 });
    tone(520, 0.14, { type: "triangle", vol: 0.1, slide: 500 });
  },
  denied() { tone(200, 0.12, { type: "square", vol: 0.08 }); },
  win() { [0, 0.08, 0.16].forEach((at, i) => tone([784, 988, 1319][i], 0.18, { type: "triangle", vol: 0.18, at })); },
  fanfare() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.24, { type: "triangle", vol: 0.17, at: i * 0.11 }));
    tone(1047, 0.8, { type: "triangle", vol: 0.15, at: 0.48 });
    tone(1319, 0.8, { type: "sine", vol: 0.08, at: 0.5 });
  },
  sad() {
    tone(392, 0.3, { type: "triangle", vol: 0.12 });
    tone(330, 0.5, { type: "triangle", vol: 0.12, at: 0.22, slide: -40 });
  },
  pop() { tone(600, 0.08, { vol: 0.15, slide: 400 }); },
};

// A continuous glugging pour; call pour(level 0..1) every frame, pour(0) to stop.
let pourNode = null;
export function pour(level) {
  if (!ctx || muted) { if (pourNode) stopPour(); return; }
  if (level <= 0.01) { if (pourNode) stopPour(); return; }
  if (!pourNode) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 520;
    f.Q.value = 2.4;
    const g = ctx.createGain();
    g.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 7.5;
    const lg = ctx.createGain();
    lg.gain.value = 260;
    lfo.connect(lg).connect(f.frequency);
    src.connect(f).connect(g).connect(master);
    src.start();
    lfo.start();
    pourNode = { src, f, g, lfo };
  }
  const t = ctx.currentTime;
  pourNode.g.gain.setTargetAtTime(0.06 + level * 0.22, t, 0.05);
  pourNode.lfo.frequency.setTargetAtTime(5 + level * 5, t, 0.1);
}
function stopPour() {
  const n = pourNode;
  pourNode = null;
  if (!ctx) return;
  try {
    n.g.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    setTimeout(() => { try { n.src.stop(); n.lfo.stop(); } catch {} }, 300);
  } catch {}
}

export function buzz(pattern) {
  if (muted || !navigator.vibrate) return;
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try { navigator.vibrate(pattern); } catch {}
}

// Big-screen announcer. Browsers only speak after the page has had a click.
let voice = null;
function pickVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  voice =
    vs.find((v) => /en[-_](US|GB)/i.test(v.lang) && /Google|Samantha|Daniel|Aria|Guy|Jenny|Serena/i.test(v.name)) ||
    vs.find((v) => /^en/i.test(v.lang)) ||
    null;
}
if (window.speechSynthesis) {
  pickVoice();
  speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
}
export function say(text, { rate = 1.05, pitch = 1 } = {}) {
  if (muted || !window.speechSynthesis) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = rate;
    u.pitch = pitch;
    speechSynthesis.speak(u);
  } catch {}
}
