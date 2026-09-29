#!/usr/bin/env node
// Prints the demo task's event timeline: `npm run demo:workflow [-- --qa-failures N]`.
import { createWorkflow } from '../engine.js';
import { demoSteps } from '../demo.js';

const i = process.argv.indexOf('--qa-failures');
const qaFailures = i > 0 ? Number(process.argv[i + 1]) : 1;

let t = 0;
const wf = createWorkflow({ now: () => (t += 1000) });
const describe = (e) => {
  const p = e.payload;
  switch (e.type) {
    case 'task_created': return `"${p.task.title}" → ${p.task.owner}`;
    case 'stage_changed': return `${p.from} → ${p.to} (owner: ${p.owner ?? '—'}, attempt ${p.attempt})`;
    case 'handoff_started': case 'handoff_completed': return `${p.handoff.fromRole} → ${p.handoff.toRole}${p.handoff.reason ? ` · ${p.handoff.reason}` : ''}`;
    case 'agent_idle': return `${p.agent.id}`;
    case 'agent_assigned': case 'agent_started': return `${p.agent.id}${p.agent.action ? ` · ${p.agent.action}` : ''}`;
    case 'agent_waiting': case 'agent_blocked': return `${p.agent.id} · ${p.reason}`;
    case 'qa_passed': return `attempt ${p.attempt}`;
    case 'qa_failed': return `attempt ${p.attempt} · ${p.reason} (${p.failures}/${p.maxQaAttempts})`;
    case 'task_completed': return `attempts ${p.attempts}, QA cycles ${p.qaCycles}`;
    case 'task_failed': return `${p.reason}`;
    default: return '';
  }
};
wf.on((e) => console.log(`#${String(e.seq).padStart(2, '0')}  t=${String(e.at / 1000).padStart(2)}s  ${e.type.padEnd(18)} ${describe(e)}`));

const ctx = {};
for (const s of demoSteps({ qaFailures })) {
  console.log(`\n— ${s.label}`);
  s.run(wf, ctx);
}
const task = wf.getTask(ctx.taskId);
console.log(`\n${task.id}: ${task.stage}, ${task.history.length} transitions, ${wf.handoffs(task.id).length} handoffs, QA ${task.qaResults.map((r) => (r.passed ? 'pass' : 'fail')).join(' → ')}`);
