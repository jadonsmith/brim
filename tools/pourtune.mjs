// How long a tipped glass takes to empty at different tip angles.
import { pourState } from "../public/js/glass.js";
const K = Number(process.argv[2] || 2.2);
for (const deg of [30, 45, 60, 75, 90, 110, 140]) {
  let fill = 0.95, t = 0, first = null;
  const ang = (deg * Math.PI) / 180;
  while (fill > 0.02 && t < 30) {
    const s = pourState(ang, fill);
    const q = s.over > 0 ? K * Math.pow(s.over, 1.5) + (deg > 100 ? 0.25 : 0) : 0;
    if (q > 0 && first === null) first = t;
    fill -= q * (1 / 60);
    t += 1 / 60;
  }
  console.log(`${String(deg).padStart(3)}°  starts ${first === null ? "never" : first.toFixed(2) + "s"}  -> ${(fill * 100).toFixed(0)}% left after ${t.toFixed(1)}s`);
}
