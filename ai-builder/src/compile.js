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

// A span is an inclusive axis-aligned box: {x1,y1,z1,x2,y2,z2,material,mode}
const span = (x1, y1, z1, x2, y2, z2, material, mode = 'solid') => ({
  x1: Math.min(x1, x2), y1: Math.min(y1, y2), z1: Math.min(z1, z2),
  x2: Math.max(x1, x2), y2: Math.max(y1, y2), z2: Math.max(z1, z2),
  material, mode,
});

export function spanVolume(s) {
  return (s.x2 - s.x1 + 1) * (s.y2 - s.y1 + 1) * (s.z2 - s.z1 + 1);
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
      // A real pitched roof. Five primitives could only make a pyramid or a
      // cone, so every rectangular building came out flat-topped.
      const x1 = Math.min(op.x1, op.x2) - (op.overhang ?? 1);
      const x2 = Math.max(op.x1, op.x2) + (op.overhang ?? 1);
      const z1 = Math.min(op.z1, op.z2) - (op.overhang ?? 1);
      const z2 = Math.max(op.z1, op.z2) + (op.overhang ?? 1);
      const pitch = Math.max(1, op.pitch ?? 1);
      const style = ['gable', 'hip', 'shed'].includes(op.style) ? op.style : 'gable';
      const ridge = op.ridge === 'x' ? 'x' : 'z';
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
        out.push(span(a1, op.y + k, b1, a2, op.y + k, b2, m));
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

    default:
      throw new Error(`unknown op: ${op.op}`);
  }

  return out;
}

export function planToSpans(plan) {
  const spans = [];
  for (const op of plan.ops) spans.push(...opToSpans(op));
  return spans;
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
