import { api, money, el } from './api.js';
import { RIDES, STALLS, SCENERY, STAFF, SPECIAL, PANDEMONIUM, CRIME, OBJECTIVES, PATH_COST, GRID, itemDef, itemCategory } from './gen/shared/catalog.js';
import * as Sim from './gen/shared/sim.js';
import { SimClient } from './gen/client/simclient.js';
import { Renderer } from './render.js';
import { Renderer3D, webglAvailable } from './render3d.js';
import { PIECES, MAX_STEPS, METERS, STEP as HEIGHT_STEP } from './gen/shared/coaster.js';
import { SETTINGS_SCHEMA, DIFFICULTIES, defaultSettings, CLIMATES, WEATHER, GUEST_TYPES, STAFF_TRAITS, PATH_STYLES, PAINT } from './gen/shared/options.js';

const AUTOSAVE_MS = 45_000;

// The simulation runs in a Web Worker. `state.park` is a read-only mirror of
// it, replaced by every snapshot; changes go through act(), which resolves
// once the worker has applied them.
const sim = new SimClient(new URL('./gen/client/sim.worker.js', import.meta.url));

/** Sends a player action to the worker. Resolves with its result; errors become warnings. */
function act(method, ...args) {
  state.dirty = true;
  return sim.act(method, ...args).catch((err) => {
    toast(err.message, 'warn');
    return { ok: false, reason: err.message };
  });
}

const $ = (id) => document.getElementById(id);
const canvas = $('view');
// Prefer the WebGL 3D renderer; fall back to the 2D canvas one.
let renderer;
try {
  renderer = webglAvailable() ? new Renderer3D(canvas) : new Renderer(canvas);
} catch (err) {
  console.warn('3D renderer unavailable, using 2D:', err);
  renderer = new Renderer(canvas);
}
const is3D = renderer instanceof Renderer3D;

const state = {
  park: null,
  me: null,
  speed: 1,
  tool: 'inspect',
  builder: null, // { id, hoverPiece, hoverOk, lastTest }
  coasterDir: 0,
  pathStyle: 0,
  importCode: null, // design code waiting to be placed
  shareCode: null, // { id, code } shown in a ride panel
  buildKind: null,
  palette: null,
  panel: null, // { type, id }
  selected: null,
  hover: null,
  dirty: false,
  lastSave: 0,
  saving: false,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    state.me = await api('/api/me');
  } catch {
    location.href = '/';
    return;
  }
  $('me-name').textContent = state.me.displayName;
  if (state.me.avatarUrl) Object.assign($('me-avatar'), { src: state.me.avatarUrl, hidden: false });

  sim.onSnapshot = (park, simulated) => {
    state.park = park;
    if (simulated > 0) state.dirty = true;
  };
  sim.onAction = () => { refreshPanel(); if (state.palette) renderPalette(); };
  try {
    await sim.load(await api('/api/park'));
  } catch (err) {
    if (err.status !== 404) toast(`Could not load your park (${err.message}). Starting fresh.`, 'warn');
    await sim.newPark(`${state.me.displayName.split(' ')[0]}'s Park`, randomSeed());
    openSetup({ fresh: true });
  }
  state.lastSave = Date.now();

  bindInput();
  setSpeed(1);
  setTool('inspect');
  requestAnimationFrame(frame);
  setInterval(() => state.dirty && save(), AUTOSAVE_MS);
  document.addEventListener('visibilitychange', () => document.hidden && state.dirty && save({ keepalive: true }));
}

// ---------------------------------------------------------------------------
// Game loop
// ---------------------------------------------------------------------------

let last = performance.now();
let hudT = 0;
let animT = 0;

function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  const { park } = state;
  if (!park) { requestAnimationFrame(frame); return; }

  if (state.speed > 0) animT += dt * Math.min(state.speed, 2);
  for (const ev of sim.drainEvents()) toast(ev.text, ev.type);
  park._fx = sim.drainFx();

  renderer.render(park, {
    time: animT,
    hover: state.hover,
    ghost: ghostFor(state.hover),
    tool: state.tool,
    selected: state.selected,
    dayProgress: Sim.dayProgress(park),
    builder: state.builder,
    coasterDir: state.coasterDir,
    coasterStartOk: state.hover && state.tool === 'coaster-start' ? Sim.objectAt(park, state.hover.x, state.hover.y) === null && park.tiles[Sim.idx(state.hover.x, state.hover.y)] === Sim.TILE.GRASS : false,
  }, dt);

  hudT -= dt;
  if (hudT <= 0) {
    hudT = 0.25;
    updateHud();
    refreshPanel();
  }
  requestAnimationFrame(frame);
}

function ghostFor(hover) {
  if (!hover || state.tool !== 'build') return null;
  const def = itemDef(state.buildKind);
  const { x, y } = anchorFor(def, hover);
  return { x, y, w: def.w, hgt: def.h, ok: Sim.canPlace(state.park, state.buildKind, x, y).ok };
}

const anchorFor = (def, tile) => ({ x: tile.x - Math.floor((def.w - 1) / 2), y: tile.y - Math.floor((def.h - 1) / 2) });

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function updateHud() {
  const { park } = state;
  const s = Sim.parkStats(park);
  $('park-name').textContent = park.name;
  $('s-cash').textContent = money(park.cash);
  $('s-cash').parentElement.classList.toggle('negative', park.cash < 0);
  $('s-guests').textContent = s.guests;
  $('s-rating').textContent = s.rating;
  $('s-rating-bar').style.width = `${(s.rating / 999) * 100}%`;
  $('s-safety').textContent = s.safety;
  $('s-safety-bar').style.width = `${s.safety}%`;
  $('s-safety-bar').style.background = s.safety > 70 ? '#51cf66' : s.safety > 40 ? '#ffd23f' : '#ff6b6b';
  $('s-day').textContent = Sim.day(park);
  const W = Sim.weatherOf(park);
  $('s-weather').textContent = `${W.icon} ${W.label}`;
  $('s-day-bar').style.width = `${Sim.dayProgress(park) * 100}%`;

  const feed = $('thoughts');
  const pandas = park.raid ? Sim.activePandas(park).filter((g) => g.state !== 'downed').length : 0;
  updateCustody();
  $('lock-btn').hidden = !park.fence;
  $('lock-btn').textContent = park.locked ? '🔒 Locked' : '🔓 Exits open';
  $('lock-btn').classList.toggle('locked', park.locked);
  $('raid-banner').hidden = !park.raid;
  if (park.raid) $('raid-banner').textContent = `🐼 PANDEMONIUM RAID: ${pandas} at large · $${Math.round(park.raid.loot).toLocaleString()} stolen · ${park.raid.captured} captured`;
  const key = park.thoughts.slice(0, 4).map((t) => t.text + t.who).join('|');
  if (feed.dataset.key !== key) {
    feed.dataset.key = key;
    feed.replaceChildren(...park.thoughts.slice(0, 4).map((t) => el('div', {}, el('b', {}, t.who), `“${t.text}”`)));
  }

  if (state.lastSave) {
    const ago = Math.round((Date.now() - state.lastSave) / 1000);
    $('save-status').textContent = state.saving ? 'Saving…' : state.dirty ? `Saved ${ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`} ago` : 'All changes saved';
  }
}

function toast(text, type = 'info') {
  const t = el('div', { class: `toast ${type}` }, text);
  $('toasts').append(t);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  setTimeout(() => t.remove(), 3500);
}

let lastErr = 0;
function buildError(res) {
  if (res.silent) return;
  if (Date.now() - lastErr < 800) return;
  lastErr = Date.now();
  toast(res.reason, 'warn');
}

// ---------------------------------------------------------------------------
// Tools & palette
// ---------------------------------------------------------------------------

function setTool(tool, kind = null) {
  state.tool = tool;
  state.buildKind = kind;
  for (const b of document.querySelectorAll('#toolbar button')) {
    const active = b.dataset.tool === tool || (tool === 'build' && b.dataset.palette === itemCategory(kind)) || b.dataset.palette === state.palette;
    b.classList.toggle('active', active);
  }
  canvas.style.cursor = tool === 'inspect' ? 'pointer' : 'crosshair';
  renderPalette();
}

function togglePalette(cat) {
  state.palette = state.palette === cat ? null : cat;
  if (!state.palette && state.tool === 'build') setTool('inspect');
  else setTool(state.tool, state.buildKind);
}

function renderPalette() {
  const box = $('palette');
  if (!state.palette) { box.hidden = true; return; }
  box.hidden = false;
  if (state.palette === 'path') {
    box.replaceChildren(...PATH_STYLES.map((st, i) => el('button', {
      class: `item${state.pathStyle === i ? ' active' : ''}`,
      onclick: () => { state.pathStyle = i; renderPalette(); },
    }, el('div', { class: 'name' }, el('span', { class: 'swatch', style: { background: `#${st.color.toString(16).padStart(6, '0')}` } }), st.label),
    el('div', { class: 'meta' }, `${money(PATH_COST)} per tile · drag over paths to repaint ($2)`))));
    return;
  }
  const security = {
    securityhq: SPECIAL.securityhq,
    ...(state.park.settings.executions ? { retribution: SPECIAL.retribution } : {}),
    camera: SCENERY.camera, lamp: SCENERY.lamp, firstaid: STALLS.firstaid,
  };
  const items = { ride: RIDES, stall: STALLS, scenery: SCENERY, security }[state.palette];
  const designer = state.palette === 'ride' && el('button', {
    class: `item designer${state.tool === 'coaster-start' ? ' active' : ''}`,
    onclick: () => { setTool('coaster-start'); toast('Click a grass tile to place the station. Press X to turn it.'); },
  }, el('div', { class: 'name' }, '🛠️ Design your own coaster'), el('div', { class: 'meta' }, 'Lay track piece by piece · real physics'));
  const importer = state.palette === 'ride' && el('button', {
    class: 'item designer',
    onclick: () => { const code = prompt('Paste a coaster design code (starts with RCM1:)'); if (code) startImport(code); },
  }, el('div', { class: 'name' }, '📥 Import a design code'), el('div', { class: 'meta' }, 'Build a coaster someone shared with you'));
  const saved = state.palette === 'ride' ? loadDesigns().map((d) => el('button', {
    class: 'item', onclick: () => startImport(d.code),
  }, el('div', { class: 'name' }, `📐 ${d.name}`), el('div', { class: 'meta' }, `Saved design · ${money(Sim.parseDesign(d.code).design?.cost || 0)}`))) : [];
  box.replaceChildren(...[designer, importer].filter(Boolean), ...saved, ...Object.entries(items).map(([kind, def]) => {
    let meta;
    if (kind === 'securityhq') meta = `${money(def.cost)} · unlocks the Hot Dog Squad`;
    else if (kind === 'retribution') meta = `${money(def.cost)} · ${def.w}×${def.h} · public executions`;
    else if (state.palette === 'ride') meta = `${money(def.cost)} · ${def.w}×${def.h} · Thrill ${def.excitement}/10 · Intensity ${def.intensity}/10`;
    else if (state.palette === 'stall') meta = `${money(def.cost)} · ${def.sells === 'restroom' ? 'free for guests' : def.sells === 'firstaid' ? 'treats injured guests' : `sells ${def.sells}`}`;
    else meta = `${money(def.cost)}${def.camera ? ' · deters & identifies criminals' : def.lamp ? ' · lights paths at dusk' : def.beauty ? ` · beauty +${def.beauty}` : def.seat ? ' · guests rest here' : def.bin ? ' · stops litter' : ''}`;
    return el('button', {
      class: `item${state.buildKind === kind ? ' active' : ''}${state.park.cash < def.cost ? ' unaffordable' : ''}`,
      onclick: () => setTool('build', kind),
    },
    el('div', { class: 'name' },
      kind === 'securityhq' ? '🚔 ' : kind === 'retribution' ? '⚖️ ' : def.icon ? `${def.icon} ` : el('span', { class: 'swatch', style: { background: def.color || '#5a9a4a' } }),
      def.name),
    el('div', { class: 'meta' }, meta));
  }));
}

function applyTool(tile, { drag = false } = {}) {
  const { park } = state;
  if (!Sim.inBounds(tile.x, tile.y)) return;
  if (state.tool === 'path') {
    act('buildPath', tile.x, tile.y, state.pathStyle).then((res) => {
      if (res.ok) renderer.floatText(tile.x + 0.5, tile.y + 0.5, `-$${res.repainted ? 2 : PATH_COST}`, '#ffd9d9');
      else buildError(res);
    });
  } else if (state.tool === 'bulldoze') {
    act('bulldoze', tile.x, tile.y).then((res) => {
      if (res.ok) {
        if (res.refund) renderer.floatText(tile.x + 0.5, tile.y + 0.5, `+${money(res.refund)}`, '#c8ffc8');
        if (state.selected && !Sim.getObject(state.park, state.selected)) closePanel();
      } else if (!drag) buildError(res);
    });
  } else if (state.tool === 'build') {
    const def = itemDef(state.buildKind);
    if (drag && (def.w > 1 || def.h > 1 || itemCategory(state.buildKind) !== 'scenery')) return;
    const { x, y } = anchorFor(def, tile);
    act('build', state.buildKind, x, y).then((res) => {
      if (res.ok) {
        renderer.floatText(x + def.w / 2, y + def.h / 2, `-${money(def.cost)}`, '#ffd9d9');
        if (res.warn) toast(res.warn);
        renderPalette();
      } else if (!drag) buildError(res);
    });
  } else if (state.tool === 'coaster-start') {
    if (drag) return;
    if (state.importCode) {
      act('importDesign', tile.x, tile.y, state.coasterDir, state.importCode).then((res) => {
        if (!res.ok) { toast(res.reason, 'warn'); return; }
        state.importCode = null;
        state.palette = null;
        setTool('inspect');
        toast(`${res.obj.name} built from its design code. Test it, then open it.`);
        openBuilder(res.obj.id);
      });
      return;
    }
    act('startCoaster', tile.x, tile.y, state.coasterDir).then((res) => {
      if (!res.ok) { buildError(res); return; }
      renderer.floatText(tile.x + 0.5, tile.y + 0.5, `-${money(PIECES.station.cost)}`, '#ffd9d9');
      state.palette = null;
      setTool('inspect');
      openBuilder(res.obj.id);
    });
  } else if (state.tool === 'inspect') {
    inspect(tile);
    return;
  }
  state.dirty = true;
}

function openBuilder(id) {
  state.builder = { id, hoverPiece: null, hoverOk: false, lastTest: null };
  showPanel({ type: 'builder', id });
}

function inspect(tile) {
  const { park } = state;
  const ft = renderer.screenToTile(pointer.x, pointer.y);
  const guest = Sim.guestAt(park, ft.x, ft.y) || park.staff.find((s) => {
    const p = Sim.actorPos(s);
    return (p.x - ft.x) ** 2 + (p.y - ft.y) ** 2 < 0.2;
  });
  if (guest) {
    showPanel({ type: guest.role ? 'staff' : 'guest', id: guest.id });
    return;
  }
  const picked = is3D ? Sim.getObject(park, renderer.pickObject(pointer.x, pointer.y)) : null;
  const obj = picked && itemCategory(picked.kind) !== 'scenery' ? picked : Sim.objectAt(park, tile.x, tile.y);
  if (obj?.kind === 'custom' && obj.building) openBuilder(obj.id);
  else if (obj && itemCategory(obj.kind) === 'special') showPanel({ type: obj.kind, id: obj.id });
  else if (obj && itemCategory(obj.kind) !== 'scenery') showPanel({ type: 'object', id: obj.id });
  else if (obj) showPanel({ type: 'scenery', id: obj.id });
  else closePanel();
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function showPanel(panel) {
  state.panel = panel;
  state.selected = ['object', 'scenery', 'guest', 'staff', 'securityhq', 'retribution', 'memorial', 'builder'].includes(panel.type) ? panel.id : null;
  if (panel.type !== 'builder') state.builder = null;
  $('panel').hidden = false;
  refreshPanel(true);
}

function closePanel() {
  state.builder = null;
  state.panel = null;
  state.selected = null;
  $('panel').hidden = true;
}

let panelKey = '';
function refreshPanel(force = false) {
  const p = state.panel;
  if (!p) return;
  // Don't rebuild while the user is typing into an input inside the panel.
  if (!force && $('panel').contains(document.activeElement) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  const body = PANELS[p.type]?.(p);
  if (body === null) { closePanel(); return; }
  const key = body.outerHTML;
  if (!force && key === panelKey) return;
  panelKey = key;
  $('panel-body').replaceChildren(body);
}

const kv = (rows) => el('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
const bar = (value, color) => el('div', { class: 'bar' }, el('span', { style: { width: `${Math.round(value)}%`, background: color } }));
const stepper = (value, onDown, onUp) => el('div', { class: 'stepper' },
  el('button', { class: 'btn btn-small', onclick: onDown, 'aria-label': 'Decrease' }, '−'),
  el('span', { class: 'value' }, value),
  el('button', { class: 'btn btn-small', onclick: onUp, 'aria-label': 'Increase' }, '+'));

const FREE = new Set(['restroom', 'firstaid']);
const CRIME_ICON = { theft: '👛', assault: '🤕', heist: '💰', homicide: '🩸', arrest: '🚓', raid: '🐼', execution: '⚖️' };

async function hireStaff(role) {
  const res = await act('hire', role);
  if (!res.ok) { toast(res.reason, 'warn'); return; }
  state.dirty = true;
  const traits = res.staff.traits.map((t) => `${STAFF_TRAITS[t].icon} ${STAFF_TRAITS[t].label}`).join(', ');
  toast(`Hired ${res.staff.name}${traits ? ` (${traits})` : ''}.`);
  refreshPanel(true);
}

function recordView(r, loot = 0) {
  return el('div', {},
    el('h3', {}, 'Criminal record'),
    kv([
      ['Thefts', r.theft],
      ['Assaults', r.assault],
      ['Robberies', r.robbery],
      ['Drug deals', r.drugs],
      ['Killings', r.homicide],
      ['Total stolen', money(r.stolen)],
      loot > 0 && ['Loot on them', money(loot)],
    ]));
}

// ---------------------------------------------------------------------------
// Custody: sentencing prompt
// ---------------------------------------------------------------------------

let custodySeen = 0;
let custodyKey = '';
function updateCustody() {
  const { park } = state;
  const n = park.custody.length;
  $('custody-btn').hidden = n === 0;
  $('custody-btn').textContent = `⚖️ ${n} in custody`;
  if (n > custodySeen && $('custody-modal').hidden) $('custody-modal').hidden = false;
  custodySeen = n;
  if (!n) { $('custody-modal').hidden = true; return; }
  if ($('custody-modal').hidden) return;
  const c = park.custody[0];
  const rig = park.settings.executions ? park.objects.find((o) => o.kind === 'retribution') : null;
  const key = `${c.id}|${n}|${!!rig}|${rig?.show ? 1 : 0}`;
  if (key === custodyKey) return;
  custodyKey = key;
  const decide = async (verdict, mode) => {
    const res = await act('sentence', c.id, verdict, mode);
    if (!res.ok) { toast(res.reason, 'warn'); return; }
    if (verdict === 'fine') toast(`${c.name} paid a ${money(res.fine)} fine.`);
    if (verdict === 'release') toast(`${c.name} was released.`);
    if (verdict === 'execute' && res.queued) toast(`${c.name} is on death row until the Retribution Rig is free.`);
    state.dirty = true;
    custodyKey = '';
    updateCustody();
  };
  $('custody-card').replaceChildren(...[
    el('div', { class: 'custody-head' },
      el('span', { class: 'mugshot' }, c.kind === 'panda' ? '🐼' : '🧑'),
      el('div', {},
        el('h2', {}, c.name),
        el('p', { class: 'small muted' }, `${Sim.CRIME_LABEL[c.kind]}${c.gang ? ` · ${c.gang}` : ''} · apprehended by ${c.by} on day ${c.day}`)),
      el('span', { class: 'small muted' }, `1 of ${n}`)),
    recordView(c.record),
    el('h3', {}, 'Your verdict'),
    el('div', { class: 'verdicts' },
      el('button', { class: 'btn', onclick: () => decide('release') }, el('b', {}, 'Release'), el('span', { class: 'small muted' }, `Safety −${CRIME.releaseSafetyHit}`)),
      el('button', { class: 'btn', onclick: () => decide('fine') }, el('b', {}, `Fine ${money(Sim.fineFor(c))}`), el('span', { class: 'small muted' }, 'Then banned from the park')),
      el('button', { class: 'btn btn-danger', disabled: !rig, onclick: () => decide('execute', 'fire') }, el('b', {}, '🔥 Execute: fire pit'), el('span', { class: 'small muted' }, 'Launched at full speed')),
      el('button', { class: 'btn btn-danger', disabled: !rig, onclick: () => decide('execute', 'water') }, el('b', {}, '🌊 Execute: drown'), el('span', { class: 'small muted' }, 'Into the dunk tank'))),
    !rig && el('p', { class: 'small muted' }, park.settings.executions ? 'Build a Retribution Rig (🛡️ Security menu) to unlock executions.' : 'Executions are turned off in this park\'s rules.'),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-link', onclick: () => { $('custody-modal').hidden = true; } }, 'Decide later')),
  ].filter(Boolean));
}

function designView(d) {
  if (!d) return null;
  if (!d.ok) return el('p', { class: 'error small' }, `❌ ${d.reason}`);
  return el('div', {},
    el('h3', {}, 'Ride statistics'),
    kv([
      ['Top speed', `${d.maxSpeed} km/h`],
      ['Max vertical G', `${d.maxG} G`],
      ['Min vertical G', `${d.minG} G`],
      ['Max lateral G', `${d.maxLat} G`],
      ['Airtime', `${d.airtime} s`],
      ['Highest point', `${d.maxHeight} m`],
      ['Biggest drop', `${d.biggestDrop} m`],
      ['Inversions', d.inversions],
      ['Track length', `${d.length} m`],
      ['Ride time', `${Math.round(d.duration)} s`],
      ['Excitement', `${d.excitement}/10`],
      ['Intensity', `${d.intensity}/10${d.intensity > 10 ? ' (extreme!)' : ''}`],
      ['Nausea', `${d.nausea}/10`],
    ]),
    d.warnings.length > 0 && el('ul', { class: 'warnings' }, d.warnings.map((w) => el('li', {}, `⚠ ${w}`))));
}

function swatches(current, onPick) {
  return el('div', { class: 'swatches' },
    PAINT.map((c) => el('button', { class: `swatch-btn${current === c ? ' active' : ''}`, title: c, style: { background: c }, onclick: () => onPick(c) })),
    el('input', { type: 'color', value: current || '#ffffff', title: 'Custom colour', onchange: (e) => onPick(e.target.value) }),
    current && el('button', { class: 'btn btn-small', onclick: () => onPick(null) }, 'Reset'));
}

function nameInput(value, onChange) {
  return el('input', { class: 'text', value, maxlength: 40, onchange: (e) => { onChange(e.target.value); state.dirty = true; e.target.blur(); } });
}

function traitBadges(traits) {
  return (traits || []).map((t) => el('span', { class: 'trait', title: STAFF_TRAITS[t].label }, `${STAFF_TRAITS[t].icon} ${STAFF_TRAITS[t].label}`));
}

const PIECE_ORDER = ['straight', 'left', 'right', 'wideLeft', 'wideRight', 'up', 'down', 'steepUp', 'steepDown', 'lift', 'booster', 'brake', 'loop', 'station'];

async function builderAction(fn) {
  const res = await fn();
  if (res && res.ok === false && res.reason) toast(res.reason, 'warn');
  if (state.builder) state.builder.lastTest = null;
  refreshPanel(true);
  return res;
}

const TIPS = [
  ['🚀 Getting started', [
    'Paths are everything: guests only walk on paths, and rides and shops need a path tile next to them.',
    'Start with a couple of cheap flat rides, a food stall, a drink stall and restrooms, then add a coaster.',
    'Guests leave when they are unhappy, tired, broke, or have been in the park for over two days.',
    'Click any guest to read their thoughts. They tell you what your park is missing.',
  ]],
  ['💰 Money & prices', [
    'You earn from admission, ride tickets and shop sales. Wages and upkeep are charged at the end of each day.',
    'Guests compare a ticket price with how exciting the ride is. Overpriced rides and food get refused.',
    'Your park value (cash plus 80% of what you have built) is your leaderboard score.',
  ]],
  ['🎢 Designing coasters', [
    'Rides → Design your own coaster. Place a station (press X to rotate it), then add track pieces.',
    'Trains leave the station slowly, so you need a chain lift or a launch booster to build energy.',
    'Speed comes from height: every metre you drop turns into speed, minus friction and air resistance.',
    'Tight turns at speed produce brutal lateral G. Use wide turns, or brakes before tight turns.',
    'Sharp changes from steep slopes to flat track cause high vertical G. Ease in with gentle slopes.',
    'Loops need roughly 70 km/h on entry, or the train falls back.',
    'Brakes hold the train at a steady crawl, which is handy for the run back into the station.',
    'Excitement rises with speed, drops, airtime and inversions. Intensity above 10 scares most guests away.',
    'Use Test run to see speed, G-forces and airtime before opening. Edit a coaster any time from its panel.',
  ]],
  ['🚨 Crime & safety', [
    'Some visitors are pickpockets, brawlers, robbers or drug dealers. Every crime lowers your Safety score.',
    'Low Safety hurts your park rating and scares new visitors away.',
    'Security guards discourage crime nearby, chase suspects and arrest them. Cameras identify culprits.',
    'Crime is more likely at dusk, unless the area is lit by lamp posts.',
    'Violence leaves blood on the paths that upsets guests until janitors scrub it away.',
    'A First Aid Post treats injured guests and makes fatal assaults less likely.',
  ]],
  ['💊 Drugs & gangs', [
    'Dealers and corrupt shop vendors sell drugs. Unhappy guests are more likely to buy.',
    'Guests who are high cannot find the exit, and some join a crime gang when they come down.',
    'Guards and cameras near a shop can expose a corrupt vendor. Replace them from the shop panel.',
    'The 🚨 Wanted list shows every identified suspect, their record and gang activity.',
  ]],
  ['⚖️ Custody & sentencing', [
    'Everyone apprehended waits in custody for your verdict: release, fine, or execution.',
    'Releasing costs Safety. Fines grow with the offender\'s record.',
    'Executions need a Retribution Rig. Spectators pay to watch, every guest cheers up, and Safety is restored.',
  ]],
  ['🐼 Pandemonium', [
    'From day 4 a heist crew in panda costumes may raid the park, appearing everywhere at once. Each raid brings more pandas.',
    'They rob tills, smash rides and shops, and attack guests. Only the Hot Dog Squad can bring them down.',
    'Build a Security HQ to hire squad officers. Pandas are weaker than officers one-on-one, but they gang up.',
    'One officer usually loses to a full crew. Two or more usually win.',
    'Capture the whole crew to stop them escaping with your money.',
  ]],
  ['🪦 Officer deaths & insurance', [
    `When pandas knock out an officer, there is a ${Math.round(PANDEMONIUM.killChance * 100)}% chance the officer is killed instead.`,
    `The park pays life insurance to the family: ${money(PANDEMONIUM.lifeInsurance.squad)} per squad officer and ${money(PANDEMONIUM.lifeInsurance.guard)} per guard.`,
    'The fallen are buried in a mass grave inside the park, under the Fallen Officers Memorial, which cannot be removed.',
    'The cheapest way to avoid payouts is enough officers that none of them fights alone.',
  ]],
  ['🌦️ Weather & events', [
    'Each climate has its own weather. Rain and snow keep visitors away and soak guests without umbrellas, so build an Umbrella Stand.',
    'Heatwaves make guests thirsty and send ice cream sales soaring. Storms break rides, and lightning can strike tall rides.',
    'Random events happen most days: tour buses, sponsors, VIPs, health inspectors, power outages, viral posts and more. Check Park → Recent events.',
    'Buzz is word of mouth. Viral posts, VIPs and influencers move it up or down, and it shifts your rating and visitor numbers.',
  ]],
  ['👨‍👩‍👧 Guests & staff', [
    'Guests come in types: families, thrill-seekers, teenagers, seniors, tourists and influencers. Each has its own budget, thrill tolerance, pace and habits.',
    'Tourists love souvenirs. Teenagers litter more and are likelier to turn to crime. Seniors tire quickly. Influencers post a review when they leave.',
    'Cash machines let broke guests top up instead of leaving. Information kiosks sell maps that help guests find things.',
    'New staff may arrive with traits: Speedy, Lazy, Tough, Sharpshooter, Eagle-eyed, Veteran and more. They change speed, health, aim and wages.',
  ]],
  ['🎨 Customization', [
    'Click any ride, shop or statue to rename and repaint it. Custom coasters also take a train colour and 2–7 cars.',
    'Choose a path style (sandstone, brick, boardwalk and more) from the Path menu. Drag over existing paths to repaint them.',
    'Set staff uniform colours in the Staff panel. Rename any employee from their panel.',
    'Share a coaster with 📤 Share design, and build someone else\'s with Rides → 📥 Import a design code. Saved designs appear in the Rides menu.',
    'Rides age and become less reliable. Refurbish them from their panel.',
    'Park → ⚙️ Rules changes crime, raids, gore, weather, events, wages, breakdowns and more, mid-game.',
  ]],
  ['🔒 Lockdown', [
    'Install barbed wire fencing from the Park panel to lock the exits at any time.',
    'While locked, nobody enters or leaves. Criminals and pandas are trapped with your security, but so are your guests, who get angry.',
  ]],
  ['🎮 Controls', [
    'Right-drag or WASD/arrow keys: pan. Scroll: zoom. Q/E or middle-drag: rotate (middle-drag also tilts).',
    'P: path, B: bulldoze, R: rides, F: shops, T: scenery, G: security. Space: pause. 1/2/3: speed. Esc: cancel.',
    'In the coaster builder, Backspace undoes the last piece.',
  ]],
];

const PANELS = {
  builder: ({ id }) => {
    const { park } = state;
    const o = Sim.getObject(park, id);
    if (!o || o.kind !== 'custom') return null;
    if (!o.building) { setTimeout(() => showPanel({ type: 'object', id }), 0); return el('div'); }
    const b = state.builder || (state.builder = { id, hoverPiece: null, hoverOk: false, lastTest: null });
    const c = o._layout.cursor;
    const complete = Sim.coasterComplete(o);
    const test = b.lastTest;
    return el('div', { class: 'builder' },
      el('h2', {}, `🛠️ ${o.name}`),
      el('input', { class: 'text', value: o.name, maxlength: 40, onchange: (e) => { act('renameRide', id, e.target.value); state.dirty = true; e.target.blur(); } }),
      kv([
        ['Pieces', o.track.pieces.length],
        ['Track height here', `${c.h * HEIGHT_STEP * METERS} m (max ${MAX_STEPS * HEIGHT_STEP * METERS} m)`],
        ['Spent so far', money(o.paid)],
        ['Circuit', complete ? '✅ Complete' : 'Bring the track back into the station'],
      ]),
      el('h3', {}, 'Add track'),
      el('div', { class: 'pieces' }, PIECE_ORDER.map((type) => {
        const def = PIECES[type];
        const check = Sim.canAddPiece(park, o, type);
        return el('button', {
          class: 'piece', disabled: !check.ok, title: check.ok ? `${def.name} (${money(def.cost)})` : check.reason,
          onmouseenter: () => { b.hoverPiece = type; b.hoverOk = check.ok; },
          onmouseleave: () => { if (b.hoverPiece === type) b.hoverPiece = null; },
          onclick: () => builderAction(() => act('addPiece', id, type)),
        }, el('span', { class: 'icon' }, def.icon), el('span', {}, def.name), el('span', { class: 'muted small' }, money(def.cost)));
      })),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', onclick: () => builderAction(async () => {
          const res = await act('removePiece', id);
          if (res.removed) { closePanel(); toast('Coaster removed and refunded.'); }
          return res;
        }) }, o.track.pieces.length > 1 ? '↶ Undo piece' : 'Remove coaster'),
        el('button', { class: 'btn', disabled: !complete, onclick: async () => { b.lastTest = await act('testCoaster', id); refreshPanel(true); } }, '🧪 Test run'),
        el('button', { class: 'btn btn-primary', disabled: !complete, onclick: async () => {
          const res = await act('openCoaster', id);
          if (!res.ok) { b.lastTest = res; refreshPanel(true); return; }
          showPanel({ type: 'object', id });
        } }, '🎢 Open coaster')),
      test && designView(test),
      el('p', { class: 'small muted' }, 'Tips: trains need a chain lift or booster to get going. Brakes before tight turns keep G-forces sane, and loops need speed. Backspace undoes the last piece.'));
  },

  wanted: () => {
    const { park } = state;
    const suspects = Sim.knownSuspects(park);
    const gangs = {};
    for (const g of park.guests) if (g.gang && !g.gone) gangs[g.gang] = (gangs[g.gang] || 0) + 1;
    return el('div', {},
      el('h2', {}, '🚨 Wanted list'),
      el('p', { class: 'small muted' }, 'Suspects identified by guards and cameras who are still in the park. Guards arrest them on sight.'),
      suspects.length
        ? el('ul', { class: 'list' }, suspects.map((g) => el('li', {},
          el('div', {},
            el('div', {}, `${g.crime === 'panda' ? '🐼' : '🧑'} ${g.name}`),
            el('div', { class: 'small muted' }, `${Sim.CRIME_LABEL[g.crime]}${g.gang ? ` · ${g.gang}` : ''} · ${Sim.offences(g.record)} offences · ${money(g.record.stolen)} stolen`)),
          el('button', { class: 'btn btn-small', onclick: () => { renderer.centerOn(g.x, g.y); showPanel({ type: 'guest', id: g.id }); } }, 'Find'))))
        : el('p', { class: 'small muted' }, 'No known suspects at large.'),
      el('h3', {}, 'Known gang activity'),
      kv([
        ['Drug deals recorded', park.stats.drugDeals],
        ['Guests recruited into gangs', park.stats.gangRecruits],
        ['Guests currently high', park.guests.filter((g) => g.high > 0).length],
        ...Object.entries(gangs).map(([name, n]) => [name, `${n} members suspected`]),
      ]),
      park.custody.length > 0 && el('div', { class: 'actions' },
        el('button', { class: 'btn btn-primary', onclick: () => { $('custody-modal').hidden = false; custodyKey = ''; updateCustody(); } }, `Sentence ${park.custody.length} in custody`)));
  },

  welcome: () => el('div', {},
    el('h2', {}, 'Welcome, Mogul!'),
    el('p', {}, `You've got ${money(state.park.cash)} and an empty field. Here's how to get started:`),
    el('ol', { class: 'small' },
      el('li', {}, 'Use 🟫 Path to extend the walkway from the entrance (click and drag).'),
      el('li', {}, 'Open 🎢 Rides and place a ride next to the path.'),
      el('li', {}, 'Add 🍔 Shops and restrooms so guests stay fed and comfortable.'),
      el('li', {}, 'Hire janitors, mechanics and security guards from 🧹 Staff.'),
      el('li', {}, 'Watch your Safety score: some visitors are thieves, brawlers or robbers.'),
      el('li', {}, 'Open 💡 Tips any time for a guide to every system.'),
      el('li', {}, 'Bulldoze trees to make room — and plant scenery to make guests happy.')),
    el('p', { class: 'small muted' }, 'Your park saves automatically to your account.'),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', onclick: closePanel }, "Let's build!"))),

  object: ({ id }) => {
    const { park } = state;
    const o = Sim.getObject(park, id);
    if (!o) return null;
    const ride = Sim.rideDef(o);
    const def = ride || STALLS[o.kind];
    const status = o.broken ? 'Broken down' : !o.open ? 'Closed' : ride ? (o.phase === 'running' ? 'Running' : 'Loading') : 'Open';
    const age = ride ? Math.max(0, Sim.day(park) - (o.builtDay || 1)) : 0;
    const failPct = ride ? Math.min(100, ((1 - ride.reliability + Sim.ageLoss(park, o)) * park.settings.breakdowns * Sim.weatherOf(park).breakdown) * 100) : 0;
    const share = state.shareCode?.id === id ? state.shareCode.code : null;
    return el('div', {},
      el('h2', {}, Sim.objName(o)),
      el('p', { class: 'muted small' }, ride ? `${ride.coaster ? 'Roller coaster' : 'Flat ride'} · ${status}` : `Shop · ${status}`),
      nameInput(Sim.objName(o), (v) => { act('renameObject', id, v); refreshPanel(true); }),
      kv([
        ride && ['Thrill', `${ride.excitement}/10`],
        ride && ['Intensity', `${ride.intensity}/10`],
        ride && ['Capacity', ride.capacity],
        ride && ['In line', o.queue.length],
        [ride ? 'Total riders' : 'Customers', o.stats.riders.toLocaleString()],
        ['Revenue', money(o.stats.revenue)],
        ['Upkeep', `${money(def.upkeep)}/day`],
        o._access.length === 0 && ['Access', '⚠ Not connected to a path'],
      ]),
      ride && kv([
        ['Age', `${age} day${age === 1 ? '' : 's'}`],
        ['Breakdown chance per cycle', `${failPct.toFixed(1)}%`],
      ]),
      ride && park.settings.ageing && age > 3 && el('div', { class: 'actions' }, el('button', {
        class: 'btn btn-small', onclick: async () => {
          const res = await act('refurbish', id);
          if (!res.ok) toast(res.reason, 'warn'); else toast(`${Sim.objName(o)} refurbished for ${money(res.cost)}. It's as reliable as new.`);
          state.dirty = true; refreshPanel(true);
        },
      }, `🔧 Refurbish (${money(Sim.refurbishCost(o))})`)),
      el('h3', {}, o.kind === 'custom' ? 'Track colour' : 'Paint'),
      swatches(o.color, (c) => { act('setColor', id, 'color', c); state.dirty = true; refreshPanel(true); }),
      o.kind === 'custom' && el('h3', {}, 'Train'),
      o.kind === 'custom' && swatches(o.trainColor, (c) => { act('setColor', id, 'trainColor', c); state.dirty = true; refreshPanel(true); }),
      o.kind === 'custom' && stepper(`${o.cars || 4} cars · ${4 * (o.cars || 4)} riders`,
        () => { act('setCoasterCars', id, (o.cars || 4) - 1); state.dirty = true; refreshPanel(true); },
        () => { act('setCoasterCars', id, (o.cars || 4) + 1); state.dirty = true; refreshPanel(true); }),
      o.kind === 'custom' && designView(o._design),
      o.kind === 'custom' && el('div', { class: 'actions' },
        el('button', { class: 'btn btn-small', onclick: () => {
          const code = Sim.exportDesign(o);
          state.shareCode = { id, code };
          navigator.clipboard?.writeText(code).then(() => toast('Design code copied to the clipboard.'), () => {});
          refreshPanel(true);
        } }, '📤 Share design'),
        el('button', { class: 'btn btn-small', onclick: () => { saveDesign(o.name, Sim.exportDesign(o)); toast('Saved to My designs (Rides menu).'); } }, '💾 Save to my designs')),
      share && el('textarea', { class: 'text code', readonly: true, rows: 3, onclick: (e) => e.target.select() }, share),
      o.exposed && el('p', { class: 'error small' }, `💊 This vendor has been caught selling drugs under the counter (${o.deals} known deals). Replace them!`),
      !FREE.has(def.sells) && el('h3', {}, 'Price'),
      !FREE.has(def.sells) && stepper(`$${o.price.toFixed(o.price % 1 ? 2 : 0)}`,
        () => { act('setPrice', id, o.price - 0.5); state.dirty = true; refreshPanel(true); },
        () => { act('setPrice', id, o.price + 0.5); state.dirty = true; refreshPanel(true); }),
      !FREE.has(def.sells) && el('p', { class: 'small muted' }, ride
        ? `Guests will typically pay up to about ${money(1.5 + ride.excitement * 1.05)}.`
        : 'Guests balk at overpriced food and drinks.'),
      el('div', { class: 'actions' },
        o.kind !== 'custom' && el('button', { class: 'btn', onclick: () => { act('setOpen', id, !o.open); state.dirty = true; refreshPanel(true); } }, o.open ? 'Close' : 'Open'),
        o.kind === 'custom' && el('button', { class: 'btn', onclick: () => { act('setOpen', id, !o.open); state.dirty = true; refreshPanel(true); } }, o.open ? 'Close' : 'Reopen'),
        o.kind === 'custom' && el('button', {
          class: 'btn',
          onclick: async () => {
            const res = await act('editCoaster', id);
            if (!res.ok) { toast(res.reason, 'warn'); return; }
            openBuilder(id);
          },
        }, '🛠️ Edit design'),
        'corrupt' in o && el('button', {
          class: `btn${o.exposed ? ' btn-primary' : ''}`,
          onclick: async () => {
            const res = await act('replaceVendor', id);
            toast(res.wasCorrupt ? 'The new vendor is clean. The dealing has stopped.' : 'New vendor hired. (The old one was clean.)');
            state.dirty = true; refreshPanel(true);
          },
        }, `Replace vendor (${money(CRIME.replaceVendorCost)})`),
        el('button', { class: 'btn btn-danger', onclick: () => demolish(o) }, `Demolish (+${money(o.paid * 0.5)})`)));
  },

  scenery: ({ id }) => {
    const o = Sim.getObject(state.park, id);
    if (!o) return null;
    const def = SCENERY[o.kind];
    return el('div', {},
      el('h2', {}, Sim.objName(o)),
      el('p', { class: 'muted small' }, def.camera ? 'Discourages crime nearby and helps identify culprits, who may be stopped at the gate.'
        : def.lamp ? 'Lights the area at dusk, when crime is otherwise more likely.'
        : def.seat ? 'Tired guests sit here to rest.' : def.bin ? 'Guests nearby throw their litter away here.' : 'Pretty scenery makes nearby guests happier.'),
      nameInput(Sim.objName(o), (v) => { act('renameObject', id, v); refreshPanel(true); }),
      o.kind === 'statue' && el('h3', {}, 'Finish'),
      o.kind === 'statue' && swatches(o.color, (c) => { act('setColor', id, 'color', c); state.dirty = true; refreshPanel(true); }),
      el('div', { class: 'actions' }, el('button', { class: 'btn btn-danger', onclick: () => demolish(o) }, o.paid ? `Remove (+${money(o.paid * 0.5)})` : 'Remove')));
  },

  guest: ({ id }) => {
    const g = state.park._guestById.get(id);
    if (!g) return null;
    if (g.crime === 'panda') {
      return el('div', {},
        el('h2', {}, `🐼 ${g.name}`),
        el('p', { class: 'error small' }, 'Member of the Pandemonium heist crew'),
        g.thought && el('div', { class: 'thought-bubble' }, `“${g.thought}”`),
        el('div', { class: 'need' }, 'Health', bar((g.hp / g.maxHp) * 100, '#e5484d')),
        kv([['Bamboo accuracy', `${Math.round(g.acc * 100)}%`]]),
        kv([
          ['Status', g.state === 'downed' ? 'Down! Being cuffed' : g.leaving ? 'Fleeing with the loot' : 'Rampaging'],
          ['Loot carried', money(g.loot)],
        ]),
        el('p', { class: 'small muted' }, 'Only the Hot Dog Squad can bring them down. Build a Security HQ to hire them.'));
    }
    const mood = g.happy > 75 ? '😄' : g.happy > 50 ? '🙂' : g.happy > 30 ? '😐' : '😠';
    const doing = { walk: g.leaving ? 'Heading home' : 'Walking', queue: 'Waiting in line', ride: 'On a ride', busy: 'At a shop', sit: 'Resting on a bench' }[g.state];
    return el('div', {},
      el('h2', {}, `${mood} ${g.name}`),
      el('p', { class: 'muted small' }, `${GUEST_TYPES[g.type]?.icon || ''} ${GUEST_TYPES[g.type]?.label || 'Guest'} · ${doing}`),
      (g.umbrella || g.map || g.souvenir) && el('p', { class: 'small' }, [g.umbrella && '☂️ Umbrella', g.map && '🗺️ Park map', g.souvenir && '🎁 Souvenir'].filter(Boolean).join(' · ')),
      g.crime && g.spotted && el('p', { class: 'error small' }, `⚠ Wanted ${Sim.CRIME_LABEL[g.crime]}${g.gang ? ` · ${g.gang}` : ''}`),
      g.injured && el('p', { class: 'small' }, '🩹 Injured: looking for first aid'),
      g.high > 0 && el('p', { class: 'small' }, `😵 High on drugs: ${g.leaving ? "can't find the exit" : 'wandering in a daze'} (${Math.ceil(g.high)}s left)`),
      g.crime && g.spotted && recordView(g.record, g.loot),
      g.thought && el('div', { class: 'thought-bubble' }, `“${g.thought}”`),
      el('div', { class: 'need' }, 'Happiness', bar(g.happy, '#2f9e44')),
      el('div', { class: 'need' }, 'Energy', bar(g.energy, '#3e8ed0')),
      el('div', { class: 'need' }, 'Hunger', bar(g.hunger, '#e8833a')),
      el('div', { class: 'need' }, 'Thirst', bar(g.thirst, '#4aa3df')),
      el('div', { class: 'need' }, 'Restroom', bar(g.bladder, '#9b6bd6')),
      el('div', { class: 'need' }, 'Nausea', bar(g.nausea, '#7bd389')),
      kv([
        ['Cash', money(g.cash)],
        ['Rides taken', g.rides],
        ['Thrill tolerance', `${g.pref}/10`],
        ['Time in park', `${(g.timeIn / 60).toFixed(1)} days`],
      ]));
  },

  staff: ({ id }) => {
    const s = state.park.staff.find((m) => m.id === id);
    if (!s) return null;
    const job = s.down > 0 ? 'Knocked out' : s.chase ? 'Chasing a suspect' : s.busy > 0 ? (s.role === 'janitor' ? 'Sweeping' : 'Fixing a ride') : s.task ? 'Heading to a broken ride' : 'Patrolling';
    return el('div', {},
      el('h2', {}, s.name),
      el('p', { class: 'muted small' }, `${STAFF[s.role].name} · ${job}`),
      nameInput(s.name, (v) => { act('renameStaff', id, v); refreshPanel(true); }),
      s.traits?.length ? el('div', { class: 'traits' }, traitBadges(s.traits)) : el('p', { class: 'small muted' }, 'No special traits.'),
      s.down > 0 && el('p', { class: 'error small' }, `💫 Knocked out: back on duty in ${Math.ceil(s.down)}s`),
      el('div', { class: 'need' }, 'Health', bar((s.hp / s.maxHp) * 100, '#e5484d')),
      kv([
        ['Wage', `${money(Sim.wageOf(state.park, s))}/day`],
        Sim.traitMul(s, 'speed') !== 1 && ['Speed', `${Math.round(Sim.traitMul(s, 'speed') * 100)}%`],
        s.role === 'squad' && ['Hot dog accuracy', `${Math.round(s.acc * 100)}%`],
      ]),
      el('div', { class: 'actions' }, el('button', { class: 'btn btn-danger', onclick: () => { act('fire', id); state.dirty = true; closePanel(); } }, 'Fire')));
  },

  securityhq: ({ id }) => {
    const { park } = state;
    if (!Sim.getObject(park, id)) return null;
    const squad = park.staff.filter((s) => s.role === 'squad');
    const pandas = Sim.activePandas(park);
    return el('div', {},
      el('h2', {}, '🚔 Security HQ'),
      el('p', { class: 'muted small' }, 'Home of the Hot Dog Squad: officers armed with hot dog launchers who hunt down Pandemonium raiders.'),
      kv([
        ['Squad officers', squad.length],
        ['Raid status', park.raid ? `ACTIVE: ${pandas.length} at large` : 'All quiet'],
        ['Pandemonium captured', park.pandemonium.captured],
        ['In custody', park.custody.length],
        ['On death row', park.captives.length],
      ]),
      el('div', { class: 'actions' },
        el('button', { class: 'btn btn-primary', onclick: () => hireStaff('squad') }, `Hire officer (${money(STAFF.squad.wage)}/day)`),
        el('button', { class: 'btn btn-danger', onclick: () => demolish(Sim.getObject(park, id)) }, 'Demolish')));
  },

  retribution: ({ id }) => {
    const { park } = state;
    const rig = Sim.getObject(park, id);
    if (!rig) return null;
    const show = rig.show;
    const mode = (m, label) => el('button', {
      class: `btn${rig.pit === m ? ' btn-primary' : ''}`, disabled: !!show,
      onclick: () => { act('setRigMode', id, m); state.dirty = true; refreshPanel(true); },
    }, label);
    return el('div', {},
      el('h2', {}, '⚖️ Retribution Rig'),
      el('p', { class: 'muted small' }, 'A siege catapult that hurls condemned prisoners at full speed into a roaring fire pit or a dunk tank they never surface from. Crowds pay to watch.'),
      el('h3', {}, 'Method'),
      el('div', { class: 'actions' }, mode('fire', '🔥 Fire pit'), mode('water', '🌊 Dunk tank')),
      el('h3', {}, `Prisoners (${park.captives.length})`),
      park.captives.length
        ? el('ul', { class: 'list' }, park.captives.map((c) => el('li', {}, `🐼 ${c.name}`)))
        : el('p', { class: 'small muted' }, show ? 'Show in progress.' : 'Death row is empty. Sentence prisoners from custody to execution to fill it.'),
      show && kv([['Now', `${show.victims[Math.min(show.victims.length - 1, Math.floor(show.t / PANDEMONIUM.showSecondsPerVictim))]}`], ['Spectators', show.spectators]]),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn btn-primary', disabled: !!show || !park.captives.length,
          onclick: async () => {
            const res = await act('execute', id, rig.pit);
            if (!res.ok) toast(res.reason, 'warn');
            state.dirty = true;
            refreshPanel(true);
          },
        }, 'Stage public execution'),
        el('button', { class: 'btn btn-danger', disabled: !!show, onclick: () => demolish(rig) }, 'Demolish')),
      el('p', { class: 'small muted' }, `Spectators pay ${money(PANDEMONIUM.spectatorFee)}. Afterwards every guest gets a big happiness boost and Safety is fully restored.`));
  },

  memorial: ({ id }) => {
    const { park } = state;
    if (!Sim.getObject(park, id)) return null;
    const total = park.fallen.reduce((n, f) => n + f.payout, 0);
    return el('div', {},
      el('h2', {}, '🪦 Fallen Officers Memorial'),
      el('p', { class: 'muted small' }, 'A mass grave and memorial honouring the security staff who gave their lives defending this park. It cannot be removed.'),
      kv([
        ['Officers laid to rest', park.fallen.length],
        ['Life insurance paid to families', money(total)],
      ]),
      el('h3', {}, 'In memory of'),
      el('ul', { class: 'list' }, [...park.fallen].reverse().map((f) => el('li', {},
        el('div', {}, el('div', {}, f.name), el('div', { class: 'small muted' }, `Killed by ${f.by} on day ${f.day}`)),
        el('span', { class: 'small muted' }, money(f.payout))))),
      el('p', { class: 'small muted' }, 'More officers, fewer raiders per officer, and a Security HQ close to the action keep your staff alive.'));
  },

  rules: () => {
    const { park } = state;
    return el('div', { class: 'rules' },
      el('h2', {}, '⚙️ Rules & settings'),
      el('p', { class: 'small muted' }, 'Change how this park plays. Greyed-out options were fixed when the park was created.'),
      ...settingGroups((def) => settingControl(def, park.settings[def.key], async (v) => {
        const res = await act('setSetting', def.key, v);
        if (!res.ok) toast(res.reason, 'warn');
        state.dirty = true;
        renderPalette();
        refreshPanel(true);
      }, { disabled: !def.live })),
      el('div', { class: 'actions' }, el('button', { class: 'btn', onclick: newGame }, 'Start a new park with different settings')));
  },

  tips: () => el('div', { class: 'tips' },
    el('h2', {}, '💡 Player tips'),
    ...TIPS.map(([title, items]) => el('details', {},
      el('summary', {}, title),
      el('ul', {}, items.map((t) => el('li', {}, t)))))),

  staff_list: () => {
    const { park } = state;
    return el('div', {},
      el('h2', {}, 'Staff'),
      el('p', { class: 'small muted' }, 'Janitors sweep up litter. Mechanics repair broken rides. Security guards deter crime and arrest suspects. Wages are paid daily.'),
      el('div', { class: 'actions' }, Object.entries(STAFF).map(([role, def]) =>
        el('button', { class: 'btn', onclick: () => hireStaff(role) },
          `Hire ${def.name} (${money(Math.round(def.wage * park.settings.wages))}/day)`))),
      el('p', { class: 'small muted' }, 'Each hire may come with random traits, such as Speedy, Tough or Sharpshooter.'),
      el('h3', {}, 'Uniforms'),
      el('div', { class: 'uniforms' }, Object.entries(STAFF).map(([role, def]) => el('label', { class: 'uniform' },
        el('input', { type: 'color', value: park.uniforms[role] || def.color, onchange: (e) => { act('setUniform', role, e.target.value); state.dirty = true; } }),
        def.name))),
      el('h3', {}, `Employees (${park.staff.length})`),
      park.staff.length
        ? el('ul', { class: 'list' }, park.staff.map((s) => el('li', {},
          el('span', {}, s.name, ' ', (s.traits || []).map((t) => STAFF_TRAITS[t].icon).join('')),
          el('span', {},
            el('button', { class: 'btn btn-small', onclick: () => { renderer.centerOn(s.x, s.y); showPanel({ type: 'staff', id: s.id }); } }, 'Find'), ' ',
            el('button', { class: 'btn btn-small btn-danger', onclick: () => { act('fire', s.id); state.dirty = true; refreshPanel(true); } }, 'Fire')))))
        : el('p', { class: 'small muted' }, 'Nobody yet.'));
  },

  park: () => {
    const { park } = state;
    const s = Sim.parkStats(park);
    const t = park.stats.today;
    const hist = park.stats.history.slice(-14);
    const maxV = Math.max(1, ...hist.flatMap((h) => [h.income, h.expenses]));
    return el('div', {},
      el('h2', {}, park.name),
      el('h3', {}, 'Park name'),
      el('input', {
        class: 'text', value: park.name, maxlength: 40,
        onchange: (e) => { act('renamePark', e.target.value); state.dirty = true; e.target.blur(); },
      }),
      el('h3', {}, 'Admission'),
      stepper(money(park.entranceFee),
        () => { act('setEntranceFee', park.entranceFee - 1); state.dirty = true; refreshPanel(true); },
        () => { act('setEntranceFee', park.entranceFee + 1); state.dirty = true; refreshPanel(true); }),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', onclick: () => { act('setParkOpen', !park.open); state.dirty = true; refreshPanel(true); } }, park.open ? 'Close park to new guests' : 'Open park')),
      el('h3', {}, 'Overview'),
      kv([
        ['Park value', money(s.value)],
        ['Rides / shops', `${s.rides} / ${s.stalls}`],
        ['Average happiness', s.guests ? `${Math.round(s.avgHappy)}%` : '—'],
        ['Litter on paths', s.litter],
        ['Guests all-time', park.stats.totalGuests.toLocaleString()],
      ]),
      el('h3', {}, '🐼 Pandemonium'),
      kv([
        ['Raids', park.pandemonium.raids],
        ['Defeated / escaped members', `${park.pandemonium.captured} / ${park.pandemonium.escaped}`],
        ['Prisoners awaiting justice', park.captives.length],
        ['Executions', park.pandemonium.executions],
        ['Status', park.raid ? `RAID IN PROGRESS: ${Sim.activePandas(park).length} at large` : `Quiet (they may strike from day ${park.pandemonium.nextRaidDay})`],
      ]),
      el('h3', {}, 'Safety & security'),
      el('div', { class: 'need' }, 'Safety', bar(s.safety, s.safety > 70 ? '#2f9e44' : s.safety > 40 ? '#e8a33a' : '#e5484d')),
      kv([
        ['Security guards', s.guards],
        ['Crimes today', t.crimeCount],
        ['Crimes all-time', park.stats.crimes],
        ['Arrests', park.stats.arrests],
        t.crime && ['Crime losses today (net)', money(t.crime)],
      ]),
      park.incidents.length > 0
        ? el('ul', { class: 'list incidents' }, park.incidents.slice(0, 6).map((i) =>
          el('li', {}, el('span', {}, `${CRIME_ICON[i.type]} ${i.text}`), el('span', { class: 'muted small' }, `D${i.day}`))))
        : el('p', { class: 'small muted' }, 'No incidents reported.'),
      s.safety < 60 && el('p', { class: 'small' }, 'Tip: guards, cameras, lamp posts and a first aid post make the park safer.'),
      el('h3', {}, 'Barbed wire perimeter'),
      park.fence
        ? el('div', {},
          el('p', { class: 'small muted' }, `Installed (${money(CRIME.fenceUpkeep)}/day upkeep). Locking the exits stops everyone entering or leaving: criminals and Pandemonium can't escape, but trapped guests get angry and your rating suffers.`),
          el('div', { class: 'actions' }, el('button', { class: `btn${park.locked ? ' btn-primary' : ' btn-danger'}`, onclick: toggleLock }, park.locked ? '🔓 Unlock the exits' : '🔒 Lock the exits')))
        : el('div', {},
          el('p', { class: 'small muted' }, 'Ring the park with razor wire so you can lock the exits at any time.'),
          el('div', { class: 'actions' }, el('button', {
            class: 'btn', onclick: async () => {
              const res = await act('installFence');
              if (!res.ok) toast(res.reason, 'warn');
              state.dirty = true; refreshPanel(true);
            },
          }, `Install barbed wire (${money(CRIME.fenceCost)})`))),
      el('h3', {}, `Today (day ${Sim.day(park)})`),
      kv([
        ['Admissions', money(t.admissions)],
        ['Ride tickets', money(t.rides)],
        ['Shops (net)', money(t.shops)],
        ['Construction (net)', money(t.construction)],
        t.events && ['Events (net)', money(t.events)],
        t.insurance && ['Life insurance payouts', money(t.insurance)],
        ['Profit so far', money(t.income - t.expenses)],
      ]),
      hist.length > 0 && el('h3', {}, 'Recent days: income vs. expenses'),
      hist.length > 0 && el('div', { class: 'chart', title: 'Green: income · Red: expenses' }, hist.map((h) =>
        el('div', { class: 'col', title: `Day ${h.day}: +${money(h.income)} / -${money(h.expenses)}` },
          el('div', { class: 'inc', style: { height: `${(h.income / maxV) * 50}%` } }),
          el('div', { class: 'exp', style: { height: `${(h.expenses / maxV) * 50}%` } })))),
      el('h3', {}, 'World'),
      kv([
        ['Weather', `${Sim.weatherOf(park).icon} ${Sim.weatherOf(park).label}`],
        ['Climate', CLIMATES[park.settings.climate].label],
        ['Buzz', `${park.buzz > 0 ? '+' : ''}${Math.round(park.buzz)}`],
        ['Difficulty', DIFFICULTIES[park.settings.difficulty].label],
        ['Map seed', park.seed],
      ]),
      park.eventLog.length > 0 && el('h3', {}, 'Recent events'),
      park.eventLog.length > 0 && el('ul', { class: 'list incidents' }, park.eventLog.slice(0, 6).map((e) =>
        el('li', {}, el('span', {}, e.text), el('span', { class: 'muted small' }, `D${e.day}`)))),
      el('div', { class: 'actions' }, el('button', { class: 'btn', onclick: () => showPanel({ type: 'rules' }) }, '⚙️ Rules & settings')),
      el('h3', {}, 'Goals'),
      el('ul', { class: 'list goals' }, OBJECTIVES.map((o) => el('li', { class: park.objectives.includes(o.id) ? 'done' : '' }, o.text))),
      el('div', { class: 'actions' }, el('button', { class: 'btn btn-danger', onclick: newGame }, 'Start a new park')));
  },

  leaderboard: () => {
    const board = state.board;
    return el('div', {},
      el('h2', {}, '🏆 Top parks'),
      el('p', { class: 'small muted' }, 'Ranked by park value. Save to update your entry.'),
      !board ? el('p', { class: 'muted' }, 'Loading…')
        : el('table', { class: 'leaderboard' },
          el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Park'), el('th', { class: 'num' }, 'Value'), el('th', { class: 'num' }, 'Rating'))),
          el('tbody', {}, board.map((p, i) => el('tr', {},
            el('td', {}, i + 1),
            el('td', {}, el('div', {}, p.park), el('div', { class: 'small muted' }, p.owner)),
            el('td', { class: 'num' }, money(p.value)),
            el('td', { class: 'num' }, p.rating))))));
  },
};

async function toggleLock() {
  const res = await act('setLocked', !state.park.locked);
  if (!res.ok) toast(res.reason, 'warn');
  state.dirty = true;
  refreshPanel(true);
}

function demolish(o) {
  act('bulldoze', o.x, o.y);
  closePanel();
}

async function openLeaderboard() {
  state.board = null;
  showPanel({ type: 'leaderboard' });
  if (state.dirty) await save();
  try {
    state.board = (await api('/api/leaderboard')).parks;
  } catch {
    state.board = [];
  }
  refreshPanel(true);
}

function newGame() {
  openSetup({ fresh: false });
}

// ---------------------------------------------------------------------------
// New park setup (rendered from SETTINGS_SCHEMA)
// ---------------------------------------------------------------------------

const randomSeed = () => Math.floor(Math.random() * 0xffffffff);
let setup = null;

function openSetup({ fresh }) {
  setup = {
    fresh,
    name: state.park?.name || 'My Park',
    seed: randomSeed(),
    settings: defaultSettings('normal'),
  };
  $('setup-modal').hidden = false;
  renderSetup();
}

function settingControl(def, value, onChange, { disabled = false } = {}) {
  const id = `set-${def.key}`;
  let input;
  if (def.type === 'bool') {
    input = el('input', { type: 'checkbox', id, checked: value, disabled, onchange: (e) => onChange(e.target.checked) });
  } else if (def.type === 'select') {
    input = el('select', { id, disabled, onchange: (e) => onChange(e.target.value) },
      def.options.map((o) => el('option', { value: o, selected: o === value }, optionLabel(def.key, o))));
  } else if (def.type === 'number') {
    input = el('input', { type: 'number', id, class: 'text', min: def.min, max: def.max, step: def.step, value, disabled, onchange: (e) => onChange(Number(e.target.value)) });
  } else {
    input = el('span', { class: 'range' },
      el('input', { type: 'range', id, min: def.min, max: def.max, step: def.step, value, disabled, oninput: (e) => { e.target.nextSibling.textContent = `${Number(e.target.value)}×`; }, onchange: (e) => onChange(Number(e.target.value)) }),
      el('span', { class: 'small' }, `${value}×`));
  }
  return el('div', { class: 'setting' },
    el('label', { for: id }, def.label),
    input,
    def.help && el('div', { class: 'small muted help' }, def.help));
}

function optionLabel(key, o) {
  if (key === 'difficulty') return DIFFICULTIES[o].label;
  if (key === 'climate') return CLIMATES[o].label;
  return o[0].toUpperCase() + o.slice(1);
}

function settingGroups(render) {
  const groups = {};
  for (const def of SETTINGS_SCHEMA) (groups[def.group] ||= []).push(def);
  return Object.entries(groups).map(([name, defs]) => el('fieldset', {}, el('legend', {}, name), defs.map(render)));
}

function renderSetup() {
  const f = setup;
  const set = (key, v) => {
    if (key === 'difficulty') f.settings = { ...defaultSettings(v), climate: f.settings.climate, treeDensity: f.settings.treeDensity };
    else f.settings[key] = v;
    renderSetup();
  };
  $('setup-card').replaceChildren(
    el('h2', {}, f.fresh ? '🎢 Create your park' : '🎢 Start a new park'),
    el('p', { class: 'small muted' }, 'Every option is saved with the park. Options marked ⚙️ can be changed later from the Rules panel.'),
    el('div', { class: 'setting' }, el('label', { for: 'setup-name' }, 'Park name'),
      el('input', { id: 'setup-name', class: 'text', maxlength: 40, value: f.name, onchange: (e) => { f.name = e.target.value; } })),
    el('div', { class: 'setting' }, el('label', { for: 'setup-seed' }, 'Map seed'),
      el('span', { class: 'seed' },
        el('input', { id: 'setup-seed', class: 'text', type: 'number', min: 0, max: 4294967295, value: f.seed, onchange: (e) => { f.seed = Number(e.target.value) >>> 0; } }),
        el('button', { class: 'btn btn-small', title: 'Random seed', onclick: () => { f.seed = randomSeed(); renderSetup(); } }, '🎲')),
      el('div', { class: 'small muted help' }, 'The same seed and settings always produce the same starting map and luck.')),
    ...settingGroups((def) => {
      const ctl = settingControl(def, f.settings[def.key], (v) => set(def.key, v));
      if (def.live) ctl.querySelector('label').append(' ⚙️');
      return ctl;
    }),
    el('div', { class: 'actions' },
      el('button', { class: 'btn btn-primary btn-lg', onclick: createFromSetup }, 'Create park'),
      !f.fresh && el('button', { class: 'btn', onclick: () => { $('setup-modal').hidden = true; } }, 'Cancel')),
  );
}

async function createFromSetup() {
  const f = setup;
  if (!f.fresh && !confirm('Bulldoze everything and start this new park? Your current park will be lost.')) return;
  if (!f.fresh) await api('/api/park', { method: 'DELETE' }).catch(() => {});
  await sim.newPark(f.name.trim() || 'My Park', f.seed, f.settings);
  state.dirty = true;
  $('setup-modal').hidden = true;
  closePanel();
  renderer.centerOn(GRID / 2, GRID - 9);
  await save();
  showPanel({ type: 'welcome' });
}

// ---------------------------------------------------------------------------
// Coaster design library (local for now; see docs/PERSISTENCE.md)
// ---------------------------------------------------------------------------

function loadDesigns() {
  try { return JSON.parse(localStorage.getItem('rcm.designs') || '[]').filter((d) => d && d.code); } catch { return []; }
}
function saveDesign(name, code) {
  const list = loadDesigns().filter((d) => d.code !== code);
  list.unshift({ name, code, savedAt: Date.now() });
  try { localStorage.setItem('rcm.designs', JSON.stringify(list.slice(0, 30))); } catch { /* storage unavailable */ }
}
function startImport(code) {
  const parsed = Sim.parseDesign(code);
  if (!parsed.ok) { toast(parsed.reason, 'warn'); return; }
  state.importCode = code;
  setTool('coaster-start');
  toast(`Click a grass tile to place "${parsed.design.name}" (${money(parsed.design.cost)}). X turns the station.`);
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

async function save({ keepalive = false } = {}) {
  if (state.saving) return;
  state.saving = true;
  try {
    const data = await sim.serialize();
    // Browsers cap keepalive bodies at 64KB; fall back to a normal request.
    const small = keepalive && JSON.stringify(data).length < 60_000;
    await api('/api/park', { method: 'PUT', body: data, keepalive: small });
    state.dirty = false;
    state.lastSave = Date.now();
  } catch (err) {
    if (err.status === 401) { location.href = '/'; return; }
    toast(`Save failed: ${err.message}`, 'warn');
  } finally {
    state.saving = false;
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const pointer = { x: 0, y: 0, down: false, pan: false, lastTile: null, startX: 0, startY: 0, moved: false };
const keys = new Set();

function tileAt(sx, sy) {
  const t = renderer.screenToTile(sx, sy);
  return { x: Math.floor(t.x), y: Math.floor(t.y) };
}

/** Tiles on a 4-connected line between a and b, so fast drags don't leave gaps. */
function lineTiles(a, b) {
  const out = [];
  let { x, y } = a;
  while (x !== b.x || y !== b.y) {
    if (Math.abs(b.x - x) >= Math.abs(b.y - y)) x += Math.sign(b.x - x);
    else y += Math.sign(b.y - y);
    out.push({ x, y });
  }
  return out;
}

function setSpeed(speed) {
  state.speed = speed;
  sim.setSpeed(speed);
  for (const b of document.querySelectorAll('.speed button')) b.classList.toggle('active', Number(b.dataset.speed) === speed);
}

function bindInput() {
  window.addEventListener('resize', () => renderer.resize());

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    Object.assign(pointer, { x: e.offsetX, y: e.offsetY, startX: e.offsetX, startY: e.offsetY, down: true, moved: false });
    const touchPan = e.pointerType === 'touch' && state.tool === 'inspect';
    pointer.pan = e.button === 1 || e.button === 2 || keys.has(' ') || touchPan;
    pointer.orbit = is3D && (e.button === 1 || (e.button === 2 && e.shiftKey));
    if (pointer.pan || e.button !== 0) return;
    const tile = tileAt(e.offsetX, e.offsetY);
    pointer.lastTile = tile;
    if (state.tool !== 'inspect') applyTool(tile);
  });
  canvas.addEventListener('pointermove', (e) => {
    const dx = e.offsetX - pointer.x, dy = e.offsetY - pointer.y;
    pointer.x = e.offsetX;
    pointer.y = e.offsetY;
    if (Math.abs(e.offsetX - pointer.startX) + Math.abs(e.offsetY - pointer.startY) > 4) pointer.moved = true;
    const tile = tileAt(e.offsetX, e.offsetY);
    state.hover = Sim.inBounds(tile.x, tile.y) ? tile : null;
    if (!pointer.down) return;
    if (pointer.orbit) { renderer.rotate(-dx * 0.008); renderer.tilt(dy * 0.006); return; }
    if (pointer.pan) { renderer.pan(dx, dy); return; }
    const paint = state.tool === 'path' || state.tool === 'bulldoze' || state.tool === 'build';
    if (paint && pointer.lastTile && (tile.x !== pointer.lastTile.x || tile.y !== pointer.lastTile.y)) {
      for (const t of lineTiles(pointer.lastTile, tile)) applyTool(t, { drag: true });
      pointer.lastTile = tile;
    }
  });
  const up = (e) => {
    if (pointer.down && !pointer.pan && !pointer.moved && state.tool === 'inspect' && e.button === 0) {
      applyTool(tileAt(e.offsetX, e.offsetY));
    }
    if (pointer.down && pointer.pan && !pointer.moved && e.pointerType === 'touch') {
      applyTool(tileAt(e.offsetX, e.offsetY)); // a tap in inspect mode
    }
    pointer.down = false;
    pointer.pan = false;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', () => { if (!pointer.down) state.hover = null; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    renderer.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.offsetX, e.offsetY);
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    keys.add(e.key);
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') { state.palette = null; state.importCode = null; setTool('inspect'); closePanel(); }
    else if (e.key === ' ') { e.preventDefault(); setSpeed(state.speed ? 0 : 1); }
    else if (k === '1') setSpeed(1);
    else if (k === '2') setSpeed(2);
    else if (k === '3') setSpeed(4);
    else if (k === 'p') { state.palette = 'path'; setTool('path'); }
    else if (k === 'b') { state.palette = null; setTool('bulldoze'); }
    else if (k === 'r') togglePalette('ride');
    else if (k === 'f') togglePalette('stall');
    else if (k === 't') togglePalette('scenery');
    else if (k === 'g') togglePalette('security');
    else if (k === '=' || k === '+') renderer.zoomAt(1.15, canvas.clientWidth / 2, canvas.clientHeight / 2);
    else if (k === '-') renderer.zoomAt(1 / 1.15, canvas.clientWidth / 2, canvas.clientHeight / 2);
    else if (k === 'q' && renderer.rotate) renderer.rotate(Math.PI / 8);
    else if (k === 'e' && renderer.rotate) renderer.rotate(-Math.PI / 8);
    else if (k === 'x' && state.tool === 'coaster-start') state.coasterDir = (state.coasterDir + 1) % 4;
    else if (e.key === 'Backspace' && state.builder) {
      e.preventDefault();
      act('removePiece', state.builder.id).then((res) => {
        if (res.removed) closePanel();
        refreshPanel(true);
      });
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key));
  setInterval(() => {
    const s = 12;
    if (keys.has('ArrowLeft') || keys.has('a')) renderer.pan(s, 0);
    if (keys.has('ArrowRight') || keys.has('d')) renderer.pan(-s, 0);
    if (keys.has('ArrowUp') || keys.has('w')) renderer.pan(0, s);
    if (keys.has('ArrowDown') || keys.has('s')) renderer.pan(0, -s);
  }, 16);

  for (const b of document.querySelectorAll('#toolbar button')) {
    b.addEventListener('click', () => {
      if (b.dataset.tool) { state.palette = b.dataset.tool === 'path' ? 'path' : null; setTool(b.dataset.tool); }
      else if (b.dataset.palette) togglePalette(b.dataset.palette);
      else if (b.dataset.panel === 'leaderboard') openLeaderboard();
      else if (b.dataset.panel === 'staff') showPanel({ type: 'staff_list' });
      else if (b.dataset.panel === 'park') showPanel({ type: 'park' });
      else if (b.dataset.panel === 'wanted') showPanel({ type: 'wanted' });
      else if (b.dataset.panel === 'tips') showPanel({ type: 'tips' });
      else if (b.dataset.panel === 'rules') showPanel({ type: 'rules' });
    });
  }
  for (const b of document.querySelectorAll('.speed button')) b.addEventListener('click', () => setSpeed(Number(b.dataset.speed)));
  $('park-name').addEventListener('click', () => showPanel({ type: 'park' }));
  document.querySelector('.panel-close').addEventListener('click', closePanel);
  $('lock-btn').addEventListener('click', toggleLock);
  $('custody-btn').addEventListener('click', () => { $('custody-modal').hidden = false; custodyKey = ''; updateCustody(); });
  $('save-btn').addEventListener('click', async () => { await save(); if (!state.dirty) toast('Park saved.'); });
  $('logout').addEventListener('click', async () => {
    if (state.dirty) await save();
    await api('/auth/logout', { method: 'POST' });
    location.href = '/';
  });
}

// Handy for debugging from the browser console.
window.mogul = { state, renderer, Sim, sim };

boot();
