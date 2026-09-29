import { formatHud, hudValues } from './format.js';

const TAU = 0.18; // seconds; a change settles in well under a second, without bounce

/**
 * Bottom-left wallpaper HUD: PROJECTS / AGENTS / TOKENS from collector stats. Numbers ease toward
 * new values (exponential, no overshoot) and the DOM is only written when a displayed string changes.
 */
export function createOverlay(el) {
  const fields = Object.fromEntries([...el.querySelectorAll('[data-k]')].map((n) => [n.dataset.k, n]));
  const keys = Object.keys(fields);
  let target = null, shown = null;
  const written = {};

  function render() {
    const text = formatHud(shown);
    for (const k of keys) {
      if (written[k] !== text[k]) { fields[k].textContent = text[k]; written[k] = text[k]; }
    }
  }

  return {
    set(stats) {
      target = hudValues(stats);
      if (!target) shown = null;
      else if (!shown) shown = { ...target }; // first value (or back online): show it, don't count up from zero
      render();
    },
    /** Advances easing; returns true while numbers are still moving. Idle ticks touch nothing. */
    tick(dt) {
      if (!target || !shown) return false;
      let settled = true;
      for (let i = 0; i < keys.length; i++) if (shown[keys[i]] !== target[keys[i]]) settled = false;
      if (settled) return false;
      let moving = false;
      const k = 1 - Math.exp(-dt / TAU);
      for (const key of keys) {
        const goal = target[key];
        let v = shown[key] + (goal - shown[key]) * k;
        if (Math.abs(goal - v) < (key === 'tokens' ? Math.max(1, goal * 0.0005) : 0.02)) v = goal;
        else moving = true;
        shown[key] = v;
      }
      render();
      return moving;
    },
  };
}
