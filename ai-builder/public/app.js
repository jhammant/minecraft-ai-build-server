'use strict';

const $ = (s) => document.querySelector(s);
const api = async (path, body) => {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

// ---------- login ----------

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-err');
  err.hidden = true;
  try {
    await api('/api/login', { password: $('#pw').value });
    start();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

let started = false;
function start() {
  if (started) return;   // guard: start() can be reached from boot AND from login
  started = true;
  $('#boot').hidden = true;
  $('#login').hidden = true;
  $('#app').hidden = false;
  const saved = localStorage.getItem('mc-player');
  if (saved) $('#who').value = saved;
  refreshStatus();
  refreshMaps();
  refreshHistory();
  refreshWhitelist();
  refreshWorlds();
  setInterval(refreshStatus, 15000);
}

// Decide up front whether a login is needed at all. On a home network the
// server answers "already authenticated", so the form is never shown - it is
// hidden by default precisely so it can't flash up before we know.
api('/api/auth')
  .then((a) => {
    if (a.authenticated) return start();
    $('#boot').hidden = true;
    $('#login').hidden = false;
    if (!a.passwordSet) {
      const err = $('#login-err');
      err.textContent = 'No password is set on the server, and this device is not '
        + 'on the local network.';
      err.hidden = false;
    }
  })
  .catch(() => { $('#boot').hidden = true; $('#login').hidden = false; });

// ---------- tabs ----------

document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`);
    });
  });
});

// ---------- status ----------

async function refreshStatus() {
  try {
    const s = await api('/api/status');
    $('#dot').className = 'dot up';
    $('#status-text').textContent = s.busy
      ? 'building…'
      : `${s.online}/${s.max} online${s.players.length ? ' · ' + s.players.join(', ') : ''}`;
  } catch {
    $('#dot').className = 'dot down';
    $('#status-text').textContent = 'server unreachable';
  }
}

// ---------- maps ----------

// BlueMap serves one map per world/dimension. Switching is just a matter of
// pointing the iframe at that map's hash.
async function refreshMaps() {
  const sel = $('#map-pick');
  try {
    const { maps } = await api('/api/maps');
    if (!maps.length) { sel.innerHTML = '<option value="">still rendering…</option>'; return; }
    const current = sel.value;
    sel.innerHTML = maps.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    if (current && maps.includes(current)) sel.value = current;
  } catch {
    sel.innerHTML = '<option value="">unavailable</option>';
  }
}

$('#map-pick').addEventListener('change', () => {
  const m = $('#map-pick').value;
  if (m) $('#map').src = `/map/#${m}`;
});
$('#map-refresh').addEventListener('click', () => {
  refreshMaps();
  $('#map').contentWindow.location.reload();
});

// ---------- build ----------

// Scope to the examples block: `.chip` is a shared visual style, and the map
// Refresh button uses it too - an unscoped selector put "Refresh" in the prompt.
document.querySelectorAll('.examples .chip').forEach((c) => {
  c.addEventListener('click', () => { $('#desc').value = c.textContent.trim(); $('#desc').focus(); });
});

document.querySelectorAll('input[name=where]').forEach((r) => {
  r.addEventListener('change', () => {
    $('#coords').classList.toggle('show', $('input[name=where]:checked').value === 'coords');
  });
});

// BlueMap keeps the camera position in its URL hash, roughly
// #world:x:y:z:distance:... - so reading the hash of the same-origin iframe
// tells us where the player is looking without any BlueMap plugin API.
function mapCentre() {
  try {
    const hash = $('#map').contentWindow.location.hash || '';
    const parts = hash.replace(/^#/, '').split(':');
    const nums = parts.map(Number).filter((n) => Number.isFinite(n));
    // Deliberately NOT returning y: the hash carries the CAMERA height, which
    // is nothing to do with the ground. Sending it made builds appear at
    // bedrock level. Let the server find the surface at this x/z instead.
    if (nums.length >= 3) return { x: Math.round(nums[0]), z: Math.round(nums[2]) };
  } catch { /* map not loaded yet, or still rendering */ }
  return null;
}

function say(msg, kind) {
  const el = $('#result');
  el.hidden = false;
  el.className = `result ${kind || ''}`;
  el.innerHTML = msg;
}

$('#build-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = $('#go');
  const description = $('#desc').value.trim();
  const player = $('#who').value.trim();
  if (player) localStorage.setItem('mc-player', player);

  let at = {};
  if ($('input[name=where]:checked').value === 'coords') {
    const x = Number($('#cx').value);
    const z = Number($('#cz').value);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return say('Enter both X and Z.', 'bad');
    at = { x, z };
  } else {
    const c = mapCentre();
    if (!c) {
      return say('I can\'t read the map position yet — it may still be rendering. '
        + 'Switch to "These coordinates" and type an X and Z.', 'bad');
    }
    at = c;
  }

  go.disabled = true;
  say('Thinking… this usually takes about 30 seconds.', '');
  try {
    const r = await api('/api/build', { description, player, ...at });
    say(`<b>${r.name}</b> — ${r.summary || ''}<br>`
      + `${r.blocks.toLocaleString()} blocks · ${r.size.x}×${r.size.y}×${r.size.z} · `
      + `${r.seconds}s · at ${r.origin.x}, ${r.origin.y}, ${r.origin.z}`
      + (r.undoable ? '' : '<br><em>Undo is not available for this one.</em>'), 'ok');
    refreshHistory();
    $('#map').contentWindow.location.reload();
  } catch (ex) {
    say(ex.message, 'bad');
  } finally {
    go.disabled = false;
  }
});

// Prepare a site: natural terrain is rarely flat, and a castle dropped on a
// hillside half-buries itself.
async function prepare(mode) {
  let at = null;
  if ($('input[name=where]:checked').value === 'coords') {
    const x = Number($('#cx').value); const z = Number($('#cz').value);
    if (Number.isFinite(x) && Number.isFinite(z)) at = { x, z };
  } else {
    at = mapCentre();
  }
  if (!at) return say('Pick a spot first — move the map, or type coordinates.', 'bad');
  say(mode === 'flatten' ? 'Flattening the ground…' : 'Clearing the area…', '');
  try {
    const r = await api('/api/prepare', { x: at.x, z: at.z, size: 40, mode });
    say(`${mode === 'flatten' ? 'Flattened' : 'Cleared'} a ${r.size}×${r.size} area at `
      + `${r.x}, ${r.y}, ${r.z} — ${r.blocks.toLocaleString()} blocks changed.`
      + (r.undoable ? ' (undoable)' : ''), 'ok');
    $('#map').contentWindow.location.reload();
  } catch (ex) { say(ex.message, 'bad'); }
}
$('#flatten').addEventListener('click', () => prepare('flatten'));
$('#clear').addEventListener('click', () => prepare('clear'));

$('#undo').addEventListener('click', async () => {
  const player = $('#who').value.trim();
  try {
    const r = await api('/api/undo', { player });
    say(`Undid <b>${r.name}</b>.`, 'ok');
    refreshHistory();
  } catch (ex) {
    say(ex.message, 'bad');
  }
});

const ago = (ts) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

async function refreshHistory() {
  const ul = $('#history');
  try {
    const { builds } = await api('/api/history');
    ul.innerHTML = builds.length
      ? builds.map((b) => `<li><b>${esc(b.name)}</b>
          <span class="muted">${esc(b.player)} · ${b.blocks.toLocaleString()} blocks</span>
          <span class="when">${ago(b.at)}</span></li>`).join('')
      : '<li class="muted">nothing yet</li>';
  } catch { ul.innerHTML = '<li class="muted">could not load</li>'; }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- players ----------

$('#wl-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#wl-err');
  err.hidden = true;
  try {
    await api('/api/whitelist', {
      name: $('#wl-name').value.trim(),
      bedrock: $('#wl-bedrock').checked,
    });
    $('#wl-name').value = '';
    refreshWhitelist();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
});

async function refreshWhitelist() {
  const ul = $('#wl-list');
  try {
    const { players } = await api('/api/whitelist');
    ul.innerHTML = players.length
      ? players.map((p) => `<li>${esc(p)}<button title="Remove" data-name="${esc(p)}">✕</button></li>`).join('')
      : '<li class="muted">nobody yet — add someone above</li>';
    ul.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
      await api('/api/whitelist/remove', { name: b.dataset.name }).catch(() => {});
      refreshWhitelist();
    }));
  } catch { ul.innerHTML = '<li class="muted">could not load</li>'; }
}

// ---------- worlds ----------

$('#world-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/worlds', { name: $('#world-name').value.trim(), type: $('#world-type').value });
    $('#world-name').value = '';
    setTimeout(refreshWorlds, 2500); // world generation takes a moment
  } catch (ex) { alert(ex.message); }
});

async function refreshWorlds() {
  const ul = $('#worlds');
  try {
    const { worlds } = await api('/api/worlds');
    ul.innerHTML = worlds.length
      ? worlds.map((w) => `<li>${esc(w.name)}<span class="type">${esc(w.type)}</span></li>`).join('')
      : '<li class="muted">none found</li>';
  } catch { ul.innerHTML = '<li class="muted">could not load</li>'; }
}
