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
const TYPE_RESPONSE = 0;

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

export class Rcon {
  constructor({ host, port = 25575, password, timeout = 15000 }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.timeout = timeout;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
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
        // Per-command deadlines are enforced in send() instead.
        socket.removeListener('timeout', onConnectTimeout);
        socket.setTimeout(0);
        socket.setKeepAlive(true, 30000);
        this.socket = socket;
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', (err) => this._failAll(err));
        socket.on('close', () => this._failAll(new Error('RCON connection closed')));

        // Auth. A failed auth comes back with requestId -1.
        const id = this.nextId++;
        this.pending.set(id, {
          resolve: () => resolve(this),
          reject,
          authing: true,
        });
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
      const body = packet.subarray(8, packet.length - 2).toString('utf8');

      // Auth failure is signalled by id === -1 on the auth response.
      if (id === -1) {
        this._failAll(new Error('RCON authentication failed - wrong password'));
        return;
      }
      const waiter = this.pending.get(id);
      if (!waiter) continue;
      // The server sends an empty TYPE_RESPONSE before the auth response;
      // ignore it and wait for the real one.
      if (waiter.authing && type !== TYPE_AUTH_RESPONSE) continue;
      this.pending.delete(id);
      waiter.resolve(body);
    }
  }

  _failAll(err) {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  send(command) {
    if (!this.socket) return Promise.reject(new Error('RCON not connected'));
    // A newline would let one command smuggle in a second. Callers are
    // already validated, but refuse here too - this is the last gate before
    // the server executes anything.
    if (/[\r\n\0]/.test(command)) {
      return Promise.reject(new Error('refusing command containing a newline or NUL'));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RCON command timed out: ${command.slice(0, 60)}`));
      }, this.timeout);
      this.pending.set(id, {
        resolve: (body) => {
          clearTimeout(timer);
          resolve(body);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.socket.write(encode(id, TYPE_COMMAND, command));
    });
  }

  close() {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
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
