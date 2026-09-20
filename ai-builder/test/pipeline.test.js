import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBuilder } from '../src/build.js';
import { forceloader } from '../src/forceload.js';
import { RconError } from '../src/rcon.js';
import { fakeWorld, fixedPlan, tempState } from './fake-world.js';

const LIMITS = { maxBlocks: 150000, maxExtent: 96, maxOps: 200 };
const quiet = () => {};

const hut = {
  name: 'Hut',
  summary: 'A hut.',
  ops: [
    { op: 'cuboid', x1: -3, y1: 0, z1: -3, x2: 3, y2: 4, z2: 3, material: 'oak_planks', hollow: true },
    { op: 'door', x: 0, y: 1, z: 3, facing: 'north', material: 'spruce_door' },
  ],
};

const builderFor = (plan) => {
  const { env, state } = tempState();
  return createBuilder({
    env, limits: LIMITS, state, saveState: quiet, log: quiet, generate: fixedPlan(plan),
  });
};

test('a build releases every chunk it force-loaded', async () => {
  // Arrange
  const world = fakeWorld();
  const builder = builderFor(hut);

  // Act
  await builder.run({ rcon: world, player: 'Kid', description: 'a hut', at: { x: 100, z: 200 } });

  // Assert
  assert.equal(forceloader.held(), 0);
  const adds = world.sent.filter((c) => c.startsWith('forceload add')).length;
  const removes = world.sent.filter((c) => c.startsWith('forceload remove')).length;
  assert.ok(adds > 0 && removes > 0);
});

test('a build that dies mid-placement still releases its chunks', async () => {
  // Arrange: the connection goes away once the fills start, for good.
  let placing = false;
  const world = fakeWorld({
    fail: (cmd) => {
      if (cmd.startsWith('fill') && !cmd.includes('air replace')) placing = true;
      return placing && !cmd.startsWith('forceload remove')
        ? new RconError('RCON not connected', { code: 'RCON_NOT_CONNECTED' })
        : null;
    },
  });
  const builder = builderFor(hut);

  // Act
  await assert.rejects(
    builder.run({ rcon: world, player: 'Kid', description: 'a hut', at: { x: 100, z: 200 } }),
    /not connected/,
  );

  // Assert
  assert.equal(forceloader.held(), 0, 'no chunk may stay force-loaded after a failure');
  assert.equal(builder.isBusy(), false);
});

// --- size grace on the last attempt --------------------------------------------

const plaza = (deep) => ({
  name: 'Plaza',
  summary: 'A plaza.',
  ops: [{ op: 'cuboid', x1: -20, y1: 0, z1: 0, x2: 20, y2: 0, z2: deep - 1, material: 'stone_bricks' }],
});

// Stands in for the model: every attempt returns the same plan, and the
// attempt count is reported exactly as the real retry loop reports it.
const stubbornModel = (plan, attempts = 3) => async (description, env, verify, { onAttempt } = {}) => {
  let lastErr;
  for (let n = 1; n <= attempts; n++) {
    onAttempt?.(n, attempts);
    try {
      return { plan, verified: await verify(plan), usage: { cost: 0 }, attempts: n, model: 'stub' };
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
};

const builderWith = (generate) => {
  const { env, state } = tempState();
  return createBuilder({ env, limits: LIMITS, state, saveState: quiet, log: quiet, generate });
};

test('a plan a little over the asked-for size is accepted on the last attempt rather than failing', async () => {
  // Arrange: "about 40 by 40" caps the footprint at 50; the model keeps drawing 54
  // deep - the live animal farm that ended in an error after three redraws.
  const builder = builderWith(stubbornModel(plaza(54)));

  // Act
  const result = await builder.run({
    rcon: fakeWorld(), player: 'Kid', description: 'a flat stone plaza about 40 by 40', at: { x: 0, z: 0 },
  });

  // Assert
  assert.equal(result.size.z, 54);
});

test('the last-attempt grace is bounded: far over the asked-for size still fails', async () => {
  // Arrange: 61 deep is more than 20% over the cap of 50.
  const builder = builderWith(stubbornModel(plaza(61)));

  // Act + Assert
  await assert.rejects(
    builder.run({ rcon: fakeWorld(), player: 'Kid', description: 'a flat stone plaza about 40 by 40', at: { x: 0, z: 0 } }),
    /too big for the size the player asked for/,
  );
});

test('before the last attempt a plan over the asked-for size is sent back', async () => {
  // Arrange: the first attempt draws 54, the second fits.
  let calls = 0;
  const generate = async (description, env, verify, { onAttempt } = {}) => {
    onAttempt?.(1, 3);
    await assert.rejects(verify(plaza(54)), /too big for the size the player asked for/);
    calls++;
    onAttempt?.(2, 3);
    const verified = await verify(plaza(40));
    return { plan: plaza(40), verified, usage: { cost: 0 }, attempts: 2, model: 'stub' };
  };
  const builder = builderWith(generate);

  // Act
  const result = await builder.run({
    rcon: fakeWorld(), player: 'Kid', description: 'a flat stone plaza about 40 by 40', at: { x: 0, z: 0 },
  });

  // Assert
  assert.equal(calls, 1);
  assert.equal(result.size.z, 40);
});
