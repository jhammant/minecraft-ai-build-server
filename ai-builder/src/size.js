// How big a build is allowed to be, as the player asked for it.
//
// The server's own ceiling (MAX_EXTENT, 120) is a safety limit, not a size.
// Left to itself the model treats it as a target: "about 40 by 40" came back as
// an 81x25x82 aquarium, "about 50 by 50" as a 67x67 sanctuary, and the two
// landed on top of each other. So a request carries a budget - a size word, or
// the dimensions typed in the description - and the validator holds the plan
// to it like any other limit, which sends an oversize plan back to be redrawn.

// Largest extent on any axis for each size word.
export const SIZES = { small: 24, medium: 48, large: 80, huge: 120 };

// Typed dimensions are "about", so allow a quarter over before rejecting.
export const SLACK = 1.25;

// Numbers smaller than this are details, not the build: "a castle with 3 by 3
// windows" must not squeeze the castle into four blocks.
const MIN_DIMENSION = 8;

export const isSize = (s) => Object.hasOwn(SIZES, String(s ?? '').toLowerCase());

/**
 * Pull a leading size word off a chat command.
 *   "small a hut"    -> { size: 'small', description: 'a hut' }
 *   "a small hut"    -> { size: null,    description: 'a small hut' }
 */
export function splitSizeWord(text) {
  const m = String(text ?? '').trim().match(/^(small|medium|large|huge)\b[\s:,-]*(.*)$/i);
  if (!m) return { size: null, description: String(text ?? '').trim() };
  return { size: m[1].toLowerCase(), description: m[2].trim() };
}

/**
 * Dimensions typed into a description, or null.
 * Takes the largest "A by B" (or "AxB", "A x B by C") pair, since the whole
 * build is at least as big as any part the child describes.
 */
export function dimensionsFrom(description) {
  const text = String(description ?? '').toLowerCase();
  const sep = '\\s*(?:x|by|×|\\*)\\s*';
  const re = new RegExp(`(\\d{1,4})${sep}(\\d{1,4})(?:${sep}(\\d{1,4}))?`, 'g');
  let best = null;
  for (const m of text.matchAll(re)) {
    const [w, d] = [Number(m[1]), Number(m[2])];
    if (w < MIN_DIMENSION || d < MIN_DIMENSION) continue;
    const h = m[3] ? Number(m[3]) : null;
    if (!best || Math.max(w, d) > Math.max(best.w, best.d)) best = { w, d, h, text: m[0] };
  }
  if (best) return best;
  // "40 blocks wide", "30 blocks across", "a 50 block square"
  const one = text.match(/(\d{1,4})\s*blocks?\s*(?:wide|long|across|square|big)/);
  if (one && Number(one[1]) >= MIN_DIMENSION) {
    return { w: Number(one[1]), d: Number(one[1]), h: null, text: one[0] };
  }
  return null;
}

/**
 * The size envelope for one request, or null when nothing was asked for.
 * Never wider than the server's own limit.
 *
 * @returns {{footprint:number, height:number, reason:string}|null}
 */
export function budgetFor({ size, description, maxExtent }) {
  const preset = isSize(size) ? SIZES[String(size).toLowerCase()] : null;
  const dims = dimensionsFrom(description);
  if (!preset && !dims) return null;
  const cap = (n) => Math.min(maxExtent, n);
  if (dims) {
    return {
      footprint: cap(Math.ceil(Math.max(dims.w, dims.d) * SLACK)),
      height: cap(dims.h ? Math.ceil(dims.h * SLACK) : (preset ?? maxExtent)),
      reason: `they asked for "${dims.text}"`,
    };
  }
  return { footprint: cap(preset), height: cap(preset), reason: `they picked a ${size} build` };
}
