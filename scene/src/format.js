export const formatInt = (n) => Math.round(n).toLocaleString('en-US');

/** Overlay strings for a Stats object, or placeholders when the collector is offline. */
export function formatStats(s) {
  if (!s) return { projects: '—', agents: '—', agentsSub: 'offline', tokens: '—', rate: '' };
  const working = s.working || 0, sub = s.subagents || 0;
  let agentsSub = 'idle';
  if (working + sub > 0) {
    const verb = s.source === 'demo' ? 'demo working' : 'working';
    agentsSub = sub > 0 ? `${sub} subagent${sub === 1 ? '' : 's'} · ${verb}` : verb;
  }
  const r = s.tokensPerMin || 0;
  const rate = r <= 0 ? '' : r >= 1000 ? `${Math.round(r / 1000)}k / min` : `${Math.round(r)} / min`;
  return { projects: String(s.projects || 0), agents: String(working + sub), agentsSub, tokens: formatInt(s.tokensToday || 0), rate };
}
