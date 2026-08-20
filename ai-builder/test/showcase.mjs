// Generate a showcase set and render each build isometrically.
//   node test/showcase.mjs out/showcase
//
// No world, no map render, no camera: plan -> spans -> image. Seconds each,
// and every frame is framed correctly by construction.

import fs from 'node:fs';
import { generateBuildPlan } from '../src/llm.js';
import { validatePlan } from '../src/validate.js';
import { renderIso, writePPM } from '../src/render-iso.js';

const OUT = process.argv[2] || 'out/showcase';
fs.mkdirSync(OUT, { recursive: true });

const L = { maxBlocks: 400000, maxExtent: 120, maxOps: 400, allowHazards: true };

const SUBJECTS = [
  ['castle', 'a grand castle with four tall corner towers, crenellated battlements and an arched gatehouse'],
  ['volcano', 'an erupting volcano with glowing lava pouring down its black basalt sides and a smoking crater'],
  ['cathedral', 'a gothic cathedral with twin bell towers, a long nave of repeating arches and a rose window'],
  ['lighthouse', 'a tall striped lighthouse on a rocky base with a glowing lantern room and a gallery at the top'],
  ['aqueduct', 'a roman aqueduct of repeating tall stone arches carrying a water channel'],
  ['yacht', 'a modern yacht with a glass cabin, a sun deck and a swimming platform'],
];

const results = [];
for (const [slug, prompt] of SUBJECTS) {
  const t0 = Date.now();
  try {
    const { plan, verified, usage } = await generateBuildPlan(
      prompt, process.env, (p) => validatePlan(p, { x: 0, y: 100, z: 0 }, L),
    );
    // Keep the plan: re-framing a shot should never cost another LLM call.
    fs.writeFileSync(`${OUT}/${slug}.plan.json`, JSON.stringify(plan));
    const img = renderIso(verified.spans, { width: 1080, height: 1080, tilt: 0.30 });
    writePPM(`${OUT}/${slug}.ppm`, img);
    const rec = {
      slug,
      prompt,
      name: plan.name,
      blocks: verified.blocks,
      size: verified.size,
      ops: plan.ops.length,
      seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
      cost: Number(usage?.cost || 0),
    };
    results.push(rec);
    console.log(`  ${slug.padEnd(11)} ${rec.name.slice(0, 26).padEnd(26)} `
      + `${String(rec.blocks).padStart(7)} blocks  ${rec.ops} ops  ${rec.seconds}s  $${rec.cost.toFixed(3)}`);
  } catch (err) {
    console.log(`  ${slug.padEnd(11)} FAILED: ${err.message.slice(0, 90)}`);
  }
}

fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(results, null, 2));
console.log(`\n  ${results.length}/${SUBJECTS.length} rendered -> ${OUT}`);
