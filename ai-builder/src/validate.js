// Safety gate between the model and the server.
//
// The whole security model of this service rests here: the LLM never emits a
// command that gets executed. It emits DATA, this module decides whether that
// data is acceptable, and only then does compile.js turn it into commands.
// An LLM that hallucinates, or a prompt-injected one, can at worst produce a
// plan that gets rejected.

import { planToSpans, spansBounds, totalBlocks } from './compile.js';

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

const VALID_OPS = new Set(['cuboid', 'cylinder', 'sphere', 'cone', 'pyramid',
  'crenellate', 'roof', 'repeat']);

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
};

// repeat carries a child op, so validation has to recurse rather than just
// check numbers on the wrapper.
function checkOp(op, limits, allowHazards, depth = 0) {
  if (!op || typeof op !== 'object') throw new ValidationError('op is not an object');
  if (!VALID_OPS.has(op.op)) {
    throw new ValidationError(`unknown op "${op.op}" (allowed: ${[...VALID_OPS].join(', ')})`);
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
  checkMaterial(op.material, allowHazards);
  if (op.axis !== undefined && !['x', 'y', 'z'].includes(op.axis)) {
    throw new ValidationError(`bad axis: ${JSON.stringify(op.axis)}`);
  }
  for (const field of OP_FIELDS[op.op]) checkNumber(op, field, limits);
  return true;
}

export class ValidationError extends Error {}

function checkMaterial(material, allowHazards) {
  if (typeof material !== 'string' || !MATERIAL_RE.test(material)) {
    throw new ValidationError(`bad material format: ${JSON.stringify(material)}`);
  }
  const base = material.split('[')[0].replace(/^minecraft:/, '');
  if (NEVER_BLOCKS.has(base)) {
    throw new ValidationError(`block not allowed: ${base}`);
  }
  if (!allowHazards && HAZARD_BLOCKS.has(base)) {
    throw new ValidationError(
      `${base} is switched off on this server (set ALLOW_HAZARD_BLOCKS=true to allow it)`,
    );
  }
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

  // NB: this sums span volumes, so overlapping ops are counted more than once.
  // A detailed build therefore reads much larger than the volume it occupies -
  // the ceiling is deliberately generous to allow for that.
  const blocks = totalBlocks(spans);
  if (blocks > maxBlocks) {
    throw new ValidationError(`build too heavy: ${blocks} blocks (max ${maxBlocks})`);
  }

  // World height limits, checked in world coordinates.
  const worldMinY = bounds.y1 + origin.y;
  const worldMaxY = bounds.y2 + origin.y;
  if (worldMinY < WORLD_MIN_Y || worldMaxY > WORLD_MAX_Y) {
    throw new ValidationError(
      `build would extend outside the world (y ${worldMinY}..${worldMaxY}, ` +
      `limits ${WORLD_MIN_Y}..${WORLD_MAX_Y})`,
    );
  }

  return { spans, bounds, size, blocks };
}
