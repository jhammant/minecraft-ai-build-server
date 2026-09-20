import net from 'node:net';

// Minecraft RCON (Source RCON protocol). Implemented directly rather than
// pulled from npm - it's ~80 lines and keeps this image dependency-free.
//
// Packet layout (all ints little-endian):
//   int32 length (of everything after this field)
//   int32 requestId
//   int32 type
//   byte[] body, NUL-terminated
//   byte   NUL terminator
const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_COMMAND = 2;

// The server end is much less forgiving than the protocol suggests. Vanilla's
// RconClient (which Paper still runs, one thread per connection) takes each
// request with a SINGLE read() of at most 1460 bytes, and hangs up unless that
// one read holds exactly one whole packet:
//
//   - two requests that arrive back to back are read together, the length
//     check fails, and the connection is closed. That is what dropped a build
//     mid-flight: the panel's status poll sent `list` while the build was
//     sending `forceload add`, both landed in the server's buffer, and the
//     server logged "Thread RCON Client ... shutting down".
//   - a request over 1460 bytes is truncated by that read and closed the
//     same way. 1460 minus the 14 bytes of framing leaves 1446 for the body.
//
// So a connection carries ONE request at a time (see _pump), and anything too
// long is refused here instead of costing the connection.
export const MAX_PAYLOAD = 1446;

// Replies go the other way in pieces: the server cuts any response into
// packets of at most 4096 bytes, all carrying the request's id.
const RESPONSE_CHUNK = 4096;
const CONTINUATION_WAIT_MS = 150;

function encode(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0); // length excludes itself
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeInt16LE(0, 12 + payload.length); // body NUL + packet NUL
  return buf;
}

/**
 * A failure talking to the server, as opposed to the server answering.
 *
 * `sent` records whether the command reached the wire. A command that was
 * never written is always safe to retry on a fresh connection; one that was
 * written may already have run.
 */
export class RconError extends Error {
  constructor(message, { code, sent = false } = {}) {
    super(message);
    this.code = code;
    this.sent = sent;
  }
}

export const isConnectionError = (err) => err instanceof RconError
  && ['RCON_NOT_CONNECTED', 'RCON_CLOSED', 'RCON_TIMEOUT'].includes(err.code);

export class Rcon {
  constructor({ host, port = 25575, password, timeout = 15000, onClose }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.timeout = timeout;
    this.onClose = onClose;
    this.socket = null;
    this.authed = false;
    this.nextId = 1;
    this.queue = [];
    this.inFlight = null;
    this.authWaiter = null;
    this.buffer = Buffer.alloc(0);
  }

  get connected() {
    return Boolean(this.socket) && this.authed;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setTimeout(this.timeout);

      const onError = (err) => {
        socket.destroy();
        reject(err);
      };
      const onConnectTimeout = () => onError(new Error('RCON connect timeout'));
      socket.once('error', onError);
      socket.once('timeout', onConnectTimeout);

      socket.once('connect', () => {
        socket.removeListener('error', onError);
        // Disarm the connect-phase timeout. Left armed, it fires on any idle
        // period longer than `timeout` and destroys a perfectly good socket -
        // which is exactly what happens while we wait on a slow LLM call.
        // Per-command deadlines are enforced in _pump() instead.
        socket.removeListener('timeout', onConnectTimeout);
        socket.setTimeout(0);
        socket.setKeepAlive(true, 30000);
        // Each packet goes out on its own, now, rather than being held back by
        // Nagle and coalesced with whatever is written next.
        socket.setNoDelay(true);
        this.socket = socket;
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', (err) => this._failAll(
          new RconError(`RCON connection error: ${err.message}`, { code: 'RCON_CLOSED' })));
        socket.on('close', () => this._failAll(
          new RconError('RCON connection closed', { code: 'RCON_CLOSED' })));

        // Auth. A failed auth comes back with requestId -1.
        const id = this.nextId++;
        this.authWaiter = {
          id,
          resolve: () => { this.authed = true; this.authWaiter = null; resolve(this); this._pump(); },
          reject: (err) => { this.authWaiter = null; reject(err); },
        };
        socket.write(encode(id, TYPE_AUTH, this.password));
      });
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readInt32LE(0);
      if (this.buffer.length < len + 4) break;
      const packet = this.buffer.subarray(4, len + 4);
      this.buffer = this.buffer.subarray(len + 4);

      const id = packet.readInt32LE(0);
      const type = packet.readInt32LE(4);
      const body = packet.subarray(8, packet.length - 2);

      // Auth failure is signalled by id === -1 on the auth response.
      if (id === -1) {
        this._failAll(new Error('RCON authentication failed - wrong password'));
        return;
      }
      if (this.authWaiter && id === this.authWaiter.id) {
        // Source servers send an empty TYPE_RESPONSE before the auth
        // response; ignore it and wait for the real one.
        if (type === TYPE_AUTH_RESPONSE) this.authWaiter.resolve();
        continue;
      }
      // Only the request on the wire can be answered. Anything else is a late
      // reply to a request we already gave up on - drop it.
      const job = this.inFlight;
      if (!job || job.id !== id) continue;
      job.parts.push(body);
      clearTimeout(job.settle);
      if (body.length >= RESPONSE_CHUNK) {
        // A full-size piece means more may follow. There is no end marker, so
        // wait briefly for the next one before calling the reply complete.
        job.settle = setTimeout(() => this._finish(job), CONTINUATION_WAIT_MS);
      } else {
        this._finish(job);
      }
    }
  }

  _finish(job) {
    if (this.inFlight !== job) return;
    clearTimeout(job.timer);
    clearTimeout(job.settle);
    this.inFlight = null;
    job.resolve(Buffer.concat(job.parts).toString('utf8'));
    this._pump();
  }

  // Write the next queued command, but only once nothing else is on the wire.
  _pump() {
    if (this.inFlight || !this.connected || this.queue.length === 0) return;
    const job = this.queue.shift();
    job.id = this.nextId++;
    job.parts = [];
    // The deadline starts when the command is written, not when it was queued:
    // a command waiting its turn behind a slow one has not been slow itself.
    job.timer = setTimeout(() => {
      // A reply we stop waiting for can still arrive, and by then the stream
      // is out of step - the server may be reading our next request while it
      // still owes us this one. Start clean rather than guess.
      this._failAll(new RconError(`RCON command timed out: ${job.command.slice(0, 60)}`,
        { code: 'RCON_TIMEOUT' }));
    }, this.timeout);
    this.inFlight = job;
    this.socket.write(encode(job.id, TYPE_COMMAND, job.command));
  }

  _failAll(err) {
    const wasOpen = Boolean(this.socket);
    if (this.authWaiter) this.authWaiter.reject(err);
    const job = this.inFlight;
    this.inFlight = null;
    if (job) {
      clearTimeout(job.timer);
      clearTimeout(job.settle);
      // Written, so it may have run. Timeouts keep their own code.
      job.reject(err instanceof RconError
        ? new RconError(err.message, { code: err.code, sent: true })
        : err);
    }
    const queued = this.queue;
    this.queue = [];
    for (const q of queued) {
      q.reject(err instanceof RconError
        ? new RconError(err.message, { code: err.code, sent: false })
        : err);
    }
    this.authed = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    if (wasOpen && this.onClose) this.onClose(err);
  }

  send(command) {
    if (!this.connected) {
      return Promise.reject(new RconError('RCON not connected', { code: 'RCON_NOT_CONNECTED' }));
    }
    // A newline would let one command smuggle in a second. Callers are
    // already validated, but refuse here too - this is the last gate before
    // the server executes anything.
    if (/[\r\n\0]/.test(command)) {
      return Promise.reject(new Error('refusing command containing a newline or NUL'));
    }
    if (Buffer.byteLength(command, 'utf8') > MAX_PAYLOAD) {
      return Promise.reject(new Error(
        `refusing command over ${MAX_PAYLOAD} bytes (the server would drop the connection): `
        + `${command.slice(0, 60)}`,
      ));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ command, resolve, reject });
      this._pump();
    });
  }

  close() {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    this.authed = false;
  }
}

// Convenience: connect, run a function, always disconnect.
export async function withRcon(opts, fn) {
  const rcon = new Rcon(opts);
  await rcon.connect();
  try {
    return await fn(rcon);
  } finally {
    rcon.close();
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Commands that must not run twice. Everything else the builder sends - fill,
// setblock, clone into the vault, forceload, execute if - lands the world in the
// same state however many times it runs.
const NOT_REPEATABLE = /^summon\s/;

/**
 * One long-lived connection that heals itself.
 *
 * A build runs for minutes and used to hold on to the client object it was
 * started with. When that connection dropped, the keepalive opened a new one -
 * and the build carried on sending into the dead one, so its snapshot failed
 * twice with "RCON not connected" a second after "RCON connected" was logged.
 *
 * Everything now holds this link instead. Each send uses whatever connection
 * is current, reconnects on demand, and retries once if the connection went
 * away underneath it.
 *
 * @param {object}   o
 * @param {function} o.open             () => Promise<connected Rcon>, one attempt
 * @param {function} o.log
 * @param {number=}  o.reconnectWaitMs  how long a send may wait for a reconnect
 */
export function createRconLink({ open, log = () => {}, reconnectWaitMs = 20000, retryDelayMs = 500 }) {
  let client = null;
  let connecting = null;

  function ensure(waitMs = reconnectWaitMs) {
    if (client?.connected) return Promise.resolve(client);
    if (!connecting) {
      connecting = (async () => {
        const deadline = Date.now() + waitMs;
        for (let attempt = 1; ; attempt++) {
          try {
            client = await open();
            log('RCON connected');
            return client;
          } catch (err) {
            const wait = Math.min(30000, attempt * 3000, Math.max(0, deadline - Date.now()));
            if (wait <= 0) {
              throw new RconError(`RCON not connected (${err.message})`, { code: 'RCON_NOT_CONNECTED' });
            }
            log(`RCON connect failed (${err.message}), retrying in ${wait / 1000}s`);
            await delay(wait);
          }
        }
      })().finally(() => { connecting = null; });
    }
    return connecting;
  }

  async function send(command) {
    let first;
    try {
      return await (await ensure()).send(command);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      if (err.sent && NOT_REPEATABLE.test(command)) throw err;
      first = err;
    }
    log(`RCON dropped during "${command.slice(0, 50)}" (${first.message}) - reconnecting to retry once`);
    await delay(retryDelayMs);
    let fresh;
    try { fresh = await ensure(); } catch { throw first; }
    return fresh.send(command);
  }

  return {
    send,
    ensure,
    connected: () => Boolean(client?.connected),
    close: () => client?.close(),
  };
}
