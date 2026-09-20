import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planFoundation, foundationCommands } from '../src/compile.js';
import { validatePlan } from '../src/validate.js';
import { createBuilder, footprintGround } from '../src/build.js';
import { fakeWorld, fixedPlan, tempState } from './fake-world.js';

const LIMITS = { maxBlocks: 400000, maxExtent: 120, maxOps: 400 };
const LOCAL = { x: 0, y: 0, z: 0 };
const plan = (...ops) => ({ name: 'Keep', summary: 's', ops });
const tower = (x1, x2, material = 'cobblestone') => ({
  op: 'cuboid', x1, y1: 0, z1: 0, x2, y2: 10, z2: 4, material, hollow: true,
});

const parse = (cmd) => {
  const [, x1, y1, z1, x2, y2, z2, material] = cmd.split(' ');
  return { x1: +x1, y1: +y1, z1: +z1, x2: +x2, y2: +y2, z2: +z2, material };
};

test('no foundation when the build already sits on its lowest ground', () => {
  const v = validatePlan(plan(tower(0, 4)), LOCAL, LIMITS);
  assert.equal(planFoundation(v, { x: 0, y: 64, z: 0 }, 64), null);
});

test('a foundation fills from the lowest ground to just under the build, only air and water', () => {
  // Arrange: two towers with a gap between them, on ground that drops 6.
  const v = validatePlan(plan(tower(0, 4), tower(10, 14)), LOCAL, LIMITS);

  // Act
  const f = planFoundation(v, { x: 100, y: 64, z: -50 }, 58);
  const cmds = foundationCommands(f);

  // Assert
  assert.deepEqual([f.bottom, f.top, f.material], [58, 63, 'cobblestone']);
  assert.deepEqual(cmds, [
    'fill 100 58 -50 104 63 -46 cobblestone replace #minecraft:replaceable',
    'fill 110 58 -50 114 63 -46 cobblestone replace #minecraft:replaceable',
  ], 'under each tower, not across the gap between them');
});

test('a foundation is never deeper than 24 blocks', () => {
  const v = validatePlan(plan(tower(0, 4)), LOCAL, LIMITS);
  assert.equal(planFoundation(v, { x: 0, y: 64, z: 0 }, 20).bottom, 40);
});

test('a base that would make a poor foundation is swapped for stone bricks', () => {
  for (const material of ['glass', 'oak_slab', 'sand', 'oak_leaves', 'water']) {
    const v = validatePlan(plan(tower(0, 4, material)), LOCAL, LIMITS);
    assert.equal(planFoundation(v, { x: 0, y: 64, z: 0 }, 60).material, 'stone_bricks', material);
  }
});

test('a build drawn starting in mid-air is not propped up', () => {
  const v = validatePlan(plan({ op: 'sphere', cx: 0, cy: 20, cz: 0, radius: 6, material: 'grass_block' }), LOCAL, LIMITS);
  assert.equal(planFoundation(v, { x: 0, y: 64, z: 0 }, 50), null);
});

test('foundation fills respect the engine fill limit', () => {
  const v = validatePlan(plan({ op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 99, y2: 0, z2: 99, material: 'stone' }), LOCAL, LIMITS);
  const cmds = foundationCommands(planFoundation(v, { x: 0, y: 64, z: 0 }, 30));
  assert.ok(cmds.length > 1);
  for (const c of cmds) {
    const b = parse(c);
    assert.ok((b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1) * (b.z2 - b.z1 + 1) <= 32768, c);
  }
});

test('the footprint probe reports the highest and the lowest ground', async () => {
  const world = fakeWorld({ groundAt: (x) => (x < 5 ? 70 : 61) });
  assert.deepEqual(await footprintGround(world, { x1: 0, z1: 0, x2: 10, z2: 10 }), { high: 70, low: 61 });
});

test('a build half over low ground gets a foundation, inside its undo snapshot', async () => {
  // Arrange: a river bank - high on the west, 8 lower on the east.
  const world = fakeWorld({ groundAt: (x) => (x < 3 ? 66 : 58) });
  const { env, state } = tempState();
  const builder = createBuilder({
    env, limits: LIMITS, state, saveState: () => {}, log: () => {},
    generate: fixedPlan(plan(tower(0, 6))),
  });

  // Act
  const r = await builder.run({ rcon: world, player: 'Kid', description: 'a lookout', at: { x: 0, z: 0 } });

  // Assert
  assert.equal(r.origin.y, 66, 'sits on the highest ground, so nothing is buried');
  const found = world.sent.findIndex((c) => c.endsWith('replace #minecraft:replaceable') && c.includes('cobblestone'));
  const walls = world.sent.findIndex((c) => c.endsWith('cobblestone hollow'));
  const clones = world.sent.filter((c) => c.startsWith('clone') && !c.includes(' 1000000 '));
  assert.ok(found >= 0 && found < walls, 'foundation goes in before the walls');
  assert.equal(parse(world.sent[found]).y1, 58);
  assert.ok(world.sent.findLastIndex((c) => c.startsWith('clone')) < found, 'after the snapshot');
  assert.ok(clones.some((c) => Number(c.split(' ')[2]) === 58), 'the snapshot reaches the foundation');
});

test('a player flying high gets their build in the air, with no pillar under it', async () => {
  // Arrange: chat build in front of a player at y=150 over ground at 64.
  const world = fakeWorld({ player: { x: 0.5, y: 150, z: 0.5 } });
  const { env, state } = tempState();
  const builder = createBuilder({
    env, limits: LIMITS, state, saveState: () => {}, log: () => {},
    generate: fixedPlan(plan(tower(0, 6))),
  });

  // Act
  await builder.run({ rcon: world, player: 'Kid', description: 'a lookout' });

  // Assert
  assert.ok(!world.sent.some((c) => c.endsWith('replace #minecraft:replaceable') && c.includes('cobblestone')));
});

test('a build over a lake sits on the water, not on the lake bed', async () => {
  // Arrange: lake bed at y 50, water up to y 62, air from 63 - the live cottage
  // that was built at y 50 with water in every door opening.
  const world = fakeWorld({ groundY: 50, waterTo: 63 });

  // Act
  const ground = await footprintGround(world, { x1: 0, z1: 0, x2: 10, z2: 10 });

  // Assert
  assert.equal(ground.high, 63, 'the build sits on the water surface');
  assert.equal(ground.low, 50, 'the foundation still reaches the lake bed');
});

test('over a lake the foundation fills the water under the build', async () => {
  // Arrange
  const world = fakeWorld({ groundY: 50, waterTo: 63 });
  const v = validatePlan(plan(tower(0, 4)), LOCAL, LIMITS);
  const ground = await footprintGround(world, { x1: 0, z1: 0, x2: 4, z2: 4 });

  // Act
  const f = planFoundation(v, { x: 0, y: ground.high, z: 0 }, ground.low);

  // Assert: a plinth from the bed to just under the floor, so the house stands
  // on stone above the water instead of floating on it.
  assert.deepEqual([f.bottom, f.top], [50, 62]);
});
