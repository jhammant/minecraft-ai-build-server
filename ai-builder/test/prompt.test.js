import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SYSTEM_PROMPT, EXAMPLE_USER, EXAMPLE_ASSISTANT, buildMessages } from '../src/prompt.js';
import { validatePlan } from '../src/validate.js';
import { interiorGaps } from '../src/interior.js';
import { CREATURES } from '../src/blocks.js';

const LIMITS = { maxBlocks: 150000, maxExtent: 96, maxOps: 200 };

test('every op the validator accepts is described to the model', () => {
  // A model that can't see an op never uses it - which is how houses went
  // without doors while the builder could have placed them.
  for (const op of ['cuboid', 'cylinder', 'sphere', 'cone', 'pyramid', 'roof', 'crenellate',
    'repeat', 'layer', 'stairs', 'door', 'bed', 'creatures']) {
    assert.ok(SYSTEM_PROMPT.includes(`{"op":"${op}"`), `${op} is not documented`);
  }
  for (const mob of CREATURES) assert.ok(SYSTEM_PROMPT.includes(mob), `${mob} is not listed`);
});

test('the prompt no longer steers the model away from torches and lanterns', () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /falls off/);
  assert.match(SYSTEM_PROMPT, /seagrass \(not sea_grass\)/);
  assert.match(SYSTEM_PROMPT, /SIZE BUDGET/);
});

test('the worked example is itself a valid plan with a real door and a bed', () => {
  // Arrange
  const example = JSON.parse(EXAMPLE_ASSISTANT);

  // Act
  const v = validatePlan(example, { x: 0, y: 64, z: 0 }, LIMITS);

  // Assert
  assert.equal(v.details.doors.length, 1);
  assert.equal(v.details.beds.length, 1);
  assert.ok(v.details.blocks.some((b) => b.material.startsWith('ladder')), 'the ladder waits for its wall');
  assert.deepEqual(interiorGaps(EXAMPLE_USER, v), []);
  assert.ok(!example.ops.some((o) => o.material === 'air' && o.x2 - o.x1 >= 2 && o.y1 === 3),
    'no 3-wide air hole standing in for a door');
});

test('the conversation is system, example, then the request', () => {
  const msgs = buildMessages('a barn', {});
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(msgs[3].content, 'a barn');
});
