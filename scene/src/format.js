/** A whole number with thousands separators, never abbreviated: 984 · 12,430 · 174,900,000. */
export const formatInt = (n) => Math.round(Math.max(0, Number(n) || 0)).toLocaleString('en-US');

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
  return { projects: String(Math.round(v.projects)), agents: String(Math.round(v.agents)), tokens: formatInt(v.tokens) };
}
