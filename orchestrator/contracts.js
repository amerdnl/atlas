/**
 * Structured result contracts for each workflow stage. Each is a JSON Schema handed to the backend
 * (Claude Code validates its final output against it with --json-schema) and re-checked here, so
 * the orchestrator never parses free-form prose to decide what happens next.
 */
const str = { type: 'string' };
const list = { type: 'array', items: { type: 'string' } };

// Any contract may carry these, so a "blocked" result tells the person exactly what is needed.
const blockedInfo = { question: str, suggestedActions: list };

const CONTRACTS = {
  // Operations, planning: turn the request into a precise goal and testable acceptance criteria.
  plan: { statuses: ['complete', 'blocked'], fields: { summary: str, goal: str, acceptanceCriteria: list, notes: list }, required: ['summary', 'goal', 'acceptanceCriteria'] },
  // Research: how to do it, without changing anything.
  research: { statuses: ['complete', 'blocked'], fields: { summary: str, findings: list, relevantFiles: list, decisions: list, risks: list }, required: ['summary', 'findings', 'relevantFiles'] },
  // Developer (development and rework): what changed and how it was checked.
  develop: { statuses: ['complete', 'blocked'], fields: { summary: str, changedFiles: list, testsRun: list, caveats: list }, required: ['summary', 'changedFiles', 'testsRun'] },
  // QA: an evidence-backed verdict.
  qa: { statuses: ['pass', 'fail', 'blocked'], fields: { summary: str, checks: list, evidence: list, failures: list, recommendedRework: list }, required: ['summary', 'checks', 'evidence'] },
  // Operations, finalizing: confirm and summarize the delivery.
  finalize: { statuses: ['complete', 'blocked'], fields: { summary: str, finalChecks: list }, required: ['summary', 'finalChecks'] },
};

const STAGE_CONTRACT = { planning: 'plan', research: 'research', development: 'develop', rework: 'develop', testing: 'qa', finalizing: 'finalize' };

const MAX_ITEMS = 40;
const MAX_TEXT = 2000;

export function contractFor(stage) {
  const key = STAGE_CONTRACT[stage];
  if (!key) throw new Error(`no result contract for stage ${stage}`);
  return key;
}

/** The JSON Schema for a contract (what the backend must return). */
export function schemaFor(key) {
  const c = CONTRACTS[key];
  return {
    type: 'object',
    properties: { status: { type: 'string', enum: c.statuses }, ...c.fields, ...blockedInfo },
    required: ['status', ...c.required],
    additionalProperties: false,
  };
}

const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

/**
 * Validate and normalize a backend's structured result: `{ ok: true, value }` or `{ ok: false, error }`.
 * Strings are trimmed and bounded, lists are string-only and capped, optional lists default to [].
 */
export function normalizeResult(key, raw) {
  const c = CONTRACTS[key];
  if (!c) return { ok: false, error: `unknown contract ${key}` };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'result is not an object' };
  if (!c.statuses.includes(raw.status)) return { ok: false, error: `status must be one of ${c.statuses.join(', ')}` };
  const value = { status: raw.status };
  for (const [name, type] of Object.entries({ ...c.fields, ...blockedInfo })) {
    const v = raw[name];
    if (type === str) {
      if (v !== undefined && typeof v !== 'string') return { ok: false, error: `${name} must be a string` };
      value[name] = clip((v ?? '').trim());
    } else {
      if (v !== undefined && !Array.isArray(v)) return { ok: false, error: `${name} must be a list` };
      value[name] = (v ?? []).filter((x) => typeof x === 'string' && x.trim()).map((x) => clip(x.trim())).slice(0, MAX_ITEMS);
    }
    // A blocked role may not know the stage's usual fields yet: it only needs to say why (summary).
    const mustHave = c.required.includes(name) && (raw.status !== 'blocked' || name === 'summary');
    if (mustHave && type === str && !value[name]) return { ok: false, error: `${name} is required` };
    if (mustHave && type !== str && v === undefined) return { ok: false, error: `${name} is required` };
  }
  if (key === 'qa' && value.status === 'fail' && value.failures.length === 0) return { ok: false, error: 'a failing QA result must list its failures' };
  if (key === 'plan' && value.status === 'complete' && !value.goal) return { ok: false, error: 'goal is required' };
  return { ok: true, value };
}
