/**
 * Agent status — what a role's agent is doing right now. Deliberately separate from a task's stage:
 * a task can sit in `development` while the developer agent is `assigned`, `working` or `blocked`.
 *
 *   idle         no task
 *   assigned     holds a task, hasn't started it
 *   working      actively working its stage
 *   waiting      paused on something expected (an answer, an external result)
 *   blocked      can't proceed without a human; `error` says why
 *   interrupted  its work stopped because ATLAS itself stopped; waiting for a recovery decision
 *
 * Any status returns to `idle` when the agent's task leaves its ownership (handoff or terminal).
 */
export const AGENT_STATUSES = Object.freeze(['idle', 'assigned', 'working', 'waiting', 'blocked', 'interrupted']);

const NEXT = Object.freeze({
  idle: ['assigned'],
  assigned: ['working', 'idle', 'interrupted'],
  working: ['waiting', 'blocked', 'idle', 'interrupted'],
  waiting: ['working', 'blocked', 'idle', 'interrupted'],
  blocked: ['working', 'idle'],
  interrupted: ['working', 'idle'],
});

export const canChangeStatus = (from, to) => (NEXT[from] ?? []).includes(to);

export function createAgent(role, at, id = role) {
  return { id, role, status: 'idle', taskId: null, action: null, error: null, since: at, updatedAt: at };
}
