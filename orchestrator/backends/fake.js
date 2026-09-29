/**
 * A scripted backend for tests: no processes, no Claude usage. `respond(call)` returns (or resolves
 * to) an outcome `{ ok, structured?, reason? }`, or the string 'hang' to stay running until
 * cancelled. `call` is the full start() request (role, stage, cwd, prompt, policy…) plus `onProgress`.
 */
export function createFakeBackend({ respond, canResume = true } = {}) {
  const calls = [];
  let pid = 40000;
  return {
    name: 'fake',
    canResume,
    calls,
    start(opts) {
      const call = { ...opts, index: calls.length, cancelled: false, cancelReason: null };
      calls.push(call);
      let settle;
      const done = new Promise((resolve) => { settle = resolve; });
      const handle = {
        pid: ++pid,
        backendSessionId: opts.resume ?? opts.backendSessionId,
        done,
        cancel(reason) {
          if (call.cancelled) return;
          call.cancelled = true;
          call.cancelReason = reason;
          settle({ ok: false, cancelled: true, reason, exitCode: null });
        },
      };
      Promise.resolve()
        .then(() => respond(call))
        .then(
          (out) => { if (!call.cancelled && out !== 'hang') settle({ exitCode: 0, costUsd: 0.01, backendSessionId: handle.backendSessionId, ...out }); },
          (err) => { if (!call.cancelled) settle({ ok: false, reason: err.message, exitCode: 1 }); },
        );
      return handle;
    },
  };
}
