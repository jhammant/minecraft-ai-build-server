// Inspect what the model ACTUALLY emits for a prompt, without building it.
//   node test/diag-plan.mjs "a grand castle with four tall corner towers"
import { generateBuildPlan } from '../src/llm.js';
import { validatePlan } from '../src/validate.js';
import { planToSpans, spansBounds } from '../src/compile.js';

const desc = process.argv[2] || 'a grand castle with four tall corner towers and a courtyard';
const L = {
  maxBlocks: 400000, maxExtent: 120, maxOps: 400, allowHazards: true,
};

const { plan } = await generateBuildPlan(desc, process.env, (p) => validatePlan(p, { x: 0, y: 100, z: 0 }, L));

const byOp = {};
const byMat = {};
for (const o of plan.ops) {
  byOp[o.op] = (byOp[o.op] || 0) + 1;
  const m = o.material || (o.child && o.child.material) || '(none)';
  byMat[m] = (byMat[m] || 0) + 1;
}

console.log('name    :', plan.name);
console.log('ops     :', plan.ops.length, JSON.stringify(byOp));
console.log('\nmaterials by op count:');
for (const [m, c] of Object.entries(byMat).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(c).padStart(3)}  ${m}`);
}

// How much VOLUME each material occupies - an op count hides the fact that one
// giant dark mass can swamp twenty little accent ops.
const vol = {};
for (const o of plan.ops) {
  const m = o.material || '(none)';
  let v = 0;
  try { for (const s of planToSpans({ ops: [o] })) v += (s.x2 - s.x1 + 1) * (s.y2 - s.y1 + 1) * (s.z2 - s.z1 + 1); } catch {}
  vol[m] = (vol[m] || 0) + v;
}
const total = Object.values(vol).reduce((a, b) => a + b, 0) || 1;
console.log('\nmaterials by VOLUME (what you actually see):');
for (const [m, v] of Object.entries(vol).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`   ${String(Math.round((v / total) * 100)).padStart(3)}%  ${m}`);
}

const b = spansBounds(planToSpans(plan));
console.log('\nbounds  :', JSON.stringify(b));
if (plan.plan) console.log('\nmodel plan:', JSON.stringify(plan.plan).slice(0, 500));
