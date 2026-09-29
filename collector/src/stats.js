import { scanClaudeActivity, projectKey, encodeCwd } from './agents.js';

/**
 * Merges agent activity from herdr and Claude Code logs, plus token counts, into one Stats object.
 * herdr is authoritative for the sessions it tracks; recently active Claude sessions it doesn't
 * know about (desktop app, plain terminals, other multiplexers) are added on top.
 */
export async function collect({ herdr, claudeRoot, counter, nowMs }) {
  const h = herdr ? await herdr() : null;
  const act = scanClaudeActivity(claudeRoot, nowMs);
  counter.scan();
  const outside = h ? act.active.filter((a) => !h.sessions.has(a.session)) : act.active;
  const rawKeys = [...(h ? h.cwds.map(encodeCwd) : []), ...outside.map((a) => a.key)];
  const keys = [...new Set(rawKeys.map(projectKey))];
  return {
    source: h ? 'herdr+claude' : 'claude',
    working: (h ? h.working : 0) + outside.length,
    subagents: act.subagents,
    projects: keys.length,
    keys,
    tokensToday: counter.total,
    tokensPerMin: counter.perMinute,
    updatedAt: nowMs,
  };
}
