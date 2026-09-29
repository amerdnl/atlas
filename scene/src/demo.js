// 40s loop: idle 0-6s, 1 agent 6-10s, subagents ramp to 6 by 22s, hold, wind down at 34s.
export function demoStats(tSec) {
  const p = tSec % 40;
  const working = p >= 6 && p < 34 ? 1 : 0;
  const subagents = p < 10 || p >= 32 ? 0 : Math.min(6, 1 + Math.floor((p - 10) / 2));
  return {
    source: 'demo', working, subagents, projects: working, keys: working ? ['demo'] : [],
    tokensToday: 215_399_164 + Math.floor(tSec * 5200),
    tokensPerMin: working ? 42_000 + subagents * 29_000 : 0, updatedAt: Date.now(),
  };
}
