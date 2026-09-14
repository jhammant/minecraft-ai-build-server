// Undo, built on vanilla /clone.
//
// The obvious approach - let CoreProtect roll our changes back - does not work:
// CoreProtect logs *events* (a player placing a block), and /fill from RCON
// fires no such event, so there is nothing to roll back. Verified on the live
// server; no config option changes it. CoreProtect still earns its place for
// griefing done by actual players, which is its real job.
//
// Instead we photocopy the region before touching it. /clone is server-side,
// needs no block reads, and restores terrain exactly - including whatever the
// child had already built there.

import { withForceload, waitLoaded, padArea } from './forceload.js';

const CLONE_LIMIT = 32768; // engine limit per /clone

// A far-away, otherwise unused area used as the photocopy tray. Each player
// gets their own 128-wide slot so two people building at once can't clobber
// each other's undo. y is low enough that a 96-tall build still fits under the
// world ceiling.
const VAULT = { x: 1_000_000, y: -60, z: 1_000_000 };
const SLOT_WIDTH = 256;   // > MAX_EXTENT, or snapshots collide

export function vaultOrigin(slot) {
  return { x: VAULT.x + slot * SLOT_WIDTH, y: VAULT.y, z: VAULT.z };
}

// Split a region into pieces small enough for a single /clone.
function splitRegion(r) {
  const vol = (r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1) * (r.z2 - r.z1 + 1);
  if (vol <= CLONE_LIMIT) return [r];
  const dx = r.x2 - r.x1 + 1;
  const dy = r.y2 - r.y1 + 1;
  const dz = r.z2 - r.z1 + 1;
  if (dx >= dy && dx >= dz) {
    const mid = r.x1 + Math.floor(dx / 2) - 1;
    return [...splitRegion({ ...r, x2: mid }), ...splitRegion({ ...r, x1: mid + 1 })];
  }
  if (dy >= dz) {
    const mid = r.y1 + Math.floor(dy / 2) - 1;
    return [...splitRegion({ ...r, y2: mid }), ...splitRegion({ ...r, y1: mid + 1 })];
  }
  const mid = r.z1 + Math.floor(dz / 2) - 1;
  return [...splitRegion({ ...r, z2: mid }), ...splitRegion({ ...r, z1: mid + 1 })];
}

const cornersOf = (r) => [
  { x: r.x1, y: r.y1, z: r.z1 },
  { x: r.x2, y: r.y2, z: r.z2 },
  { x: r.x1, y: r.y1, z: r.z2 },
  { x: r.x2, y: r.y1, z: r.z1 },
];

const vaultRegionFor = (region, slot) => {
  const vault = vaultOrigin(slot);
  return {
    x1: vault.x, y1: vault.y, z1: vault.z,
    x2: vault.x + (region.x2 - region.x1),
    y2: vault.y + (region.y2 - region.y1),
    z2: vault.z + (region.z2 - region.z1),
  };
};

// Both ends stay loaded only while copying, and are released however the copy
// ends - a failed snapshot used to leave the vault loaded for good.
function withBothEnds(rcon, region, vaultRegion, fn) {
  return withForceload(rcon, [padArea(vaultRegion, 16), padArea(region, 16)], async () => {
    await waitLoaded(rcon, [...cornersOf(vaultRegion), ...cornersOf(region)]);
    return fn();
  });
}

/**
 * Copy `region` (world coords) into the player's vault slot.
 * Returns the info needed to restore it later.
 */
export async function snapshot(rcon, region, slot) {
  const vaultRegion = vaultRegionFor(region, slot);
  return withBothEnds(rcon, region, vaultRegion, async () => {
    let cloned = 0;
    for (const piece of splitRegion(region)) {
      // Destination is the piece's lower corner translated into the vault.
      const dx = vaultRegion.x1 + (piece.x1 - region.x1);
      const dy = vaultRegion.y1 + (piece.y1 - region.y1);
      const dz = vaultRegion.z1 + (piece.z1 - region.z1);
      const res = await rcon.send(
        `clone ${piece.x1} ${piece.y1} ${piece.z1} ${piece.x2} ${piece.y2} ${piece.z2} ${dx} ${dy} ${dz}`,
      );
      // Verify from the clone's own report. Comparing the regions afterwards
      // with `execute if blocks` looks stricter but is useless here: the world
      // is live, so flowing water, falling gravel and decaying leaves change
      // blocks between the copy and the check, and it fails on a perfectly good
      // snapshot. The copied-block count catches the failure that actually
      // matters - cloning into chunks that were not loaded, which copies nothing.
      const m = res.trim().match(/Successfully cloned (\d+)/i);
      if (!m) {
        throw new Error(`snapshot clone failed: ${res.trim().slice(0, 140) || '(empty response)'}`);
      }
      const expected = (piece.x2 - piece.x1 + 1) * (piece.y2 - piece.y1 + 1) * (piece.z2 - piece.z1 + 1);
      if (Number(m[1]) !== expected) {
        throw new Error(`snapshot incomplete: cloned ${m[1]} of ${expected} blocks`);
      }
      cloned++;
    }
    return { region, slot, pieces: cloned };
  });
}

/**
 * Copy the vault slot back over the original region.
 */
export async function restore(rcon, snap) {
  const { region, slot } = snap;
  const vaultRegion = vaultRegionFor(region, slot);
  return withBothEnds(rcon, region, vaultRegion, async () => {
    for (const piece of splitRegion(vaultRegion)) {
      const dx = region.x1 + (piece.x1 - vaultRegion.x1);
      const dy = region.y1 + (piece.y1 - vaultRegion.y1);
      const dz = region.z1 + (piece.z1 - vaultRegion.z1);
      const res = await rcon.send(
        `clone ${piece.x1} ${piece.y1} ${piece.z1} ${piece.x2} ${piece.y2} ${piece.z2} ${dx} ${dy} ${dz}`,
      );
      if (!/^Successfully cloned/i.test(res.trim())) {
        throw new Error(`restore clone failed: ${res.trim().slice(0, 140) || '(empty response)'}`);
      }
    }
    return true;
  });
}

// Stable slot per player so concurrent builders don't share a tray.
export function slotFor(player, slots = 16) {
  let h = 0;
  for (let i = 0; i < player.length; i++) h = (h * 31 + player.charCodeAt(i)) >>> 0;
  return h % slots;
}
