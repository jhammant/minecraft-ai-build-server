// The build pipeline, shared by both front ends.
//
// Chat (`!build a castle`) and the web panel (click the map, type a prompt) are
// the same job with a different way of choosing where to build, so the pipeline
// lives here and each caller supplies an origin strategy and a way to report
// progress.

import { generateBuildPlan } from './llm.js';
import { validatePlan, ValidationError, WORLD_MIN_Y, WORLD_MAX_Y } from './validate.js';
import { spansToCommands } from './compile.js';
import { snapshot, restore, slotFor } from './undo.js';

export { ValidationError };

// "Name has the following entity data: [123.5d, 64.0d, -456.5d]"
export async function getPlayerPos(rcon, player) {
  const res = await rcon.send(`data get entity ${player} Pos`);
  const nums = res.match(/-?\d+\.?\d*/g);
  if (!nums || nums.length < 3) throw new Error(`could not read position for ${player}`);
  const vals = nums.slice(-3).map(Number);
  return { x: vals[0], y: vals[1], z: vals[2] };
}

// Yaw: 0 = south (+z), 90 = west (-x), 180 = north (-z), 270 = east (+x)
export async function getPlayerYaw(rcon, player) {
  const res = await rcon.send(`data get entity ${player} Rotation`);
  const nums = res.match(/-?\d+\.?\d*/g);
  if (!nums || nums.length < 1) return 0;
  return Number(nums[nums.length - 2] ?? nums[0]);
}

const forwardVector = (yaw) => {
  const rad = (yaw * Math.PI) / 180;
  return { x: -Math.sin(rad), z: Math.cos(rad) };
};

// There's no "give me the terrain height" command, so find the highest solid
// block by binary search and build on top of it.
//
// The obvious version searches UP from the bottom for the first air block. That
// is wrong twice over: the bottom of the world is bedrock (so a "is the floor
// air?" guard never passes), and caves mean air appears long before the
// surface. Searching DOWN from the sky is sound, because everything above the
// terrain really is air.
// Highest surface across a build's whole footprint. Using the centre point
// alone buries anything wider than the terrain is flat - the ground rises under
// one corner and swallows the build. Sit on the highest point instead.
export async function footprintSurfaceY(rcon, cx, cz, halfX, halfZ) {
  const xs = [cx, cx - halfX, cx + halfX, cx, cx, cx - halfX, cx + halfX, cx - halfX, cx + halfX];
  const zs = [cz, cz, cz, cz - halfZ, cz + halfZ, cz - halfZ, cz + halfZ, cz + halfZ, cz - halfZ];
  let best = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    best = Math.max(best, await findSurfaceY(rcon, xs[i], zs[i]));
  }
  return best;
}

export async function findSurfaceY(rcon, x, z) {
  const isAir = async (y) => /Test passed/i.test(
    await rcon.send(`execute if block ${x} ${y} ${z} air`),
  );
  let lo = WORLD_MIN_Y;      // assumed solid
  let hi = WORLD_MAX_Y;      // assumed air
  if (!(await isAir(hi))) return hi;          // solid to the ceiling
  if (await isAir(lo)) return lo + 1;         // void column
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await isAir(mid)) hi = mid; else lo = mid;
  }
  return lo + 1;             // first free block above the highest solid one
}

export function createBuilder({ env, limits, state, saveState, log }) {
  let busy = false;
  const maxPerHour = Number(env.MAX_BUILDS_PER_HOUR || 20);
  const cooldownMs = Number(env.BUILD_COOLDOWN_SEC || 10) * 1000;
  // Per-player limits alone don't bound the bill: ten players at 20/hour is
  // 200/hour. These two cap the whole server.
  const maxPerHourGlobal = Number(env.MAX_BUILDS_PER_HOUR_GLOBAL || 60);
  const dailyCostLimit = Number(env.DAILY_COST_LIMIT_USD || 2);

  const today = () => new Date().toISOString().slice(0, 10);

  function spentToday() {
    const ledger = state.spend || {};
    return ledger[today()] || 0;
  }

  function recordSpend(usd) {
    state.spend = state.spend || {};
    const day = today();
    state.spend[day] = (state.spend[day] || 0) + (usd || 0);
    // Keep a fortnight; drop the rest so state.json can't grow forever.
    const keep = Object.keys(state.spend).sort().slice(-14);
    state.spend = Object.fromEntries(keep.map((d) => [d, state.spend[d]]));
  }

  function globalLimit() {
    if (dailyCostLimit > 0 && spentToday() >= dailyCostLimit) {
      return `the server has reached today's AI budget ($${dailyCostLimit.toFixed(2)}). `
        + 'It resets tomorrow.';
    }
    const now = Date.now();
    const recent = Object.values(state.builds || {})
      .flat().filter((tms) => now - tms < 3600_000).length;
    if (recent >= maxPerHourGlobal) {
      return `the server has built ${recent} things this hour, which is the limit for everyone.`;
    }
    return null;
  }

  function rateLimit(player) {
    const now = Date.now();
    const hist = (state.builds[player] || []).filter((t) => now - t < 3600_000);
    state.builds[player] = hist;
    if (hist.length >= maxPerHour) {
      return `you've built ${hist.length} things this hour - take a break and try again later!`;
    }
    const last = hist[hist.length - 1];
    if (last && now - last < cooldownMs) {
      return `hold on ${Math.ceil((cooldownMs - (now - last)) / 1000)}s before the next build!`;
    }
    return null;
  }

  /**
   * @param {object}   o
   * @param {object}   o.rcon
   * @param {string}   o.player       who to attribute and rate-limit against
   * @param {string}   o.description  what to build
   * @param {object=}  o.at           explicit {x,y,z}; omit to build in front of the player
   * @param {function} o.notify       (message, kind) => void, for progress
   */
  async function run({ rcon, player, description, at, notify = () => {} }) {
    if (busy) throw new Error('Someone else is building right now - try again in a moment!');
    const limited = rateLimit(player) || globalLimit();
    if (limited) throw new Error(limited);
    if (!description || description.trim().length < 3) {
      throw new Error('Tell me what to build, e.g. "a wizard tower"');
    }

    busy = true;
    const started = Date.now();
    try {
      // Decide the ground level first: validation needs origin.y to check the
      // build won't poke through the top or bottom of the world.
      let originY;
      let placement;
      if (at && Number.isFinite(at.x) && Number.isFinite(at.z)) {
        // Load the area BEFORE probing it. In an unloaded chunk every
        // `execute if block` fails, which reads as "solid" and sends the
        // surface search to the world ceiling.
        const p = limits.maxExtent;
        await rcon.send(`forceload add ${at.x - p} ${at.z - p} ${at.x + p} ${at.z + p}`).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
        originY = Number.isFinite(at.y) ? Math.floor(at.y) : await findSurfaceY(rcon, at.x, at.z);
        placement = { mode: 'at', x: Math.round(at.x), z: Math.round(at.z) };
      } else {
        const pos = await getPlayerPos(rcon, player);
        const yaw = await getPlayerYaw(rcon, player);
        originY = Math.floor(pos.y);
        placement = { mode: 'ahead', pos, yaw };
      }

      notify(`Thinking about "${description}"...`, 'info');

      const verify = (plan) => validatePlan(plan, { x: 0, y: originY, z: 0 }, limits);
      const { plan, verified, usage, attempts, model } = await generateBuildPlan(
        description, env, verify,
      );

      let origin;
      if (placement.mode === 'at') {
        // Now the footprint is known, re-check the ground across it rather than
        // trusting the single probe taken before the plan existed.
        let y = originY;
        if (!Number.isFinite(at?.y)) {
          const halfX = Math.ceil(verified.size.x / 2);
          const halfZ = Math.ceil(verified.size.z / 2);
          const ground = await footprintSurfaceY(rcon, placement.x, placement.z, halfX, halfZ);
          if (Number.isFinite(ground)
              && ground + verified.bounds.y2 <= WORLD_MAX_Y
              && ground + verified.bounds.y1 >= WORLD_MIN_Y) {
            y = ground;
          }
        }
        origin = { x: placement.x, y, z: placement.z };
      } else {
        // Push the build clear of the player's own body.
        const fwd = forwardVector(placement.yaw);
        const reach = 4 + Math.max(
          Math.abs(verified.bounds.x1), Math.abs(verified.bounds.x2),
          Math.abs(verified.bounds.z1), Math.abs(verified.bounds.z2),
        );
        origin = {
          x: Math.round(placement.pos.x + fwd.x * reach),
          y: originY,
          z: Math.round(placement.pos.z + fwd.z * reach),
        };
      }

      const commands = spansToCommands(verified.spans, origin);
      log(`build "${plan.name}" for ${player} at ${origin.x},${origin.y},${origin.z}: `
        + `${verified.blocks} blocks, ${commands.length} commands, ${attempts} attempt(s), ${model}`);

      notify(`Building "${plan.name}" - ${verified.blocks} blocks...`, 'progress');

      const pad = limits.maxExtent;
      await rcon.send(
        `forceload add ${origin.x - pad} ${origin.z - pad} ${origin.x + pad} ${origin.z + pad}`,
      ).catch(() => {});

      const region = {
        x1: verified.bounds.x1 + origin.x, y1: verified.bounds.y1 + origin.y,
        z1: verified.bounds.z1 + origin.z, x2: verified.bounds.x2 + origin.x,
        y2: verified.bounds.y2 + origin.y, z2: verified.bounds.z2 + origin.z,
      };
      // Take the undo snapshot, retrying once. This is the step that fails
      // when the server is busy (a pre-generation pass, or a big render), and
      // a build with no snapshot can never be undone - so it's worth a retry
      // and a loud log rather than a silent downgrade.
      let snap = null;
      for (let attempt = 1; attempt <= 2 && !snap; attempt++) {
        try {
          snap = await snapshot(rcon, region, slotFor(player));
        } catch (e) {
          log(`SNAPSHOT FAILED (attempt ${attempt}/2) for ${player}: ${e.message}`);
          if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (!snap) log(`WARNING: building "${description}" with NO UNDO available`);

      let done = 0;
      for (const cmd of commands) {
        const res = await rcon.send(cmd);
        if (/^(Failed|Unknown|Incorrect|That position)/i.test(res.trim())) {
          log(`command rejected: ${cmd} -> ${res.trim().slice(0, 120)}`);
        }
        if (++done % 40 === 0) await new Promise((r) => setTimeout(r, 60));
      }

      await rcon.send(
        `forceload remove ${origin.x - pad} ${origin.z - pad} ${origin.x + pad} ${origin.z + pad}`,
      ).catch(() => {});

      const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
      state.builds[player] = [...(state.builds[player] || []), Date.now()];
      state.lastBuild[player] = {
        name: plan.name, at: Date.now(), origin, blocks: verified.blocks, snap,
      };
      // OpenRouter returns the actual charged cost; fall back to a rough token
      // estimate for backends that don't.
      const cost = Number(usage?.cost)
        || ((usage?.prompt_tokens || 0) * 0.58 + (usage?.completion_tokens || 0) * 2.44) / 1e6;
      recordSpend(cost);

      state.history = [
        { player, name: plan.name, summary: plan.summary, description,
          origin, blocks: verified.blocks, seconds, at: Date.now(),
          // Kept so a build can be located (and cleared) even if its undo
          // snapshot failed.
          region, undoable: Boolean(snap) },
        ...(state.history || []),
      ].slice(0, 100);
      saveState(state);

      return {
        name: plan.name, summary: plan.summary, blocks: verified.blocks,
        size: verified.size, origin, seconds, model, attempts,
        undoable: Boolean(snap), usage,
        cost, spentToday: spentToday(), dailyCostLimit,
      };
    } finally {
      busy = false;
    }
  }

  async function undo({ rcon, player }) {
    const last = state.lastBuild[player];
    if (!last) throw new Error("You haven't built anything for me to undo yet.");
    if (!last.snap) throw new Error(`I don't have a snapshot of "${last.name}" to restore.`);
    await restore(rcon, last.snap);
    const name = last.name;
    delete state.lastBuild[player];
    saveState(state);
    return { name };
  }

  return { run, undo, isBusy: () => busy, rateLimit, spentToday, dailyCostLimit };
}
