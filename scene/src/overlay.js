import { formatStats, formatInt } from './format.js';

export function createOverlay(el) {
  const fields = Object.fromEntries([...el.querySelectorAll('[data-k]')].map((n) => [n.dataset.k, n]));
  let target = null, shown = 0;
  return {
    set(stats) {
      target = stats;
      const f = formatStats(stats);
      for (const k of ['projects', 'agents', 'agentsSub', 'rate']) fields[k].textContent = f[k];
      if (!stats) fields.tokens.textContent = f.tokens;
      else if (shown === 0) shown = stats.tokensToday;
    },
    // Tokens count up smoothly toward the latest total.
    tick(dt) {
      if (!target) return;
      const goal = target.tokensToday || 0;
      shown = goal < shown ? goal : shown + (goal - shown) * Math.min(1, dt * 3);
      if (goal - shown < 1) shown = goal;
      fields.tokens.textContent = formatInt(shown);
    },
  };
}
