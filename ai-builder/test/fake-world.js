// A stand-in for the server end of RCON, good enough to drive the whole build
// pipeline without a Minecraft server: ground at a fixed height (or a height
// per column), every chunk loaded, every clone and fill successful.
//
// Not a *.test.js file, so the test runner doesn't pick it up on its own.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function fakeWorld({ groundY = 64, groundAt, fail = () => null, player = { x: 0.5, y: 64, z: 0.5 } } = {}) {
  const sent = [];
  const heightAt = (x, z) => (groundAt ? groundAt(x, z) : groundY);
  const vol = (a) => (Math.abs(a[3] - a[0]) + 1) * (Math.abs(a[4] - a[1]) + 1) * (Math.abs(a[5] - a[2]) + 1);
  return {
    sent,
    async send(cmd) {
      const injected = fail(cmd);
      if (injected) throw injected;
      sent.push(cmd);
      let m;
      if ((m = cmd.match(/^execute if block (-?\d+) (-?\d+) (-?\d+) (\S+)$/))) {
        const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (m[4] === 'air') return y >= heightAt(x, z) ? 'Test passed' : 'Test failed';
        return 'Test failed';
      }
      if (cmd.startsWith('execute if loaded')) return 'Test passed';
      if ((m = cmd.match(/^clone (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/))) {
        return `Successfully cloned ${vol(m.slice(1, 7).map(Number))} block(s)`;
      }
      if ((m = cmd.match(/^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/))) {
        return `Successfully filled ${vol(m.slice(1, 7).map(Number))} block(s)`;
      }
      if (/^data get entity \S+ Pos$/.test(cmd)) {
        return `Kid has the following entity data: [${player.x}d, ${player.y}d, ${player.z}d]`;
      }
      if (/^data get entity \S+ Rotation$/.test(cmd)) {
        return 'Kid has the following entity data: [0.0f, 0.0f]';
      }
      return '';
    },
  };
}

// The model, replaced by a fixed plan that still goes through the real
// validator exactly as a generated one would.
export const fixedPlan = (plan) => async (description, env, verify) => {
  const verified = await verify(plan);
  return { plan, verified, usage: { cost: 0 }, attempts: 1, model: 'fixed' };
};

export function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-test-'));
  return {
    env: { STATE_DIR: dir, BUILD_COOLDOWN_SEC: '0' },
    state: { builds: {}, lastBuild: {}, history: [] },
  };
}
