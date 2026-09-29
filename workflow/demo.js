/**
 * A scripted run of one task through the whole workflow, for exercising the engine without real
 * agents. Browser-safe (no Node APIs): a future scene demo mode can play `demoSteps()` on a timer;
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
 * The story as steps: `{ role, label, run(workflow, ctx) }`, run in order with a shared `ctx`
 * (`ctx.taskId` is set by the first step). `qaFailures` QA rejections happen before the pass.
 */
export function demoSteps({ qaFailures = 1, task = DEMO_TASK } = {}) {
  const step = (role, label, run) => ({ role, label, run });
  const steps = [
    step('operations', 'Operations receives the request', (wf, ctx) => { ctx.taskId = wf.createTask(task).id; }),
    step('operations', 'Operations scopes the task', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'Scoping the request' })),
    step('operations', 'Operations hands off to Research', (wf, ctx) => wf.completeStage(ctx.taskId, { reason: 'Scoped: email + password sessions' })),
    step('research', 'Research investigates', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'Reviewing the codebase and auth options' })),
    step('research', 'Research waits on a decision', (wf, ctx) => wf.wait(ctx.taskId, { reason: 'Confirming session storage approach' })),
    step('research', 'Research resumes', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'Writing up the recommendation' })),
    step('research', 'Research hands off to Developer', (wf, ctx) => wf.completeStage(ctx.taskId, { reason: 'Use hashed passwords and httpOnly session cookies' })),
    step('developer', 'Developer implements', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'Implementing sign-in, sign-out and session middleware' })),
    step('developer', 'Developer hands off to QA', (wf, ctx) => wf.completeStage(ctx.taskId, { reason: 'Ready for testing' })),
    step('qa', 'QA tests', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'Running the auth test suite' })),
  ];
  for (let i = 0; i < qaFailures; i++) {
    steps.push(
      step('qa', 'QA fails the attempt', (wf, ctx) => wf.qaFail(ctx.taskId, { reason: 'Signing out does not invalidate the session' })),
      step('developer', 'Developer reworks', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'Invalidating the session on sign-out' })),
      step('developer', 'Developer hands the fix to QA', (wf, ctx) => wf.completeStage(ctx.taskId, { reason: 'Fix ready for retest' })),
      step('qa', 'QA retests', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'Re-running the auth test suite' })),
    );
  }
  steps.push(
    step('qa', 'QA passes', (wf, ctx) => wf.qaPass(ctx.taskId, { notes: 'All acceptance criteria met' })),
    step('operations', 'Operations finalizes', (wf, ctx) => wf.startWork(ctx.taskId, { action: 'Preparing the delivery summary' })),
    step('operations', 'Operations closes the task', (wf, ctx) => wf.completeStage(ctx.taskId, { reason: 'Delivered' })),
  );
  return steps;
}

/** Runs the whole story immediately; returns the task id. */
export function runDemo(workflow, options) {
  const ctx = {};
  for (const s of demoSteps(options)) s.run(workflow, ctx);
  return ctx.taskId;
}
