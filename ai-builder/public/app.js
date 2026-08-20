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
  say('Thinking… working out what to build.', '');
  const stop = trackProgress();
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
    stop();
    go.disabled = false;
  }
});

// A build can take four minutes. One "Thinking…" and then silence for that long
// reads as a hang - so ask the server what it is doing and show it.
const PHASES = {
  thinking: 'Designing the build',
  snapshot: 'Saving the area so you can undo',
  clearing: 'Clearing trees off the site',
  placing: 'Placing blocks',
};
function trackProgress() {
  const t0 = Date.now();
  const tick = async () => {
    let p = null;
    try { p = (await api('/api/status')).progress; } catch { /* keep the last message */ }
    const secs = Math.round((Date.now() - t0) / 1000);
    if (!p) return say(`Working… ${secs}s`, '');
    const label = `${PHASES[p.phase] || p.phase}${p.detail ? ` — ${esc(p.detail)}` : ''}`;
    const pct = p.total ? Math.round((p.done / p.total) * 100) : null;
    say(`${label}<br><span class="muted">${secs}s`
      + (pct === null ? '' : ` · ${p.done.toLocaleString()} of ${p.total.toLocaleString()} fills`)
      + '</span>'
      + (pct === null
        ? '<div class="bar indeterminate"><i></i></div>'
        : `<div class="bar"><i style="width:${pct}%"></i></div>`), '');
  };
  tick();
  const id = setInterval(tick, 1500);
  return () => clearInterval(id);
}

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

// A name and a block count tell you something got built, but not WHAT. Each row
// opens to show what was actually asked for and what came back.
function detailHtml(b) {
  const row = (k, v) => (v ? `<div><span>${k}</span><span>${v}</span></div>` : '');
  const s = b.size ? `${b.size.x}×${b.size.y}×${b.size.z}` : '';
  return `<div class="detail">
    ${b.shot ? `<img class="shot" data-src="/shots/${esc(b.shot)}" alt="${esc(b.name)}">` : ''}
    ${b.summary ? `<p class="summary">${esc(b.summary)}</p>` : ''}
    ${b.description ? `<p class="asked">“${esc(b.description)}”</p>` : ''}
    <div class="facts">
      ${row('Blocks', b.blocks.toLocaleString())}
      ${row('Size', s)}
      ${row('Shapes', b.ops ? `${b.ops} ops → ${(b.commands || 0).toLocaleString()} fills` : '')}
      ${row('Took', b.seconds ? `${b.seconds}s` : '')}
      ${row('Cost', b.cost ? `${(b.cost * 100).toFixed(1)}p` : '')}
      ${row('Where', b.origin ? `${b.origin.x}, ${b.origin.y}, ${b.origin.z}` : '')}
      ${row('Built by', esc(b.player || ''))}
      ${row('Model', esc(b.model || ''))}
    </div>
    ${(b.materials || []).length
      ? `<div class="mats">${b.materials.map((m) => `<span class="mat">${esc(m.replace(/_/g, ' '))}</span>`).join('')}</div>`
      : ''}
    ${b.origin ? `<div class="detail-actions">
      <button class="link go-there" data-x="${b.origin.x}" data-y="${b.origin.y}" data-z="${b.origin.z}">Show me on the map</button>
      <button class="link tp-there" data-x="${b.origin.x}" data-y="${b.origin.y}" data-z="${b.origin.z}">Teleport me there</button>
    </div>` : ''}
  </div>`;
}

async function refreshHistory() {
  const ul = $('#history');
  try {
    const { builds } = await api('/api/history');
    // Keep whatever the user had open across a refresh.
    const open = new Set([...ul.querySelectorAll('li.open')].map((li) => li.dataset.at));
    ul.innerHTML = builds.length
      ? builds.map((b) => `<li class="row${open.has(String(b.at)) ? ' open' : ''}" data-at="${b.at}">
          <button class="head" type="button">
            <b>${esc(b.name)}</b>
            <span class="muted">${esc(b.player)} · ${b.blocks.toLocaleString()} blocks</span>
            <span class="when">${ago(b.at)}</span>
          </button>
          ${detailHtml(b)}
        </li>`).join('')
      : '<li class="muted">nothing yet</li>';
  } catch { ul.innerHTML = '<li class="muted">could not load</li>'; }
}

$('#history').addEventListener('click', (e) => {
  const jump = e.target.closest('.go-there');
  if (jump) {
    const { x, y, z } = jump.dataset;
    // Actually fly the map there. Filling in the coordinate boxes was not
    // "showing me on the map" - nothing visibly moved, so the button looked
    // broken. BlueMap reads its camera straight out of the URL hash.
    const map = $('#map-pick').value || 'world';
    const frame = $('#map');
    try {
      frame.contentWindow.location.hash =
        `#${map}:${x}:${y || 100}:${z}:220:0:0.55:0:0:perspective`;
    } catch {
      frame.src = `/map/#${map}:${x}:${y || 100}:${z}:220:0:0.55:0:0:perspective`;
    }
    // Point the next build at the same spot, so "show me" and "build here" agree.
    $('input[name=where][value=coords]').checked = true;
    $('#cx').value = x; $('#cz').value = z;
    // Scroll the CARD, not the iframe: scrollIntoView on an iframe scrolls the
    // document inside it, which moves nothing the user can see.
    // Plain scrollIntoView, not smooth: smooth is a no-op under some browser
    // settings, and a button that silently does nothing is the bug being fixed.
    (frame.closest('.card') || frame).scrollIntoView({ block: 'start' });
    return;
  }
  const tp = e.target.closest('.tp-there');
  if (tp) {
    const name = ($('#who').value || localStorage.getItem('mc-player') || '').trim();
    const note = tp.parentElement;
    const say2 = (msg) => {
      let n = note.querySelector('.tp-msg');
      if (!n) { n = document.createElement('span'); n.className = 'tp-msg muted'; note.appendChild(n); }
      n.textContent = msg;
    };
    if (!name) return say2('Put your Minecraft name in "Build as" first.');
    say2('Sending you…');
    api('/api/teleport', { name, x: tp.dataset.x, y: tp.dataset.y, z: tp.dataset.z })
      .then((r) => say2(r.message))
      .catch((ex) => say2(ex.message));
    return;
  }

  const head = e.target.closest('.head');
  if (!head) return;
  const li = head.closest('li');
  li.classList.toggle('open');
  // Fetch the picture when the row opens. `loading="lazy"` never fires for an
  // image inside a display:none block, so the src is withheld until it is
  // actually on screen - which also saves 40 requests for rows nobody opens.
  const img = li.querySelector('img.shot[data-src]');
  if (li.classList.contains('open') && img) {
    img.src = img.dataset.src;
    img.removeAttribute('data-src');
  }
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Small world controls. These are the buttons a child reaches for before they
// ever type a prompt, so they live next to the build form rather than buried.
document.querySelector('.world-ctl').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-time], button[data-weather]');
  if (!btn) return;
  const was = btn.textContent;
  btn.disabled = true;
  try {
    const r = btn.dataset.time
      ? await api('/api/time', { value: btn.dataset.time })
      : await api('/api/weather', { value: btn.dataset.weather });
    say(r.message, 'ok');
  } catch (ex) {
    say(ex.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
});

// ---------- players ----------

// Silence is the worst possible response to pressing a button: a success used
// to show nothing at all, and an empty field only triggered a browser tooltip -
// both of which read as "it didn't work".
$('#wl-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#wl-err');
  const btn = $('#wl-form').querySelector('button[type=submit]');
  const name = $('#wl-name').value.trim();
  const say = (msg, bad) => {
    err.textContent = msg;
    err.hidden = false;
    err.style.color = bad ? 'var(--danger)' : 'var(--accent)';
  };
  err.hidden = true;
  if (!name) return say('Type their Minecraft username first.', true);

  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = 'Adding…';
  try {
    const r = await api('/api/whitelist', { name, bedrock: $('#wl-bedrock').checked });
    $('#wl-name').value = '';
    say(r.message || `${name} can now join.`, false);
    refreshWhitelist();
  } catch (ex) {
    say(ex.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
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

$('#worlds').addEventListener('change', async (e) => {
  const sel = e.target.closest('select.mode');
  if (!sel || !sel.value) return;
  const { world } = sel.dataset;
  sel.disabled = true;
  try {
    const r = await api('/api/worlds/mode', { name: world, mode: sel.value });
    alert(r.message);
  } catch (ex) { alert(ex.message); } finally { sel.disabled = false; sel.value = ''; }
});

async function refreshWorlds() {
  const ul = $('#worlds');
  try {
    const { worlds } = await api('/api/worlds');
    ul.innerHTML = worlds.length
      ? worlds.map((w) => `<li>${esc(w.name)}
          <span class="type">${esc(w.type)}</span>
          <select class="mode" data-world="${esc(w.name)}" title="Game mode for this world">
            <option value="">mode…</option>
            <option value="survival">survival</option>
            <option value="creative">creative</option>
            <option value="adventure">adventure</option>
            <option value="spectator">spectator</option>
          </select></li>`).join('')
      : '<li class="muted">none found</li>';
  } catch { ul.innerHTML = '<li class="muted">could not load</li>'; }
}
