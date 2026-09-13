import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { Rcon, RconError, createRconLink, MAX_PAYLOAD } from '../src/rcon.js';
import { createForceloader, chunkRects } from '../src/forceload.js';

// --- a fake server with vanilla's temperament ----------------------------------
//
// Vanilla's RconClient reads one request at a time and hangs up if a second
// arrives while it is still busy with the first (they end up in the same
// read). This fake enforces exactly that, deterministically: a packet that
// arrives while another is outstanding closes the connection.

const packet = (id, type, body) => {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
};

function fakeServer({ password = 'pw', reply = (cmd) => `ran ${cmd}`, delayMs = 5 } = {}) {
  const stats = { dropped: 0, commands: [], maxOutstanding: 0 };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let outstanding = 0;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (buf.length < len + 4) break;
        const p = buf.subarray(4, len + 4);
        buf = buf.subarray(len + 4);
        const id = p.readInt32LE(0);
        const type = p.readInt32LE(4);
        const body = p.subarray(8, p.length - 2).toString('utf8');
        if (type === 3) {
          sock.write(packet(body === password ? id : -1, 2, ''));
          continue;
        }
        if (outstanding > 0) { stats.dropped++; sock.destroy(); return; }
        outstanding++;
        stats.maxOutstanding = Math.max(stats.maxOutstanding, outstanding);
        stats.commands.push(body);
        const out = reply(body);
        if (out === null) continue;             // never answer: a hung server
        setTimeout(() => {
          outstanding--;
          const pieces = Array.isArray(out) ? out : [out];
          for (const piece of pieces) sock.write(packet(id, 0, piece));
        }, delayMs);
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ port: server.address().port, stats, close: () => server.close() });
  }));
}

const connectTo = (port, extra = {}) => new Rcon({ host: '127.0.0.1', port, password: 'pw', ...extra }).connect();

test('concurrent sends never put two requests on the wire at once', async () => {
  // Arrange: the scenario that dropped a live build - a status poll firing
  // while the build is mid-command.
  const srv = await fakeServer();
  const rcon = await connectTo(srv.port);

  // Act
  const replies = await Promise.all(
    Array.from({ length: 25 }, (_, i) => rcon.send(`fill ${i} 0 0 ${i} 0 0 stone`)),
  );

  // Assert
  assert.equal(srv.stats.dropped, 0, 'the server must never see an overlapping request');
  assert.equal(srv.stats.maxOutstanding, 1);
  assert.deepEqual(replies, Array.from({ length: 25 }, (_, i) => `ran fill ${i} 0 0 ${i} 0 0 stone`),
    'every reply is matched to its own command, in order');
  rcon.close();
  srv.close();
});

test('a reply split across 4096-byte packets is reassembled', async () => {
  // Arrange
  const big = 'a'.repeat(4096);
  const srv = await fakeServer({ reply: (cmd) => (cmd === 'long' ? [big, 'tail'] : 'short') });
  const rcon = await connectTo(srv.port);

  // Act
  const long = await rcon.send('long');
  const next = await rcon.send('next');

  // Assert
  assert.equal(long, `${big}tail`);
  assert.equal(next, 'short', 'the continuation must not be mistaken for the next reply');
  rcon.close();
  srv.close();
});

test('an over-long command is refused locally and the connection survives', async () => {
  // Arrange
  const srv = await fakeServer();
  const rcon = await connectTo(srv.port);

  // Act + Assert
  await assert.rejects(rcon.send(`say ${'x'.repeat(MAX_PAYLOAD)}`), /over 1446 bytes/);
  assert.equal(srv.stats.commands.length, 0, 'nothing oversized reached the server');
  assert.equal(await rcon.send('list'), 'ran list');
  rcon.close();
  srv.close();
});

test('a timed-out command resets the connection and fails what was queued behind it', async () => {
  // Arrange
  const srv = await fakeServer({ reply: (cmd) => (cmd === 'hang' ? null : 'ok') });
  const closed = [];
  const rcon = await connectTo(srv.port, { timeout: 80, onClose: (e) => closed.push(e.code) });

  // Act
  const hung = rcon.send('hang');
  const queued = rcon.send('list');
  const [a, b] = await Promise.allSettled([hung, queued]);

  // Assert
  assert.equal(a.reason.code, 'RCON_TIMEOUT');
  assert.equal(a.reason.sent, true, 'the hung command reached the server');
  assert.equal(b.reason.code, 'RCON_TIMEOUT');
  assert.equal(b.reason.sent, false, 'the queued one never did, so it is safe to retry');
  assert.equal(rcon.connected, false);
  assert.deepEqual(closed, ['RCON_TIMEOUT']);
  srv.close();
});

test('a wrong password is reported, not retried silently', async () => {
  const srv = await fakeServer({ password: 'right' });
  await assert.rejects(connectTo(srv.port), /authentication failed/);
  srv.close();
});

// --- the self-healing link -----------------------------------------------------

// A stand-in client whose connection can be cut from the test.
function fakeClient(name, log) {
  const c = {
    connected: true,
    failNext: null,
    async send(cmd) {
      if (!c.connected) throw new RconError('RCON not connected', { code: 'RCON_NOT_CONNECTED' });
      if (c.failNext) {
        const err = c.failNext;
        c.failNext = null;
        c.connected = false;
        throw err;
      }
      log.push(`${name}:${cmd}`);
      return `${name} ok`;
    },
    close() { c.connected = false; },
  };
  return c;
}

test('a send whose connection dies mid-flight is retried on the NEW connection', async () => {
  // Arrange: the build holds the link, not a client - so when the connection
  // is replaced, it follows.
  const log = [];
  const clients = [];
  const link = createRconLink({
    open: async () => { const c = fakeClient(`c${clients.length + 1}`, log); clients.push(c); return c; },
    retryDelayMs: 1,
  });
  await link.send('list');
  clients[0].failNext = new RconError('RCON connection closed', { code: 'RCON_CLOSED', sent: true });

  // Act
  const res = await link.send('fill 0 0 0 1 1 1 stone');

  // Assert
  assert.equal(res, 'c2 ok');
  assert.deepEqual(log, ['c1:list', 'c2:fill 0 0 0 1 1 1 stone']);
  assert.equal(clients.length, 2);
});

test('the link never repeats a summon that may already have run', async () => {
  // Arrange
  const log = [];
  const clients = [];
  const link = createRconLink({
    open: async () => { const c = fakeClient(`c${clients.length + 1}`, log); clients.push(c); return c; },
    retryDelayMs: 1,
  });
  await link.ensure();

  // Act: written and then lost - it may have spawned a cow already
  clients[0].failNext = new RconError('RCON connection closed', { code: 'RCON_CLOSED', sent: true });
  const written = link.send('summon minecraft:cow 0 64 0');

  // Assert
  await assert.rejects(written, /closed/);
  assert.equal(log.length, 0, 'no second cow');
});

test('a summon that never reached the wire is sent again', async () => {
  // Arrange
  const log = [];
  const clients = [];
  const link = createRconLink({
    open: async () => { const c = fakeClient(`c${clients.length + 1}`, log); clients.push(c); return c; },
    retryDelayMs: 1,
  });
  await link.ensure();
  clients[0].failNext = new RconError('RCON connection closed', { code: 'RCON_CLOSED', sent: false });

  // Act
  const res = await link.send('summon minecraft:cow 0 64 0');

  // Assert
  assert.equal(res, 'c2 ok');
  assert.deepEqual(log, ['c2:summon minecraft:cow 0 64 0']);
});

test('errors from the server itself are not retried', async () => {
  const link = createRconLink({
    open: async () => ({ connected: true, send: async () => { throw new Error('refusing command containing a newline or NUL'); } }),
    retryDelayMs: 1,
  });
  await assert.rejects(link.send('x'), /newline/);
});

test('a link that cannot reconnect gives up after its wait, with the original error', async () => {
  // Arrange
  let opens = 0;
  const c = fakeClient('c1', []);
  const link = createRconLink({
    open: async () => { opens++; if (opens === 1) return c; throw new Error('ECONNREFUSED'); },
    reconnectWaitMs: 0,
    retryDelayMs: 1,
  });
  await link.ensure();
  c.failNext = new RconError('RCON connection closed', { code: 'RCON_CLOSED', sent: true });

  // Act + Assert
  await assert.rejects(link.send('list'), /connection closed/);
});

// --- force-loaded chunks -------------------------------------------------------

const recorder = (fail = () => false) => {
  const sent = [];
  return {
    sent,
    send: async (cmd) => {
      if (fail(cmd)) throw new RconError('RCON not connected', { code: 'RCON_NOT_CONNECTED' });
      sent.push(cmd);
      return 'ok';
    },
  };
};

test('chunks are released even when the work in between throws', async () => {
  // Arrange
  const fl = createForceloader();
  const rcon = recorder();

  // Act
  await assert.rejects(fl.withForceload(rcon, [{ x1: 0, z1: 0, x2: 40, z2: 40 }], async () => {
    throw new Error('RCON not connected');
  }), /not connected/);

  // Assert
  assert.deepEqual(rcon.sent, ['forceload add 0 0 47 47', 'forceload remove 0 0 47 47']);
  assert.equal(fl.held(), 0);
});

test('a nested use does not unload chunks the outer use still needs', async () => {
  // Arrange: the snapshot runs inside the build, over the same site.
  const fl = createForceloader();
  const rcon = recorder();
  const site = { x1: 0, z1: 0, x2: 31, z2: 31 };

  // Act
  await fl.withForceload(rcon, [site], async () => {
    await fl.withForceload(rcon, [{ x1: 0, z1: 0, x2: 63, z2: 15 }], async () => {});
    rcon.sent.push('-- snapshot done --');
  });

  // Assert: the inner release frees only the chunk the site never held
  const inner = rcon.sent.slice(0, rcon.sent.indexOf('-- snapshot done --'));
  assert.deepEqual(inner.filter((c) => c.startsWith('forceload remove')), ['forceload remove 32 0 63 15']);
  assert.equal(rcon.sent.at(-1), 'forceload remove 0 0 31 31');
  assert.equal(fl.held(), 0);
});

test('a release that failed is retried later, unless the chunks were claimed again', async () => {
  // Arrange
  const fl = createForceloader();
  let down = true;
  const rcon = recorder((cmd) => down && cmd.startsWith('forceload remove'));
  await fl.withForceload(rcon, [{ x1: 0, z1: 0, x2: 15, z2: 15 }], async () => {});
  assert.equal(fl.pending(), 1);

  // Act
  down = false;
  await fl.flush(rcon);

  // Assert
  assert.equal(rcon.sent.at(-1), 'forceload remove 0 0 15 15');
  assert.equal(fl.pending(), 0);
});

test('chunk sets merge into few rectangles', () => {
  const keys = [];
  for (let z = 0; z < 3; z++) for (let x = 0; x < 4; x++) keys.push(`${x},${z}`);
  keys.push('10,0');
  assert.deepEqual(chunkRects(keys), [
    { cx1: 0, cx2: 3, cz1: 0, cz2: 2 },
    { cx1: 10, cx2: 10, cz1: 0, cz2: 0 },
  ]);
});
