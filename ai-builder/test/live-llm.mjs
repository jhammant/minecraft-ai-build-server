// Live check against the real LLM backend. Not part of `npm test` - it costs
// money and needs network. Run it after changing the prompt or switching model:
//
//   OPENROUTER_API_KEY=... node test/live-llm.mjs "a wizard tower"
//
// Prints what the model produced, whether the validator accepted it, and the
// first few commands that would be sent to the server. Nothing is executed.

import { generateBuildPlan, describeBackend } from '../src/llm.js';
import { validatePlan } from '../src/validate.js';
import { spansToCommands } from '../src/compile.js';

const description = process.argv[2] || 'a small stone house with a red roof and a window';
const LIMITS = {
  maxBlocks: Number(process.env.MAX_BLOCKS || 150000),
  maxExtent: Number(process.env.MAX_EXTENT || 96),
  maxOps: 200,
};
const ORIGIN = { x: 0, y: 64, z: 0 };

console.log(`backend : ${describeBackend(process.env)}`);
console.log(`prompt  : "${description}"\n`);

const t0 = Date.now();
const verify = (plan) => validatePlan(plan, ORIGIN, LIMITS);

try {
  const { plan, verified, usage, attempts, model } = await generateBuildPlan(
    description, process.env, verify,
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const cmds = spansToCommands(verified.spans, ORIGIN);

  console.log(`name    : ${plan.name}`);
  console.log(`summary : ${plan.summary}`);
  console.log(`ops     : ${plan.ops.length}  ->  ${verified.spans.length} spans -> ${cmds.length} commands`);
  console.log(`size    : ${verified.size.x} x ${verified.size.y} x ${verified.size.z}`);
  console.log(`blocks  : ${verified.blocks.toLocaleString()}`);
  console.log(`took    : ${secs}s, ${attempts} attempt(s), model ${model}`);
  if (usage) {
    const cost = (usage.prompt_tokens * 0.58 + usage.completion_tokens * 2.44) / 1e6;
    console.log(`tokens  : ${usage.prompt_tokens} in / ${usage.completion_tokens} out  (~$${cost.toFixed(4)})`);
  }

  const mats = [...new Set(plan.ops.map((o) => o.material))];
  console.log(`\nmaterials: ${mats.join(', ')}`);
  console.log('\nfirst 8 commands:');
  for (const c of cmds.slice(0, 8)) console.log('  ' + c);
  console.log(`\nVALIDATED OK - ${cmds.length} commands would be sent.`);
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
}
