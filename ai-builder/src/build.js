// The build pipeline, shared by both front ends.
//
// Chat (`!build a castle`) and the web panel (click the map, type a prompt) are
// the same job with a different way of choosing where to build, so the pipeline
// lives here and each caller supplies an origin strategy and a way to report
// progress.

import fs from 'node:fs';
import { generateBuildPlan } from './llm.js';
import { validatePlan, ValidationError, WORLD_MIN_Y, WORLD_MAX_Y } from './validate.js';
import { spansToCommands } from './compile.js';
import { renderIso } from './render-iso.js';
import { encodePNG } from './png.js';
import { snapshot, restore, slotFor } from './undo.js';
import { withForceload, waitLoaded, padArea } from './forceload.js';
import { createBlockChecker } from './blocks.js';

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

// How far ahead of the player to put a build so it clears their own body.
const reachFor = (bounds) => 4 + Math.max(
  Math.abs(bounds.x1), Math.abs(bounds.x2), Math.abs(bounds.z1), Math.abs(bounds.z2),
);

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

// Foliage the probe must see straight through. A binary search from the sky
// stops at the first thing that isn't air, and in a forest that is the top of a
// tree - which is exactly why builds ended up perched on the canopy.
const FOLIAGE = ['#minecraft:leaves', '#minecraft:logs', '#minecraft:replaceable',
  'bamboo', 'cactus', 'sugar_cane', 'vine', 'snow'];
const MAX_CANOPY = 48;       // tallest jungle tree, with room to spare

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

  // `lo` is the highest non-air block. If it's part of a tree, keep walking
  // down until real ground. Done by testing rather than by clearing, so the
  // measurement never changes the world before the undo snapshot is taken.
  let y = lo;
  for (let step = 0; step < MAX_CANOPY; step++) {
    let leafy = false;
    for (const kind of FOLIAGE) {
      if (/Test passed/i.test(await rcon.send(`execute if block ${x} ${y} ${z} ${kind}`))) {
        leafy = true;
        break;
      }
    }
    if (!leafy) break;
    y--;
    // Air under a canopy is still canopy - keep going until something solid.
    while (y > WORLD_MIN_Y && await isAir(y)) y--;
  }
  return y + 1;              // first free block above the ground
}

// Trees standing inside the footprint poke through walls and roofs. Clearing
// them is part of "put this on the land", and it happens AFTER the snapshot so
// undo puts the wood back.
export async function clearFoliage(rcon, region) {
  const { x1, x2, z1, z2 } = region;
  const area = (x2 - x1 + 1) * (z2 - z1 + 1);
  const slice = Math.max(1, Math.floor(30000 / Math.max(1, area)));
  const top = Math.min(WORLD_MAX_Y, region.y2 + 24);
  for (const kind of ['#minecraft:leaves', '#minecraft:logs', '#minecraft:replaceable']) {
    for (let y = region.y1; y <= top; y += slice) {
      const yTop = Math.min(y + slice - 1, top);
      await rcon.send(`fill ${x1} ${y} ${z1} ${x2} ${yTop} ${z2} air replace ${kind}`)
        .catch(() => {});
    }
  }
}

// The handful of blocks that dominate a build, for the details panel.
function topMaterials(spans, n = 6) {
  const vol = new Map();
  for (const s of spans) {
    const base = String(s.material).split('[')[0].replace(/^minecraft:/, '');
    if (base === 'air') continue;
    vol.set(base, (vol.get(base) || 0)
      + (s.x2 - s.x1 + 1) * (s.y2 - s.y1 + 1) * (s.z2 - s.z1 + 1));
  }
  return [...vol.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([m]) => m);
}

// A row saying "211,845 blocks" doesn't tell you what got made. We already hold
// every block's position and material, so draw it: no camera to fly, no chunk to
// load, no chance of photographing the inside of a wall.
function saveShot(dir, id, spans, log) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const img = renderIso(spans, { width: 640, height: 640 });
    fs.writeFileSync(`${dir}/${id}.png`, encodePNG(img));
    return `${id}.png`;
  } catch (err) {
    // A missing picture must never fail a build that actually worked.
    log(`could not render preview: ${err.message}`);
    return null;
  }
}

// With REWARDS_MODE=off (the default) the builder must behave exactly as it did
// before rewards existed, so an absent ledger is a ledger that charges nothing
// and caps nothing.
const NO_REWARDS = {
  enabled: () => false,
  check: () => null,
  quote: () => ({ band: null, price: 0, affordable: true }),
  charge: () => null,
  limitsFor: (_player, base) => base,
};

export function createBuilder({
  env, limits, state, saveState, log, rewards = NO_REWARDS,
  // Injectable so the placement pipeline can be tested without paying for a
  // model call.
  generate = generateBuildPlan,
}) {
  let busy = false;
  const blockChecker = createBlockChecker({ log });
  // A single "Thinking..." then silence for four minutes reads as a hang. Track
  // what the build is actually doing so the panel can show it.
  let progress = null;
  const setProgress = (phase, detail, done, total) => {
    progress = { phase, detail, done, total, at: Date.now() };
  };
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
    // Checked before the model is asked anything: if they can't afford the
    // cheapest build on the board, there is no point paying for a plan just to
    // find out this one costs more.
    const broke = rewards.check(player);
    if (broke) throw new Error(broke);

    // Rank only ever narrows the server's envelope (see limitsFor), so this is
    // safe to hand straight to the validator.
    const lim = rewards.limitsFor(player, limits);

    busy = true;
    const started = Date.now();
    try {
      // Decide the ground level first: validation needs origin.y to check the
      // build won't poke through the top or bottom of the world.
      let originY;
      let placement;
      if (at && Number.isFinite(at.x) && Number.isFinite(at.z)) {
        placement = { mode: 'at', x: Math.round(at.x), z: Math.round(at.z) };
        // Load the spot BEFORE probing it. In an unloaded chunk every
        // `execute if block` fails, which reads as "solid" and sends the
        // surface search to the world ceiling. Released straight after: the
        // model is about to think for minutes, and nothing needs these chunks
        // ticking while it does.
        originY = Number.isFinite(at.y) ? Math.floor(at.y)
          : await withForceload(rcon, [padArea({ x1: placement.x, z1: placement.z,
            x2: placement.x, z2: placement.z }, 16)], async () => {
            await waitLoaded(rcon, [{ x: placement.x, y: 0, z: placement.z }], 20000);
            return findSurfaceY(rcon, placement.x, placement.z);
          });
      } else {
        const pos = await getPlayerPos(rcon, player);
        const yaw = await getPlayerYaw(rcon, player);
        originY = Math.floor(pos.y);
        placement = { mode: 'ahead', pos, yaw };
      }

      setProgress('thinking', `Designing "${description}"`, 0, 0);
      notify(`Thinking about "${description}"...`, 'info');

      const verify = async (plan) => {
        const checked = validatePlan(plan, { x: 0, y: originY, z: 0 }, lim);
        // The validator knows the id is well-formed; only the server knows it
        // exists. An id it doesn't recognise used to be dropped silently at
        // build time - 47 plants vanished from one aquarium - so ask first,
        // and send the answer back to the model like any other rejection.
        const unknown = await blockChecker.unknown(rcon, checked.materials);
        if (unknown.length) {
          throw new ValidationError(
            `these are not block ids in Minecraft Java 26.1 and would not be placed: `
            + `${unknown.map((u) => `${u.material} (${u.reason})`).join('; ')}. `
            + 'Use exact current ids, e.g. seagrass, dirt_path, short_grass, oak_planks.',
          );
        }
        return checked;
      };
      const onAttempt = (n, of) => setProgress('thinking',
        n === 1 ? `Designing "${description}"` : `Retry ${n} of ${of} — the first plan didn't pass the safety check`, 0, 0);
      const { plan, verified, usage, attempts, model } = await generate(
        description, env, verify, { onAttempt },
      );

      // Now the plan exists, its real size is known - so a hut costs a hut and
      // a castle costs a castle. Refused here, nothing has been placed yet.
      const bill = rewards.quote(player, verified.blocks);
      if (!bill.affordable) {
        throw new Error(`"${plan.name}" is a ${bill.band} build and costs ${bill.price} credits `
          + `- you have ${bill.credits}. Ask for something smaller, or go and build a bit more!`);
      }

      // Where the build goes across x/z is known now; only its height may still
      // need the ground probed. Everything from here to the last block placed
      // runs with the site force-loaded, and the chunks are released however it
      // ends - a failure used to leave hundreds of them loaded for good.
      const ox = placement.mode === 'at' ? placement.x : Math.round(placement.pos.x
        + forwardVector(placement.yaw).x * reachFor(verified.bounds));
      const oz = placement.mode === 'at' ? placement.z : Math.round(placement.pos.z
        + forwardVector(placement.yaw).z * reachFor(verified.bounds));
      const site = {
        x1: verified.bounds.x1 + ox, z1: verified.bounds.z1 + oz,
        x2: verified.bounds.x2 + ox, z2: verified.bounds.z2 + oz,
      };

      // The ground probe samples a square centred on the origin, which can reach
      // past a lopsided footprint - so keep that loaded too.
      const probe = {
        x1: ox - Math.ceil(verified.size.x / 2), z1: oz - Math.ceil(verified.size.z / 2),
        x2: ox + Math.ceil(verified.size.x / 2), z2: oz + Math.ceil(verified.size.z / 2),
      };

      const placed = await withForceload(rcon, [padArea(site, 16), padArea(probe, 16)], async () => {
        await waitLoaded(rcon, [{ x: site.x1, y: 0, z: site.z1 }, { x: site.x2, y: 0, z: site.z2 }], 30000);

        let y = originY;
        if (placement.mode === 'at' && !Number.isFinite(at?.y)) {
          // Now the footprint is known, re-check the ground across it rather
          // than trusting the single probe taken before the plan existed.
          const halfX = Math.ceil(verified.size.x / 2);
          const halfZ = Math.ceil(verified.size.z / 2);
          const ground = await footprintSurfaceY(rcon, ox, oz, halfX, halfZ);
          if (Number.isFinite(ground)
              && ground + verified.bounds.y2 <= WORLD_MAX_Y
              && ground + verified.bounds.y1 >= WORLD_MIN_Y) {
            y = ground;
          }
        }
        const origin = { x: ox, y, z: oz };

        const commands = spansToCommands(verified.spans, origin);
        log(`build "${plan.name}" for ${player} at ${origin.x},${origin.y},${origin.z}: `
          + `${verified.blocks} blocks, ${commands.length} commands, ${attempts} attempt(s), ${model}`);

        setProgress('placing', `Building "${plan.name}"`, 0, commands.length);
        notify(`Building "${plan.name}" - ${verified.blocks} blocks...`, 'progress');

        const region = {
          x1: verified.bounds.x1 + origin.x, y1: verified.bounds.y1 + origin.y,
          z1: verified.bounds.z1 + origin.z, x2: verified.bounds.x2 + origin.x,
          y2: verified.bounds.y2 + origin.y, z2: verified.bounds.z2 + origin.z,
        };
        // Take the undo snapshot, retrying once. This is the step that fails
        // when the server is busy (a pre-generation pass, or a big render), and
        // a build with no snapshot can never be undone - so it's worth a retry
        // and a loud log rather than a silent downgrade.
        setProgress('snapshot', 'Saving the area so this can be undone', 0, 0);
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

        // Now the area is safely recorded, take the trees out of it.
        setProgress('clearing', 'Clearing trees off the site', 0, 0);
        await clearFoliage(rcon, region);

        let done = 0;
        for (const cmd of commands) {
          const res = await rcon.send(cmd);
          if (/^(Failed|Unknown|Incorrect|That position)/i.test(res.trim())) {
            log(`command rejected: ${cmd} -> ${res.trim().slice(0, 120)}`);
          }
          if (++done % 40 === 0) {
            setProgress('placing', `Building "${plan.name}"`, done, commands.length);
            await new Promise((r) => setTimeout(r, 60));
          }
        }
        return { origin, region, snap, commands };
      });
      const { origin, region, snap, commands } = placed;

      const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
      // Charged only once the blocks are actually in the ground: a build that
      // fell over halfway is not one they should have paid for.
      const wallet = rewards.charge(player, bill.price);
      state.builds[player] = [...(state.builds[player] || []), Date.now()];
      state.lastBuild[player] = {
        name: plan.name, at: Date.now(), origin, blocks: verified.blocks, snap,
      };
      // OpenRouter returns the actual charged cost; fall back to a rough token
      // estimate for backends that don't.
      const cost = Number(usage?.cost)
        || ((usage?.prompt_tokens || 0) * 0.58 + (usage?.completion_tokens || 0) * 2.44) / 1e6;
      recordSpend(cost);

      // One timestamp identifies the build everywhere: history key and picture.
      // (`at` is already the caller's placement argument, hence the name.)
      const builtAt = Date.now();
      state.history = [
        { player, name: plan.name, summary: plan.summary, description,
          origin, blocks: verified.blocks, seconds, at: builtAt,
          ops: plan.ops.length, commands: commands.length, model,
          shot: saveShot(`${env.STATE_DIR || '/state'}/shots`, builtAt, verified.spans, log),
          size: verified.size, cost, materials: topMaterials(verified.spans),
          price: bill.price || 0, band: bill.band,
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
        price: bill.price || 0, band: bill.band, wallet,
      };
    } finally {
      busy = false;
      progress = null;
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

  return { run, undo, isBusy: () => busy, progress: () => progress, rateLimit, spentToday, dailyCostLimit };
}
