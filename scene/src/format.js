export const formatInt = (n) => Math.round(n).toLocaleString('en-US');

const UNITS = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * 984 · 12.4K · 128.4K · 1.2M — one decimal above 1000, so the width doesn't jitter while easing.
 * The unit is chosen by the value; if rounding would show 1000 of it (999,950 → "1000.0K") the
 * next unit up is used instead ("1.0M").
 */
export function formatCompact(n) {
  const v = Math.max(0, n || 0);
  for (let i = 0; i < UNITS.length; i++) {
    const [unit, suffix] = UNITS[i];
    if (v < unit) continue;
    const scaled = round1(v / unit);
    if (scaled >= 1000 && i > 0) return `${round1(v / UNITS[i - 1][0]).toFixed(1)}${UNITS[i - 1][1]}`;
    return `${scaled.toFixed(1)}${suffix}`;
  }
  const whole = Math.round(v);
  return whole >= 1000 ? '1.0K' : String(whole);
}

/**
 * The HUD's three numbers from collector Stats (existing semantics: agents = working agents plus
 * subagents; tokens = tokens used today), or null while the collector is offline.
 */
export function hudValues(s) {
  if (!s) return null;
  return { projects: s.projects || 0, agents: (s.working || 0) + (s.subagents || 0), tokens: s.tokensToday || 0 };
}

/** Display strings for the HUD values ("—" while offline). */
export function formatHud(v) {
  if (!v) return { projects: '—', agents: '—', tokens: '—' };
  return { projects: String(Math.round(v.projects)), agents: String(Math.round(v.agents)), tokens: formatCompact(v.tokens) };
}
