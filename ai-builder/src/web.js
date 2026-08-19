// Web panel: status, whitelist, worlds, backups, and AI builds placed by
// clicking the map. Node's built-in http only - no framework, no npm deps.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// A player name we're willing to interpolate into a server command. Same
// reasoning as the block-material check in validate.js: anything outside this
// character set could smuggle a second command past RCON.
const NAME_RE = /^\.?[A-Za-z0-9_]{1,32}$/;
const WORLD_RE = /^[a-z0-9_-]{1,32}$/i;

// --- trusting the local network ---------------------------------------------
//
// Typing a password to manage a server on your own sofa is friction nobody
// wants, so connections from private address space can skip the login.
//
// This is only sound because Docker's published ports preserve the real client
// address (verified: the game server logs joining players as 10.x.x.x, not the
// bridge gateway). If you ever run this behind something that rewrites the
// source address, every request would look local - so this is opt-in, and the
// panel logs the address it saw on the first request from each host.

const PRIVATE_CIDRS = [
  '127.0.0.0/8',      // loopback
  '10.0.0.0/8',       // RFC1918
  '172.16.0.0/12',    // RFC1918 (includes Docker's own bridges)
  '192.168.0.0/16',   // RFC1918
  '169.254.0.0/16',   // link-local
  '100.64.0.0/10',    // CGNAT - where Tailscale and friends live
];

const ip4ToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8 >>> 0) + Number(o), 0) >>> 0;

function inCidr(ip, cidr) {
  const [range, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(range)) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ip4ToInt(ip) & mask) === (ip4ToInt(range) & mask);
}

// Node reports IPv4 clients as "::ffff:10.0.0.5" on a dual-stack socket.
export function normaliseIp(addr) {
  if (!addr) return '';
  const s = String(addr);
  if (s.startsWith('::ffff:')) return s.slice(7);
  if (s === '::1') return '127.0.0.1';
  return s;
}

export function isLocalAddress(addr, cidrs = PRIVATE_CIDRS) {
  const ip = normaliseIp(addr);
  return cidrs.some((c) => inCidr(ip, c));
}

/**
 * The address we should actually make a trust decision about.
 *
 * Behind a reverse proxy every request arrives from the proxy - a private
 * address - so a naive "is this local?" check would hand the whole internet a
 * free pass. Only when the immediate peer is a *declared* trusted proxy do we
 * believe X-Forwarded-For, and then we take the last hop it recorded.
 *
 * With no trusted proxies configured (the default) the header is ignored
 * entirely, because anyone can send it.
 */
export function clientAddress(req, trustedProxies = []) {
  const peer = normaliseIp(req.socket?.remoteAddress);
  if (!trustedProxies.length) return peer;
  if (!trustedProxies.some((c) => inCidr(peer, c))) return peer;
  const xff = req.headers['x-forwarded-for'];
  if (!xff) return peer;
  const hops = String(xff).split(',').map((s) => normaliseIp(s.trim())).filter(Boolean);
  // Walk back from the proxy towards the client, skipping other trusted hops.
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!trustedProxies.some((c) => inCidr(hops[i], c))) return hops[i];
  }
  return hops[0] || peer;
}

const DIMENSION = {
  NORMAL: 'minecraft:overworld',
  NETHER: 'minecraft:the_nether',
  THE_END: 'minecraft:the_end',
};

// Write a BlueMap map config for a freshly created world.
async function addBlueMapWorld(name, type, log) {
  const dir = process.env.BLUEMAP_MAPS_DIR || '/bluemap-maps';
  const conf = [
    `world: "${name}"`,
    `dimension: "${DIMENSION[type] || DIMENSION.NORMAL}"`,
    `name: "${name}"`,
    'sorting: 100',
    'start-pos: { x: 0, z: 0 }',
    '',
  ].join('\n');
  try {
    await fs.promises.writeFile(path.join(dir, `${name}.conf`), conf, { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return true;
    log(`could not add ${name} to BlueMap: ${err.message}`);
    return false;
  }
}

// Flatten (or clear) a square of ground so there is somewhere sensible to build.
async function prepareSite(rcon, x, z, half, mode, material, log) {
  const { findSurfaceY, footprintSurfaceY } = await import('./build.js');
  const { snapshot } = await import('./undo.js');

  await rcon.send(`forceload add ${x - half - 16} ${z - half - 16} ${x + half + 16} ${z + half + 16}`)
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));

  // Sea level is 63. A pad levelled at or below it floods the moment the
  // surrounding water flows back in - which is exactly what happened to a whole
  // showcase built on "flat" ground that turned out to be ocean. Lift the pad
  // clear of the water and it becomes an island instead of a puddle.
  const SEA_LEVEL = 63;
  const natural = await footprintSurfaceY(rcon, x, z, half, half);
  const ground = Math.max(natural, SEA_LEVEL + 3);
  const raised = ground > natural;
  const top = ground + 40;                 // clear headroom above the pad
  const region = { x1: x - half, y1: ground - 6, z1: z - half, x2: x + half, y2: top, z2: z + half };

  // Same undo guarantee as a build: snapshot before touching anything.
  let snap = null;
  try { snap = await snapshot(rcon, region, 15); } catch (e) { log(`prepare snapshot failed: ${e.message}`); }

  const chunks = [];
  const LIMIT = 32768;
  const step = Math.max(1, Math.floor(LIMIT / ((2 * half + 1) * (2 * half + 1))));
  for (let y = region.y1; y <= region.y2; y += step) {
    const y2 = Math.min(y + step - 1, region.y2);
    const block = (y < ground) ? material : (y === ground ? material : 'air');
    chunks.push(`fill ${region.x1} ${y} ${region.z1} ${region.x2} ${y2} ${region.z2} ${block}`);
  }
  let changed = 0;
  for (const c of chunks) {
    const r = await rcon.send(c);
    const m = r.match(/filled (\d+)/i);
    if (m) changed += Number(m[1]);
  }
  await rcon.send(`forceload remove ${x - half - 16} ${z - half - 16} ${x + half + 16} ${z + half + 16}`)
    .catch(() => {});

  return {
    x, z, y: ground, size: half * 2, blocks: changed, undoable: Boolean(snap), mode,
    raised, naturalGround: natural,
  };
}

// Minimal reverse proxy for the map tiles.
function proxy(targetUrl, req, res) {
  const upstream = http.request(targetUrl, {
    method: req.method,
    headers: { ...req.headers, host: new URL(targetUrl).host },
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Map is not running yet. It renders in the background after the server starts.');
    } else res.end();
  });
  req.pipe(upstream);
}

export function startWebServer({ env, state, saveState, builder, log, getRcon, broadcast }) {
  const port = Number(env.WEB_PORT || 8080);
  const password = env.WEB_PASSWORD || '';
  // When the panel sits behind a reverse proxy that already authenticated the
  // user (Authelia, oauth2-proxy, Cloudflare Access), trust its identity header
  // instead of asking for a second password.
  const trustedHeader = (env.WEB_TRUST_PROXY_HEADER || '').toLowerCase();
  // No password needed from the local network. On by default: this panel is
  // meant to live on a home LAN.
  const lanNoAuth = String(env.WEB_LAN_NOAUTH ?? 'true').toLowerCase() !== 'false';
  const lanCidrs = (env.WEB_TRUSTED_CIDRS || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Reverse proxies whose X-Forwarded-For we believe. Empty = trust none.
  const trustedProxies = (env.WEB_TRUSTED_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (!password && !trustedHeader && !lanNoAuth) {
    log('WEB_PASSWORD is not set and nothing else is trusted - web panel DISABLED');
    return null;
  }
  if (lanNoAuth && !trustedProxies.length) {
    log('note: X-Forwarded-For is ignored (no WEB_TRUSTED_PROXIES set). If you put '
      + 'this behind a reverse proxy, set it, or every request will look local.');
  }
  log(`web auth: ${lanNoAuth ? 'local network trusted' : 'password only'}`
    + `${password ? ', password set' : ', NO password set'}`
    + `${trustedHeader ? `, proxy header ${trustedHeader}` : ''}`);

  const seenHosts = new Set();

  const sessions = new Map(); // token -> expiry
  const SESSION_MS = 7 * 24 * 3600 * 1000;

  const newSession = () => {
    const token = crypto.randomBytes(24).toString('base64url');
    sessions.set(token, Date.now() + SESSION_MS);
    return token;
  };

  function authed(req) {
    if (trustedHeader && req.headers[trustedHeader]) return true;

    if (lanNoAuth) {
      const ip = clientAddress(req, trustedProxies);
      const local = lanCidrs.length ? isLocalAddress(ip, lanCidrs) : isLocalAddress(ip);
      // Log each new client once, so it's obvious if everything is arriving
      // from one address (which would mean source IPs are being rewritten and
      // this check is worthless).
      if (!seenHosts.has(ip)) {
        seenHosts.add(ip);
        log(`web client ${ip} -> ${local ? 'local network, no password needed' : 'remote, password required'}`);
      }
      if (local) return true;
    }
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/(?:^|;\s*)mcpanel=([A-Za-z0-9_-]+)/);
    if (!m) return false;
    const exp = sessions.get(m[1]);
    if (!exp) return false;
    if (exp < Date.now()) { sessions.delete(m[1]); return false; }
    return true;
  }

  const rcon = () => {
    const r = getRcon();
    if (!r) throw new Error('server connection not ready');
    return r;
  };
  const strip = (s) => s.replace(/§[0-9a-fk-or]/g, '').trim();

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/auth') {
      return json(res, 200, { authenticated: authed(req), passwordSet: Boolean(password) });
    }

    if (route === 'POST /api/login') {
      if (!password) return json(res, 400, { error: 'No password is configured on this server.' });
      const body = await readBody(req);
      const supplied = Buffer.from(String(body.password || ''));
      const expected = Buffer.from(password);
      // Constant-time compare so the panel can't be probed a character at a time.
      const ok = password.length > 0
        && supplied.length === expected.length
        && crypto.timingSafeEqual(supplied, expected);
      if (!ok) {
        await new Promise((r) => setTimeout(r, 400)); // blunt the brute-force rate
        return json(res, 401, { error: 'Wrong password' });
      }
      res.setHeader('Set-Cookie',
        `mcpanel=${newSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`);
      return json(res, 200, { ok: true });
    }

    if (!authed(req)) return json(res, 401, { error: 'Not logged in' });

    switch (route) {
      case 'GET /api/status': {
        const players = strip(await rcon().send('list'));
        const m = players.match(/(\d+) of a max of (\d+)/);
        const names = players.split(':')[1]?.split(',').map((s) => s.trim()).filter(Boolean) || [];
        return json(res, 200, {
          online: m ? Number(m[1]) : 0,
          max: m ? Number(m[2]) : 0,
          players: names,
          busy: builder.isBusy(),
          mapUrl: env.MAP_PUBLIC_URL || '',
        });
      }

      case 'GET /api/whitelist': {
        const out = strip(await rcon().send('whitelist list'));
        const names = out.includes(':')
          ? out.split(':')[1].split(',').map((s) => s.trim()).filter(Boolean)
          : [];
        return json(res, 200, { players: names });
      }

      case 'POST /api/whitelist': {
        const { name, bedrock } = await readBody(req);
        if (!NAME_RE.test(String(name || ''))) {
          return json(res, 400, { error: 'That does not look like a Minecraft username.' });
        }
        // Bedrock players arrive through Floodgate and are not in Mojang's
        // database, so they need Floodgate's own whitelist command.
        const cmd = bedrock ? `fwhitelist add ${name}` : `whitelist add ${name}`;
        const out = strip(await rcon().send(cmd));
        await rcon().send('whitelist reload').catch(() => {});
        const failed = /does not exist|Couldn't find/i.test(out);
        return json(res, failed ? 400 : 200,
          failed ? { error: `${out || 'Could not find that player'}${bedrock ? '' : ' - if they play on console/tablet, tick Bedrock.'}` }
                 : { ok: true, message: out || `Added ${name}` });
      }

      case 'POST /api/whitelist/remove': {
        const { name } = await readBody(req);
        if (!NAME_RE.test(String(name || ''))) return json(res, 400, { error: 'Bad name' });
        const out = strip(await rcon().send(`whitelist remove ${name}`));
        return json(res, 200, { ok: true, message: out });
      }

      case 'GET /api/worlds': {
        const out = strip(await rcon().send('mv list'));
        const worlds = [...out.matchAll(/^\s*(\S+)\s+-\s+(NORMAL|NETHER|THE_END)/gim)]
          .map((m) => ({ name: m[1], type: m[2] }));
        return json(res, 200, { worlds });
      }

      case 'POST /api/worlds': {
        const { name, type = 'NORMAL' } = await readBody(req);
        if (!WORLD_RE.test(String(name || ''))) return json(res, 400, { error: 'Bad world name' });
        if (!['NORMAL', 'NETHER', 'THE_END'].includes(type)) {
          return json(res, 400, { error: 'Bad world type' });
        }
        const out = strip(await rcon().send(`mv create ${name} ${type}`));
        // A new Multiverse world is invisible to BlueMap until it has a map
        // config, so write one and reload - otherwise the world exists in game
        // but never appears on the web map.
        const mapped = await addBlueMapWorld(name, type, log);
        if (mapped) await rcon().send('bluemap reload').catch(() => {});
        return json(res, 200, {
          ok: true,
          message: (out || `Creating ${name}...`)
            + (mapped ? ' It will appear on the map once it renders.'
                      : ' (could not add it to the web map automatically)'),
        });
      }

      case 'POST /api/prepare': {
        // "Flatten this spot" / "clear this spot". Kids want somewhere tidy to
        // build on, and natural terrain almost never is - this was the single
        // biggest cause of builds half-buried in a hillside.
        const { x, z, size = 32, mode = 'flatten', material = 'grass_block' } = await readBody(req);
        if (!Number.isFinite(x) || !Number.isFinite(z)) {
          return json(res, 400, { error: 'Pick a spot on the map first.' });
        }
        const half = Math.max(4, Math.min(64, Math.floor(size / 2)));
        if (!['flatten', 'clear'].includes(mode)) return json(res, 400, { error: 'Bad mode' });
        if (!/^[a-z0-9_]+$/.test(String(material))) return json(res, 400, { error: 'Bad material' });
        try {
          const out = await prepareSite(rcon(), Math.round(x), Math.round(z), half, mode, material, log);
          return json(res, 200, { ok: true, ...out });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }

      case 'GET /api/maps': {
        // BlueMap publishes the maps it has rendered in settings.json. Ask it
        // rather than guessing from the worlds Multiverse knows about - a world
        // can exist without having been rendered yet.
        const base = (env.MAP_INTERNAL_URL || 'http://mc:8100').replace(/\/$/, '');
        try {
          const r = await fetch(`${base}/settings.json`, { signal: AbortSignal.timeout(8000) });
          const s = await r.json();
          return json(res, 200, { maps: s.maps || [] });
        } catch (err) {
          return json(res, 200, { maps: [], error: 'map server not ready' });
        }
      }

      case 'GET /api/history':
        return json(res, 200, { builds: (state.history || []).slice(0, 40) });

      case 'POST /api/build': {
        const { description, x, y, z, player } = await readBody(req);
        const who = NAME_RE.test(String(player || '')) ? player : 'WebPanel';
        try {
          const result = await builder.run({
            rcon: rcon(),
            player: who,
            description: String(description || ''),
            at: Number.isFinite(x) && Number.isFinite(z) ? { x, y, z } : undefined,
            notify: (msg) => log(`[web] ${msg}`),
          });
          broadcast(`${who} built "${result.name}" from the web panel`);
          return json(res, 200, result);
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }

      case 'POST /api/undo': {
        const { player } = await readBody(req);
        const who = NAME_RE.test(String(player || '')) ? player : 'WebPanel';
        try {
          const { name } = await builder.undo({ rcon: rcon(), player: who });
          return json(res, 200, { ok: true, name });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }

      default:
        return json(res, 404, { error: 'Unknown endpoint' });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      log(`${req.method} ${url.pathname} from ${clientAddress(req, trustedProxies)}`);
    }
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

      // Proxy BlueMap under our own origin. Serving it from a different origin
      // would work for *viewing*, but the browser then refuses to let us read
      // the iframe's position - and reading that is how "build where I'm
      // looking" knows where to build.
      if (url.pathname === '/map' || url.pathname.startsWith('/map/')) {
        if (!authed(req)) { res.writeHead(401); return res.end('Not logged in'); }
        const target = (env.MAP_INTERNAL_URL || 'http://mc:8100').replace(/\/$/, '');
        const rest = url.pathname === '/map' ? '/' : url.pathname.slice('/map'.length);
        return proxy(`${target}${rest}${url.search}`, req, res);
      }

      // Static files. Resolve then confirm the result is still inside
      // PUBLIC_DIR, so "../../etc/passwd" can't escape the directory.
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
      const data = await fs.promises.readFile(file).catch(() => null);
      if (!data) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(file);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // The shell must never be cached: a stale app.js survives a redeploy
        // and leaves people staring at a login screen that no longer applies.
        'Cache-Control': ['.html', '.js', '.css'].includes(ext)
          ? 'no-cache, must-revalidate' : 'public, max-age=3600',
      });
      return res.end(data);
    } catch (err) {
      log('web error:', err.message);
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.end();
    }
  });

  server.listen(port, () => {
    log(`web panel on :${port}${trustedHeader ? ` (auth via ${trustedHeader})` : ''}`);
  });
  return server;
}
