// Safety gate between the model and the server.
//
// The whole security model of this service rests here: the LLM never emits a
// command that gets executed. It emits DATA, this module decides whether that
// data is acceptable, and only then does compile.js turn it into commands.
// An LLM that hallucinates, or a prompt-injected one, can at worst produce a
// plan that gets rejected.

import { planToSpans, spansBounds, totalBlocks } from './compile.js';
import { normaliseMaterial, notABlock } from './blocks.js';

// Minecraft world height limits (1.18+ / 26.x).
export const WORLD_MIN_Y = -64;
export const WORLD_MAX_Y = 319;

// A block id, optionally with blockstates: oak_stairs[facing=north,half=top]
// Anything with whitespace, quotes, braces or backslashes is refused outright -
// those are the characters that would be needed to break out of a /fill and
// smuggle in a second command or an NBT payload.
const MATERIAL_RE = /^[a-z0-9_]+(\[[a-z0-9_]+=[a-z0-9_]+(,[a-z0-9_]+=[a-z0-9_]+)*\])?$/;

// Two tiers.
//
// NEVER: blocks that break the server's own security or the world's integrity.
// A command block can run anything, including /op - that is a privilege
// escalation, not a gameplay choice, so it is not configurable.
const NEVER_BLOCKS = new Set([
  'command_block', 'chain_command_block', 'repeating_command_block',
  'command_block_minecart',
  'structure_block', 'structure_void', 'jigsaw',
  'barrier', 'light', 'bedrock',
  'spawner', 'trial_spawner',
  'end_portal', 'end_portal_frame', 'end_gateway', 'nether_portal',
  'reinforced_deepslate',
]);

// HAZARDS: destructive but legitimate building materials. A volcano needs lava;
// a pirate ship wants a powder keg. Off by default, because they spread and
// destroy - on when the operator says so. Undo still snapshots the region
// first, so an accident is recoverable.
const HAZARD_BLOCKS = new Set([
  'lava', 'flowing_lava', 'lava_bucket',
  'fire', 'soul_fire', 'campfire', 'soul_campfire',
  'tnt', 'tnt_minecart',
  'creaking_heart', 'dragon_egg',
]);

const VALID_OPS = new Set(['layer', 'cuboid', 'cylinder', 'sphere', 'cone', 'pyramid',
  'crenellate', 'roof', 'repeat', 'stairs']);

// Per-op required numeric fields.
const OP_FIELDS = {
  cuboid: ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'],
  cylinder: ['cx', 'cy', 'cz', 'radius', 'height'],
  sphere: ['cx', 'cy', 'cz', 'radius'],
  cone: ['cx', 'cy', 'cz', 'radius', 'height'],
  pyramid: ['cx', 'cy', 'cz', 'radius', 'height'],
  crenellate: ['y'],
  roof: ['x1', 'z1', 'x2', 'z2', 'y'],
  repeat: ['count'],
  layer: ['x', 'y', 'z'],
  stairs: ['x', 'y', 'z', 'steps'],
};

// repeat carries a child op, so validation has to recurse rather than just
// check numbers on the wrapper.
function checkOp(op, limits, allowHazards, depth = 0) {
  if (!op || typeof op !== 'object') throw new ValidationError('op is not an object');
  if (!VALID_OPS.has(op.op)) {
    throw new ValidationError(`unknown op "${op.op}" (allowed: ${[...VALID_OPS].join(', ')})`);
  }
  if (op.orient !== undefined && op.orient !== 'outward' && op.orient !== 'inward') {
    throw new ValidationError(`bad orient: ${JSON.stringify(op.orient)} (allowed: outward, inward)`);
  }
  if (op.op === 'repeat') {
    if (depth > 0) throw new ValidationError('repeat may not contain another repeat');
    const n1 = Number(op.count) || 0;
    const n2 = Number(op.count2 ?? 1) || 1;
    if (!Number.isInteger(n1) || n1 < 1 || n1 > 64) {
      throw new ValidationError(`repeat.count must be 1..64, got ${op.count}`);
    }
    if (n1 * n2 > 128) throw new ValidationError('repeat expands too far (count*count2 > 128)');
    return checkOp(op.child, limits, allowHazards, depth + 1);
  }
  if (op.op === 'layer') {
    // A layer carries its materials in a legend rather than one material field.
    // Models reach for several synonyms; accept them rather than reject a plan
    // that is otherwise fine.
    const legend = op.legend || op.key || op.palette || op.materials;
    const rows = op.rows || op.grid || op.pattern || op.lines;
    if (legend) op.legend = legend;
    if (rows) op.rows = rows;
    if (!legend || typeof legend !== 'object' || Array.isArray(legend)) {
      throw new ValidationError(
        'layer needs "legend": an object mapping single characters to block ids, '
        + `e.g. {"#":"stone_bricks",".":"air"} - got ${JSON.stringify(legend)?.slice(0, 80)}`,
      );
    }
    for (const [ch, mat] of Object.entries(legend)) legend[ch] = checkMaterial(mat, allowHazards);
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new ValidationError('layer needs "rows": an array of equal-length strings');
    }
    if (rows.length > 128) throw new ValidationError('layer has too many rows (max 128)');
    for (const r of rows) {
      if (typeof r !== 'string' || r.length > 128) {
        throw new ValidationError('each layer row must be a string of at most 128 characters');
      }
    }
    for (const f of OP_FIELDS.layer) checkNumber(op, f, limits);
    return true;
  }
  op.material = checkMaterial(op.material, allowHazards);
  if (op.axis !== undefined && !['x', 'y', 'z'].includes(op.axis)) {
    throw new ValidationError(`bad axis: ${JSON.stringify(op.axis)}`);
  }
  if (op.op === 'stairs') {
    if (!['north', 'south', 'east', 'west'].includes(op.dir)) {
      throw new ValidationError(`stairs.dir must be north|south|east|west, got ${JSON.stringify(op.dir)}`);
    }
    if (op.steps < 1) {
      throw new ValidationError(`stairs.steps must be >= 1, got ${op.steps}`);
    }
    if (op.width !== undefined) {
      checkNumber(op, 'width', limits);
      if (op.width < 1) throw new ValidationError(`stairs.width must be >= 1, got ${op.width}`);
    }
  }
  for (const field of OP_FIELDS[op.op]) checkNumber(op, field, limits);
  return true;
}

export class ValidationError extends Error {}

// Rough lightness (0 dark .. 9 light) for the blocks builds actually use.
// Only needs to be good enough to catch "black roof on black wall", which is
// what made a castle read as an undifferentiated dark lump.
const LIGHTNESS = {
  black_concrete: 0, obsidian: 0, coal_block: 0, blackstone: 1, polished_blackstone: 1,
  deepslate: 2, deepslate_bricks: 2, deepslate_tiles: 2, polished_deepslate: 2,
  cobbled_deepslate: 2, dark_prismarine: 2, dark_oak_planks: 2, spruce_planks: 3,
  netherrack: 3, basalt: 2, gray_concrete: 3, tuff: 3,
  stone: 4, cobblestone: 4, andesite: 4, polished_andesite: 5, gravel: 4,
  stone_bricks: 5, mossy_stone_bricks: 4, chiseled_stone_bricks: 5, bricks: 4,
  oak_planks: 6, sandstone: 7, smooth_sandstone: 7, birch_planks: 7,
  diorite: 7, polished_diorite: 8, quartz_block: 8, smooth_quartz: 8,
  white_concrete: 9, snow_block: 9, calcite: 8, bone_block: 8,
  copper_block: 5, oxidized_copper: 5, prismarine: 4, sea_lantern: 8, glowstone: 7,
  grass_block: 4, dirt: 3, mud_bricks: 3, terracotta: 4,
};

const lightnessOf = (mat) => LIGHTNESS[String(mat).split('[')[0].replace(/^minecraft:/, '')];

// Colour family, because lightness alone judges badly: stone walls with oak
// floors read as a fine contrast (grey against brown) even though they sit one
// step apart on a greyscale, whereas deepslate on deepslate does not.
const FAMILY = [
  [/(deepslate|blackstone|obsidian|basalt|coal_block|tuff|gray|grey)/, 'dark-stone'],
  [/(stone|cobble|andesite|diorite|granite|calcite|gravel|smooth_stone)/, 'stone'],
  [/(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|planks|log)/, 'wood'],
  [/(sand|sandstone)/, 'sand'],
  [/(brick|terracotta|mud)/, 'brick'],
  [/(quartz|snow|white|bone)/, 'white'],
  [/(prismarine|copper|lantern|glowstone|amethyst|glass)/, 'accent'],
  [/(grass|dirt|moss|leaves|podzol)/, 'earth'],
  [/(nether|crimson|warped|magma|lava|fire)/, 'nether'],
];
const familyOf = (mat) => {
  const base = String(mat).split('[')[0].replace(/^minecraft:/, '');
  for (const [re, name] of FAMILY) if (re.test(base)) return name;
  return 'other';
};

/**
 * Reject a plan that is all one shade.
 *
 * Asking the model for a five-material palette does not bind - it happily put
 * deepslate walls under a deepslate roof, which is why a castle came out as a
 * black lump with no readable silhouette. Measuring the emitted geometry does
 * bind, and the error text is fed back so the retry fixes it.
 */
const PALETTE_MIN_VOLUME = 5000;

export function paletteNote(spans) {
  const vol = new Map();
  let total = 0;
  for (const s of spans) {
    const base = String(s.material).split('[')[0].replace(/^minecraft:/, '');
    if (base === 'air') continue;
    const v = (s.x2 - s.x1 + 1) * (s.y2 - s.y1 + 1) * (s.z2 - s.z1 + 1);
    vol.set(base, (vol.get(base) || 0) + v);
    total += v;
  }
  // Only a real build needs a palette. A small structure - or a test fixture -
  // is legitimately one material, and demanding four would be nonsense.
  if (total < PALETTE_MIN_VOLUME) return null;

  // A volcano IS black basalt, and it reads brilliantly because it glows. A
  // little lava or glowstone against a dark mass is more contrast than any
  // amount of beige, so let emissive accents satisfy the test on their own.
  const emissive = ['lava', 'fire', 'glowstone', 'shroomlight', 'magma_block',
    'sea_lantern', 'lantern', 'jack_o_lantern', 'froglight', 'campfire',
    'ochre_froglight', 'verdant_froglight', 'pearlescent_froglight'];
  let glow = 0;
  for (const [mat, vv] of vol) if (emissive.some((e) => mat.includes(e))) glow += vv;
  if (glow / total >= 0.01) return null;

  const ranked = [...vol.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length < 3) return `only ${ranked.length} material(s): ${ranked.map((r) => r[0]).join(', ')}`;

  // Judge the materials that actually dominate the view - the top 85% of
  // volume. Trying to guess which mass is "the roof" was unreliable; what
  // matters is whether the bulk of the build is visually varied at all.
  const bulk = [];
  let acc = 0;
  for (const [mat, v] of ranked) {
    bulk.push(mat);
    acc += v;
    if (acc / total >= 0.85) break;
  }


  const families = new Set(bulk.map(familyOf));
  const shades = bulk.map(lightnessOf).filter((n) => n !== undefined);
  const spread = shades.length ? Math.max(...shades) - Math.min(...shades) : 0;

  // Varied if it mixes colour families (grey stone against brown wood) OR
  // spans a real range of light and dark. Only fail when it does neither.
  // A modern yacht IS white; a quartz palace IS white. The failure this rule was
  // written for is a DARK shapeless lump - light monotone reads perfectly well.
  const avg = shades.length ? shades.reduce((a, s) => a + s, 0) / shades.length : 5;
  if (avg >= 6) return null;
  if (families.size < 2 && spread < 3) return `all one shade of ${[...families][0]} (${bulk.join(', ')})`;
  return null;
}

// Returns the material as it should be placed: a renamed id is corrected here
// (sea_grass -> seagrass), and callers write the result back into the plan so
// the compiler places the corrected block. Correction happens FIRST, so every
// check below judges the id that will actually be sent.
function checkMaterial(raw, allowHazards) {
  const material = normaliseMaterial(raw);
  if (typeof material !== 'string' || !MATERIAL_RE.test(material)) {
    throw new ValidationError(`bad material format: ${JSON.stringify(raw)}`);
  }
  const base = material.split('[')[0];
  if (NEVER_BLOCKS.has(base)) {
    throw new ValidationError(`block not allowed: ${base}`);
  }
  const item = notABlock(base);
  if (item) throw new ValidationError(item);
  if (!allowHazards && HAZARD_BLOCKS.has(base)) {
    throw new ValidationError(
      `${base} is switched off on this server (set ALLOW_HAZARD_BLOCKS=true to allow it)`,
    );
  }
  return material;
}

export { NEVER_BLOCKS, HAZARD_BLOCKS };

function checkNumber(op, field, limits) {
  const v = op[field];
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new ValidationError(`${op.op}.${field} must be a whole number, got ${JSON.stringify(v)}`);
  }
  if (Math.abs(v) > limits.maxExtent * 2) {
    throw new ValidationError(`${op.op}.${field} out of range: ${v}`);
  }
  if ((field === 'radius' || field === 'height') && v < 0) {
    throw new ValidationError(`${op.op}.${field} must not be negative: ${v}`);
  }
}

/**
 * Validate a build plan and return the compiled spans plus stats.
 * Throws ValidationError on anything suspicious.
 *
 * @param {object} plan   the model's proposed plan
 * @param {object} origin world coords the build is anchored to
 * @param {object} limits {maxBlocks, maxExtent, maxOps}
 */
export function validatePlan(plan, origin, limits) {
  const { maxBlocks, maxExtent, maxOps = 200, allowHazards = false } = limits;

  if (!plan || typeof plan !== 'object') {
    throw new ValidationError('plan is not an object');
  }
  if (!Array.isArray(plan.ops) || plan.ops.length === 0) {
    throw new ValidationError('plan.ops must be a non-empty array');
  }
  if (plan.ops.length > maxOps) {
    throw new ValidationError(`too many ops: ${plan.ops.length} (max ${maxOps})`);
  }

  for (const op of plan.ops) checkOp(op, limits, allowHazards);

  // From here on we validate the REAL geometry, so an op can't understate its size.
  const spans = planToSpans(plan);
  if (spans.length === 0) throw new ValidationError('plan compiles to nothing');

  const bounds = spansBounds(spans);
  const size = {
    x: bounds.x2 - bounds.x1 + 1,
    y: bounds.y2 - bounds.y1 + 1,
    z: bounds.z2 - bounds.z1 + 1,
  };
  if (size.x > maxExtent || size.y > maxExtent || size.z > maxExtent) {
    throw new ValidationError(
      `build too large: ${size.x}x${size.y}x${size.z} (max ${maxExtent} on any axis)`,
    );
  }
  // The size the player asked for (see size.js). Held exactly like the server
  // limit, so an oversize plan goes back to the model to be redrawn smaller.
  const { budget } = limits;
  if (budget && (size.x > budget.footprint || size.z > budget.footprint || size.y > budget.height)) {
    throw new ValidationError(
      `too big for the size the player asked for: ${size.x} wide x ${size.z} deep x ${size.y} tall, `
      + `but it must fit within ${budget.footprint} x ${budget.footprint} and ${budget.height} tall `
      + `(${budget.reason}). Scale the whole design down - smaller masses, closer together - `
      + 'rather than cropping it.',
    );
  }

  // NB: this sums span volumes, so overlapping ops are counted more than once.
  // A detailed build therefore reads much larger than the volume it occupies -
  // the ceiling is deliberately generous to allow for that.
  const blocks = totalBlocks(spans);
  if (blocks > maxBlocks) {
    throw new ValidationError(`build too heavy: ${blocks} blocks (max ${maxBlocks})`);
  }

  // Deliberately NOT enforced. Taste is the model's job and it is better at it
  // than a regex over material names: the rule kept refusing a white yacht and a
  // black volcano, which are both correct answers. Quality guidance lives in the
  // system prompt now; the validator only decides what is SAFE.
  const note = paletteNote(spans);
  if (note && typeof console !== 'undefined') console.log(`  palette note: ${note}`);

  // World height limits, checked in world coordinates.
  const worldMinY = bounds.y1 + origin.y;
  const worldMaxY = bounds.y2 + origin.y;
  if (worldMinY < WORLD_MIN_Y || worldMaxY > WORLD_MAX_Y) {
    throw new ValidationError(
      `build would extend outside the world (y ${worldMinY}..${worldMaxY}, ` +
      `limits ${WORLD_MIN_Y}..${WORLD_MAX_Y})`,
    );
  }

  // Every distinct block the build will place, so the caller can have the
  // server confirm each one exists before anything is built.
  const materials = [...new Set(spans.map((s) => s.material))].filter((m) => m !== 'air');

  return { spans, bounds, size, blocks, materials };
}
