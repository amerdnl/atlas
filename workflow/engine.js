import { ROLE_IDS } from './roles.js';
import { canTransition, forwardStage, isTerminal, ownerOf } from './stages.js';
import { canChangeStatus, createAgent } from './agents.js';
import { createEmitter } from './events.js';

export class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

/** A history record is a handoff when work moves from one role to a different role. */
export const isHandoff = (r) => Boolean(r.fromRole && r.toRole && r.fromRole !== r.toRole);

const clone = (o) => structuredClone(o);
const text = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * The in-memory ATLAS workflow engine: tasks, one agent per role, the SDLC transitions between
 * them, and the events that describe every change. Deterministic given `now`; no I/O.
 *
 * Every command validates before it mutates, so a rejected command (a WorkflowError) leaves state
 * untouched. Events produced by a command are emitted only after it has fully succeeded, in order,
 * with a monotonically increasing `seq`. Callers get snapshots (copies), never live state.
 *
 * An agent holds at most one task. Work handed to a busy role waits and is picked up first-in,
 * first-out when that role's agent frees up — so `handoff_started` (work sent) and
 * `handoff_completed` (work picked up) coincide when the receiver is free and not otherwise.
 */
export function createWorkflow({ now = () => Date.now(), maxQaAttempts = 3 } = {}) {
  if (!Number.isInteger(maxQaAttempts) || maxQaAttempts < 1) throw new WorkflowError('invalid_input', 'maxQaAttempts must be a positive integer');
  const emitter = createEmitter();
  const tasks = new Map();
  const start = now();
  const agents = new Map(ROLE_IDS.map((role) => [role, createAgent(role, start)]));
  const queueOrder = new Map(); // taskId → order it joined its current owner's queue
  const openHandoff = new Map(); // taskId → handoff record not yet picked up
  let seq = 0, taskCount = 0, queueCount = 0;

  // One delivery queue: if a listener issues a command while events are being delivered, its events
  // are delivered after the current ones, so delivery order always equals `seq` order.
  const outbox = [];
  let delivering = false;
  function deliver() {
    if (delivering) return;
    delivering = true;
    try { while (outbox.length) emitter.emit(outbox.shift()); } finally { delivering = false; }
  }

  function command(fn) {
    return (...args) => {
      const at = now();
      const out = [];
      const emit = (type, taskId, payload) => out.push({ type, taskId, payload });
      const result = clone(fn({ at, emit }, ...args));
      for (const e of out) outbox.push({ seq: ++seq, type: e.type, at, taskId: e.taskId, payload: e.payload });
      deliver();
      return result;
    };
  }

  // ---- guards (throw before any mutation) ----
  function taskOf(id) {
    const task = tasks.get(id);
    if (!task) throw new WorkflowError('unknown_task', `unknown task: ${id}`);
    return task;
  }
  function openTask(id) {
    const task = taskOf(id);
    if (isTerminal(task.stage)) throw new WorkflowError('task_closed', `task ${id} is ${task.stage}`);
    return task;
  }
  function inStage(task, stage) {
    if (task.stage !== stage) throw new WorkflowError('wrong_stage', `task ${task.id} is in ${task.stage}, not ${stage}`);
  }
  function holder(task) {
    const agent = task.assignee ? agents.get(task.assignee) : null;
    if (!agent) throw new WorkflowError('not_assigned', `task ${task.id} is waiting for the ${task.owner} agent`);
    return agent;
  }
  function working(task) {
    const agent = holder(task);
    if (agent.status !== 'working') throw new WorkflowError('agent_not_working', `${agent.id} is ${agent.status}, not working`);
    return agent;
  }
  function statusChange(agent, to) {
    if (!canChangeStatus(agent.status, to)) throw new WorkflowError('invalid_agent_status', `${agent.id} cannot go from ${agent.status} to ${to}`);
  }
  function required(value, what) {
    if (!text(value)) throw new WorkflowError('invalid_input', `${what} is required`);
  }

  // ---- state changes ----
  function setAgent(agent, at, patch) {
    if (patch.status && patch.status !== agent.status) agent.since = at;
    Object.assign(agent, patch, { updatedAt: at });
  }

  function release(agent, { at, emit }) {
    const releasedTaskId = agent.taskId;
    setAgent(agent, at, { status: 'idle', taskId: null, action: null, error: null });
    emit('agent_idle', releasedTaskId, { agent: clone(agent), releasedTaskId });
  }

  /** If `role`'s agent is idle, hand it the oldest task waiting for that role. */
  function pickUp(role, { at, emit }) {
    if (!role) return;
    const agent = agents.get(role);
    if (agent.status !== 'idle') return;
    let next = null;
    for (const t of tasks.values()) {
      if (t.owner === role && !t.assignee && !isTerminal(t.stage) && (!next || queueOrder.get(t.id) < queueOrder.get(next.id))) next = t;
    }
    if (!next) return;
    next.assignee = agent.id;
    next.status = 'in_progress';
    next.updatedAt = at;
    queueOrder.delete(next.id);
    setAgent(agent, at, { status: 'assigned', taskId: next.id, action: null, error: null });
    emit('agent_assigned', next.id, { agent: clone(agent) });
    const handoff = openHandoff.get(next.id);
    if (handoff) {
      openHandoff.delete(next.id);
      emit('handoff_completed', next.id, { handoff: clone(handoff) });
    }
  }

  function transition(task, to, ctx, { reason = null, meta = null } = {}) {
    if (!canTransition(task.stage, to)) throw new WorkflowError('invalid_transition', `${task.stage} → ${to} is not allowed`);
    const { at, emit } = ctx;
    const from = task.stage, fromRole = ownerOf(from), toRole = ownerOf(to);
    const record = { id: `${task.id}#${task.history.length + 1}`, taskId: task.id, fromRole, toRole, fromStage: from, toStage: to, at, reason, meta };
    const previous = task.assignee ? agents.get(task.assignee) : null;

    task.history.push(record);
    Object.assign(task, { stage: to, owner: toRole, assignee: null, stageEnteredAt: at, updatedAt: at });
    task.status = isTerminal(to) ? to : 'queued';
    if (!isTerminal(to)) queueOrder.set(task.id, ++queueCount);
    else queueOrder.delete(task.id);
    openHandoff.delete(task.id);

    emit('stage_changed', task.id, { from, to, owner: toRole, attempt: task.attempt });
    if (previous) release(previous, ctx);
    if (isHandoff(record)) {
      openHandoff.set(task.id, record);
      emit('handoff_started', task.id, { handoff: clone(record) });
    }
    if (to === 'completed') emit('task_completed', task.id, { attempts: task.attempt, qaCycles: task.qaResults.length });
    if (to === 'failed') emit('task_failed', task.id, { reason, stage: from });
    pickUp(toRole, ctx); // the receiver first, for continuity of this task…
    if (previous && previous.role !== toRole) pickUp(previous.role, ctx); // …then the freed agent's own queue
  }

  // ---- commands ----
  const createTask = command((ctx, { id, title, description = '', acceptanceCriteria = [] } = {}) => {
    required(title, 'title');
    if (typeof description !== 'string') throw new WorkflowError('invalid_input', 'description must be a string');
    if (!Array.isArray(acceptanceCriteria) || !acceptanceCriteria.every(text)) throw new WorkflowError('invalid_input', 'acceptanceCriteria must be non-empty strings');
    let taskId = id;
    if (taskId === undefined) {
      let n = taskCount + 1;
      while (tasks.has(`task-${n}`)) n++;
      taskId = `task-${n}`;
    }
    required(taskId, 'id');
    if (tasks.has(taskId)) throw new WorkflowError('duplicate_task', `task ${taskId} already exists`);
    taskCount++;
    const { at, emit } = ctx;
    const task = {
      id: taskId, title: title.trim(), description, acceptanceCriteria: [...acceptanceCriteria],
      status: 'queued', stage: 'planning', owner: ownerOf('planning'), assignee: null,
      attempt: 1, qaResults: [], failure: null, history: [],
      createdAt: at, updatedAt: at, stageEnteredAt: at,
    };
    tasks.set(taskId, task);
    queueOrder.set(taskId, ++queueCount);
    emit('task_created', taskId, { task: clone(task) });
    pickUp(task.owner, ctx);
    return task;
  });

  /** The owner's agent starts (or resumes, from waiting/blocked) work on its current stage. */
  const startWork = command((ctx, taskId, { action = null } = {}) => {
    const task = openTask(taskId);
    const agent = holder(task);
    statusChange(agent, 'working');
    const resumedFrom = agent.status;
    setAgent(agent, ctx.at, { status: 'working', action, error: null });
    task.updatedAt = ctx.at;
    ctx.emit('agent_started', taskId, { agent: clone(agent), resumedFrom });
    return task;
  });

  const wait = command((ctx, taskId, { reason } = {}) => {
    required(reason, 'reason');
    const task = openTask(taskId);
    const agent = holder(task);
    statusChange(agent, 'waiting');
    setAgent(agent, ctx.at, { status: 'waiting', action: reason });
    task.updatedAt = ctx.at;
    ctx.emit('agent_waiting', taskId, { agent: clone(agent), reason });
    return task;
  });

  const block = command((ctx, taskId, { reason } = {}) => {
    required(reason, 'reason');
    const task = openTask(taskId);
    const agent = holder(task);
    statusChange(agent, 'blocked');
    setAgent(agent, ctx.at, { status: 'blocked', error: { message: reason, at: ctx.at } });
    task.updatedAt = ctx.at;
    ctx.emit('agent_blocked', taskId, { agent: clone(agent), reason });
    return task;
  });

  /** The owner finishes its stage and the task moves one step forward (testing uses qaPass/qaFail). */
  const completeStage = command((ctx, taskId, { reason = null, meta = null } = {}) => {
    const task = openTask(taskId);
    const to = forwardStage(task.stage);
    if (!to) throw new WorkflowError('wrong_stage', `${task.stage} ends with a QA verdict (qaPass / qaFail), not completeStage`);
    working(task);
    transition(task, to, ctx, { reason, meta });
    return task;
  });

  const qaPass = command((ctx, taskId, { notes = null, meta = null } = {}) => {
    const task = openTask(taskId);
    inStage(task, 'testing');
    working(task);
    task.qaResults.push({ attempt: task.attempt, passed: true, reason: notes, at: ctx.at });
    ctx.emit('qa_passed', taskId, { attempt: task.attempt, notes });
    transition(task, 'finalizing', ctx, { reason: notes, meta });
    return task;
  });

  /** QA rejects the attempt: back to the developer as rework, or failed once attempts run out. */
  const qaFail = command((ctx, taskId, { reason, meta = null } = {}) => {
    required(reason, 'reason');
    const task = openTask(taskId);
    inStage(task, 'testing');
    working(task);
    task.qaResults.push({ attempt: task.attempt, passed: false, reason, at: ctx.at });
    const failures = task.qaResults.filter((r) => !r.passed).length;
    ctx.emit('qa_failed', taskId, { attempt: task.attempt, reason, failures, maxQaAttempts });
    if (failures >= maxQaAttempts) {
      const why = `QA failed ${failures} time${failures === 1 ? '' : 's'} (limit ${maxQaAttempts}): ${reason}`;
      task.failure = { reason: why, stage: 'testing', at: ctx.at };
      transition(task, 'failed', ctx, { reason: why, meta });
    } else {
      task.attempt += 1;
      transition(task, 'rework', ctx, { reason, meta });
    }
    return task;
  });

  /** The working agent reports what it is doing right now (short text); status and stage are unchanged. */
  const reportProgress = command((ctx, taskId, { action } = {}) => {
    required(action, 'action');
    const task = openTask(taskId);
    const agent = working(task);
    setAgent(agent, ctx.at, { action });
    ctx.emit('agent_progress', taskId, { agent: clone(agent) });
    return task;
  });

  /** Explicit abort from any open stage (e.g. Operations cancels, or a stage can't be completed). */
  const failTask = command((ctx, taskId, { reason, meta = null } = {}) => {
    required(reason, 'reason');
    const task = openTask(taskId);
    task.failure = { reason, stage: task.stage, at: ctx.at };
    transition(task, 'failed', ctx, { reason, meta });
    return task;
  });

  return {
    createTask, startWork, wait, block, reportProgress, completeStage, qaPass, qaFail, failTask,
    /** Subscribe to events; returns an unsubscribe function. */
    on: (fn) => emitter.on(fn),
    getTask: (id) => clone(taskOf(id)),
    listTasks: () => [...tasks.values()].map(clone),
    getAgent(id) {
      const agent = agents.get(id);
      if (!agent) throw new WorkflowError('unknown_agent', `unknown agent: ${id}`);
      return clone(agent);
    },
    listAgents: () => [...agents.values()].map(clone),
    handoffs: (taskId) => clone(taskOf(taskId).history.filter(isHandoff)),
    /** Full state plus the last event seq, so a late subscriber can sync, then apply events with a higher seq. */
    snapshot: () => ({ seq, tasks: [...tasks.values()].map(clone), agents: [...agents.values()].map(clone) }),
  };
}
