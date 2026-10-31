import { api, money, el } from './api.js';
import { RIDES, STALLS, SCENERY, STAFF, SPECIAL, PANDEMONIUM, OBJECTIVES, PATH_COST, GRID, itemDef, itemCategory } from './catalog.js';
import * as Sim from './sim.js';
import { Renderer } from './render.js';

const STEP = 0.1; // fixed simulation step in game-seconds
const AUTOSAVE_MS = 45_000;

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const renderer = new Renderer(canvas);

const state = {
  park: null,
  me: null,
  speed: 1,
  tool: 'inspect',
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

  try {
    state.park = Sim.deserialize(await api('/api/park'));
  } catch (err) {
    if (err.status !== 404) toast(`Could not load your park (${err.message}). Starting fresh.`, 'warn');
    state.park = Sim.createPark(`${state.me.displayName.split(' ')[0]}'s Park`);
    state.dirty = true;
    showPanel({ type: 'welcome' });
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
let acc = 0;
let hudT = 0;
let animT = 0;

function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  const { park } = state;

  if (state.speed > 0) {
    acc += dt * state.speed;
    let steps = 0;
    while (acc >= STEP && steps < 60) {
      Sim.step(park, STEP);
      acc -= STEP;
      steps++;
    }
    if (steps) state.dirty = true;
    animT += dt * Math.min(state.speed, 2);
  }

  for (const ev of Sim.drainEvents(park)) toast(ev.text, ev.type);

  renderer.render(park, {
    time: animT,
    hover: state.hover,
    ghost: ghostFor(state.hover),
    tool: state.tool,
    selected: state.selected,
    dayProgress: Sim.dayProgress(park),
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
  $('s-day-bar').style.width = `${Sim.dayProgress(park) * 100}%`;

  const feed = $('thoughts');
  const pandas = park.raid ? Sim.activePandas(park).filter((g) => g.state !== 'downed').length : 0;
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
  const security = {
    securityhq: SPECIAL.securityhq, retribution: SPECIAL.retribution,
    camera: SCENERY.camera, lamp: SCENERY.lamp, firstaid: STALLS.firstaid,
  };
  const items = { ride: RIDES, stall: STALLS, scenery: SCENERY, security }[state.palette];
  box.replaceChildren(...Object.entries(items).map(([kind, def]) => {
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
    const res = Sim.buildPath(park, tile.x, tile.y);
    if (res.ok) renderer.floatText(tile.x + 0.5, tile.y + 0.5, `-$${PATH_COST}`, '#ffd9d9');
    else buildError(res);
  } else if (state.tool === 'bulldoze') {
    const res = Sim.bulldoze(park, tile.x, tile.y);
    if (res.ok) {
      if (res.refund) renderer.floatText(tile.x + 0.5, tile.y + 0.5, `+${money(res.refund)}`, '#c8ffc8');
      if (state.selected && !Sim.getObject(park, state.selected)) closePanel();
    } else if (!drag) buildError(res);
  } else if (state.tool === 'build') {
    const def = itemDef(state.buildKind);
    if (drag && (def.w > 1 || def.h > 1 || itemCategory(state.buildKind) !== 'scenery')) return;
    const { x, y } = anchorFor(def, tile);
    const res = Sim.build(park, state.buildKind, x, y);
    if (res.ok) {
      renderer.floatText(x + def.w / 2, y + def.h / 2, `-${money(def.cost)}`, '#ffd9d9');
      if (res.warn) toast(res.warn);
      renderPalette();
    } else if (!drag) buildError(res);
  } else if (state.tool === 'inspect') {
    inspect(tile);
    return;
  }
  state.dirty = true;
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
  const obj = Sim.objectAt(park, tile.x, tile.y);
  if (obj && itemCategory(obj.kind) === 'special') showPanel({ type: obj.kind, id: obj.id });
  else if (obj && itemCategory(obj.kind) !== 'scenery') showPanel({ type: 'object', id: obj.id });
  else if (obj) showPanel({ type: 'scenery', id: obj.id });
  else closePanel();
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function showPanel(panel) {
  state.panel = panel;
  state.selected = ['object', 'scenery', 'guest', 'staff', 'securityhq', 'retribution'].includes(panel.type) ? panel.id : null;
  $('panel').hidden = false;
  refreshPanel(true);
}

function closePanel() {
  state.panel = null;
  state.selected = null;
  $('panel').hidden = true;
}

let panelKey = '';
function refreshPanel(force = false) {
  const p = state.panel;
  if (!p) return;
  // Don't rebuild while the user is typing into an input inside the panel.
  if (!force && $('panel').contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
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

function hireStaff(role) {
  const res = Sim.hire(state.park, role);
  if (!res.ok) { toast(res.reason, 'warn'); return; }
  state.dirty = true;
  toast(`Hired ${res.staff.name}.`);
  refreshPanel(true);
}

const PANELS = {
  welcome: () => el('div', {},
    el('h2', {}, 'Welcome, Mogul!'),
    el('p', {}, `You've got ${money(state.park.cash)} and an empty field. Here's how to get started:`),
    el('ol', { class: 'small' },
      el('li', {}, 'Use 🟫 Path to extend the walkway from the entrance (click and drag).'),
      el('li', {}, 'Open 🎢 Rides and place a ride next to the path.'),
      el('li', {}, 'Add 🍔 Shops and restrooms so guests stay fed and comfortable.'),
      el('li', {}, 'Hire janitors, mechanics and security guards from 🧹 Staff.'),
      el('li', {}, 'Watch your Safety score: some visitors are thieves, brawlers or robbers.'),
      el('li', {}, 'Bulldoze trees to make room — and plant scenery to make guests happy.')),
    el('p', { class: 'small muted' }, 'Your park saves automatically to your account.'),
    el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', onclick: closePanel }, "Let's build!"))),

  object: ({ id }) => {
    const { park } = state;
    const o = Sim.getObject(park, id);
    if (!o) return null;
    const ride = RIDES[o.kind];
    const def = ride || STALLS[o.kind];
    const status = o.broken ? 'Broken down' : !o.open ? 'Closed' : ride ? (o.phase === 'running' ? 'Running' : 'Loading') : 'Open';
    return el('div', {},
      el('h2', {}, def.name),
      el('p', { class: 'muted small' }, ride ? `${ride.coaster ? 'Roller coaster' : 'Flat ride'} · ${status}` : `Shop · ${status}`),
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
      !FREE.has(def.sells) && el('h3', {}, 'Price'),
      !FREE.has(def.sells) && stepper(`$${o.price.toFixed(o.price % 1 ? 2 : 0)}`,
        () => { Sim.setPrice(park, id, o.price - 0.5); state.dirty = true; refreshPanel(true); },
        () => { Sim.setPrice(park, id, o.price + 0.5); state.dirty = true; refreshPanel(true); }),
      !FREE.has(def.sells) && el('p', { class: 'small muted' }, ride
        ? `Guests will typically pay up to about ${money(1.5 + ride.excitement * 1.05)}.`
        : 'Guests balk at overpriced food and drinks.'),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', onclick: () => { Sim.setOpen(park, id, !o.open); state.dirty = true; refreshPanel(true); } }, o.open ? 'Close' : 'Open'),
        el('button', { class: 'btn btn-danger', onclick: () => demolish(o) }, `Demolish (+${money(o.paid * 0.5)})`)));
  },

  scenery: ({ id }) => {
    const o = Sim.getObject(state.park, id);
    if (!o) return null;
    const def = SCENERY[o.kind];
    return el('div', {},
      el('h2', {}, def.name),
      el('p', { class: 'muted small' }, def.camera ? 'Discourages crime nearby and helps identify culprits, who may be stopped at the gate.'
        : def.lamp ? 'Lights the area at dusk, when crime is otherwise more likely.'
        : def.seat ? 'Tired guests sit here to rest.' : def.bin ? 'Guests nearby throw their litter away here.' : 'Pretty scenery makes nearby guests happier.'),
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
        el('div', { class: 'need' }, 'Health', bar((g.hp / PANDEMONIUM.hp) * 100, '#e5484d')),
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
      el('p', { class: 'muted small' }, doing),
      g.crime && g.spotted && el('p', { class: 'error small' }, `⚠ Wanted: ${{ pickpocket: 'pickpocketing', brawler: 'assault', robber: 'robbery' }[g.crime]}`),
      g.injured && el('p', { class: 'small' }, '🩹 Injured: looking for first aid'),
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
    const job = s.chase ? 'Chasing a suspect' : s.busy > 0 ? (s.role === 'janitor' ? 'Sweeping' : 'Fixing a ride') : s.task ? 'Heading to a broken ride' : 'Patrolling';
    return el('div', {},
      el('h2', {}, s.name),
      el('p', { class: 'muted small' }, `${STAFF[s.role].name} · ${job}`),
      kv([['Wage', `${money(STAFF[s.role].wage)}/day`]]),
      el('div', { class: 'actions' }, el('button', { class: 'btn btn-danger', onclick: () => { Sim.fire(state.park, id); state.dirty = true; closePanel(); } }, 'Fire')));
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
        ['Prisoners awaiting justice', park.captives.length],
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
      onclick: () => { Sim.setRigMode(park, id, m); state.dirty = true; refreshPanel(true); },
    }, label);
    return el('div', {},
      el('h2', {}, '⚖️ Retribution Rig'),
      el('p', { class: 'muted small' }, 'A siege catapult that hurls captured Pandemonium members at full speed into a roaring fire pit or a dunk tank they never surface from. Crowds pay to watch.'),
      el('h3', {}, 'Method'),
      el('div', { class: 'actions' }, mode('fire', '🔥 Fire pit'), mode('water', '🌊 Dunk tank')),
      el('h3', {}, `Prisoners (${park.captives.length})`),
      park.captives.length
        ? el('ul', { class: 'list' }, park.captives.map((c) => el('li', {}, `🐼 ${c.name}`)))
        : el('p', { class: 'small muted' }, show ? 'Show in progress.' : 'No prisoners. Defeat a Pandemonium raid to capture some.'),
      show && kv([['Now', `${show.victims[Math.min(show.victims.length - 1, Math.floor(show.t / PANDEMONIUM.showSecondsPerVictim))]}`], ['Spectators', show.spectators]]),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn btn-primary', disabled: !!show || !park.captives.length,
          onclick: () => {
            const res = Sim.execute(park, id, rig.pit);
            if (!res.ok) toast(res.reason, 'warn');
            state.dirty = true;
            refreshPanel(true);
          },
        }, 'Stage public execution'),
        el('button', { class: 'btn btn-danger', disabled: !!show, onclick: () => demolish(rig) }, 'Demolish')),
      el('p', { class: 'small muted' }, `Spectators pay ${money(PANDEMONIUM.spectatorFee)}. Afterwards every guest gets a big happiness boost and Safety is fully restored.`));
  },

  staff_list: () => {
    const { park } = state;
    return el('div', {},
      el('h2', {}, 'Staff'),
      el('p', { class: 'small muted' }, 'Janitors sweep up litter. Mechanics repair broken rides. Security guards deter crime and arrest suspects. Wages are paid daily.'),
      el('div', { class: 'actions' }, Object.entries(STAFF).map(([role, def]) =>
        el('button', { class: 'btn', onclick: () => hireStaff(role) },
          `Hire ${def.name} (${money(def.wage)}/day)`))),
      el('h3', {}, `Employees (${park.staff.length})`),
      park.staff.length
        ? el('ul', { class: 'list' }, park.staff.map((s) => el('li', {},
          el('span', {}, s.name),
          el('span', {},
            el('button', { class: 'btn btn-small', onclick: () => { renderer.centerOn(s.x, s.y); showPanel({ type: 'staff', id: s.id }); } }, 'Find'), ' ',
            el('button', { class: 'btn btn-small btn-danger', onclick: () => { Sim.fire(park, s.id); state.dirty = true; refreshPanel(true); } }, 'Fire')))))
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
        onchange: (e) => { Sim.renamePark(park, e.target.value); state.dirty = true; e.target.blur(); },
      }),
      el('h3', {}, 'Admission'),
      stepper(money(park.entranceFee),
        () => { Sim.setEntranceFee(park, park.entranceFee - 1); state.dirty = true; refreshPanel(true); },
        () => { Sim.setEntranceFee(park, park.entranceFee + 1); state.dirty = true; refreshPanel(true); }),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', onclick: () => { Sim.setParkOpen(park, !park.open); state.dirty = true; refreshPanel(true); } }, park.open ? 'Close park to new guests' : 'Open park')),
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
      el('h3', {}, `Today (day ${Sim.day(park)})`),
      kv([
        ['Admissions', money(t.admissions)],
        ['Ride tickets', money(t.rides)],
        ['Shops (net)', money(t.shops)],
        ['Construction (net)', money(t.construction)],
        ['Profit so far', money(t.income - t.expenses)],
      ]),
      hist.length > 0 && el('h3', {}, 'Recent days: income vs. expenses'),
      hist.length > 0 && el('div', { class: 'chart', title: 'Green: income · Red: expenses' }, hist.map((h) =>
        el('div', { class: 'col', title: `Day ${h.day}: +${money(h.income)} / -${money(h.expenses)}` },
          el('div', { class: 'inc', style: { height: `${(h.income / maxV) * 50}%` } }),
          el('div', { class: 'exp', style: { height: `${(h.expenses / maxV) * 50}%` } })))),
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

function demolish(o) {
  Sim.bulldoze(state.park, o.x, o.y);
  state.dirty = true;
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

async function newGame() {
  if (!confirm('Bulldoze everything and start a brand new park? This cannot be undone.')) return;
  await api('/api/park', { method: 'DELETE' });
  state.park = Sim.createPark(state.park.name);
  state.dirty = true;
  renderer.centerOn(GRID / 2, GRID - 9);
  await save();
  showPanel({ type: 'welcome' });
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

async function save({ keepalive = false } = {}) {
  if (state.saving) return;
  state.saving = true;
  try {
    const data = Sim.serialize(state.park);
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
    if (e.key === 'Escape') { state.palette = null; setTool('inspect'); closePanel(); }
    else if (e.key === ' ') { e.preventDefault(); setSpeed(state.speed ? 0 : 1); }
    else if (k === '1') setSpeed(1);
    else if (k === '2') setSpeed(2);
    else if (k === '3') setSpeed(4);
    else if (k === 'p') { state.palette = null; setTool('path'); }
    else if (k === 'b') { state.palette = null; setTool('bulldoze'); }
    else if (k === 'r') togglePalette('ride');
    else if (k === 'f') togglePalette('stall');
    else if (k === 't') togglePalette('scenery');
    else if (k === 'g') togglePalette('security');
    else if (k === '=' || k === '+') renderer.zoomAt(1.15, canvas.clientWidth / 2, canvas.clientHeight / 2);
    else if (k === '-') renderer.zoomAt(1 / 1.15, canvas.clientWidth / 2, canvas.clientHeight / 2);
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
      if (b.dataset.tool) { state.palette = null; setTool(b.dataset.tool); }
      else if (b.dataset.palette) togglePalette(b.dataset.palette);
      else if (b.dataset.panel === 'leaderboard') openLeaderboard();
      else if (b.dataset.panel === 'staff') showPanel({ type: 'staff_list' });
      else if (b.dataset.panel === 'park') showPanel({ type: 'park' });
    });
  }
  for (const b of document.querySelectorAll('.speed button')) b.addEventListener('click', () => setSpeed(Number(b.dataset.speed)));
  $('park-name').addEventListener('click', () => showPanel({ type: 'park' }));
  document.querySelector('.panel-close').addEventListener('click', closePanel);
  $('save-btn').addEventListener('click', async () => { await save(); if (!state.dirty) toast('Park saved.'); });
  $('logout').addEventListener('click', async () => {
    if (state.dirty) await save();
    await api('/auth/logout', { method: 'POST' });
    location.href = '/';
  });
}

// Handy for debugging from the browser console.
window.mogul = { state, renderer, Sim };

boot();
