// The city's own brightness curve, replayed from story.json with the scene's formulas
// (scene/src/activity.js), so ambient light in the room tracks the screens.
import story from '../story.json' with { type: 'json' };
import { FPS, TOTAL } from './timeline';

const level = (w: number, sub: number) => {
  const eff = w + 0.5 * sub;
  return eff <= 0 ? 0 : Math.min(1, 0.45 + 0.2 * Math.log2(Math.max(1, eff)));
};
const at = (t: number) => [...story.stats].reverse().find((k) => k.t <= t)!;

const curve: number[] = [];
let a = 0;
for (let f = 0; f <= TOTAL; f++) {
  const k = at(f / FPS);
  a = level(k.working, k.subagents) + (a - level(k.working, k.subagents)) * Math.exp(-1 / FPS);
  curve.push(a);
}
export const activity = (f: number) => curve[Math.max(0, Math.min(TOTAL, Math.round(f)))];
