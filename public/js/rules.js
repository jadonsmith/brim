// Rules shared by the server and every client (no DOM in here).

export const V0_ML = 330;            // the first glass holds a can's worth
export const LEAK_PER_S = 0.0025;    // every glass has a hairline crack: 0.25% of the leg's start per second

// Liquid simulation constants (see liquid.js)
export const LIQUID = { N: 22, depth: 2.0, damp: 0.85, diffuse: 0.012, weir: 2.4 };

// How full each glass starts (freeboard = gap to the rim, in glass radii) and how hard
// motion pushes the drink around (kappa scales the sideways part of gravity).
export const FILLS = {
  generous: { label: "Generous", blurb: "A finger of room at the top", freeboard: 0.2, kappa: 0.62 },
  brim: { label: "Brim", blurb: "Right to the top", freeboard: 0.13, kappa: 0.75 },
  meniscus: { label: "Meniscus", blurb: "Bulging over the rim", freeboard: 0.08, kappa: 0.9 },
};

export const MODES = {
  race: { label: "Race", blurb: "Both teams run at once" },
  turns: { label: "Turns", blurb: "One runner at a time" },
};

export const TEAMS = [
  { id: 0, name: "Sunrise", color: "#ff8a1f", deep: "#d8351a", mid: "#ff7a1a", top: "#ffc94a", glow: "#ffb347" },
  { id: 1, name: "Lagoon", color: "#2fb8ff", deep: "#1235c9", mid: "#1f86ff", top: "#58e6ff", glow: "#5cc8ff" },
];
export const SOLO_DRINK = { id: 2, name: "House pour", color: "#a6e22e", deep: "#2f9c3c", mid: "#7fd32a", top: "#e4ff7a", glow: "#c8f25a" };
export const HECKLER_COLOR = "#c08bff";

// Mischief cards. "hit" cards land on the rival runner, "help" cards on your own.
// cost = team charges spent, cd = team cooldown, dur = how long the effect lasts.
export const CARDS = {
  quake: { name: "Quake", kind: "hit", cost: 2, cd: 12000, dur: 1800, blurb: "Shake the floor" },
  ice: { name: "Ice cube", kind: "hit", cost: 1, cd: 7000, dur: 900, blurb: "Plop. Up goes the level" },
  fizz: { name: "Fizz", kind: "hit", cost: 1, cd: 12000, dur: 4200, blurb: "Foams over the rim" },
  frost: { name: "Frost", kind: "hit", cost: 1, cd: 11000, dur: 6000, blurb: "Ice over their screen" },
  swell: { name: "Swell", kind: "hit", cost: 1, cd: 12000, dur: 5200, blurb: "The floor starts to roll" },
  lid: { name: "Lid", kind: "help", cost: 2, cd: 16000, dur: 3200, blurb: "No spills for 3 s" },
};
export const CARD_ORDER = ["quake", "ice", "fizz", "frost", "swell", "lid"];

export const CHARGE = { teamMs: 5000, teamMax: 3, teamStart: 1, heckMs: 8000, heckMax: 2, heckStart: 1 };
export const TELEGRAPH_MS = 1100;    // a card lands this long after it's played
export const IMMUNE_MS = 2600;       // after one lands, the runner is safe this long

// Base timings in ms (the server scales them for its headless tests)
export const TIMING = {
  intro: 5200,      // match intro: teams and running order
  fill: 2600,       // the bartender pours the first glass
  count: 1900,      // steady... 3, 2, 1 before a run
  ready: 2300,      // after a catch, before the run
  refill: 2400,     // a one-player team pours into a fresh glass by itself
  pourMax: 12000,   // a pour is forced to finish after this
  legMax: 120000,   // a run is ended for you after two minutes
  drop: 20000,      // a vanished runner is replaced after this
  overDelay: 1600,  // last finish -> results
};

export const FILL_TARGET = (fillId) => 1 - (FILLS[fillId] || FILLS.brim).freeboard / 2.3;

export function grade(kept) {
  if (kept >= 0.97) return "Bartender";
  if (kept >= 0.92) return "Smooth";
  if (kept >= 0.84) return "Steady";
  if (kept >= 0.72) return "Sloshy";
  if (kept >= 0.55) return "Sloppy";
  return "Butterfingers";
}

// The glass for a leg is sized so its drink fills it to the start line. Visual
// scale is the cube root of its capacity relative to the first glass.
export function glassScale(capacityMl, fillId) {
  const cap0 = V0_ML / FILL_TARGET(fillId);
  return Math.max(0.42, Math.cbrt(Math.max(1, capacityMl) / cap0));
}
