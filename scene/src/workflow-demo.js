import { createWorkflow } from '../../workflow/engine.js';
import { demoSteps } from '../../workflow/demo.js';
import { TIMING } from './workflow-visuals.js';

// How long after the previous step each step runs (ms). Presentation pacing only — the steps and
// their order come from the workflow package; nothing here decides what happens next.
const PACE = { create: 3000, start: 1800, wait: 3500, block: 3500, handoff: 6500, qaFail: 6500, qaPass: 6500, close: 5500 };
const START_AFTER_HANDOFF = TIMING.travelMs + 1600; // the point arrives, the receiver sits "assigned", then starts
const RESUME = 3500;
const REST_MS = 9000; // the finished city settles to idle before the story repeats

/** The Phase 3 demo steps with absolute offsets (ms into the loop) and the loop period. */
export function demoSchedule(options) {
  const steps = demoSteps(options);
  const times = [];
  let t = 0;
  steps.forEach((s, i) => {
    const prev = steps[i - 1]?.kind;
    let d = PACE[s.kind];
    if (s.kind === 'start' && (prev === 'handoff' || prev === 'qaFail' || prev === 'qaPass')) d = START_AFTER_HANDOFF;
    else if (s.kind === 'start' && (prev === 'wait' || prev === 'block')) d = RESUME;
    t += d;
    times.push(t);
  });
  return { steps, times, periodMs: t + REST_MS };
}

/**
 * Plays the demo through a real workflow engine whose clock is the schedule itself, anchored to
 * wall-clock loop boundaries (loop k starts at k × period since the epoch). Every page computes the
 * same loop and the same event timestamps for the same instant, so all displays show the same
 * moment, and a page opened mid-story catches up instantly instead of starting over.
 */
export function createDemoDriver(visuals, { schedule = demoSchedule() } = {}) {
  let loop = null, next = 0, clock = 0, workflow = null, ctx = null;
  return {
    periodMs: schedule.periodMs,
    update(now) {
      const k = Math.floor(now / schedule.periodMs);
      const start = k * schedule.periodMs;
      if (k !== loop) {
        loop = k;
        next = 0;
        ctx = {};
        clock = start;
        visuals.reset();
        workflow = createWorkflow({ now: () => clock });
        workflow.on(visuals.apply);
      }
      while (next < schedule.steps.length && start + schedule.times[next] <= now) {
        clock = start + schedule.times[next];
        schedule.steps[next].run(workflow, ctx);
        next++;
      }
    },
  };
}
