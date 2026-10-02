/**
 * Managed sessions: one backend process ATLAS launched for a specific task, role and stage.
 *
 * Session status is process lifecycle — is the thing running, did it exit, how. It is deliberately
 * separate from the workflow's agent status (idle/assigned/working/waiting/blocked), which says what
 * a role means in the SDLC. The runtime translates between them; the workflow engine never sees a
 * process, and a session never decides a workflow transition on its own.
 *
 *   queued → starting → running ⇄ waiting → completed | failed | cancelled | interrupted
 *
 * `interrupted` means the runtime stopped (shutdown or crash) before the session finished.
 *
 * `waiting` is reserved for backends that can pause (e.g. awaiting input); the Claude print-mode
 * adapter never enters it.
 */
export const SESSION_STATUSES = Object.freeze(['queued', 'starting', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted']);

const NEXT = {
  queued: ['starting', 'failed', 'cancelled', 'interrupted'],
  starting: ['running', 'failed', 'cancelled', 'interrupted'],
  running: ['waiting', 'completed', 'failed', 'cancelled', 'interrupted'],
  waiting: ['running', 'completed', 'failed', 'cancelled', 'interrupted'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export const isFinished = (s) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(s.status);

export function createSession({ id, taskId, role, stage, backend, cwd, handoffId = null, attempt = 1, at }) {
  return {
    id, taskId, role, stage, attempt, backend, backendSessionId: null, pid: null, cwd,
    status: 'queued', startedAt: null, updatedAt: at, completedAt: null,
    exitCode: null, failure: null, result: null, handoffId, costUsd: null,
  };
}

/** Move a session to `to` (validated), merging `patch`; returns a new object. */
export function advanceSession(session, to, at, patch = {}) {
  if (!NEXT[session.status]?.includes(to)) throw new Error(`session ${session.id}: ${session.status} → ${to} is not allowed`);
  const next = { ...session, ...patch, status: to, updatedAt: at };
  if (to === 'starting') next.startedAt = at;
  if (isFinished(next)) next.completedAt = at;
  return next;
}

/**
 * Split Claude activity the generic collector sees into managed (launched by ATLAS, with an explicit
 * role) and unmanaged (everything else — never given a role). Matching is by exact backend session
 * id, which ATLAS assigns before launch; nothing is inferred from paths, timing or text.
 */
export function classifySessions(active, managed) {
  const byBackendId = new Map(managed.filter((m) => m.backendSessionId).map((m) => [m.backendSessionId, m]));
  return active.map((a) => {
    const m = byBackendId.get(a.session);
    return m
      ? { ...a, managed: true, role: m.role, taskId: m.taskId, sessionId: m.id }
      : { ...a, managed: false, role: null, taskId: null, sessionId: null };
  });
}
