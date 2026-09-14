// The details pass: doors, beds, and everything that hangs off a wall.
//
// Two finished houses from a live session were scanned block by block and had
// no doors at all, and the cottage had three bed blocks - broken halves. The
// compiler only ever emitted /fill, and a fill can't place either half of a
// two-block thing properly; the torch placed before the wall it hangs on falls
// off for the same reason. So the plan is split in two:
//
//   structure - every ordinary block, placed by fill in op order, as before
//   details   - doors, beds and fragile blocks, placed AFTER all structure, so
//               whatever they hang on or stand on already exists
//
// This module does the split and fills in what the model left out (which way a
// door faces, which side its hinge is). It works on local coordinates and
// never builds a command: compile.js turns the result into setblocks.

import { baseOf, statesOf, isDoor, isBed, isFragile } from './blocks.js';

export const FACINGS = ['north', 'south', 'east', 'west'];
export const HINGES = ['left', 'right'];
export const STEP = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
// The side on your left as you walk through a door facing this way.
const LEFT_OF = { north: 'west', south: 'east', east: 'north', west: 'south' };

// A door or bed fill the size of a room is not a door; stop reading cells long
// before that becomes expensive. The validator caps the real counts.
const MAX_CELLS = 512;
// A fragile block cut up by many later ops can fragment badly; beyond this it
// is placed whole rather than risk a combinatorial blow-up.
const MAX_PIECES = 512;

const key = (x, y, z) => `${x},${y},${z}`;
const inside = (s, x, y, z) => x >= s.x1 && x <= s.x2 && y >= s.y1 && y <= s.y2 && z >= s.z1 && z <= s.z2;
const overlaps = (a, b) => a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1
  && a.z1 <= b.z2 && a.z2 >= b.z1;

/** The parts of box `a` not covered by box `b`, as at most six boxes. */
export function subtractBox(a, b) {
  if (!overlaps(a, b)) return [a];
  const out = [];
  let { x1, x2, y1, y2, z1, z2 } = a;
  if (x1 < b.x1) { out.push({ ...a, x1, x2: b.x1 - 1, y1, y2, z1, z2 }); x1 = b.x1; }
  if (x2 > b.x2) { out.push({ ...a, x1: b.x2 + 1, x2, y1, y2, z1, z2 }); x2 = b.x2; }
  if (y1 < b.y1) { out.push({ ...a, x1, x2, y1, y2: b.y1 - 1, z1, z2 }); y1 = b.y1; }
  if (y2 > b.y2) { out.push({ ...a, x1, x2, y1: b.y2 + 1, y2, z1, z2 }); y2 = b.y2; }
  if (z1 < b.z1) { out.push({ ...a, x1, x2, y1, y2, z1, z2: b.z1 - 1 }); z1 = b.z1; }
  if (z2 > b.z2) { out.push({ ...a, x1, x2, y1, y2, z1: b.z2 + 1, z2 }); }
  return out;
}

// The six faces of a box - everything an "outline" fill touches.
function shellOf(s) {
  const { x1, y1, z1, x2, y2, z2 } = s;
  const f = (a, b, c, d, e, g) => ({ ...s, x1: a, y1: b, z1: c, x2: d, y2: e, z2: g, mode: 'solid' });
  return [f(x1, y1, z1, x2, y1, z2), f(x1, y2, z1, x2, y2, z2), f(x1, y1, z1, x1, y2, z2),
    f(x2, y1, z1, x2, y2, z2), f(x1, y1, z1, x2, y2, z1), f(x1, y1, z2, x2, y2, z2)];
}

/** What the structure leaves at a cell once every fill has run, or null if untouched. */
export function materialAt(spans, x, y, z) {
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i];
    if (!inside(s, x, y, z)) continue;
    const onShell = x === s.x1 || x === s.x2 || y === s.y1 || y === s.y2 || z === s.z1 || z === s.z2;
    if (s.mode === 'outline' && !onShell) continue;
    if (s.mode === 'hollow' && !onShell) return 'air';
    return s.material;
  }
  return null;
}

const solidAt = (spans, x, y, z) => {
  const m = materialAt(spans, x, y, z);
  return Boolean(m) && baseOf(m) !== 'air';
};

/**
 * Which way a door faces, when the plan didn't say. Minecraft's door `facing`
 * is the way you look as you walk in, so: find the wall the door sits in, and
 * face along the wall's normal towards the middle of the build.
 */
export function inferDoorFacing(spans, x, y, z, centre) {
  const wallAlongX = solidAt(spans, x - 1, y, z) || solidAt(spans, x + 1, y, z);
  const wallAlongZ = solidAt(spans, x, y, z - 1) || solidAt(spans, x, y, z + 1);
  if (wallAlongX && !wallAlongZ) return z > centre.z ? 'north' : 'south';
  if (wallAlongZ && !wallAlongX) return x > centre.x ? 'west' : 'east';
  const dx = x - centre.x;
  const dz = z - centre.z;
  if (Math.abs(dz) >= Math.abs(dx)) return dz > 0 ? 'north' : 'south';
  return dx > 0 ? 'west' : 'east';
}

/** Which way a bed points (foot to head) when the plan didn't say: into free space. */
export function inferBedFacing(spans, x, y, z, centre, taken = new Set()) {
  const dx = centre.x - x;
  const dz = centre.z - z;
  const inward = Math.abs(dz) >= Math.abs(dx) ? (dz >= 0 ? 'south' : 'north') : (dx >= 0 ? 'east' : 'west');
  const order = [inward, ...FACINGS.filter((f) => f !== inward)];
  for (const f of order) {
    const [sx, sz] = STEP[f];
    if (!solidAt(spans, x + sx, y, z + sz) && !taken.has(key(x + sx, y, z + sz))) return f;
  }
  return inward;
}

function cellsOf(s, into) {
  const states = statesOf(s.material);
  const base = baseOf(s.material);
  for (let y = s.y1; y <= s.y2; y++) {
    for (let z = s.z1; z <= s.z2; z++) {
      for (let x = s.x1; x <= s.x2; x++) {
        if (into.size >= MAX_CELLS) return;
        into.set(key(x, y, z), { x, y, z, base, states });
      }
    }
  }
}

// Door blocks drawn into walls: the lowest block of each column is a door; the
// block above it is its upper half and is not a second door.
function doorsFromCells(cells) {
  const doors = [];
  const claimed = new Set();
  const ordered = [...cells.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  for (const c of ordered) {
    const k = key(c.x, c.y, c.z);
    if (claimed.has(k) || c.states.half === 'upper') continue;
    claimed.add(k);
    claimed.add(key(c.x, c.y + 1, c.z));
    doors.push({
      x: c.x, y: c.y, z: c.z, material: c.base,
      facing: FACINGS.includes(c.states.facing) ? c.states.facing : undefined,
      hinge: HINGES.includes(c.states.hinge) ? c.states.hinge : undefined,
    });
  }
  return doors;
}

// Bed blocks drawn into a floor: pair each with a neighbouring bed block as
// foot and head; a lone block becomes the foot of a bed pointing into space.
function bedsFromCells(cells) {
  const beds = [];
  const claimed = new Set();
  const ordered = [...cells.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  for (const c of ordered) {
    const k = key(c.x, c.y, c.z);
    if (claimed.has(k)) continue;
    claimed.add(k);
    const partner = ['south', 'east', 'north', 'west'].find((f) => {
      const n = cells.get(key(c.x + STEP[f][0], c.y, c.z + STEP[f][1]));
      return n && n.base === c.base && !claimed.has(key(n.x, n.y, n.z));
    });
    if (partner) {
      claimed.add(key(c.x + STEP[partner][0], c.y, c.z + STEP[partner][1]));
      beds.push({ x: c.x, y: c.y, z: c.z, material: c.base, facing: partner });
      continue;
    }
    const facing = FACINGS.includes(c.states.facing) ? c.states.facing : undefined;
    if (facing && c.states.part === 'head') {
      // Drawn as a head: the foot is one block back.
      beds.push({ x: c.x - STEP[facing][0], y: c.y, z: c.z - STEP[facing][1], material: c.base, facing });
    } else {
      beds.push({ x: c.x, y: c.y, z: c.z, material: c.base, facing });
    }
  }
  return beds;
}

const centreOf = (spans, fallback) => {
  if (!spans.length) return fallback;
  let x1 = Infinity; let x2 = -Infinity; let z1 = Infinity; let z2 = -Infinity;
  for (const s of spans) {
    x1 = Math.min(x1, s.x1); x2 = Math.max(x2, s.x2); z1 = Math.min(z1, s.z1); z2 = Math.max(z2, s.z2);
  }
  return { x: (x1 + x2) / 2, z: (z1 + z2) / 2 };
};

/**
 * Split compiled spans into structure and details.
 *
 * @param {object[]} raw     every span, in op order
 * @param {object}   ops     door and bed ops already read from the plan
 * @returns {{spans, doors, beds, blocks}}
 *   spans  - structure, for the fill pass
 *   doors  - {x,y,z,material,facing,hinge}, y is the lower half
 *   beds   - {x,y,z,material,facing}, x/z is the foot
 *   blocks - fragile spans, for the details pass, in their original order
 */
export function splitDetails(raw, { doors: doorOps = [], beds: bedOps = [] } = {}) {
  const spans = [];
  const moved = [];
  const doorCells = new Map();
  const bedCells = new Map();

  for (const s of raw) {
    const base = baseOf(s.material);
    if (isDoor(base)) { cellsOf(s, doorCells); continue; }
    if (isBed(base)) { cellsOf(s, bedCells); continue; }
    if (!isFragile(base)) { spans.push(s); continue; }
    // A shaped fill of something fragile: its faces are the blocks, and a
    // hollow one still clears its inside, which stays with the structure.
    if (s.mode === 'hollow' && s.x2 - s.x1 > 1 && s.y2 - s.y1 > 1 && s.z2 - s.z1 > 1) {
      spans.push({ ...s, x1: s.x1 + 1, y1: s.y1 + 1, z1: s.z1 + 1,
        x2: s.x2 - 1, y2: s.y2 - 1, z2: s.z2 - 1, material: 'air', mode: 'solid' });
    }
    const boxes = s.mode === 'hollow' || s.mode === 'outline' ? shellOf(s) : [{ ...s, mode: 'solid' }];
    for (const box of boxes) moved.push({ box, after: spans.length });
  }

  // Moving a block later must not change what the plan meant. "Later ops
  // overwrite earlier ones" is the plan's contract - it is how air cuts a
  // doorway - so any structure the plan put down AFTER a fragile block still
  // wins over it, and those cells are taken out of the moved block.
  const blocks = [];
  for (const { box, after } of moved) {
    let pieces = [box];
    for (let j = after; j < spans.length && pieces.length <= MAX_PIECES; j++) {
      const later = spans[j];
      if (!overlaps(box, later)) continue;
      const cuts = later.mode === 'outline' ? shellOf(later) : [later];
      for (const cut of cuts) pieces = pieces.flatMap((p) => subtractBox(p, cut));
    }
    blocks.push(...pieces);
  }

  const centre = centreOf(spans, { x: 0, z: 0 });

  const doors = [...doorOps.map((d) => ({ ...d })), ...doorsFromCells(doorCells)];
  for (const d of doors) d.facing ||= inferDoorFacing(spans, d.x, d.y, d.z, centre);
  // Side by side, facing the same way, with no hinge given: a double door that
  // opens from the middle.
  const doorAt = new Map(doors.map((d) => [key(d.x, d.y, d.z), d]));
  for (const d of doors) {
    if (d.hinge) continue;
    const [lx, lz] = STEP[LEFT_OF[d.facing]];
    const onLeft = doorAt.get(key(d.x + lx, d.y, d.z + lz));
    const onRight = doorAt.get(key(d.x - lx, d.y, d.z - lz));
    d.hinge = onLeft && onLeft.facing === d.facing && !onRight ? 'right' : 'left';
  }

  const beds = [...bedOps.map((b) => ({ ...b })), ...bedsFromCells(bedCells)];
  const taken = new Set(beds.flatMap((b) => (b.facing
    ? [key(b.x, b.y, b.z), key(b.x + STEP[b.facing][0], b.y, b.z + STEP[b.facing][1])]
    : [key(b.x, b.y, b.z)])));
  for (const b of beds) {
    if (b.facing) continue;
    b.facing = inferBedFacing(spans, b.x, b.y, b.z, centre, taken);
    taken.add(key(b.x + STEP[b.facing][0], b.y, b.z + STEP[b.facing][1]));
  }

  return { spans, doors, beds, blocks };
}

/** The details as plain boxes, for measuring and drawing the build. */
export function detailBoxes({ doors = [], beds = [], blocks = [] }) {
  const box = (x1, y1, z1, x2, y2, z2, material) => ({
    x1: Math.min(x1, x2), y1: Math.min(y1, y2), z1: Math.min(z1, z2),
    x2: Math.max(x1, x2), y2: Math.max(y1, y2), z2: Math.max(z1, z2), material, mode: 'solid',
  });
  return [
    ...doors.map((d) => box(d.x, d.y, d.z, d.x, d.y + 1, d.z, d.material)),
    ...beds.map((b) => box(b.x, b.y, b.z, b.x + STEP[b.facing][0], b.y, b.z + STEP[b.facing][1], b.material)),
    ...blocks,
  ];
}
