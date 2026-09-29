/** 0 when nothing works; 1 agent → 0.45, 2 → 0.65, 4 → 0.85, 6+ → ~1. Subagents count half. */
export function activityLevel({ working = 0, subagents = 0 } = {}) {
  const eff = working + 0.5 * subagents;
  if (eff <= 0) return 0;
  return Math.min(1, 0.45 + 0.2 * Math.log2(Math.max(1, eff)));
}

export const pulseLevel = (tokensPerMin = 0) => Math.max(0, Math.min(1, tokensPerMin / 100_000));

export function districtOf(key, n = 8) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % n;
}

/** Each working project lights up its own district of the city. */
export function districtBoosts(keys = [], n = 8) {
  const b = new Array(n).fill(0);
  for (const k of keys) { const d = districtOf(k, n); b[d] = Math.min(1, b[d] + 0.5); }
  return b;
}

export const easeToward = (cur, target, dt, tau = 1) => target + (cur - target) * Math.exp(-dt / tau);
