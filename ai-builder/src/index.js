import fs from 'node:fs';
import path from 'node:path';
import { Rcon, createRconLink } from './rcon.js';
import { forceloader } from './forceload.js';
import { describeBackend } from './llm.js';
import { createBuilder, ValidationError } from './build.js';
import { createRewards } from './rewards.js';
import { startWebServer } from './web.js';

const env = process.env;
const STATE_DIR = env.STATE_DIR || '/state';
const LOG_PATH = env.MC_LOG || '/data/logs/latest.log';

const LIMITS = {
  maxBlocks: Number(env.MAX_BLOCKS || 150000),
  maxExtent: Number(env.MAX_EXTENT || 96),
  maxOps: Number(env.MAX_OPS || 200),
  allowHazards: String(env.ALLOW_HAZARD_BLOCKS || 'false').toLowerCase() === 'true',
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

// --- chat parsing ------------------------------------------------------------

// Paper writes: [12:34:56 INFO]: <PlayerName> hello
// Two variations that will bite you if unhandled:
//   - since 1.19 an unsigned message is logged as "[Not Secure] <Name> hello",
//     which happens whenever chat signing is off or the client can't sign
//   - Bedrock players arriving via Floodgate carry a prefix, e.g. <.BedrockKid>
// The thread name before INFO also varies (Server thread / Async Chat Thread).
const CHAT_RE = /^\[[\d:]+(?: [^\]]*)? INFO\]:?\s*(?:\[Not Secure\]\s*)?<([A-Za-z0-9_.]{1,32})> (.+)$/;

function parseChat(line) {
  const m = line.match(CHAT_RE);
  return m ? { player: m[1], text: m[2].trim() } : null;
}

// --- state -------------------------------------------------------------------

const statePath = (n) => path.join(STATE_DIR, n);

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath('state.json'), 'utf8'));
  } catch {
    return { builds: {}, lastBuild: {}, history: [] };
  }
}

function saveState(s) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(statePath('state.json'), JSON.stringify(s, null, 2));
  } catch (e) {
    log('could not persist state:', e.message);
  }
}

const state = loadState();
state.history ||= [];

// Off unless REWARDS_MODE says otherwise, in which case the AI builder has to
// be earned rather than simply asked for.
const rewards = createRewards({ env, state, saveState, log });

const builder = createBuilder({ env, limits: LIMITS, state, saveState, log, rewards });

// --- talking to players ------------------------------------------------------

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

// Chat lines are capped well under the RCON request limit (see rcon.js): an
// over-long error message would otherwise be refused, and the player told
// nothing at all.
const chatText = (s) => esc(String(s).slice(0, 400));

async function tell(rcon, player, text, colour = 'aqua') {
  await rcon.send(`tellraw ${player} {"text":"${chatText(text)}","color":"${colour}"}`)
    .catch((e) => log('tellraw failed:', e.message));
}

async function broadcast(rcon, text, colour = 'dark_aqua') {
  await rcon.send(`tellraw @a {"text":"${chatText(text)}","color":"${colour}"}`)
    .catch((e) => log('broadcast failed:', e.message));
}

// --- chat commands -----------------------------------------------------------

const COLOUR = { info: 'aqua', progress: 'green', error: 'red' };

async function handleBuild(rcon, player, description) {
  try {
    const r = await builder.run({
      rcon, player, description,
      notify: (msg, kind) => tell(rcon, player, msg, COLOUR[kind] || 'aqua'),
    });
    await tell(rcon, player, r.summary || `Done: ${r.name}`, 'green');
    await tell(rcon, player, r.undoable
      ? `Built in ${r.seconds}s. Don't like it? Type !undo`
      : `Built in ${r.seconds}s. (Undo isn't available for this one.)`, 'gray');
    if (r.price) {
      await tell(rcon, player,
        `That ${r.band} build cost ${r.price} credits - you have ${r.wallet.credits} left.`,
        'gray');
    }
    await broadcast(rcon, `${player} built "${r.name}" with the AI builder`);
  } catch (err) {
    log('build failed:', err.stack || err.message);
    await tell(rcon, player, err instanceof ValidationError
      ? `I couldn't build that safely: ${err.message}`
      : err.message, 'red');
    await tell(rcon, player, 'Try describing it a bit differently!', 'gray');
  }
}

async function handleUndo(rcon, player) {
  try {
    await tell(rcon, player, 'Undoing...', 'aqua');
    const { name } = await builder.undo({ rcon, player });
    await tell(rcon, player, `Undid "${name}".`, 'green');
  } catch (err) {
    await tell(rcon, player, err.message, 'red');
  }
}

// What you've earned, what it buys, and what earns more of it.
async function handleCredits(rcon, player) {
  if (!rewards.enabled()) {
    return tell(rcon, player, 'Builds are free on this server - just type !build', 'gray');
  }
  const s = rewards.summary(player);
  const cfg = rewards.config();
  if (s.exempt) return tell(rcon, player, 'You build for free on this server.', 'gray');

  await tell(rcon, player, '--- Your building record ---', 'gold');
  if (cfg.useCredits) {
    await tell(rcon, player, `${s.credits} credits`, 'green');
    await tell(rcon, player,
      `A small build costs ${s.prices.small}, a medium one ${s.prices.medium}, `
      + `a big one ${s.prices.large}.`, 'white');
  }
  if (cfg.useRanks) {
    await tell(rcon, player, `Rank: ${s.rank.name} (${s.rank.index + 1} of 4)`, 'aqua');
    await tell(rcon, player, s.rank.next
      ? `${Math.max(0, s.rank.next.at - s.lifetime)} more to ${s.rank.next.name}, `
        + 'which lets me build you something bigger.'
      : 'Top rank - nothing I build for you is too big now.', 'white');
  }
  const how = {
    placed: 'Every block you place yourself earns 1 credit.',
    mixed: 'Placing blocks, mining, crafting and exploring all earn credits.',
    granted: 'Credits are handed out by a grown-up, not earned in game.',
  }[cfg.earn];
  await tell(rcon, player, how, 'gray');
}

async function handleHelp(rcon, player) {
  const lines = [
    ['--- AI Builder ---', 'gold'],
    ['!build <what you want>  - e.g. !build a pirate ship', 'white'],
    ['!undo                   - remove the last thing I built', 'white'],
    ...(rewards.enabled()
      ? [['!credits                - what you have earned, and what it buys', 'white']]
      : []),
    ['!help                   - this message', 'white'],
    ['Tip: say what it is made of, how big, and what is inside!', 'gray'],
  ];
  for (const [t, c] of lines) await tell(rcon, player, t, c);
}

async function dispatch(rcon, player, text) {
  if (!text.startsWith('!')) return;
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd.toLowerCase()) {
    case 'build': return handleBuild(rcon, player, arg);
    case 'undo': return handleUndo(rcon, player);
    case 'credits':
    case 'points':
    case 'rank': return handleCredits(rcon, player);
    case 'help':
    case 'ai': return handleHelp(rcon, player);
    default: return;
  }
}

// --- log tailing -------------------------------------------------------------

// Follow latest.log. The server truncates/recreates it on restart and rotates it
// daily, so watch for the file shrinking or its inode changing and reopen.
function tailLog(filePath, onLine) {
  let position = 0;
  let inode = null;
  let carry = '';

  try {
    const st = fs.statSync(filePath);
    position = st.size; // start at the end so a restart doesn't replay old chat
    inode = st.ino;
  } catch { /* file appears later */ }

  return setInterval(() => {
    let st;
    try { st = fs.statSync(filePath); } catch { return; }
    if (inode !== null && (st.ino !== inode || st.size < position)) {
      log('log rotated, reopening');
      position = 0;
      carry = '';
    }
    inode = st.ino;
    if (st.size === position) return;

    const fd = fs.openSync(filePath, 'r');
    try {
      const len = st.size - position;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, position);
      position = st.size;
      const lines = (carry + buf.toString('utf8')).split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) onLine(line.trimEnd());
    } finally {
      fs.closeSync(fd);
    }
  }, 500);
}

// --- main --------------------------------------------------------------------

async function main() {
  log('AI builder starting');
  let backend;
  try { backend = describeBackend(env); } catch (e) { backend = `UNCONFIGURED (${e.message})`; }
  log(`LLM backend: ${backend}`);
  log(`limits: ${LIMITS.maxBlocks} blocks, ${LIMITS.maxExtent} max extent`);

  // One self-healing link for the whole process. Every caller - chat, the
  // panel, a build in flight, the rewards sweep - sends through it, so a
  // reconnect is seen by all of them at once instead of only by whoever
  // happened to notice the drop.
  const rcon = createRconLink({
    open: () => new Rcon({
      host: env.RCON_HOST || 'mc',
      port: Number(env.RCON_PORT || 25575),
      password: env.RCON_PASSWORD,
      onClose: (err) => log(`RCON connection lost: ${err.message}`),
    }).connect(),
    log,
  });
  await rcon.ensure(Infinity);

  // Keepalive: notices a dead connection between builds (the link reconnects
  // on the spot), and retries any chunk release that failed while it was down.
  setInterval(async () => {
    try {
      await rcon.send('list');
      await forceloader.flush(rcon);
    } catch (e) {
      log(`RCON keepalive failed: ${e.message}`);
    }
  }, 30000);

  // Earning happens on a timer rather than on an event, because there is no
  // event to hook: the effort we pay for is recorded in the server's own
  // statistics files, which we diff against the last reading.
  if (rewards.enabled()) {
    const cfg = rewards.config();
    log(`rewards: ${cfg.mode}, earned from ${cfg.earn}, `
      + `every ${cfg.pollSec}s${cfg.exempt.length ? `, exempt: ${cfg.exempt.join(', ')}` : ''}`);
    setInterval(async () => {
      try {
        for (const { player, rank } of await rewards.poll(rcon)) {
          await broadcast(rcon, `${player} is now a ${rank}!`, 'gold');
          await tell(rcon, player, `You've been promoted to ${rank} - `
            + 'I can build you bigger things now.', 'gold');
        }
      } catch (e) { log('rewards poll failed:', e.message); }
    }, Math.max(5, cfg.pollSec) * 1000);
  }

  tailLog(LOG_PATH, (line) => {
    const chat = parseChat(line);
    if (!chat || !chat.text.startsWith('!')) return;
    log(`<${chat.player}> ${chat.text}`);
    dispatch(rcon, chat.player, chat.text).catch((e) => log('dispatch error:', e.message));
  });
  log(`watching ${LOG_PATH}`);

  startWebServer({
    env, state, saveState, builder, rewards, log,
    getRcon: () => rcon,
    broadcast: (msg) => broadcast(rcon, msg),
  });
}

main().catch((err) => {
  log('fatal:', err.stack || err.message);
  process.exit(1);
});
