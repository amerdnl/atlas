/**
 * A scripted run of one task through the whole workflow, for exercising the engine without real
 * agents. Browser-safe (no Node APIs): the scene's demo mode plays `demoSteps()` on a schedule;
 * tests and `npm run demo:workflow` run them back to back.
 */
export const DEMO_TASK = Object.freeze({
  title: 'Add authentication',
  description: 'Let users sign in and out with email and password.',
  acceptanceCriteria: Object.freeze([
    'Users can sign in with a valid email and password',
    'Invalid credentials are rejected with a clear message',
    'Signing out invalidates the session',
  ]),
});

/**
 * The story as steps: `{ role, kind, label, run(workflow, ctx) }`, run in order with a shared `ctx`
 * (`ctx.taskId` is set by the first step). `kind` names the engine command a step issues
 * (create | start | wait | block | handoff | qaFail | qaPass | close) so a player can pace them;
 * it carries no workflow meaning of its own. `qaFailures` QA rejections happen before the pass.
 */
export function demoSteps({ qaFailures = 1, task = DEMO_TASK } = {}) {
  const step = (role, kind, label, run) => ({ role, kind, label, run });
  const steps = [
    step('operations', 'create', 'Operations receives the request', (wf, ctx) => { ctx.taskId = wf.createTask(task).id; }),
    step('operations', 'start', 'Operations scopes the task', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'scoping the request' })),
    step('operations', 'handoff', 'Operations hands off to Research', (wf, ctx) => wf.completeStage(ctx.taskId, { reason: 'Scoped: email + password sessions' })),
    step('research', 'start', 'Research investigates', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'reading requirements' })),
    step('research', 'wait', 'Research waits on a decision', (wf, ctx) => wf.wait(ctx.taskId, { reason: 'awaiting session decision' })),
    step('research', 'start', 'Research resumes', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'writing recommendation' })),
    step('research', 'handoff', 'Research hands off to Developer', (wf, ctx) => wf.completeStage(ctx.taskId, { reason: 'Use hashed passwords and httpOnly session cookies' })),
    step('developer', 'start', 'Developer implements', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'implementing sign-in' })),
    step('developer', 'handoff', 'Developer hands off to QA', (wf, ctx) => wf.completeStage(ctx.taskId, { reason: 'Ready for testing' })),
    step('qa', 'start', 'QA tests', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'running tests' })),
  ];
  for (let i = 0; i < qaFailures; i++) {
    steps.push(
      step('qa', 'qaFail', 'QA fails the attempt', (wf, ctx) => wf.qaFail(ctx.taskId, { reason: 'Signing out does not invalidate the session' })),
      step('developer', 'start', 'Developer reworks', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'fixing sign-out' })),
    );
    if (i === 0) {
      steps.push(
        step('developer', 'block', 'Developer is blocked', (wf, ctx) => wf.block(ctx.taskId, { reason: 'test database unavailable' })),
        step('developer', 'start', 'Developer resumes', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'fixing sign-out' })),
      );
    }
    steps.push(
      step('developer', 'handoff', 'Developer hands the fix to QA', (wf, ctx) => wf.completeStage(ctx.taskId, { reason: 'Fix ready for retest' })),
      step('qa', 'start', 'QA retests', (wf, ctx) => wf.startWork(ctx.taskId, { action: 're-running tests' })),
    );
  }
  steps.push(
    step('qa', 'qaPass', 'QA passes', (wf, ctx) => wf.qaPass(ctx.taskId, { notes: 'All acceptance criteria met' })),
    step('operations', 'start', 'Operations finalizes', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'finalizing delivery' })),
    step('operations', 'close', 'Operations closes the task', (wf, ctx) => wf.completeStage(ctx.taskId, { reason: 'Delivered' })),
  );
  return steps;
}

/** Runs the whole story immediately; returns the task id. */
export function runDemo(workflow, options) {
  const ctx = {};
  for (const s of demoSteps(options)) s.run(workflow, ctx);
  return ctx.taskId;
}
