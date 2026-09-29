import { ROLE_IDS } from '../../workflow/roles.js';
import { ATLAS_AREAS } from './atlas-areas.js';

/**
 * Workflow → visuals adapter. Pure: no WebGL, no DOM, no SDLC rules. It consumes Phase 3 workflow
 * events (in `seq` order) and keeps a small timeline — per role, when its agent's status changes;
 * per handoff, when a path starts and completes — then `sample(now)` evaluates that timeline at
 * any wall-clock instant.
 *
 * Every value is a function of absolute time and event timestamps (never of frame count or page
 * load time), so separate displays — separate pages — render the identical frame at the same
 * instant, and a display that reloads picks up mid-animation instead of restarting it.
 *
 * Presentation choreography only (workflow timing is untouched): a handoff's point takes
 * `travelMs` to cross the city; the source stays lit until it arrives, then the destination powers
 * up and the source powers down. If the receiver is busy, the point waits at the destination until
 * the real `handoff_completed`.
 */
export const TIMING = Object.freeze({ riseMs: 750, fallMs: 1000, travelMs: 2600, pathFadeInMs: 450, pathFadeOutMs: 900, textFadeMs: 700 });

/** Light targets per Phase 3 agent status: light level, working flow, waiting pulse, blocked warning, status line. */
export const STATUS_VISUALS = Object.freeze({
  idle: Object.freeze({ level: 0.12, flow: 0, wait: 0, warn: 0, show: 0 }),
  assigned: Object.freeze({ level: 0.4, flow: 0, wait: 0, warn: 0, show: 0 }),
  working: Object.freeze({ level: 0.85, flow: 1, wait: 0, warn: 0, show: 1 }),
  waiting: Object.freeze({ level: 0.5, flow: 0, wait: 1, warn: 0, show: 1 }),
  blocked: Object.freeze({ level: 0.45, flow: 0, wait: 0, warn: 1, show: 1 }),
});
const CHANNELS = ['level', 'flow', 'wait', 'warn', 'show'];
export const MAX_PATHS = 4;
const KEEP_ENTRIES = 24;

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

const blankChannels = () => ({ ...STATUS_VISUALS.idle });

/** When a path's point has arrived and the receiver has picked the work up (∞ while it hasn't). */
const pathEnd = (p) => (p.completedAt === null ? Infinity : Math.max(p.startedAt + TIMING.travelMs, p.completedAt));
const pathFinished = (p, now) => pathEnd(p) + TIMING.pathFadeOutMs <= now;

export function createWorkflowVisuals() {
  let roles, paths, lastSeq;

  function reset() {
    roles = Object.fromEntries(ROLE_IDS.map((id) => [id, { entries: [], base: null, notBefore: -Infinity }]));
    paths = [];
    lastSeq = 0;
  }
  reset();

  /** Re-derive each entry's starting values and sticky status text after the timeline changed. */
  function rebuild(role) {
    const r = roles[role];
    r.entries.sort((a, b) => a.at - b.at || a.seq - b.seq);
    let prev = r.base ?? { from: blankChannels(), status: 'idle', at: -Infinity, text: null, prevText: null, textAt: -Infinity };
    for (const e of r.entries) {
      e.from = prev.at === -Infinity ? { ...prev.from } : ease(prev.from, STATUS_VISUALS[prev.status], prev.at, e.at, {});
      if (e.rawText && e.rawText !== prev.text) Object.assign(e, { text: e.rawText, prevText: prev.text, textAt: e.at });
      else Object.assign(e, { text: prev.text, prevText: prev.prevText, textAt: prev.textAt });
      prev = e;
    }
    while (r.entries.length > KEEP_ENTRIES) r.base = r.entries.shift(); // already baked into the next entry's `from`
  }

  function push(role, event, status, rawText, at) {
    const r = roles[role];
    r.entries.push({ at, seq: event.seq, status, taskId: event.taskId, rawText: rawText || null });
    rebuild(role);
  }

  const pathFor = (taskId, to) => paths.find((p) => p.taskId === taskId && p.to === to && p.completedAt === null);

  /** Feed one workflow event. Events must arrive in `seq` order; repeats are ignored. */
  function apply(event) {
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    const p = event.payload;
    switch (event.type) {
      case 'agent_assigned': case 'agent_started': case 'agent_waiting': case 'agent_blocked': case 'agent_idle': case 'agent_progress': {
        const role = p.agent.role;
        const r = roles[role];
        if (!r) return;
        let at = Math.max(event.at, r.notBefore);
        if (event.type === 'agent_assigned') {
          const incoming = pathFor(event.taskId, role);
          if (incoming) at = Math.max(at, incoming.startedAt + TIMING.travelMs); // light up when the point arrives
          r.notBefore = at;
        }
        const text = event.type === 'agent_started' || event.type === 'agent_progress' ? p.agent.action : event.type === 'agent_waiting' || event.type === 'agent_blocked' ? p.reason : null;
        push(role, event, p.agent.status, text, at);
        return;
      }
      case 'handoff_started': {
        const h = p.handoff;
        if (!roles[h.fromRole] || !roles[h.toRole]) return;
        const arrive = event.at + TIMING.travelMs;
        paths = paths.filter((x) => !pathFinished(x, event.at));
        paths.push({ id: h.id, taskId: h.taskId, from: h.fromRole, to: h.toRole, color: ATLAS_AREAS[h.fromRole].color, startedAt: event.at, completedAt: null });
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
        if (path) path.completedAt = event.at;
        return;
      }
      default:
        // task_created, stage_changed, qa_passed/failed, task_completed/failed carry no extra visual
        // meaning: their visible effects arrive as the agent and handoff events above.
    }
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

  /** Evaluate everything at wall-clock `now` (ms) into `out` (see createSample); allocation-free per frame. */
  function sample(now, out = createSample()) {
    let busy = false;
    for (const id of ROLE_IDS) {
      const r = roles[id], o = out.roles[id];
      let e = r.base;
      for (let i = r.entries.length - 1; i >= 0; i--) if (r.entries[i].at <= now) { e = r.entries[i]; break; }
      if (!e) {
        Object.assign(o, STATUS_VISUALS.idle);
        o.status = 'idle'; o.text = null; o.prevText = null; o.textMix = 1;
        continue;
      }
      const target = STATUS_VISUALS[e.status];
      ease(e.from, target, e.at, now, o);
      o.status = e.status;
      o.text = e.text;
      o.prevText = e.prevText;
      o.textMix = clamp01((now - e.textAt) / TIMING.textFadeMs);
      if (e.status !== 'idle' || now - e.at < Math.max(TIMING.riseMs, TIMING.fallMs)) busy = true;
      if (r.entries.length && r.entries.at(-1).at > now) busy = true; // a change is scheduled
    }
    let n = 0;
    for (let i = 0; i < paths.length && n < MAX_PATHS; i++) {
      if (pathFinished(paths[i], now)) continue;
      busy = true;
      samplePath(paths[i], now, out.paths[n]);
      if (out.paths[n].opacity > 0) n++;
    }
    for (let i = n; i < MAX_PATHS; i++) out.paths[i].opacity = 0;
    out.pathCount = n;
    out.busy = busy;
    return out;
  }

  /** The visual timeline so far (for tests and debugging): role changes in effect order, and handoff paths. */
  function timeline() {
    const changes = ROLE_IDS.flatMap((role) => roles[role].entries.map((e) => ({ role, status: e.status, at: e.at, seq: e.seq, text: e.rawText })));
    changes.sort((a, b) => a.at - b.at || a.seq - b.seq);
    return { changes, paths: paths.map((p) => ({ ...p })) };
  }

  /**
   * Start from a workflow snapshot (each agent's current status since `since`). Used when a
   * subscriber connects: the events replayed after it add the history and in-flight animations.
   */
  function seed(snapshot) {
    for (const a of snapshot?.agents ?? []) {
      if (!roles[a.role] || a.status === 'idle') continue;
      push(a.role, { seq: 0, taskId: a.taskId }, a.status, a.action, a.since);
    }
  }

  return { apply, sample, reset, seed, timeline };
}

/** Preallocated sample output, reused every frame. */
export function createSample() {
  return {
    busy: false,
    pathCount: 0,
    roles: Object.fromEntries(ROLE_IDS.map((id) => [id, { ...STATUS_VISUALS.idle, status: 'idle', text: null, prevText: null, textMix: 1 }])),
    paths: Array.from({ length: MAX_PATHS }, () => ({ from: null, to: null, color: 0, progress: 0, opacity: 0 })),
  };
}
