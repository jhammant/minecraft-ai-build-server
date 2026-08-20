import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  countersFrom, deltaOf, pointsFor, rankFor, priceFor, readConfig, barId,
  isSpammable, createRewards,
} from '../src/rewards.js';

// A stats file shaped like the ones Paper actually writes.
const stats = (used = {}, mined = {}, crafted = {}, custom = {}) => ({
  stats: {
    'minecraft:used': used,
    'minecraft:mined': mined,
    'minecraft:crafted': crafted,
    'minecraft:custom': custom,
  },
});

const ledger = (env = {}) => {
  const state = {};
  return createRewards({
    env: { REWARDS_MODE: 'both', ...env }, state, saveState: () => {}, log: () => {},
  });
};

// --- reading the server's own statistics --------------------------------------

test('counts block placements out of minecraft:used', () => {
  const c = countersFrom(stats(
    { 'minecraft:oak_planks': 400, 'minecraft:stone_bricks': 112 },
    { 'minecraft:stone': 64 },
    { 'minecraft:oak_planks': 24 },
    { 'minecraft:walk_one_cm': 50000, 'minecraft:sprint_one_cm': 20000 },
  ));
  assert.deepEqual(c, { placed: 512, mined: 64, crafted: 24, cm: 70000 });
});

test('spammable items do not count as building', () => {
  // Otherwise a stack of snowballs is a castle.
  for (const item of [
    'minecraft:snowball', 'minecraft:egg', 'minecraft:bow', 'minecraft:water_bucket',
    'minecraft:firework_rocket', 'minecraft:bone_meal', 'minecraft:oak_boat',
    'minecraft:splash_potion', 'minecraft:zombie_spawn_egg', 'minecraft:fishing_rod',
  ]) {
    assert.ok(isSpammable(item), `${item} should not count`);
  }
  for (const block of [
    'minecraft:oak_planks', 'minecraft:stone', 'minecraft:glass', 'minecraft:white_wool',
    'minecraft:oak_stairs', 'minecraft:torch', 'minecraft:chest',
  ]) {
    assert.ok(!isSpammable(block), `${block} should count`);
  }
});

test('an empty or malformed stats file reads as zero, not a crash', () => {
  assert.deepEqual(countersFrom(null), { placed: 0, mined: 0, crafted: 0, cm: 0 });
  assert.deepEqual(countersFrom({}), { placed: 0, mined: 0, crafted: 0, cm: 0 });
  assert.deepEqual(countersFrom({ stats: {} }), { placed: 0, mined: 0, crafted: 0, cm: 0 });
});

test('a stats reset pays out nothing rather than going backwards', () => {
  // World reset, stats wiped: the new reading is SMALLER than the last one.
  // The baseline then moves to 5, so ordinary earning resumes from there.
  const d = deltaOf({ placed: 5, mined: 0, crafted: 0, cm: 0 },
    { placed: 900, mined: 400, crafted: 0, cm: 0 });
  assert.deepEqual(d, { placed: 0, mined: 0, crafted: 0, cm: 0 });
  assert.deepEqual(deltaOf({ placed: 60, mined: 0, crafted: 0, cm: 0 },
    { placed: 5, mined: 0, crafted: 0, cm: 0 }),
  { placed: 55, mined: 0, crafted: 0, cm: 0 });
});

// --- what earns what ----------------------------------------------------------

test('placed mode pays for placing and nothing else', () => {
  const { rates } = readConfig({ REWARDS_MODE: 'credits', REWARDS_EARN: 'placed' });
  const delta = { placed: 200, mined: 500, crafted: 30, cm: 100000 };
  assert.equal(pointsFor(delta, rates), 200);
});

test('mixed mode pays for placing, mining, crafting and travel', () => {
  const { rates } = readConfig({ REWARDS_MODE: 'credits', REWARDS_EARN: 'mixed' });
  // 200 placed + 500 mined*0.5 + 30 crafted*2 + 10 hundred-metres*0.5
  assert.equal(pointsFor({ placed: 200, mined: 500, crafted: 30, cm: 100000 }, rates),
    200 + 250 + 60 + 5);
});

test('granted mode earns nothing in game at all', () => {
  const { rates } = readConfig({ REWARDS_MODE: 'credits', REWARDS_EARN: 'granted' });
  assert.equal(pointsFor({ placed: 5000, mined: 5000, crafted: 5000, cm: 9e6 }, rates), 0);
});

test('time online is never worth anything, in any mode', () => {
  for (const earn of ['placed', 'mixed', 'granted']) {
    const { rates } = readConfig({ REWARDS_MODE: 'credits', REWARDS_EARN: earn });
    const idle = countersFrom(stats({}, {}, {}, { 'minecraft:play_time': 9_000_000 }));
    assert.equal(pointsFor(deltaOf(idle, { placed: 0, mined: 0, crafted: 0, cm: 0 }), rates), 0,
      `${earn} must not pay for sitting still`);
  }
});

test('an unknown mode or earn source falls back to something safe', () => {
  assert.equal(readConfig({ REWARDS_MODE: 'nonsense' }).mode, 'off');
  assert.equal(readConfig({ REWARDS_MODE: 'both', REWARDS_EARN: 'nonsense' }).earn, 'placed');
  assert.equal(readConfig({}).mode, 'off', 'rewards must be off unless asked for');
});

// --- ranks --------------------------------------------------------------------

test('rank climbs with lifetime points and stops at the top', () => {
  const t = [0, 2000, 10000, 40000];
  assert.equal(rankFor(0, t).name, 'Apprentice');
  assert.equal(rankFor(1999, t).name, 'Apprentice');
  assert.equal(rankFor(2000, t).name, 'Builder');
  assert.equal(rankFor(39999, t).name, 'Architect');
  assert.equal(rankFor(999999, t).name, 'Master');
  assert.equal(rankFor(999999, t).next, null);
  assert.equal(rankFor(0, t).next.toGo, 2000);
});

test('a rank can narrow the size envelope but never widen it', () => {
  const r = ledger({ REWARDS_MODE: 'ranks' });
  const server = { maxBlocks: 400000, maxExtent: 120, maxOps: 400 };
  const beginner = r.limitsFor('Kid', server);
  assert.equal(beginner.maxBlocks, 8000, 'an apprentice gets the small envelope');
  assert.equal(beginner.maxExtent, 40);
  assert.equal(beginner.maxOps, 400, 'untouched limits pass through');

  r.grant('Kid', 100000);                       // straight to Master
  const master = r.limitsFor('Kid', server);
  assert.equal(master.maxBlocks, 400000, 'the top rank still cannot exceed the server limit');
  assert.equal(master.maxExtent, 120);

  // A tighter server envelope wins over the rank in both directions.
  const tight = r.limitsFor('Kid', { maxBlocks: 5000, maxExtent: 24, maxOps: 10 });
  assert.equal(tight.maxBlocks, 5000);
  assert.equal(tight.maxExtent, 24);
});

// --- pricing ------------------------------------------------------------------

test('a build is priced by how big it actually turned out', () => {
  const cfg = readConfig({ REWARDS_MODE: 'credits' });
  assert.deepEqual(priceFor(900, cfg), { band: 'small', price: 150 });
  assert.deepEqual(priceFor(3000, cfg), { band: 'small', price: 150 });
  assert.deepEqual(priceFor(3001, cfg), { band: 'medium', price: 400 });
  assert.deepEqual(priceFor(29999, cfg), { band: 'medium', price: 400 });
  assert.deepEqual(priceFor(200000, cfg), { band: 'large', price: 900 });
});

// --- the ledger ---------------------------------------------------------------

test('with rewards off, nothing is checked, charged or capped', () => {
  const r = ledger({ REWARDS_MODE: 'off' });
  assert.equal(r.enabled(), false);
  assert.equal(r.check('Kid'), null);
  assert.equal(r.quote('Kid', 500000).price, 0);
  assert.equal(r.quote('Kid', 500000).affordable, true);
  const server = { maxBlocks: 400000, maxExtent: 120 };
  assert.deepEqual(r.limitsFor('Kid', server), server);
});

test('a new player starts with exactly one small build in the bank', () => {
  const r = ledger({ REWARDS_MODE: 'credits' });
  assert.equal(r.summary('Kid').credits, 150);
  assert.equal(r.check('Kid'), null, 'and is not stonewalled on arrival');
  const q = r.quote('Kid', 900);
  assert.ok(q.affordable);
  r.charge('Kid', q.price);
  assert.equal(r.summary('Kid').credits, 0);
  // ...and now the cheap gate closes before any model is called.
  assert.match(r.check('Kid'), /smallest build costs 150/);
});

test('an unaffordable build is refused with the size named', () => {
  const r = ledger({ REWARDS_MODE: 'credits' });
  const q = r.quote('Kid', 200000);
  assert.equal(q.band, 'large');
  assert.equal(q.affordable, false, '150 starting credits must not buy a castle');
});

test('credits cannot go negative however hard you charge', () => {
  const r = ledger({ REWARDS_MODE: 'credits' });
  r.charge('Kid', 99999);
  assert.equal(r.summary('Kid').credits, 0);
});

test('exempt players pay nothing and are capped by nothing', () => {
  const r = ledger({ REWARDS_MODE: 'both', REWARDS_EXEMPT: 'Dad,MumsAccount' });
  assert.ok(r.isExempt('dad'), 'the match is case-insensitive');
  assert.equal(r.check('Dad'), null);
  assert.equal(r.quote('Dad', 300000).price, 0);
  const server = { maxBlocks: 400000, maxExtent: 120 };
  assert.deepEqual(r.limitsFor('Dad', server), server);
  // ...while everyone else is still held to the rules.
  assert.equal(r.quote('Kid', 300000).price, 900);
  assert.equal(r.limitsFor('Kid', server).maxBlocks, 8000);
});

test('a grown-up can hand out credits, and they count towards rank', () => {
  const r = ledger({ REWARDS_MODE: 'both' });
  const s = r.grant('Kid', 2000);
  assert.equal(s.credits, 2150);
  assert.equal(s.granted, 2000);
  assert.equal(s.rank.name, 'Builder', 'a job done offline is still a job done');
  assert.throws(() => r.grant('Kid', 0), /How many/);
  assert.throws(() => r.grant('Kid', 'lots'), /How many/);
});

test('granted credits can be kept out of rank when asked', () => {
  const r = ledger({ REWARDS_MODE: 'both', REWARDS_GRANT_RANKS: 'false' });
  const s = r.grant('Kid', 5000);
  assert.equal(s.credits, 5150);
  assert.equal(s.rank.name, 'Apprentice');
});

test('bossbar ids survive names the game allows but resource locations do not', () => {
  // Bedrock players arrive through Floodgate with a leading dot and capitals.
  assert.equal(barId('.BedrockKid'), 'aibuild..bedrockkid');
  assert.equal(barId('Steve_2000'), 'aibuild.steve_2000');
  for (const name of ['.BedrockKid', 'Steve_2000', 'ABC']) {
    assert.match(barId(name), /^[a-z0-9_.-]+$/, `${name} must produce a legal bossbar id`);
  }
});

// --- the poller, against real files on disk ------------------------------------
//
// The whole earning mechanism hangs on reading files the server writes, so
// these exercise the real filesystem path rather than a mocked one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fakeServer(players) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rewards-'));
  const statsDir = path.join(dir, 'world', 'players', 'stats');
  fs.mkdirSync(statsDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'usercache.json'), JSON.stringify(
    Object.keys(players).map((name, i) => ({ name, uuid: `0000000${i}-0000-0000-0009-00000000000${i}` })),
  ));
  const write = (name, counters) => {
    const i = Object.keys(players).indexOf(name);
    fs.writeFileSync(path.join(statsDir, `0000000${i}-0000-0000-0009-00000000000${i}.json`),
      JSON.stringify(stats(
        { 'minecraft:oak_planks': counters.placed || 0 },
        { 'minecraft:stone': counters.mined || 0 },
        {}, {},
      )));
  };
  for (const [name, c] of Object.entries(players)) write(name, c);
  return { dir, write };
}

// A stand-in for the game server: answers `list` and the game-mode probe, and
// records every command so the bossbar can be inspected.
function fakeRcon(online, gameMode = 0) {
  const sent = [];
  return {
    sent,
    async send(cmd) {
      sent.push(cmd);
      if (cmd === 'list') {
        return `There are ${online.length} of a max of 12 players online: ${online.join(', ')}`;
      }
      if (cmd.includes('playerGameType')) {
        return `Kid has the following entity data: ${gameMode}`;
      }
      return '';
    },
  };
}

const onDisk = (env, server) => {
  const state = {};
  const r = createRewards({
    env: {
      REWARDS_MODE: 'both', REWARDS_BOSSBAR: 'false',
      MC_WORLD_DIR: path.join(server.dir, 'world'),
      MC_DATA_DIR_INTERNAL: server.dir,
      ...env,
    },
    state,
    saveState: () => {},
    log: () => {},
  });
  return { rewards: r, state };
};

test('the first sweep only takes a baseline - no windfall for past play', () => {
  // A kid who has played for a year must not be handed a year of credits the
  // moment this is switched on.
  const server = fakeServer({ Kid: { placed: 250000, mined: 90000 } });
  const { rewards } = onDisk({}, server);
  return rewards.poll(fakeRcon(['Kid'])).then(() => {
    assert.equal(rewards.summary('Kid').credits, 150, 'starting credits only');
    assert.equal(rewards.summary('Kid').lifetime, 0);
  });
});

test('the second sweep pays for what was done in between', async () => {
  const server = fakeServer({ Kid: { placed: 1000 } });
  const { rewards } = onDisk({}, server);
  const rcon = fakeRcon(['Kid']);
  await rewards.poll(rcon);                       // baseline at 1000
  server.write('Kid', { placed: 1420 });          // they built 420 blocks
  await rewards.poll(rcon);
  const s = rewards.summary('Kid');
  assert.equal(s.credits, 150 + 420);
  assert.equal(s.lifetime, 420);
  assert.equal(s.earned.placed, 420);
});

test('blocks placed in creative mode earn nothing, and cannot be banked', async () => {
  const server = fakeServer({ Kid: { placed: 1000 } });
  const { rewards } = onDisk({}, server);
  const creative = fakeRcon(['Kid'], 1);
  await rewards.poll(creative);
  server.write('Kid', { placed: 60000 });        // an afternoon in creative
  await rewards.poll(creative);
  assert.equal(rewards.summary('Kid').credits, 150, 'creative placements are free');

  // And the baseline moved on with them, so switching back to survival does
  // not release 59,000 banked credits.
  server.write('Kid', { placed: 60050 });
  await rewards.poll(fakeRcon(['Kid'], 0));
  assert.equal(rewards.summary('Kid').credits, 200, 'only the 50 done in survival');
});

test('grinding is capped per hour', async () => {
  const server = fakeServer({ Kid: { placed: 0 } });
  const { rewards } = onDisk({ REWARDS_MAX_POINTS_PER_HOUR: '500' }, server);
  const rcon = fakeRcon(['Kid']);
  await rewards.poll(rcon);
  server.write('Kid', { placed: 5000 });
  await rewards.poll(rcon);
  assert.equal(rewards.summary('Kid').credits, 150 + 500, 'the hourly cap holds');
  server.write('Kid', { placed: 9000 });
  await rewards.poll(rcon);
  assert.equal(rewards.summary('Kid').credits, 650, 'and keeps holding within the hour');
});

test('promotion is reported once, when it happens', async () => {
  const server = fakeServer({ Kid: { placed: 0 } });
  const { rewards } = onDisk({ REWARDS_MAX_POINTS_PER_HOUR: '100000' }, server);
  const rcon = fakeRcon(['Kid']);
  assert.deepEqual(await rewards.poll(rcon), []);
  server.write('Kid', { placed: 2500 });                  // past the Builder line
  assert.deepEqual(await rewards.poll(rcon), [{ player: 'Kid', rank: 'Builder' }]);
  server.write('Kid', { placed: 2600 });
  assert.deepEqual(await rewards.poll(rcon), [], 'no repeat announcement');
});

test('an exempt player is skipped entirely by the sweep', async () => {
  const server = fakeServer({ Dad: { placed: 0 } });
  const { rewards, state } = onDisk({ REWARDS_EXEMPT: 'Dad' }, server);
  const rcon = fakeRcon(['Dad']);
  await rewards.poll(rcon);
  server.write('Dad', { placed: 5000 });
  await rewards.poll(rcon);
  assert.equal(state.rewards.players.Dad, undefined, 'no ledger entry is even created');
});

test('a player with no stats file yet is skipped, not crashed on', async () => {
  const server = fakeServer({ Kid: { placed: 10 } });
  const { rewards } = onDisk({}, server);
  await rewards.poll(fakeRcon(['Kid', 'NeverJoined']));
  assert.equal(rewards.summary('NeverJoined').lifetime, 0);
});

test('the vanilla stats layout is found as well as the Paper one', async () => {
  // Paper 26 writes <world>/players/stats; older Paper and vanilla use
  // <world>/stats. Whichever is there should be picked up.
  const server = fakeServer({ Kid: { placed: 100 } });
  const vanilla = path.join(server.dir, 'world', 'stats');
  fs.mkdirSync(vanilla, { recursive: true });
  fs.renameSync(path.join(server.dir, 'world', 'players', 'stats', '00000000-0000-0000-0009-000000000000.json'),
    path.join(vanilla, '00000000-0000-0000-0009-000000000000.json'));
  fs.rmSync(path.join(server.dir, 'world', 'players'), { recursive: true });

  const { rewards } = onDisk({}, server);
  const rcon = fakeRcon(['Kid']);
  await rewards.poll(rcon);
  fs.writeFileSync(path.join(vanilla, '00000000-0000-0000-0009-000000000000.json'),
    JSON.stringify(stats({ 'minecraft:oak_planks': 300 })));
  await rewards.poll(rcon);
  assert.equal(rewards.summary('Kid').credits, 150 + 200);
});

test('the bossbar is addressed to one player and stays within its scale', async () => {
  const server = fakeServer({ Kid: { placed: 0 } });
  const { rewards } = onDisk({ REWARDS_BOSSBAR: 'true', REWARDS_MODE: 'credits' }, server);
  const rcon = fakeRcon(['Kid']);
  await rewards.poll(rcon);
  server.write('Kid', { placed: 40 });
  await rewards.poll(rcon);
  const bar = rcon.sent.filter((c) => c.startsWith('bossbar'));
  assert.ok(bar.some((c) => c.startsWith('bossbar add aibuild.kid')));
  assert.ok(bar.some((c) => c === 'bossbar set aibuild.kid players Kid'),
    'the bar must be shown to that player only');
  for (const c of bar.filter((x) => / value \d+$/.test(x))) {
    const v = Number(c.match(/ value (\d+)$/)[1]);
    assert.ok(v >= 0 && v <= 100, `bossbar value ${v} out of range`);
  }
});
