import { test } from 'node:test';
import assert from 'node:assert/strict';

import { creaturePositions, creatureCommands } from '../src/compile.js';
import { validatePlan, ValidationError, MAX_CREATURES } from '../src/validate.js';
import { createBuilder } from '../src/build.js';
import { fakeWorld, fixedPlan, tempState } from './fake-world.js';

const LIMITS = { maxBlocks: 150000, maxExtent: 96, maxOps: 200 };
const ZERO = { x: 0, y: 0, z: 0 };
const plan = (...ops) => ({ name: 'Farm', summary: 's', ops });
const pen = { op: 'cuboid', x1: -6, y1: 0, z1: -6, x2: 6, y2: 2, z2: 6, material: 'oak_fence', hollow: true };
const cows = (extra = {}) => ({ op: 'creatures', mob: 'cow', count: 4, x1: -4, z1: -4, x2: 4, z2: 4, y: 1, ...extra });

test('an area of animals is spread evenly and stays inside it', () => {
  // Act
  const pts = creaturePositions(cows({ count: 9 }));

  // Assert
  assert.equal(pts.length, 9);
  assert.equal(new Set(pts.map((p) => `${p.x},${p.z}`)).size, 9, 'no two animals on the same block');
  assert.ok(pts.every((p) => p.x >= -4 && p.x <= 4 && p.z >= -4 && p.z <= 4 && p.y === 1));
  assert.deepEqual(creaturePositions(cows({ count: 9 })), pts, 'deterministic');
});

test('summons are persistent, tagged with the build, and fish never despawn', () => {
  // Act
  const cmds = creatureCommands(
    [{ mob: 'cow', x: -3, y: 1, z: 2 }, { mob: 'tropical_fish', x: 0, y: 2, z: 0 }],
    { x: 100, y: 64, z: -200 }, 'aib_abc123',
  );

  // Assert
  assert.deepEqual(cmds, [
    'summon minecraft:cow 97.5 65 -197.5 {PersistenceRequired:1b,Tags:["aib","aib_abc123"]}',
    'summon minecraft:tropical_fish 100.5 66 -199.5 {PersistenceRequired:1b,FromBucket:1b,Tags:["aib","aib_abc123"]}',
  ]);
  assert.throws(() => creatureCommands([], ZERO, 'aib_x"]} run op @a'), /bad build tag/);
});

test('only passive mobs from the allowlist can be summoned', () => {
  for (const mob of ['zombie', 'creeper', 'wither', 'ender_dragon', 'warden', 'cow{Health:1}', 'cow run op @a', 42]) {
    assert.throws(() => validatePlan(plan(pen, cows({ mob })), ZERO, LIMITS), /creatures.mob must be one of/, String(mob));
  }
  const v = validatePlan(plan(pen, cows({ mob: 'minecraft:Sheep' })), ZERO, LIMITS);
  assert.equal(v.creatures[0].mob, 'sheep');
});

test('creature counts are capped per op and per build', () => {
  assert.throws(() => validatePlan(plan(pen, cows({ count: MAX_CREATURES + 1 })), ZERO, LIMITS), /count must be/);
  assert.throws(() => validatePlan(plan(pen, cows({ count: 40 }), cows({ mob: 'pig', count: 40 })), ZERO, LIMITS),
    /too many creatures: 80/);
  assert.throws(() => validatePlan(plan(pen, { op: 'repeat', count: 2, step: { dx: 1 }, child: cows() }), ZERO, LIMITS),
    /repeat can't contain a creatures/);
});

test('animals must be inside the build, not loose in the world', () => {
  assert.throws(() => validatePlan(plan(pen, cows({ x1: 20, x2: 30 })), ZERO, LIMITS),
    (e) => e instanceof ValidationError && /inside the build/.test(e.message));
  assert.throws(() => validatePlan(plan(pen, cows({ y: 40 })), ZERO, LIMITS), /inside the build/);
  // explicit points work too
  const v = validatePlan(plan(pen, { op: 'creatures', mob: 'axolotl', points: [[0, 1, 0], { x: 1, y: 1, z: 1 }] }), ZERO, LIMITS);
  assert.deepEqual(v.creatures.map((c) => [c.x, c.y, c.z]), [[0, 1, 0], [1, 1, 1]]);
  assert.throws(() => validatePlan(plan(pen, { op: 'creatures', mob: 'cod', points: [[0, 'up', 0]] }), ZERO, LIMITS),
    /whole number/);
});

test('a build summons its animals last, and undo removes exactly those', async () => {
  // Arrange
  const world = fakeWorld();
  const { env, state } = tempState();
  const builder = createBuilder({
    env, limits: LIMITS, state, saveState: () => {}, log: () => {},
    generate: fixedPlan(plan(pen, cows())),
  });

  // Act
  await builder.run({ rcon: world, player: 'Kid', description: 'an animal farm', at: { x: 0, z: 0 } });
  const summons = world.sent.filter((c) => c.startsWith('summon'));
  const lastPlacement = world.sent.findLastIndex((c) => /^(fill|setblock) /.test(c) && !c.includes('replace #'));
  const firstSummon = world.sent.findIndex((c) => c.startsWith('summon'));
  const tag = summons[0].match(/"(aib_[a-z0-9]+)"/)[1];
  const beforeUndo = world.sent.length;
  await builder.undo({ rcon: world, player: 'Kid' });
  const undoCmds = world.sent.slice(beforeUndo);

  // Assert
  assert.equal(summons.length, 4);
  assert.ok(firstSummon > lastPlacement, 'animals arrive after every block');
  assert.ok(summons.every((c) => c.includes(`"${tag}"`)));
  const kill = undoCmds.findIndex((c) => c.startsWith('kill'));
  assert.equal(undoCmds[kill], `kill @e[type=!minecraft:player,tag=${tag}]`);
  assert.ok(undoCmds.findLastIndex((c) => c.startsWith('clone')) < kill, 'after the blocks are restored');
});
