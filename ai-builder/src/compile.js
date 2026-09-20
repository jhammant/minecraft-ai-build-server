// Compiles an abstract build plan into Minecraft /fill commands.
//
// The pipeline is deliberately three stages:
//   planToSpans()   plan -> exact list of axis-aligned boxes (local coords)
//   validateSpans() safety checks run on the REAL geometry, not an estimate
//   spansToCommands() boxes -> /fill, translated to world coords
//
// Validating spans rather than the plan matters: it means the safety limits
// apply to what will actually be executed, so a cleverly-worded op can't
// under-report its size.

import { splitDetails, STEP } from './details.js';
import { baseOf, isDoublePlant, statesOf } from './blocks.js';

// A span is an inclusive axis-aligned box: {x1,y1,z1,x2,y2,z2,material,mode}
const span = (x1, y1, z1, x2, y2, z2, material, mode = 'solid') => ({
  x1: Math.min(x1, x2), y1: Math.min(y1, y2), z1: Math.min(z1, z2),
  x2: Math.max(x1, x2), y2: Math.max(y1, y2), z2: Math.max(z1, z2),
  material, mode,
});

export function spanVolume(s) {
  return (s.x2 - s.x1 + 1) * (s.y2 - s.y1 + 1) * (s.z2 - s.z1 + 1);
}

// Merge a blockstate into a material id: "oak_stairs" + "facing=north" ->
// "oak_stairs[facing=north]". A state already present is left alone, so an
// explicit state in the plan always wins over a generated one.
function addState(material, kv) {
  const key = kv.split('=')[0];
  if (material.includes(`${key}=`)) return material;
  const i = material.indexOf('[');
  return i === -1 ? `${material}[${kv}]` : `${material.slice(0, -1)},${kv}]`;
}

// The "orient" modifier ("outward"/"inward") only means something for stair
// and slab materials; everything else passes through untouched. Stairs on the
// perimeter of the op's footprint are split into one-block-thick face spans
// whose facing follows the outward (or inward) normal; slabs get a type
// instead of a facing, since that is how a slab "faces".
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

function orientSpans(spans, orient) {
  const base = (m) => m.split('[')[0];
  const shaped = spans.filter((s) => /_(stairs|slab)$/.test(base(s.material)));
  if (shaped.length === 0) return spans;
  const b = spansBounds(shaped);
  const out = [];
  for (const s of spans) {
    const sb = base(s.material);
    if (sb.endsWith('_slab')) {
      out.push({ ...s, material: addState(s.material, `type=${orient === 'outward' ? 'top' : 'bottom'}`) });
      continue;
    }
    if (!sb.endsWith('_stairs')) { out.push(s); continue; }
    // Carve perimeter faces out of the span (x faces first, then z, so corner
    // blocks belong to the x face). Interior blocks keep the plain material.
    let { x1, x2, z1, z2 } = s;
    const face = (fx1, fz1, fx2, fz2, normal) => out.push({
      ...s, x1: fx1, z1: fz1, x2: fx2, z2: fz2,
      material: addState(s.material, `facing=${orient === 'outward' ? normal : OPPOSITE[normal]}`),
    });
    if (x1 === b.x1) { face(x1, z1, x1, z2, 'west'); x1 += 1; }
    if (x2 === b.x2 && x2 >= x1) { face(x2, z1, x2, z2, 'east'); x2 -= 1; }
    if (x1 <= x2) {
      if (z1 === b.z1) { face(x1, z1, x2, z1, 'north'); z1 += 1; }
      if (z2 === b.z2 && z2 >= z1) { face(x1, z2, x2, z2, 'south'); z2 -= 1; }
    }
    if (x1 <= x2 && z1 <= z2) out.push({ ...s, x1, z1, x2, z2 });
  }
  return out;
}

// Horizontal runs making up a filled or hollow disc of the given radius,
// centred on (0,0). Returns [{dz, x1, x2}].
// A hollow disc is disc(r) minus disc(r-1), which keeps the wall exactly one
// block thick without leaving diagonal gaps.
function discRuns(radius, hollow) {
  const runs = [];
  const r2 = radius * radius;
  const inner = radius - 1;
  const inner2 = inner * inner;
  for (let dz = -radius; dz <= radius; dz++) {
    const hw = Math.floor(Math.sqrt(Math.max(0, r2 - dz * dz)));
    if (hw < 0) continue;
    if (!hollow) {
      runs.push({ dz, x1: -hw, x2: hw });
      continue;
    }
    const innerHw = Math.abs(dz) <= inner
      ? Math.floor(Math.sqrt(Math.max(0, inner2 - dz * dz)))
      : -1;
    if (innerHw < 0) {
      runs.push({ dz, x1: -hw, x2: hw }); // solid cap row
    } else {
      runs.push({ dz, x1: -hw, x2: -innerHw - 1 });
      runs.push({ dz, x1: innerHw + 1, x2: hw });
    }
  }
  return runs.filter((r) => r.x1 <= r.x2);
}

// Map (u, v, w) in an axis-local frame back to world (x, y, z).
//   axis y -> u=x, v=z, w=y   (the original vertical case)
//   axis x -> u=z, v=y, w=x
//   axis z -> u=x, v=y, w=z
// This is what unlocks arches, masts, hulls and bridges: a cylinder that lies
// down. Everything stays axis-aligned, so run-length encoding and splitting are
// untouched.
function axisSpan(axis, cu, cv, cw, u1, u2, v, w1, w2, material) {
  const A = (uu, vv, ww) => (
    axis === 'x' ? [ww, vv, uu]
      : axis === 'z' ? [uu, vv, ww]
        : [uu, ww, vv]                       // 'y'
  );
  const [x1, y1, z1] = A(cu + u1, cv + v, cw + w1);
  const [x2, y2, z2] = A(cu + u2, cv + v, cw + w2);
  return span(x1, y1, z1, x2, y2, z2, material);
}

// Centre coords in the axis-local frame.
function axisCentre(axis, op) {
  return axis === 'x' ? { cu: op.cz, cv: op.cy, cw: op.cx }
    : axis === 'z' ? { cu: op.cx, cv: op.cy, cw: op.cz }
      : { cu: op.cx, cv: op.cz, cw: op.cy };
}

function opToSpans(op) {
  const m = op.material;
  const out = [];

  switch (op.op) {
    case 'cuboid': {
      const mode = op.hollow ? 'hollow' : (op.outline ? 'outline' : 'solid');
      out.push(span(op.x1, op.y1, op.z1, op.x2, op.y2, op.z2, m, mode));
      break;
    }

    case 'cylinder': {
      // (cx,cy,cz) is the CENTRE OF THE BASE CAP, extruded `height` along the
      // axis (default y). The disc is computed once and extruded, which is why
      // a tall tower costs no more commands than a flat ring.
      const axis = op.axis === 'x' || op.axis === 'z' ? op.axis : 'y';
      const h = Math.max(1, op.height);
      const { cu, cv, cw } = axisCentre(axis, op);
      for (const run of discRuns(op.radius, !!op.hollow)) {
        out.push(axisSpan(axis, cu, cv, cw, run.x1, run.x2, run.dz, 0, h - 1, m));
      }
      break;
    }

    case 'sphere': {
      // Must go layer by layer - the cross-section changes with height.
      const r = op.radius;
      const r2 = r * r;
      const innerR = r - 1;
      for (let dy = -r; dy <= r; dy++) {
        const layerR = Math.floor(Math.sqrt(Math.max(0, r2 - dy * dy)));
        if (layerR < 0) continue;
        // For a hollow sphere the shell is only "ring-shaped" in layers that
        // still intersect the inner sphere; cap layers stay solid.
        const isCap = Math.abs(dy) > innerR;
        for (const run of discRuns(layerR, op.hollow && !isCap)) {
          out.push(span(
            op.cx + run.x1, op.cy + dy, op.cz + run.dz,
            op.cx + run.x2, op.cy + dy, op.cz + run.dz,
            m,
          ));
        }
      }
      break;
    }

    case 'cone': {
      // Spire / tapered mass. Also axis-aware, so it can point sideways.
      const axis = op.axis === 'x' || op.axis === 'z' ? op.axis : 'y';
      const h = Math.max(1, op.height);
      const { cu, cv, cw } = axisCentre(axis, op);
      for (let d = 0; d < h; d++) {
        const layerR = Math.round(op.radius * (1 - d / h));
        if (layerR < 0) continue;
        for (const run of discRuns(layerR, !!op.hollow)) {
          out.push(axisSpan(axis, cu, cv, cw, run.x1, run.x2, run.dz, d, d, m));
        }
      }
      break;
    }

    case 'crenellate': {
      // Battlements. Previously 30-80 hand-placed cuboids and air cuts; now one
      // op, which is what makes the model actually bother putting them on.
      const period = Math.max(2, op.period ?? 4);
      const merlon = Math.max(1, op.merlon ?? 2);
      const hh = Math.max(1, op.height ?? 2);
      const y = op.y;
      const put = (x, z) => out.push(span(x, y, z, x + merlon - 1, y + hh - 1, z + merlon - 1, m));
      if (Number.isFinite(op.radius)) {
        // Ring variant, for round towers.
        const r = op.radius;
        const steps = Math.max(4, Math.round((2 * Math.PI * r) / period));
        for (let i = 0; i < steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          put(Math.round(op.cx + r * Math.cos(a)), Math.round(op.cz + r * Math.sin(a)));
        }
      } else {
        const x1 = Math.min(op.x1, op.x2); const x2 = Math.max(op.x1, op.x2);
        const z1 = Math.min(op.z1, op.z2); const z2 = Math.max(op.z1, op.z2);
        for (let x = x1; x <= x2; x += period) { put(x, z1); put(x, z2); }
        for (let z = z1; z <= z2; z += period) { put(x1, z); put(x2, z); }
      }
      break;
    }

    case 'roof': {
      // A real pitched roof is a SHELL. The first version emitted a full solid
      // slab per layer, so a roof over a 40-wide hall became twenty stacked
      // slabs - a giant stepped wedge that looked like a shard and ate the
      // block budget. Emit only the sloping surface (thickness = pitch) plus
      // the gable ends, unless solid is explicitly asked for.
      const oh = op.overhang ?? 1;
      const x1 = Math.min(op.x1, op.x2) - oh;
      const x2 = Math.max(op.x1, op.x2) + oh;
      const z1 = Math.min(op.z1, op.z2) - oh;
      const z2 = Math.max(op.z1, op.z2) + oh;
      const pitch = Math.max(1, op.pitch ?? 1);
      const style = ['gable', 'hip', 'shed'].includes(op.style) ? op.style : 'gable';
      const ridge = op.ridge === 'x' ? 'x' : 'z';
      const solid = op.solid === true;
      const halfDepth = ridge === 'z'
        ? Math.ceil((x2 - x1) / 2)
        : Math.ceil((z2 - z1) / 2);

      for (let k = 0; k * pitch <= halfDepth; k++) {
        const inset = k * pitch;
        let a1 = x1; let a2 = x2; let b1 = z1; let b2 = z2;
        if (style === 'shed') {
          if (ridge === 'z') a1 = x1 + inset * 2; else b1 = z1 + inset * 2;
        } else if (ridge === 'z') {
          a1 = x1 + inset; a2 = x2 - inset;
          if (style === 'hip') { b1 = z1 + inset; b2 = z2 - inset; }
        } else {
          b1 = z1 + inset; b2 = z2 - inset;
          if (style === 'hip') { a1 = x1 + inset; a2 = x2 - inset; }
        }
        if (a1 > a2 || b1 > b2) break;
        const y = op.y + k;

        if (solid) { out.push(span(a1, y, b1, a2, y, b2, m)); continue; }

        // Shell: just the courses that form the slope, `pitch` thick.
        const w = Math.max(1, pitch);
        if (style === 'shed') {
          if (ridge === 'z') out.push(span(a1, y, b1, Math.min(a1 + w - 1, a2), y, b2, m));
          else out.push(span(a1, y, b1, a2, y, Math.min(b1 + w - 1, b2), m));
        } else if (ridge === 'z') {
          out.push(span(a1, y, b1, Math.min(a1 + w - 1, a2), y, b2, m));   // -x slope
          out.push(span(Math.max(a2 - w + 1, a1), y, b1, a2, y, b2, m));   // +x slope
          if (style === 'hip') {
            out.push(span(a1, y, b1, a2, y, Math.min(b1 + w - 1, b2), m));
            out.push(span(a1, y, Math.max(b2 - w + 1, b1), a2, y, b2, m));
          }
        } else {
          out.push(span(a1, y, b1, a2, y, Math.min(b1 + w - 1, b2), m));
          out.push(span(a1, y, Math.max(b2 - w + 1, b1), a2, y, b2, m));
          if (style === 'hip') {
            out.push(span(a1, y, b1, Math.min(a1 + w - 1, a2), y, b2, m));
            out.push(span(Math.max(a2 - w + 1, a1), y, b1, a2, y, b2, m));
          }
        }
        // Close the gable ends so the roof isn't open at the sides.
        if (style === 'gable') {
          if (ridge === 'z') {
            out.push(span(a1, y, b1, a2, y, b1, m));
            out.push(span(a1, y, b2, a2, y, b2, m));
          } else {
            out.push(span(a1, y, b1, a1, y, b2, m));
            out.push(span(a2, y, b1, a2, y, b2, m));
          }
        }
      }
      break;
    }

    case 'stairs': {
      // A climbable flight. The model cannot get stair blockstates right by
      // hand, and "can I actually walk up it" is the property a child tests
      // first - so the compiler owns it.
      const DIRS = {
        north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0],
      };
      const [dx, dz] = DIRS[op.dir] || DIRS.north;
      const steps = Math.max(1, op.steps);
      const width = Math.max(1, op.width ?? 2);
      // Perpendicular to travel, so the flight has width.
      const [px, pz] = dx !== 0 ? [0, 1] : [1, 0];
      for (let i = 0; i < steps; i++) {
        const x = op.x + dx * i;
        const z = op.z + dz * i;
        const y = op.y + i;
        const x2 = x + px * (width - 1);
        const z2 = z + pz * (width - 1);
        // From the bare id: a material that already carried states would
        // otherwise become "oak_stairs[facing=north][facing=east,...]", which
        // no server parses.
        const tread = `${baseOf(m)}[facing=${op.dir || 'north'},half=bottom]`;
        out.push(span(x, y, z, x2, y, z2, tread));
        if (op.support !== false && y > op.y) {
          out.push(span(x, op.y, z, x2, y - 1, z2, m));
        }
        // Headroom, so the flight is walkable rather than a buried ramp.
        out.push(span(x, y + 1, z, x2, y + 3, z2, 'air'));
      }
      break;
    }

    case 'layer': {
      // Draw a level as a character grid with a legend - the way people
      // actually design Minecraft builds, and a form models are genuinely good
      // at. Five abstract solids could never express a window pattern, a
      // doorway with a lintel, or a ship's deck outline; this can draw anything
      // exactly. Rows run along +z, characters along +x.
      const legend = op.legend || {};
      const rows = op.rows || [];
      for (let r = 0; r < rows.length; r++) {
        const row = String(rows[r]);
        let runStart = null;
        let runMat = null;
        const flush = (endIdx) => {
          if (runStart === null || runMat == null) return;
          out.push(span(op.x + runStart, op.y, op.z + r,
            op.x + endIdx, op.y, op.z + r, runMat));
          runStart = null; runMat = null;
        };
        for (let i = 0; i < row.length; i++) {
          const ch = row[i];
          const mat = legend[ch];
          // Unmapped characters (and a space) mean "leave whatever is there",
          // which is what makes a grid safe to draw over existing work.
          if (!mat) { flush(i - 1); continue; }
          if (mat !== runMat) { flush(i - 1); runStart = i; runMat = mat; }
        }
        flush(row.length - 1);
      }
      break;
    }

    case 'repeat': {
      // Rhythm: colonnades, arcades, ribs, fence posts, ship frames. One op
      // instead of forty, so the model spends its budget on form not repetition.
      const child = op.child;
      if (!child || child.op === 'repeat') throw new Error('repeat needs a non-repeat child');
      const n1 = Math.max(1, Math.min(64, op.count ?? 1));
      const n2 = Math.max(1, Math.min(64, op.count2 ?? 1));
      const s1 = op.step || {};
      const s2 = op.step2 || {};
      for (let i = 0; i < n1; i++) {
        for (let j = 0; j < n2; j++) {
          const dx = (s1.dx ?? 0) * i + (s2.dx ?? 0) * j;
          const dy = (s1.dy ?? 0) * i + (s2.dy ?? 0) * j;
          const dz = (s1.dz ?? 0) * i + (s2.dz ?? 0) * j;
          const moved = { ...child };
          for (const [f, d] of [['x1', dx], ['x2', dx], ['cx', dx],
            ['y1', dy], ['y2', dy], ['cy', dy], ['y', dy],
            ['z1', dz], ['z2', dz], ['cz', dz]]) {
            if (Number.isFinite(moved[f])) moved[f] += d;
          }
          out.push(...opToSpans(moved));
        }
      }
      break;
    }

    case 'pyramid': {
      // Square roof. radius = half-width at the base.
      const h = Math.max(1, op.height);
      for (let dy = 0; dy < h; dy++) {
        const rr = Math.round(op.radius * (1 - dy / h));
        if (rr < 0) continue;
        if (op.hollow && rr > 0) {
          // Four edges only, so the roof is a shell.
          out.push(span(op.cx - rr, op.cy + dy, op.cz - rr, op.cx + rr, op.cy + dy, op.cz - rr, m));
          out.push(span(op.cx - rr, op.cy + dy, op.cz + rr, op.cx + rr, op.cy + dy, op.cz + rr, m));
          out.push(span(op.cx - rr, op.cy + dy, op.cz - rr, op.cx - rr, op.cy + dy, op.cz + rr, m));
          out.push(span(op.cx + rr, op.cy + dy, op.cz - rr, op.cx + rr, op.cy + dy, op.cz + rr, m));
        } else {
          out.push(span(op.cx - rr, op.cy + dy, op.cz - rr, op.cx + rr, op.cy + dy, op.cz + rr, m));
        }
      }
      break;
    }

    // Placed in the details pass, not as geometry: see compilePlan.
    case 'door':
    case 'bed':
    case 'creatures':
      break;

    default:
      throw new Error(`unknown op: ${op.op}`);
  }

  return op.orient ? orientSpans(out, op.orient) : out;
}

export function planToSpans(plan) {
  const spans = [];
  for (const op of plan.ops) spans.push(...opToSpans(op));
  return spans;
}

/**
 * The whole plan, split into what fill places and what the details pass places.
 * Validate this, not planToSpans: the details are real blocks too.
 */
export function compilePlan(plan) {
  const raw = [];
  const doors = [];
  const beds = [];
  const creatures = [];
  for (const op of plan.ops) {
    if (op.op === 'creatures') {
      creatures.push(...creaturePositions(op));
    } else if (op.op === 'door') {
      doors.push({ x: op.x, y: op.y, z: op.z, material: op.material, facing: op.facing, hinge: op.hinge });
    } else if (op.op === 'bed') {
      beds.push({ x: op.x, y: op.y, z: op.z, material: op.material, facing: op.facing });
    } else {
      raw.push(...opToSpans(op));
    }
  }
  return { ...splitDetails(raw, { doors, beds }), creatures };
}

/**
 * Where each animal of a creatures op stands, in local coordinates.
 * Explicit points are used as given; an area is filled on an even lattice -
 * deterministic, so the same plan always puts the cows in the same places.
 */
export function creaturePositions(op) {
  const mob = op.mob;
  if (Array.isArray(op.points)) {
    return op.points.map((p) => (Array.isArray(p)
      ? { mob, x: p[0], y: p[1], z: p[2] }
      : { mob, x: p.x, y: p.y, z: p.z }));
  }
  const x1 = Math.min(op.x1, op.x2); const x2 = Math.max(op.x1, op.x2);
  const z1 = Math.min(op.z1, op.z2); const z2 = Math.max(op.z1, op.z2);
  const count = Math.max(1, op.count ?? 1);
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const out = [];
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({
      mob,
      x: x1 + Math.floor(((c + 0.5) * (x2 - x1 + 1)) / cols),
      y: op.y,
      z: z1 + Math.floor(((r + 0.5) * (z2 - z1 + 1)) / rows),
    });
  }
  return out;
}

// Bounding box over all spans, in local coordinates.
export function spansBounds(spans) {
  if (spans.length === 0) return null;
  const b = {
    x1: Infinity, y1: Infinity, z1: Infinity,
    x2: -Infinity, y2: -Infinity, z2: -Infinity,
  };
  for (const s of spans) {
    b.x1 = Math.min(b.x1, s.x1); b.y1 = Math.min(b.y1, s.y1); b.z1 = Math.min(b.z1, s.z1);
    b.x2 = Math.max(b.x2, s.x2); b.y2 = Math.max(b.y2, s.y2); b.z2 = Math.max(b.z2, s.z2);
  }
  return b;
}

// Total blocks written. Overlapping spans are counted twice, which is the
// conservative direction for a safety limit.
export function totalBlocks(spans) {
  return spans.reduce((n, s) => n + spanVolume(s), 0);
}

// Minecraft refuses a /fill covering more than 32768 blocks, so split any
// oversized span along its longest axis until each piece fits.
const FILL_LIMIT = 32768;

function splitSpan(s) {
  if (spanVolume(s) <= FILL_LIMIT) return [s];
  const dx = s.x2 - s.x1 + 1;
  const dy = s.y2 - s.y1 + 1;
  const dz = s.z2 - s.z1 + 1;
  const out = [];
  if (dx >= dy && dx >= dz) {
    const mid = s.x1 + Math.floor(dx / 2) - 1;
    out.push(...splitSpan({ ...s, x2: mid }), ...splitSpan({ ...s, x1: mid + 1 }));
  } else if (dy >= dz) {
    const mid = s.y1 + Math.floor(dy / 2) - 1;
    out.push(...splitSpan({ ...s, y2: mid }), ...splitSpan({ ...s, y1: mid + 1 }));
  } else {
    const mid = s.z1 + Math.floor(dz / 2) - 1;
    out.push(...splitSpan({ ...s, z2: mid }), ...splitSpan({ ...s, z1: mid + 1 }));
  }
  return out;
}

// A hollow/outline fill cannot be split - the mode applies to the whole box -
// but it is still subject to the 32768-block limit, and the server SILENTLY
// DROPS an oversized fill. A big hollow room therefore just never appeared,
// which is what made large builds look like bare floors.
//
// So decompose it ourselves: a hollow box is six solid faces, an outline is its
// twelve edges. Those are thin, so they chunk normally.
function explodeShaped(s) {
  const { x1, y1, z1, x2, y2, z2, material } = s;
  const face = (a, b, c, d, e, f) => ({ x1: a, y1: b, z1: c, x2: d, y2: e, z2: f, material, mode: 'solid' });
  if (s.mode === 'hollow') {
    return [
      face(x1, y1, z1, x2, y1, z2),           // floor
      face(x1, y2, z1, x2, y2, z2),           // ceiling
      face(x1, y1, z1, x1, y2, z2),           // -x wall
      face(x2, y1, z1, x2, y2, z2),           // +x wall
      face(x1, y1, z1, x2, y2, z1),           // -z wall
      face(x1, y1, z2, x2, y2, z2),           // +z wall
    ];
  }
  // outline: the twelve edges of the box
  const out = [];
  for (const y of [y1, y2]) for (const z of [z1, z2]) out.push(face(x1, y, z, x2, y, z));
  for (const x of [x1, x2]) for (const z of [z1, z2]) out.push(face(x, y1, z, x, y2, z));
  for (const x of [x1, x2]) for (const y of [y1, y2]) out.push(face(x, y, z1, x, y, z2));
  return out;
}

// Translate to world coordinates and emit commands.
export function spansToCommands(spans, origin) {
  const cmds = [];
  for (const raw of spans) {
    // Shaped fills that fit stay native (one command); oversized ones are
    // exploded into faces so they actually get placed.
    const shaped = raw.mode && raw.mode !== 'solid';
    const list = (shaped && spanVolume(raw) > FILL_LIMIT) ? explodeShaped(raw) : [raw];
    for (const s of list) {
    const pieces = (s.mode === 'solid') ? splitSpan(s) : [s];
    for (const p of pieces) {
      const x1 = p.x1 + origin.x, y1 = p.y1 + origin.y, z1 = p.z1 + origin.z;
      const x2 = p.x2 + origin.x, y2 = p.y2 + origin.y, z2 = p.z2 + origin.z;
      const suffix = p.mode && p.mode !== 'solid' ? ` ${p.mode}` : '';
      cmds.push(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${p.material}${suffix}`);
      }
    }
  }
  return cmds;
}

// Level a site: `material` up to and including `ground`, air above it.
// Two spans, so no single fill can straddle the ground line. The old loop cut
// the region into fixed-height slabs and took each slab's block from its bottom
// row - on a small site one slab ran from below ground to 30 blocks above it,
// and "flatten" raised a sand tower with the build perched on top.
export function siteFillCommands(region, ground, material) {
  const base = { x1: region.x1, z1: region.z1, x2: region.x2, z2: region.z2, mode: 'solid' };
  const spans = [];
  if (region.y1 <= ground) {
    spans.push({ ...base, y1: region.y1, y2: Math.min(ground, region.y2), material });
  }
  if (region.y2 > ground) {
    spans.push({ ...base, y1: Math.max(ground + 1, region.y1), y2: region.y2, material: 'air' });
  }
  return spansToCommands(spans, { x: 0, y: 0, z: 0 });
}

// Tall plants are two blocks like a door, and need the same two-step placement.
// Capped: a meadow of sunflowers is two commands per flower.
const MAX_DOUBLE_PLANTS = 128;

/**
 * The details pass, as commands. Runs after every structure command, so the
 * wall a torch hangs on and the floor a bed stands on already exist.
 *
 * Two-block things go down in two setblocks, lower (or foot) first. The first
 * half is placed `strict` - as-is, with no shape update - because on its own it
 * is an invalid half and an update would remove it. The second half is placed
 * normally, so the pair settles against its neighbours. Every value here comes
 * from the validated plan: coordinates are integers, ids passed the block
 * checks, facing and hinge are from fixed lists.
 */
export function detailCommands({ doors = [], beds = [], blocks = [] }, origin) {
  const at = (x, y, z) => `${x + origin.x} ${y + origin.y} ${z + origin.z}`;
  const cmds = [];
  for (const d of doors) {
    const states = `facing=${d.facing},hinge=${d.hinge}`;
    // Clear the opening first, so a door that fails to place still leaves a
    // way in rather than a wall.
    cmds.push(`fill ${at(d.x, d.y, d.z)} ${at(d.x, d.y + 1, d.z)} air`);
    cmds.push(`setblock ${at(d.x, d.y, d.z)} ${d.material}[${states},half=lower] strict`);
    cmds.push(`setblock ${at(d.x, d.y + 1, d.z)} ${d.material}[${states},half=upper]`);
  }
  for (const b of beds) {
    const [dx, dz] = STEP[b.facing];
    cmds.push(`setblock ${at(b.x, b.y, b.z)} ${b.material}[facing=${b.facing},part=foot] strict`);
    cmds.push(`setblock ${at(b.x + dx, b.y, b.z + dz)} ${b.material}[facing=${b.facing},part=head]`);
  }
  let plants = 0;
  for (const s of blocks) {
    const base = baseOf(s.material);
    if (isDoublePlant(base)) {
      // An upper half drawn on its own is placed by the lower half below it.
      if (statesOf(s.material).half === 'upper') continue;
      for (let z = s.z1; z <= s.z2; z++) {
        for (let x = s.x1; x <= s.x2; x++) {
          if (plants++ >= MAX_DOUBLE_PLANTS) continue;
          cmds.push(`setblock ${at(x, s.y1, z)} ${base}[half=lower] strict`);
          cmds.push(`setblock ${at(x, s.y1 + 1, z)} ${base}[half=upper]`);
        }
      }
      continue;
    }
    if (spanVolume(s) === 1) cmds.push(`setblock ${at(s.x1, s.y1, s.z1)} ${s.material}`);
    else cmds.push(...spansToCommands([{ ...s, mode: 'solid' }], origin));
  }
  return cmds;
}

// Fish and axolotls also carry FromBucket, the flag that keeps a caught fish
// from despawning; PersistenceRequired covers everything else.
const BUCKETABLE = new Set(['tropical_fish', 'cod', 'salmon', 'axolotl']);

export const BUILD_TAG_RE = /^aib_[a-z0-9]{1,24}$/;

/**
 * Summon commands, run last, once the pens and tanks exist. Every animal is
 * tagged with the build's id so undo can take back exactly what this build
 * put there. The mob id comes from the allowlist, the NBT is fixed here, and
 * the tag is checked against a strict pattern - nothing in it is model text.
 */
export function creatureCommands(creatures, origin, tag) {
  if (!BUILD_TAG_RE.test(tag)) throw new Error(`bad build tag: ${tag}`);
  return creatures.map((c) => {
    const nbt = [
      'PersistenceRequired:1b',
      ...(BUCKETABLE.has(c.mob) ? ['FromBucket:1b'] : []),
      `Tags:["aib","${tag}"]`,
    ].join(',');
    return `summon minecraft:${c.mob} ${c.x + origin.x + 0.5} ${c.y + origin.y} ${c.z + origin.z + 0.5} {${nbt}}`;
  });
}

// --- foundations -----------------------------------------------------------------
//
// A build sits at the HIGHEST ground under its footprint, so nothing is buried.
// On a slope, or half over a river, that left the low side hanging in the air:
// a haunted house landed with its floor ten blocks above the water. So the gap
// is filled - from the lowest ground found up to just under the build - only
// where it is air or water, and only under the parts of the build that
// actually touch the ground.

export const FOUNDATION_MAX_DEPTH = 24;
const FOUNDATION_MAX_RECTS = 64;
// Air, water, lava and the plants that grow in them. Replacing only these
// means real ground is never dug out or overwritten.
const FILLABLE = '#minecraft:replaceable';
// Blocks that would make a poor or unstable foundation, however much of the
// base is made of them.
const NOT_A_FOUNDATION = /^(air|water|lava|sand|red_sand|gravel|farmland|dirt_path|scaffolding|tnt|cake|cactus|barrel|bookshelf|chest|trapped_chest|hay_block|slime_block|honey_block)$|_slab$|_stairs$|_wall$|_fence|_pane$|glass|leaves|_carpet$|concrete_powder|ice$|snow|_door$|_trapdoor$|_shulker_box$|_ore$/;

/**
 * What to fill under a build, or null if it already sits on the ground.
 *
 * @param {object} verified   validatePlan's result (local coordinates)
 * @param {object} origin     world origin; origin.y is where the build sits
 * @param {number} lowGround  lowest free block above ground across the footprint
 * @returns {{bottom:number, top:number, material:string, rects:object[]}|null}
 */
export function planFoundation(verified, origin, lowGround, { maxDepth = FOUNDATION_MAX_DEPTH, minY = -64 } = {}) {
  if (!Number.isFinite(lowGround) || lowGround >= origin.y) return null;
  const { spans, bounds } = verified;
  // Drawn starting in mid-air on purpose - a sky island, a floating castle.
  // Propping it up on a stone pillar would be wrong.
  if (bounds.y1 > 1) return null;
  const base = spans.filter((s) => s.y1 <= bounds.y1 + 1 && baseOf(s.material) !== 'air');
  if (!base.length) return null;

  // Rest it on the parts that touch the ground, not the whole bounding box: a
  // courtyard or the gap between two towers stays as the land was.
  const seen = new Set();
  let rects = [];
  for (const s of base) {
    const r = { x1: s.x1 + origin.x, z1: s.z1 + origin.z, x2: s.x2 + origin.x, z2: s.z2 + origin.z };
    const k = `${r.x1},${r.z1},${r.x2},${r.z2}`;
    if (!seen.has(k)) { seen.add(k); rects.push(r); }
  }
  if (rects.length > FOUNDATION_MAX_RECTS) {
    rects = [{
      x1: Math.min(...rects.map((r) => r.x1)), z1: Math.min(...rects.map((r) => r.z1)),
      x2: Math.max(...rects.map((r) => r.x2)), z2: Math.max(...rects.map((r) => r.z2)),
    }];
  }

  // The build's own base material, if it is one that stands up as a wall of
  // earth or stone; otherwise stone bricks.
  const area = new Map();
  for (const s of base) {
    const b = baseOf(s.material);
    area.set(b, (area.get(b) || 0) + (s.x2 - s.x1 + 1) * (s.z2 - s.z1 + 1));
  }
  const [dominant] = [...area.entries()].sort((a, b) => b[1] - a[1])[0];
  const material = NOT_A_FOUNDATION.test(dominant) ? 'stone_bricks' : dominant;

  const top = origin.y + bounds.y1 - 1;
  const bottom = Math.max(lowGround, origin.y - maxDepth, minY);
  if (bottom > top) return null;
  return { bottom, top, material, rects };
}

export function foundationCommands(foundation) {
  if (!foundation) return [];
  const { bottom, top, material, rects } = foundation;
  const spans = rects.map((r) => ({ ...r, y1: bottom, y2: top, material, mode: 'solid' }));
  return spansToCommands(spans, { x: 0, y: 0, z: 0 }).map((c) => `${c} replace ${FILLABLE}`);
}
