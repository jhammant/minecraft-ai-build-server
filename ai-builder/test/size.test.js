import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitSizeWord, dimensionsFrom, budgetFor, SIZES } from '../src/size.js';
import { validatePlan, ValidationError } from '../src/validate.js';
import { buildMessages } from '../src/prompt.js';
import { createBuilder } from '../src/build.js';
import { fakeWorld, fixedPlan, tempState } from './fake-world.js';

const LIMITS = { maxBlocks: 400000, maxExtent: 120, maxOps: 400 };
const ORIGIN = { x: 0, y: 64, z: 0 };
const slab = (w, h, d) => ({
  name: 't', summary: 's',
  ops: [{ op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: w - 1, y2: h - 1, z2: d - 1, material: 'stone', hollow: true }],
});

// --- reading what was asked for ------------------------------------------------

test('a leading size word is taken off a chat command', () => {
  assert.deepEqual(splitSizeWord('small a hut'), { size: 'small', description: 'a hut' });
  assert.deepEqual(splitSizeWord('HUGE: castle'), { size: 'huge', description: 'castle' });
  assert.deepEqual(splitSizeWord('a small hut'), { size: null, description: 'a small hut' });
  assert.deepEqual(splitSizeWord('smallish hut'), { size: null, description: 'smallish hut' });
});

test('typed dimensions are found, and small ones are read as details', () => {
  assert.deepEqual(dimensionsFrom('an aquarium about 40 by 40').w, 40);
  const barn = dimensionsFrom('a 20x30x12 barn');
  assert.deepEqual([barn.w, barn.d, barn.h], [20, 30, 12]);
  assert.equal(dimensionsFrom('a castle with 2x2 windows'), null);
  assert.equal(dimensionsFrom('a sanctuary about 50 by 50 with 3 by 3 ponds').w, 50);
  assert.equal(dimensionsFrom('a pond 30 blocks wide').w, 30);
  assert.equal(dimensionsFrom('a pirate ship'), null);
});

test('typed dimensions become a cap a quarter over, never above the server limit', () => {
  // Arrange + Act
  const typed = budgetFor({ description: 'an aquarium about 40 by 40', maxExtent: 120 });
  const tall = budgetFor({ description: 'a tower 10 by 10 by 60', maxExtent: 120 });
  const clamped = budgetFor({ size: 'huge', description: 'x', maxExtent: 96 });

  // Assert
  assert.equal(typed.footprint, 50);
  assert.equal(typed.height, 120, 'a footprint says nothing about height');
  assert.match(typed.reason, /40 by 40/);
  assert.deepEqual([tall.footprint, tall.height], [13, 75]);
  assert.deepEqual([clamped.footprint, clamped.height], [96, 96]);
});

test('size words map to their extents, and typed numbers win over the word', () => {
  assert.deepEqual(budgetFor({ size: 'small', description: 'a hut', maxExtent: 120 }),
    { footprint: SIZES.small, height: SIZES.small, reason: 'they picked a small build' });
  const both = budgetFor({ size: 'small', description: 'a farm 40 by 40', maxExtent: 120 });
  assert.deepEqual([both.footprint, both.height], [50, 24]);
  assert.equal(budgetFor({ description: 'a castle', maxExtent: 120 }), null);
});

// --- holding the plan to it ------------------------------------------------------

test('an oversize plan is rejected with the budget and the reason in the message', () => {
  // Arrange: the live failure - asked for about 40 by 40, drew 81 x 82.
  const budget = budgetFor({ description: 'an aquarium about 40 by 40', maxExtent: 120 });

  // Act + Assert
  assert.throws(
    () => validatePlan(slab(81, 25, 82), ORIGIN, { ...LIMITS, budget }),
    (err) => err instanceof ValidationError
      && /81 wide x 82 deep/.test(err.message)
      && /50 x 50/.test(err.message)
      && /40 by 40/.test(err.message),
  );
  assert.ok(validatePlan(slab(48, 25, 50), ORIGIN, { ...LIMITS, budget }).blocks > 0);
});

test('height is held to the budget too', () => {
  const budget = budgetFor({ size: 'small', description: 'a hut', maxExtent: 120 });
  assert.throws(() => validatePlan(slab(10, 30, 10), ORIGIN, { ...LIMITS, budget }), /30 tall/);
});

test('the model is told the budget in the request itself', () => {
  // Arrange
  const budget = budgetFor({ size: 'medium', description: 'a barn', maxExtent: 120 });

  // Act
  const withBudget = buildMessages('a barn', { budget }).at(-1).content;
  const without = buildMessages('a barn', { limits: LIMITS }).at(-1).content;

  // Assert
  assert.match(withBudget, /^a barn/);
  assert.match(withBudget, /SIZE BUDGET: .*48 x 48 .*48 tall/);
  assert.match(without, /at most 120 blocks/);
});

test('a size passed to the builder reaches the validator', async () => {
  // Arrange
  const { env, state } = tempState();
  const builder = createBuilder({
    env, limits: LIMITS, state, saveState: () => {}, log: () => {},
    generate: fixedPlan(slab(40, 10, 40)),
  });

  // Act + Assert
  await assert.rejects(
    builder.run({ rcon: fakeWorld(), player: 'Kid', description: 'a hut', size: 'small', at: { x: 0, z: 0 } }),
    /must fit within 24 x 24/,
  );
  await assert.rejects(
    builder.run({ rcon: fakeWorld(), player: 'Kid', description: 'a hut', size: 'gigantic', at: { x: 0, z: 0 } }),
    /isn't a size/,
  );
});
