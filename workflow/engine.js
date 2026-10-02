import { ROLE_IDS } from './roles.js';
import { STAGES, canTransition, forwardStage, isTerminal, ownerOf } from './stages.js';
import { AGENT_STATUSES, canChangeStatus, createAgent } from './agents.js';
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

const TASK_STATUSES = ['queued', 'in_progress', 'blocked', 'interrupted', 'completed', 'failed', 'cancelled'];

/** Fields added after Phase 3; restored tasks from older records get these defaults. */
const taskDefaults = () => ({ pause: null, pauses: [], cancellation: null });

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
 *
 * A task can pause without leaving its stage: `blocked` (its role needs a human answer) or
 * `interrupted` (ATLAS stopped while it was running). `task.pause` describes the current pause and
 * `task.pauses` keeps the history; paused tasks are never picked up or continued automatically —
 * only an explicit `resume` (or the agent starting work again) ends the pause.
 *
 * `restore` (a previous `snapshot()`) rebuilds the engine after a restart: tasks, agents, the
 * event `seq`, queue order and handoffs still waiting for their receiver.
 */
export function createWorkflow({ now = () => Date.now(), maxQaAttempts = 3, restore = null } = {}) {
  if (!Number.isInteger(maxQaAttempts) || maxQaAttempts < 1) throw new WorkflowError('invalid_input', 'maxQaAttempts must be a positive integer');
  const emitter = createEmitter();
  const tasks = new Map();
  const start = now();
  const agents = new Map(ROLE_IDS.map((role) => [role, createAgent(role, start)]));
  const queueOrder = new Map(); // taskId → order it joined its current owner's queue
  const openHandoff = new Map(); // taskId → handoff record not yet picked up
  let seq = 0, taskCount = 0, queueCount = 0;
  if (restore) restoreFrom(restore);

  function restoreFrom(snap) {
    const bad = (why) => { throw new WorkflowError('invalid_snapshot', `cannot restore: ${why}`); };
    if (!snap || typeof snap !== 'object') bad('not an object');
    if (!Number.isInteger(snap.seq) || snap.seq < 0) bad('seq must be a non-negative integer');
    if (!Array.isArray(snap.tasks)) bad('tasks must be a list');
    for (const raw of snap.tasks) {
      if (!raw || !text(raw.id) || !text(raw.title) || tasks.has(raw.id)) bad(`task ${raw?.id ?? '?'} is missing or duplicated`);
      if (!STAGES.includes(raw.stage)) bad(`task ${raw.id} has unknown stage ${raw.stage}`);
      if (!TASK_STATUSES.includes(raw.status)) bad(`task ${raw.id} has unknown status ${raw.status}`);
      const task = { ...taskDefaults(), ...structuredClone(raw) };
      if (task.owner !== ownerOf(task.stage)) bad(`task ${raw.id}: owner ${task.owner} does not own ${task.stage}`);
      tasks.set(task.id, task);
    }
    for (const raw of snap.agents ?? []) {
      if (!agents.has(raw?.role) || raw.id !== raw.role || !AGENT_STATUSES.includes(raw.status)) bad(`agent ${raw?.id ?? '?'} is invalid`);
      agents.set(raw.role, { ...createAgent(raw.role, start), ...structuredClone(raw) });
    }
    // Agents and tasks must agree on who holds what; anything inconsistent is released, not guessed.
    for (const agent of agents.values()) {
      const t = agent.taskId ? tasks.get(agent.taskId) : null;
      if (agent.status !== 'idle' && (!t || isTerminal(t.stage) || t.assignee !== agent.id || t.owner !== agent.role)) {
        Object.assign(agent, { status: 'idle', taskId: null, action: null, error: null });
      }
    }
    for (const t of tasks.values()) {
      if (isTerminal(t.stage) || !t.assignee) continue;
      const agent = agents.get(t.assignee);
      if (!agent || agent.taskId !== t.id) { t.assignee = null; if (t.status === 'in_progress') t.status = 'queued'; }
    }
    [...tasks.values()]
      .filter((t) => !isTerminal(t.stage) && !t.assignee)
      .sort((a, b) => a.stageEnteredAt - b.stageEnteredAt || a.createdAt - b.createdAt)
      .forEach((t) => {
        queueOrder.set(t.id, ++queueCount);
        const last = t.history.at(-1);
        if (last && isHandoff(last) && last.toStage === t.stage) openHandoff.set(t.id, last);
      });
    seq = snap.seq;
    taskCount = tasks.size;
  }

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
      if (t.owner === role && t.status === 'queued' && !t.assignee && (!next || queueOrder.get(t.id) < queueOrder.get(next.id))) next = t;
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
    if (isTerminal(to)) closePause(task, at, to);
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
    if (to === 'cancelled') emit('task_cancelled', task.id, { reason, stage: from });
    pickUp(toRole, ctx); // the receiver first, for continuity of this task…
    if (previous && previous.role !== toRole) pickUp(previous.role, ctx); // …then the freed agent's own queue
  }

  /** End the current pause (if any), keeping it in the task's pause history. */
  function closePause(task, at, outcome, extra = {}) {
    if (!task.pause) return;
    task.pauses.push({ ...task.pause, endedAt: at, outcome, ...extra });
    task.pause = null;
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
      attempt: 1, qaResults: [], failure: null, history: [], ...taskDefaults(),
      createdAt: at, updatedAt: at, stageEnteredAt: at,
    };
    tasks.set(taskId, task);
    queueOrder.set(taskId, ++queueCount);
    emit('task_created', taskId, { task: clone(task) });
    pickUp(task.owner, ctx);
    return task;
  });

  /** The owner's agent starts (or resumes, from waiting/blocked/interrupted) work on its current stage. */
  const startWork = command((ctx, taskId, { action = null } = {}) => {
    const task = openTask(taskId);
    const agent = holder(task);
    statusChange(agent, 'working');
    const resumedFrom = agent.status;
    setAgent(agent, ctx.at, { status: 'working', action, error: null });
    if (task.pause) closePause(task, ctx.at, 'resumed', { mode: 'startWork' });
    task.status = 'in_progress';
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

  /**
   * The working agent cannot continue without a human: the task pauses as `blocked` (keeping its
   * stage), with the reason, an optional question and suggested actions for the person.
   */
  const block = command((ctx, taskId, { reason, question = null, suggestedActions = [] } = {}) => {
    required(reason, 'reason');
    if (question !== null && typeof question !== 'string') throw new WorkflowError('invalid_input', 'question must be a string');
    if (!Array.isArray(suggestedActions) || !suggestedActions.every(text)) throw new WorkflowError('invalid_input', 'suggestedActions must be non-empty strings');
    const task = openTask(taskId);
    const agent = holder(task);
    statusChange(agent, 'blocked');
    setAgent(agent, ctx.at, { status: 'blocked', error: { message: reason, at: ctx.at } });
    task.status = 'blocked';
    task.pause = {
      kind: 'blocked', role: agent.role, stage: task.stage, reason, question: question?.trim() || null,
      suggestedActions: [...suggestedActions], response: null, respondedAt: null, at: ctx.at,
    };
    task.updatedAt = ctx.at;
    ctx.emit('agent_blocked', taskId, { agent: clone(agent), reason, pause: clone(task.pause) });
    return task;
  });

  /** A person answers a blocked task's question. The task stays paused until it is resumed. */
  const respond = command((ctx, taskId, { response } = {}) => {
    required(response, 'response');
    const task = openTask(taskId);
    if (task.pause?.kind !== 'blocked') throw new WorkflowError('not_blocked', `task ${taskId} is not waiting for a response`);
    Object.assign(task.pause, { response: response.trim(), respondedAt: ctx.at });
    task.updatedAt = ctx.at;
    ctx.emit('intervention_responded', taskId, { pause: clone(task.pause) });
    return task;
  });

  /**
   * ATLAS stopped while this task was open (shutdown or crash): pause it as `interrupted` so nothing
   * continues until someone decides. The holding agent (if any) shows as interrupted.
   */
  const interrupt = command((ctx, taskId, { reason } = {}) => {
    required(reason, 'reason');
    const task = openTask(taskId);
    if (task.pause) throw new WorkflowError('already_paused', `task ${taskId} is already ${task.pause.kind}`);
    const agent = task.assignee ? agents.get(task.assignee) : null;
    if (agent) statusChange(agent, 'interrupted');
    if (agent) {
      setAgent(agent, ctx.at, { status: 'interrupted', action: null, error: { message: reason, at: ctx.at } });
      ctx.emit('agent_interrupted', taskId, { agent: clone(agent), reason });
    }
    queueOrder.delete(taskId);
    task.status = 'interrupted';
    task.pause = { kind: 'interrupted', role: task.owner, stage: task.stage, reason, at: ctx.at };
    task.updatedAt = ctx.at;
    ctx.emit('task_interrupted', taskId, { reason, stage: task.stage, role: task.owner });
    return task;
  });

  /**
   * A person decides to continue a paused task (`mode` records how: resume or retry). The pause
   * ends; a task whose agent still holds it is ready to start work again, one that was waiting for
   * its role rejoins that role's queue.
   */
  const resume = command((ctx, taskId, { mode = 'resume', note = null } = {}) => {
    const task = openTask(taskId);
    if (!task.pause) throw new WorkflowError('not_paused', `task ${taskId} is not paused`);
    const from = task.pause.kind;
    closePause(task, ctx.at, 'resumed', { mode, note });
    task.status = task.assignee ? 'in_progress' : 'queued';
    if (!task.assignee) queueOrder.set(taskId, ++queueCount);
    task.updatedAt = ctx.at;
    ctx.emit('task_resumed', taskId, { mode, note, from, stage: task.stage });
    if (!task.assignee) pickUp(task.owner, ctx);
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

  /** Explicit abort from any open stage (a stage can't be completed, or a person abandons the task). */
  const failTask = command((ctx, taskId, { reason, meta = null } = {}) => {
    required(reason, 'reason');
    const task = openTask(taskId);
    task.failure = { reason, stage: task.stage, at: ctx.at };
    transition(task, 'failed', ctx, { reason, meta });
    return task;
  });

  /** A person stops the task, from any open stage (running, queued, blocked or interrupted). */
  const cancelTask = command((ctx, taskId, { reason = 'Cancelled by user', meta = null } = {}) => {
    required(reason, 'reason');
    const task = openTask(taskId);
    task.cancellation = { reason, stage: task.stage, at: ctx.at };
    transition(task, 'cancelled', ctx, { reason, meta });
    return task;
  });

  return {
    createTask, startWork, wait, block, respond, interrupt, resume, reportProgress, completeStage, qaPass, qaFail, failTask, cancelTask,
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
