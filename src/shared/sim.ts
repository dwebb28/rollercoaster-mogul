// Theme park simulation. Pure logic with no DOM access, so it runs in the
// browser for gameplay and on the server for save validation and scoring.

import {
  GRID, DAY_SECONDS, START_CASH, PATH_COST, REFUND_RATE,
  RIDES, STALLS, SCENERY, STAFF, SPECIAL, OBJECTIVES, CRIME, PANDEMONIUM, itemDef, itemCategory,
  CUSTOM_COASTER, SHOP_VALUE, AGEING, DESIGN_CODE_PREFIX,
} from './catalog.ts';
import * as Coaster from './coaster.ts';
import {
  sanitizeSettings, settingDef, CLIMATES, WEATHER, EVENTS, GUEST_TYPES, STAFF_TRAITS, PATH_STYLES,
  isHexColor, weighted,
} from './options.ts';

import type {
  Park, ParkObject, Guest, Staff, Walker, StaffRole, Settings, EventDef, Fx, CriminalRecord, CustodyCase,
  ParkStats, Ledger, GuestTypeKey, CrimeKind, RideDef, TileKind, PieceType, Result, WeatherDef, SimEvent, PandemoniumStats,
  StallDef, Incident, CoasterDesign, LedgerCategory, RideObject, ShopObject, CoasterObject,
} from './types.ts';
import type { Cursor } from './coaster.ts';

export type { Park, ParkObject, Guest, Staff, ParkStats, Settings } from './types.ts';

/** Security coverage of a tile: nearest guard, cameras and lamps in range. */
interface Coverage {
  guard: Staff | null;
  guardD: number;
  camera: boolean;
  lamp: boolean;
}

/** Options for spawning a guest outside the normal arrival flow. */
interface SpawnOpts {
  type?: GuestTypeKey;
  cash?: number;
  name?: string;
  crime?: CrimeKind;
  gang?: string | null;
  honest?: boolean;
}

export const SAVE_VERSION = 2;

export const TILE = { GRASS: 0, PATH: 1, ENTRANCE: 2 } as const;
export const ENTRANCE = { x: GRID / 2, y: GRID - 1 };

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const GUEST_SPEED = 1.4; // tiles per game-second
const STAFF_SPEED = 1.7;
const MAX_GUESTS = 600;
const FIRST_NAMES = [
  'Ava', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jade', 'Kai', 'Lena', 'Milo',
  'Nia', 'Omar', 'Pia', 'Quinn', 'Rosa', 'Sami', 'Theo', 'Uma', 'Vik', 'Wren', 'Xan', 'Yara', 'Zed',
];
const SHIRTS = ['#e5484d', '#3e8ed0', '#f2b84b', '#7bd389', '#9b6bd6', '#ef6fa8', '#ffffff', '#2bb3a3', '#ff8a3d'];

export const idx = (x: number, y: number) => y * GRID + x;
export const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < GRID && y < GRID;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Seeded PRNG (mulberry32) whose state is part of the save. */
function rand(park: Park) {
  park.rngState = (park.rngState + 0x6d2b79f5) >>> 0;
  let t = park.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(park: Park, arr: readonly T[]): T => arr[Math.floor(rand(park) * arr.length)]!;

// ---------------------------------------------------------------------------
// Creation, indexing, persistence
// ---------------------------------------------------------------------------

export function createPark(name = 'New Park', seed = Date.now(), settings?: Partial<Settings>): Park {
  const cfg = sanitizeSettings(settings);
  const park: Park = {
    version: SAVE_VERSION,
    name: String(name).slice(0, 40),
    seed: seed >>> 0,
    rngState: seed >>> 0,
    time: 0,
    cash: settings ? cfg.startCash : START_CASH,
    settings: cfg,
    weather: { type: 'sunny', day: 1 },
    buzz: 0,
    effects: [],
    eventLog: [],
    pathStyles: new Array(GRID * GRID).fill(0),
    uniforms: {},
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
    stats: { totalGuests: 0, peakGuests: 0, arrests: 0, crimes: 0, drugDeals: 0, gangRecruits: 0, today: newLedger(), history: [] },
    thoughts: [],
    incidents: [],
    objectives: [],
    raid: null,
    captives: [],
    custody: [],
    fallen: [],
    fence: false,
    locked: false,
    pandemonium: newPandaStats(),
    ...transientDefaults(),
  };
  park.tiles[idx(ENTRANCE.x, ENTRANCE.y)] = TILE.ENTRANCE;
  for (let y = ENTRANCE.y - 1; y >= ENTRANCE.y - 6; y--) park.tiles[idx(ENTRANCE.x, y)] = TILE.PATH;

  rebuildIndex(park);
  // Scatter free starting plants (by climate) away from the entrance.
  const flora = CLIMATES[cfg.climate].trees;
  const count = Math.round(140 * cfg.treeDensity);
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rand(park) * GRID);
    const y = Math.floor(rand(park) * GRID);
    const kind = weighted(flora, rand(park));
    if (Math.abs(x - ENTRANCE.x) < 5 && y > GRID - 10) continue;
    const t = idx(x, y);
    if (park.tiles[t] === TILE.GRASS && !park._objAt[t]) addObject(park, kind, x, y, 0);
  }
  park.weather = { type: rollWeatherType(park), day: 1 };
  if (cfg.pandemonium === 'aggressive') park.pandemonium.nextRaidDay = PANDEMONIUM.firstRaidDay - 2;
  return park;
}

/** Lookup tables that rebuildIndex() fills in; never saved. */
function transientDefaults(): Pick<Park, '_objAt' | '_byId' | '_guestById' | '_events'> {
  return { _objAt: new Int32Array(GRID * GRID), _byId: new Map(), _guestById: new Map(), _events: [] };
}

const RECORD_KEYS = ['theft', 'assault', 'robbery', 'drugs', 'homicide', 'stolen'] as const;
const newRecord = (): CriminalRecord => ({ theft: 0, assault: 0, robbery: 0, drugs: 0, homicide: 0, stolen: 0 });
function cleanRecord(r: unknown): CriminalRecord {
  const out = newRecord();
  if (r && typeof r === 'object') for (const k of RECORD_KEYS) out[k] = num((r as Record<string, unknown>)[k], 0, 1e9);
  return out;
}
export const offences = (r: CriminalRecord): number => r.theft + r.assault + r.robbery + r.drugs + r.homicide;

function newPandaStats() {
  return { raids: 0, defeated: 0, escaped: 0, captured: 0, executions: 0, nextRaidDay: PANDEMONIUM.firstRaidDay };
}

function newLedger() {
  return { income: 0, expenses: 0, admissions: 0, rides: 0, shops: 0, wages: 0, upkeep: 0, construction: 0, crime: 0, shows: 0, fines: 0, insurance: 0, events: 0, crimeCount: 0 };
}

/** Ground tiles an object stands on (custom coasters follow their track). */
export function cellsOf(obj: ParkObject) {
  if (obj.kind === 'custom') return obj._cells || [];
  const out = [];
  for (let y = obj.y; y < obj.y + obj.h; y++) for (let x = obj.x; x < obj.x + obj.w; x++) out.push([x, y]);
  return out;
}

/** Ride definition for an object, including physics-derived custom coasters. */
export function rideDef(obj: ParkObject) {
  if (RIDES[obj.kind]) return obj._def || RIDES[obj.kind];
  return obj.kind === 'custom' ? obj._def || CUSTOM_COASTER : null;
}

/** Rides carry a queue and a ride cycle. */
export const isRideObj = (o: ParkObject): o is RideObject => Array.isArray(o.queue);
/** Rides and shops carry a till (price, takings, open/broken). */
export const hasTill = (o: ParkObject): o is ShopObject => o.stats !== undefined;

/** Display name: a player-chosen name, else the catalogue name. */
export function objName(obj: ParkObject) {
  return obj.name || rideDef(obj)?.name || itemDef(obj.kind)?.name || obj.kind;
}

const cfgOf = (park: Park) => park.settings;
/** Current weather definition (always sunny when weather is turned off). */
export const weatherOf = (park: Park) => (park.settings.weather ? WEATHER[park.weather.type] || WEATHER.sunny : WEATHER.sunny);
const hasEffect = (park: Park, id: string) => park.effects.some((e) => e.id === id && e.until > park.time);
const guestType = (g: Guest) => GUEST_TYPES[g.type] || GUEST_TYPES.family;

/** Rebuilds transient lookup tables (anything prefixed with `_`). */
function rebuildIndex(park: Park) {
  park._objAt = new Int32Array(GRID * GRID);
  park._byId = new Map();
  for (const obj of park.objects) {
    if (isCoaster(obj)) refreshCoaster(obj);
    else if (RIDES[obj.kind] && obj.name) obj._def = { ...RIDES[obj.kind], name: obj.name };
    for (const [x, y] of cellsOf(obj)) {
      if (!inBounds(x, y)) throw new Error('object out of bounds');
      const i = idx(x, y);
      if (park._objAt[i] || park.tiles[i] !== TILE.GRASS) throw new Error('overlapping objects');
      park._objAt[i] = obj.id;
    }
    park._byId.set(obj.id, obj);
  }
  park._guestById = new Map(park.guests.map((g) => [g.id, g]));
  park._events = park._events || [];
  refreshAccess(park);
}

/** Recomputes which path tiles touch each object. */
function refreshAccess(park: Park) {
  for (const obj of park.objects) {
    if (obj.kind === 'custom') {
      // Guests board at the station only.
      const access = new Set<number>();
      for (const [x, y] of obj._stationCells || []) {
        for (const [dx, dy] of DIRS) {
          const nx = x + dx, ny = y + dy;
          if (inBounds(nx, ny) && park.tiles[idx(nx, ny)] === TILE.PATH) access.add(idx(nx, ny));
        }
      }
      obj._access = [...access];
      continue;
    }
    const access: number[] = [];
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

/** JSON-safe save document (the shape of Park minus transient fields). */
export type SaveData = Record<string, unknown>;

export function serialize(park: Park): SaveData {
  const data = JSON.parse(JSON.stringify(park, (k, v) => (k.startsWith('_') ? undefined : v)));
  data.tiles = park.tiles.join('');
  data.litter = park.litter.join('');
  data.stains = park.stains.join('');
  data.pathStyles = park.pathStyles.join('');
  for (const a of [...data.guests, ...data.staff]) delete a.route;
  return data;
}

/** Type guard: is `k` an own key of `table`? Used to vet untrusted strings from saves. */
export const isKey = <T extends object>(table: T, k: unknown): k is keyof T =>
  typeof k === 'string' && Object.hasOwn(table, k);

const INCIDENT_TYPES: readonly string[] = ['theft', 'assault', 'heist', 'homicide', 'arrest', 'raid', 'execution', 'drugs', 'gang', 'sentence'];

/** Clamps an untrusted value to [lo, hi], or returns the fallback if it isn't a number. */
const num = (v: unknown, lo: number, hi: number, fallback = lo): number =>
  (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const okPos = (a: any): boolean => Number.isInteger(a.x) && Number.isInteger(a.y) && inBounds(a.x, a.y)
  && Number.isInteger(a.nx) && Number.isInteger(a.ny) && inBounds(a.nx, a.ny);

/**
 * Validates untrusted save data and returns a live park. Throws on bad input.
 * `data` and the callbacks below are deliberately `any`: this is the trust
 * boundary, and every field is checked, clamped or allow-listed before use.
 */
export function deserialize(data: any): Park {
  if (!data || typeof data !== 'object') throw new Error('not an object');
  if (data.version !== 1 && data.version !== SAVE_VERSION) throw new Error('unsupported version');
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
  park.tiles = [...(data.tiles as string)].map(Number) as TileKind[];
  park.litter = [...(data.litter as string)].map(Number);
  // v1 saves predate settings: they get the Normal preset (see docs/PERSISTENCE.md).
  park.settings = sanitizeSettings(data.settings);
  park.seed = num(data.seed, 0, 0xffffffff, park.rngState) >>> 0;
  park.weather = { type: isKey(WEATHER, data.weather?.type) ? data.weather.type : 'sunny', day: num(data.weather?.day, 0, 1e7, 1) };
  park.buzz = num(data.buzz, -100, 100, 0);
  park.effects = Array.isArray(data.effects)
    ? data.effects.slice(0, 20).filter((e: any) => ['outage', 'protest'].includes(e?.id)).map((e: any) => ({ id: e.id, until: num(e.until, 0, 1e9) }))
    : [];
  park.eventLog = Array.isArray(data.eventLog)
    ? data.eventLog.slice(0, 20).map((e: any) => ({ id: String(e?.id ?? '').slice(0, 20), text: String(e?.text ?? '').slice(0, 160), day: num(e?.day, 0, 1e7) }))
    : [];
  park.pathStyles = typeof data.pathStyles === 'string' && new RegExp(`^[0-${PATH_STYLES.length - 1}]{${n}}$`).test(data.pathStyles)
    ? [...(data.pathStyles as string)].map(Number) : new Array<number>(n).fill(0);
  park.uniforms = {};
  for (const [role, c] of Object.entries(data.uniforms && typeof data.uniforms === 'object' ? data.uniforms : {})) {
    if (isKey(STAFF, role) && isHexColor(c)) park.uniforms[role] = c;
  }
  park.stains = typeof data.stains === 'string' && new RegExp(`^[0-3]{${n}}$`).test(data.stains)
    ? [...(data.stains as string)].map(Number) : new Array<number>(n).fill(0);
  if (park.tiles[idx(ENTRANCE.x, ENTRANCE.y)] !== TILE.ENTRANCE) throw new Error('entrance missing');

  let maxId = 0;
  const seen = new Set<number>();
  const ensureId = (id: unknown): void => {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || seen.has(id)) throw new Error('bad id');
    seen.add(id);
    maxId = Math.max(maxId, id);
  };

  const pendingCaptives: string[] = [];
  // Cosmetic fields any object may carry.
  const looks = (o: any): Partial<ParkObject> => {
    const out: Partial<ParkObject> = { builtDay: num(o.builtDay, 0, 1e7, 1) };
    if (typeof o.name === 'string' && o.name.trim() && o.kind !== 'custom') out.name = o.name.trim().slice(0, 40);
    if (isHexColor(o.color)) out.color = o.color;
    return out;
  };
  for (const o of data.objects) {
    const def = itemDef(o?.kind);
    if (!def) throw new Error('unknown object kind');
    ensureId(o.id);
    if (!Number.isInteger(o.x) || !Number.isInteger(o.y)) throw new Error('bad object position');
    if (o.kind === 'custom') {
      const t = o.track;
      if (!t || !Number.isInteger(t.dir) || t.dir < 0 || t.dir > 3 || !Array.isArray(t.pieces)) throw new Error('bad coaster track');
      const pieces = t.pieces.slice(0, 400);
      if (pieces[0] !== 'station' || pieces.some((p: unknown) => !isKey(Coaster.PIECES, p))) throw new Error('bad coaster track');
      park.objects.push(makeObject('custom', o.id, o.x, o.y, num(o.paid, 0, 1e7, 0), {
        price: num(o.price, 0, 50, 0), open: o.open === true && o.building !== true, broken: o.broken === true,
        stats: { riders: num(o.stats?.riders, 0, 1e9), revenue: num(o.stats?.revenue, 0, 1e10) },
        track: { dir: t.dir, pieces }, building: o.building === true,
        name: String(o.name ?? 'Custom Coaster').slice(0, 40) || 'Custom Coaster',
        ...looks(o),
        trainColor: isHexColor(o.trainColor) ? o.trainColor : undefined,
        cars: Number.isInteger(o.cars) ? clamp(o.cars, 2, 7) : 4,
      }));
      continue;
    }
    if (o.kind === 'retribution') {
      // An interrupted show returns its prisoners to custody.
      for (const v of Array.isArray(o.show?.victims) ? o.show.victims.slice(0, 50) : []) pendingCaptives.push(String(v).slice(0, 30));
    }
    park.objects.push(makeObject(o.kind, o.id, o.x, o.y, num(o.paid, 0, def.cost, 0), {
      price: num(o.price, 0, 50, 'price' in def ? def.price : 0),
      open: o.open !== false,
      broken: o.broken === true,
      stats: { riders: num(o.stats?.riders, 0, 1e9), revenue: num(o.stats?.revenue, 0, 1e10) },
      ...(o.kind === 'retribution' ? { pit: o.pit === 'water' ? 'water' : 'fire', show: null } : {}),
      ...(o.kind === 'memorial' ? { graves: num(o.graves, 0, 500, 0) } : {}),
      ...(STALLS[o.kind] ? { corrupt: o.corrupt === true, exposed: o.corrupt === true && o.exposed === true, deals: num(o.deals, 0, 1e6) } : {}),
      ...looks(o),
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
      crime: isKey(CRIME.types, g.crime) || g.crime === 'panda' ? g.crime : null,
      hp: num(g.hp, 0, PANDEMONIUM.hp[1], PANDEMONIUM.hp[1]),
      maxHp: num(g.maxHp, 1, PANDEMONIUM.hp[1], PANDEMONIUM.hp[1]),
      acc: num(g.acc, 0, 1, PANDEMONIUM.pandaAccuracy[0]),
      crimeT: num(g.crimeT, 0, 1e4, 20),
      record: cleanRecord(g.record),
      gang: CRIME.gangs.includes(g.gang) ? g.gang : null,
      high: num(g.high, 0, 1000, 0),
      crimes: num(g.crimes, 0, 100),
      loot: num(g.loot, 0, 1e7),
      heistLoot: g.heistLoot === true,
      spotted: g.spotted === true,
      injured: g.injured === true,
      type: isKey(GUEST_TYPES, g.type) ? g.type : 'family',
      umbrella: g.umbrella === true, map: g.map === true, souvenir: g.souvenir === true, atmUsed: g.atmUsed === true,
      // Riders/queuers resume walking; ride state is not persisted.
      state: 'walk',
    });
    const last = park.guests[park.guests.length - 1]!;
    if (last.crime === 'panda' && (last.hp ?? 0) <= 0) last.hp = 1;
  }
  for (const s of data.staff) {
    if (!s || !isKey(STAFF, s.role) || !okPos(s)) continue;
    ensureId(s.id);
    const st = newStaff(s.role, s.id, s.x, s.y);
    applyTraits(st, Array.isArray(s.traits) ? s.traits.filter((t: unknown, i: number, a: unknown[]) => isKey(STAFF_TRAITS, t) && a.indexOf(t) === i).slice(0, 3) : []);
    park.staff.push({
      ...st, nx: s.nx, ny: s.ny, name: String(s.name ?? '').slice(0, 40),
      hp: num(s.hp, 0, st.maxHp, st.maxHp), acc: num(s.acc, 0, 1, st.acc), down: num(s.down, 0, 600, 0),
      traits: st.traits,
    });
  }
  park.nextId = Math.max(maxId + 1, Number.isInteger(data.nextId) ? data.nextId : 0);

  const st = data.stats || {};
  park.stats.totalGuests = num(st.totalGuests, 0, 1e9);
  park.stats.peakGuests = num(st.peakGuests, 0, 1e6);
  park.stats.arrests = num(st.arrests, 0, 1e9);
  park.stats.crimes = num(st.crimes, 0, 1e9);
  if (st.today && typeof st.today === 'object') {
    for (const k of Object.keys(park.stats.today) as (keyof Ledger)[]) park.stats.today[k] = num(st.today[k], -1e10, 1e10, 0);
  }
  if (Array.isArray(st.history)) {
    park.stats.history = st.history.slice(-30).map((h: any) => ({
      day: num(h?.day, 0, 1e7), income: num(h?.income, -1e10, 1e10), expenses: num(h?.expenses, -1e10, 1e10),
      guests: num(h?.guests, 0, 1e6), crimes: num(h?.crimes, 0, 1e6),
    }));
  }
  if (Array.isArray(data.thoughts)) {
    park.thoughts = data.thoughts.slice(0, 25).map((t: any) => ({
      text: String(t?.text ?? '').slice(0, 120), who: String(t?.who ?? '').slice(0, 20), day: num(t?.day, 0, 1e7),
    }));
  }
  if (Array.isArray(data.incidents)) {
    park.incidents = data.incidents.slice(0, 30).map((t: any) => ({
      type: INCIDENT_TYPES.includes(t?.type) ? t.type : 'theft',
      text: String(t?.text ?? '').slice(0, 160), day: num(t?.day, 0, 1e7),
    }));
  }
  if (Array.isArray(data.fallen)) {
    park.fallen = data.fallen.slice(0, 500).map((f: any) => ({
      name: String(f?.name ?? 'Officer').slice(0, 40), role: isKey(STAFF, f?.role) ? f.role : 'squad',
      by: String(f?.by ?? 'Pandemonium').slice(0, 40), day: num(f?.day, 0, 1e7), payout: num(f?.payout, 0, 1e7),
    }));
  }
  if (Array.isArray(data.captives)) {
    park.captives = data.captives.slice(0, 50).map((c: any) => ({ name: String(c?.name ?? 'Panda').slice(0, 30) }));
  }
  park.captives.push(...pendingCaptives.map((name) => ({ name })));
  if (Array.isArray(data.custody)) {
    park.custody = data.custody.slice(0, 100).filter((c: any) => Number.isInteger(c?.id)).map((c: any) => ({
      id: c.id, name: String(c.name ?? 'Suspect').slice(0, 30),
      kind: isKey(CRIME.types, c.kind) || c.kind === 'panda' ? c.kind : 'pickpocket',
      gang: CRIME.gangs.includes(c.gang) ? c.gang : null,
      record: cleanRecord(c.record), by: String(c.by ?? '').slice(0, 60), day: num(c.day, 0, 1e7),
    }));
  }
  park.fence = data.fence === true;
  park.locked = park.fence && data.locked === true;
  park.stats.drugDeals = num(data.stats?.drugDeals, 0, 1e9);
  park.stats.gangRecruits = num(data.stats?.gangRecruits, 0, 1e9);
  const pd = data.pandemonium || {};
  for (const k of Object.keys(park.pandemonium) as (keyof PandemoniumStats)[]) park.pandemonium[k] = num(pd[k], 0, 1e7, park.pandemonium[k]);
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
    park.objectives = data.objectives.filter((id: unknown): id is string => typeof id === 'string' && valid.has(id));
  }

  rebuildIndex(park);
  return park;
}

function createEmpty(): Park {
  return {
    ...transientDefaults(),
    version: SAVE_VERSION, settings: sanitizeSettings(), seed: 1, weather: { type: 'sunny', day: 1 }, buzz: 0, effects: [], eventLog: [], pathStyles: [], uniforms: {}, name: '', rngState: 1, time: 0, cash: 0, entranceFee: 10, open: true, rating: 500, safety: 100, nextId: 1,
    tiles: [], litter: [], stains: [], objects: [], guests: [], staff: [], raid: null, captives: [], custody: [], fallen: [], fence: false, locked: false, pandemonium: newPandaStats(),
    stats: { totalGuests: 0, peakGuests: 0, arrests: 0, crimes: 0, drugDeals: 0, gangRecruits: 0, today: newLedger(), history: [] },
    thoughts: [], incidents: [], objectives: [],
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const walkable = (park: Park, i: number) => park.tiles[i] === TILE.PATH || park.tiles[i] === TILE.ENTRANCE;
export const objectAt = (park: Park, x: number, y: number) => (inBounds(x, y) ? park._byId.get(park._objAt[idx(x, y)]) || null : null);
export const getObject = (park: Park, id: number) => park._byId.get(id) || null;
export const day = (park: Park) => Math.floor(park.time / DAY_SECONDS) + 1;
export const dayProgress = (park: Park) => (park.time % DAY_SECONDS) / DAY_SECONDS;

export function guestAt(park: Park, fx: number, fy: number, radius = 0.45) {
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
export function actorPos(a: Walker): { x: number; y: number } {
  return { x: a.x + (a.nx - a.x) * a.t + 0.5, y: a.y + (a.ny - a.y) * a.t + 0.5 };
}

export function parkStats(park: Park) {
  let customCoasters = 0;
  let rides = 0, coasters = 0, stalls = 0, assets = 0, excitement = 0, broken = 0, beauty = 0;
  for (const o of park.objects) {
    assets += o.paid;
    const cat = itemCategory(o.kind);
    if (cat === 'ride') {
      rides++;
      const rd = rideDef(o)!;
      if (rd.coaster) coasters++;
      if (o.kind === 'custom' && !o.building) customCoasters++;
      if (o.open) excitement += rd.excitement;
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
    rides, coasters, customCoasters, stalls, broken, excitement, beauty, litter,
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

export function parkSummary(park: Park) {
  const s = parkStats(park);
  return { name: park.name, value: s.value, rating: s.rating, guests: s.guests, day: day(park) };
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export function canPlace(park: Park, kind: string, x: number, y: number) {
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

function makeObject(kind: string, id: number, x: number, y: number, paid: number, extra: Partial<ParkObject> = {}): ParkObject {
  const def = itemDef(kind);
  if (!def) throw new Error(`unknown object kind ${kind}`);
  const obj: ParkObject = { id, kind, x, y, w: def.w, h: def.h, paid, _access: [] };
  const cat = itemCategory(kind);
  if (cat === 'ride' || cat === 'stall') {
    Object.assign(obj, { price: 'price' in def ? def.price : 0, open: true, broken: false, stats: { riders: 0, revenue: 0 } });
  }
  if (cat === 'ride') Object.assign(obj, { phase: 'idle', timer: 0, wait: 0, queue: [], riders: [] });
  if (kind === 'retribution') Object.assign(obj, { pit: 'fire', show: null });
  return Object.assign(obj, extra);
}

function addObject(park: Park, kind: string, x: number, y: number, paid: number): ParkObject {
  const obj = makeObject(kind, park.nextId++, x, y, paid);
  park.objects.push(obj);
  park._byId.set(obj.id, obj);
  for (let yy = y; yy < y + obj.h; yy++) for (let xx = x; xx < x + obj.w; xx++) park._objAt[idx(xx, yy)] = obj.id;
  refreshAccess(park);
  return obj;
}

export function build(park: Park, kind: string, x: number, y: number) {
  if (kind === 'retribution' && !cfgOf(park).executions) return { ok: false, reason: 'Executions are turned off in this park\'s rules.' };
  if (SPECIAL[kind]?.auto) return { ok: false, reason: 'That cannot be built by hand.' };
  const check = canPlace(park, kind, x, y);
  if (!check.ok) return check;
  const def = itemDef(kind)!;
  spend(park, def.cost, 'construction');
  const obj = addObject(park, kind, x, y, def.cost);
  obj.builtDay = day(park);
  const cat = itemCategory(kind);
  if (STALLS[kind] && (STALLS[kind].sells === 'food' || STALLS[kind].sells === 'drink')) {
    const chance = cfgOf(park).drugs ? CRIME.corruptVendorChance * Math.min(1.5, cfgOf(park).crimeRate) : 0;
    Object.assign(obj, { corrupt: rand(park) < chance, exposed: false, deals: 0 });
  }
  const warn = cat !== 'scenery' && obj._access.length === 0 ? 'Connect it to a path so guests can reach it.' : null;
  return { ok: true, obj, warn };
}

export function buildPath(park: Park, x: number, y: number, style = 0) {
  if (!inBounds(x, y)) return { ok: false, reason: 'Out of bounds' };
  const i = idx(x, y);
  style = clamp(Math.round(style) || 0, 0, PATH_STYLES.length - 1);
  if (park.tiles[i] === TILE.PATH && park.pathStyles[i] !== style) {
    // Repaint an existing path in a new style.
    if (park.cash < 2) return { ok: false, reason: 'Not enough cash', cash: true };
    spend(park, 2, 'construction');
    park.pathStyles[i] = style;
    return { ok: true, repainted: true };
  }
  if (park.tiles[i] !== TILE.GRASS) return { ok: false, reason: 'Already a path', silent: true };
  if (park._objAt[i]) return { ok: false, reason: 'Something is in the way' };
  if (park.cash < PATH_COST) return { ok: false, reason: 'Not enough cash', cash: true };
  spend(park, PATH_COST, 'construction');
  park.tiles[i] = TILE.PATH;
  park.pathStyles[i] = style;
  refreshAccess(park);
  return { ok: true };
}

export function bulldoze(park: Park, x: number, y: number) {
  if (!inBounds(x, y)) return { ok: false, reason: 'Out of bounds' };
  const i = idx(x, y);
  const obj = objectAt(park, x, y);
  if (obj) {
    if (obj.kind === 'memorial') return { ok: false, reason: 'The memorial to fallen officers cannot be removed.' };
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

function removeObject(park: Park, obj: ParkObject) {
  if (isRideObj(obj)) for (const gid of [...obj.queue, ...obj.riders]) releaseGuest(park, park._guestById.get(gid));
  for (const s of park.staff) if (s.task === obj.id) s.task = null;
  for (const [xx, yy] of cellsOf(obj)) park._objAt[idx(xx, yy)] = 0;
  park.objects.splice(park.objects.indexOf(obj), 1);
  park._byId.delete(obj.id);
  const refund = Math.round(obj.paid * REFUND_RATE);
  if (refund) earn(park, refund, 'construction');
  refreshAccess(park);
}

export function setPrice(park: Park, id: number, price: number) {
  const obj = getObject(park, id);
  if (obj && 'price' in obj) obj.price = clamp(Math.round(price * 2) / 2, 0, 50);
}

export function setOpen(park: Park, id: number, open: boolean) {
  const obj = getObject(park, id);
  if (!obj || !('open' in obj)) return;
  if (open && obj.building) return; // custom coasters open via openCoaster()
  obj.open = open;
  if (!open && isRideObj(obj)) for (const gid of obj.queue.splice(0)) releaseGuest(park, park._guestById.get(gid));
}

export function setEntranceFee(park: Park, fee: number) { park.entranceFee = clamp(Math.round(fee), 0, 100); }
export function setParkOpen(park: Park, open: boolean) { park.open = !!open; }
export function renamePark(park: Park, name: string) { park.name = String(name).trim().slice(0, 40) || park.name; }

export function hire(park: Park, role: StaffRole) {
  if (!STAFF[role]) return { ok: false, reason: 'Unknown role' };
  if (park.staff.length >= 200) return { ok: false, reason: 'Too many staff' };
  const req = STAFF[role].requires;
  const base = req ? park.objects.find((o) => o.kind === req) : null;
  if (req && !base) return { ok: false, reason: `Build a ${itemDef(req)!.name} first.` };
  const start = base?._access[0];
  const s = start !== undefined
    ? newStaff(role, park.nextId++, start % GRID, (start / GRID) | 0)
    : newStaff(role, park.nextId++, ENTRANCE.x, ENTRANCE.y - 1);
  s.name = `${pick(park, FIRST_NAMES)} the ${STAFF[role].name}`;
  if (STAFF[role].accuracy) s.acc = randIn(park, STAFF[role].accuracy);
  applyTraits(s, rollTraits(park, role));
  park.staff.push(s);
  return { ok: true, staff: s };
}

const TRAIT_CLASHES = [['speedy', 'lazy'], ['sharpshooter', 'clumsy'], ['tough', 'fragile'], ['veteran', 'rookie']];

function rollTraits(park: Park, role: StaffRole) {
  const r = rand(park);
  const n = r < 0.4 ? 0 : r < 0.85 ? 1 : 2;
  const pool = Object.entries(STAFF_TRAITS).filter(([, t]) => !t.roles || t.roles.includes(role)).map(([k]) => k);
  const out: string[] = [];
  for (let tries = 0; out.length < n && tries < 20; tries++) {
    const t = pick(park, pool);
    if (out.includes(t) || TRAIT_CLASHES.some((pair) => pair.includes(t) && pair.some((o) => out.includes(o)))) continue;
    out.push(t);
  }
  return out;
}

/** Applies trait effects that change stored stats (health, accuracy). */
function applyTraits(s: Staff, traits: string[]) {
  s.traits = traits;
  const base = STAFF[s.role];
  s.maxHp = Math.max(1, base.hp + traits.reduce((n, t) => n + (STAFF_TRAITS[t].hp || 0), 0));
  s.hp = s.maxHp;
  if (base.accuracy) s.acc = clamp(s.acc + traits.reduce((n, t) => n + (STAFF_TRAITS[t]?.accuracy || 0), 0), 0.2, 0.97);
}

/** Multiplier from traits for runtime effects (speed, wage, workSpeed). */
export function traitMul(s: Staff, key: 'speed' | 'wage' | 'workSpeed'): number {
  return (s.traits || []).reduce((m, t) => m * (STAFF_TRAITS[t]?.[key] ?? 1), 1);
}

export const wageOf = (park: Park, s: Staff) => Math.round(STAFF[s.role].wage * cfgOf(park).wages * traitMul(s, 'wage'));

export function fire(park: Park, id: number) {
  const i = park.staff.findIndex((s) => s.id === id);
  if (i >= 0) park.staff.splice(i, 1);
}

function newStaff(role: StaffRole, id: number, x: number, y: number): Staff {
  const def = STAFF[role];
  const acc = def.accuracy ? (def.accuracy[0] + def.accuracy[1]) / 2 : 0;
  return {
    id, role, name: '', x, y, nx: x, ny: y, lx: x, ly: y, t: 0, route: null, task: null, busy: 0, chase: null, cool: 0,
    hp: def.hp, maxHp: def.hp, acc, down: 0, traits: [],
  };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

function earn(park: Park, amount: number, category: LedgerCategory) {
  park.cash += amount;
  const t = park.stats.today;
  t.income += amount;
  t[category] = (t[category] || 0) + amount;
}

function spend(park: Park, amount: number, category: LedgerCategory) {
  park.cash -= amount;
  const t = park.stats.today;
  t.expenses += amount;
  t[category] = (t[category] || 0) - amount;
}

// ---------------------------------------------------------------------------
// Pathfinding
// ---------------------------------------------------------------------------

function bfs(park: Park, start: number, allowEntrance = false) {
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

function traceRoute(prev: Int32Array, start: number, goal: number) {
  const route = [];
  for (let c = goal; c !== start; c = prev[c]) {
    if (c < 0) return null;
    route.push(c);
  }
  return route.reverse();
}

/** Nearest access tile of `obj` from a BFS result, or null if unreachable. */
function nearestAccess(obj: ParkObject, dist: Int16Array) {
  let best = null;
  for (const a of obj._access) if (dist[a] >= 0 && (best === null || dist[a] < dist[best])) best = a;
  return best;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export function step(park: Park, dt: number) {
  const prevDay = day(park);
  park.time += dt;

  spawnGuests(park, dt);
  for (const g of park.guests) updateGuest(park, g, dt);
  for (const obj of park.objects) {
    if (isRideObj(obj)) updateRide(park, obj, dt);
    else if (obj.show) updateShow(park, obj, dt);
  }
  for (const s of park.staff) updateStaff(park, s, dt);

  if (park.guests.some((g) => g.gone)) {
    park.guests = park.guests.filter((g) => !g.gone);
    park._guestById = new Map(park.guests.map((g) => [g.id, g]));
  }

  park.safety = Math.min(100, park.safety + CRIME.safetyRecovery * dt);
  park.buzz *= 1 - 0.004 * dt;
  park._slowT = (park._slowT || 0) + dt;
  if (park._slowT >= 1) {
    park._slowT = 0;
    checkRaidOver(park);
    if (park.effects.length) park.effects = park.effects.filter((e) => e.until > park.time);
    maybeChangeWeather(park);
    updateRating(park);
    checkObjectives(park);
  }
  if (day(park) !== prevDay) endDay(park, prevDay);
}

function spawnGuests(park: Park, dt: number) {
  if (!park.open || park.locked) return;
  const s = parkStats(park);
  const attraction = 0.06 + s.rides * 0.07 + s.stalls * 0.01 + s.excitement * 0.012;
  const ratingF = 0.4 + (park.rating / 1000) * 1.2;
  const feeF = clamp(1 - (park.entranceFee - (6 + s.excitement * 0.8)) / 40, 0.03, 1.3);
  const cap = Math.min(MAX_GUESTS, 30 + s.rides * 35 + s.stalls * 5);
  const crowd = park.guests.length >= cap ? 0.05 : 1;
  const safetyF = 0.5 + park.safety / 200;
  const worldF = cfgOf(park).guestRate * weatherOf(park).arrivals * (1 + park.buzz / 200) * (hasEffect(park, 'protest') ? 0.5 : 1);
  park._spawnAcc = (park._spawnAcc || 0) + attraction * ratingF * feeF * safetyF * crowd * worldF * dt;
  while (park._spawnAcc >= 1) {
    park._spawnAcc -= 1;
    spawnGuest(park);
  }
}

/** Everything about a guest that isn't set from their arrival (position, needs, money...). */
type GuestDefaults = Omit<Guest, 'id' | 'name' | 'shirt' | 'x' | 'y' | 'nx' | 'ny' | 'lx' | 'ly' | 't' | 'cash' | 'happy'
  | 'hunger' | 'thirst' | 'bladder' | 'energy' | 'nausea' | 'pref' | 'thrift' | 'timeIn'>;

function newGuestStats(): GuestDefaults {
  return {
    state: 'walk', target: null, route: null, busy: 0, queueT: 0, queueAt: -1,
    thought: '', thoughtT: 0, litterT: 0, decideIn: 0, ridden: {}, rides: 0, gone: false, leaving: false,
    crime: null, crimeT: 0, crimes: 0, loot: 0, heistLoot: false, heist: null, spotted: false, injured: false,
    record: newRecord(), gang: null, high: 0,
    type: 'family', umbrella: false, map: false, souvenir: false, atmUsed: false,
  };
}

function spawnGuest(park: Park, opts: SpawnOpts = {}) {
  const cfg = cfgOf(park);
  const type = opts.type || weighted(GUEST_TYPES, rand(park));
  const T = GUEST_TYPES[type];
  const cash = Math.round((opts.cash ?? randIn(park, T.cash)) * (opts.cash ? 1 : cfg.guestWealth));
  if (cash < park.entranceFee) return null;
  const [pLo, pHi] = T.pref;
  const g = {
    ...newGuestStats(),
    type,
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
    pref: pLo + Math.floor(rand(park) * (pHi - pLo + 1)), // max ride intensity they enjoy
    thrift: rand(park),
    timeIn: 0,
  };
  if (opts.name) g.name = opts.name;
  if (!walkable(park, idx(g.nx, g.ny))) return null;
  const crimeRate = (CRIME.baseRate + (park.rating < 400 ? CRIME.lowRatingRate : 0)) * cfg.crimeRate * (T.crime || 1);
  const dealerRate = cfg.drugs ? CRIME.dealerRate * Math.min(1.5, cfg.crimeRate) : 0;
  if (opts.crime) {
    g.crime = opts.crime;
    g.crimeT = 10 + rand(park) * 20;
    g.gang = opts.gang || null;
  } else if (opts.honest) {
    // no criminals in special arrivals
  } else if (rand(park) < dealerRate) {
    g.crime = 'dealer';
    g.crimeT = 10 + rand(park) * 20;
    g.gang = pick(park, CRIME.gangs);
  } else if (rand(park) < crimeRate) {
    let r = rand(park);
    for (const [type, share] of Object.entries(CRIME.types) as [CrimeKind, number][]) {
      g.crime = type;
      if ((r -= share) < 0) break;
    }
    g.crimeT = 15 + rand(park) * 30;
    if (g.crime === 'dealer' || rand(park) < CRIME.gangChance) g.gang = pick(park, CRIME.gangs);
  }
  if (park.entranceFee) earn(park, park.entranceFee, 'admissions');
  park.guests.push(g);
  park._guestById.set(g.id, g);
  park.stats.totalGuests++;
  park.stats.peakGuests = Math.max(park.stats.peakGuests, park.guests.length);
  return g;
}

function think(park: Park, g: Guest, text: string, force = false) {
  if (g.thoughtT > 0 && !force) return;
  g.thought = text;
  g.thoughtT = 12;
  if (rand(park) < 0.3 || force) {
    park.thoughts.unshift({ text, who: g.name, day: day(park) });
    if (park.thoughts.length > 25) park.thoughts.length = 25;
  }
}

function startLeaving(park: Park, g: Guest, reason?: string) {
  if (g.leaving) return;
  g.leaving = true;
  g.target = null;
  g.route = null;
  if (reason) think(park, g, reason);
}

function releaseGuest(park: Park, g: Guest | undefined) {
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

function updateGuest(park: Park, g: Guest, dt: number) {
  if (g.crime === 'panda') return updatePanda(park, g, dt);
  g.timeIn += dt;
  g.thoughtT -= dt;
  const pace = g.state === 'ride' ? 0.3 : 1;
  const T = guestType(g), W = weatherOf(park);
  g.hunger = Math.min(100, g.hunger + 0.42 * T.hunger * dt * pace);
  g.thirst = Math.min(100, g.thirst + 0.5 * W.thirst * dt * pace);
  g.bladder = Math.min(100, g.bladder + 0.28 * dt * pace);
  g.energy = Math.max(0, g.energy - 0.18 * T.energy * dt * pace);
  g.nausea = Math.max(0, g.nausea - 1.2 * dt);

  let drain = 0;
  if (g.hunger > 85) { drain += 0.5; if (rand(park) < 0.02) think(park, g, "I'm starving!"); }
  if (g.thirst > 85) { drain += 0.5; if (rand(park) < 0.02) think(park, g, "I'm so thirsty."); }
  if (g.bladder > 90) { drain += 0.8; if (rand(park) < 0.02) think(park, g, 'I really need a restroom!'); }
  if (g.nausea > 60) { drain += 0.4; if (rand(park) < 0.02) think(park, g, 'I feel sick...'); }
  if (g.energy < 20) drain += 0.2;
  if (W.happyDrain && !(W.umbrella && g.umbrella) && g.state === 'walk') {
    drain += W.happyDrain;
    if (rand(park) < 0.004) think(park, g, W.precip === 'snow' ? "I'm freezing out here." : W.precip ? "I'm getting soaked!" : 'This heat is unbearable.');
  }
  g.happy = clamp(g.happy - drain * dt, 0, 100);

  if (g.litterT > 0) {
    g.litterT -= dt;
    if (g.litterT <= 0) dropLitter(park, g.x, g.y, guestType(g).litter);
  }

  if (g.heist && !g.target) { g.heist = null; g.crimeT = 10; } // heist target became unreachable
  if (g.high > 0) {
    g.high -= dt;
    g.energy = Math.min(100, g.energy + 0.1 * dt);
    if (rand(park) < 0.004) think(park, g, pick(park, ['Whoa... the colors...', 'Which way is the exit again?', 'I can hear the rides breathing.', 'Best. Park. EVER.']));
    if (g.high <= 0) comeDown(park, g);
  }
  if (park.locked && g.leaving && !g.crime) {
    g.happy = Math.max(0, g.happy - 0.6 * dt);
    if (rand(park) < 0.01) think(park, g, 'The exits are locked! Let us out!');
  }
  if (g.crime && !g.leaving && g.state === 'walk') {
    g.crimeT -= dt;
    if (g.crimeT <= 0) planCrime(park, g);
  }

  if (g.state === 'walk') walkGuest(park, g, dt);
  else if (g.state === 'queue') {
    g.queueT += dt;
    g.happy = Math.max(0, g.happy - 0.08 * dt);
    if (g.queueT > 45) {
      const ride = park.objects.find((o): o is RideObject => isRideObj(o) && o.queue.includes(g.id));
      if (ride) ride.queue.splice(ride.queue.indexOf(g.id), 1);
      releaseGuest(park, g);
      g.happy -= 8;
      think(park, g, `I've waited too long for ${ride ? rideDef(ride)!.name : 'this ride'}.`);
    }
  } else if (g.state === 'busy' || g.state === 'sit') {
    g.busy -= dt;
    if (g.state === 'sit') g.energy = Math.min(100, g.energy + 7 * dt);
    if (g.busy <= 0) g.state = 'walk';
  }
}

function dropLitter(park: Park, x: number, y: number, chance = 0.75) {
  for (let yy = y - 1; yy <= y + 1; yy++) {
    for (let xx = x - 1; xx <= x + 1; xx++) {
      const o = objectAt(park, xx, yy);
      if (o && SCENERY[o.kind]?.bin) return;
    }
  }
  const i = idx(x, y);
  if (park.tiles[i] === TILE.PATH && rand(park) < chance) park.litter[i] = Math.min(5, park.litter[i] + 1);
}

function moveActor(park: Park, a: Walker, dt: number, speed: number) {
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
function advance(park: Park, a: Walker, allowEntrance = false) {
  if (a.route?.length) {
    const n = a.route.shift()!;
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

function walkGuest(park: Park, g: Guest, dt: number) {
  if (!moveActor(park, g, dt, GUEST_SPEED * guestType(g).speed * (g.energy < 20 ? 0.6 : 1))) return;
  const here = idx(g.x, g.y);
  if (!walkable(park, here)) { g.gone = true; return; }
  if (g.nx !== g.x || g.ny !== g.y) return;
  onArrive(park, g, here);
  if (g.gone || g.state !== 'walk') return;
  decide(park, g, here);
}

function onArrive(park: Park, g: Guest, here: number) {
  if (park.tiles[here] === TILE.ENTRANCE && g.leaving && !park.locked && g.high <= 0) {
    if (g.crime && g.spotted && rand(park) < CRIME.gateArrestChance) arrest(park, g, 'park security at the gate');
    if (guestType(g).influencer && !g.crime) influencerReview(park, g);
    g.gone = true;
    return;
  }
  if (!g.map) {
    for (const [dx, dy] of DIRS) {
      const o = objectAt(park, g.x + dx, g.y + dy);
      if (o && hasTill(o) && STALLS[o.kind]?.sells === 'info' && o.open && g.cash >= o.price && rand(park) < 0.6) {
        g.map = true;
        g.cash -= o.price;
        if (o.price) earn(park, o.price, 'shops');
        o.stats.revenue += o.price;
        o.stats.riders++;
        think(park, g, 'Got a park map. Now I know where everything is!');
        break;
      }
    }
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

function decide(park: Park, g: Guest, here: number) {
  if (g.leaving && (g.high > 0 || park.locked)) {
    // Too high to find the exit, or the exits are sealed: wander.
    g.route = null;
    if (g.high > 0 && rand(park) < 0.05) think(park, g, "I can't find the exit... where am I?");
    advance(park, g);
    return;
  }
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
      const tgt = g.target ? getObject(park, g.target) : null;
      if (tgt && tgt._access.includes(here)) return interact(park, g, tgt, here);
    }
  }
  advance(park, g);
}

const NEED_THOUGHTS: Record<string, string> = {
  restroom: "I can't find a restroom!",
  drink: "I can't find anything to drink.",
  firstaid: "I'm hurt and there's no first aid here!",
  food: "I can't find anything to eat.",
  umbrella: 'I wish I could buy an umbrella.',
};

function pickGoal(park: Park, g: Guest, here: number) {
  if (g.happy < 20) return startLeaving(park, g, "I'm not having fun. I'm going home.");
  if (g.energy < 8) return startLeaving(park, g, "I'm exhausted. Time to go home.");
  if (g.timeIn > DAY_SECONDS * 2.2) return startLeaving(park, g, 'What a day! Heading home.');
  const hasShop = (sells: string) => park.objects.some((o) => STALLS[o.kind]?.sells === sells && o.open && o._access.length);
  if (g.cash < 8 && !g.atmUsed && hasShop('atm')) {
    // Low on cash but there's a cash machine: top up instead of leaving.
  } else if (g.cash < 1 && rand(park) < 0.4) return startLeaving(park, g, "I'm out of money.");

  const W = weatherOf(park), T = guestType(g);
  let need: string | null = null; // a shop's `sells`, or 'seat'
  if (g.injured) need = 'firstaid';
  else if (g.bladder > 70) need = 'restroom';
  else if (g.cash < 8 && !g.atmUsed && hasShop('atm')) need = 'atm';
  else if (W.umbrella && !g.umbrella && g.cash > 6 && rand(park) < 0.6) need = 'umbrella';
  else if (g.thirst > 65) need = 'drink';
  else if (g.hunger > 65) need = 'food';
  else if (g.energy < 35) need = 'seat';
  else if (!g.souvenir && g.happy > 60 && g.cash > 15 && rand(park) < T.souvenir * 0.15) need = 'souvenir';

  const { dist, prev } = bfs(park, here);
  let best: ParkObject | null = null, bestScore = -Infinity, bestGoal = -1;
  for (const obj of park.objects) {
    if (!obj._access.length) continue;
    let score: number;
    if (need) {
      if (need === 'seat' ? !SCENERY[obj.kind]?.seat : STALLS[obj.kind]?.sells !== need || !obj.open) continue;
      score = 0;
    } else {
      const def = rideDef(obj);
      if (!def || !isRideObj(obj) || !obj.open || obj.broken || def.intensity > g.pref + 2 || obj.price > g.cash) continue;
      score = def.excitement * 10 - (g.ridden[obj.id] || 0) * 18 - obj.queue.length * 1.5 + rand(park) * 12;
    }
    const goal = nearestAccess(obj, dist);
    if (goal === null) continue;
    score -= dist[goal] * (need ? 1 : 0.6);
    if (score > bestScore) { bestScore = score; best = obj; bestGoal = goal; }
  }

  if (!best && need === 'firstaid') return startLeaving(park, g, "I'm hurt. I need to get out of here.");
  if (!best) {
    if (need && NEED_THOUGHTS[need]) { g.happy = Math.max(0, g.happy - (g.map ? 1 : 3)); think(park, g, NEED_THOUGHTS[need]); }
    else if (!need && rand(park) < 0.1) think(park, g, "There isn't much to do here.");
    return;
  }
  if (!need && !g.map && rand(park) < 0.25) return; // sometimes just wander (a map helps)
  g.target = best.id;
  g.route = traceRoute(prev, here, bestGoal);
}

function rideValue(park: Park, def: RideDef, g: Guest) {
  return (1.5 + def.excitement * 1.05) * (0.75 + g.thrift * 0.5) * cfgOf(park).priceTolerance;
}

function interact(park: Park, g: Guest, obj: ParkObject, here: number) {
  g.target = null;
  g.route = null;
  if (g.heist === obj.id) return commitHeist(park, g, obj);
  if (obj.kind === 'retribution') return watchShow(park, g, obj);
  const ride = rideDef(obj);
  const stall: StallDef | undefined = STALLS[obj.kind];
  if (ride && isRideObj(obj)) {
    if (!obj.open || obj.broken) return think(park, g, `${ride.name} isn't running.`);
    if (obj.price > g.cash) return think(park, g, `I can't afford ${ride.name}.`);
    if (obj.price > rideValue(park, ride, g)) {
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
  } else if (stall && hasTill(obj)) {
    if (!obj.open || obj.broken) return think(park, g, `${stall.name} has been smashed up.`);
    if (obj.price > g.cash) return think(park, g, `I can't afford ${stall.name}.`);
    const heat = stall.snack && park.weather.type === 'heatwave' ? 1.5 : 1;
    const value = (SHOP_VALUE[stall.sells] ?? 2) * (0.75 + g.thrift * 0.5) * cfgOf(park).priceTolerance * heat;
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
    if (obj.corrupt && cfgOf(park).drugs && !g.crime && g.high <= 0 && rand(park) < CRIME.corruptOfferChance) vendorDeal(park, g, obj);
    if (stall.sells === 'food') {
      if (stall.snack) { g.hunger = Math.max(0, g.hunger - 50); g.thirst = Math.max(0, g.thirst - 20); g.happy = Math.min(100, g.happy + 6 * heat); }
      else { g.hunger = 0; g.happy = Math.min(100, g.happy + 5); }
      g.litterT = 4 + rand(park) * 10;
    }
    if (stall.sells === 'drink') {
      g.thirst = 0; g.bladder += 20; g.happy = Math.min(100, g.happy + 4); g.litterT = 4 + rand(park) * 10;
      if (stall.energy) g.energy = Math.min(100, g.energy + stall.energy);
    }
    if (stall.sells === 'souvenir') {
      g.souvenir = true;
      g.happy = Math.min(100, g.happy + (g.type === 'tourist' ? 15 : 10));
      think(park, g, `I bought a souvenir from ${park.name}!`);
    }
    if (stall.sells === 'umbrella') { g.umbrella = true; g.happy = Math.min(100, g.happy + 5); think(park, g, 'Finally, an umbrella!'); }
    if (stall.sells === 'atm') {
      g.atmUsed = true;
      g.cash += Math.round(40 + rand(park) * 60);
      think(park, g, 'Topped up my wallet at the cash machine.');
    }
    if (stall.sells === 'info') g.map = true;
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

function updateRide(park: Park, obj: RideObject, dt: number) {
  const def = rideDef(obj)!;
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
    if (hasEffect(park, 'outage')) return; // no power, no rides
    obj.wait += dt;
    if (obj.queue.length >= def.capacity || obj.wait >= 4) {
      obj.riders = obj.queue.splice(0, def.capacity);
      for (const gid of obj.riders) { const rider = park._guestById.get(gid); if (rider) rider.state = 'ride'; }
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
  const failChance = (1 - def.reliability + ageLoss(park, obj)) * cfgOf(park).breakdowns * weatherOf(park).breakdown;
  if (rand(park) < failChance) {
    obj.broken = true;
    park._events.push({ type: 'warn', text: `${def.name} has broken down! A mechanic is needed.` });
  }
}

function updateStaff(park: Park, s: Staff, dt: number) {
  if (s.down > 0) {
    s.down -= dt;
    if (s.down <= 0) { s.down = 0; s.hp = s.maxHp; }
    return;
  }
  if (s.role === 'squad') squadShoot(park, s, dt);
  if (s.busy > 0) {
    s.busy -= dt;
    if (s.busy <= 0) finishStaffJob(park, s);
    return;
  }
  const hurry = s.chase || (s.role === 'squad' && park.raid);
  if (!moveActor(park, s, dt, (hurry ? STAFF_SPEED * 1.5 : STAFF_SPEED) * traitMul(s, 'speed'))) return;
  const here = idx(s.x, s.y);
  if (!walkable(park, here)) { // path was removed underneath them
    s.x = s.nx = ENTRANCE.x; s.y = s.ny = ENTRANCE.y - 1; s.t = 0; s.route = null;
    return;
  }
  if (s.nx !== s.x || s.ny !== s.y) return;

  if (s.role === 'janitor') {
    if (park.litter[here] > 0 || park.stains[here] > 0) { s.busy = (1.2 + park.stains[here] * 0.8) / traitMul(s, 'workSpeed'); s.job = here; return; }
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
    if (ride && ride._access.includes(here)) { s.busy = 4 / traitMul(s, 'workSpeed'); s.job = ride.id; s.route = null; return; }
    if (ride && !s.route) {
      const { dist, prev } = bfs(park, here);
      const goal = nearestAccess(ride, dist);
      if (goal !== null) s.route = traceRoute(prev, here, goal);
    }
  }
  advance(park, s);
}

function finishStaffJob(park: Park, s: Staff) {
  const job = s.job ?? -1;
  if (s.role === 'janitor' && job >= 0) { park.litter[job] = 0; park.stains[job] = 0; }
  if (s.role === 'mechanic') {
    const ride = getObject(park, job);
    if (ride?.broken) {
      ride.broken = false;
      park._events.push({ type: 'info', text: `${objName(ride)} has been repaired.` });
    }
    s.task = null;
  }
  s.job = -1;
}

function updateRating(park: Park) {
  const s = parkStats(park);
  const happy = s.guests ? s.avgHappy : 60;
  const target = 120 + happy * 4 + Math.min(s.rides, 10) * 28 + Math.min(s.beauty, 120)
    - s.litter * 4 - s.broken * 60 - (s.stalls === 0 && s.guests > 10 ? 80 : 0)
    - (100 - park.safety) * 3 - s.stains * 6 - (park.locked ? CRIME.lockedRatingPenalty : 0)
    + park.buzz * 1.5;
  park.rating += (clamp(target, 0, 999) - park.rating) * 0.08;
}

function checkObjectives(park: Park) {
  const s = parkStats(park);
  for (const o of OBJECTIVES) {
    if (!park.objectives.includes(o.id) && o.test(s)) {
      park.objectives.push(o.id);
      park._events.push({ type: 'goal', text: `Goal complete: ${o.text}!` });
    }
  }
}

function endDay(park: Park, finishedDay: number) {
  maybeStartRaid(park, finishedDay + 1);
  for (const s of park.staff) spend(park, wageOf(park, s), 'wages');
  for (const o of park.objects) {
    const def = rideDef(o) || STALLS[o.kind] || SPECIAL[o.kind];
    if (def && o.open !== false) spend(park, def.upkeep, 'upkeep');
  }
  if (park.fence) spend(park, CRIME.fenceUpkeep, 'upkeep');
  const t = park.stats.today;
  park.stats.history.push({ day: finishedDay, income: Math.round(t.income), expenses: Math.round(t.expenses), guests: park.guests.length, crimes: t.crimeCount });
  if (park.stats.history.length > 30) park.stats.history.shift();
  park.stats.today = newLedger();
  if (park.cash < 0) park._events.push({ type: 'warn', text: 'Your park is in debt! Cut costs or raise prices.' });
  newDayWeather(park, finishedDay + 1);
  maybeRandomEvent(park, finishedDay + 1);
}

// ---------------------------------------------------------------------------
// Crime & security
// ---------------------------------------------------------------------------

interface Point { x: number; y: number }
const dist2 = (a: Point, b: Point): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** How well a tile is covered by security. */
function coverage(park: Park, x: number, y: number): Coverage {
  const here = { x: x + 0.5, y: y + 0.5 };
  let guard: Staff | null = null, guardD = Infinity;
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

function logIncident(park: Park, type: Incident['type'], text: string) {
  park.incidents.unshift({ type, text, day: day(park) });
  if (park.incidents.length > 30) park.incidents.length = 30;
  const hit = (CRIME.safetyHit as Record<string, number>)[type];
  if (hit) {
    park.stats.crimes++;
    park.stats.today.crimeCount++;
    park.safety = Math.max(0, park.safety - hit);
  }
}

function victimNear(park: Park, g: Guest) {
  const me = actorPos(g);
  let best: Guest | null = null, bestD = 2.25;
  for (const v of park.guests) {
    if (v === g || v.crime || v.gone || (v.state !== 'walk' && v.state !== 'queue' && v.state !== 'sit')) continue;
    const d = dist2(actorPos(v), me);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

/** Decides whether a criminal acts now, based on security nearby. */
function planCrime(park: Park, g: Guest) {
  const cov = coverage(park, g.x, g.y);
  let chance = 1;
  const deterR = cov.guard ? CRIME.guardDeterRadius + (cov.guard.traits || []).reduce((n, t) => n + (STAFF_TRAITS[t].deter || 0), 0) : 0;
  if (cov.guard && cov.guardD <= deterR) chance *= CRIME.guardDeterFactor;
  if (cov.camera) chance *= CRIME.cameraDeterFactor;
  const dusk = dayProgress(park) > 0.75;
  if (!dusk || cov.lamp) chance *= CRIME.daytimeFactor;
  if (rand(park) > chance) {
    g.crimeT = 5 + rand(park) * 8;
    if (cov.guard && cov.guardD <= deterR) think(park, g, 'Too much security around here...');
    return;
  }

  if (g.crime === 'robber') {
    // Pick the busiest reachable till to hit.
    const targets = park.objects.filter((o): o is ShopObject => hasTill(o) && o.open && o._access.length > 0 && o.stats.revenue > 0);
    if (!targets.length) { g.crimeT = 20; return; }
    targets.sort((a, b) => b.stats.revenue - a.stats.revenue);
    const t = targets[Math.floor(rand(park) * Math.min(3, targets.length))]!;
    g.heist = t.id;
    g.target = t.id;
    g.route = null;
    g.crimeT = 9999; // acts on arrival
    return;
  }

  const victim = victimNear(park, g);
  if (!victim) { g.crimeT = 3 + rand(park) * 4; return; }
  if (g.crime === 'dealer') commitDeal(park, g, victim, cov);
  else if (g.crime === 'pickpocket') commitTheft(park, g, victim, cov);
  else commitAssault(park, g, victim, cov);
}

function commitTheft(park: Park, g: Guest, v: Guest, cov: Coverage) {
  const amount = Math.min(v.cash, Math.round(5 + rand(park) * 30));
  if (amount <= 0) { g.crimeT = 4; return; }
  v.cash -= amount;
  g.loot += amount;
  g.record.theft++;
  g.record.stolen += amount;
  v.happy = Math.max(0, v.happy - 20);
  think(park, v, 'Someone stole my wallet!', true);
  logIncident(park, 'theft', `${v.name} was pickpocketed ($${amount}).`);
  afterCrime(park, g, cov, false);
}

function commitAssault(park: Park, g: Guest, v: Guest, cov: Coverage) {
  const firstAid = park.objects.some((o) => o.kind === 'firstaid' && o.open);
  const fatal = rand(park) < CRIME.homicideChance * (firstAid ? CRIME.firstAidHomicideFactor : 1);
  bleed(park, v, fatal ? 3 : 1);
  g.record[fatal ? 'homicide' : 'assault']++;
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

function commitHeist(park: Park, g: Guest, obj: ParkObject) {
  g.heist = null;
  const name = objName(obj);
  const amount = Math.round(clamp(park.stats.today.income * 0.35, 150, 3000));
  const taken = Math.min(amount, Math.max(0, Math.round(park.cash)));
  if (taken <= 0) { startLeaving(park, g); return; }
  spend(park, taken, 'crime');
  g.loot += taken;
  g.heistLoot = true;
  g.record.robbery++;
  g.record.stolen += taken;
  logIncident(park, 'heist', `Heist at ${name}: $${taken.toLocaleString()} stolen.`);
  park._events.push({ type: 'warn', text: `Heist at ${name}! $${taken.toLocaleString()} stolen.` });
  afterCrime(park, g, coverage(park, g.x, g.y), true);
}

/** Witnesses and cameras may identify the culprit; guards give chase. */
function afterCrime(park: Park, g: Guest, cov: Coverage, flee: boolean) {
  g.crimes++;
  g.crimeT = 15 + rand(park) * 20;
  const guard = cov.guard && cov.guardD <= CRIME.guardChaseRadius ? cov.guard : null;
  if (guard || (cov.camera && rand(park) < CRIME.cameraSpotChance)) g.spotted = true;
  if (guard && !guard.chase) {
    guard.chase = g.id;
    guard.route = null;
  }
  if (flee || g.crimes >= (g.crime === 'dealer' ? 8 : 3)) startLeaving(park, g);
}

function arrest(park: Park, g: Guest, by: string) {
  for (const o of park.objects) {
    if (isRideObj(o) && o.queue.includes(g.id)) o.queue.splice(o.queue.indexOf(g.id), 1);
  }
  g.gone = true;
  g.arrested = true;
  park.stats.arrests++;
  park.safety = Math.min(100, park.safety + 2);
  if (g.heistLoot && g.loot) earn(park, g.loot, 'crime');
  const what = g.crime ? CRIME_LABEL[g.crime] : 'suspect';
  const recovered = g.heistLoot && g.loot ? ` $${Math.round(g.loot).toLocaleString()} recovered.` : '';
  logIncident(park, 'arrest', `${g.name}, a ${what}, was arrested by ${by}.${recovered}`);
  park._events.push({ type: 'goal', text: `${g.name} (${what}) arrested!${recovered}` });
  takeIntoCustody(park, g, by);
  for (const s of park.staff) if (s.chase === g.id) s.chase = null;
}

/** Guard behaviour on arriving at a tile. Returns true if it handled movement. */
function guardStep(park: Park, s: Staff, here: number) {
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

/** Adds blood to a path tile (no-op when gore is off). */
function stain(park: Park, i: number, amount: number) {
  if (cfgOf(park).gore && park.tiles[i] !== TILE.GRASS) park.stains[i] = Math.min(3, park.stains[i] + amount);
}

function bleed(park: Park, v: Guest, amount: number) {
  const i = idx(v.x, v.y);
  stain(park, i, amount);
  const p = actorPos(v);
  fx(park, { type: 'blood', x: p.x, y: p.y, amount });
}

/** Transient visual effects for the renderer (not saved). */
function fx(park: Park, effect: Fx) {
  if (effect.type === 'blood' && !cfgOf(park).gore) return;
  park._fx = park._fx || [];
  if (park._fx.length < 200) park._fx.push(effect);
}

// ---------------------------------------------------------------------------
// Pandemonium heist crew
// ---------------------------------------------------------------------------

const randIn = (park: Park, [lo, hi]: readonly [number, number] | number[]): number => lo! + rand(park) * (hi! - lo!);
export const activePandas = (park: Park) => park.guests.filter((g) => g.crime === 'panda' && !g.gone);

function maybeStartRaid(park: Park, newDay: number) {
  const mode = cfgOf(park).pandemonium;
  if (mode === 'off') return;
  const pd = park.pandemonium;
  if (park.raid || newDay < pd.nextRaidDay || park.guests.length < PANDEMONIUM.minGuests) return;
  if (rand(park) >= PANDEMONIUM.raidChance * (mode === 'aggressive' ? 1.6 : 1)) return;
  startRaid(park);
}

/** Starts a raid right away. Exported for tests and debugging. */
export function startRaid(park: Park) {
  if (park.raid) return false;
  const paths = [];
  for (let i = 0; i < park.tiles.length; i++) if (park.tiles[i] === TILE.PATH) paths.push(i);
  if (paths.length < 6) return false;
  const pd = park.pandemonium;
  const size = Math.min(PANDEMONIUM.crewMax + 2, PANDEMONIUM.crewBase + pd.raids * PANDEMONIUM.crewGrowth + (cfgOf(park).pandemonium === 'aggressive' ? 2 : 0));
  pd.raids++;
  park.raid = { startedAt: park.time, size, captured: 0, escaped: 0, loot: 0 };
  const names = [...PANDEMONIUM.names];
  for (let k = 0; k < size; k++) {
    // They infiltrate everywhere: each member pops up somewhere different.
    const at = paths[Math.floor(rand(park) * paths.length)]!;
    const x = at % GRID, y = (at / GRID) | 0;
    const name = names.splice(Math.floor(rand(park) * names.length), 1)[0] || `Panda #${k + 1}`;
    const g: Guest = {
      ...newGuestStats(),
      id: park.nextId++, name, shirt: '#ffffff',
      x, y, nx: x, ny: y, lx: x, ly: y, t: 0,
      cash: 0, happy: 50, hunger: 0, thirst: 0, bladder: 0, energy: 100, nausea: 0, pref: 10, thrift: 0, timeIn: 0,
      crime: 'panda', crimeT: randIn(park, PANDEMONIUM.actEvery),
      maxHp: Math.round(randIn(park, PANDEMONIUM.hp)), acc: randIn(park, PANDEMONIUM.pandaAccuracy), cool: 0,
    };
    g.hp = g.maxHp;
    park.guests.push(g);
    park._guestById.set(g.id, g);
  }
  logIncident(park, 'raid', `Pandemonium infiltrated the park with ${size} members!`);
  park._events.push({ type: 'raid', text: `🐼 PANDEMONIUM has infiltrated the park with ${size} members! Deploy the Hot Dog Squad!` });
  return true;
}

function updatePanda(park: Park, g: Guest, dt: number) {
  g.thoughtT -= dt;
  if (g.state === 'downed') {
    g.busy -= dt;
    if (g.busy <= 0) capturePanda(park, g);
    return;
  }
  pandaFight(park, g, dt);
  if (g.state === 'busy') {
    g.busy -= dt;
    if (g.busy <= 0) g.state = 'walk';
    return;
  }
  if (!park.raid) { g.gone = true; return; }
  if (g.leaving && park.locked) { g.leaving = false; g.route = null; think(park, g, "They've locked us in!"); }
  if (!g.leaving && !park.locked && park.time - park.raid.startedAt > PANDEMONIUM.raidSeconds) {
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
      g.record.assault++;
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

function robTill(park: Park, g: Guest, obj: ParkObject) {
  const def = itemDef(obj.kind);
  const taken = Math.min(Math.round(randIn(park, PANDEMONIUM.tillLoot)), Math.max(0, Math.round(park.cash)));
  if (taken > 0) {
    spend(park, taken, 'crime');
    g.loot += taken;
    if (park.raid) park.raid.loot += taken;
    g.record.robbery++;
    g.record.stolen += taken;
  }
  const smashed = rand(park) < PANDEMONIUM.sabotageChance && 'broken' in obj;
  if (smashed) {
    obj.broken = true;
    if (isRideObj(obj)) for (const gid of obj.queue.splice(0)) releaseGuest(park, park._guestById.get(gid));
  }
  logIncident(park, 'heist', `Pandemonium hit ${objName(obj)}: $${taken.toLocaleString()} stolen${smashed ? ' and the place was smashed up' : ''}.`);
  park._events.push({ type: 'warn', text: `🐼 ${g.name} robbed ${objName(obj)}${taken ? ` of $${taken.toLocaleString()}` : ''}${smashed ? ' and smashed it' : ''}!` });
  g.state = 'busy';
  g.busy = 1.5;
}

function pandaEscapes(park: Park, g: Guest) {
  g.gone = true;
  if (!park.raid) return;
  park.raid.escaped++;
  park.pandemonium.escaped++;
  park.safety = Math.max(0, park.safety - PANDEMONIUM.escapeSafetyHit / Math.max(1, park.raid.size / 2));
  logIncident(park, 'raid', `${g.name} escaped with $${Math.round(g.loot).toLocaleString()}.`);
}

function capturePanda(park: Park, g: Guest) {
  g.gone = true;
  takeIntoCustody(park, g, 'the Hot Dog Squad');
  park.pandemonium.captured++;
  park.stats.arrests++;
  if (park.raid) park.raid.captured++;
  if (g.loot) earn(park, g.loot, 'crime');
  logIncident(park, 'arrest', `${g.name} of Pandemonium was captured${g.loot ? `. $${Math.round(g.loot).toLocaleString()} recovered` : ''}.`);
  park._events.push({ type: 'goal', text: `🌭 ${g.name} captured by the Hot Dog Squad!` });
}

function checkRaidOver(park: Park) {
  const raid = park.raid;
  if (!raid || activePandas(park).length) return;
  const pd = park.pandemonium;
  park.raid = null;
  if (raid.escaped === 0) {
    pd.defeated++;
    pd.nextRaidDay = day(park) + PANDEMONIUM.cooldownDays + 2;
    park.safety = Math.min(100, park.safety + PANDEMONIUM.defeatSafetyBonus);
    logIncident(park, 'raid', `Pandemonium was defeated! ${raid.captured} members in custody.`);
    park._events.push({ type: 'goal', text: `Pandemonium defeated! ${raid.captured} members in custody await sentencing.` });
  } else {
    pd.nextRaidDay = day(park) + PANDEMONIUM.cooldownDays;
    logIncident(park, 'raid', `Pandemonium got away with $${Math.round(raid.loot).toLocaleString()}. ${raid.captured} captured, ${raid.escaped} escaped.`);
    park._events.push({ type: 'warn', text: `Pandemonium escaped! ${raid.escaped} got away. They'll be back...` });
  }
}

function squadShoot(park: Park, s: Staff, dt: number) {
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
  const hit = rand(park) < s.acc;
  const to = actorPos(target);
  fx(park, { type: 'shot', x0: me.x, y0: me.y, x1: to.x, y1: to.y, hit });
  if (!hit) return;
  target.hp = (target.hp ?? 1) - 1;
  if (target.hp <= 0) {
    target.state = 'downed';
    target.busy = PANDEMONIUM.downedSeconds;
    target.route = null;
    target.nx = target.x; target.ny = target.y; target.t = 0;
    think(park, target, 'Bested by a hot dog...', true);
  }
}

/** Pandas throw bamboo at nearby security staff. */
function pandaFight(park: Park, g: Guest, dt: number) {
  g.cool = Math.max(0, (g.cool || 0) - dt);
  if (g.cool > 0) return;
  const me = actorPos(g);
  let target = null, best = PANDEMONIUM.throwRange ** 2;
  for (const s of park.staff) {
    if ((s.role !== 'squad' && s.role !== 'guard') || s.down > 0) continue;
    const d = dist2(actorPos(s), me);
    if (d <= best) { best = d; target = s; }
  }
  if (!target) return;
  g.cool = PANDEMONIUM.throwCooldown;
  const hit = rand(park) < (g.acc ?? 0.5);
  const to = actorPos(target);
  fx(park, { type: 'bamboo', x0: me.x, y0: me.y, x1: to.x, y1: to.y, hit });
  if (!hit) return;
  target.hp--;
  if (target.hp > 0) return;
  if (cfgOf(park).officerDeaths && rand(park) < PANDEMONIUM.killChance) {
    killOfficer(park, target, g);
    return;
  }
  target.down = PANDEMONIUM.knockoutSeconds;
  target.chase = null;
  target.route = null;
  target.busy = 0;
  target.nx = target.x; target.ny = target.y; target.t = 0;
  stain(park, idx(target.x, target.y), 1);
  fx(park, { type: 'blood', x: to.x, y: to.y, amount: 1 });
  logIncident(park, 'assault', `${target.name} was knocked out by ${g.name} of Pandemonium.`);
  park._events.push({ type: 'warn', text: `🐼 ${g.name} knocked out ${target.name}!` });
}

/** An officer dies in the line of duty: insurance, burial and a memorial. */
function killOfficer(park: Park, s: Staff, killer: Guest) {
  const pos = actorPos(s);
  stain(park, idx(s.x, s.y), 3);
  fx(park, { type: 'blood', x: pos.x, y: pos.y, amount: 3 });
  park.staff.splice(park.staff.indexOf(s), 1);
  const payout = (PANDEMONIUM.lifeInsurance as Partial<Record<StaffRole, number>>)[s.role] || 0;
  if (payout) spend(park, payout, 'insurance');
  park.fallen.push({ name: s.name, role: s.role, by: killer.name, day: day(park), payout });
  const memorial = buryFallen(park);
  logIncident(park, 'homicide', `${s.name} was killed in the line of duty by ${killer.name} of Pandemonium.`);
  park._events.push({ type: 'warn', text: `🪦 ${s.name} was killed by ${killer.name}. $${payout.toLocaleString()} life insurance paid to the family.` });
  park._events.push({ type: 'info', text: memorial
    ? `${s.name} has been laid to rest at the Fallen Officers Memorial.`
    : `${s.name} has been laid to rest. Clear a 2×2 space for a memorial.` });
  for (const g of park.guests) {
    if (!g.crime && dist2(actorPos(g), pos) <= 16) think(park, g, 'They killed an officer... this park is a war zone.');
  }
}

/** Adds a grave to the memorial, creating it on free ground near the entrance. */
function buryFallen(park: Park) {
  let m = park.objects.find((o) => o.kind === 'memorial');
  if (!m) {
    const spot = memorialSpot(park);
    if (!spot) return null;
    for (const o of spot.clear) removeObject(park, o);
    m = addObject(park, 'memorial', spot.x, spot.y, 0);
    m.graves = 0;
  }
  m.graves = park.fallen.length;
  park.safety = Math.min(100, park.safety + PANDEMONIUM.memorialSafetyBonus);
  return m;
}

function memorialSpot(park: Park) {
  const free = (x: number, y: number, clear: ParkObject[]): boolean => {
    for (let yy = y; yy < y + 2; yy++) {
      for (let xx = x; xx < x + 2; xx++) {
        if (!inBounds(xx, yy)) return false;
        const i = idx(xx, yy);
        if (park.tiles[i] !== TILE.GRASS) return false;
        const o = park._byId.get(park._objAt[i]);
        if (!o) continue;
        if (!['tree', 'pine', 'flowers'].includes(o.kind)) return false; // only clear plants
        if (!clear.includes(o)) clear.push(o);
      }
    }
    return true;
  };
  let best: { x: number; y: number; clear: ParkObject[]; score: number } | null = null;
  for (let y = 0; y < GRID - 1; y++) {
    for (let x = 0; x < GRID - 1; x++) {
      if (Math.abs(x + 0.5 - ENTRANCE.x) < 3 && y + 2 >= ENTRANCE.y - 1) continue; // keep the gate clear
      const clear: ParkObject[] = [];
      if (!free(x, y, clear)) continue;
      // Prefer a spot beside a path, close to the entrance, needing little clearing.
      let pathNear = false;
      for (let yy = y - 1; yy <= y + 2 && !pathNear; yy++) {
        for (let xx = x - 1; xx <= x + 2; xx++) if (inBounds(xx, yy) && park.tiles[idx(xx, yy)] === TILE.PATH) { pathNear = true; break; }
      }
      const score = Math.hypot(x + 1 - ENTRANCE.x, y + 1 - ENTRANCE.y) + clear.length * 2 + (pathNear ? 0 : 15);
      if (!best || score < best.score) best = { x, y, clear, score };
    }
  }
  return best;
}

/** Squad officers hunt the nearest panda during a raid. */
function squadStep(park: Park, s: Staff, here: number) {
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
export function execute(park: Park, id: number, mode: string) {
  const rig = getObject(park, id);
  if (!rig || rig.kind !== 'retribution') return { ok: false, reason: 'That is not a Retribution Rig.' };
  if (!cfgOf(park).executions) return { ok: false, reason: 'Executions are turned off in this park\'s rules.' };
  if (rig.show) return { ok: false, reason: 'A show is already underway.' };
  if (!park.captives.length) return { ok: false, reason: 'Nobody is on death row.' };
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
  park._events.push({ type: 'raid', text: `⚖️ Public execution at the Retribution Rig! ${victims.length > 1 ? `${victims.length} prisoners` : victims[0]} to be ${how}.` });
  return { ok: true };
}

export function setRigMode(park: Park, id: number, mode: string) {
  const rig = getObject(park, id);
  if (rig?.kind === 'retribution' && !rig.show) rig.pit = mode === 'water' ? 'water' : 'fire';
}

function watchShow(park: Park, g: Guest, rig: ParkObject) {
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

function updateShow(park: Park, rig: ParkObject, dt: number) {
  const show = rig.show;
  if (!show) return;
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
  if (park.captives.length) execute(park, rig.id, rig.pit ?? 'fire'); // more on death row: next show
}

// ---------------------------------------------------------------------------
// Drugs & gangs
// ---------------------------------------------------------------------------

export const CRIME_LABEL: Record<CrimeKind, string> = {
  pickpocket: 'pickpocket', brawler: 'violent offender', robber: 'robber', dealer: 'drug dealer', panda: 'Pandemonium raider',
};

function getHigh(park: Park, v: Guest) {
  v.high = randIn(park, CRIME.highSeconds);
  v.happy = Math.min(100, v.happy + 10);
  park.stats.drugDeals++;
  think(park, v, 'Whoa... everything is so colorful.', true);
}

function commitDeal(park: Park, g: Guest, v: Guest, cov: Coverage) {
  if (!cfgOf(park).drugs) { g.crimeT = 30; return; }
  if (v.high > 0 || v.cash < CRIME.dealPrice[0]) { g.crimeT = 4; return; }
  const accept = CRIME.dealAcceptBase + (100 - v.happy) / 200;
  if (rand(park) >= accept) {
    v.happy = Math.max(0, v.happy - 3);
    think(park, v, 'Some shady character just tried to sell me drugs.');
    g.crimeT = 6 + rand(park) * 6;
    return;
  }
  const price = Math.min(v.cash, Math.round(randIn(park, CRIME.dealPrice)));
  v.cash -= price;
  g.loot += price;
  g.record.drugs++;
  getHigh(park, v);
  logIncident(park, 'drugs', `${g.name}${g.gang ? ` (${g.gang})` : ''} sold drugs to ${v.name}.`);
  afterCrime(park, g, cov, false);
}

function vendorDeal(park: Park, g: Guest, obj: ParkObject) {
  const def = STALLS[obj.kind];
  const accept = CRIME.dealAcceptBase + (100 - g.happy) / 200;
  if (rand(park) >= accept) { think(park, g, `The ${def.name} vendor offered me something... not on the menu.`); return; }
  const price = Math.min(g.cash, Math.round(randIn(park, CRIME.dealPrice)));
  g.cash -= price;
  obj.deals = (obj.deals ?? 0) + 1;
  getHigh(park, g);
  logIncident(park, 'drugs', `Drugs were sold under the counter at ${def.name}.`);
  const cov = coverage(park, obj.x, obj.y);
  const watched = (cov.guard && cov.guardD <= CRIME.guardChaseRadius) || cov.camera;
  if (!obj.exposed && watched && rand(park) < CRIME.corruptExposeChance) {
    obj.exposed = true;
    park._events.push({ type: 'warn', text: `💊 Security caught the ${def.name} vendor dealing drugs! Replace the vendor.` });
  }
}

/** Replaces a stall's vendor, ending any under-the-counter dealing. */
export function replaceVendor(park: Park, id: number) {
  const obj = getObject(park, id);
  if (!obj || !('corrupt' in obj)) return { ok: false, reason: 'No vendor to replace.' };
  spend(park, CRIME.replaceVendorCost, 'wages');
  const was = obj.corrupt;
  Object.assign(obj, { corrupt: false, exposed: false });
  return { ok: true, wasCorrupt: was };
}

function comeDown(park: Park, g: Guest) {
  g.high = 0;
  if (g.crime || rand(park) >= CRIME.gangRecruitChance) {
    think(park, g, 'Ugh. What happened? Where am I?');
    return;
  }
  g.crime = pick(park, ['pickpocket', 'brawler', 'dealer']);
  g.gang = pick(park, CRIME.gangs);
  g.crimeT = 10 + rand(park) * 15;
  g.leaving = false;
  park.stats.gangRecruits++;
  think(park, g, `I run with ${g.gang} now.`);
  logIncident(park, 'gang', `${g.name} joined ${g.gang}.`);
}

// ---------------------------------------------------------------------------
// Custody & sentencing
// ---------------------------------------------------------------------------

export const knownSuspects = (park: Park) => park.guests.filter((g) => g.crime && !g.gone && (g.spotted || g.crime === 'panda'));

function takeIntoCustody(park: Park, g: Guest, by: string) {
  park.custody.push({
    id: g.id, name: g.name, kind: g.crime ?? 'pickpocket', gang: g.gang, record: { ...g.record }, by, day: day(park),
  });
  park._events.push({ type: 'custody', text: `${g.name} is in custody awaiting your decision.` });
}

export function fineFor(c: CustodyCase): number {
  if (c.kind === 'panda') return CRIME.pandaFine;
  return Math.round(CRIME.fineBase + offences(c.record) * CRIME.finePerOffence + c.record.stolen * CRIME.fineStolenMultiplier);
}

/**
 * Decides the fate of someone in custody.
 * verdict: 'release' | 'fine' | 'execute' (mode: 'fire' | 'water').
 */
export function sentence(park: Park, id: number, verdict: 'release' | 'fine' | 'execute', mode = 'fire') {
  const i = park.custody.findIndex((c) => c.id === id);
  if (i < 0) return { ok: false, reason: 'Nobody by that ID is in custody.' };
  const c = park.custody[i];
  const rig = park.objects.find((o) => o.kind === 'retribution');
  if (verdict === 'execute' && !cfgOf(park).executions) return { ok: false, reason: 'Executions are turned off in this park\'s rules.' };
  if (verdict === 'execute' && !rig) return { ok: false, reason: 'Build a Retribution Rig first.' };
  park.custody.splice(i, 1);
  if (verdict === 'release') {
    park.safety = Math.max(0, park.safety - CRIME.releaseSafetyHit);
    logIncident(park, 'sentence', `${c.name} was released without charge.`);
    return { ok: true };
  }
  if (verdict === 'fine') {
    const fine = fineFor(c);
    earn(park, fine, 'fines');
    logIncident(park, 'sentence', `${c.name} was fined $${fine.toLocaleString()} and banned from the park.`);
    return { ok: true, fine };
  }
  park.captives.push({ name: c.name });
  if (rig && !rig.show) {
    const res = execute(park, rig.id, mode);
    if (!res.ok) return { ok: true, queued: true, reason: res.reason };
    return { ok: true };
  }
  return { ok: true, queued: true };
}

// ---------------------------------------------------------------------------
// Barbed wire perimeter
// ---------------------------------------------------------------------------

export function installFence(park: Park) {
  if (park.fence) return { ok: false, reason: 'The fence is already installed.' };
  if (park.cash < CRIME.fenceCost) return { ok: false, reason: 'Not enough cash', cash: true };
  spend(park, CRIME.fenceCost, 'construction');
  park.fence = true;
  park._events.push({ type: 'info', text: 'Barbed wire fencing installed around the park. You can now lock the exits.' });
  return { ok: true };
}

export function setLocked(park: Park, locked: boolean) {
  if (!park.fence) return { ok: false, reason: 'Install barbed wire fencing first.' };
  park.locked = !!locked;
  for (const a of [...park.guests, ...park.staff]) a.route = null;
  park._events.push(park.locked
    ? { type: 'raid', text: '🔒 LOCKDOWN: the exits are sealed. Nobody gets in or out.' }
    : { type: 'info', text: '🔓 Lockdown lifted. The gates are open.' });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Custom coasters
// ---------------------------------------------------------------------------

/** Custom coasters have a track. */
export const isCoaster = (o: ParkObject | null | undefined): o is CoasterObject => !!o && o.kind === 'custom' && !!o.track;

/** Looks up a custom coaster by id. */
const getCoaster = (park: Park, id: number): CoasterObject | null => {
  const o = getObject(park, id);
  return isCoaster(o) ? o : null;
};

/** Recomputes a custom coaster's layout, footprint, and (if open) physics. */
function refreshCoaster(obj: CoasterObject) {
  const start = coasterStart(obj);
  const lay = Coaster.layout(start, obj.track.pieces);
  const seen = new Set<number>();
  const cells: [number, number][] = [];
  const stationCells: [number, number][] = [];
  for (const seg of lay.segs) {
    for (const c of seg.cells) {
      if (seg.type === 'station') stationCells.push([c.x, c.y]);
      const k = c.y * GRID + c.x;
      if (!seen.has(k)) { seen.add(k); cells.push([c.x, c.y]); }
    }
  }
  obj._cells = cells;
  obj._stationCells = stationCells;
  obj._layout = lay;
  obj._version = (obj._version || 0) + 1;
  obj._design = Coaster.isComplete(start, obj.track.pieces) ? Coaster.simulate(start, obj.track.pieces) : null;
  obj._def = defFromDesign(obj);
  if (obj._design && !obj._design.ok && !obj.building) { obj.building = true; obj.open = false; }
}

function defFromDesign(obj: CoasterObject): RideDef {
  const d = obj._design?.ok ? obj._design : null;
  const n = obj.track.pieces.length;
  return {
    ...CUSTOM_COASTER,
    name: obj.name,
    capacity: 4 * (obj.cars || 4),
    duration: d ? d.duration + 2 : CUSTOM_COASTER.duration,
    excitement: d ? d.excitement : 0,
    intensity: d ? d.intensity : 0,
    nausea: d ? d.nausea : 0,
    upkeep: Math.round(30 + n * 1.2),
    reliability: Math.max(0.9, 0.985 - n * 0.0002),
  };
}

export const coasterStart = (obj: CoasterObject) => ({ x: obj.x, y: obj.y, dir: obj.track.dir });
export const coasterComplete = (obj: CoasterObject): boolean => Coaster.isComplete(coasterStart(obj), obj.track.pieces);

/** Places a new coaster's station and opens it for building. */
export function startCoaster(park: Park, x: number, y: number, dir: number): Result<{ obj: CoasterObject }> {
  if (!inBounds(x, y)) return { ok: false, reason: 'Out of bounds' };
  const i = idx(x, y);
  if (park.tiles[i] !== TILE.GRASS || park._objAt[i]) return { ok: false, reason: 'Something is in the way' };
  const cost = Coaster.PIECES.station.cost;
  if (park.cash < cost) return { ok: false, reason: 'Not enough cash', cash: true };
  spend(park, cost, 'construction');
  const n = park.objects.filter((o) => o.kind === 'custom').length + 1;
  const obj = makeObject('custom', park.nextId++, x, y, cost, {
    track: { dir: ((dir % 4) + 4) % 4, pieces: ['station'] }, building: true, open: false, name: `Coaster ${n}`, price: 0,
    cars: 4, builtDay: day(park),
  }) as CoasterObject;
  park.objects.push(obj);
  park._byId.set(obj.id, obj);
  refreshCoaster(obj);
  park._objAt[i] = obj.id;
  refreshAccess(park);
  return { ok: true, obj };
}

const loopRise = (type: PieceType) => (Coaster.PIECES[type].loop ? (Coaster.PHYSICS.loopRadius * 2) / Coaster.STEP : 0);

/** Checks whether a piece can be added to the end of a coaster under construction. */
export function canAddPiece(park: Park, obj: CoasterObject | null, type: string): Result {
  if (!isKey(Coaster.PIECES, type)) return { ok: false, reason: 'Unknown piece' };
  const def = Coaster.PIECES[type];
  if (!obj?.building) return { ok: false, reason: 'Close the coaster and choose Edit to change it.' };
  if (coasterComplete(obj)) return { ok: false, reason: 'The circuit is complete.' };
  if (obj.track.pieces.length >= 400) return { ok: false, reason: 'Track is too long.' };
  const start = coasterStart(obj);
  const lay = Coaster.layout(start, [...obj.track.pieces, type]);
  const seg = lay.segs[lay.segs.length - 1]!;
  if (seg.h1 < 0) return { ok: false, reason: "Track can't go underground." };
  const top = Math.max(seg.h0, seg.h1) + loopRise(type);
  if (top > Coaster.MAX_STEPS) return { ok: false, reason: 'Too high.' };
  const lo = Math.min(seg.h0, seg.h1);
  for (const c of seg.cells) {
    if (!inBounds(c.x, c.y)) return { ok: false, reason: 'Out of bounds' };
    const i = idx(c.x, c.y);
    if (park.tiles[i] !== TILE.GRASS) return { ok: false, reason: 'Blocked by a path' };
    const owner = park._objAt[i];
    if (owner && owner !== obj.id) return { ok: false, reason: 'Something is in the way' };
    if (owner === obj.id) {
      // Crossing our own track needs vertical clearance.
      for (const other of lay.segs.slice(0, -1)) {
        if (!other.cells.some((oc) => oc.x === c.x && oc.y === c.y)) continue;
        const oLo = Math.min(other.h0, other.h1);
        const oHi = Math.max(other.h0, other.h1) + loopRise(other.type);
        if (!(lo >= oHi + Coaster.CROSS_CLEARANCE || top + Coaster.CROSS_CLEARANCE <= oLo)) {
          return { ok: false, reason: 'Track would collide with itself' };
        }
      }
    }
  }
  if (park.cash < def.cost) return { ok: false, reason: 'Not enough cash', cash: true };
  return { ok: true };
}

function reindexCoaster(park: Park, obj: CoasterObject) {
  for (const [x, y] of obj._cells || []) if (park._objAt[idx(x, y)] === obj.id) park._objAt[idx(x, y)] = 0;
  refreshCoaster(obj);
  for (const [x, y] of obj._cells || []) park._objAt[idx(x, y)] = obj.id;
  refreshAccess(park);
}

export function addPiece(park: Park, id: number, type: string): Result<{ complete: boolean }> {
  const obj = getCoaster(park, id);
  const check = canAddPiece(park, obj, type);
  if (!check.ok) return check;
  const piece = type as PieceType; // validated by canAddPiece
  const cost = Coaster.PIECES[piece].cost;
  spend(park, cost, 'construction');
  obj!.paid += cost;
  obj!.track.pieces.push(piece);
  reindexCoaster(park, obj!);
  return { ok: true, complete: coasterComplete(obj!) };
}

/** Removes the last piece (full refund while building). Removing the station demolishes the coaster. */
export function removePiece(park: Park, id: number): Result<{ removed?: boolean }> {
  const obj = getCoaster(park, id);
  if (!obj?.building) return { ok: false, reason: 'Close the coaster and choose Edit first.' };
  if (obj.track.pieces.length <= 1) {
    const paid = obj.paid;
    obj.paid = 0;
    removeObject(park, obj);
    earn(park, paid, 'construction');
    return { ok: true, removed: true };
  }
  const type = obj.track.pieces.pop()!;
  const cost = Coaster.PIECES[type].cost;
  obj.paid -= cost;
  earn(park, cost, 'construction');
  reindexCoaster(park, obj);
  return { ok: true };
}

/** Runs the physics test. Returns the stats or the reason it failed. */
export function testCoaster(park: Park, id: number): CoasterDesign {
  const obj = getCoaster(park, id);
  if (!obj) return { ok: false, reason: 'Not a custom coaster.' };
  if (!coasterComplete(obj)) {
    const c = obj._layout!.cursor;
    return { ok: false, reason: `The track must return to the station. It ends ${describeGap(obj, c)}.` };
  }
  refreshCoaster(obj);
  return obj._design!;
}

function describeGap(obj: CoasterObject, c: Cursor): string {
  const parts: string[] = [];
  const dx = obj.x - c.x, dy = obj.y - c.y;
  if (dx) parts.push(`${Math.abs(dx)} tile${Math.abs(dx) > 1 ? 's' : ''} ${dx > 0 ? 'west' : 'east'}`);
  if (dy) parts.push(`${Math.abs(dy)} tile${Math.abs(dy) > 1 ? 's' : ''} ${dy > 0 ? 'north' : 'south'}`);
  if (c.h) parts.push(`${c.h} m up`);
  if (c.dir !== obj.track.dir) parts.push('facing the wrong way');
  return parts.length ? parts.join(', ') + ' of the station' : 'at the station';
}

export function openCoaster(park: Park, id: number): CoasterDesign {
  const obj = getCoaster(park, id);
  const res = testCoaster(park, id);
  if (!res.ok || !obj) return res;
  obj.building = false;
  obj.open = true;
  obj._def = defFromDesign(obj);
  if (!obj.price) obj.price = Math.max(1, Math.round(1 + res.excitement * 0.9));
  park._events.push({ type: 'goal', text: `${obj.name} is open! Top speed ${res.maxSpeed} km/h.` });
  return res;
}

export function editCoaster(park: Park, id: number): Result {
  const obj = getCoaster(park, id);
  if (!obj) return { ok: false, reason: 'Not a custom coaster.' };
  if (obj.phase === 'running') return { ok: false, reason: 'Wait for the train to return to the station.' };
  setOpen(park, id, false);
  obj.building = true;
  return { ok: true };
}

export function renameRide(park: Park, id: number, name: string) {
  const obj = getCoaster(park, id);
  if (!obj) return;
  obj.name = String(name).trim().slice(0, 40) || obj.name;
  obj._def = defFromDesign(obj);
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

function rollWeatherType(park: Park) {
  return weighted(CLIMATES[cfgOf(park).climate].weather, rand(park));
}

function newDayWeather(park: Park, newDay: number) {
  if (!cfgOf(park).weather) return;
  const before = park.weather.type;
  // Weather tends to persist from one day to the next.
  const type = rand(park) < 0.35 ? before : rollWeatherType(park);
  park.weather = { type, day: newDay };
  if (type !== before) {
    const W = WEATHER[type];
    park._events.push({ type: 'weather', text: `${W.icon} ${W.label} today.` });
  }
}

/** Occasional mid-day changes, and lightning strikes in storms. */
function maybeChangeWeather(park: Park) {
  if (!cfgOf(park).weather) return;
  if (rand(park) < 0.002) newDayWeather(park, day(park));
  const W = weatherOf(park);
  if (W.lightning && rand(park) < 0.02) {
    const tall = park.objects.filter((o) => rideDef(o)?.coaster || o.kind === 'skywheel' || o.kind === 'droptower' || o.kind === 'chairswing');
    if (tall.length && rand(park) < 0.3) {
      const hit = pick(park, tall);
      if (!hit.broken) {
        hit.broken = true;
        park._events.push({ type: 'warn', text: `⚡ Lightning struck ${objName(hit)}! It needs repairs.` });
      }
    }
    fx(park, { type: 'lightning' });
  }
}

// ---------------------------------------------------------------------------
// Random events
// ---------------------------------------------------------------------------

const SPONSORS = ['Fizzwhizz Cola', 'MegaMart', 'Zoomy Telecom', 'Crunch Co.', 'Gigglebank', 'Spinwell Tyres'];

function logEvent(park: Park, ev: EventDef, text: string, type: SimEvent['type'] = 'event') {
  park.eventLog.unshift({ id: ev.id, text: `${ev.icon} ${text}`, day: day(park) });
  if (park.eventLog.length > 20) park.eventLog.length = 20;
  park._events.push({ type, text: `${ev.icon} ${text}` });
}

function eventEligible(park: Park, ev: EventDef) {
  const cfg = cfgOf(park);
  if (ev.crime && cfg.crimeRate <= 0) return false;
  if (ev.needsFallen && !park.fallen.length) return false;
  if (ev.needsExecutions && (!park.pandemonium.executions || !cfg.executions)) return false;
  if (ev.needsWeather && park.weather.type !== ev.needsWeather) return false;
  return true;
}

function maybeRandomEvent(park: Park, newDay: number) {
  const cfg = cfgOf(park);
  if (!cfg.events || newDay < 2) return;
  if (rand(park) >= Math.min(0.95, 0.55 * cfg.eventRate)) return;
  const pool = Object.fromEntries(EVENTS.filter((e) => eventEligible(park, e)).map((e) => [e.id, e.weight]));
  if (!Object.keys(pool).length) return;
  triggerEvent(park, weighted(pool, rand(park)));
}

/**
 * Adds guests immediately (ignoring the arrival rate and park cap), spread over
 * random path tiles. Used by the stress test and benchmarks.
 */
export function addGuests(park: Park, n: number): number {
  const paths: number[] = [];
  for (let i = 0; i < park.tiles.length; i++) if (park.tiles[i] === TILE.PATH) paths.push(i);
  let added = 0;
  for (let k = 0; k < n; k++) {
    const g = spawnGuest(park, { cash: 60 + Math.floor(rand(park) * 120) });
    if (!g) continue;
    added++;
    if (!paths.length) continue;
    const at = pick(park, paths);
    g.x = g.nx = g.lx = at % GRID;
    g.y = g.ny = g.ly = (at / GRID) | 0;
    g.t = 0;
  }
  return added;
}

/** Runs a random event by id. Exported for tests and debugging. */
export function triggerEvent(park: Park, id: string) {
  const ev = EVENTS.find((e) => e.id === id);
  if (!ev) return false;
  const s = parkStats(park);
  switch (id) {
    case 'tourBus': {
      const n = 10 + Math.floor(rand(park) * 16);
      let arrived = 0;
      for (let k = 0; k < n; k++) if (spawnGuest(park, { type: 'tourist', honest: true })) arrived++;
      logEvent(park, ev, `A tour bus dropped off ${arrived} tourists.`, 'goal');
      break;
    }
    case 'sponsor': {
      const amount = Math.round((2000 + rand(park) * 4000) / 100) * 100;
      earn(park, amount, 'events');
      logEvent(park, ev, `${pick(park, SPONSORS)} sponsored the park for $${amount.toLocaleString()}.`, 'goal');
      break;
    }
    case 'vip': {
      if (park.rating >= 600) {
        earn(park, 1500, 'events');
        park.buzz = clamp(park.buzz + 15, -100, 100);
        logEvent(park, ev, 'A VIP loved their visit and left a $1,500 tip. Word is spreading.', 'goal');
      } else {
        park.buzz = clamp(park.buzz - 10, -100, 100);
        logEvent(park, ev, 'A VIP left unimpressed. Raise your rating above 600 to win them over.', 'warn');
      }
      break;
    }
    case 'inspector': {
      const dirt = s.litter + s.stains;
      if (dirt > 10) {
        const fine = Math.min(3000, dirt * 50);
        spend(park, fine, 'events');
        park.buzz = clamp(park.buzz - 5, -100, 100);
        logEvent(park, ev, `The health inspector fined you $${fine.toLocaleString()} for ${dirt} patches of litter and blood. Hire janitors!`, 'warn');
      } else {
        park.buzz = clamp(park.buzz + 8, -100, 100);
        logEvent(park, ev, 'The health inspector awarded a cleanliness certificate.', 'goal');
      }
      break;
    }
    case 'powerOutage': {
      park.effects.push({ id: 'outage', until: park.time + 20 });
      logEvent(park, ev, 'Power outage! Rides can\'t load new riders for 20 seconds.', 'warn');
      break;
    }
    case 'viral': {
      const bad = park.safety < 50 || s.stains > 5;
      park.buzz = clamp(park.buzz + (bad ? -25 : 25), -100, 100);
      logEvent(park, ev, bad ? 'A video of violence in your park went viral. Visitor interest dropped.' : 'A guest\'s ride video went viral! More visitors are on the way.', bad ? 'warn' : 'goal');
      break;
    }
    case 'lottery': {
      const g = spawnGuest(park, { type: 'tourist', cash: 500, honest: true });
      if (g) { g.name = `Lucky ${g.name}`; logEvent(park, ev, `${g.name} just won the lottery and arrived with $500 to spend.`); }
      break;
    }
    case 'celebrity': {
      for (const g of park.guests) if (!g.crime) g.happy = Math.min(100, g.happy + 10);
      park.buzz = clamp(park.buzz + 10, -100, 100);
      logEvent(park, ev, 'A celebrity was spotted in the park! Guests are thrilled.', 'goal');
      break;
    }
    case 'pickpocketRing': {
      const gang = pick(park, CRIME.gangs);
      for (let k = 0; k < 3; k++) spawnGuest(park, { crime: 'pickpocket', gang });
      logEvent(park, ev, `Rumour has it ${gang} sent a pickpocket ring to your park.`, 'warn');
      break;
    }
    case 'donation': {
      const amount = Math.min(3000, 500 * park.fallen.length);
      earn(park, amount, 'events');
      logEvent(park, ev, `Visitors left $${amount.toLocaleString()} in donations at the Fallen Officers Memorial.`, 'goal');
      break;
    }
    case 'protest': {
      park.effects.push({ id: 'protest', until: park.time + DAY_SECONDS });
      park.buzz = clamp(park.buzz - 10, -100, 100);
      logEvent(park, ev, 'Protesters against public executions are blocking the gate. Arrivals are halved today.', 'warn');
      break;
    }
    case 'heatAdvisory': {
      for (const g of park.guests) g.thirst = Math.min(100, g.thirst + 25);
      logEvent(park, ev, 'Heat advisory! Guests are desperate for drinks and ice cream.');
      break;
    }
    default:
      return false;
  }
  return true;
}

function influencerReview(park: Park, g: Guest) {
  const delta = Math.round((g.happy - 50) / 4);
  if (Math.abs(delta) < 3) return;
  park.buzz = clamp(park.buzz + delta, -100, 100);
  park._events.push(delta > 0
    ? { type: 'goal', text: `🤳 Influencer ${g.name} posted a glowing review of your park.` }
    : { type: 'warn', text: `🤳 Influencer ${g.name} trashed your park online.` });
}

// ---------------------------------------------------------------------------
// Ride ageing
// ---------------------------------------------------------------------------

/** Extra breakdown chance from age (0 when ageing is off). */
export function ageLoss(park: Park, obj: ParkObject) {
  if (!cfgOf(park).ageing || !rideDef(obj)) return 0;
  return Math.min(AGEING.maxLoss, Math.max(0, day(park) - (obj.builtDay || 1)) * AGEING.perDay);
}

export const refurbishCost = (obj: ParkObject) => Math.round(obj.paid * AGEING.refurbishShare);

export function refurbish(park: Park, id: number) {
  const obj = getObject(park, id);
  if (!obj || !rideDef(obj)) return { ok: false, reason: 'Only rides can be refurbished.' };
  const cost = refurbishCost(obj);
  if (park.cash < cost) return { ok: false, reason: 'Not enough cash', cash: true };
  spend(park, cost, 'upkeep');
  obj.builtDay = day(park);
  obj.broken = false;
  return { ok: true, cost };
}

// ---------------------------------------------------------------------------
// Customization
// ---------------------------------------------------------------------------

/** Changes a live setting mid-game. Settings marked live:false are fixed at creation. */
export function setSetting(park: Park, key: string, value: unknown): Result<{ value: unknown }> {
  const def = settingDef(key);
  if (!def || !def.live) return { ok: false, reason: 'That setting can only be chosen when creating a park.' };
  park.settings = sanitizeSettings({ ...park.settings, [key]: value });
  if (key === 'executions' && !park.settings.executions) park.captives.length = 0;
  return { ok: true, value: park.settings[def.key] };
}

export function renameObject(park: Park, id: number, name: string) {
  const obj = getObject(park, id);
  if (!obj) return;
  if (obj.kind === 'custom') return renameRide(park, id, name);
  const clean = String(name).trim().slice(0, 40);
  if (clean) obj.name = clean; else delete obj.name;
  if (RIDES[obj.kind]) obj._def = obj.name ? { ...RIDES[obj.kind], name: obj.name } : undefined;
}

export function renameStaff(park: Park, id: number, name: string) {
  const s = park.staff.find((m) => m.id === id);
  const clean = String(name).trim().slice(0, 40);
  if (s && clean) s.name = clean;
}

/** Paints an object. field: 'color' (any ride/shop/coaster) or 'trainColor' (custom coasters). */
export function setColor(park: Park, id: number, field: string, color: string | null): Result {
  const obj = getObject(park, id);
  if (!obj || (field !== 'color' && field !== 'trainColor')) return { ok: false, reason: 'Nothing to paint.' };
  if (color === null) { delete obj[field]; return { ok: true }; }
  if (!isHexColor(color)) return { ok: false, reason: 'Colours are #rrggbb' };
  obj[field] = color.toLowerCase();
  return { ok: true };
}

export function setCoasterCars(park: Park, id: number, cars: number) {
  const obj = getCoaster(park, id);
  if (!obj) return;
  obj.cars = clamp(Math.round(cars), 2, 7);
  obj._def = defFromDesign(obj);
}

export function setUniform(park: Park, role: StaffRole, color: string | null) {
  if (!STAFF[role]) return;
  if (color === null) delete park.uniforms[role];
  else if (isHexColor(color)) park.uniforms[role] = color.toLowerCase();
}

// ---------------------------------------------------------------------------
// Coaster design codes (share/import)
// ---------------------------------------------------------------------------

const toBase64 = (str: string): string => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const fromBase64 = (b64: string): string => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

/** A shareable text code for a custom coaster's design. */
/** The JSON inside a design code. */
export interface DesignCode {
  v: 1;
  name: string;
  pieces: PieceType[];
  cars: number;
  color?: string;
  trainColor?: string;
}

export function exportDesign(obj: CoasterObject): string {
  const design: DesignCode = { v: 1, name: obj.name, pieces: obj.track.pieces, cars: obj.cars || 4 };
  if (obj.color) design.color = obj.color;
  if (obj.trainColor) design.trainColor = obj.trainColor;
  return DESIGN_CODE_PREFIX + toBase64(JSON.stringify(design));
}

/** Parses and validates a design code. */
export function parseDesign(code: string): Result<{ design: Omit<DesignCode, 'v'> & { cost: number } }> {
  try {
    const text = String(code).trim();
    if (!text.startsWith(DESIGN_CODE_PREFIX)) return { ok: false, reason: 'Not a Rollercoaster Mogul design code.' };
    const d = JSON.parse(fromBase64(text.slice(DESIGN_CODE_PREFIX.length)));
    if (!d || d.v !== 1 || !Array.isArray(d.pieces) || d.pieces.length < 2 || d.pieces.length > 400) return { ok: false, reason: 'Unsupported or damaged design.' };
    if (d.pieces[0] !== 'station' || d.pieces.some((p: unknown) => !isKey(Coaster.PIECES, p))) return { ok: false, reason: 'The design contains unknown track.' };
    return {
      ok: true,
      design: {
        name: String(d.name ?? 'Imported Coaster').slice(0, 40) || 'Imported Coaster',
        pieces: d.pieces,
        cars: Number.isInteger(d.cars) ? clamp(d.cars, 2, 7) : 4,
        color: isHexColor(d.color) ? d.color : undefined,
        trainColor: isHexColor(d.trainColor) ? d.trainColor : undefined,
        cost: Coaster.designCost(d.pieces),
      },
    };
  } catch {
    return { ok: false, reason: 'That code could not be read.' };
  }
}

/** Builds a coaster from a design code with its station at (x, y) facing dir. Rolls back if blocked. */
export function importDesign(park: Park, x: number, y: number, dir: number, code: string): Result<{ obj: CoasterObject }> {
  const parsed = parseDesign(code);
  if (!parsed.ok) return parsed;
  const { design } = parsed;
  if (park.cash < design.cost) return { ok: false, reason: `This design costs $${design.cost.toLocaleString()}.`, cash: true };
  const start = startCoaster(park, x, y, dir);
  if (!start.ok) return start;
  const obj = start.obj;
  for (let i = 1; i < design.pieces.length; i++) {
    const res = addPiece(park, obj.id, design.pieces[i]!);
    if (!res.ok) {
      while (getObject(park, obj.id)) removePiece(park, obj.id);
      return { ok: false, reason: `Piece ${i + 1} (${Coaster.PIECES[design.pieces[i]!].name}) doesn't fit here: ${res.reason}` };
    }
  }
  obj.name = design.name;
  obj.cars = design.cars;
  if (design.color) obj.color = design.color;
  if (design.trainColor) obj.trainColor = design.trainColor;
  obj._def = defFromDesign(obj);
  return { ok: true, obj };
}

/** Removes and returns pending UI notifications produced by the sim. */
export function drainEvents(park: Park) {
  return park._events.splice(0);
}
