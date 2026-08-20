// Render a build plan as an isometric image, straight from the block data.
//
// Photographing the world through BlueMap meant driving a camera blind through
// a URL: most shots landed inside a wall, underground, or in the dark. We
// already know every block's position and material, so draw it ourselves and
// the framing problem disappears entirely.
//
//   node test/render-iso.mjs "a wizard tower" out/tower.ppm
//
// Writes a PPM (no encoder needed); convert with:
//   ffmpeg -i out/tower.ppm out/tower.png

import fs from 'node:fs';
import { generateBuildPlan } from './llm.js';
import { validatePlan } from './validate.js';
import { planToSpans, spansBounds } from './compile.js';

// Base colours for the blocks builds actually use. Approximate is fine - the
// shape and palette contrast are what matter at this size.
const COLOURS = {
  stone: [125, 125, 125], stone_bricks: [122, 122, 122], cobblestone: [110, 110, 110],
  chiseled_stone_bricks: [118, 118, 118], mossy_stone_bricks: [110, 118, 104],
  smooth_stone: [158, 158, 158], andesite: [136, 136, 137], polished_andesite: [132, 136, 132],
  diorite: [188, 188, 190], polished_diorite: [193, 193, 196], granite: [154, 106, 88],
  deepslate: [77, 77, 81], deepslate_bricks: [70, 70, 74], deepslate_tiles: [60, 60, 63],
  polished_deepslate: [72, 72, 76], cobbled_deepslate: [79, 79, 84], tuff: [108, 109, 102],
  blackstone: [42, 35, 40], basalt: [80, 78, 84], obsidian: [21, 18, 30],
  bricks: [150, 97, 83], mud_bricks: [137, 110, 88], terracotta: [152, 94, 67],
  sandstone: [219, 207, 163], smooth_sandstone: [224, 213, 170],
  oak_planks: [162, 130, 78], spruce_planks: [114, 84, 48], dark_oak_planks: [67, 43, 20],
  birch_planks: [196, 179, 123], oak_log: [109, 85, 50], spruce_log: [88, 68, 41],
  quartz_block: [235, 229, 222], smooth_quartz: [232, 226, 219], calcite: [223, 226, 220],
  white_concrete: [207, 213, 214], snow_block: [249, 254, 254], bone_block: [209, 206, 179],
  glass: [175, 213, 219], glass_pane: [175, 213, 219], black_stained_glass: [40, 40, 44],
  tinted_glass: [61, 54, 62],
  sea_lantern: [172, 199, 190], glowstone: [171, 131, 84], lantern: [201, 140, 71],
  copper_block: [192, 107, 79], oxidized_copper: [82, 162, 132], prismarine: [99, 156, 145],
  dark_prismarine: [51, 91, 75],
  grass_block: [110, 158, 66], dirt: [134, 96, 67], coarse_dirt: [119, 85, 59],
  lava: [217, 100, 22], fire: [222, 132, 40], netherrack: [97, 38, 38],
  purpur_block: [169, 125, 169], purpur_pillar: [172, 128, 172],
  gold_block: [246, 208, 61], iron_block: [220, 220, 220], emerald_block: [42, 203, 89],
  water: [63, 118, 228],
};

const baseOf = (m) => String(m).split('[')[0].replace(/^minecraft:/, '');
const colourFor = (m) => COLOURS[baseOf(m)] || [150, 145, 140];

// Ground cover the build lays down around itself. It belongs in the world but
// not in the frame: a 92x102 lawn under a 35-block castle turns every shot into
// a green diamond with some grey specks on it.
const GROUND = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'sand',
  'gravel', 'water', 'path', 'dirt_path', 'farmland', 'moss_block']);

// `tilt` is the camera elevation: how much screen height one block of DEPTH is
// worth, as a fraction of one block of HEIGHT. A true 2:1 isometric (0.5) looks
// down on the build, so courtyards and base slabs fill the frame and towers
// squash. Dropping the camera makes ground compress to a band and buildings
// stand up - which is what a hero shot wants.
export function renderIso(spans, {
  width = 1400, height = 1400, bg = [16, 19, 26], tilt = 0.30,
} = {}) {
  const full = spansBounds(spans);
  if (!full) throw new Error('nothing to render');

  // Frame on the structure, then keep only the ground within a short margin of
  // it. The lawn still appears - it just stops being the subject.
  //
  // Material alone isn't enough to spot ground: the cathedral paved itself a
  // 41x86 deepslate plate two blocks thick, which is a floor by every measure
  // except its block id. Judge by shape instead - anything flat, wide and at
  // the very bottom is a base, whatever it's made of.
  const area = (full.x2 - full.x1 + 1) * (full.z2 - full.z1 + 1);
  const isBase = (s) => s.y1 <= full.y1 + 3
    && (s.y2 - s.y1 + 1) <= 4
    && ((s.x2 - s.x1 + 1) * (s.z2 - s.z1 + 1)) >= area * 0.45;
  const structural = spans.filter((s) => baseOf(s.material) !== 'air'
    && !GROUND.has(baseOf(s.material)) && !isBase(s));
  const core = spansBounds(structural.length ? structural : spans) || full;
  const PAD = 8;
  const clip = {
    x1: Math.max(full.x1, core.x1 - PAD), x2: Math.min(full.x2, core.x2 + PAD),
    y1: full.y1, y2: full.y2,
    z1: Math.max(full.z1, core.z1 - PAD), z2: Math.min(full.z2, core.z2 + PAD),
  };
  spans = spans
    .map((s) => ({
      ...s,
      x1: Math.max(s.x1, clip.x1), x2: Math.min(s.x2, clip.x2),
      z1: Math.max(s.z1, clip.z1), z2: Math.min(s.z2, clip.z2),
    }))
    .filter((s) => s.x1 <= s.x2 && s.z1 <= s.z2);
  const b = spansBounds(spans);
  if (!b) throw new Error('nothing to render');

  // Voxelise. A build is mostly hollow, so only surface-ish blocks matter, but
  // at these sizes just keeping the topmost block per screen cell is enough.
  const cells = new Map();                       // key -> {material, depth}
  const put = (x, y, z, m) => {
    // Skip air and anything fully enclosed later; painter's algorithm handles order.
    if (baseOf(m) === 'air') { cells.delete(`${x},${y},${z}`); return; }
    cells.set(`${x},${y},${z}`, m);
  };
  for (const s of spans) {
    for (let x = s.x1; x <= s.x2; x++) {
      for (let y = s.y1; y <= s.y2; y++) {
        for (let z = s.z1; z <= s.z2; z++) put(x, y, z, s.material);
      }
    }
  }

  // Two-pass framing: project once at unit scale, measure the real extent, then
  // scale to fit. The unit projection MUST use the same block aspect the
  // renderer uses (tw = th/2) - measuring at a different ratio and correcting
  // with a fudge factor is what left long builds rendering at half size.
  const proj = (rx, ry, rz) => ({
    x: (rx - rz) * 0.5,                          // th = 1, so tw = 0.5
    y: -(rx + rz) * tilt - ry,
  });
  const corners = [];
  for (const dx of [0, b.x2 - b.x1]) {
    for (const dy of [0, b.y2 - b.y1]) {
      for (const dz of [0, b.z2 - b.z1]) corners.push(proj(dx, dy, dz));
    }
  }
  const pminx = Math.min(...corners.map((c) => c.x));
  const pmaxx = Math.max(...corners.map((c) => c.x));
  const pminy = Math.min(...corners.map((c) => c.y));
  const pmaxy = Math.max(...corners.map((c) => c.y));
  const margin = 0.92;
  const scale = Math.max(1, Math.floor(Math.min(
    (width * margin) / Math.max(1, pmaxx - pminx),
    (height * margin) / Math.max(1, pmaxy - pminy),
  )));
  const tw = Math.max(1, Math.round(scale / 2));
  const th = Math.max(1, scale);                 // taller blocks: towers read as tall

  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    px[i * 3] = bg[0]; px[i * 3 + 1] = bg[1]; px[i * 3 + 2] = bg[2];
  }
  // Centre the measured extent rather than guessing an origin. The unit
  // projection is in units of `th`, so both axes scale by `th`.
  const ox = Math.round(width / 2 - ((pminx + pmaxx) / 2) * th);
  const oy = Math.round(height / 2 - ((pminy + pmaxy) / 2) * th);

  const plot = (sx, sy, [r, g, bl]) => {
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) return;
    const i = (sy * width + sx) * 3;
    px[i] = r; px[i + 1] = g; px[i + 2] = bl;
  };
  const fillQuad = (cx, cy, w, h, col) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) plot(cx + dx, cy + dy, col);
  };

  // Painter's algorithm: far blocks first. Depth increases with x+z+y.
  const keys = [...cells.keys()].map((k) => {
    const [x, y, z] = k.split(',').map(Number);
    return { x, y, z, m: cells.get(k), d: x + z + y };
  }).sort((a, b2) => a.d - b2.d);

  for (const { x, y, z, m } of keys) {
    const rx = x - b.x1; const ry = y - b.y1; const rz = z - b.z1;
    const sx = ox + Math.round((rx - rz) * tw) - tw;
    const sy = oy - Math.round((rx + rz) * (th * tilt)) - ry * th;
    const c = colourFor(m);
    // Cheap three-tone shading so faces read as faces.
    const top = c.map((v) => Math.min(255, Math.round(v * 1.12)));
    const left = c.map((v) => Math.round(v * 0.78));
    const right = c.map((v) => Math.round(v * 0.94));
    const topH = Math.max(1, Math.round(th * tilt * 2));
    fillQuad(sx, sy - topH, tw * 2, topH, top);
    fillQuad(sx, sy, tw, th, left);
    fillQuad(sx + tw, sy, tw, th, right);
  }

  return { px, width, height, blocks: cells.size };
}

export function writePPM(path, { px, width, height }) {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii');
  fs.writeFileSync(path, Buffer.concat([header, px]));
}

// --- CLI ---------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const desc = process.argv[2] || 'a wizard tower with a spiral staircase';
  const out = process.argv[3] || 'out/build.ppm';
  const L = { maxBlocks: 400000, maxExtent: 120, maxOps: 400, allowHazards: true };
  const { plan, verified } = await generateBuildPlan(
    desc, process.env, (p) => validatePlan(p, { x: 0, y: 100, z: 0 }, L),
  );
  console.log(`${plan.name}: ${verified.blocks} blocks, ${plan.ops.length} ops`);
  const img = renderIso(verified.spans);
  fs.mkdirSync(out.replace(/\/[^/]+$/, ''), { recursive: true });
  writePPM(out, img);
  console.log(`wrote ${out} (${img.blocks} visible blocks)`);
}
