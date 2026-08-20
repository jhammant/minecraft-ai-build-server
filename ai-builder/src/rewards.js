// "Earn it" mode: the AI builder as a reward rather than a tap.
//
// The idea came from a comment on a post about this server: a kid who can
// summon a castle by typing one line never learns patience, determination or
// follow-through. So make the summoning cost something they can only get by
// building with their own hands.
//
// Two levers, independently switchable:
//
//   credits - how OFTEN they can summon. Earned by playing, spent per build,
//             priced by how big the thing they asked for turned out to be.
//   ranks   - how BIG they may summon. Lifetime points, never spent, each rank
//             widening the size envelope the validator will accept.
//
// Both are OFF by default (REWARDS_MODE=off): a fresh clone of this repo
// behaves exactly as it did before this file existed.
//
// Effort is measured from the vanilla statistics files the server already
// writes - no plugin, no extra process. The ai-builder container mounts /data
// read-only, which is all this needs.

import fs from 'node:fs';
import path from 'node:path';

export const MODES = ['off', 'credits', 'ranks', 'both'];
export const EARN_SOURCES = ['placed', 'mixed', 'granted'];

// --- what counts as "doing something with your own hands" --------------------
//
// minecraft:used counts item USES, which for a block item means placements.
// It also counts firing a bow, throwing a snowball and eating a sandwich.
//
// Rather than try to enumerate every block in the game (a list that silently
// under-credits real work the moment Mojang adds a stone variant), this denies
// the handful of items that are *spammable* - the ones a kid could click a
// thousand times in a minute. Eating the occasional bread roll is noise; being
// able to farm credits with a stack of snowballs is not.
const SPAMMABLE = new Set([
  'bow', 'crossbow', 'trident', 'fishing_rod', 'flint_and_steel', 'shears',
  'snowball', 'egg', 'ender_pearl', 'ender_eye', 'firework_rocket', 'bone_meal',
  'experience_bottle', 'lead', 'name_tag', 'shield', 'elytra', 'compass', 'clock',
  'spyglass', 'goat_horn', 'wind_charge', 'ominous_bottle',
]);
const SPAMMABLE_SUFFIX = [
  '_bucket', '_spawn_egg', '_boat', '_chest_boat', '_minecart', '_raft',
  '_horse_armor', '_potion', 'potion',
];

export function isSpammable(key) {
  const base = String(key).split(':').pop();
  if (SPAMMABLE.has(base)) return true;
  return SPAMMABLE_SUFFIX.some((s) => base.endsWith(s));
}

/**
 * Reduce a whole stats file to the four numbers the ledger cares about.
 * Shape: { stats: { "minecraft:used": { "minecraft:oak_planks": 412 }, ... } }
 */
export function countersFrom(json) {
  const s = (json && json.stats) || {};
  const custom = s['minecraft:custom'] || {};
  const sum = (obj, skip) => Object.entries(obj || {}).reduce(
    (n, [k, v]) => (skip && skip(k) ? n : n + (Number(v) || 0)), 0,
  );
  return {
    placed: sum(s['minecraft:used'], isSpammable),
    mined: sum(s['minecraft:mined']),
    crafted: sum(s['minecraft:crafted']),
    // Centimetres. Minecraft really does count distance this way.
    cm: (Number(custom['minecraft:walk_one_cm']) || 0)
      + (Number(custom['minecraft:sprint_one_cm']) || 0),
  };
}

export const zeroCounters = () => ({ placed: 0, mined: 0, crafted: 0, cm: 0 });

// A stats file only ever grows, except when a world is reset or a player's
// stats are wiped - in which case a negative delta must credit nothing rather
// than going backwards.
export function deltaOf(now, before) {
  const out = {};
  for (const k of Object.keys(zeroCounters())) {
    out[k] = Math.max(0, (now[k] || 0) - (before?.[k] || 0));
  }
  return out;
}

export function pointsFor(delta, rates) {
  const raw = (delta.placed || 0) * rates.placed
    + (delta.mined || 0) * rates.mined
    + (delta.crafted || 0) * rates.crafted
    + ((delta.cm || 0) / 10000) * rates.travel;   // per 100 metres
  return Math.max(0, Math.floor(raw));
}

// Presets behind REWARDS_EARN. Any individual rate can still be overridden.
const RATE_PRESETS = {
  // Only blocks you placed yourself. The strictest reading of "learning to DO".
  placed: { placed: 1, mined: 0, crafted: 0, travel: 0 },
  // Placing, mining, crafting and exploring all count, at different weights.
  mixed: { placed: 1, mined: 0.5, crafted: 2, travel: 0.5 },
  // Nothing is earned in game. Credits come from a grown-up pressing the
  // button in the panel - for chores, homework, whatever you decide.
  granted: { placed: 0, mined: 0, crafted: 0, travel: 0 },
};

// Deliberately absent from every preset: time online. Sitting in a chair is
// not effort, and rewarding it teaches exactly the wrong lesson.

// --- ranks -------------------------------------------------------------------
//
// A rank never widens the server's own safety envelope - limitsFor() takes the
// smaller of the two - so promoting someone can't outrun MAX_BLOCKS.
export const RANK_NAMES = ['Apprentice', 'Builder', 'Architect', 'Master'];
export const RANK_LIMITS = [
  { maxBlocks: 8000, maxExtent: 40 },
  { maxBlocks: 40000, maxExtent: 72 },
  { maxBlocks: 150000, maxExtent: 96 },
  { maxBlocks: Infinity, maxExtent: Infinity },
];

export function rankFor(lifetime, thresholds) {
  let i = 0;
  for (let n = 0; n < thresholds.length; n++) if (lifetime >= thresholds[n]) i = n;
  return {
    index: i,
    name: RANK_NAMES[i],
    ...RANK_LIMITS[i],
    next: i + 1 < thresholds.length
      ? { name: RANK_NAMES[i + 1], at: thresholds[i + 1], toGo: thresholds[i + 1] - lifetime }
      : null,
  };
}

// --- pricing -----------------------------------------------------------------
//
// Priced after the plan exists, so a hut costs a hut and a castle costs a
// castle. The model's own idea of "big" is not to be trusted; the validator's
// block count is.
export function priceFor(blocks, cfg) {
  if (blocks <= cfg.bandSmall) return { band: 'small', price: cfg.priceSmall };
  if (blocks <= cfg.bandMedium) return { band: 'medium', price: cfg.priceMedium };
  return { band: 'large', price: cfg.priceLarge };
}

// --- configuration -----------------------------------------------------------

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');

export function readConfig(env = {}) {
  const mode = MODES.includes(String(env.REWARDS_MODE || 'off').toLowerCase())
    ? String(env.REWARDS_MODE || 'off').toLowerCase() : 'off';
  const earn = EARN_SOURCES.includes(String(env.REWARDS_EARN || 'placed').toLowerCase())
    ? String(env.REWARDS_EARN || 'placed').toLowerCase() : 'placed';
  const preset = RATE_PRESETS[earn];

  const thresholds = String(env.REWARDS_RANK_POINTS || '0,2000,10000,40000')
    .split(',').map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
    .slice(0, RANK_NAMES.length);

  return {
    mode,
    earn,
    enabled: mode !== 'off',
    useCredits: mode === 'credits' || mode === 'both',
    useRanks: mode === 'ranks' || mode === 'both',
    rates: {
      placed: num(env.REWARDS_RATE_PLACED, preset.placed),
      mined: num(env.REWARDS_RATE_MINED, preset.mined),
      crafted: num(env.REWARDS_RATE_CRAFTED, preset.crafted),
      travel: num(env.REWARDS_RATE_TRAVEL, preset.travel),
    },
    // A new player starts with enough for one small build, so their first
    // five minutes on the server aren't a locked door.
    startCredits: num(env.REWARDS_START_CREDITS, 150),
    bandSmall: num(env.REWARDS_BAND_SMALL, 3000),
    bandMedium: num(env.REWARDS_BAND_MEDIUM, 30000),
    priceSmall: num(env.REWARDS_PRICE_SMALL, 150),
    priceMedium: num(env.REWARDS_PRICE_MEDIUM, 400),
    priceLarge: num(env.REWARDS_PRICE_LARGE, 900),
    // The anti-grind backstop. Placing and breaking the same dirt block all
    // afternoon is still work, but it shouldn't out-earn actually building.
    maxPerHour: num(env.REWARDS_MAX_POINTS_PER_HOUR, 1200),
    rankPoints: thresholds.length ? thresholds : [0, 2000, 10000, 40000],
    // Creative mode hands out infinite blocks, so placements there are free and
    // must not pay. Deltas earned in creative are absorbed, not banked.
    survivalOnly: bool(env.REWARDS_SURVIVAL_ONLY, true),
    bossbar: bool(env.REWARDS_BOSSBAR, true),
    pollSec: num(env.REWARDS_POLL_SEC, 30),
    exempt: String(env.REWARDS_EXEMPT || '').split(',').map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    worldDir: env.MC_WORLD_DIR || '/data/world',
    dataDir: env.MC_DATA_DIR_INTERNAL || '/data',
  };
}

// --- the ledger --------------------------------------------------------------

// bossbar ids are resource locations: [a-z0-9_.-] only. Player names are not.
export const barId = (player) => `aibuild.${String(player).toLowerCase().replace(/[^a-z0-9_.-]/g, '_')}`;

export function createRewards({ env, state, saveState, log = () => {} }) {
  const cfg = readConfig(env);
  state.rewards ||= { players: {} };
  state.rewards.players ||= {};

  let statsDir = null;          // resolved on first successful read
  let userCache = { at: 0, byName: new Map() };
  const barsShown = new Set();

  const isExempt = (player) => cfg.exempt.includes(String(player).toLowerCase());

  function recordFor(player) {
    const p = state.rewards.players;
    p[player] ||= {
      credits: cfg.startCredits, lifetime: 0, spent: 0, granted: 0, builds: 0,
      earned: { placed: 0, mined: 0, crafted: 0, travel: 0 },
      lastStats: null, hour: null, since: Date.now(),
    };
    // state.json outlives any one version of this file, so a record written by
    // an older shape must not blow up on the next line that touches it.
    p[player].earned ||= { placed: 0, mined: 0, crafted: 0, travel: 0 };
    return p[player];
  }

  // --- reading what the server already knows ---------------------------------

  function uuidFor(name) {
    const file = path.join(cfg.dataDir, 'usercache.json');
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs !== userCache.at) {
        const list = JSON.parse(fs.readFileSync(file, 'utf8'));
        userCache = {
          at: st.mtimeMs,
          byName: new Map(list.map((e) => [String(e.name).toLowerCase(), e.uuid])),
        };
      }
    } catch { /* no cache yet - nobody has joined */ }
    return userCache.byName.get(String(name).toLowerCase()) || null;
  }

  // Paper 26 writes <world>/players/stats/<uuid>.json; vanilla and older Paper
  // use <world>/stats/. Try both and remember whichever answered.
  function statsFile(uuid) {
    const candidates = statsDir ? [statsDir] : [
      path.join(cfg.worldDir, 'players', 'stats'),
      path.join(cfg.worldDir, 'stats'),
    ];
    for (const dir of candidates) {
      const f = path.join(dir, `${uuid}.json`);
      if (fs.existsSync(f)) { statsDir = dir; return f; }
    }
    return null;
  }

  function countersOf(player) {
    const uuid = uuidFor(player);
    if (!uuid) return null;
    const file = statsFile(uuid);
    if (!file) return null;
    try {
      return countersFrom(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      log(`could not read stats for ${player}: ${e.message}`);
      return null;
    }
  }

  // --- earning ---------------------------------------------------------------

  function creditPoints(rec, points, delta) {
    if (points <= 0) return 0;
    const hour = Math.floor(Date.now() / 3600_000);
    if (!rec.hour || rec.hour.at !== hour) rec.hour = { at: hour, points: 0 };
    const room = Math.max(0, cfg.maxPerHour - rec.hour.points);
    const given = Math.min(points, room);
    if (given <= 0) return 0;
    rec.hour.points += given;
    rec.credits += given;
    rec.lifetime += given;
    // Keep the breakdown so the panel can say WHERE it came from.
    rec.earned.placed += (delta.placed || 0) * cfg.rates.placed;
    rec.earned.mined += (delta.mined || 0) * cfg.rates.mined;
    rec.earned.crafted += (delta.crafted || 0) * cfg.rates.crafted;
    rec.earned.travel += ((delta.cm || 0) / 10000) * cfg.rates.travel;
    return given;
  }

  async function inSurvival(rcon, player) {
    try {
      const out = await rcon.send(`data get entity ${player} playerGameType`);
      const m = out.match(/(-?\d+)\s*$/);
      return m ? Number(m[1]) === 0 : true;   // unreadable: don't punish them
    } catch { return true; }
  }

  async function onlinePlayers(rcon) {
    const out = (await rcon.send('list')).replace(/§[0-9a-fk-or]/g, '');
    const after = out.split(':')[1];
    return (after || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  /**
   * One sweep: diff every online player's stats against their last reading and
   * pay out the difference. Called on a timer from index.js.
   */
  async function poll(rcon) {
    if (!cfg.enabled || !rcon) return [];
    const paid = [];
    let names = [];
    try { names = await onlinePlayers(rcon); } catch { return []; }

    for (const player of names) {
      if (isExempt(player)) continue;
      const now = countersOf(player);
      if (!now) continue;
      const rec = recordFor(player);
      const before = rec.lastStats;
      rec.lastStats = now;

      // First time we've ever seen them, only take a baseline. Otherwise a kid
      // who has played for a year would be handed a year of credits at once,
      // which rather defeats the point.
      if (!before) { rec.rank = rankFor(rec.lifetime, cfg.rankPoints).index; continue; }

      const delta = deltaOf(now, before);
      const points = pointsFor(delta, cfg.rates);
      if (points <= 0) continue;
      // Creative mode is a bottomless chest. Earned nothing, and the baseline
      // has already moved on, so it can't be claimed later either.
      if (cfg.survivalOnly && !(await inSurvival(rcon, player))) continue;

      const given = creditPoints(rec, points, delta);
      if (given > 0) paid.push({ player, points: given, rec });
    }

    // Promotions are worth announcing; nothing else here is.
    const promoted = [];
    for (const { player, rec } of paid) {
      const now = rankFor(rec.lifetime, cfg.rankPoints).index;
      if (cfg.useRanks && rec.rank !== undefined && now > rec.rank) {
        promoted.push({ player, rank: RANK_NAMES[now] });
      }
      rec.rank = now;
    }
    if (paid.length) saveState(state);
    if (cfg.bossbar) await updateBars(rcon, names).catch(() => {});
    return promoted;
  }

  // --- the bar across the top of the screen -----------------------------------

  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  async function updateBars(rcon, names) {
    for (const player of names) {
      if (isExempt(player)) continue;
      const id = barId(player);
      const s = summary(player);
      const [label, pct, colour] = cfg.useCredits
        ? [
          s.credits >= s.prices.small
            ? `${s.credits} credits - ready to build!`
            : `${s.credits} / ${s.prices.small} credits to your next build`,
          Math.min(100, Math.round((s.credits / Math.max(1, s.prices.small)) * 100)),
          s.credits >= s.prices.small ? 'green' : 'yellow',
        ]
        : [
          s.rank.next
            ? `${s.rank.name} - ${Math.max(0, Math.round(s.rank.next.toGo))} to ${s.rank.next.name}`
            : `${s.rank.name} - top rank`,
          s.rank.next
            ? Math.min(100, Math.round(((s.lifetime - (cfg.rankPoints[s.rank.index] || 0))
              / Math.max(1, s.rank.next.at - (cfg.rankPoints[s.rank.index] || 0))) * 100))
            : 100,
          'blue',
        ];
      if (!barsShown.has(id)) {
        await rcon.send(`bossbar add ${id} {"text":"${esc(label)}"}`).catch(() => {});
        await rcon.send(`bossbar set ${id} max 100`).catch(() => {});
        barsShown.add(id);
      }
      await rcon.send(`bossbar set ${id} name {"text":"${esc(label)}"}`).catch(() => {});
      await rcon.send(`bossbar set ${id} color ${colour}`).catch(() => {});
      await rcon.send(`bossbar set ${id} value ${pct}`).catch(() => {});
      await rcon.send(`bossbar set ${id} players ${player}`).catch(() => {});
    }
  }

  // --- spending --------------------------------------------------------------

  function summary(player) {
    const rec = recordFor(player);
    return {
      player,
      credits: Math.floor(rec.credits),
      lifetime: Math.floor(rec.lifetime),
      spent: Math.floor(rec.spent),
      granted: Math.floor(rec.granted),
      builds: rec.builds || 0,
      earned: Object.fromEntries(
        Object.entries(rec.earned || {}).map(([k, v]) => [k, Math.floor(v)]),
      ),
      rank: rankFor(rec.lifetime, cfg.rankPoints),
      prices: { small: cfg.priceSmall, medium: cfg.priceMedium, large: cfg.priceLarge },
      exempt: isExempt(player),
      mode: cfg.mode,
      earnFrom: cfg.earn,
    };
  }

  // Cheap gate, run BEFORE the model is asked for anything: if they can't
  // afford the smallest build there is, there's no point spending a call to
  // find out what this one would have cost.
  function check(player) {
    if (!cfg.enabled || !cfg.useCredits || isExempt(player)) return null;
    const rec = recordFor(player);
    if (rec.credits >= cfg.priceSmall) return null;
    const short = Math.ceil(cfg.priceSmall - rec.credits);
    return cfg.earn === 'granted'
      ? `you have ${Math.floor(rec.credits)} of the ${cfg.priceSmall} credits a build costs. `
        + 'Ask a grown-up to top you up!'
      : `you have ${Math.floor(rec.credits)} credits and the smallest build costs `
        + `${cfg.priceSmall}. Go and build something yourself - about ${short} more `
        + 'blocks and it\'s yours.';
  }

  // Priced once the plan exists and its real size is known.
  function quote(player, blocks) {
    const { band, price } = priceFor(blocks, cfg);
    if (!cfg.enabled || !cfg.useCredits || isExempt(player)) {
      return { band, price: 0, affordable: true };
    }
    const rec = recordFor(player);
    return { band, price, affordable: rec.credits >= price, credits: Math.floor(rec.credits) };
  }

  function charge(player, price) {
    const rec = recordFor(player);
    rec.builds = (rec.builds || 0) + 1;
    if (!cfg.enabled || !cfg.useCredits || isExempt(player) || !price) return summary(player);
    rec.credits = Math.max(0, rec.credits - price);
    rec.spent += price;
    saveState(state);
    return summary(player);
  }

  function grant(player, credits) {
    const n = Math.floor(Number(credits));
    if (!Number.isFinite(n) || n === 0) throw new Error('How many credits?');
    const rec = recordFor(player);
    rec.credits = Math.max(0, rec.credits + n);
    if (n > 0) {
      rec.granted += n;
      // Granted credits count towards rank too: a job done offline is still a
      // job done. Set REWARDS_GRANT_RANKS=false if you'd rather they didn't.
      if (bool(env.REWARDS_GRANT_RANKS, true)) rec.lifetime += n;
    }
    saveState(state);
    return summary(player);
  }

  // Rank narrows the envelope; it can never widen it past the server's own.
  function limitsFor(player, base) {
    if (!cfg.enabled || !cfg.useRanks || isExempt(player)) return base;
    const r = rankFor(recordFor(player).lifetime, cfg.rankPoints);
    return {
      ...base,
      maxBlocks: Math.min(base.maxBlocks, r.maxBlocks),
      maxExtent: Math.min(base.maxExtent, r.maxExtent),
    };
  }

  const all = () => Object.keys(state.rewards.players).sort().map(summary);

  return {
    config: () => cfg,
    enabled: () => cfg.enabled,
    summary, check, quote, charge, grant, limitsFor, poll, all,
    isExempt,
  };
}
