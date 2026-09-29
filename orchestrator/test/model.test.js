import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractFor, schemaFor, normalizeResult } from '../contracts.js';
import { createArtifact, applyResult, routeArtifact, artifactView } from '../artifact.js';
import { ROLE_POLICY, systemPrompt, stagePrompt, repairPrompt } from '../prompts.js';
import { SESSION_STATUSES, createSession, advanceSession, isFinished, classifySessions } from '../sessions.js';
import { ROLE_IDS } from '../../workflow/roles.js';
import { STAGES, ownerOf, isTerminal } from '../../workflow/stages.js';

// ---- contracts ----

test('every active stage has a result contract with a strict JSON Schema', () => {
  for (const stage of STAGES.filter((s) => !isTerminal(s))) {
    const schema = schemaFor(contractFor(stage));
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.required.includes('status') && schema.required.includes('summary'), stage);
    assert.ok(Array.isArray(schema.properties.status.enum));
  }
  assert.equal(contractFor('rework'), contractFor('development'), 'rework returns the same shape as development');
  assert.throws(() => contractFor('completed'));
});

test('normalizeResult: valid results pass, trimmed and bounded; optional lists default to []', () => {
  const r = normalizeResult('research', { status: 'complete', summary: '  found it ', findings: ['a', ' b ', '', 3], relevantFiles: ['src/math.js'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { status: 'complete', summary: 'found it', findings: ['a', 'b'], relevantFiles: ['src/math.js'], decisions: [], risks: [] });
  const long = normalizeResult('develop', { status: 'complete', summary: 'x'.repeat(5000), changedFiles: Array(99).fill('f'), testsRun: [] });
  assert.ok(long.value.summary.length <= 2000 && long.value.changedFiles.length === 40);
});

test('normalizeResult: rejects wrong shapes with a reason, never guesses', () => {
  const bad = [
    ['qa', null, 'not an object'], ['qa', [], 'not an object'],
    ['qa', { status: 'maybe', summary: 's', checks: [], evidence: [] }, 'status'],
    ['qa', { status: 'pass', checks: [], evidence: [] }, 'summary'],
    ['qa', { status: 'pass', summary: 's', evidence: [] }, 'checks'],
    ['qa', { status: 'fail', summary: 's', checks: [], evidence: [], failures: [] }, 'failures'],
    ['develop', { status: 'complete', summary: 's', changedFiles: 'a.js', testsRun: [] }, 'list'],
    ['plan', { status: 'complete', summary: 's', goal: '', acceptanceCriteria: [] }, 'goal'],
  ];
  for (const [key, raw, why] of bad) {
    const r = normalizeResult(key, raw);
    assert.equal(r.ok, false, JSON.stringify(raw));
    assert.match(r.error, new RegExp(why), r.error);
  }
});

// ---- artifact ----

const at = 1000;
const research = { status: 'complete', summary: 'use src/math.js', findings: ['add() lives in src/math.js'], relevantFiles: ['src/math.js', 'test/math.test.js'], decisions: ['export multiply'], risks: ['none'] };
const dev = { status: 'complete', summary: 'added multiply', changedFiles: ['src/math.js', 'test/math.test.js'], testsRun: ['npm test — 4 passed'], caveats: [] };
const qaFail = { status: 'fail', summary: 'negatives wrong', checks: ['multiply(2,3)=6'], evidence: ['npm test output'], failures: ['multiply(-2,3) returned 6'], recommendedRework: ['handle signs'] };
const qaPass = { status: 'pass', summary: 'all criteria met', checks: ['multiply(2,3)=6', 'multiply(-2,3)=-6'], evidence: ['npm test — 5 passed'], failures: [], recommendedRework: [] };

test('artifact: Research → Developer carries files, findings, decisions, risks and criteria', () => {
  let a = createArtifact({ taskId: 't', goal: 'Add multiply', acceptanceCriteria: ['multiply(2,3) is 6'] });
  a = applyResult(a, { role: 'research', stage: 'research', contract: 'research', sessionId: 's1', result: research, at });
  const view = artifactView(a, 'development');
  assert.deepEqual(view.relevantFiles, research.relevantFiles);
  assert.deepEqual([view.findings, view.decisions, view.risks], [research.findings, research.decisions, research.risks]);
  assert.deepEqual(view.acceptanceCriteria, ['multiply(2,3) is 6']);
  assert.deepEqual(a.history.map((h) => [h.role, h.stage, h.sessionId]), [['research', 'research', 's1']]);
});

test('artifact: Developer → QA carries the implementation; QA fail → Developer carries exact failures; pass clears them', () => {
  let a = createArtifact({ taskId: 't', goal: 'g' });
  a = applyResult(a, { role: 'developer', stage: 'development', contract: 'develop', sessionId: 's2', result: dev, at });
  const toQa = artifactView(a, 'testing');
  assert.equal(toQa.implementationSummary, 'added multiply');
  assert.deepEqual([toQa.changedFiles, toQa.testsRun], [dev.changedFiles, dev.testsRun]);
  a = applyResult(a, { role: 'qa', stage: 'testing', contract: 'qa', sessionId: 's3', result: qaFail, at });
  const toDev = artifactView(a, 'rework');
  assert.deepEqual([toDev.qaFailures, toDev.recommendedRework, toDev.qaEvidence], [qaFail.failures, qaFail.recommendedRework, qaFail.evidence]);
  assert.deepEqual(artifactView(a, 'testing').previousQa.qaFailures, qaFail.failures, 'the retest sees what failed before');
  a = applyResult(a, { role: 'qa', stage: 'testing', contract: 'qa', sessionId: 's4', result: qaPass, at });
  assert.deepEqual([a.qaFailures, a.recommendedRework], [[], []]);
  assert.deepEqual(artifactView(a, 'finalizing').qaEvidence, qaPass.evidence, 'QA → Operations carries the validation evidence');
});

test('artifact: planning merges criteria; routing records direction; results are immutable', () => {
  const a0 = createArtifact({ taskId: 't', goal: 'raw request', acceptanceCriteria: ['user criterion'] });
  const a1 = applyResult(a0, { role: 'operations', stage: 'planning', contract: 'plan', sessionId: 's0', result: { status: 'complete', summary: 's', goal: 'Precise goal', acceptanceCriteria: ['user criterion', 'tests cover it'], notes: [] }, at });
  assert.deepEqual(a1.acceptanceCriteria, ['user criterion', 'tests cover it']);
  assert.equal(a1.goal, 'Precise goal');
  assert.equal(a0.goal, 'raw request', 'the input artifact is untouched');
  assert.deepEqual(routeArtifact(a1, { stage: 'research', fromRole: 'operations', toRole: 'research' }).fromRole, 'operations');
});

// ---- prompts & policy ----

test('role prompts carry identity, stage, criteria, cwd, artifact, output shape and prohibitions', () => {
  const task = { id: 'task-9', title: 'Add multiply', description: 'Add multiply(a, b) and tests', attempt: 2 };
  const project = { cwd: '/tmp/fixture', branch: 'main' };
  let artifact = createArtifact({ taskId: 'task-9', goal: 'Add multiply', acceptanceCriteria: ['multiply(2,3) is 6'] });
  artifact = applyResult(artifact, { role: 'qa', stage: 'testing', contract: 'qa', sessionId: 's', result: qaFail, at });
  const sys = systemPrompt('developer', '/tmp/fixture');
  assert.match(sys, /ATLAS Developer agent/);
  assert.match(sys, /must not: .*commit/);
  assert.match(sys, /\/tmp\/fixture/);
  const p = stagePrompt({ role: 'developer', stage: 'rework', task, artifact, project });
  assert.match(p, /stage: rework/);
  assert.match(p, /attempt 2/);
  assert.match(p, /multiply\(-2,3\) returned 6/, 'rework sees the exact QA failure');
  assert.match(p, /multiply\(2,3\) is 6/);
  assert.match(p, /Return: status/);
  assert.match(systemPrompt('qa', '/x'), /never fix them yourself/);
  const fin = stagePrompt({ role: 'operations', stage: 'finalizing', task, artifact, project, changes: { status: [' M src/math.js'], diffStat: '1 file changed' } });
  assert.match(fin, / M src\/math\.js/);
  assert.match(repairPrompt('summary is required'), /summary is required/);
});

test('tool policy: Operations/Research read-only, QA cannot edit, Developer edits, nobody gets risky tools', () => {
  for (const role of ['operations', 'research']) {
    const p = ROLE_POLICY[role];
    assert.equal(p.restricted, true, `${role} runs restricted`);
    assert.ok(!p.allowedTools.some((t) => /Edit|Write|Bash/.test(t)), `${role} has no edit/shell tools`);
    assert.ok(p.disallowedTools.includes('Edit') && p.disallowedTools.includes('Write'));
  }
  assert.ok(ROLE_POLICY.qa.disallowedTools.includes('Edit') && ROLE_POLICY.qa.disallowedTools.includes('Write'), 'QA cannot silently fix code');
  assert.ok(ROLE_POLICY.qa.allowedTools.includes('Bash'), 'QA can run tests');
  assert.equal(ROLE_POLICY.developer.permissionMode, 'acceptEdits');
  for (const role of ROLE_IDS) {
    const deny = ROLE_POLICY[role].disallowedTools;
    for (const t of ['Task', 'EnterWorktree', 'WebFetch', 'PushNotification']) assert.ok(deny.includes(t), `${role} denies ${t}`);
    if (!ROLE_POLICY[role].restricted) for (const g of ['push', 'reset', 'checkout', 'clean', 'commit']) assert.ok(deny.includes(`Bash(git ${g} *)`), `${role} denies git ${g}`);
  }
  for (const s of STAGES.filter((x) => !isTerminal(x))) assert.ok(ROLE_POLICY[ownerOf(s)], `policy for ${s}'s owner`);
});

// ---- sessions ----

test('managed session lifecycle: valid transitions only, timestamps recorded', () => {
  assert.deepEqual(SESSION_STATUSES, ['queued', 'starting', 'running', 'waiting', 'completed', 'failed', 'cancelled']);
  let s = createSession({ id: 's1', taskId: 't', role: 'qa', stage: 'testing', backend: 'fake', cwd: '/x', at: 1 });
  assert.equal(s.status, 'queued');
  s = advanceSession(s, 'starting', 2, { backendSessionId: 'uuid' });
  assert.equal(s.startedAt, 2);
  s = advanceSession(s, 'running', 3, { pid: 42 });
  s = advanceSession(s, 'completed', 9, { exitCode: 0 });
  assert.deepEqual([s.status, s.completedAt, s.exitCode, s.pid, s.backendSessionId], ['completed', 9, 0, 42, 'uuid']);
  assert.ok(isFinished(s));
  assert.throws(() => advanceSession(s, 'running', 10), /not allowed/);
  assert.throws(() => advanceSession(createSession({ id: 's2', at: 0 }), 'completed', 1), /not allowed/, 'cannot complete without running');
});

test('unmanaged Claude sessions are never given a role; managed ones match by exact session id only', () => {
  const managed = [{ id: 's-1', role: 'developer', taskId: 't-1', backendSessionId: 'aaaa-1111' }];
  const active = [
    { key: '-Users-me-fixture', session: 'aaaa-1111' },
    { key: '-Users-me-fixture', session: 'bbbb-2222' }, // same project, but not launched by ATLAS
    { key: '-Users-me-other', session: 'cccc-3333' },
  ];
  const rows = classifySessions(active, managed);
  assert.deepEqual(rows.map((r) => [r.session, r.managed, r.role]), [['aaaa-1111', true, 'developer'], ['bbbb-2222', false, null], ['cccc-3333', false, null]]);
});
