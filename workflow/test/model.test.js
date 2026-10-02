import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, ROLE_IDS, getRole, isRole } from '../roles.js';
import { STAGES, STAGE_OWNER, allowedNext, canTransition, forwardStage, isTerminal, ownerOf } from '../stages.js';
import { AGENT_STATUSES, canChangeStatus, createAgent } from '../agents.js';
import { EVENT_TYPES } from '../events.js';

test('role registry: exactly the four v1 roles, in workflow order, with stable identity', () => {
  assert.deepEqual(ROLE_IDS, ['operations', 'research', 'developer', 'qa']);
  assert.deepEqual(
    Object.values(ROLES).map(({ id, name, color }) => [id, name, color]),
    [['operations', 'Operations', '#ff9a3c'], ['research', 'Research', '#4a9dff'], ['developer', 'Developer', '#3ddc84'], ['qa', 'QA', '#b96bff']],
  );
  for (const r of Object.values(ROLES)) assert.match(r.color, /^#[0-9a-f]{6}$/);
  assert.ok(Object.isFrozen(ROLES) && Object.isFrozen(ROLES.qa) && Object.isFrozen(ROLE_IDS));
  assert.equal(getRole('qa').name, 'QA');
  assert.throws(() => getRole('designer'), /unknown role/);
  assert.equal(isRole('research'), true);
  assert.equal(isRole('toString'), false); // own keys only, not the prototype
});

test('stage ownership follows the SDLC; terminal stages have no active owner', () => {
  assert.deepEqual(STAGE_OWNER, {
    planning: 'operations', research: 'research', development: 'developer', testing: 'qa',
    rework: 'developer', finalizing: 'operations', completed: null, failed: null, cancelled: null,
  });
  for (const s of STAGES) assert.ok(ownerOf(s) === null || isRole(ownerOf(s)), `${s} owner must be a role`);
  assert.equal(isTerminal('completed') && isTerminal('failed') && isTerminal('cancelled'), true);
  assert.equal(STAGES.filter(isTerminal).length, 3);
});

test('valid transitions: the normal path, the QA loop, and failing from any open stage', () => {
  const normal = ['planning', 'research', 'development', 'testing', 'finalizing', 'completed'];
  for (let i = 0; i < normal.length - 1; i++) assert.ok(canTransition(normal[i], normal[i + 1]), `${normal[i]} → ${normal[i + 1]}`);
  assert.ok(canTransition('testing', 'rework'));
  assert.ok(canTransition('rework', 'testing'));
  for (const s of STAGES.filter((x) => !isTerminal(x))) {
    assert.ok(canTransition(s, 'failed'), `${s} → failed`);
    assert.ok(canTransition(s, 'cancelled'), `${s} → cancelled`);
  }
});

test('invalid transitions are rejected', () => {
  const bad = [
    ['planning', 'testing'], ['planning', 'development'], ['planning', 'completed'], ['research', 'planning'],
    ['research', 'testing'], ['development', 'rework'], ['development', 'completed'], ['testing', 'development'],
    ['testing', 'completed'], ['rework', 'development'], ['rework', 'finalizing'], ['finalizing', 'testing'],
    ['completed', 'development'], ['completed', 'planning'], ['completed', 'failed'], ['failed', 'planning'],
    ['cancelled', 'planning'], ['completed', 'cancelled'], ['failed', 'cancelled'],
    ['testing', 'testing'], ['planning', 'nope'], ['nope', 'research'],
  ];
  for (const [from, to] of bad) assert.equal(canTransition(from, to), false, `${from} → ${to} must be rejected`);
  assert.deepEqual(allowedNext('completed'), []);
  assert.deepEqual(allowedNext('failed'), []);
  assert.deepEqual(allowedNext('cancelled'), []);
});

test('the transition table only references known stages; forward steps are allowed transitions', () => {
  for (const s of STAGES) for (const n of allowedNext(s)) assert.ok(STAGES.includes(n), `${s} → unknown ${n}`);
  assert.equal(forwardStage('planning'), 'research');
  assert.equal(forwardStage('rework'), 'testing');
  assert.equal(forwardStage('finalizing'), 'completed');
  assert.equal(forwardStage('testing'), null, 'testing ends with a QA verdict, not a forward step');
  assert.equal(forwardStage('completed'), null);
  for (const s of STAGES) if (forwardStage(s)) assert.ok(canTransition(s, forwardStage(s)));
});

test('agent statuses and the changes allowed between them', () => {
  assert.deepEqual(AGENT_STATUSES, ['idle', 'assigned', 'working', 'waiting', 'blocked', 'interrupted']);
  for (const [from, to] of [['idle', 'assigned'], ['assigned', 'working'], ['working', 'waiting'], ['working', 'blocked'], ['waiting', 'working'], ['blocked', 'working'], ['working', 'idle'],
    ['working', 'interrupted'], ['assigned', 'interrupted'], ['interrupted', 'working'], ['interrupted', 'idle']]) {
    assert.ok(canChangeStatus(from, to), `${from} → ${to}`);
  }
  for (const [from, to] of [['idle', 'working'], ['assigned', 'waiting'], ['idle', 'blocked'], ['working', 'assigned'], ['blocked', 'waiting'], ['idle', 'interrupted'], ['blocked', 'interrupted'], ['interrupted', 'blocked']]) {
    assert.equal(canChangeStatus(from, to), false, `${from} → ${to}`);
  }
  assert.deepEqual(createAgent('qa', 5), { id: 'qa', role: 'qa', status: 'idle', taskId: null, action: null, error: null, since: 5, updatedAt: 5 });
});

test('event type names are unique', () => {
  assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length);
});
