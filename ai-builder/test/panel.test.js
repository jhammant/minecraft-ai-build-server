import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startWebServer } from '../src/web.js';
import { SIZES } from '../src/size.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f));

// Width and height straight out of a PNG's IHDR chunk.
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

test('the panel can be added to an iPad home screen', () => {
  // Arrange
  const html = read('index.html').toString();
  const manifest = JSON.parse(read('manifest.webmanifest').toString());

  // Assert
  assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon.png">/);
  assert.deepEqual(pngSize(read('apple-touch-icon.png')), { w: 180, h: 180 });
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.deepEqual(pngSize(read(icon.src.slice(1))), { w, h }, icon.src);
  }
});

test('the size buttons offer exactly the sizes the server accepts', () => {
  const html = read('index.html').toString();
  const offered = [...html.matchAll(/name="size" value="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(offered, Object.keys(SIZES));
  for (const m of html.matchAll(/data-size="(\w+)"/g)) assert.ok(SIZES[m[1]], m[1]);
});

async function panel(builder) {
  const server = startWebServer({
    env: { WEB_PORT: '0' }, state: { history: [] }, saveState: () => {}, builder,
    rewards: { enabled: () => false }, log: () => {},
    getRcon: () => ({ send: async () => '' }), broadcast: () => {},
  });
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

test('a build request carries its size to the builder, and a bad size is refused', async () => {
  // Arrange
  const calls = [];
  const builder = {
    run: async (o) => { calls.push(o); return { name: 'Hut' }; },
    isBusy: () => false,
  };
  const { base, close } = await panel(builder);
  const post = (body) => fetch(`${base}/api/build`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  try {
    // Act
    const bad = await post({ description: 'a hut', size: 'gigantic', x: 0, z: 0 });
    const good = await post({ description: 'a hut', size: 'small', x: 0, z: 0 });
    const manifest = await fetch(`${base}/manifest.webmanifest`);

    // Assert
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /small, medium, large or huge/);
    assert.equal(good.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].size, 'small');
    assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
  } finally {
    await close();
  }
});
