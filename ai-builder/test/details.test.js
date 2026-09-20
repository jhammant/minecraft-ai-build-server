import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compilePlan, detailCommands, spansToCommands } from '../src/compile.js';
import { subtractBox, inferDoorFacing } from '../src/details.js';
import { validatePlan, ValidationError } from '../src/validate.js';
import { interiorGaps, wantedFurniture } from '../src/interior.js';
import { requestText } from '../src/prompt.js';
import { generateBuildPlan } from '../src/llm.js';
import { createBuilder } from '../src/build.js';
import { fakeWorld, tempState } from './fake-world.js';

const LIMITS = { maxBlocks: 150000, maxExtent: 96, maxOps: 200 };
const ORIGIN = { x: 100, y: 64, z: -200 };
const ZERO = { x: 0, y: 0, z: 0 };
const plan = (...ops) => ({ name: 't', summary: 's', ops });
const room = { op: 'cuboid', x1: -3, y1: 0, z1: -3, x2: 3, y2: 4, z2: 3, material: 'stone_bricks', hollow: true };

// --- doors and beds ------------------------------------------------------------

test('a door op becomes an opening and two halves, lower half first and strict', () => {
  // Arrange
  const v = validatePlan(plan(room, { op: 'door', x: 0, y: 1, z: 3, facing: 'north', material: 'spruce_door' }),
    ORIGIN, LIMITS);

  // Act
  const cmds = detailCommands(v.details, ORIGIN);

  // Assert
  assert.deepEqual(cmds, [
    'fill 100 65 -197 100 66 -197 air',
    'setblock 100 65 -197 spruce_door[facing=north,hinge=left,half=lower] strict',
    'setblock 100 66 -197 spruce_door[facing=north,hinge=left,half=upper]',
  ]);
});

test('a bed op places the foot, then the head one block along its facing', () => {
  const v = validatePlan(plan(room, { op: 'bed', x: 1, y: 1, z: 1, facing: 'north', color: 'blue' }), ZERO, LIMITS);
  assert.deepEqual(detailCommands(v.details, ZERO), [
    'setblock 1 1 1 blue_bed[facing=north,part=foot] strict',
    'setblock 1 1 0 blue_bed[facing=north,part=head]',
  ]);
});

test('door and bed fields are held to fixed shapes', () => {
  const bad = [
    { op: 'door', x: 0, y: 1, z: 3, material: 'oak_planks' },
    { op: 'door', x: 0, y: 1, z: 3, facing: 'up' },
    { op: 'door', x: 0, y: 1, z: 3, hinge: 'middle' },
    { op: 'door', x: 0, y: 1.5, z: 3 },
    { op: 'door', x: 0, y: 1, z: 3, material: 'oak_door run say hi' },
    { op: 'bed', x: 0, y: 1, z: 0, color: 'tartan' },
    { op: 'bed', x: 0, y: 1, z: 0, material: 'command_block' },
    { op: 'repeat', count: 3, step: { dx: 2 }, child: { op: 'door', x: 0, y: 1, z: 3 } },
  ];
  for (const op of bad) {
    assert.throws(() => validatePlan(plan(room, op), ZERO, LIMITS), ValidationError, JSON.stringify(op));
  }
});

test('a door with no material or facing gets an oak door facing into the building', () => {
  // Arrange: a door in the +z wall. You walk in from outside heading north.
  const v = validatePlan(plan(room, { op: 'door', x: 0, y: 1, z: 3 }), ZERO, LIMITS);

  // Assert
  assert.deepEqual(v.details.doors, [{ x: 0, y: 1, z: 3, material: 'oak_door', facing: 'north', hinge: 'left' }]);
});

test('door blocks drawn into a wall become real doors, and a pair opens from the middle', () => {
  // Arrange: a 2-wide, 2-tall doorway of oak_door blocks in the -x wall.
  const v = validatePlan(plan(room,
    { op: 'cuboid', x1: -3, y1: 1, z1: 0, x2: -3, y2: 2, z2: 1, material: 'oak_door' }), ZERO, LIMITS);

  // Act
  const { doors } = v.details;

  // Assert
  assert.equal(doors.length, 2, 'one door per column, not one per block');
  assert.ok(doors.every((d) => d.facing === 'east' && d.y === 1), 'walking in from -x means facing east');
  // Facing east, your left is north (-z): the z=0 door hinges left, z=1 right.
  assert.equal(doors.find((d) => d.z === 0).hinge, 'left');
  assert.equal(doors.find((d) => d.z === 1).hinge, 'right');
  assert.ok(!v.spans.some((s) => s.material.includes('door')), 'no door block is left for fill');
});

test('bed blocks drawn two long become one bed pointing along them', () => {
  const v = validatePlan(plan(room,
    { op: 'layer', x: 1, y: 1, z: 0, legend: { B: 'red_bed' }, rows: ['B', 'B'] }), ZERO, LIMITS);
  assert.deepEqual(v.details.beds, [{ x: 1, y: 1, z: 0, material: 'red_bed', facing: 'south' }]);
});

test('facing is inferred from the wall a door sits in', () => {
  const walls = [{ x1: -5, y1: 0, z1: 5, x2: 5, y2: 3, z2: 5, material: 'stone', mode: 'solid' }];
  assert.equal(inferDoorFacing(walls, 0, 1, 5, { x: 0, z: 0 }), 'north');
  const side = [{ x1: 5, y1: 0, z1: -5, x2: 5, y2: 3, z2: 5, material: 'stone', mode: 'solid' }];
  assert.equal(inferDoorFacing(side, 5, 1, 0, { x: 0, z: 0 }), 'west');
});

// --- fragile blocks ------------------------------------------------------------------

test('a torch placed before its wall is moved after all structure', () => {
  // Arrange: the order that made torches fall off - light first, wall second.
  const p = plan(
    { op: 'cuboid', x1: 1, y1: 2, z1: 0, x2: 1, y2: 2, z2: 0, material: 'wall_torch[facing=east]' },
    { op: 'cuboid', x1: 0, y1: 0, z1: -2, x2: 0, y2: 4, z2: 2, material: 'stone_bricks' },
  );

  // Act
  const v = validatePlan(p, ZERO, LIMITS);
  const cmds = [...spansToCommands(v.spans, ZERO), ...detailCommands(v.details, ZERO)];

  // Assert
  assert.deepEqual(cmds, [
    'fill 0 0 -2 0 4 2 stone_bricks',
    'setblock 1 2 0 wall_torch[facing=east]',
  ]);
});

test('moving a fragile block never undoes a later op that overwrote it', () => {
  // Arrange: carpet across a floor, then a later air cut through part of it.
  const p = plan(
    { op: 'cuboid', x1: 0, y1: 1, z1: 0, x2: 4, y2: 1, z2: 0, material: 'red_carpet' },
    { op: 'cuboid', x1: 2, y1: 1, z1: 0, x2: 2, y2: 3, z2: 0, material: 'air' },
  );

  // Act
  const { blocks } = compilePlan(p);

  // Assert
  const cells = blocks.flatMap((b) => Array.from({ length: b.x2 - b.x1 + 1 }, (_, i) => b.x1 + i));
  assert.deepEqual(cells.sort(), [0, 1, 3, 4], 'the cut cell stays air');
});

test('lanterns, ladders, signs and seagrass go to the details pass; sea lanterns do not', () => {
  const ids = ['lantern', 'ladder[facing=west]', 'oak_wall_sign', 'seagrass', 'white_carpet', 'potted_cactus', 'sea_lantern'];
  const { spans, blocks } = compilePlan(plan(...ids.map((m, i) => (
    { op: 'cuboid', x1: i, y1: 0, z1: 0, x2: i, y2: 0, z2: 0, material: m }))));
  assert.deepEqual(spans.map((s) => s.material), ['sea_lantern']);
  assert.equal(blocks.length, 6);
});

test('tall plants are placed as two halves', () => {
  const v = validatePlan(plan({ op: 'cuboid', x1: 0, y1: 1, z1: 0, x2: 0, y2: 1, z2: 0, material: 'tall_seagrass' }), ZERO, LIMITS);
  assert.deepEqual(detailCommands(v.details, ZERO), [
    'setblock 0 1 0 tall_seagrass[half=lower] strict',
    'setblock 0 2 0 tall_seagrass[half=upper]',
  ]);
});

test('box subtraction leaves exactly the uncovered cells', () => {
  const a = { x1: 0, y1: 0, z1: 0, x2: 2, y2: 2, z2: 2 };
  const pieces = subtractBox(a, { x1: 1, y1: 1, z1: 1, x2: 1, y2: 1, z2: 1 });
  const vol = pieces.reduce((n, p) => n + (p.x2 - p.x1 + 1) * (p.y2 - p.y1 + 1) * (p.z2 - p.z1 + 1), 0);
  assert.equal(vol, 26);
});

test('details count towards size: a door on the top course makes the build taller', () => {
  const v = validatePlan(plan(room, { op: 'door', x: 0, y: 4, z: 3 }), ZERO, LIMITS);
  assert.equal(v.size.y, 6);
});

// --- furniture and doors are expected --------------------------------------------------

test('named furniture is found in the description and required in the request', () => {
  // Act
  const wanted = wantedFurniture('a cottage with a bed, a kitchen, a crafting table and chests');
  const text = requestText('a cottage', { wanted });

  // Assert
  assert.deepEqual(wanted, ['a bed (bed op)', 'a chest', 'a crafting_table', 'a furnace or smoker']);
  assert.match(text, /MUST INCLUDE, inside: a bed/);
});

test('a house with no door is a gap; an aquarium without one is not', () => {
  const shell = validatePlan(plan(room), ZERO, LIMITS);
  assert.match(interiorGaps('a spooky haunted house', shell).join(), /door/);
  assert.deepEqual(interiorGaps('an aquarium', shell), []);
  const withBed = validatePlan(plan(room, { op: 'door', x: 0, y: 1, z: 3 }, { op: 'bed', x: 0, y: 1, z: 0 }), ZERO, LIMITS);
  assert.deepEqual(interiorGaps('a house with a bed', withBed), []);
  assert.deepEqual(interiorGaps('a house with a bed and a crafting table', withBed), ['a crafting_table']);
});

test('a doorless house is sent back once, then the build places real doors after the walls', async () => {
  // Arrange: first answer has an air hole for a door, second has a door op.
  const hole = plan(room, { op: 'cuboid', x1: 0, y1: 1, z1: 3, x2: 0, y2: 2, z2: 3, material: 'air' });
  const door = plan(room, { op: 'door', x: 0, y: 1, z: 3, material: 'oak_door' });
  const answers = [hole, door];
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const content = JSON.stringify(answers[requests.length - 1]);
    return { ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { cost: 0 } }) };
  };
  const world = fakeWorld();
  const { env, state } = tempState();
  const builder = createBuilder({
    env: { ...env, OPENROUTER_API_KEY: 'test' }, limits: LIMITS, state,
    saveState: () => {}, log: () => {}, generate: generateBuildPlan,
  });

  try {
    // Act
    const r = await builder.run({ rcon: world, player: 'Kid', description: 'a little house', at: { x: 0, z: 0 } });

    // Assert
    assert.equal(r.attempts, 2);
    assert.match(requests[1].messages.at(-1).content, /missing a door \(door op\)/);
    const lastFill = world.sent.findLastIndex((c) => c.startsWith('fill') && c.endsWith('stone_bricks hollow'));
    const lower = world.sent.findIndex((c) => /^setblock 0 \d+ 3 oak_door\[.*half=lower\] strict$/.test(c));
    const upper = world.sent.findIndex((c) => /^setblock 0 \d+ 3 oak_door\[.*half=upper\]$/.test(c));
    assert.ok(lastFill >= 0 && lower > lastFill, 'the door goes in after the walls');
    assert.equal(upper, lower + 1, 'upper half straight after the lower');
  } finally {
    globalThis.fetch = realFetch;
  }
});
