import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planToSpans, spansToCommands, spansBounds, totalBlocks, spanVolume, siteFillCommands,
} from '../src/compile.js';
import { validatePlan, ValidationError, WORLD_MAX_Y, paletteNote } from '../src/validate.js';

const LIMITS = { maxBlocks: 150000, maxExtent: 96, maxOps: 200 };
const ORIGIN = { x: 100, y: 64, z: -200 };

const plan = (...ops) => ({ name: 't', summary: 's', ops });

// --- geometry ----------------------------------------------------------------

test('cuboid compiles to a single fill', () => {
  const spans = planToSpans(plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 3, y2: 3, z2: 3, material: 'stone',
  }));
  assert.equal(spans.length, 1);
  const cmds = spansToCommands(spans, ORIGIN);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0], 'fill 100 64 -200 103 67 -197 stone');
});

test('hollow cuboid uses the native hollow mode', () => {
  const cmds = spansToCommands(planToSpans(plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 5, y2: 5, z2: 5, material: 'oak_planks', hollow: true,
  })), ORIGIN);
  assert.equal(cmds.length, 1);
  assert.match(cmds[0], /hollow$/);
});

test('blockstates survive compilation', () => {
  const cmds = spansToCommands(planToSpans(plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0,
    material: 'oak_stairs[facing=north]',
  })), ORIGIN);
  assert.equal(cmds[0], 'fill 100 64 -200 100 64 -200 oak_stairs[facing=north]');
});

test('tall cylinder costs no more commands than a short one (vertical extrusion)', () => {
  const short = planToSpans(plan({
    op: 'cylinder', cx: 0, cy: 0, cz: 0, radius: 6, height: 1, material: 'stone_bricks', hollow: true,
  }));
  const tall = planToSpans(plan({
    op: 'cylinder', cx: 0, cy: 0, cz: 0, radius: 6, height: 40, material: 'stone_bricks', hollow: true,
  }));
  assert.equal(short.length, tall.length,
    'a 40-tall tower should extrude the same spans as a 1-tall ring');
  assert.ok(tall.length < 40, `expected a handful of spans, got ${tall.length}`);
});

test('hollow cylinder wall is one block thick and encloses the interior', () => {
  const r = 8;
  const spans = planToSpans(plan({
    op: 'cylinder', cx: 0, cy: 0, cz: 0, radius: r, height: 1, material: 'stone', hollow: true,
  }));
  // Rasterise the ring and check the centre is empty but the rim is filled.
  const filled = new Set();
  for (const s of spans) {
    for (let x = s.x1; x <= s.x2; x++) for (let z = s.z1; z <= s.z2; z++) filled.add(`${x},${z}`);
  }
  assert.ok(!filled.has('0,0'), 'centre of a hollow cylinder must be empty');
  assert.ok(filled.has(`${r},0`), 'rim must be filled');
  assert.ok(!filled.has(`${r - 2},0`), 'wall should not be 3 blocks thick');
});

test('solid cylinder fills its centre', () => {
  const spans = planToSpans(plan({
    op: 'cylinder', cx: 0, cy: 0, cz: 0, radius: 5, height: 3, material: 'stone',
  }));
  const covers = spans.some((s) => s.x1 <= 0 && s.x2 >= 0 && s.z1 <= 0 && s.z2 >= 0);
  assert.ok(covers, 'solid cylinder must cover its axis');
});

test('sphere is bounded by its radius and roughly spherical in volume', () => {
  const r = 10;
  const spans = planToSpans(plan({
    op: 'sphere', cx: 0, cy: 0, cz: 0, radius: r, material: 'glass',
  }));
  const b = spansBounds(spans);
  assert.equal(b.x1, -r); assert.equal(b.x2, r);
  assert.equal(b.y1, -r); assert.equal(b.y2, r);
  const ideal = (4 / 3) * Math.PI * r ** 3;
  const actual = totalBlocks(spans);
  assert.ok(Math.abs(actual - ideal) / ideal < 0.15,
    `sphere volume ${actual} should be within 15% of ${ideal.toFixed(0)}`);
});

test('cone tapers to a point', () => {
  const spans = planToSpans(plan({
    op: 'cone', cx: 0, cy: 0, cz: 0, radius: 6, height: 6, material: 'bricks',
  }));
  const top = spans.filter((s) => s.y1 === 5);
  const width = Math.max(...top.map((s) => s.x2 - s.x1 + 1));
  assert.ok(width <= 3, `cone tip should be narrow, got width ${width}`);
});

test('oversized fills are split under the 32768-block engine limit', () => {
  const cmds = spansToCommands(planToSpans(plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 63, y2: 63, z2: 63, material: 'dirt', // 262144
  })), ORIGIN);
  assert.ok(cmds.length >= 8, `expected several fills, got ${cmds.length}`);
  const spans = planToSpans(plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 63, y2: 63, z2: 63, material: 'dirt',
  }));
  assert.equal(totalBlocks(spans), 262144);
});

test('later ops overwrite earlier ones (air cuts a doorway)', () => {
  const spans = planToSpans(plan(
    { op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 4, y2: 4, z2: 4, material: 'stone' },
    { op: 'cuboid', x1: 1, y1: 0, z1: 0, x2: 2, y2: 2, z2: 0, material: 'air' },
  ));
  assert.equal(spans.at(-1).material, 'air', 'air cut must be emitted last');
});

// --- validation: the security boundary ---------------------------------------

test('accepts a reasonable build', () => {
  const r = validatePlan(plan({
    op: 'cylinder', cx: 0, cy: 0, cz: 0, radius: 5, height: 20,
    material: 'stone_bricks', hollow: true,
  }), ORIGIN, LIMITS);
  assert.ok(r.blocks > 0);
  assert.ok(r.size.y === 20);
});

test('rejects banned blocks', () => {
  for (const bad of ['lava', 'tnt', 'bedrock', 'command_block', 'barrier', 'spawner']) {
    assert.throws(
      () => validatePlan(plan({
        op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1, material: bad,
      }), ORIGIN, LIMITS),
      ValidationError,
      `${bad} should be rejected`,
    );
  }
});

test('rejects banned blocks hiding behind a namespace prefix', () => {
  assert.throws(() => validatePlan(plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1, material: 'minecraft:lava',
  }), ORIGIN, LIMITS), ValidationError);
});

test('rejects command injection attempts in the material field', () => {
  const attacks = [
    'stone\nop @a',                       // newline smuggling a second command
    'stone run say pwned',                // whitespace
    'stone{Command:"/op @a"}',            // NBT payload
    'stone" ',                            // quote break-out
    'stone\\',                            // backslash
    '../../etc/passwd',
  ];
  for (const material of attacks) {
    assert.throws(
      () => validatePlan(plan({
        op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1, material,
      }), ORIGIN, LIMITS),
      ValidationError,
      `should reject material ${JSON.stringify(material)}`,
    );
  }
});

test('rejects builds that are too large on any axis', () => {
  assert.throws(() => validatePlan(plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 200, y2: 1, z2: 1, material: 'stone',
  }), ORIGIN, LIMITS), ValidationError);
});

test('rejects builds over the block budget', () => {
  assert.throws(() => validatePlan(plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 90, y2: 90, z2: 90, material: 'stone',
  }), ORIGIN, { ...LIMITS, maxBlocks: 1000 }), ValidationError);
});

test('rejects builds that would breach the world height limit', () => {
  assert.throws(() => validatePlan(plan({
    op: 'cylinder', cx: 0, cy: 0, cz: 0, radius: 2, height: 90, material: 'stone',
  }), { x: 0, y: WORLD_MAX_Y - 10, z: 0 }, LIMITS), ValidationError);
});

test('rejects unknown ops and malformed numbers', () => {
  assert.throws(() => validatePlan(plan({ op: 'nuke', material: 'stone' }), ORIGIN, LIMITS),
    ValidationError);
  assert.throws(() => validatePlan(plan({
    op: 'cuboid', x1: 'NaN', y1: 0, z1: 0, x2: 1, y2: 1, z2: 1, material: 'stone',
  }), ORIGIN, LIMITS), ValidationError);
  assert.throws(() => validatePlan(plan({
    op: 'cuboid', x1: 0.5, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1, material: 'stone',
  }), ORIGIN, LIMITS), ValidationError);
});

test('rejects empty or malformed plans', () => {
  assert.throws(() => validatePlan({ ops: [] }, ORIGIN, LIMITS), ValidationError);
  assert.throws(() => validatePlan(null, ORIGIN, LIMITS), ValidationError);
  assert.throws(() => validatePlan({ ops: 'not an array' }, ORIGIN, LIMITS), ValidationError);
});

test('validation measures real geometry, not what the plan claims', () => {
  // A single small-looking op that actually rasterises to a huge sphere.
  assert.throws(() => validatePlan(plan({
    op: 'sphere', cx: 0, cy: 0, cz: 0, radius: 60, material: 'stone',
  }), ORIGIN, { ...LIMITS, maxBlocks: 50000 }), ValidationError);
});

// --- chat parsing ------------------------------------------------------------

const CHAT_RE = /^\[[\d:]+(?: [^\]]*)? INFO\]:?\s*(?:\[Not Secure\]\s*)?<([A-Za-z0-9_.]{1,32})> (.+)$/;

test('parses every chat line shape Paper actually emits', () => {
  const cases = [
    ['[12:34:56 INFO]: <SteveBuilder> !build a castle', 'SteveBuilder', '!build a castle'],
    // Floodgate prefixes Bedrock players with a dot.
    ['[12:34:56 INFO]: <.BedrockKid> !undo', '.BedrockKid', '!undo'],
    // Unsigned chat (1.19+) - the variant that silently breaks a naive regex.
    ['[12:34:56 INFO]: [Not Secure] <SteveBuilder> !build a hut', 'SteveBuilder', '!build a hut'],
    // Paper includes the thread name in some configurations.
    ['[12:34:56 Async Chat Thread - #0 INFO]: <Kid> !help', 'Kid', '!help'],
  ];
  for (const [line, player, text] of cases) {
    const m = line.match(CHAT_RE);
    assert.ok(m, `should match: ${line}`);
    assert.equal(m[1], player);
    assert.equal(m[2], text);
  }
});

test('ignores non-chat log lines', () => {
  for (const line of [
    '[12:34:56 INFO]: Done (12.345s)! For help, type "help"',
    '[12:34:56 WARN]: <Player> something',
    '[12:34:56 INFO]: Player joined the game',
  ]) {
    assert.equal(line.match(CHAT_RE), null, `should not match: ${line}`);
  }
});

// --- local-network trust (web panel auth bypass) -----------------------------

import { isLocalAddress, normaliseIp } from '../src/web.js';

test('normalises IPv4-mapped IPv6 addresses', () => {
  assert.equal(normaliseIp('::ffff:10.0.0.85'), '10.0.0.85');
  assert.equal(normaliseIp('::1'), '127.0.0.1');
  assert.equal(normaliseIp('10.0.0.85'), '10.0.0.85');
});

test('treats private and loopback addresses as local', () => {
  for (const ip of [
    '127.0.0.1', '10.0.0.85', '10.255.255.254', '192.168.1.20',
    '172.16.0.1', '172.31.255.254', '169.254.1.1',
    '100.64.1.1',           // CGNAT range used by mesh VPNs
    '::ffff:10.0.0.85',         // IPv4-mapped
  ]) {
    assert.ok(isLocalAddress(ip), `${ip} should be treated as local`);
  }
});

test('never treats public addresses as local', () => {
  for (const ip of [
    '8.8.8.8', '1.1.1.1', '203.0.113.7', '172.32.0.1', // just outside 172.16/12
    '172.15.255.255', '11.0.0.1', '192.169.0.1', '99.64.0.1', '100.128.0.1',
  ]) {
    assert.ok(!isLocalAddress(ip), `${ip} must NOT be treated as local`);
  }
});

test('respects a custom CIDR allowlist', () => {
  assert.ok(isLocalAddress('192.168.5.10', ['192.168.5.0/24']));
  assert.ok(!isLocalAddress('192.168.6.10', ['192.168.5.0/24']));
  assert.ok(!isLocalAddress('10.0.0.1', ['192.168.5.0/24']));
});

test('malformed addresses are never local', () => {
  for (const ip of ['', 'not-an-ip', '999.999.999.999', 'fe80::1']) {
    assert.ok(!isLocalAddress(ip), `${ip} must not be local`);
  }
});

// --- reverse-proxy trust -----------------------------------------------------
// The failure mode being guarded against: behind a proxy every request arrives
// from a private address, so trusting the socket blindly would let the whole
// internet in without a password.

import { clientAddress } from '../src/web.js';

const req = (peer, xff) => ({
  socket: { remoteAddress: peer },
  headers: xff ? { 'x-forwarded-for': xff } : {},
});

test('ignores X-Forwarded-For when no proxy is trusted', () => {
  // Anyone can send this header, so unconfigured means unbelieved.
  assert.equal(clientAddress(req('10.0.0.184', '8.8.8.8'), []), '10.0.0.184');
  assert.equal(clientAddress(req('203.0.113.9', '10.0.0.5'), []), '203.0.113.9');
});

test('uses X-Forwarded-For only from a declared proxy', () => {
  const proxies = ['10.0.0.184/32'];
  assert.equal(clientAddress(req('10.0.0.184', '8.8.8.8'), proxies), '8.8.8.8');
  // ...and not from anyone else claiming to be one.
  assert.equal(clientAddress(req('10.0.0.99', '8.8.8.8'), proxies), '10.0.0.99');
});

test('a spoofed header cannot buy a public client a free pass', () => {
  const proxies = ['10.0.0.184/32'];
  // Internet client, straight to the panel, lying about being on the LAN.
  const ip = clientAddress(req('203.0.113.9', '10.0.0.5'), proxies);
  assert.equal(ip, '203.0.113.9');
  assert.ok(!isLocalAddress(ip), 'a spoofing public client must never look local');
});

test('walks back past chained proxies to the real client', () => {
  const proxies = ['10.0.0.0/8'];
  assert.equal(clientAddress(req('10.0.0.184', '8.8.8.8, 10.0.0.7, 10.0.0.184'), proxies), '8.8.8.8');
});

test('internet client through a trusted proxy is still challenged', () => {
  const proxies = ['10.0.0.184/32'];
  assert.ok(!isLocalAddress(clientAddress(req('10.0.0.184', '203.0.113.9'), proxies)));
  // while a genuine LAN client through the same proxy is not
  assert.ok(isLocalAddress(clientAddress(req('10.0.0.184', '10.0.0.63'), proxies)));
});

// --- oversized shaped fills --------------------------------------------------
// The failure this guards against is silent: Minecraft refuses a >32768-block
// fill and says nothing, so a large hollow room simply never appeared.

test('an oversized hollow cuboid is exploded into faces, not dropped', () => {
  const big = plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 45, y2: 30, z2: 45,   // 45k+ blocks
    material: 'stone_bricks', hollow: true,
  });
  const cmds = spansToCommands(planToSpans(big), ORIGIN);
  assert.ok(cmds.length >= 6, `expected at least 6 faces, got ${cmds.length}`);
  assert.ok(!cmds.some((c) => / hollow$/.test(c)),
    'oversized hollow must not be emitted as a single native hollow fill');
  // every emitted fill must be within the engine limit
  for (const c of cmds) {
    const [, x1, y1, z1, x2, y2, z2] = c.match(/fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/).map(Number);
    const vol = (Math.abs(x2 - x1) + 1) * (Math.abs(y2 - y1) + 1) * (Math.abs(z2 - z1) + 1);
    assert.ok(vol <= 32768, `fill of ${vol} blocks exceeds the engine limit`);
  }
});

test('a hollow cuboid that fits still uses the native single fill', () => {
  const cmds = spansToCommands(planToSpans(plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 10, y2: 10, z2: 10, material: 'stone', hollow: true,
  })), ORIGIN);
  assert.equal(cmds.length, 1);
  assert.match(cmds[0], /hollow$/);
});

// --- new ops -----------------------------------------------------------------
// These exist because five upright primitives could not express architecture:
// no arches, no pitched roofs, no battlements without 40 hand-placed cuboids.

test('a cylinder can lie down (axis) — this is what makes arches possible', () => {
  const vert = planToSpans(plan({
    op: 'cylinder', cx: 0, cy: 0, cz: 0, radius: 4, height: 20, material: 'stone',
  }));
  const horiz = planToSpans(plan({
    op: 'cylinder', cx: 0, cy: 0, cz: 0, radius: 4, height: 20, material: 'stone', axis: 'x',
  }));
  const bv = spansBounds(vert); const bh = spansBounds(horiz);
  assert.equal(bv.y2 - bv.y1 + 1, 20, 'vertical cylinder is 20 tall');
  assert.equal(bh.x2 - bh.x1 + 1, 20, 'x-axis cylinder is 20 long in x');
  assert.ok(bh.y2 - bh.y1 + 1 <= 9, 'and only as tall as its diameter');
  assert.equal(vert.length, horiz.length, 'same span count either way');
});

test('crenellate rings a rectangle with merlons', () => {
  const spans = planToSpans(plan({
    op: 'crenellate', x1: 0, z1: 0, x2: 20, z2: 20, y: 10, material: 'stone_bricks',
    period: 4, merlon: 2, height: 2,
  }));
  assert.ok(spans.length >= 8, `expected merlons around the edge, got ${spans.length}`);
  const b = spansBounds(spans);
  assert.equal(b.y1, 10);
  assert.equal(b.y2, 11);
  // gaps must exist - a solid parapet is not a battlement
  const covered = new Set();
  for (const s of spans) for (let x = s.x1; x <= s.x2; x++) covered.add(`${x},${s.z1}`);
  assert.ok(covered.size < 21 * 4, 'merlons must leave gaps between them');
});

test('a gable roof steps inward as it rises', () => {
  const spans = planToSpans(plan({
    op: 'roof', x1: 0, z1: 0, x2: 20, z2: 14, y: 10, style: 'gable', ridge: 'z',
    material: 'deepslate_tiles', pitch: 1, overhang: 1,
  }));
  assert.ok(spans.length >= 4);
  // A shell roof emits several thin spans per course, so compare the EXTENT of
  // the lowest course against the highest, not one span against another.
  const extentAt = (y) => {
    const at = spans.filter((s) => s.y1 === y);
    return Math.max(...at.map((s) => s.x2)) - Math.min(...at.map((s) => s.x1));
  };
  const top = Math.max(...spans.map((s) => s.y1));
  assert.ok(extentAt(top) < extentAt(10), 'the ridge must be narrower than the eaves');
});

test('repeat multiplies its child along a step', () => {
  const spans = planToSpans(plan({
    op: 'repeat', count: 5, step: { dx: 6, dy: 0, dz: 0 },
    child: { op: 'cylinder', cx: 0, cy: 0, cz: 0, radius: 1, height: 8, material: 'stone' },
  }));
  const b = spansBounds(spans);
  assert.ok(b.x2 - b.x1 >= 24, 'five columns six apart should span 24+ blocks');
});

test('repeat cannot nest, and is bounded', () => {
  const L = { maxBlocks: 400000, maxExtent: 96, maxOps: 400 };
  assert.throws(() => validatePlan(plan({
    op: 'repeat', count: 2, step: { dx: 1 },
    child: { op: 'repeat', count: 2, step: { dx: 1 }, child: { op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1, material: 'stone' } },
  }), ORIGIN, L), ValidationError);
  assert.throws(() => validatePlan(plan({
    op: 'repeat', count: 200, step: { dx: 1 },
    child: { op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1, material: 'stone' },
  }), ORIGIN, L), ValidationError);
});

test('hazard blocks are gated by the allowHazards flag, command blocks never', () => {
  const base = { maxBlocks: 400000, maxExtent: 96, maxOps: 400 };
  const lava = plan({ op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1, material: 'lava' });
  assert.throws(() => validatePlan(lava, ORIGIN, { ...base, allowHazards: false }), ValidationError);
  assert.ok(validatePlan(lava, ORIGIN, { ...base, allowHazards: true }).blocks > 0);
  const cb = plan({ op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1, material: 'command_block' });
  assert.throws(() => validatePlan(cb, ORIGIN, { ...base, allowHazards: true }), ValidationError);
});

// --- stairs and orient --------------------------------------------------------

test('a stairs flight rises one block per step and its treads carry facing', () => {
  const spans = planToSpans(plan({
    op: 'stairs', x: 0, y: 0, z: 0, dir: 'south', steps: 5, width: 2, material: 'oak_stairs',
  }));
  const treads = spans.filter((s) => s.material.includes('facing=south'));
  assert.equal(treads.length, 5, 'one tread per step');
  for (const t of treads) assert.ok(t.material.includes('half=bottom'));
  assert.deepEqual(treads.map((t) => t.y1).sort((a, b) => a - b), [0, 1, 2, 3, 4],
    'each step rises exactly one block');
  assert.deepEqual(treads.map((t) => t.z1).sort((a, b) => a - b), [0, 1, 2, 3, 4],
    'and advances one block along dir (south = +z)');
  for (const t of treads) assert.equal(t.x2 - t.x1 + 1, 2, 'tread is `width` wide across the climb');
  // and the flight is walkable: air is cut above each tread
  const air = spans.filter((s) => s.material === 'air');
  assert.equal(air.length, 5);
  for (const a of air) assert.equal(a.y2 - a.y1 + 1, 3, 'three blocks of headroom');
});

test('a stairs op given a material with states still produces one valid blockstate', () => {
  const spans = planToSpans(plan({
    op: 'stairs', x: 0, y: 0, z: 0, dir: 'east', steps: 1, material: 'oak_stairs[facing=north]',
  }));
  assert.equal(spans[0].material, 'oak_stairs[facing=east,half=bottom]');
});

test('stairs support columns reach down to the base y', () => {
  const spans = planToSpans(plan({
    op: 'stairs', x: 0, y: 10, z: 0, dir: 'east', steps: 4, width: 1, material: 'stone_bricks',
  }));
  const supports = spans.filter((s) => s.material === 'stone_bricks');
  assert.equal(supports.length, 3, 'the ground-level tread needs no column');
  for (const s of supports) assert.equal(s.y1, 10, 'every column reaches the base y');
  const tallest = supports.find((s) => s.y2 === 12);
  assert.ok(tallest, 'the top tread (y=13) stands on a 10..12 column');
  // support: false turns the columns off entirely
  const bare = planToSpans(plan({
    op: 'stairs', x: 0, y: 10, z: 0, dir: 'east', steps: 4, width: 1,
    material: 'stone_bricks', support: false,
  }));
  assert.ok(!bare.some((s) => s.material === 'stone_bricks' && s.y2 - s.y1 > 0));
});

test('orient injects an outward facing on stair materials', () => {
  const spans = planToSpans(plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 4, y2: 0, z2: 4,
    material: 'oak_stairs', orient: 'outward',
  }));
  const facing = (s) => (s.material.match(/facing=(\w+)/) || [])[1];
  const west = spans.filter((s) => facing(s) === 'west');
  const east = spans.filter((s) => facing(s) === 'east');
  const north = spans.filter((s) => facing(s) === 'north');
  const south = spans.filter((s) => facing(s) === 'south');
  assert.ok(west.length && east.length && north.length && south.length,
    'all four outward normals should appear');
  assert.ok(west.every((s) => s.x1 === 0 && s.x2 === 0), 'west face hugs x=0');
  assert.ok(east.every((s) => s.x1 === 4 && s.x2 === 4), 'east face hugs x=4');
  const interior = spans.filter((s) => !facing(s));
  assert.ok(interior.length > 0, 'interior blocks keep the plain material');
  assert.ok(interior.every((s) => s.x1 >= 1 && s.x2 <= 3 && s.z1 >= 1 && s.z2 <= 3));
});

test('orient=inward flips the normal, and slabs get a type instead', () => {
  const spans = planToSpans(plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 2, y2: 0, z2: 0,
    material: 'oak_stairs', orient: 'inward',
  }));
  const west = spans.find((s) => s.x1 === 0);
  assert.match(west.material, /facing=east/, 'inward faces away from the outward normal');
  const slabs = planToSpans(plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 4, y2: 0, z2: 4,
    material: 'stone_slab', orient: 'outward',
  }));
  assert.ok(slabs.every((s) => s.material === 'stone_slab[type=top]'));
});

test('orient leaves plain blocks like stone_bricks unchanged', () => {
  const spans = planToSpans(plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 4, y2: 2, z2: 4,
    material: 'stone_bricks', orient: 'outward',
  }));
  assert.equal(spans.length, 1, 'no face splitting for a non-stair material');
  assert.equal(spans[0].material, 'stone_bricks');
});

test('validation rejects a bad stairs dir and a bad orient value', () => {
  assert.throws(() => validatePlan(plan({
    op: 'stairs', x: 0, y: 0, z: 0, dir: 'up', steps: 4, material: 'oak_stairs',
  }), ORIGIN, LIMITS), ValidationError);
  assert.throws(() => validatePlan(plan({
    op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1,
    material: 'oak_stairs', orient: 'sideways',
  }), ORIGIN, LIMITS), ValidationError);
  // and a well-formed flight passes
  assert.ok(validatePlan(plan({
    op: 'stairs', x: 0, y: 0, z: 0, dir: 'north', steps: 6, material: 'oak_stairs',
  }), ORIGIN, LIMITS).blocks > 0);
});

// Taste is the model's job. The validator used to refuse a white yacht and a
// black volcano for being "one shade" - both correct answers - so a monochrome
// build is now allowed through and merely noted.
test('a monochrome build is allowed, not rejected', () => {
  const plan = { name: 'yacht', ops: [
    { op: 'cuboid', x1: 0, y1: 0, z1: 0, x2: 30, y2: 8, z2: 14, material: 'white_concrete' },
  ] };
  assert.doesNotThrow(() => validatePlan(plan, { x: 0, y: 80, z: 0 },
    { maxBlocks: 400000, maxExtent: 120, maxOps: 400 }));
});

test('paletteNote flags a dark monotone build without blocking it', () => {
  const spans = [{ x1: 0, y1: 0, z1: 0, x2: 40, y2: 20, z2: 40, material: 'deepslate' }];
  assert.match(paletteNote(spans) || '', /deepslate/);
});

test('paletteNote stays quiet when lava lights a dark build', () => {
  const spans = [
    { x1: 0, y1: 0, z1: 0, x2: 40, y2: 20, z2: 40, material: 'blackstone' },
    { x1: 10, y1: 0, z1: 10, x2: 20, y2: 20, z2: 20, material: 'lava' },
  ];
  assert.equal(paletteNote(spans), null);
});

// --- site preparation --------------------------------------------------------

// Which block a fill command puts at a given height, or undefined if none covers it.
const blockAt = (cmds, y) => {
  for (const c of cmds) {
    const [, , y1, , , y2, , block] = c.split(' ');
    if (y >= Number(y1) && y <= Number(y2)) return block;
  }
  return undefined;
};

test('site fill never raises material above the ground line on a small site', () => {
  // A 29x29 site: the old row-chunked loop filled 62..99 with sand here,
  // because the chunk took its block from its bottom row.
  const region = { x1: 6, y1: 62, z1: 286, x2: 34, y2: 108, z2: 314 };
  const cmds = siteFillCommands(region, 68, 'sand');
  assert.equal(blockAt(cmds, 62), 'sand');
  assert.equal(blockAt(cmds, 68), 'sand');
  assert.equal(blockAt(cmds, 69), 'air');
  assert.equal(blockAt(cmds, 99), 'air');
  assert.equal(blockAt(cmds, 108), 'air');
});

test('site fill covers every row exactly once and respects the fill limit', () => {
  const region = { x1: -64, y1: 98, z1: 46, x2: 64, y2: 144, z2: 174 };
  const cmds = siteFillCommands(region, 104, 'grass_block');
  for (let y = region.y1; y <= region.y2; y++) {
    const covering = cmds.filter((c) => blockAt([c], y) !== undefined);
    assert.equal(covering.length > 0, true, `row ${y} not filled`);
    assert.equal(blockAt(cmds, y), y <= 104 ? 'grass_block' : 'air', `row ${y}`);
  }
  for (const c of cmds) {
    const [, x1, y1, z1, x2, y2, z2] = c.split(' ').map(Number);
    assert.ok((x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1) <= 32768, c);
  }
});
