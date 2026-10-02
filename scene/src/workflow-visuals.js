import { ROLE_IDS } from '../../workflow/roles.js';
import { isTerminal } from '../../workflow/stages.js';
import { ATLAS_AREAS } from './atlas-areas.js';

/**
 * Workflow → visuals adapter. Pure: no WebGL, no DOM, no SDLC rules. It consumes Phase 3 workflow
 * events (in `seq` order) and keeps a small timeline — per role, when its agent's status changes;
 * per handoff, when a path starts and ends — then `sample(now)` evaluates that timeline at any
 * wall-clock instant.
 *
 * Every value is a function of absolute time and event timestamps (never of frame count or page
 * load time), so separate displays — separate pages — render the identical frame at the same
 * instant, and a display that reloads picks up mid-animation instead of restarting it.
 *
 * With no ATLAS task a role is fully off: no light, no label. Only workflow events light a role —
 * generic Claude activity never reaches this module.
 *
 * Presentation choreography only (workflow timing is untouched): a handoff's point takes
 * `travelMs` to cross the city; the source stays lit until it arrives, then the destination powers
 * up and the source powers down. If the receiver is busy, the point waits at the destination until
 * the real `handoff_completed`.
 */
export const TIMING = Object.freeze({
  riseMs: 650, fallMs: 900, travelMs: 2600, pathFadeInMs: 450, pathFadeOutMs: 900, textFadeMs: 700,
  labelInMs: 450, labelHoldMs: 2600, labelOutMs: 800,
});

/** Breathing periods in seconds (each divides 3600, so the hourly clock wrap is seamless). */
export const BREATHE_S = Object.freeze({ working: 3, waiting: 9, blocked: 4 });

/** Light targets per Phase 3 agent status: light level, working flow, waiting pulse, blocked warning. */
export const STATUS_VISUALS = Object.freeze({
  idle: Object.freeze({ level: 0, flow: 0, wait: 0, warn: 0 }),
  assigned: Object.freeze({ level: 0.45, flow: 0, wait: 0, warn: 0 }),
  working: Object.freeze({ level: 0.85, flow: 1, wait: 0, warn: 0 }),
  waiting: Object.freeze({ level: 0.5, flow: 0, wait: 1, warn: 0 }),
  blocked: Object.freeze({ level: 0.45, flow: 0, wait: 0, warn: 1 }),
  // ATLAS stopped mid-stage: the district dimly identifiable with a slow pulse — not active work, not a warning.
  interrupted: Object.freeze({ level: 0.25, flow: 0, wait: 1, warn: 0 }),
});
const visualsFor = (status) => STATUS_VISUALS[status] ?? STATUS_VISUALS.blocked; // unknown non-idle states read as needing attention
const CHANNELS = ['level', 'flow', 'wait', 'warn'];
/** Statuses whose label stays up until the status changes (they need a human's attention). */
const PINNED = new Set(['blocked', 'interrupted']);

const STAGE_WORD = { planning: 'planning', research: 'researching', development: 'implementing', rework: 'implementing', testing: 'testing', finalizing: 'finalizing' };
const ROLE_WORD = { operations: 'planning', research: 'researching', developer: 'implementing', qa: 'testing' };

/** The short status line for a role: one word from the stage and status, never tool or model text. */
export function statusWord(status, stage, role) {
  if (!status || status === 'idle') return null;
  if (status === 'blocked' || status === 'interrupted' || status === 'waiting') return status;
  return STAGE_WORD[stage] ?? ROLE_WORD[role] ?? null;
}

export const MAX_PATHS = 4;
const KEEP_ENTRIES = 24;
const LATE_SEQ = Number.MAX_SAFE_INTEGER; // sorts local corrections after any event at the same instant

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoother = (k) => k * k * k * (k * (k * 6 - 15) + 10);

/** Channel values at `t`, easing from `from` (the values at `t0`) toward `target`. Writes into `out`. */
function ease(from, target, t0, t, out) {
  for (const c of CHANNELS) {
    const a = from[c], b = target[c];
    const k = clamp01((t - t0) / (b > a ? TIMING.riseMs : TIMING.fallMs));
    out[c] = a + (b - a) * smoother(k);
  }
  return out;
}

/** Label opacity for a timeline entry: fade in from `labelOn`, hold, fade out from `labelOff`. */
function labelVis(e, now) {
  if (!(now >= e.labelOn)) return 0;
  return clamp01((now - e.labelOn) / TIMING.labelInMs) * (1 - clamp01((now - e.labelOff) / TIMING.labelOutMs));
}
const labelMoving = (e, now) => (now >= e.labelOn && now < e.labelOn + TIMING.labelInMs) || (now >= e.labelOff && now < e.labelOff + TIMING.labelOutMs);

const START = Object.freeze({ from: STATUS_VISUALS.idle, status: 'idle', at: -Infinity, text: null, prevText: null, textAt: -Infinity, labelOn: Infinity, labelOff: Infinity });

/** When a path stops being active: aborted, or its point arrived and the receiver took it (∞ while neither). */
const pathEnd = (p) => (p.abortedAt !== null ? p.abortedAt : p.completedAt === null ? Infinity : Math.max(p.startedAt + TIMING.travelMs, p.completedAt));
const pathFinished = (p, now) => pathEnd(p) + TIMING.pathFadeOutMs <= now;

export function createWorkflowVisuals() {
  let roles, paths, lastSeq, stages;

  function reset() {
    roles = Object.fromEntries(ROLE_IDS.map((id) => [id, { entries: [], base: null, notBefore: -Infinity }]));
    paths = [];
    lastSeq = 0;
    stages = new Map(); // taskId → current stage, for the status word
  }
  reset();

  /** Re-derive each entry's starting light, status line and label timing after the timeline changed. */
  function rebuild(role) {
    const r = roles[role];
    r.entries.sort((a, b) => a.at - b.at || a.seq - b.seq);
    let prev = r.base ?? START;
    for (const e of r.entries) {
      e.from = prev.at === -Infinity ? { ...prev.from } : ease(prev.from, visualsFor(prev.status), prev.at, e.at, {});
      const before = prev.at === -Infinity ? 0 : labelVis(prev, e.at);
      const pinned = PINNED.has(e.status);
      const trigger = e.status !== 'idle' && e.status !== prev.status
        && (prev.status === 'idle' || pinned || e.status === 'waiting' || PINNED.has(prev.status));
      if (trigger) { // activation, handoff arrival, or a status that needs attention: show the label
        e.labelOn = e.at - TIMING.labelInMs * before; // continue from wherever a visible label already is
        e.labelOff = pinned ? Infinity : e.at + TIMING.labelHoldMs;
      } else {
        e.labelOn = prev.labelOn;
        e.labelOff = e.status === 'idle' ? Math.min(prev.labelOff, e.at) : prev.labelOff;
      }
      if (e.word && e.word !== prev.text) { // crossfade only when the old line is actually on screen
        Object.assign(e, { text: e.word, prevText: before > 0 ? prev.text : null, textAt: before > 0 ? e.at : -Infinity });
      } else {
        Object.assign(e, { text: prev.text, prevText: prev.prevText, textAt: prev.textAt });
      }
      prev = e;
    }
    while (r.entries.length > KEEP_ENTRIES) r.base = r.entries.shift(); // already baked into the next entry's `from`
  }

  function push(role, seq, taskId, status, at) {
    const word = statusWord(status, stages.get(taskId), role);
    roles[role].entries.push({ at, seq, status, taskId, word });
    rebuild(role);
  }

  const lastEntry = (r) => r.entries.at(-1) ?? r.base;
  const pathFor = (taskId, to) => paths.find((p) => p.taskId === taskId && p.to === to && p.completedAt === null && p.abortedAt === null);

  /** End every still-open path (of one task, or all) at `at`: its line fades from there. */
  function abortPaths(at, taskId = null) {
    for (const p of paths) {
      if ((taskId === null || p.taskId === taskId) && p.completedAt === null && p.abortedAt === null) p.abortedAt = Math.max(at, p.startedAt);
    }
  }

  /** Feed one workflow event. Events must arrive in `seq` order; repeats are ignored. */
  function apply(event) {
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    const p = event.payload;
    switch (event.type) {
      case 'task_created':
        stages.set(event.taskId, p.task.stage);
        return;
      case 'stage_changed':
        // A new stage supersedes any handoff of this task still waiting for its receiver (e.g. the
        // task failed or was cancelled while queued): that line must not stay on screen.
        abortPaths(event.at, event.taskId);
        stages.set(event.taskId, p.to);
        return;
      case 'task_completed': case 'task_failed': case 'task_cancelled':
        abortPaths(event.at, event.taskId);
        stages.delete(event.taskId);
        return;
      case 'agent_assigned': case 'agent_started': case 'agent_waiting': case 'agent_blocked': case 'agent_idle': case 'agent_progress': case 'agent_interrupted': {
        const role = p.agent.role;
        const r = roles[role];
        if (!r) return;
        const status = p.agent.status;
        const last = lastEntry(r);
        // Progress carries no visual change (the status line is a stage word, not tool text).
        if (event.type === 'agent_progress' && last && last.status === status) return;
        let at = Math.max(event.at, r.notBefore);
        if (event.type === 'agent_assigned') {
          const incoming = pathFor(event.taskId, role);
          if (incoming) at = Math.max(at, incoming.startedAt + TIMING.travelMs); // light up when the point arrives
          r.notBefore = at;
        }
        push(role, event.seq, event.taskId, status, at);
        return;
      }
      case 'handoff_started': {
        const h = p.handoff;
        if (!roles[h.fromRole] || !roles[h.toRole]) return;
        const arrive = event.at + TIMING.travelMs;
        paths = paths.filter((x) => !pathFinished(x, event.at));
        paths.push({ id: h.id, taskId: h.taskId, from: h.fromRole, to: h.toRole, color: ATLAS_AREAS[h.fromRole].color, startedAt: event.at, completedAt: null, abortedAt: null });
        // The source was released in this same command (agent_idle precedes handoff_started):
        // keep it lit until the point arrives.
        const src = roles[h.fromRole];
        const released = src.entries.findLast((e) => e.status === 'idle' && e.taskId === h.taskId);
        if (released) { released.at = Math.max(released.at, arrive); rebuild(h.fromRole); }
        src.notBefore = Math.max(src.notBefore, arrive);
        return;
      }
      case 'handoff_completed': {
        const path = paths.find((x) => x.id === p.handoff.id);
        if (path && path.abortedAt === null) path.completedAt = event.at;
        return;
      }
      default:
        // qa_passed/qa_failed carry no extra visual meaning: their effects arrive as the events above.
    }
  }

  /**
   * Converge on the authoritative snapshot after replaying the event log: any role whose replayed
   * timeline doesn't end in its snapshot status (the log was trimmed, or state changed outside it)
   * is corrected from the snapshot. Nothing is replayed as new — corrections take effect at the
   * snapshot's own `since`.
   */
  function seed(snapshot) {
    for (const t of snapshot?.tasks ?? []) if (!isTerminal(t.stage)) stages.set(t.id, t.stage);
    for (const a of snapshot?.agents ?? []) {
      const r = roles[a.role];
      if (!r) continue;
      const last = lastEntry(r);
      const status = last?.status ?? 'idle';
      if (status === a.status && (a.status === 'idle' || last.taskId === a.taskId)) continue;
      push(a.role, LATE_SEQ, a.taskId ?? null, a.status, Math.max(a.since ?? -Infinity, last?.at ?? -Infinity));
    }
    const open = new Set((snapshot?.tasks ?? []).filter((t) => !isTerminal(t.stage)).map((t) => t.id));
    if (snapshot?.tasks) for (const p of paths) if (!open.has(p.taskId)) abortPaths(p.startedAt + TIMING.travelMs, p.taskId);
  }

  /**
   * The authoritative source is gone (connection lost): with no truth to show, show nothing —
   * every role and line fades out from `at`. The next sync rebuilds the real state.
   */
  function settle(at) {
    for (const id of ROLE_IDS) {
      const last = lastEntry(roles[id]);
      if (last && last.status !== 'idle') push(id, LATE_SEQ, last.taskId, 'idle', Math.max(at, last.at));
    }
    abortPaths(at);
  }

  function samplePath(path, now, out) {
    const fadeIn = clamp01((now - path.startedAt) / TIMING.pathFadeInMs);
    const fadeOut = 1 - clamp01((now - pathEnd(path)) / TIMING.pathFadeOutMs);
    out.from = path.from;
    out.to = path.to;
    out.color = path.color;
    out.progress = smoother(clamp01((now - path.startedAt) / TIMING.travelMs));
    out.opacity = now < path.startedAt ? 0 : fadeIn * fadeOut;
  }

  /**
   * Evaluate everything at wall-clock `now` (ms) into `out` (see createSample); allocation-free per
   * frame. `busy` is true only while something moves enough to need the full frame rate: a light
   * turning on or off, a working role's flow, a label fading, a path. Holds and slow pulses aren't.
   */
  function sample(now, out = createSample()) {
    let busy = false, active = false;
    for (const id of ROLE_IDS) {
      const r = roles[id], o = out.roles[id];
      let e = r.base;
      for (let i = r.entries.length - 1; i >= 0; i--) if (r.entries[i].at <= now) { e = r.entries[i]; break; }
      if (!e) {
        Object.assign(o, STATUS_VISUALS.idle);
        o.status = 'idle'; o.text = null; o.prevText = null; o.textMix = 1; o.label = 0;
        continue;
      }
      ease(e.from, visualsFor(e.status), e.at, now, o);
      o.status = e.status;
      o.text = e.text;
      o.prevText = e.prevText;
      o.textMix = clamp01((now - e.textAt) / TIMING.textFadeMs);
      o.label = labelVis(e, now);
      if (e.status !== 'idle' || o.level > 0.001) active = true;
      const easeMs = visualsFor(e.status).level >= e.from.level ? TIMING.riseMs : TIMING.fallMs;
      if (now - e.at < easeMs || e.status === 'working' || labelMoving(e, now) || (o.textMix < 1 && o.label > 0)) busy = true;
    }
    let n = 0;
    for (let i = 0; i < paths.length && n < MAX_PATHS; i++) {
      if (pathFinished(paths[i], now)) continue;
      samplePath(paths[i], now, out.paths[n]);
      if (out.paths[n].opacity > 0) { n++; busy = true; }
    }
    for (let i = n; i < MAX_PATHS; i++) out.paths[i].opacity = 0;
    out.pathCount = n;
    out.busy = busy;
    out.active = active || n > 0;
    return out;
  }

  /** The visual timeline so far (for tests and debugging): role changes in effect order, and handoff paths. */
  function timeline() {
    const changes = ROLE_IDS.flatMap((role) => roles[role].entries.map((e) => ({ role, status: e.status, at: e.at, seq: e.seq, text: e.word })));
    changes.sort((a, b) => a.at - b.at || a.seq - b.seq);
    return { changes, paths: paths.map((p) => ({ ...p })) };
  }

  return { apply, sample, reset, seed, settle, timeline };
}

/** Preallocated sample output, reused every frame. */
export function createSample() {
  return {
    busy: false,
    active: false,
    pathCount: 0,
    roles: Object.fromEntries(ROLE_IDS.map((id) => [id, { ...STATUS_VISUALS.idle, status: 'idle', text: null, prevText: null, textMix: 1, label: 0 }])),
    paths: Array.from({ length: MAX_PATHS }, () => ({ from: null, to: null, color: 0, progress: 0, opacity: 0 })),
  };
}
