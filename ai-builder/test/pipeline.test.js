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
