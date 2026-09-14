// "A house with a bed, a kitchen and a crafting table" came back as a shell.
//
// The details ops make furniture possible; this makes it expected. Furniture
// the child named goes into the request as a requirement, and a plan that
// leaves it out - or a house with no door at all - is sent back once with a
// note saying what is missing. Only once: this is taste, not safety, and a
// second refusal would cost more than the missing chest is worth (see
// README, "Don't let a quality heuristic block the user").

const FURNITURE = [
  { words: /\bbeds?\b|bedroom/, name: 'a bed (bed op)', has: (v) => v.details.beds.length > 0 },
  { words: /\bchests?\b|storage/, name: 'a chest', has: (v) => usesAny(v, ['chest', 'trapped_chest', 'barrel']) },
  { words: /crafting|workbench/, name: 'a crafting_table', has: (v) => usesAny(v, ['crafting_table']) },
  { words: /furnace|oven|kitchen|cook/, name: 'a furnace or smoker', has: (v) => usesAny(v, ['furnace', 'smoker', 'blast_furnace']) },
  { words: /bookshel|library/, name: 'bookshelves', has: (v) => usesAny(v, ['bookshelf', 'chiseled_bookshelf']) },
  { words: /barrels?/, name: 'barrels', has: (v) => usesAny(v, ['barrel']) },
  { words: /enchant/, name: 'an enchanting_table', has: (v) => usesAny(v, ['enchanting_table']) },
  { words: /anvil|blacksmith|forge/, name: 'an anvil', has: (v) => usesAny(v, ['anvil']) },
  { words: /brewing|potion/, name: 'a brewing_stand', has: (v) => usesAny(v, ['brewing_stand']) },
];

// Somewhere you walk into. An aquarium or a statue doesn't need a front door.
const ENTERABLE = /\b(house|home|cottage|cabin|hut|shop|store|barn|stable|mansion|castle|keep|tower|church|chapel|school|inn|tavern|temple|palace|lighthouse|hotel|bakery|library|station|hospital|manor|villa|shack|bungalow|lodge|chalet|farmhouse|treehouse|windmill|hall|fort|hideout|clubhouse|shed|workshop|bank|museum)s?\b/;

const usesAny = (verified, ids) => verified.materials.some((m) => ids.includes(m.split('[')[0]));

/** Furniture named in the description, as phrases for the request. */
export function wantedFurniture(description) {
  const text = String(description ?? '').toLowerCase();
  return FURNITURE.filter((f) => f.words.test(text)).map((f) => f.name);
}

export const isEnterable = (description) => ENTERABLE.test(String(description ?? '').toLowerCase());

/** What the plan is missing that the child asked for (or that any house needs). */
export function interiorGaps(description, verified) {
  const text = String(description ?? '').toLowerCase();
  const gaps = [];
  if (isEnterable(text) && verified.details.doors.length === 0) {
    gaps.push('a door (door op) on every building you can walk into - not an air hole');
  }
  for (const f of FURNITURE) {
    if (f.words.test(text) && !f.has(verified)) gaps.push(f.name);
  }
  return gaps;
}
