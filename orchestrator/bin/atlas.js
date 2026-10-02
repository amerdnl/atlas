#!/usr/bin/env node
// ATLAS command line: submit and follow real tasks on the running ATLAS runtime (the collector).
//
//   atlas run "<request>" --cwd <dir> [--criteria "<text>"]... [--allow-dirty] [--allow-self] [--no-follow]
//   atlas status [taskId]          atlas show <taskId>            atlas history [--limit N]
//   atlas respond <taskId> "<answer>" [--resume]                 (a blocked task)
//   atlas resume <taskId> [--note "<text>"]                      (blocked or interrupted: continue the stage)
//   atlas retry <taskId> [--note "<text>"]                       (same stage, fresh session)
//   atlas cancel <taskId> [--reason "<text>"]    atlas fail <taskId> --reason "<text>"
//   atlas watch      atlas activity      atlas runtime      atlas unlock [--force]
//   common: [--state-dir <dir>] [--port <n>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore, summarize } from '../store.js';
import { readLock, ownerState, lockPath } from '../lock.js';

/** A fresh idempotency id per invocation: if a request is repeated (or retried), the runtime acts once. */
const rid = () => `cli-${crypto.randomUUID()}`;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const opts = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
const BOOLEAN = ['--allow-dirty', '--allow-self', '--no-follow', '--resume', '--force'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !BOOLEAN.includes(argv[i - 1])));
const [command, ...rest] = positional;

const stateDir = path.resolve(opt('state-dir') ?? path.join(os.homedir(), '.config', 'atlas'));
function runtimeInfo() {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'runtime.json'), 'utf8')); } catch { return null; }
}
const info = runtimeInfo();
const port = Number(opt('port') ?? info?.port ?? 47823);
const base = `http://127.0.0.1:${port}`;
const die = (msg) => { console.error(`atlas: ${msg}`); process.exit(1); };

/** Call the runtime API. With `offline`, a read falls back to the local state files when the runtime is not running. */
async function call(method, p, body, { offline = null } = {}) {
  if (!info?.token) {
    if (offline) return offline();
    die(`no running ATLAS runtime found (${path.join(stateDir, 'runtime.json')}). Start the app or \`make dev\`.`);
  }
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${info.token}` };
  let res;
  try { res = await fetch(`${base}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined }); } catch {
    if (offline) return offline();
    die(`cannot reach the ATLAS runtime at ${base}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${data.error ?? res.statusText}${data.code ? ` (${data.code})` : ''}`);
  return data;
}
const store = () => createStore(stateDir);

const time = (ms) => new Date(ms).toLocaleTimeString();
function line(e) {
  const p = e.payload;
  switch (e.type) {
    case 'task_created': return `task created: "${p.task.title}"`;
    case 'stage_changed': return `stage ${p.from} → ${p.to}${p.owner ? ` (${p.owner})` : ''}`;
    case 'agent_started': return `${p.agent.role} working · ${p.agent.action ?? ''}`;
    case 'agent_progress': return `${p.agent.role} · ${p.agent.action}`;
    case 'agent_blocked': return `${p.agent.role} BLOCKED · ${p.pause?.question ?? p.reason}`;
    case 'intervention_responded': return `response recorded: ${p.pause.response}`;
    case 'task_interrupted': return `task interrupted at ${p.stage}: ${p.reason}`;
    case 'task_resumed': return `task resumed (${p.mode}) at ${p.stage}`;
    case 'task_cancelled': return `task cancelled at ${p.stage}: ${p.reason}`;
    case 'handoff_started': return `handoff ${p.handoff.fromRole} → ${p.handoff.toRole}`;
    case 'qa_passed': return `QA passed (attempt ${p.attempt})`;
    case 'qa_failed': return `QA failed (attempt ${p.attempt}, ${p.failures}/${p.maxQaAttempts}): ${p.reason}`;
    case 'task_completed': return `task completed (attempts ${p.attempts}, QA cycles ${p.qaCycles})`;
    case 'task_failed': return `task FAILED at ${p.stage}: ${p.reason}`;
    default: return null;
  }
}

/** Minimal SSE reader over fetch; calls onEvent(name, data) until onEvent returns true. */
async function stream(p, onEvent) {
  const res = await fetch(`${base}${p}`).catch(() => die(`cannot reach the ATLAS runtime at ${base}`));
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let name = 'message', data = '';
      for (const l of block.split('\n')) {
        if (l.startsWith('event: ')) name = l.slice(7);
        else if (l.startsWith('data: ')) data += l.slice(6);
      }
      if (data && (await onEvent(name, JSON.parse(data)))) return;
    }
  }
}

const STOP = ['task_completed', 'task_failed', 'task_cancelled', 'agent_blocked', 'task_interrupted'];
async function follow(taskId) {
  let seen = 0;
  await stream('/api/workflow/events', async (name, data) => {
    const list = name === 'sync' ? data.events : [data];
    for (const e of list) {
      if (e.taskId !== taskId || e.seq <= seen) continue;
      seen = e.seq;
      const text = line(e);
      if (text) console.log(`${time(e.at)}  ${text}`);
      // Stop following when the task ends — or pauses for a person (blocked) or for recovery (interrupted).
      if (name !== 'sync' && STOP.includes(e.type)) return true; // replayed history never ends a follow
    }
    if (name === 'sync') { const t = data.snapshot.tasks.find((x) => x.id === taskId); return !t || ['completed', 'failed', 'cancelled'].includes(t.stage) || Boolean(t.pause); }
    return false;
  });
  await summary(taskId);
}

async function summary(taskId) {
  const d = await call('GET', `/api/tasks/${taskId}`, null, { offline: () => { const r = store().loadRecord(taskId); if (!r) die(`unknown task: ${taskId}`); return { ...r, active: false, runDir: store().runDir(taskId) }; } });
  const a = d.artifact ?? {};
  const t = d.task;
  console.log(`\n${t.id}: ${t.status} at ${t.stage} in ${d.project?.cwd ?? '?'}`);
  console.log(`request: ${d.request ?? t.description}`);
  if (t.pause?.kind === 'blocked') {
    console.log(`BLOCKED (${t.pause.role}): ${t.pause.reason}`);
    if (t.pause.question) console.log(`question: ${t.pause.question}`);
    for (const s of t.pause.suggestedActions ?? []) console.log(`  suggestion: ${s}`);
    console.log(t.pause.response ? `your answer: ${t.pause.response}\nnext: atlas resume ${t.id}` : `next: atlas respond ${t.id} "<answer>" --resume   (or: atlas cancel / atlas fail)`);
  }
  if (t.pause?.kind === 'interrupted') {
    console.log(`INTERRUPTED at ${t.stage}: ${t.pause.reason}`);
    console.log(`next: atlas resume ${t.id}  (continue the stage)  ·  atlas retry ${t.id}  (fresh session)  ·  atlas cancel / atlas fail`);
  }
  if (a.finalSummary) console.log(`summary: ${a.finalSummary}`);
  if (a.changedFiles?.length) console.log(`changed: ${a.changedFiles.join(', ')}`);
  if (a.qaEvidence?.length) console.log(`QA evidence:\n  - ${a.qaEvidence.join('\n  - ')}`);
  if (t.cancellation) console.log(`cancelled: ${t.cancellation.reason}`);
  if (t.failure) console.log(`failure: ${t.failure.reason}`);
  console.log(`QA attempts: ${(t.qaResults ?? []).length} · pauses: ${(t.pauses ?? []).length + (t.pause ? 1 : 0)}`);
  const cost = d.cost ?? { totalUsd: d.sessions.reduce((s, x) => s + (x.costUsd ?? 0), 0), byRole: {} };
  const roles = Object.entries(cost.byRole ?? {}).map(([r, c]) => `${r} $${c.toFixed(2)}`).join(', ');
  console.log(`sessions: ${d.sessions.map((s) => `${s.role}/${s.stage}:${s.status}`).join(' → ') || '—'}`);
  console.log(`cost: $${cost.totalUsd.toFixed(2)}${roles ? ` (${roles})` : ''}`);
  if (d.runDir) console.log(`run record: ${d.runDir}`);
}

switch (command) {
  case 'run': {
    const request = rest.join(' ').trim();
    if (!request) die('usage: atlas run "<request>" --cwd <dir>');
    const cwd = opt('cwd');
    if (!cwd) die('--cwd <project directory> is required (ATLAS never guesses the target project)');
    // One request id per invocation: a retried or duplicated submission returns the same task.
    const out = await call('POST', '/api/tasks', {
      request, cwd: path.resolve(cwd), acceptanceCriteria: opts('criteria'),
      allowDirty: flag('allow-dirty'), allowSelf: flag('allow-self'), requestId: rid(),
    });
    console.log(`task ${out.taskId} → ${out.project.cwd} (branch ${out.project.branch ?? 'detached'})`);
    if (!flag('no-follow')) await follow(out.taskId);
    break;
  }
  case 'status':
    if (rest[0]) await summary(rest[0]);
    else for (const t of await call('GET', '/api/tasks')) console.log(`${t.id}  ${t.status.padEnd(11)} ${t.stage.padEnd(11)} ${t.active ? 'running' : '       '}  ${t.title}  (${t.cwd})`);
    break;
  case 'follow':
    if (!rest[0]) die('usage: atlas follow <taskId>');
    await follow(rest[0]);
    break;
  case 'show':
    if (!rest[0]) die('usage: atlas show <taskId>');
    await summary(rest[0]);
    break;
  case 'history': {
    const limit = Number(opt('limit') ?? 20);
    const rows = await call('GET', `/api/history?limit=${limit}`, null, { offline: () => store().loadAll().records.map(summarize).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit) });
    for (const h of rows) {
      console.log(`${h.taskId}  ${String(h.status).padEnd(11)} ${String(h.stage).padEnd(11)} QA ${h.qaAttempts}  $${(h.costUsd ?? 0).toFixed(2)}  ${new Date(h.createdAt).toLocaleString()}  ${h.title}  (${h.project ?? '?'})${h.reason ? `\n    ${h.reason}` : ''}`);
    }
    if (!rows.length) console.log('no tasks on record');
    break;
  }
  case 'respond': {
    if (!rest[0] || !rest[1]) die('usage: atlas respond <taskId> "<answer>" [--resume]');
    await call('POST', `/api/tasks/${rest[0]}/respond`, { response: rest.slice(1).join(' '), requestId: rid() });
    console.log(`${rest[0]}: answer recorded`);
    if (flag('resume')) { await call('POST', `/api/tasks/${rest[0]}/resume`, { mode: 'resume', requestId: rid() }); console.log(`${rest[0]}: resumed`); await follow(rest[0]); }
    break;
  }
  case 'resume':
  case 'retry': {
    if (!rest[0]) die(`usage: atlas ${command} <taskId> [--note "<text>"]`);
    const d = await call('POST', `/api/tasks/${rest[0]}/resume`, { mode: command, note: opt('note') ?? null, requestId: rid() });
    console.log(`${d.task.id}: ${command === 'retry' ? 'retrying' : 'resuming'} ${d.task.stage}`);
    if (!flag('no-follow')) await follow(rest[0]);
    break;
  }
  case 'cancel': {
    if (!rest[0]) die('usage: atlas cancel <taskId> [--reason "<text>"]');
    const d = await call('POST', `/api/tasks/${rest[0]}/cancel`, { reason: opt('reason') ?? 'Cancelled by user', requestId: rid() });
    console.log(`${d.task.id}: ${d.task.stage}${d.task.cancellation ? ` — ${d.task.cancellation.reason}` : ''}`);
    break;
  }
  case 'fail': {
    const reason = opt('reason') ?? rest.slice(1).join(' ');
    if (!rest[0] || !reason) die('usage: atlas fail <taskId> --reason "<text>"');
    const d = await call('POST', `/api/tasks/${rest[0]}/fail`, { reason, requestId: rid() });
    console.log(`${d.task.id}: ${d.task.stage} — ${d.task.failure.reason}`);
    break;
  }
  case 'runtime': {
    const r = await call('GET', '/api/runtime');
    console.log(JSON.stringify(r.recovery, null, 2));
    break;
  }
  case 'unlock': {
    // Offline and explicit: only for a lock whose owner can't be verified and is known to be gone.
    const lock = readLock(stateDir);
    if (!lock) { console.log('no runtime lock'); break; }
    const verdict = ownerState(lock);
    console.log(`lock: pid ${lock.pid}, port ${lock.port}, started ${new Date(lock.startedAt).toLocaleString()} — ${verdict.state} (${verdict.why})`);
    if (verdict.state === 'alive') die('that runtime is still running; stop it instead of unlocking');
    if (!flag('force')) die('re-run with --force to remove this lock');
    fs.unlinkSync(lockPath(stateDir));
    console.log('lock removed');
    break;
  }
  case 'watch':
    await stream('/api/workflow/events', (name, data) => {
      for (const e of name === 'sync' ? data.events.slice(-20) : [data]) { const t = line(e); if (t) console.log(`${time(e.at)}  ${e.taskId}  ${t}`); }
      return false;
    });
    break;
  case 'activity': {
    const a = await call('GET', '/api/activity');
    console.log(`managed (ATLAS roles): ${a.managed.length}`);
    for (const m of a.managed) console.log(`  ${m.role.padEnd(10)} ${m.taskId}  session ${m.session}`);
    console.log(`unmanaged Claude sessions (no role): ${a.unmanaged.length}`);
    for (const u of a.unmanaged) console.log(`  —          ${u.key}  session ${u.session}`);
    break;
  }
  default:
    die('commands: run, status, show, history, respond, resume, retry, cancel, fail, watch, activity, runtime, unlock');
}
