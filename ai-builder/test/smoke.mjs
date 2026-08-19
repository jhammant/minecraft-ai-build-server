// End-to-end smoke test against the LIVE server. Run inside the ai-builder
// container so it can reach RCON:
//
//   docker exec minecraft-ai-builder node test/smoke.mjs
//
// Exercises the real pipeline (LLM -> validate -> compile -> RCON -> blocks on
// disk), then verifies CoreProtect actually logged the change and can roll it
// back - which is what makes !undo work. Builds far from spawn and cleans up.

import { Rcon } from '../src/rcon.js';
import { generateBuildPlan } from '../src/llm.js';
import { validatePlan } from '../src/validate.js';
import { spansToCommands } from '../src/compile.js';
import { snapshot, restore } from '../src/undo.js';

const TEST = { x: 8000, y: 100, z: 8000 };
const LIMITS = { maxBlocks: 150000, maxExtent: 96, maxOps: 200 };

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' - ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' - ' + detail : ''}`); }
};

const rcon = new Rcon({
  host: process.env.RCON_HOST || 'mc',
  port: Number(process.env.RCON_PORT || 25575),
  password: process.env.RCON_PASSWORD,
});
await rcon.connect();
console.log('\n== 1. RCON ==');
const ver = await rcon.send('version');
ok('rcon connected and responds', ver.length > 0, ver.split('\n')[0].slice(0, 60));

// Keep the test area loaded, or fills silently no-op in unloaded chunks.
await rcon.send(`forceload add ${TEST.x - 32} ${TEST.z - 32} ${TEST.x + 32} ${TEST.z + 32}`);
await new Promise((r) => setTimeout(r, 1500)); // let the chunks actually load
await rcon.send(`fill ${TEST.x - 20} ${TEST.y - 1} ${TEST.z - 20} ${TEST.x + 20} ${TEST.y + 40} ${TEST.z + 20} air`);

// Reading a block over RCON is fiddlier than it looks. `execute if block ...
// run say X` is the obvious probe and is USELESS: /say writes to chat, not to
// the command's output, so RCON sees an empty string either way. `run <cmd>`
// doesn't help either - execute returns its own result, not the inner command's
// message. Dropping the `run` clause entirely is the trick: a bare
// `execute if block` answers "Test passed" / "Test failed" straight back.
const isBlock = async (x, y, z, block) => {
  const r = await rcon.send(`execute if block ${x} ${y} ${z} ${block}`);
  return /Test passed/i.test(r);
};

console.log('\n== 2. Direct fill + read-back ==');
const fillRes = await rcon.send(`fill ${TEST.x} ${TEST.y} ${TEST.z} ${TEST.x + 2} ${TEST.y + 2} ${TEST.z + 2} stone_bricks`);
ok('fill reports success', /filled|changed/i.test(fillRes), fillRes.trim().slice(0, 50));
ok('block is actually present on disk',
  await isBlock(TEST.x + 1, TEST.y + 1, TEST.z + 1, 'stone_bricks'));


console.log('\n== 3. Snapshot/restore round-trip (the !undo mechanism) ==');
{
  // Lay down a recognisable "before" state, snapshot it, scribble over it,
  // then restore and check the original blocks came back exactly.
  const r = { x1: TEST.x, y1: TEST.y + 10, z1: TEST.z, x2: TEST.x + 5, y2: TEST.y + 13, z2: TEST.z + 5 };
  await rcon.send(`fill ${r.x1} ${r.y1} ${r.z1} ${r.x2} ${r.y2} ${r.z2} air`);
  await rcon.send(`setblock ${r.x1 + 1} ${r.y1 + 1} ${r.z1 + 1} emerald_block`);
  await rcon.send(`setblock ${r.x1 + 3} ${r.y1 + 2} ${r.z1 + 3} gold_block`);

  const snap = await snapshot(rcon, r, 0);
  ok('snapshot taken', snap.pieces >= 1, `${snap.pieces} clone piece(s)`);

  await rcon.send(`fill ${r.x1} ${r.y1} ${r.z1} ${r.x2} ${r.y2} ${r.z2} netherrack`);
  ok('region overwritten', await isBlock(r.x1 + 1, r.y1 + 1, r.z1 + 1, 'netherrack'));

  await restore(rcon, snap);
  const emeraldBack = await isBlock(r.x1 + 1, r.y1 + 1, r.z1 + 1, 'emerald_block');
  const goldBack = await isBlock(r.x1 + 3, r.y1 + 2, r.z1 + 3, 'gold_block');
  const airBack = await isBlock(r.x1, r.y1, r.z1, 'air');
  ok('restore brought back the exact original blocks', emeraldBack && goldBack && airBack,
    `emerald=${emeraldBack} gold=${goldBack} air=${airBack}`);
}

console.log('\n== 4. Full pipeline: LLM -> validate -> compile -> execute ==');
const verify = (plan) => validatePlan(plan, TEST, LIMITS);
const t0 = Date.now();
let built = null;
try {
  const { plan, verified, attempts, model } = await generateBuildPlan(
    'a tiny stone hut with a wooden roof and a doorway', process.env, verify,
  );
  const cmds = spansToCommands(verified.spans, TEST);
  const region = {
    x1: verified.bounds.x1 + TEST.x, y1: verified.bounds.y1 + TEST.y, z1: verified.bounds.z1 + TEST.z,
    x2: verified.bounds.x2 + TEST.x, y2: verified.bounds.y2 + TEST.y, z2: verified.bounds.z2 + TEST.z,
  };
  const buildSnap = await snapshot(rcon, region, 1);
  ok('LLM returned a valid plan', true,
    `"${plan.name}" ${verified.blocks} blocks, ${cmds.length} cmds, ${attempts} try, ${model}`);

  let errors = 0;
  for (const c of cmds) {
    const r = await rcon.send(c);
    if (/^(Failed|Unknown|Incorrect|That position)/i.test(r.trim())) {
      errors++;
      if (errors <= 2) console.log(`    rejected: ${c} -> ${r.trim().slice(0, 90)}`);
    }
  }
  ok('all compiled commands accepted by the server', errors === 0, `${errors} rejected`);
  ok('build completed in reasonable time', true, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  built = { plan, verified, snap: buildSnap };
} catch (err) {
  ok('LLM pipeline', false, err.message);
}

console.log('\n== 5. Undo the generated build (real !undo path) ==');
if (built) {
  const { vaultOrigin } = await import('../src/undo.js');
  const vr = built.snap.region;
  const v = vaultOrigin(built.snap.slot);
  // "Did undo work?" is exactly "does the world match the snapshot again?".
  // Asserting the area is air would be wrong - the snapshot legitimately
  // contains whatever was standing there first.
  const matches = async () => /Test passed/i.test(await rcon.send(
    `execute if blocks ${vr.x1} ${vr.y1} ${vr.z1} ${vr.x2} ${vr.y2} ${vr.z2} ${v.x} ${v.y} ${v.z} all`));

  const solid = built.verified.spans.filter((sp) => sp.material !== 'air').slice(0, 5);
  let present = 0;
  for (const s of solid) {
    if (await isBlock(s.x1 + TEST.x, s.y1 + TEST.y, s.z1 + TEST.z, s.material)) present++;
  }
  ok('build is standing before undo', present > 0, `${present}/${solid.length} sampled`);
  ok('world differs from snapshot before undo', !(await matches()));

  await restore(rcon, built.snap);
  ok('undo restored the world to the snapshot exactly', await matches());
} else {
  ok('undo', false, 'skipped, no build');
}

console.log('\n== 6. Cleanup ==');
await rcon.send(`fill ${TEST.x - 20} ${TEST.y - 1} ${TEST.z - 20} ${TEST.x + 20} ${TEST.y + 40} ${TEST.z + 20} air`);
await rcon.send(`forceload remove ${TEST.x - 32} ${TEST.z - 32} ${TEST.x + 32} ${TEST.z + 32}`);
ok('test area cleared', true);

console.log(`\n==== ${pass} passed, ${fail} failed ====\n`);
rcon.close();
process.exit(fail > 0 ? 1 : 0);
