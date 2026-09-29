/**
 * Workflow stages, who owns each, and the only transitions allowed between them. This table is the
 * source of truth for the SDLC — nothing infers the workflow from visuals or logs.
 *
 *   planning → research → development → testing ─pass→ finalizing → completed
 *                                         │  ↑
 *                                    fail ↓  │
 *                                         rework
 *   any active stage → failed (explicit abort, or QA attempts exhausted)
 *
 * `rework` returns straight to `testing`: it has the same owner as `development`, so an extra
 * rework → development hop would be a Developer→Developer "handoff" that hands nothing off.
 * `finalizing` makes Operations' closing step (QA → Operations → Done) an owned, observable stage.
 */
export const STAGES = Object.freeze(['planning', 'research', 'development', 'testing', 'rework', 'finalizing', 'completed', 'failed']);

export const STAGE_OWNER = Object.freeze({
  planning: 'operations',
  research: 'research',
  development: 'developer',
  testing: 'qa',
  rework: 'developer',
  finalizing: 'operations',
  completed: null,
  failed: null,
});

const NEXT = Object.freeze({
  planning: ['research', 'failed'],
  research: ['development', 'failed'],
  development: ['testing', 'failed'],
  testing: ['finalizing', 'rework', 'failed'],
  rework: ['testing', 'failed'],
  finalizing: ['completed', 'failed'],
  completed: [],
  failed: [],
});

/** The single forward step a stage takes when its owner finishes (testing has two outcomes, so none). */
const FORWARD = Object.freeze({ planning: 'research', research: 'development', development: 'testing', rework: 'testing', finalizing: 'completed' });

export const isStage = (s) => STAGES.includes(s);
export const isTerminal = (s) => s === 'completed' || s === 'failed';
export const allowedNext = (s) => NEXT[s] ?? [];
export const canTransition = (from, to) => allowedNext(from).includes(to);
export const forwardStage = (s) => FORWARD[s] ?? null;
export const ownerOf = (s) => STAGE_OWNER[s] ?? null;
