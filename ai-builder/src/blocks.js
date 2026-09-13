// What the builder knows about block ids.
//
// The model writes block ids from memory, and its memory spans fifteen years of
// Minecraft. A live aquarium lost all 47 of its plants to `sea_grass`, and a
// path vanished as `grass_path` - both real ids once, both refused by 26.1 with
// "Unknown block type", and nobody saw the refusal but the log. Three layers
// catch this now, cheapest first:
//
//   1. aliases   - a renamed or near-miss id is quietly corrected
//   2. items     - things that are not blocks at all (spawn eggs, buckets) are
//                  rejected with a message that says what to use instead
//   3. the server - every distinct id is test-parsed by the server itself
//                  before anything is placed (createBlockChecker)
//
// None of this loosens the safety checks: aliasing runs BEFORE the banned-block
// test and the strict id pattern, so an alias can never smuggle anything past
// them.

const COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry',
  'pale_oak', 'bamboo', 'crimson', 'warped'];

export { COLOURS };

// Old names, and the generic names a model reaches for, mapped to the id that
// exists in Java 26.1. Only entries where the left side is certainly NOT a block
// today and the right side certainly is.
export const ALIASES = {
  grass_path: 'dirt_path', path: 'dirt_path',
  sea_grass: 'seagrass', tall_sea_grass: 'tall_seagrass',
  grass: 'short_grass',
  door: 'oak_door', trapdoor: 'oak_trapdoor',
  planks: 'oak_planks', wood_planks: 'oak_planks', wood: 'oak_planks',
  log: 'oak_log', leaves: 'oak_leaves', sapling: 'oak_sapling',
  fence: 'oak_fence', fence_gate: 'oak_fence_gate', sign: 'oak_sign',
  wool: 'white_wool', carpet: 'white_carpet', concrete: 'white_concrete',
  stained_glass: 'white_stained_glass', stained_glass_pane: 'white_stained_glass_pane',
  thin_glass: 'glass_pane', glass_panes: 'glass_pane', glass_block: 'glass',
  stone_brick: 'stone_bricks', mossy_stone_brick: 'mossy_stone_bricks',
  cracked_stone_brick: 'cracked_stone_bricks', brick: 'bricks', brick_block: 'bricks',
  nether_brick: 'nether_bricks', red_nether_brick: 'red_nether_bricks',
  end_stone_brick: 'end_stone_bricks', mud_brick: 'mud_bricks',
  deepslate_brick: 'deepslate_bricks', deepslate_tile: 'deepslate_tiles',
  prismarine_brick: 'prismarine_bricks',
  cobble: 'cobblestone', moss_stone: 'mossy_cobblestone',
  hardened_clay: 'terracotta', stained_hardened_clay: 'white_terracotta',
  bed: 'red_bed',
  waterlily: 'lily_pad', web: 'cobweb', snow_layer: 'snow',
  red_flower: 'poppy', rose: 'poppy', yellow_flower: 'dandelion',
  melon_block: 'melon', lit_pumpkin: 'jack_o_lantern', pumpkin_lantern: 'jack_o_lantern',
  quartz: 'quartz_block',
  flowing_water: 'water', stationary_water: 'water', still_water: 'water',
  flowing_lava: 'lava', stationary_lava: 'lava',
  workbench: 'crafting_table', crafting_bench: 'crafting_table',
  bookshelves: 'bookshelf', book_shelf: 'bookshelf',
  lit_furnace: 'furnace', lit_redstone_lamp: 'redstone_lamp',
  hay_bale: 'hay_block', slime: 'slime_block', magma: 'magma_block',
  glowstone_block: 'glowstone', sealantern: 'sea_lantern',
  torch_wall: 'wall_torch', wall_lantern: 'lantern',
  iron: 'iron_block', gold: 'gold_block', diamond: 'diamond_block',
  emerald: 'emerald_block', lapis: 'lapis_block', copper: 'copper_block',
  sand_stone: 'sandstone', double_stone_slab: 'smooth_stone',
};

// Patterned mistakes: plurals inside a derived id ("stone_bricks_stairs"), the
// old "wooden_" prefix, and colours without the word "stained".
const RULES = [
  [/^bricks_(stairs|slab|wall)$/, 'brick_$1'],
  [/^([a-z_]+)_bricks_(stairs|slab|wall|fence)$/, '$1_brick_$2'],
  [/^([a-z_]+)_tiles_(stairs|slab|wall)$/, '$1_tile_$2'],
  [new RegExp(`^(${WOODS.join('|')})_planks_(stairs|slab|fence|fence_gate|door|trapdoor|button|pressure_plate|sign)$`), '$1_$2'],
  [/^wood(?:en)?_(door|trapdoor|stairs|slab|fence|fence_gate|button|pressure_plate|sign|planks|log)$/, 'oak_$1'],
  [new RegExp(`^(${COLOURS.join('|')})_glass$`), '$1_stained_glass'],
  [new RegExp(`^(${COLOURS.join('|')})_glass_pane$`), '$1_stained_glass_pane'],
  [new RegExp(`^(${COLOURS.join('|')})_(?:hardened_)?clay$`), '$1_terracotta'],
];

export function aliasFor(base) {
  if (ALIASES[base]) return ALIASES[base];
  for (const [re, to] of RULES) if (re.test(base)) return base.replace(re, to);
  return null;
}

/**
 * Tidy a material the model wrote: trim, lowercase, drop a "minecraft:" prefix,
 * and correct a known wrong id - keeping any blockstate. The result still has
 * to pass the strict pattern and the banned list; this only fixes spelling.
 */
export function normaliseMaterial(material) {
  if (typeof material !== 'string') return material;
  let m = material.trim().toLowerCase();
  if (m.startsWith('minecraft:')) m = m.slice('minecraft:'.length);
  const i = m.indexOf('[');
  const base = i === -1 ? m : m.slice(0, i);
  const states = i === -1 ? '' : m.slice(i);
  const alias = aliasFor(base);
  return alias ? `${alias}${states}` : m;
}

// Mobs a plan can ask for with the creatures op. Passive and ambient only:
// nothing that attacks, nothing that breaks blocks, nothing that explodes.
export const CREATURES = new Set([
  'cow', 'sheep', 'pig', 'chicken', 'horse', 'donkey', 'mule', 'rabbit', 'llama', 'cat',
  'fox', 'panda', 'turtle', 'armadillo', 'frog', 'parrot', 'camel', 'sniffer', 'mooshroom',
  'ocelot', 'tropical_fish', 'cod', 'salmon', 'squid', 'glow_squid', 'axolotl', 'dolphin',
]);

const ITEM_SUFFIXES = ['_spawn_egg', '_bucket', '_boat', '_raft', '_sword', '_pickaxe', '_axe',
  '_shovel', '_hoe', '_helmet', '_chestplate', '_leggings', '_boots', '_horse_armor', '_ingot',
  '_nugget', '_dye', '_seeds', '_potion', '_smithing_template', '_banner_pattern',
  '_pottery_sherd'];
const ITEMS = new Set(['bucket', 'minecart', 'egg', 'snowball', 'stick', 'bone', 'arrow', 'bow',
  'crossbow', 'trident', 'shield', 'saddle', 'lead', 'name_tag', 'ender_pearl', 'book',
  'writable_book', 'written_book', 'map', 'filled_map', 'compass', 'clock', 'apple', 'bread',
  'carrot', 'potato', 'beetroot', 'sugar', 'paper', 'feather', 'leather', 'string', 'coal',
  'charcoal', 'redstone', 'glowstone_dust', 'gunpowder', 'painting', 'item_frame',
  'glow_item_frame', 'armor_stand', 'end_crystal', 'firework_rocket', 'experience_bottle',
  'fishing_rod', 'flint_and_steel', 'shears', 'elytra', 'totem_of_undying', 'spyglass', 'brush',
  'mace', 'wind_charge', 'honey_bottle', 'glass_bottle', 'bowl', 'cookie']);
// Words for animals, which a model sometimes writes where a block goes.
const MOB_WORDS = new Set([...CREATURES, 'fish', 'dog', 'wolf', 'bee', 'goat', 'villager']);

/**
 * Why `base` can't be placed as a block, or null if it might be one.
 * Spawn eggs and fish buckets are how a model tries to add animals, so those
 * point it at the creatures op instead.
 */
export function notABlock(base) {
  const creatureHint = `For animals or fish use {"op":"creatures","mob":"cow",...} `
    + `(mobs: ${[...CREATURES].join(', ')}).`;
  if (base.endsWith('_spawn_egg') || MOB_WORDS.has(base)
      || /^(axolotl|cod|salmon|tropical_fish|pufferfish|tadpole)_bucket$/.test(base)) {
    return `"${base}" is not a block, so it can't be placed. ${creatureHint}`;
  }
  if (base === 'water_bucket' || base === 'lava_bucket' || base === 'powder_snow_bucket') {
    return `"${base}" is an item, not a block - use "${base.replace('_bucket', '')}".`;
  }
  if (ITEMS.has(base) || ITEM_SUFFIXES.some((s) => base.endsWith(s)) || base.startsWith('music_disc_')) {
    return `"${base}" is an item, not a block, so it can't be placed. Use a real block id.`;
  }
  return null;
}

// --- asking the server ---------------------------------------------------------

/**
 * What a probe reply says about the id it tested.
 *
 * The probe is `execute if block 0 0 0 <material>`. The block argument is parsed
 * before the command runs, so a bad id or blockstate fails with a parse error,
 * while a good one gets as far as testing the block - "Test passed", "Test
 * failed", or "That position is not loaded", all of which prove it parsed.
 */
export function probeVerdict(reply) {
  const r = String(reply ?? '');
  if (/Test (passed|failed)|not loaded/i.test(r)) return 'valid';
  if (/Unknown block|does not have property|does not accept|Expected value for property|Incorrect argument|Unknown or incomplete|Invalid|Unclosed|Duplicate property/i.test(r)) {
    return 'invalid';
  }
  return 'unsure';
}

export function createBlockChecker({ log = () => {} } = {}) {
  // Ids don't change while the server runs, so every answer is kept.
  const known = new Map();   // material -> reply text for invalid, true for valid

  /** The materials the server does not recognise, as [{material, reason}]. */
  async function unknown(rcon, materials) {
    const bad = [];
    for (const material of new Set(materials)) {
      if (material === 'air') continue;
      if (!known.has(material)) {
        let reply;
        try {
          reply = await rcon.send(`execute if block 0 0 0 ${material}`);
        } catch (e) {
          // A probe that could not be asked is not evidence of a bad id. The
          // build goes ahead; the fill's own error is still logged if it was.
          log(`block check skipped for ${material}: ${e.message}`);
          continue;
        }
        const verdict = probeVerdict(reply);
        if (verdict === 'unsure') {
          log(`block check: unexpected reply for ${material}: ${String(reply).slice(0, 100)}`);
          continue;
        }
        known.set(material, verdict === 'valid' ? true : String(reply).trim().split('\n')[0].slice(0, 100));
      }
      const verdict = known.get(material);
      if (verdict !== true) bad.push({ material, reason: verdict });
    }
    return bad;
  }

  return { unknown };
}
