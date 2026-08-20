// Re-render saved plans at a new camera angle. No LLM calls, no cost.
//   node test/reframe.mjs out/showcase2 0.30
import fs from 'node:fs';
import { planToSpans } from '../src/compile.js';
import { renderIso, writePPM } from '../src/render-iso.js';

const dir = process.argv[2] || 'out/showcase2';
const tilt = Number(process.argv[3] || 0.30);
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.plan.json'))) {
  const slug = f.replace('.plan.json', '');
  const plan = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  const img = renderIso(planToSpans(plan), { width: 1080, height: 1080, tilt });
  writePPM(`${dir}/${slug}.ppm`, img);
  console.log(`  ${slug} re-framed at tilt ${tilt}`);
}
