/**
 * Workflow event types. Every event is a plain, JSON-serializable object:
 *   { seq, type, at, taskId, payload }
 * `seq` increases by one per event within an engine, so consumers (the city, the app, a future
 * integration reading a stream) can order and de-duplicate them.
 */
export const EVENT_TYPES = Object.freeze([
  'task_created',
  'stage_changed',
  'agent_assigned',
  'agent_started',
  'agent_waiting',
  'agent_blocked',
  'agent_idle',
  'agent_progress',
  'handoff_started',
  'handoff_completed',
  'qa_passed',
  'qa_failed',
  'task_completed',
  'task_failed',
]);

/** A minimal synchronous emitter: listeners run in subscription order; a throwing listener can't break the engine. */
export function createEmitter() {
  const listeners = new Set();
  return {
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(event) {
      for (const fn of listeners) {
        try { fn(event); } catch (e) { console.error('[atlas workflow] listener failed:', e); }
      }
    },
  };
}
