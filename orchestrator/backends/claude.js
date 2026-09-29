import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

/** Short, human status text for a tool call (drives the city's status line; never the full input). */
export function describeTool(name, input = {}) {
  const base = (p) => (typeof p === 'string' ? path.basename(p) : '');
  const clip = (s, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  switch (name) {
    case 'Read': return `reading ${base(input.file_path)}`.trim();
    case 'Edit': case 'MultiEdit': return `editing ${base(input.file_path)}`.trim();
    case 'Write': return `writing ${base(input.file_path)}`.trim();
    case 'Grep': return 'searching the code';
    case 'Glob': return 'listing files';
    case 'Bash': return `running ${clip(String(input.command ?? '').split('\n')[0].trim())}`;
    case 'TodoWrite': return 'planning steps';
    case 'StructuredOutput': return 'reporting results';
    default: return null;
  }
}

/** The claude CLI arguments for one managed session (the prompt itself goes on stdin). */
export function claudeArgs({ backendSessionId, resume, system, schema, policy, model, maxBudgetUsd }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema), '--strict-mcp-config'];
  if (resume) args.push('--resume', resume); else args.push('--session-id', backendSessionId);
  if (system) args.push('--append-system-prompt', system);
  if (model) args.push('--model', model);
  if (maxBudgetUsd) args.push('--max-budget-usd', String(maxBudgetUsd));
  if (policy.restricted) args.push('--restricted');
  if (policy.permissionMode) args.push('--permission-mode', policy.permissionMode);
  // Variadic lists go last; the prompt is on stdin, so there is no positional argument to swallow.
  if (policy.allowedTools?.length) args.push('--allowedTools', ...policy.allowedTools);
  if (policy.disallowedTools?.length) args.push('--disallowedTools', ...policy.disallowedTools);
  return args;
}

function describeFailure(final, code, signal, stderr) {
  if (final?.subtype && final.subtype !== 'success') return `claude ended with ${final.subtype}${final.result ? `: ${String(final.result).slice(0, 200)}` : ''}`;
  if (final?.is_error) return `claude reported an error: ${String(final.result ?? '').slice(0, 200)}`;
  if (signal) return `claude was terminated by ${signal}`;
  const tail = stderr.trim().split('\n').slice(-3).join(' | ');
  return `claude exited with code ${code}${tail ? `: ${tail.slice(0, 300)}` : ''}${final ? '' : ' (no result)'}`;
}

/**
 * Claude Code adapter behind the backend interface:
 *   start({ backendSessionId, resume?, cwd, system, prompt, schema, policy, rawLogPath, onProgress })
 *     → { pid, backendSessionId, done: Promise<outcome>, cancel(reason) }
 *   outcome: { ok: true, structured, exitCode, costUsd, backendSessionId } | { ok: false, reason, exitCode, cancelled? }
 *
 * Each session is `claude -p` with a session id ATLAS chose before launch, a JSON Schema for the
 * final result, and the role's tool policy. It runs in its own process group, so cancellation,
 * timeout and runtime shutdown terminate Claude and anything it spawned (SIGTERM, then SIGKILL).
 * Limitation: a descendant that deliberately starts its own session escapes the group, and if the
 * runtime itself is SIGKILLed nothing can clean up.
 */
export function createClaudeBackend({
  bin = 'claude', model = null, maxBudgetUsd = 3, timeoutMs = 20 * 60_000, killGraceMs = 5000,
  env = process.env, log = () => {},
} = {}) {
  const live = new Map(); // pid → child
  // Never let a managed session think it is nested inside another Claude Code session.
  const childEnv = { ...env };
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;

  return {
    name: 'claude',
    canResume: true,
    start({ backendSessionId, resume = null, cwd, system, prompt, schema, policy, rawLogPath = null, onProgress = () => {} }) {
      const args = claudeArgs({ backendSessionId, resume, system, schema, policy, model, maxBudgetUsd });
      const child = spawn(bin, args, { cwd, env: childEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const raw = rawLogPath ? fs.createWriteStream(rawLogPath, { flags: 'a', mode: 0o600 }) : null;
      let final = null, stderr = '', cancelled = false, cancelReason = null, exited = false, killTimer = null;
      let settle;
      const done = new Promise((resolve) => { settle = resolve; });

      const killGroup = (signal) => {
        try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
      };
      const cancel = (reason = 'cancelled') => {
        if (exited || cancelled) return;
        cancelled = true;
        cancelReason = reason;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => { if (!exited) killGroup('SIGKILL'); }, killGraceMs);
        killTimer.unref?.();
      };
      const timer = setTimeout(() => { log(`claude session ${backendSessionId ?? resume} exceeded ${Math.round(timeoutMs / 60000)} min; terminating`); cancel('timed out'); }, timeoutMs);
      timer.unref?.();

      child.on('error', (err) => {
        exited = true;
        clearTimeout(timer);
        raw?.end();
        settle({ ok: false, reason: `could not launch claude (${err.code ?? err.message})`, exitCode: null });
      });
      if (child.pid) live.set(child.pid, child);

      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        raw?.write(`${line}\n`);
        let o;
        try { o = JSON.parse(line); } catch { return; }
        if (o.type === 'assistant') {
          for (const c of o.message?.content ?? []) {
            if (c.type === 'tool_use') { const d = describeTool(c.name, c.input); if (d) onProgress(d); }
          }
        } else if (o.type === 'result') {
          final = o;
        }
      });
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });

      child.on('close', (code, signal) => {
        exited = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        live.delete(child.pid);
        raw?.end();
        const common = { exitCode: code, costUsd: final?.total_cost_usd ?? null, backendSessionId: final?.session_id ?? resume ?? backendSessionId };
        if (cancelled && cancelReason === 'timed out') return settle({ ok: false, reason: `timed out after ${Math.round(timeoutMs / 60000)} min`, ...common });
        if (cancelled) return settle({ ok: false, cancelled: true, reason: cancelReason, ...common });
        if (code === 0 && final && final.subtype === 'success' && !final.is_error) {
          let structured = final.structured_output;
          if (structured === undefined) { try { structured = JSON.parse(final.result); } catch { structured = null; } }
          return settle({ ok: true, structured, permissionDenials: final.permission_denials ?? [], ...common });
        }
        return settle({ ok: false, reason: describeFailure(final, code, signal, stderr), ...common });
      });

      child.stdin.on('error', () => { /* the process died before reading its prompt; 'close' reports why */ });
      child.stdin.end(prompt);
      return { pid: child.pid ?? null, backendSessionId: resume ?? backendSessionId, done, cancel };
    },
    /** Synchronous last resort for process exit: SIGKILL every live session's process group. */
    killAllSync() {
      for (const pid of live.keys()) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
    },
    liveCount: () => live.size,
  };
}
