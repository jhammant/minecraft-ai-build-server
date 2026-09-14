// Force-loading chunks without leaking them.
//
// A build force-loads its site, the undo snapshot force-loads the vault, and
// "flatten this spot" force-loads its square. Every one of those used to be a
// bare `forceload add` ... `forceload remove` pair, so any failure in between -
// a dropped connection, a snapshot timeout - left the chunks loaded for good.
// One failed build today left 296 of them ticking.
//
// Two rules fix it:
//   1. every add is paired with its remove in a finally (withForceload), and
//   2. chunks are reference-counted, because the uses nest. The snapshot runs
//      INSIDE the build, over the same chunks; a plain remove at the end of the
//      snapshot would unload the site while the build was still filling it.
//      `forceload` is a per-chunk flag, not a counter, so the counting is ours.

const CHUNK = 16;
// The server refuses `forceload add` over more than 256 chunks at once.
const MAX_CHUNKS_PER_COMMAND = 256;

const chunkOf = (block) => Math.floor(block / CHUNK);

/** Inclusive chunk rectangle covering a block area {x1,z1,x2,z2}. */
export function chunkRect(area) {
  return {
    cx1: chunkOf(Math.min(area.x1, area.x2)), cz1: chunkOf(Math.min(area.z1, area.z2)),
    cx2: chunkOf(Math.max(area.x1, area.x2)), cz2: chunkOf(Math.max(area.z1, area.z2)),
  };
}

// Merge a set of chunk keys into as few rectangles as a simple sweep finds:
// runs along x per row, then identical runs stacked along z.
export function chunkRects(keys) {
  const rows = new Map();
  for (const k of keys) {
    const [cx, cz] = k.split(',').map(Number);
    if (!rows.has(cz)) rows.set(cz, []);
    rows.get(cz).push(cx);
  }
  const runs = [];
  for (const cz of [...rows.keys()].sort((a, b) => a - b)) {
    const xs = rows.get(cz).sort((a, b) => a - b);
    let start = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      if (i === xs.length || xs[i] !== xs[i - 1] + 1) {
        runs.push({ cx1: start, cx2: xs[i - 1], cz });
        start = xs[i];
      }
    }
  }
  const rects = [];
  for (const r of runs) {
    const above = rects.find((q) => q.cx1 === r.cx1 && q.cx2 === r.cx2 && q.cz2 === r.cz - 1);
    if (above) above.cz2 = r.cz;
    else rects.push({ cx1: r.cx1, cx2: r.cx2, cz1: r.cz, cz2: r.cz });
  }
  return rects;
}

// Split a chunk rectangle into pieces the server will accept in one command.
function limitRect(r) {
  const w = r.cx2 - r.cx1 + 1;
  const h = r.cz2 - r.cz1 + 1;
  if (w * h <= MAX_CHUNKS_PER_COMMAND) return [r];
  if (w <= MAX_CHUNKS_PER_COMMAND) {
    const rowsPer = Math.floor(MAX_CHUNKS_PER_COMMAND / w);
    const out = [];
    for (let z = r.cz1; z <= r.cz2; z += rowsPer) {
      out.push({ ...r, cz1: z, cz2: Math.min(r.cz2, z + rowsPer - 1) });
    }
    return out;
  }
  const mid = r.cx1 + Math.floor(w / 2) - 1;
  return [...limitRect({ ...r, cx2: mid }), ...limitRect({ ...r, cx1: mid + 1 })];
}

const rectCommand = (verb, r) => `forceload ${verb} ${r.cx1 * CHUNK} ${r.cz1 * CHUNK} `
  + `${r.cx2 * CHUNK + CHUNK - 1} ${r.cz2 * CHUNK + CHUNK - 1}`;

export function createForceloader({ log = () => {} } = {}) {
  const counts = new Map();     // "cx,cz" -> holders
  const unreleased = new Set(); // keys whose remove failed, retried by flush()

  const keysOf = (area) => {
    const r = chunkRect(area);
    const keys = [];
    for (let cz = r.cz1; cz <= r.cz2; cz++) {
      for (let cx = r.cx1; cx <= r.cx2; cx++) keys.push(`${cx},${cz}`);
    }
    return keys;
  };

  async function add(rcon, area) {
    const keys = keysOf(area);
    for (const k of keys) {
      counts.set(k, (counts.get(k) || 0) + 1);
      unreleased.delete(k);
    }
    // Re-marking a chunk that is already loaded is harmless, so the whole area
    // is sent rather than just the new chunks - fewer, simpler commands.
    for (const piece of limitRect(chunkRect(area))) {
      await rcon.send(rectCommand('add', piece)).catch((e) => log(`forceload add failed: ${e.message}`));
    }
  }

  async function release(rcon, keys) {
    for (const piece of chunkRects(keys).flatMap(limitRect)) {
      try {
        await rcon.send(rectCommand('remove', piece));
        for (let cz = piece.cz1; cz <= piece.cz2; cz++) {
          for (let cx = piece.cx1; cx <= piece.cx2; cx++) unreleased.delete(`${cx},${cz}`);
        }
      } catch (e) {
        log(`forceload remove failed (will retry): ${e.message}`);
      }
    }
  }

  async function remove(rcon, area) {
    const free = [];
    for (const k of keysOf(area)) {
      const n = (counts.get(k) || 0) - 1;
      if (n > 0) { counts.set(k, n); continue; }
      counts.delete(k);
      free.push(k);
      unreleased.add(k);
    }
    if (free.length) await release(rcon, free);
  }

  // Retry removals that failed, e.g. because the connection was down at the
  // time. Only chunks nobody has claimed since are released.
  async function flush(rcon) {
    const keys = [...unreleased].filter((k) => !counts.has(k));
    if (keys.length) await release(rcon, keys);
  }

  /** Keep `areas` loaded for exactly as long as `fn` runs, however it ends. */
  async function withForceload(rcon, areas, fn) {
    const list = areas.filter(Boolean);
    const added = [];
    try {
      for (const a of list) {
        await add(rcon, a);
        added.push(a);
      }
      return await fn();
    } finally {
      for (const a of added.reverse()) await remove(rcon, a);
    }
  }

  return {
    add, remove, flush, withForceload,
    held: () => counts.size,
    pending: () => [...unreleased].filter((k) => !counts.has(k)).length,
  };
}

// One process, one world: every caller shares the same counts.
export const forceloader = createForceloader({
  log: (...a) => console.log(new Date().toISOString(), ...a),
});

export const withForceload = (rcon, areas, fn) => forceloader.withForceload(rcon, areas, fn);

/** A block area grown by `pad` on every side. */
export const padArea = (r, pad = 0) => ({
  x1: Math.min(r.x1, r.x2) - pad, z1: Math.min(r.z1, r.z2) - pad,
  x2: Math.max(r.x1, r.x2) + pad, z2: Math.max(r.z1, r.z2) + pad,
});

// forceload only *marks* chunks; the server loads (and, out in never-visited
// territory, generates) them over subsequent ticks. Cloning too early succeeds
// loudly while copying the wrong thing - which silently turns an undo into
// "paste natural bedrock over the child's build". Wait for the engine to confirm.
export async function waitLoaded(rcon, corners, timeoutMs = 60000, pollMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let all = true;
    for (const c of corners) {
      const r = await rcon.send(`execute if loaded ${c.x} ${c.y} ${c.z}`);
      if (!/Test passed/i.test(r)) { all = false; break; }
    }
    if (all) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error('timed out waiting for chunks to load');
}
