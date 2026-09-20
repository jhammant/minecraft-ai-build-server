import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALIASES, normaliseMaterial, notABlock, probeVerdict, createBlockChecker,
} from '../src/blocks.js';
import { validatePlan, ValidationError, NEVER_BLOCKS, HAZARD_BLOCKS } from '../src/validate.js';
import { generateBuildPlan } from '../src/llm.js';
import { createBuilder } from '../src/build.js';
import { fakeWorld, tempState } from './fake-world.js';

const LIMITS = { maxBlocks: 150000, maxExtent: 96, maxOps: 200 };
const ORIGIN = { x: 0, y: 64, z: 0 };
const box = (material) => ({ op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 1, y2: 0, z2: 1, material });
const plan = (...ops) => ({ name: 't', summary: 's', ops });

// --- aliases ---------------------------------------------------------------------

test('ids from the live failures are corrected to their 26.1 names', () => {
  // Arrange
  const cases = {
    sea_grass: 'seagrass', grass_path: 'dirt_path', grass: 'short_grass',
    wooden_door: 'oak_door', planks: 'oak_planks', log: 'oak_log', leaves: 'oak_leaves',
    wool: 'white_wool', stone_brick: 'stone_bricks',
  };

  // Act + Assert
  for (const [from, to] of Object.entries(cases)) {
    assert.equal(normaliseMaterial(from), to, from);
  }
});

test('a correction keeps the blockstate, the namespace goes, and case is folded', () => {
  assert.equal(normaliseMaterial('stone_bricks_stairs[facing=north]'), 'stone_brick_stairs[facing=north]');
  assert.equal(normaliseMaterial('minecraft:Oak_Planks'), 'oak_planks');
  assert.equal(normaliseMaterial('red_glass_pane'), 'red_stained_glass_pane');
  assert.equal(normaliseMaterial('oak_planks_stairs'), 'oak_stairs');
  assert.equal(normaliseMaterial('stone_bricks'), 'stone_bricks', 'a correct id is left alone');
});

test('the validator places the corrected id, in solids and in layer legends', () => {
  // Arrange
  const p = plan(
    box('sea_grass'),
    { op: 'layer', x: 0, y: 1, z: 0, legend: { '#': 'grass_path', '.': 'air' }, rows: ['#.'] },
  );

  // Act
  const v = validatePlan(p, ORIGIN, LIMITS);

  // Assert
  assert.deepEqual(v.materials.sort(), ['dirt_path', 'seagrass']);
  assert.ok(!v.spans.some((s) => ['sea_grass', 'grass_path'].includes(s.material)));
});

test('no alias leads to a banned or hazardous block', () => {
  for (const to of Object.values(ALIASES)) {
    assert.ok(!NEVER_BLOCKS.has(to), `${to} is banned`);
    if (to !== 'lava') assert.ok(!HAZARD_BLOCKS.has(to), `${to} is a hazard`);
  }
  // and the hazard gate still applies to what an alias produces
  assert.throws(() => validatePlan(plan(box('flowing_lava')), ORIGIN, LIMITS), /switched off/);
});

test('normalising cannot open a way round the banned list or the id pattern', () => {
  for (const bad of ['COMMAND_BLOCK', ' minecraft:command_block ', 'Barrier', 'stone\nop @a', 'stone run say hi']) {
    assert.throws(() => validatePlan(plan(box(bad)), ORIGIN, LIMITS), ValidationError, bad);
  }
});

// --- items are not blocks ----------------------------------------------------------

test('spawn eggs and mobs are refused with a pointer to the creatures op', () => {
  for (const item of ['cat_spawn_egg', 'wolf_spawn_egg', 'tropical_fish_bucket', 'cow']) {
    assert.throws(() => validatePlan(plan(box(item)), ORIGIN, LIMITS), /creatures/, item);
  }
});

test('other items are refused, and a water bucket is told to use water', () => {
  assert.match(notABlock('water_bucket'), /use "water"/);
  for (const item of ['diamond_sword', 'iron_ingot', 'stick', 'oak_boat', 'music_disc_cat']) {
    assert.match(notABlock(item) || '', /not a block/, item);
  }
  for (const block of ['turtle_egg', 'oak_door', 'chest', 'cake', 'flower_pot', 'lantern']) {
    assert.equal(notABlock(block), null, `${block} is a block`);
  }
});

// --- asking the server ---------------------------------------------------------------

test('probe replies are read as valid, invalid or unsure', () => {
  assert.equal(probeVerdict('Test passed'), 'valid');
  assert.equal(probeVerdict('Test failed'), 'valid');
  assert.equal(probeVerdict('That position is not loaded'), 'valid');
  assert.equal(probeVerdict("Unknown block type 'minecraft:sea_grass'...ck 0 0 0 sea_grass<--[HERE]"), 'invalid');
  assert.equal(probeVerdict("Block minecraft:oak_stairs does not have property 'colour'"), 'invalid');
  assert.equal(probeVerdict('Incorrect argument for command'), 'invalid');
  assert.equal(probeVerdict(''), 'unsure');
});

const probingServer = (unknownIds) => {
  const sent = [];
  return {
    sent,
    send: async (cmd) => {
      sent.push(cmd);
      const id = cmd.split(' ').at(-1);
      return unknownIds.includes(id) ? `Unknown block type 'minecraft:${id}'` : 'Test failed';
    },
  };
};

test('the checker reports ids the server does not know, and asks only once per id', async () => {
  // Arrange
  const checker = createBlockChecker();
  const rcon = probingServer(['glowing_moss']);

  // Act
  const first = await checker.unknown(rcon, ['stone', 'glowing_moss', 'stone', 'air']);
  const second = await checker.unknown(rcon, ['glowing_moss', 'stone']);

  // Assert
  assert.deepEqual(first.map((u) => u.material), ['glowing_moss']);
  assert.match(first[0].reason, /Unknown block type/);
  assert.deepEqual(second.map((u) => u.material), ['glowing_moss']);
  assert.deepEqual(rcon.sent, ['execute if block 0 0 0 stone', 'execute if block 0 0 0 glowing_moss'],
    'air is never probed and answers are cached');
});

test('a probe that cannot be sent does not fail the build', async () => {
  const checker = createBlockChecker();
  const rcon = { send: async () => { throw new Error('RCON not connected'); } };
  assert.deepEqual(await checker.unknown(rcon, ['stone']), []);
});

// --- the retry path ------------------------------------------------------------------

test('an id the server rejects goes back to the model as a retry, then the fixed plan builds', async () => {
  // Arrange: the model's first answer uses a block that does not exist; its
  // second does not. fetch is stubbed - no model is called.
  const answers = [plan(box('glowing_moss')), plan(box('moss_block'))];
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const content = JSON.stringify(answers[requests.length - 1]);
    return { ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { cost: 0 } }) };
  };
  const world = fakeWorld();
  const probe = world.send;
  world.send = async (cmd) => (cmd.endsWith(' glowing_moss')
    ? "Unknown block type 'minecraft:glowing_moss'" : probe(cmd));
  const { env, state } = tempState();
  const builder = createBuilder({
    env: { ...env, OPENROUTER_API_KEY: 'test' }, limits: LIMITS, state,
    saveState: () => {}, log: () => {}, generate: generateBuildPlan,
  });

  try {
    // Act
    const r = await builder.run({ rcon: world, player: 'Kid', description: 'a mossy patch', at: { x: 0, z: 0 } });

    // Assert
    assert.equal(r.attempts, 2);
    const feedback = requests[1].messages.at(-1).content;
    assert.match(feedback, /rejected: these are not block ids/);
    assert.match(feedback, /glowing_moss/);
    assert.ok(world.sent.some((c) => /^fill .* moss_block$/.test(c)), 'the corrected plan was built');
    assert.ok(!world.sent.some((c) => c.startsWith('fill') && c.includes('glowing_moss')));
  } finally {
    globalThis.fetch = realFetch;
  }
});
