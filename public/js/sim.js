// Theme park simulation. Pure logic with no DOM access, so it runs in the
// browser for gameplay and on the server for save validation and scoring.

import {
  GRID, DAY_SECONDS, START_CASH, PATH_COST, REFUND_RATE,
  RIDES, STALLS, SCENERY, STAFF, SPECIAL, OBJECTIVES, CRIME, PANDEMONIUM, itemDef, itemCategory,
} from './catalog.js';

export const TILE = { GRASS: 0, PATH: 1, ENTRANCE: 2 };
export const ENTRANCE = { x: GRID / 2, y: GRID - 1 };

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const GUEST_SPEED = 1.4; // tiles per game-second
const STAFF_SPEED = 1.7;
const MAX_GUESTS = 600;
const FIRST_NAMES = [
  'Ava', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jade', 'Kai', 'Lena', 'Milo',
  'Nia', 'Omar', 'Pia', 'Quinn', 'Rosa', 'Sami', 'Theo', 'Uma', 'Vik', 'Wren', 'Xan', 'Yara', 'Zed',
];
const SHIRTS = ['#e5484d', '#3e8ed0', '#f2b84b', '#7bd389', '#9b6bd6', '#ef6fa8', '#ffffff', '#2bb3a3', '#ff8a3d'];

export const idx = (x, y) => y * GRID + x;
export const inBounds = (x, y) => x >= 0 && y >= 0 && x < GRID && y < GRID;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Seeded PRNG (mulberry32) whose state is part of the save. */
function rand(park) {
  park.rngState = (park.rngState + 0x6d2b79f5) >>> 0;
  let t = park.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (park, arr) => arr[Math.floor(rand(park) * arr.length)];

// ---------------------------------------------------------------------------
// Creation, indexing, persistence
// ---------------------------------------------------------------------------

export function createPark(name = 'New Park', seed = Date.now()) {
  const park = {
    version: 1,
    name: String(name).slice(0, 40),
    rngState: seed >>> 0,
    time: 0,
    cash: START_CASH,
    entranceFee: 10,
    open: true,
    rating: 500,
    safety: 100,
    nextId: 1,
    tiles: new Array(GRID * GRID).fill(TILE.GRASS),
    litter: new Array(GRID * GRID).fill(0),
    stains: new Array(GRID * GRID).fill(0),
    objects: [],
    guests: [],
    staff: [],
    stats: { totalGuests: 0, peakGuests: 0, arrests: 0, crimes: 0, today: newLedger(), history: [] },
    thoughts: [],
    incidents: [],
    objectives: [],
    raid: null,
    captives: [],
    pandemonium: newPandaStats(),
  };
  park.tiles[idx(ENTRANCE.x, ENTRANCE.y)] = TILE.ENTRANCE;
  for (let y = ENTRANCE.y - 1; y >= ENTRANCE.y - 6; y--) park.tiles[idx(ENTRANCE.x, y)] = TILE.PATH;

  rebuildIndex(park);
  // Scatter some free starting trees away from the entrance.
  for (let i = 0; i < 140; i++) {
    const x = Math.floor(rand(park) * GRID);
    const y = Math.floor(rand(park) * GRID);
    if (Math.abs(x - ENTRANCE.x) < 5 && y > GRID - 10) continue;
    if (canPlace(park, 'tree', x, y).ok) {
      addObject(park, rand(park) < 0.5 ? 'tree' : 'pine', x, y, 0);
    }
  }
  return park;
}

function newPandaStats() {
  return { raids: 0, defeated: 0, escaped: 0, captured: 0, executions: 0, nextRaidDay: PANDEMONIUM.firstRaidDay };
}

function newLedger() {
  return { income: 0, expenses: 0, admissions: 0, rides: 0, shops: 0, wages: 0, upkeep: 0, construction: 0, crime: 0, shows: 0, crimeCount: 0 };
}

/** Rebuilds transient lookup tables (anything prefixed with `_`). */
function rebuildIndex(park) {
  park._objAt = new Int32Array(GRID * GRID);
  park._byId = new Map();
  for (const obj of park.objects) {
    for (let y = obj.y; y < obj.y + obj.h; y++) {
      for (let x = obj.x; x < obj.x + obj.w; x++) {
        if (!inBounds(x, y)) throw new Error('object out of bounds');
        const i = idx(x, y);
        if (park._objAt[i] || park.tiles[i] !== TILE.GRASS) throw new Error('overlapping objects');
        park._objAt[i] = obj.id;
      }
    }
    park._byId.set(obj.id, obj);
  }
  park._guestById = new Map(park.guests.map((g) => [g.id, g]));
  park._events = park._events || [];
  refreshAccess(park);
}

/** Recomputes which path tiles touch each object. */
function refreshAccess(park) {
  for (const obj of park.objects) {
    const access = [];
    for (let y = obj.y - 1; y <= obj.y + obj.h; y++) {
      for (let x = obj.x - 1; x <= obj.x + obj.w; x++) {
        const edge = x === obj.x - 1 || x === obj.x + obj.w;
        const edgeY = y === obj.y - 1 || y === obj.y + obj.h;
        if (edge === edgeY) continue; // skip interior and diagonal corners
        if (inBounds(x, y) && park.tiles[idx(x, y)] === TILE.PATH) access.push(idx(x, y));
      }
    }
    obj._access = access;
  }
  for (const a of [...park.guests, ...park.staff]) a.route = null;
}

export function serialize(park) {
  const data = JSON.parse(JSON.stringify(park, (k, v) => (k.startsWith('_') ? undefined : v)));
  data.tiles = park.tiles.join('');
  data.litter = park.litter.join('');
  data.stains = park.stains.join('');
  for (const a of [...data.guests, ...data.staff]) delete a.route;
  return data;
}

const num = (v, lo, hi, fallback = lo) => (Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
const okPos = (a) => Number.isInteger(a.x) && Number.isInteger(a.y) && inBounds(a.x, a.y)
  && Number.isInteger(a.nx) && Number.isInteger(a.ny) && inBounds(a.nx, a.ny);

/** Validates untrusted save data and returns a live park. Throws on bad input. */
export function deserialize(data) {
  if (!data || typeof data !== 'object') throw new Error('not an object');
  if (data.version !== 1) throw new Error('unsupported version');
  const n = GRID * GRID;
  if (typeof data.tiles !== 'string' || !new RegExp(`^[0-2]{${n}}$`).test(data.tiles)) throw new Error('bad tiles');
  if (typeof data.litter !== 'string' || !new RegExp(`^[0-5]{${n}}$`).test(data.litter)) throw new Error('bad litter');
  if (!Array.isArray(data.objects) || data.objects.length > n) throw new Error('bad objects');
  if (!Array.isArray(data.guests) || data.guests.length > MAX_GUESTS * 2) throw new Error('bad guests');
  if (!Array.isArray(data.staff) || data.staff.length > 200) throw new Error('bad staff');

  const park = createEmpty();
  park.name = String(data.name ?? 'My Park').slice(0, 40) || 'My Park';
  park.rngState = num(data.rngState, 0, 0xffffffff) >>> 0;
  park.time = num(data.time, 0, 1e9);
  park.cash = num(data.cash, -1e9, 1e10);
  park.entranceFee = Math.round(num(data.entranceFee, 0, 100, 10));
  park.open = data.open !== false;
  park.rating = num(data.rating, 0, 999, 500);
  park.safety = num(data.safety, 0, 100, 100);
  park.tiles = [...data.tiles].map(Number);
  park.litter = [...data.litter].map(Number);
  park.stains = typeof data.stains === 'string' && new RegExp(`^[0-3]{${n}}$`).test(data.stains)
    ? [...data.stains].map(Number) : new Array(n).fill(0);
  if (park.tiles[idx(ENTRANCE.x, ENTRANCE.y)] !== TILE.ENTRANCE) throw new Error('entrance missing');

  let maxId = 0;
  const seen = new Set();
  const ensureId = (id) => {
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) throw new Error('bad id');
    seen.add(id);
    maxId = Math.max(maxId, id);
  };

  const pendingCaptives = [];
  for (const o of data.objects) {
    const def = itemDef(o?.kind);
    if (!def) throw new Error('unknown object kind');
    ensureId(o.id);
    if (!Number.isInteger(o.x) || !Number.isInteger(o.y)) throw new Error('bad object position');
    if (o.kind === 'retribution') {
      // An interrupted show returns its prisoners to custody.
      for (const v of Array.isArray(o.show?.victims) ? o.show.victims.slice(0, 50) : []) pendingCaptives.push(String(v).slice(0, 30));
    }
    park.objects.push(makeObject(o.kind, o.id, o.x, o.y, num(o.paid, 0, def.cost, 0), {
      price: num(o.price, 0, 50, def.price ?? 0),
      open: o.open !== false,
      broken: o.broken === true,
      stats: { riders: num(o.stats?.riders, 0, 1e9), revenue: num(o.stats?.revenue, 0, 1e10) },
      ...(o.kind === 'retribution' ? { pit: o.pit === 'water' ? 'water' : 'fire', show: null } : {}),
    }));
  }
  for (const g of data.guests) {
    if (!g || !okPos(g)) continue;
    ensureId(g.id);
    park.guests.push({
      ...newGuestStats(),
      id: g.id, name: String(g.name ?? 'Guest').slice(0, 20), shirt: String(g.shirt ?? '#fff').slice(0, 9),
      x: g.x, y: g.y, nx: g.nx, ny: g.ny, lx: g.x, ly: g.y, t: num(g.t, 0, 1),
      cash: num(g.cash, 0, 1000), happy: num(g.happy, 0, 100), hunger: num(g.hunger, 0, 100),
      thirst: num(g.thirst, 0, 100), bladder: num(g.bladder, 0, 100), energy: num(g.energy, 0, 100),
      nausea: num(g.nausea, 0, 100), pref: num(g.pref, 1, 10, 5), thrift: num(g.thrift, 0, 1, 0.5),
      timeIn: num(g.timeIn, 0, 1e6), leaving: g.leaving === true,
      rides: num(g.rides, 0, 1e4),
      crime: CRIME.types[g.crime] || g.crime === 'panda' ? g.crime : null,
      hp: num(g.hp, 0, PANDEMONIUM.hp, PANDEMONIUM.hp),
      crimeT: num(g.crimeT, 0, 1e4, 20),
      crimes: num(g.crimes, 0, 100),
      loot: num(g.loot, 0, 1e7),
      heistLoot: g.heistLoot === true,
      spotted: g.spotted === true,
      injured: g.injured === true,
      // Riders/queuers resume walking; ride state is not persisted.
      state: 'walk',
    });
    const last = park.guests[park.guests.length - 1];
    if (last.crime === 'panda' && last.hp <= 0) last.hp = 1;
  }
  for (const s of data.staff) {
    if (!s || !STAFF[s.role] || !okPos(s)) continue;
    ensureId(s.id);
    park.staff.push({ ...newStaff(s.role, s.id, s.x, s.y), nx: s.nx, ny: s.ny, name: String(s.name ?? '').slice(0, 40) });
  }
  park.nextId = Math.max(maxId + 1, Number.isInteger(data.nextId) ? data.nextId : 0);

  const st = data.stats || {};
  park.stats.totalGuests = num(st.totalGuests, 0, 1e9);
  park.stats.peakGuests = num(st.peakGuests, 0, 1e6);
  park.stats.arrests = num(st.arrests, 0, 1e9);
  park.stats.crimes = num(st.crimes, 0, 1e9);
  if (st.today && typeof st.today === 'object') {
    for (const k of Object.keys(park.stats.today)) park.stats.today[k] = num(st.today[k], -1e10, 1e10, 0);
  }
  if (Array.isArray(st.history)) {
    park.stats.history = st.history.slice(-30).map((h) => ({
      day: num(h?.day, 0, 1e7), income: num(h?.income, -1e10, 1e10), expenses: num(h?.expenses, -1e10, 1e10),
      guests: num(h?.guests, 0, 1e6), crimes: num(h?.crimes, 0, 1e6),
    }));
  }
  if (Array.isArray(data.thoughts)) {
    park.thoughts = data.thoughts.slice(0, 25).map((t) => ({
      text: String(t?.text ?? '').slice(0, 120), who: String(t?.who ?? '').slice(0, 20), day: num(t?.day, 0, 1e7),
    }));
  }
  if (Array.isArray(data.incidents)) {
    park.incidents = data.incidents.slice(0, 30).map((t) => ({
      type: ['theft', 'assault', 'heist', 'homicide', 'arrest', 'raid', 'execution'].includes(t?.type) ? t.type : 'theft',
      text: String(t?.text ?? '').slice(0, 160), day: num(t?.day, 0, 1e7),
    }));
  }
  if (Array.isArray(data.captives)) {
    park.captives = data.captives.slice(0, 50).map((c) => ({ name: String(c?.name ?? 'Panda').slice(0, 30) }));
  }
  park.captives.push(...pendingCaptives.map((name) => ({ name })));
  const pd = data.pandemonium || {};
  for (const k of Object.keys(park.pandemonium)) park.pandemonium[k] = num(pd[k], 0, 1e7, park.pandemonium[k]);
  if (data.raid && typeof data.raid === 'object' && park.guests.some((g) => g.crime === 'panda')) {
    park.raid = {
      startedAt: num(data.raid.startedAt, 0, park.time), size: num(data.raid.size, 0, 50),
      captured: num(data.raid.captured, 0, 50), escaped: num(data.raid.escaped, 0, 50), loot: num(data.raid.loot, 0, 1e9),
    };
  } else {
    park.guests = park.guests.filter((g) => g.crime !== 'panda');
  }
  if (Array.isArray(data.objectives)) {
    const valid = new Set(OBJECTIVES.map((o) => o.id));
    park.objectives = data.objectives.filter((id) => valid.has(id));
  }

  rebuildIndex(park);
  return park;
}

function createEmpty() {
  return {
    version: 1, name: '', rngState: 1, time: 0, cash: 0, entranceFee: 10, open: true, rating: 500, safety: 100, nextId: 1,
    tiles: [], litter: [], stains: [], objects: [], guests: [], staff: [], raid: null, captives: [], pandemonium: newPandaStats(),
    stats: { totalGuests: 0, peakGuests: 0, arrests: 0, crimes: 0, today: newLedger(), history: [] },
    thoughts: [], incidents: [], objectives: [],
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const walkable = (park, i) => park.tiles[i] === TILE.PATH || park.tiles[i] === TILE.ENTRANCE;
export const objectAt = (park, x, y) => (inBounds(x, y) ? park._byId.get(park._objAt[idx(x, y)]) || null : null);
export const getObject = (park, id) => park._byId.get(id) || null;
export const day = (park) => Math.floor(park.time / DAY_SECONDS) + 1;
export const dayProgress = (park) => (park.time % DAY_SECONDS) / DAY_SECONDS;

export function guestAt(park, fx, fy, radius = 0.45) {
  let best = null;
  let bestD = radius * radius;
  for (const g of park.guests) {
    if (g.state === 'ride') continue;
    const p = actorPos(g);
    const d = (p.x - fx) ** 2 + (p.y - fy) ** 2;
    if (d < bestD) { bestD = d; best = g; }
  }
  return best;
}

/** Continuous tile-space position of a guest or staff member (tile centre = +0.5). */
export function actorPos(a) {
  return { x: a.x + (a.nx - a.x) * a.t + 0.5, y: a.y + (a.ny - a.y) * a.t + 0.5 };
}

export function parkStats(park) {
  let rides = 0, coasters = 0, stalls = 0, assets = 0, excitement = 0, broken = 0, beauty = 0;
  for (const o of park.objects) {
    assets += o.paid;
    const cat = itemCategory(o.kind);
    if (cat === 'ride') {
      rides++;
      if (RIDES[o.kind].coaster) coasters++;
      if (o.open) excitement += RIDES[o.kind].excitement;
      if (o.broken) broken++;
    } else if (cat === 'stall') stalls++;
    else if (cat === 'scenery') beauty += SCENERY[o.kind].beauty;
  }
  let litter = 0, stains = 0;
  for (const l of park.litter) litter += l;
  for (const b of park.stains) stains += b;
  let happy = 0;
  for (const g of park.guests) happy += g.happy;
  return {
    rides, coasters, stalls, broken, excitement, beauty, litter,
    guards: park.staff.filter((s) => s.role === 'guard').length,
    arrests: park.stats.arrests,
    safety: Math.round(park.safety),
    stains,
    raidsDefeated: park.pandemonium.defeated,
    executions: park.pandemonium.executions,
    guests: park.guests.length,
    avgHappy: park.guests.length ? happy / park.guests.length : 0,
    rating: Math.round(park.rating),
    value: Math.round(park.cash + assets * 0.8),
  };
}

export function parkSummary(park) {
  const s = parkStats(park);
  return { name: park.name, value: s.value, rating: s.rating, guests: s.guests, day: day(park) };
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export function canPlace(park, kind, x, y) {
  const def = itemDef(kind);
  if (!def) return { ok: false, reason: 'Unknown item' };
  for (let yy = y; yy < y + def.h; yy++) {
    for (let xx = x; xx < x + def.w; xx++) {
      if (!inBounds(xx, yy)) return { ok: false, reason: 'Out of bounds' };
      const i = idx(xx, yy);
      if (park.tiles[i] !== TILE.GRASS) return { ok: false, reason: 'Blocked by path' };
      if (park._objAt[i]) return { ok: false, reason: 'Something is in the way' };
    }
  }
  if (park.cash < def.cost) return { ok: false, reason: 'Not enough cash', cash: true };
  return { ok: true };
}

function makeObject(kind, id, x, y, paid, extra = {}) {
  const def = itemDef(kind);
  const obj = { id, kind, x, y, w: def.w, h: def.h, paid };
  const cat = itemCategory(kind);
  if (cat === 'ride' || cat === 'stall') {
    Object.assign(obj, { price: def.price, open: true, broken: false, stats: { riders: 0, revenue: 0 } });
  }
  if (cat === 'ride') Object.assign(obj, { phase: 'idle', timer: 0, wait: 0, queue: [], riders: [] });
  if (kind === 'retribution') Object.assign(obj, { pit: 'fire', show: null });
  return Object.assign(obj, extra);
}

function addObject(park, kind, x, y, paid) {
  const obj = makeObject(kind, park.nextId++, x, y, paid);
  park.objects.push(obj);
  park._byId.set(obj.id, obj);
  for (let yy = y; yy < y + obj.h; yy++) for (let xx = x; xx < x + obj.w; xx++) park._objAt[idx(xx, yy)] = obj.id;
  refreshAccess(park);
  return obj;
}

export function build(park, kind, x, y) {
  const check = canPlace(park, kind, x, y);
  if (!check.ok) return check;
  const def = itemDef(kind);
  spend(park, def.cost, 'construction');
  const obj = addObject(park, kind, x, y, def.cost);
  const cat = itemCategory(kind);
  const warn = cat !== 'scenery' && obj._access.length === 0 ? 'Connect it to a path so guests can reach it.' : null;
  return { ok: true, obj, warn };
}

export function buildPath(park, x, y) {
  if (!inBounds(x, y)) return { ok: false, reason: 'Out of bounds' };
  const i = idx(x, y);
  if (park.tiles[i] !== TILE.GRASS) return { ok: false, reason: 'Already a path', silent: true };
  if (park._objAt[i]) return { ok: false, reason: 'Something is in the way' };
  if (park.cash < PATH_COST) return { ok: false, reason: 'Not enough cash', cash: true };
  spend(park, PATH_COST, 'construction');
  park.tiles[i] = TILE.PATH;
  refreshAccess(park);
  return { ok: true };
}

export function bulldoze(park, x, y) {
  if (!inBounds(x, y)) return { ok: false, reason: 'Out of bounds' };
  const i = idx(x, y);
  const obj = objectAt(park, x, y);
  if (obj) {
    removeObject(park, obj);
    return { ok: true, refund: Math.round(obj.paid * REFUND_RATE) };
  }
  if (park.tiles[i] === TILE.ENTRANCE) return { ok: false, reason: "You can't remove the entrance" };
  if (park.tiles[i] === TILE.PATH) {
    park.tiles[i] = TILE.GRASS;
    park.litter[i] = 0;
    refreshAccess(park);
    return { ok: true, refund: 0 };
  }
  return { ok: false, reason: 'Nothing to remove', silent: true };
}

function removeObject(park, obj) {
  if (obj.queue) for (const gid of [...obj.queue, ...obj.riders]) releaseGuest(park, park._guestById.get(gid));
  for (const s of park.staff) if (s.task === obj.id) s.task = null;
  for (let yy = obj.y; yy < obj.y + obj.h; yy++) for (let xx = obj.x; xx < obj.x + obj.w; xx++) park._objAt[idx(xx, yy)] = 0;
  park.objects.splice(park.objects.indexOf(obj), 1);
  park._byId.delete(obj.id);
  const refund = Math.round(obj.paid * REFUND_RATE);
  if (refund) earn(park, refund, 'construction');
  refreshAccess(park);
}

export function setPrice(park, id, price) {
  const obj = getObject(park, id);
  if (obj && 'price' in obj) obj.price = clamp(Math.round(price * 2) / 2, 0, 50);
}

export function setOpen(park, id, open) {
  const obj = getObject(park, id);
  if (!obj || !('open' in obj)) return;
  obj.open = open;
  if (!open && obj.queue) for (const gid of obj.queue.splice(0)) releaseGuest(park, park._guestById.get(gid));
}

export function setEntranceFee(park, fee) { park.entranceFee = clamp(Math.round(fee), 0, 100); }
export function setParkOpen(park, open) { park.open = !!open; }
export function renamePark(park, name) { park.name = String(name).trim().slice(0, 40) || park.name; }

export function hire(park, role) {
  if (!STAFF[role]) return { ok: false, reason: 'Unknown role' };
  if (park.staff.length >= 200) return { ok: false, reason: 'Too many staff' };
  const req = STAFF[role].requires;
  const base = req ? park.objects.find((o) => o.kind === req) : null;
  if (req && !base) return { ok: false, reason: `Build a ${itemDef(req).name} first.` };
  const start = base?._access[0];
  const s = start !== undefined
    ? newStaff(role, park.nextId++, start % GRID, (start / GRID) | 0)
    : newStaff(role, park.nextId++, ENTRANCE.x, ENTRANCE.y - 1);
  s.name = `${pick(park, FIRST_NAMES)} the ${STAFF[role].name}`;
  park.staff.push(s);
  return { ok: true, staff: s };
}

export function fire(park, id) {
  const i = park.staff.findIndex((s) => s.id === id);
  if (i >= 0) park.staff.splice(i, 1);
}

function newStaff(role, id, x, y) {
  return { id, role, name: '', x, y, nx: x, ny: y, lx: x, ly: y, t: 0, route: null, task: null, busy: 0, chase: null, cool: 0 };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

function earn(park, amount, category) {
  park.cash += amount;
  const t = park.stats.today;
  t.income += amount;
  t[category] = (t[category] || 0) + amount;
}

function spend(park, amount, category) {
  park.cash -= amount;
  const t = park.stats.today;
  t.expenses += amount;
  t[category] = (t[category] || 0) - amount;
}

// ---------------------------------------------------------------------------
// Pathfinding
// ---------------------------------------------------------------------------

function bfs(park, start, allowEntrance = false) {
  const n = GRID * GRID;
  const dist = new Int16Array(n).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  queue[tail++] = start;
  dist[start] = 0;
  while (head < tail) {
    const c = queue[head++];
    const cx = c % GRID, cy = (c / GRID) | 0;
    for (const [dx, dy] of DIRS) {
      const x = cx + dx, y = cy + dy;
      if (!inBounds(x, y)) continue;
      const i = idx(x, y);
      if (dist[i] >= 0 || !walkable(park, i)) continue;
      if (!allowEntrance && park.tiles[i] === TILE.ENTRANCE) continue;
      dist[i] = dist[c] + 1;
      prev[i] = c;
      queue[tail++] = i;
    }
  }
  return { dist, prev };
}

function traceRoute(prev, start, goal) {
  const route = [];
  for (let c = goal; c !== start; c = prev[c]) {
    if (c < 0) return null;
    route.push(c);
  }
  return route.reverse();
}

/** Nearest access tile of `obj` from a BFS result, or null if unreachable. */
function nearestAccess(obj, dist) {
  let best = null;
  for (const a of obj._access) if (dist[a] >= 0 && (best === null || dist[a] < dist[best])) best = a;
  return best;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export function step(park, dt) {
  const prevDay = day(park);
  park.time += dt;

  spawnGuests(park, dt);
  for (const g of park.guests) updateGuest(park, g, dt);
  for (const obj of park.objects) {
    if (obj.queue) updateRide(park, obj, dt);
    else if (obj.show) updateShow(park, obj, dt);
  }
  for (const s of park.staff) updateStaff(park, s, dt);

  if (park.guests.some((g) => g.gone)) {
    park.guests = park.guests.filter((g) => !g.gone);
    park._guestById = new Map(park.guests.map((g) => [g.id, g]));
  }

  park.safety = Math.min(100, park.safety + CRIME.safetyRecovery * dt);
  park._slowT = (park._slowT || 0) + dt;
  if (park._slowT >= 1) {
    park._slowT = 0;
    checkRaidOver(park);
    updateRating(park);
    checkObjectives(park);
  }
  if (day(park) !== prevDay) endDay(park, prevDay);
}

function spawnGuests(park, dt) {
  if (!park.open) return;
  const s = parkStats(park);
  const attraction = 0.06 + s.rides * 0.07 + s.stalls * 0.01 + s.excitement * 0.012;
  const ratingF = 0.4 + (park.rating / 1000) * 1.2;
  const feeF = clamp(1 - (park.entranceFee - (6 + s.excitement * 0.8)) / 40, 0.03, 1.3);
  const cap = Math.min(MAX_GUESTS, 30 + s.rides * 35 + s.stalls * 5);
  const crowd = park.guests.length >= cap ? 0.05 : 1;
  const safetyF = 0.5 + park.safety / 200;
  park._spawnAcc = (park._spawnAcc || 0) + attraction * ratingF * feeF * safetyF * crowd * dt;
  while (park._spawnAcc >= 1) {
    park._spawnAcc -= 1;
    spawnGuest(park);
  }
}

function newGuestStats() {
  return {
    state: 'walk', target: null, route: null, busy: 0, queueT: 0, queueAt: -1,
    thought: '', thoughtT: 0, litterT: 0, decideIn: 0, ridden: {}, rides: 0, gone: false, leaving: false,
    crime: null, crimeT: 0, crimes: 0, loot: 0, heistLoot: false, heist: null, spotted: false, injured: false,
  };
}

function spawnGuest(park) {
  const cash = Math.round(25 + rand(park) * 100);
  if (cash < park.entranceFee) return;
  const g = {
    ...newGuestStats(),
    id: park.nextId++,
    name: `${pick(park, FIRST_NAMES)} ${String.fromCharCode(65 + Math.floor(rand(park) * 26))}.`,
    shirt: pick(park, SHIRTS),
    x: ENTRANCE.x, y: ENTRANCE.y, nx: ENTRANCE.x, ny: ENTRANCE.y - 1, lx: ENTRANCE.x, ly: ENTRANCE.y, t: 0,
    cash: cash - park.entranceFee,
    happy: 60 + rand(park) * 25,
    hunger: rand(park) * 40,
    thirst: rand(park) * 40,
    bladder: rand(park) * 30,
    energy: 70 + rand(park) * 30,
    nausea: 0,
    pref: 1 + Math.floor(rand(park) * 10), // max ride intensity they enjoy
    thrift: rand(park),
    timeIn: 0,
  };
  if (!walkable(park, idx(g.nx, g.ny))) return;
  const crimeRate = CRIME.baseRate + (park.rating < 400 ? CRIME.lowRatingRate : 0);
  if (rand(park) < crimeRate) {
    let r = rand(park);
    for (const [type, share] of Object.entries(CRIME.types)) {
      g.crime = type;
      if ((r -= share) < 0) break;
    }
    g.crimeT = 15 + rand(park) * 30;
  }
  if (park.entranceFee) earn(park, park.entranceFee, 'admissions');
  park.guests.push(g);
  park._guestById.set(g.id, g);
  park.stats.totalGuests++;
  park.stats.peakGuests = Math.max(park.stats.peakGuests, park.guests.length);
}

function think(park, g, text, force = false) {
  if (g.thoughtT > 0 && !force) return;
  g.thought = text;
  g.thoughtT = 12;
  if (rand(park) < 0.3 || force) {
    park.thoughts.unshift({ text, who: g.name, day: day(park) });
    if (park.thoughts.length > 25) park.thoughts.length = 25;
  }
}

function startLeaving(park, g, reason) {
  if (g.leaving) return;
  g.leaving = true;
  g.target = null;
  g.route = null;
  if (reason) think(park, g, reason);
}

function releaseGuest(park, g) {
  if (!g) return;
  g.state = 'walk';
  const at = g.queueAt;
  if (at >= 0 && walkable(park, at)) {
    g.x = g.nx = at % GRID;
    g.y = g.ny = (at / GRID) | 0;
    g.t = 0;
  } else {
    g.gone = true;
  }
}

function updateGuest(park, g, dt) {
  if (g.crime === 'panda') return updatePanda(park, g, dt);
  g.timeIn += dt;
  g.thoughtT -= dt;
  const pace = g.state === 'ride' ? 0.3 : 1;
  g.hunger = Math.min(100, g.hunger + 0.42 * dt * pace);
  g.thirst = Math.min(100, g.thirst + 0.5 * dt * pace);
  g.bladder = Math.min(100, g.bladder + 0.28 * dt * pace);
  g.energy = Math.max(0, g.energy - 0.18 * dt * pace);
  g.nausea = Math.max(0, g.nausea - 1.2 * dt);

  let drain = 0;
  if (g.hunger > 85) { drain += 0.5; if (rand(park) < 0.02) think(park, g, "I'm starving!"); }
  if (g.thirst > 85) { drain += 0.5; if (rand(park) < 0.02) think(park, g, "I'm so thirsty."); }
  if (g.bladder > 90) { drain += 0.8; if (rand(park) < 0.02) think(park, g, 'I really need a restroom!'); }
  if (g.nausea > 60) { drain += 0.4; if (rand(park) < 0.02) think(park, g, 'I feel sick...'); }
  if (g.energy < 20) drain += 0.2;
  g.happy = clamp(g.happy - drain * dt, 0, 100);

  if (g.litterT > 0) {
    g.litterT -= dt;
    if (g.litterT <= 0) dropLitter(park, g.x, g.y);
  }

  if (g.heist && !g.target) { g.heist = null; g.crimeT = 10; } // heist target became unreachable
  if (g.crime && !g.leaving && g.state === 'walk') {
    g.crimeT -= dt;
    if (g.crimeT <= 0) planCrime(park, g);
  }

  if (g.state === 'walk') walkGuest(park, g, dt);
  else if (g.state === 'queue') {
    g.queueT += dt;
    g.happy = Math.max(0, g.happy - 0.08 * dt);
    if (g.queueT > 45) {
      const ride = park.objects.find((o) => o.queue?.includes(g.id));
      if (ride) ride.queue.splice(ride.queue.indexOf(g.id), 1);
      releaseGuest(park, g);
      g.happy -= 8;
      think(park, g, `I've waited too long for ${ride ? RIDES[ride.kind].name : 'this ride'}.`);
    }
  } else if (g.state === 'busy' || g.state === 'sit') {
    g.busy -= dt;
    if (g.state === 'sit') g.energy = Math.min(100, g.energy + 7 * dt);
    if (g.busy <= 0) g.state = 'walk';
  }
}

function dropLitter(park, x, y) {
  for (let yy = y - 1; yy <= y + 1; yy++) {
    for (let xx = x - 1; xx <= x + 1; xx++) {
      const o = objectAt(park, xx, yy);
      if (o && SCENERY[o.kind]?.bin) return;
    }
  }
  const i = idx(x, y);
  if (park.tiles[i] === TILE.PATH && rand(park) < 0.75) park.litter[i] = Math.min(5, park.litter[i] + 1);
}

function moveActor(park, a, dt, speed) {
  if (a.nx === a.x && a.ny === a.y) return true; // standing still: ready for a decision
  if (!walkable(park, idx(a.nx, a.ny))) { a.nx = a.x; a.ny = a.y; a.t = 0; return true; }
  a.t += speed * dt;
  if (a.t < 1) return false;
  a.lx = a.x; a.ly = a.y;
  a.x = a.nx; a.y = a.ny;
  a.t = 0;
  return true;
}

/** Sets the next tile from the route, or wanders. Returns false if stuck. */
function advance(park, a, allowEntrance = false) {
  if (a.route?.length) {
    const n = a.route.shift();
    const nx = n % GRID, ny = (n / GRID) | 0;
    if (Math.abs(nx - a.x) + Math.abs(ny - a.y) === 1 && walkable(park, n)) {
      a.nx = nx; a.ny = ny;
      return true;
    }
    a.route = null;
  }
  const options = [];
  for (const [dx, dy] of DIRS) {
    const x = a.x + dx, y = a.y + dy;
    if (!inBounds(x, y)) continue;
    const i = idx(x, y);
    if (!walkable(park, i) || (!allowEntrance && park.tiles[i] === TILE.ENTRANCE)) continue;
    options.push([x, y]);
  }
  if (!options.length) { a.nx = a.x; a.ny = a.y; return false; }
  const forward = options.filter(([x, y]) => x !== a.lx || y !== a.ly);
  const [x, y] = pick(park, forward.length ? forward : options);
  a.nx = x; a.ny = y;
  return true;
}

function walkGuest(park, g, dt) {
  if (!moveActor(park, g, dt, GUEST_SPEED * (g.energy < 20 ? 0.6 : 1))) return;
  const here = idx(g.x, g.y);
  if (!walkable(park, here)) { g.gone = true; return; }
  if (g.nx !== g.x || g.ny !== g.y) return;
  onArrive(park, g, here);
  if (g.gone || g.state !== 'walk') return;
  decide(park, g, here);
}

function onArrive(park, g, here) {
  if (park.tiles[here] === TILE.ENTRANCE && g.leaving) {
    if (g.crime && g.spotted && rand(park) < CRIME.gateArrestChance) arrest(park, g, 'park security at the gate');
    g.gone = true;
    return;
  }
  const blood = park.stains[here];
  if (blood) {
    g.happy = Math.max(0, g.happy - blood * 1.5);
    if (rand(park) < 0.2) think(park, g, blood >= 3 ? "There's blood everywhere. What happened here?!" : 'Is that... blood?!');
  }
  if (park.safety < 50 && !g.crime && rand(park) < 0.01) {
    g.happy = Math.max(0, g.happy - 3);
    think(park, g, "I don't feel safe in this park.");
  }
  const litter = park.litter[here];
  if (litter) {
    g.happy = Math.max(0, g.happy - litter * 0.8);
    if (litter >= 2 && rand(park) < 0.15) think(park, g, 'This path is disgusting.');
  }
  // Nearby scenery cheers guests up.
  let beauty = 0;
  for (let y = g.y - 2; y <= g.y + 2; y++) {
    for (let x = g.x - 2; x <= g.x + 2; x++) {
      const o = objectAt(park, x, y);
      if (o && SCENERY[o.kind]) beauty += SCENERY[o.kind].beauty;
    }
  }
  if (beauty) {
    g.happy = Math.min(100, g.happy + Math.min(beauty, 12) * 0.06);
    if (beauty > 14 && rand(park) < 0.03) think(park, g, 'The scenery here is lovely!');
  }
}

function decide(park, g, here) {
  if (g.leaving) {
    if (!g.route) {
      const { prev } = bfs(park, here, true);
      g.route = traceRoute(prev, here, idx(ENTRANCE.x, ENTRANCE.y));
    }
    if (!g.route) g.gone = true; // trapped on a disconnected path: walk off-map
    else advance(park, g, true);
    return;
  }

  if (g.target) {
    const obj = getObject(park, g.target);
    if (!obj) g.target = null;
    else if (obj._access.includes(here)) { interact(park, g, obj, here); return; }
    else if (!g.route) {
      const { dist, prev } = bfs(park, here);
      const goal = nearestAccess(obj, dist);
      g.route = goal === null ? null : traceRoute(prev, here, goal);
      if (!g.route) g.target = null;
    }
  }

  if (!g.target) {
    g.decideIn--;
    if (g.decideIn <= 0) {
      g.decideIn = 2 + Math.floor(rand(park) * 4);
      pickGoal(park, g, here);
      if (g.leaving || g.state !== 'walk') return decide(park, g, here);
      if (g.target && getObject(park, g.target)._access.includes(here)) {
        return interact(park, g, getObject(park, g.target), here);
      }
    }
  }
  advance(park, g);
}

const NEED_THOUGHTS = {
  restroom: "I can't find a restroom!",
  drink: "I can't find anything to drink.",
  firstaid: "I'm hurt and there's no first aid here!",
  food: "I can't find anything to eat.",
};

function pickGoal(park, g, here) {
  if (g.happy < 20) return startLeaving(park, g, "I'm not having fun. I'm going home.");
  if (g.energy < 8) return startLeaving(park, g, "I'm exhausted. Time to go home.");
  if (g.timeIn > DAY_SECONDS * 2.2) return startLeaving(park, g, 'What a day! Heading home.');
  if (g.cash < 1 && rand(park) < 0.4) return startLeaving(park, g, "I'm out of money.");

  let need = null;
  if (g.injured) need = 'firstaid';
  else if (g.bladder > 70) need = 'restroom';
  else if (g.thirst > 65) need = 'drink';
  else if (g.hunger > 65) need = 'food';
  else if (g.energy < 35) need = 'seat';

  const { dist, prev } = bfs(park, here);
  let best = null, bestScore = -Infinity, bestGoal = -1;
  for (const obj of park.objects) {
    if (!obj._access.length) continue;
    let score;
    if (need) {
      if (need === 'seat' ? !SCENERY[obj.kind]?.seat : STALLS[obj.kind]?.sells !== need || !obj.open) continue;
      score = 0;
    } else {
      const def = RIDES[obj.kind];
      if (!def || !obj.open || obj.broken || def.intensity > g.pref + 2 || obj.price > g.cash) continue;
      score = def.excitement * 10 - (g.ridden[obj.id] || 0) * 18 - obj.queue.length * 1.5 + rand(park) * 12;
    }
    const goal = nearestAccess(obj, dist);
    if (goal === null) continue;
    score -= dist[goal] * (need ? 1 : 0.6);
    if (score > bestScore) { bestScore = score; best = obj; bestGoal = goal; }
  }

  if (!best && need === 'firstaid') return startLeaving(park, g, "I'm hurt. I need to get out of here.");
  if (!best) {
    if (need && NEED_THOUGHTS[need]) { g.happy = Math.max(0, g.happy - 3); think(park, g, NEED_THOUGHTS[need]); }
    else if (!need && rand(park) < 0.1) think(park, g, "There isn't much to do here.");
    return;
  }
  if (!need && rand(park) < 0.25) return; // sometimes just wander
  g.target = best.id;
  g.route = traceRoute(prev, here, bestGoal);
}

function rideValue(def, g) {
  return (1.5 + def.excitement * 1.05) * (0.75 + g.thrift * 0.5);
}

function interact(park, g, obj, here) {
  g.target = null;
  g.route = null;
  if (g.heist === obj.id) return commitHeist(park, g, obj);
  if (obj.kind === 'retribution') return watchShow(park, g, obj);
  const ride = RIDES[obj.kind];
  const stall = STALLS[obj.kind];
  if (ride) {
    if (!obj.open || obj.broken) return think(park, g, `${ride.name} isn't running.`);
    if (obj.price > g.cash) return think(park, g, `I can't afford ${ride.name}.`);
    if (obj.price > rideValue(ride, g)) {
      g.happy = Math.max(0, g.happy - 4);
      return think(park, g, `I'm not paying $${obj.price} for ${ride.name}!`);
    }
    if (obj.queue.length >= ride.capacity * 3) return think(park, g, `The line for ${ride.name} is too long.`);
    g.cash -= obj.price;
    if (obj.price) earn(park, obj.price, 'rides');
    obj.stats.revenue += obj.price;
    obj.queue.push(g.id);
    g.state = 'queue';
    g.queueT = 0;
    g.queueAt = here;
  } else if (stall) {
    if (!obj.open || obj.broken) return think(park, g, `${stall.name} has been smashed up.`);
    if (obj.price > g.cash) return think(park, g, `I can't afford ${stall.name}.`);
    const value = (stall.sells === 'food' ? 7 : stall.sells === 'drink' ? 4.5 : 2) * (0.75 + g.thrift * 0.5);
    if (obj.price > value) {
      g.happy = Math.max(0, g.happy - 3);
      return think(park, g, `$${obj.price} at ${stall.name}? No way.`);
    }
    g.cash -= obj.price;
    if (obj.price) earn(park, obj.price, 'shops');
    if (stall.unitCost) spend(park, stall.unitCost, 'shops');
    obj.stats.revenue += obj.price;
    obj.stats.riders++;
    g.state = 'busy';
    g.busy = 2;
    if (stall.sells === 'food') { g.hunger = 0; g.happy = Math.min(100, g.happy + 5); g.litterT = 4 + rand(park) * 10; }
    if (stall.sells === 'drink') { g.thirst = 0; g.bladder += 20; g.happy = Math.min(100, g.happy + 4); g.litterT = 4 + rand(park) * 10; }
    if (stall.sells === 'restroom') { g.bladder = 0; g.busy = 4; g.happy = Math.min(100, g.happy + 4); }
    if (stall.sells === 'firstaid') {
      g.busy = 6;
      if (g.injured) { g.injured = false; g.happy = Math.min(100, g.happy + 15); think(park, g, 'The first aid team patched me up.'); }
      g.nausea = 0;
    }
  } else if (SCENERY[obj.kind]?.seat) {
    g.state = 'sit';
    g.busy = 8;
  }
}

function updateRide(park, obj, dt) {
  const def = RIDES[obj.kind];
  if (obj.broken || !obj.open) {
    if (obj.queue.length) {
      for (const gid of obj.queue.splice(0)) {
        const g = park._guestById.get(gid);
        if (!g) continue;
        releaseGuest(park, g);
        g.happy -= 6;
        think(park, g, `${def.name} broke down while I was waiting!`);
      }
    }
    if (obj.phase !== 'running') return;
  }
  obj.queue = obj.queue.filter((gid) => park._guestById.has(gid));

  if (obj.phase === 'idle') {
    if (!obj.queue.length) { obj.wait = 0; return; }
    obj.wait += dt;
    if (obj.queue.length >= def.capacity || obj.wait >= 4) {
      obj.riders = obj.queue.splice(0, def.capacity);
      for (const gid of obj.riders) park._guestById.get(gid).state = 'ride';
      obj.phase = 'running';
      obj.timer = def.duration;
      obj.wait = 0;
    }
    return;
  }

  obj.timer -= dt;
  if (obj.timer > 0) return;
  for (const gid of obj.riders) {
    const g = park._guestById.get(gid);
    if (!g) continue;
    releaseGuest(park, g);
    const tooIntense = Math.max(0, def.intensity - g.pref);
    const joy = def.excitement * 2.6 - tooIntense * 5 + rand(park) * 4 - 2;
    g.happy = clamp(g.happy + joy, 0, 100);
    g.nausea = Math.min(100, g.nausea + def.nausea * (tooIntense ? 9 : 5));
    g.energy = Math.max(0, g.energy - 2 - def.intensity * 0.5);
    g.ridden[obj.id] = (g.ridden[obj.id] || 0) + 1;
    g.rides++;
    if (joy > 18) think(park, g, `${def.name} was amazing!`);
    else if (tooIntense > 1) think(park, g, `${def.name} was way too intense!`);
    else if (joy > 8) think(park, g, `${def.name} was fun.`);
  }
  obj.stats.riders += obj.riders.length;
  obj.riders = [];
  obj.phase = 'idle';
  if (rand(park) > def.reliability) {
    obj.broken = true;
    park._events.push({ type: 'warn', text: `${def.name} has broken down! A mechanic is needed.` });
  }
}

function updateStaff(park, s, dt) {
  if (s.role === 'squad') squadShoot(park, s, dt);
  if (s.busy > 0) {
    s.busy -= dt;
    if (s.busy <= 0) finishStaffJob(park, s);
    return;
  }
  const hurry = s.chase || (s.role === 'squad' && park.raid);
  if (!moveActor(park, s, dt, hurry ? STAFF_SPEED * 1.5 : STAFF_SPEED)) return;
  const here = idx(s.x, s.y);
  if (!walkable(park, here)) { // path was removed underneath them
    s.x = s.nx = ENTRANCE.x; s.y = s.ny = ENTRANCE.y - 1; s.t = 0; s.route = null;
    return;
  }
  if (s.nx !== s.x || s.ny !== s.y) return;

  if (s.role === 'janitor') {
    if (park.litter[here] > 0 || park.stains[here] > 0) { s.busy = 1.2 + park.stains[here] * 0.8; s.job = here; return; }
    if (!s.route) {
      const { dist, prev } = bfs(park, here);
      let best = -1;
      for (let i = 0; i < park.litter.length; i++) {
        if ((park.litter[i] || park.stains[i]) && dist[i] >= 0 && dist[i] <= 14 && (best < 0 || dist[i] < dist[best])) best = i;
      }
      if (best >= 0) s.route = traceRoute(prev, here, best);
    }
  } else if (s.role === 'guard') {
    if (guardStep(park, s, here)) return;
  } else if (s.role === 'squad') {
    if (squadStep(park, s, here)) return;
  } else if (s.role === 'mechanic') {
    let ride = s.task ? getObject(park, s.task) : null;
    if (!ride || !ride.broken) {
      s.task = null;
      ride = null;
      const { dist, prev } = bfs(park, here);
      let bestD = Infinity, bestGoal = -1;
      for (const o of park.objects) {
        if (!o.broken || park.staff.some((m) => m !== s && m.task === o.id)) continue;
        const goal = nearestAccess(o, dist);
        if (goal !== null && dist[goal] < bestD) { bestD = dist[goal]; ride = o; bestGoal = goal; }
      }
      if (ride) { s.task = ride.id; s.route = traceRoute(prev, here, bestGoal); }
    }
    if (ride && ride._access.includes(here)) { s.busy = 4; s.job = ride.id; s.route = null; return; }
    if (ride && !s.route) {
      const { dist, prev } = bfs(park, here);
      const goal = nearestAccess(ride, dist);
      if (goal !== null) s.route = traceRoute(prev, here, goal);
    }
  }
  advance(park, s);
}

function finishStaffJob(park, s) {
  if (s.role === 'janitor' && s.job >= 0) { park.litter[s.job] = 0; park.stains[s.job] = 0; }
  if (s.role === 'mechanic') {
    const ride = getObject(park, s.job);
    if (ride?.broken) {
      ride.broken = false;
      park._events.push({ type: 'info', text: `${itemDef(ride.kind).name} has been repaired.` });
    }
    s.task = null;
  }
  s.job = -1;
}

function updateRating(park) {
  const s = parkStats(park);
  const happy = s.guests ? s.avgHappy : 60;
  const target = 120 + happy * 4 + Math.min(s.rides, 10) * 28 + Math.min(s.beauty, 120)
    - s.litter * 4 - s.broken * 60 - (s.stalls === 0 && s.guests > 10 ? 80 : 0)
    - (100 - park.safety) * 3 - s.stains * 6;
  park.rating += (clamp(target, 0, 999) - park.rating) * 0.08;
}

function checkObjectives(park) {
  const s = parkStats(park);
  for (const o of OBJECTIVES) {
    if (!park.objectives.includes(o.id) && o.test(s)) {
      park.objectives.push(o.id);
      park._events.push({ type: 'goal', text: `Goal complete: ${o.text}!` });
    }
  }
}

function endDay(park, finishedDay) {
  maybeStartRaid(park, finishedDay + 1);
  for (const s of park.staff) spend(park, STAFF[s.role].wage, 'wages');
  for (const o of park.objects) {
    const def = RIDES[o.kind] || STALLS[o.kind] || SPECIAL[o.kind];
    if (def && o.open !== false) spend(park, def.upkeep, 'upkeep');
  }
  const t = park.stats.today;
  park.stats.history.push({ day: finishedDay, income: Math.round(t.income), expenses: Math.round(t.expenses), guests: park.guests.length, crimes: t.crimeCount });
  if (park.stats.history.length > 30) park.stats.history.shift();
  park.stats.today = newLedger();
  if (park.cash < 0) park._events.push({ type: 'warn', text: 'Your park is in debt! Cut costs or raise prices.' });
}

// ---------------------------------------------------------------------------
// Crime & security
// ---------------------------------------------------------------------------

const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** How well a tile is covered by security. */
function coverage(park, x, y) {
  const here = { x: x + 0.5, y: y + 0.5 };
  let guard = null, guardD = Infinity;
  for (const s of park.staff) {
    if (s.role !== 'guard') continue;
    const d = dist2(actorPos(s), here);
    if (d < guardD) { guardD = d; guard = s; }
  }
  let camera = false, lamp = false;
  for (const o of park.objects) {
    const def = SCENERY[o.kind];
    if (!def || (!def.camera && !def.lamp)) continue;
    const d = dist2({ x: o.x + 0.5, y: o.y + 0.5 }, here);
    if (def.camera && d <= CRIME.cameraRadius ** 2) camera = true;
    if (def.lamp && d <= CRIME.lampRadius ** 2) lamp = true;
  }
  return { guard, guardD: Math.sqrt(guardD), camera, lamp };
}

function logIncident(park, type, text) {
  park.incidents.unshift({ type, text, day: day(park) });
  if (park.incidents.length > 30) park.incidents.length = 30;
  if (CRIME.safetyHit[type]) {
    park.stats.crimes++;
    park.stats.today.crimeCount++;
    park.safety = Math.max(0, park.safety - CRIME.safetyHit[type]);
  }
}

function victimNear(park, g) {
  const me = actorPos(g);
  let best = null, bestD = 2.25;
  for (const v of park.guests) {
    if (v === g || v.crime || v.gone || (v.state !== 'walk' && v.state !== 'queue' && v.state !== 'sit')) continue;
    const d = dist2(actorPos(v), me);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

/** Decides whether a criminal acts now, based on security nearby. */
function planCrime(park, g) {
  const cov = coverage(park, g.x, g.y);
  let chance = 1;
  if (cov.guard && cov.guardD <= CRIME.guardDeterRadius) chance *= CRIME.guardDeterFactor;
  if (cov.camera) chance *= CRIME.cameraDeterFactor;
  const dusk = dayProgress(park) > 0.75;
  if (!dusk || cov.lamp) chance *= CRIME.daytimeFactor;
  if (rand(park) > chance) {
    g.crimeT = 5 + rand(park) * 8;
    if (cov.guard && cov.guardD <= CRIME.guardDeterRadius) think(park, g, 'Too much security around here...');
    return;
  }

  if (g.crime === 'robber') {
    // Pick the busiest reachable till to hit.
    const targets = park.objects.filter((o) => o.stats && o.open && o._access.length && o.stats.revenue > 0);
    if (!targets.length) { g.crimeT = 20; return; }
    targets.sort((a, b) => b.stats.revenue - a.stats.revenue);
    const t = targets[Math.floor(rand(park) * Math.min(3, targets.length))];
    g.heist = t.id;
    g.target = t.id;
    g.route = null;
    g.crimeT = 9999; // acts on arrival
    return;
  }

  const victim = victimNear(park, g);
  if (!victim) { g.crimeT = 3 + rand(park) * 4; return; }
  if (g.crime === 'pickpocket') commitTheft(park, g, victim, cov);
  else commitAssault(park, g, victim, cov);
}

function commitTheft(park, g, v, cov) {
  const amount = Math.min(v.cash, Math.round(5 + rand(park) * 30));
  if (amount <= 0) { g.crimeT = 4; return; }
  v.cash -= amount;
  g.loot += amount;
  v.happy = Math.max(0, v.happy - 20);
  think(park, v, 'Someone stole my wallet!', true);
  logIncident(park, 'theft', `${v.name} was pickpocketed ($${amount}).`);
  afterCrime(park, g, cov, false);
}

function commitAssault(park, g, v, cov) {
  const firstAid = park.objects.some((o) => o.kind === 'firstaid' && o.open);
  const fatal = rand(park) < CRIME.homicideChance * (firstAid ? CRIME.firstAidHomicideFactor : 1);
  bleed(park, v, fatal ? 3 : 1);
  if (fatal) {
    v.gone = true;
    spend(park, CRIME.homicideLegalCost, 'crime');
    logIncident(park, 'homicide', `${v.name} was killed in an attack. Police are investigating.`);
    park._events.push({ type: 'warn', text: `A guest was killed in an attack. Legal costs: $${CRIME.homicideLegalCost.toLocaleString()}.` });
    const at = actorPos(v);
    for (const w of park.guests) {
      if (w !== g && !w.crime && dist2(actorPos(w), at) <= 25) startLeaving(park, w, "I'm getting out of here!");
    }
  } else {
    v.injured = true;
    v.happy = Math.max(0, v.happy - 40);
    v.energy = Math.max(0, v.energy - 20);
    think(park, v, 'I was attacked!', true);
    logIncident(park, 'assault', `${v.name} was assaulted.`);
    park._events.push({ type: 'warn', text: `A guest was assaulted! Consider hiring security.` });
  }
  afterCrime(park, g, cov, true);
}

function commitHeist(park, g, obj) {
  g.heist = null;
  const name = itemDef(obj.kind).name;
  const amount = Math.round(clamp(park.stats.today.income * 0.35, 150, 3000));
  const taken = Math.min(amount, Math.max(0, Math.round(park.cash)));
  if (taken <= 0) { startLeaving(park, g); return; }
  spend(park, taken, 'crime');
  g.loot += taken;
  g.heistLoot = true;
  logIncident(park, 'heist', `Heist at ${name}: $${taken.toLocaleString()} stolen.`);
  park._events.push({ type: 'warn', text: `Heist at ${name}! $${taken.toLocaleString()} stolen.` });
  afterCrime(park, g, coverage(park, g.x, g.y), true);
}

/** Witnesses and cameras may identify the culprit; guards give chase. */
function afterCrime(park, g, cov, flee) {
  g.crimes++;
  g.crimeT = 15 + rand(park) * 20;
  const guardNear = cov.guard && cov.guardD <= CRIME.guardChaseRadius;
  if (guardNear || (cov.camera && rand(park) < CRIME.cameraSpotChance)) g.spotted = true;
  if (guardNear && !cov.guard.chase) {
    cov.guard.chase = g.id;
    cov.guard.route = null;
  }
  if (flee || g.crimes >= 3) startLeaving(park, g);
}

function arrest(park, g, by) {
  for (const o of park.objects) {
    if (o.queue?.includes(g.id)) o.queue.splice(o.queue.indexOf(g.id), 1);
  }
  g.gone = true;
  g.arrested = true;
  park.stats.arrests++;
  park.safety = Math.min(100, park.safety + 2);
  if (g.heistLoot && g.loot) earn(park, g.loot, 'crime');
  const what = { pickpocket: 'pickpocket', brawler: 'violent offender', robber: 'robber' }[g.crime];
  const recovered = g.heistLoot && g.loot ? ` $${Math.round(g.loot).toLocaleString()} recovered.` : '';
  logIncident(park, 'arrest', `${g.name}, a ${what}, was arrested by ${by}.${recovered}`);
  park._events.push({ type: 'goal', text: `${g.name} (${what}) arrested!${recovered}` });
  for (const s of park.staff) if (s.chase === g.id) s.chase = null;
}

/** Guard behaviour on arriving at a tile. Returns true if it handled movement. */
function guardStep(park, s, here) {
  const pos = { x: s.x + 0.5, y: s.y + 0.5 };
  // Arrest any identified criminal within reach.
  for (const g of park.guests) {
    if (!g.crime || g.crime === 'panda' || !g.spotted || g.gone || g.state === 'ride') continue;
    if (dist2(actorPos(g), pos) <= 1.6) { arrest(park, g, s.name); return false; }
  }
  if (!s.chase) return false;
  const g = park._guestById.get(s.chase);
  if (!g || g.gone) { s.chase = null; return false; }
  const goal = g.state === 'queue' && g.queueAt >= 0 ? g.queueAt : idx(g.nx, g.ny);
  const { prev } = bfs(park, here, true);
  s.route = traceRoute(prev, here, goal);
  if (!s.route) { s.chase = null; return false; }
  advance(park, s, true);
  return true;
}

function bleed(park, v, amount) {
  const i = idx(v.x, v.y);
  if (park.tiles[i] !== TILE.GRASS) park.stains[i] = Math.min(3, park.stains[i] + amount);
  const p = actorPos(v);
  fx(park, { type: 'blood', x: p.x, y: p.y, amount });
}

/** Transient visual effects for the renderer (not saved). */
function fx(park, effect) {
  park._fx = park._fx || [];
  if (park._fx.length < 200) park._fx.push(effect);
}

// ---------------------------------------------------------------------------
// Pandemonium heist crew
// ---------------------------------------------------------------------------

const randIn = (park, [lo, hi]) => lo + rand(park) * (hi - lo);
export const activePandas = (park) => park.guests.filter((g) => g.crime === 'panda' && !g.gone);

function maybeStartRaid(park, newDay) {
  const pd = park.pandemonium;
  if (park.raid || newDay < pd.nextRaidDay || park.guests.length < PANDEMONIUM.minGuests) return;
  if (rand(park) >= PANDEMONIUM.raidChance) return;
  startRaid(park);
}

/** Starts a raid right away. Exported for tests and debugging. */
export function startRaid(park) {
  if (park.raid) return false;
  const paths = [];
  for (let i = 0; i < park.tiles.length; i++) if (park.tiles[i] === TILE.PATH) paths.push(i);
  if (paths.length < 6) return false;
  const pd = park.pandemonium;
  const size = Math.min(PANDEMONIUM.crewMax, PANDEMONIUM.crewBase + pd.raids * PANDEMONIUM.crewGrowth);
  pd.raids++;
  park.raid = { startedAt: park.time, size, captured: 0, escaped: 0, loot: 0 };
  const names = [...PANDEMONIUM.names];
  for (let k = 0; k < size; k++) {
    // They infiltrate everywhere: each member pops up somewhere different.
    const at = paths[Math.floor(rand(park) * paths.length)];
    const x = at % GRID, y = (at / GRID) | 0;
    const name = names.splice(Math.floor(rand(park) * names.length), 1)[0] || `Panda #${k + 1}`;
    const g = {
      ...newGuestStats(),
      id: park.nextId++, name, shirt: '#ffffff',
      x, y, nx: x, ny: y, lx: x, ly: y, t: 0,
      cash: 0, happy: 50, hunger: 0, thirst: 0, bladder: 0, energy: 100, nausea: 0, pref: 10, thrift: 0, timeIn: 0,
      crime: 'panda', hp: PANDEMONIUM.hp, crimeT: randIn(park, PANDEMONIUM.actEvery),
    };
    park.guests.push(g);
    park._guestById.set(g.id, g);
  }
  logIncident(park, 'raid', `Pandemonium infiltrated the park with ${size} members!`);
  park._events.push({ type: 'raid', text: `🐼 PANDEMONIUM has infiltrated the park with ${size} members! Deploy the Hot Dog Squad!` });
  return true;
}

function updatePanda(park, g, dt) {
  g.thoughtT -= dt;
  if (g.state === 'downed') {
    g.busy -= dt;
    if (g.busy <= 0) capturePanda(park, g);
    return;
  }
  if (g.state === 'busy') {
    g.busy -= dt;
    if (g.busy <= 0) g.state = 'walk';
    return;
  }
  if (!park.raid) { g.gone = true; return; }
  if (!g.leaving && park.time - park.raid.startedAt > PANDEMONIUM.raidSeconds) {
    startLeaving(park, g, 'Grab the loot and scatter!');
  }
  g.crimeT -= dt;
  if (!moveActor(park, g, dt, PANDEMONIUM.speed)) return;
  const here = idx(g.x, g.y);
  if (!walkable(park, here)) return pandaEscapes(park, g);
  if (g.nx !== g.x || g.ny !== g.y) return;

  if (g.leaving) {
    if (park.tiles[here] === TILE.ENTRANCE) return pandaEscapes(park, g);
    if (!g.route) {
      const { prev } = bfs(park, here, true);
      g.route = traceRoute(prev, here, idx(ENTRANCE.x, ENTRANCE.y));
      if (!g.route) return pandaEscapes(park, g);
    }
    advance(park, g, true);
    return;
  }

  g.robT = (g.robT || 0) - (park.time - (g.lastT ?? park.time));
  g.lastT = park.time;
  const target = g.target ? getObject(park, g.target) : null;
  if (target && target._access.includes(here) && g.robT <= 0) {
    g.robT = PANDEMONIUM.robCooldown;
    robTill(park, g, target);
    g.target = null;
    g.route = null;
    return;
  }
  if (g.crimeT <= 0) {
    g.crimeT = randIn(park, PANDEMONIUM.actEvery);
    const v = victimNear(park, g);
    if (v && rand(park) < PANDEMONIUM.assaultChance) {
      v.injured = true;
      v.happy = Math.max(0, v.happy - 45);
      think(park, v, `A panda just beat me up!`, true);
      bleed(park, v, 1);
      logIncident(park, 'assault', `${g.name} of Pandemonium assaulted ${v.name}.`);
    }
  }
  if (!target || !g.route?.length) {
    const tills = park.objects.filter((o) => o.stats && o._access.length);
    if (tills.length) {
      const t = tills[Math.floor(rand(park) * tills.length)];
      const { dist, prev } = bfs(park, here);
      const goal = nearestAccess(t, dist);
      if (goal !== null) { g.target = t.id; g.route = traceRoute(prev, here, goal); }
    }
  }
  advance(park, g);
}

function robTill(park, g, obj) {
  const def = itemDef(obj.kind);
  const taken = Math.min(Math.round(randIn(park, PANDEMONIUM.tillLoot)), Math.max(0, Math.round(park.cash)));
  if (taken > 0) {
    spend(park, taken, 'crime');
    g.loot += taken;
    park.raid.loot += taken;
  }
  const smashed = rand(park) < PANDEMONIUM.sabotageChance && 'broken' in obj;
  if (smashed) {
    obj.broken = true;
    if (obj.queue) for (const gid of obj.queue.splice(0)) releaseGuest(park, park._guestById.get(gid));
  }
  logIncident(park, 'heist', `Pandemonium hit ${def.name}: $${taken.toLocaleString()} stolen${smashed ? ' and the place was smashed up' : ''}.`);
  park._events.push({ type: 'warn', text: `🐼 ${g.name} robbed ${def.name}${taken ? ` of $${taken.toLocaleString()}` : ''}${smashed ? ' and smashed it' : ''}!` });
  g.state = 'busy';
  g.busy = 1.5;
}

function pandaEscapes(park, g) {
  g.gone = true;
  if (!park.raid) return;
  park.raid.escaped++;
  park.pandemonium.escaped++;
  park.safety = Math.max(0, park.safety - PANDEMONIUM.escapeSafetyHit / Math.max(1, park.raid.size / 2));
  logIncident(park, 'raid', `${g.name} escaped with $${Math.round(g.loot).toLocaleString()}.`);
}

function capturePanda(park, g) {
  g.gone = true;
  park.captives.push({ name: g.name });
  park.pandemonium.captured++;
  park.stats.arrests++;
  if (park.raid) park.raid.captured++;
  if (g.loot) earn(park, g.loot, 'crime');
  logIncident(park, 'arrest', `${g.name} of Pandemonium was captured${g.loot ? `. $${Math.round(g.loot).toLocaleString()} recovered` : ''}.`);
  park._events.push({ type: 'goal', text: `🌭 ${g.name} captured by the Hot Dog Squad!` });
}

function checkRaidOver(park) {
  const raid = park.raid;
  if (!raid || activePandas(park).length) return;
  const pd = park.pandemonium;
  park.raid = null;
  if (raid.escaped === 0) {
    pd.defeated++;
    pd.nextRaidDay = day(park) + PANDEMONIUM.cooldownDays + 2;
    park.safety = Math.min(100, park.safety + PANDEMONIUM.defeatSafetyBonus);
    logIncident(park, 'raid', `Pandemonium was defeated! ${raid.captured} members in custody.`);
    park._events.push({ type: 'goal', text: `Pandemonium defeated! ${park.captives.length} prisoners await justice at the Retribution Rig.` });
  } else {
    pd.nextRaidDay = day(park) + PANDEMONIUM.cooldownDays;
    logIncident(park, 'raid', `Pandemonium got away with $${Math.round(raid.loot).toLocaleString()}. ${raid.captured} captured, ${raid.escaped} escaped.`);
    park._events.push({ type: 'warn', text: `Pandemonium escaped! ${raid.escaped} got away. They'll be back...` });
  }
}

function squadShoot(park, s, dt) {
  s.cool = Math.max(0, (s.cool || 0) - dt);
  if (s.cool > 0 || !park.raid) return;
  const me = actorPos(s);
  let target = null, best = PANDEMONIUM.shotRange ** 2;
  for (const g of park.guests) {
    if (g.crime !== 'panda' || g.gone || g.state === 'downed') continue;
    const d = dist2(actorPos(g), me);
    if (d <= best) { best = d; target = g; }
  }
  if (!target) return;
  s.cool = PANDEMONIUM.shotCooldown;
  const hit = rand(park) < PANDEMONIUM.hitChance;
  const to = actorPos(target);
  fx(park, { type: 'shot', x0: me.x, y0: me.y, x1: to.x, y1: to.y, hit });
  if (!hit) return;
  target.hp--;
  if (target.hp <= 0) {
    target.state = 'downed';
    target.busy = PANDEMONIUM.downedSeconds;
    target.route = null;
    target.nx = target.x; target.ny = target.y; target.t = 0;
    think(park, target, 'Bested by a hot dog...', true);
  }
}

/** Squad officers hunt the nearest panda during a raid. */
function squadStep(park, s, here) {
  if (!park.raid) return false;
  const pandas = park.guests.filter((g) => g.crime === 'panda' && !g.gone && g.state !== 'downed');
  if (!pandas.length) return false;
  const { dist, prev } = bfs(park, here, true);
  let goal = -1;
  for (const g of pandas) {
    const i = idx(g.nx, g.ny);
    if (dist[i] >= 0 && (goal < 0 || dist[i] < dist[goal])) goal = i;
  }
  if (goal < 0 || goal === here) return false;
  s.route = traceRoute(prev, here, goal);
  advance(park, s, true);
  return true;
}

/** Stages a public execution of captured Pandemonium members. */
export function execute(park, id, mode) {
  const rig = getObject(park, id);
  if (!rig || rig.kind !== 'retribution') return { ok: false, reason: 'That is not a Retribution Rig.' };
  if (rig.show) return { ok: false, reason: 'A show is already underway.' };
  if (!park.captives.length) return { ok: false, reason: 'No Pandemonium prisoners in custody.' };
  if (!rig._access.length) return { ok: false, reason: 'Connect the rig to a path so a crowd can gather.' };
  rig.pit = mode === 'water' ? 'water' : 'fire';
  const victims = park.captives.splice(0).map((c) => c.name);
  rig.show = { t: 0, victims, duration: victims.length * PANDEMONIUM.showSecondsPerVictim + 2, spectators: 0 };
  for (const g of park.guests) {
    if (g.crime || g.leaving || g.state !== 'walk' || g.injured) continue;
    g.target = rig.id;
    g.route = null;
  }
  const how = rig.pit === 'fire' ? 'launched into the fire pit' : 'drowned in the dunk tank';
  logIncident(park, 'execution', `${victims.join(', ')} ${victims.length > 1 ? 'were' : 'was'} ${how}.`);
  park._events.push({ type: 'raid', text: `⚖️ Public execution at the Retribution Rig! ${victims.length} Pandemonium member${victims.length > 1 ? 's' : ''} to be ${how}.` });
  return { ok: true };
}

export function setRigMode(park, id, mode) {
  const rig = getObject(park, id);
  if (rig?.kind === 'retribution' && !rig.show) rig.pit = mode === 'water' ? 'water' : 'fire';
}

function watchShow(park, g, rig) {
  if (!rig.show) return;
  if (g.cash >= PANDEMONIUM.spectatorFee) {
    g.cash -= PANDEMONIUM.spectatorFee;
    earn(park, PANDEMONIUM.spectatorFee, 'shows');
  }
  rig.show.spectators++;
  g.state = 'busy';
  g.busy = Math.max(2, rig.show.duration - rig.show.t);
  think(park, g, pick(park, ['Get those pandas!', "That's what you get for robbing us!", 'Brutal. I love it.', 'Justice!']));
}

function updateShow(park, rig, dt) {
  const show = rig.show;
  const per = PANDEMONIUM.showSecondsPerVictim;
  const before = Math.floor((show.t - per * 0.75) / per);
  show.t += dt;
  const after = Math.floor((show.t - per * 0.75) / per);
  if (after > before && after >= 0 && after < show.victims.length) {
    // A victim hits the pit.
    const pit = { x: rig.x + rig.w - 0.9, y: rig.y + rig.h / 2 };
    fx(park, { type: rig.pit === 'fire' ? 'burn' : 'splash', x: pit.x, y: pit.y });
    fx(park, { type: 'blood', x: pit.x, y: pit.y, amount: 3 });
    park.pandemonium.executions++;
  }
  if (show.t < show.duration) return;
  rig.show = null;
  for (const g of park.guests) if (!g.crime) g.happy = Math.min(100, g.happy + PANDEMONIUM.showHappiness);
  park.safety = 100;
  park._events.push({ type: 'goal', text: `Justice served. ${show.spectators} spectators cheered. Pandemonium will think twice.` });
  park.pandemonium.nextRaidDay = Math.max(park.pandemonium.nextRaidDay, day(park) + PANDEMONIUM.cooldownDays + 1);
}

/** Removes and returns pending UI notifications produced by the sim. */
export function drainEvents(park) {
  return park._events.splice(0);
}
