#!/usr/bin/env node
// ATLAS command line: submit and follow real tasks on the running ATLAS runtime (the collector).
//
//   atlas run "<request>" --cwd <dir> [--criteria "<text>"]... [--allow-dirty] [--allow-self] [--no-follow]
//   atlas status [taskId]      atlas cancel <taskId>      atlas watch      atlas activity
//   common: [--state-dir <dir>] [--port <n>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const opts = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--allow-dirty', '--allow-self', '--no-follow'].includes(argv[i - 1])));
const [command, ...rest] = positional;

const stateDir = path.resolve(opt('state-dir') ?? path.join(os.homedir(), '.config', 'atlas'));
function runtimeInfo() {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'runtime.json'), 'utf8')); } catch { return null; }
}
const info = runtimeInfo();
const port = Number(opt('port') ?? info?.port ?? 47823);
const base = `http://127.0.0.1:${port}`;
const die = (msg) => { console.error(`atlas: ${msg}`); process.exit(1); };

async function call(method, p, body) {
  const headers = { 'content-type': 'application/json' };
  if (method !== 'GET') {
    if (!info?.token) die(`no running ATLAS runtime found (${path.join(stateDir, 'runtime.json')}). Start the app or \`make dev\`.`);
    headers.authorization = `Bearer ${info.token}`;
  }
  let res;
  try { res = await fetch(`${base}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined }); } catch { die(`cannot reach the ATLAS runtime at ${base}`); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${data.error ?? res.statusText}${data.code ? ` (${data.code})` : ''}`);
  return data;
}

const time = (ms) => new Date(ms).toLocaleTimeString();
function line(e) {
  const p = e.payload;
  switch (e.type) {
    case 'task_created': return `task created: "${p.task.title}"`;
    case 'stage_changed': return `stage ${p.from} → ${p.to}${p.owner ? ` (${p.owner})` : ''}`;
    case 'agent_started': return `${p.agent.role} working · ${p.agent.action ?? ''}`;
    case 'agent_progress': return `${p.agent.role} · ${p.agent.action}`;
    case 'agent_blocked': return `${p.agent.role} blocked · ${p.reason}`;
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

async function follow(taskId) {
  let seen = 0;
  await stream('/api/workflow/events', async (name, data) => {
    const list = name === 'sync' ? data.events : [data];
    for (const e of list) {
      if (e.taskId !== taskId || e.seq <= seen) continue;
      seen = e.seq;
      const text = line(e);
      if (text) console.log(`${time(e.at)}  ${text}`);
      if (e.type === 'task_completed' || e.type === 'task_failed') return true;
    }
    return false;
  });
  await summary(taskId);
}

async function summary(taskId) {
  const d = await call('GET', `/api/tasks/${taskId}`);
  const a = d.artifact;
  console.log(`\n${d.task.id}: ${d.task.stage} (${d.task.status}) in ${d.project.cwd}`);
  if (a.finalSummary) console.log(`summary: ${a.finalSummary}`);
  if (a.changedFiles.length) console.log(`changed: ${a.changedFiles.join(', ')}`);
  if (a.qaEvidence.length) console.log(`QA evidence:\n  - ${a.qaEvidence.join('\n  - ')}`);
  if (d.task.failure) console.log(`failure: ${d.task.failure.reason}`);
  const cost = d.sessions.reduce((s, x) => s + (x.costUsd ?? 0), 0);
  console.log(`sessions: ${d.sessions.map((s) => `${s.role}/${s.stage}:${s.status}`).join(' → ')}${cost ? ` · $${cost.toFixed(2)}` : ''}`);
  if (d.runDir) console.log(`run record: ${d.runDir}`);
}

switch (command) {
  case 'run': {
    const request = rest.join(' ').trim();
    if (!request) die('usage: atlas run "<request>" --cwd <dir>');
    const cwd = opt('cwd');
    if (!cwd) die('--cwd <project directory> is required (ATLAS never guesses the target project)');
    const out = await call('POST', '/api/tasks', {
      request, cwd: path.resolve(cwd), acceptanceCriteria: opts('criteria'),
      allowDirty: flag('allow-dirty'), allowSelf: flag('allow-self'),
    });
    console.log(`task ${out.taskId} → ${out.project.cwd} (branch ${out.project.branch ?? 'detached'})`);
    if (!flag('no-follow')) await follow(out.taskId);
    break;
  }
  case 'status':
    if (rest[0]) await summary(rest[0]);
    else for (const t of await call('GET', '/api/tasks')) console.log(`${t.id}  ${t.stage.padEnd(11)} ${t.active ? 'active' : '      '}  ${t.title}  (${t.cwd})`);
    break;
  case 'cancel': {
    if (!rest[0]) die('usage: atlas cancel <taskId>');
    const d = await call('POST', `/api/tasks/${rest[0]}/cancel`);
    console.log(`${d.task.id}: ${d.task.stage}${d.task.failure ? ` — ${d.task.failure.reason}` : ''}`);
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
    die('commands: run, status, cancel, watch, activity');
}
