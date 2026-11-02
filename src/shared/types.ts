// Domain types for the simulation and the save format.
//
// These interfaces ARE the save format: `serialize(park)` writes a Park
// (minus fields starting with `_`), and `deserialize()` validates untrusted
// JSON back into one. See docs/PERSISTENCE.md for field-by-field notes.

// ---------------------------------------------------------------------------
// Catalogue definitions (catalog.ts)
// ---------------------------------------------------------------------------

interface BaseDef {
  name: string;
  w: number;
  h: number;
  cost: number;
  color?: string;
}

export interface RideDef extends BaseDef {
  capacity: number;
  /** Seconds per ride cycle. */
  duration: number;
  excitement: number;
  intensity: number;
  nausea: number;
  price: number;
  /** $ per day. */
  upkeep: number;
  /** Chance a cycle ends without breaking down. */
  reliability: number;
  color: string;
  coaster?: boolean;
  loop?: boolean;
  custom?: boolean;
}

export type Sells = 'food' | 'drink' | 'restroom' | 'firstaid' | 'souvenir' | 'umbrella' | 'atm' | 'info';

export interface StallDef extends BaseDef {
  sells: Sells;
  price: number;
  /** What each sale costs the park. */
  unitCost: number;
  upkeep: number;
  icon: string;
  color: string;
  /** Food that also quenches thirst (ice cream). */
  snack?: boolean;
  /** Energy restored per drink (coffee). */
  energy?: number;
}

export interface SceneryDef extends BaseDef {
  beauty: number;
  seat?: boolean;
  bin?: boolean;
  lamp?: boolean;
  camera?: boolean;
  plant?: boolean;
}

export interface SpecialDef extends BaseDef {
  upkeep: number;
  color: string;
  /** Placed by the sim; cannot be bought or bulldozed. */
  auto?: boolean;
}

export type ItemDef = RideDef | StallDef | SceneryDef | SpecialDef;
export type ItemCategory = 'ride' | 'stall' | 'scenery' | 'special';

export type StaffRole = 'janitor' | 'mechanic' | 'guard' | 'squad';

export interface StaffDef {
  name: string;
  wage: number;
  color: string;
  hp: number;
  /** Requires this special structure before hiring. */
  requires?: string;
  /** [min, max] hit chance for squad officers. */
  accuracy?: [number, number];
}

export interface Objective {
  id: string;
  text: string;
  test: (s: ParkStats) => boolean;
}

// ---------------------------------------------------------------------------
// Options (options.ts)
// ---------------------------------------------------------------------------

export type Difficulty = 'sandbox' | 'easy' | 'normal' | 'hard' | 'nightmare';
export type Climate = 'temperate' | 'desert' | 'tropical' | 'alpine' | 'autumn';
export type PandemoniumMode = 'off' | 'normal' | 'aggressive';
export type WeatherType = 'sunny' | 'cloudy' | 'rain' | 'storm' | 'heatwave' | 'snow' | 'fog';
export type GuestTypeKey = 'family' | 'thrill' | 'teen' | 'senior' | 'tourist' | 'influencer';

/** Every park's rules. Validated by sanitizeSettings(). */
export interface Settings {
  difficulty: Difficulty;
  climate: Climate;
  startCash: number;
  treeDensity: number;
  guestRate: number;
  guestWealth: number;
  priceTolerance: number;
  breakdowns: number;
  ageing: boolean;
  wages: number;
  crimeRate: number;
  drugs: boolean;
  pandemonium: PandemoniumMode;
  officerDeaths: boolean;
  executions: boolean;
  gore: boolean;
  weather: boolean;
  events: boolean;
  eventRate: number;
}

export type SettingKey = keyof Settings;

interface SettingBase {
  key: SettingKey;
  label: string;
  group: string;
  help?: string;
  /** Changeable mid-game from the Rules panel. */
  live: boolean;
}
export type SettingDef =
  | (SettingBase & { type: 'bool'; default: boolean })
  | (SettingBase & { type: 'select'; options: readonly string[]; default: string })
  | (SettingBase & { type: 'range' | 'number'; min: number; max: number; step: number; default: number });

export interface WeatherDef {
  label: string;
  icon: string;
  /** Multipliers and per-second effects. */
  arrivals: number;
  thirst: number;
  happyDrain: number;
  breakdown: number;
  /** Sky colour and light level for the renderer. */
  sky: number;
  light: number;
  precip?: 'rain' | 'snow';
  umbrella?: boolean;
  lightning?: boolean;
  fog?: boolean;
}

export interface ClimateDef {
  label: string;
  weather: Partial<Record<WeatherType, number>>;
  trees: Record<string, number>;
  grass: [number, number, number];
  outer: number;
  foliage?: number[];
}

export interface EventDef {
  id: string;
  label: string;
  icon: string;
  weight: number;
  crime?: boolean;
  needsFallen?: boolean;
  needsExecutions?: boolean;
  needsWeather?: WeatherType;
}

export interface GuestTypeDef {
  label: string;
  icon: string;
  weight: number;
  cash: [number, number];
  pref: [number, number];
  speed: number;
  energy: number;
  hunger: number;
  litter: number;
  souvenir: number;
  crime?: number;
  influencer?: boolean;
}

export interface StaffTraitDef {
  label: string;
  icon: string;
  speed?: number;
  wage?: number;
  accuracy?: number;
  hp?: number;
  deter?: number;
  workSpeed?: number;
  roles?: StaffRole[];
}

export interface PathStyle {
  label: string;
  color: number;
  edge: number;
}

// ---------------------------------------------------------------------------
// Coasters (coaster.ts)
// ---------------------------------------------------------------------------

export type PieceType =
  | 'station' | 'straight' | 'left' | 'right' | 'wideLeft' | 'wideRight' | 'up' | 'down'
  | 'steepUp' | 'steepDown' | 'lift' | 'booster' | 'brake' | 'loop';

export type Dir = 0 | 1 | 2 | 3;

export interface CoasterStart {
  x: number;
  y: number;
  dir: number;
}

/** Physics result for a complete circuit (or why it failed). */
export type CoasterDesign =
  | { ok: false; reason: string; seg?: number }
  | {
    ok: true;
    maxSpeed: number;
    maxG: number;
    minG: number;
    maxLat: number;
    airtime: number;
    length: number;
    duration: number;
    drops: number;
    biggestDrop: number;
    maxHeight: number;
    inversions: number;
    turns: number;
    excitement: number;
    intensity: number;
    nausea: number;
    warnings: string[];
    times: number[];
    bank: number[];
  };

// ---------------------------------------------------------------------------
// Park state (sim.ts) — the save format
// ---------------------------------------------------------------------------

export type TileKind = 0 | 1 | 2; // grass, path, entrance

export interface RideStats {
  riders: number;
  revenue: number;
}

/** Anything placed on the map. Fields beyond the first block depend on kind. */
export interface ParkObject {
  id: number;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** What the player paid (refunds are based on this). */
  paid: number;
  builtDay?: number;
  name?: string;
  color?: string;

  // Rides and shops
  price?: number;
  open?: boolean;
  broken?: boolean;
  stats?: RideStats;

  // Rides
  phase?: 'idle' | 'running';
  timer?: number;
  wait?: number;
  queue?: number[];
  riders?: number[];

  // Food & drink shops
  corrupt?: boolean;
  exposed?: boolean;
  deals?: number;

  // Custom coasters
  track?: { dir: number; pieces: PieceType[] };
  building?: boolean;
  cars?: number;
  trainColor?: string;

  // Retribution Rig / memorial
  pit?: 'fire' | 'water';
  show?: { t: number; victims: string[]; duration: number; spectators: number } | null;
  graves?: number;

  // Transient (never saved)
  /** Path tiles guests can use this object from (refreshAccess()). */
  _access: number[];
  _cells?: [number, number][];
  _stationCells?: [number, number][];
  _layout?: ReturnType<typeof import('./coaster.ts').layout>;
  _design?: CoasterDesign | null;
  _def?: RideDef;
  _version?: number;
}

/** A ride or shop: always has a till. */
export type ShopObject = ParkObject & Required<Pick<ParkObject, 'price' | 'open' | 'broken' | 'stats'>>;
/** A ride: a till plus a queue and a ride cycle. */
export type RideObject = ShopObject & Required<Pick<ParkObject, 'phase' | 'timer' | 'wait' | 'queue' | 'riders'>>;

/** A player-designed coaster: a ride with a track. */
export type CoasterObject = RideObject & Required<Pick<ParkObject, 'track' | 'cars' | 'name'>>;

export type CrimeKind = 'pickpocket' | 'brawler' | 'robber' | 'dealer' | 'panda';

export interface CriminalRecord {
  theft: number;
  assault: number;
  robbery: number;
  drugs: number;
  homicide: number;
  stolen: number;
}

/** Anything that walks the paths (guests and staff). */
export interface Walker {
  id: number;
  name: string;
  x: number;
  y: number;
  nx: number;
  ny: number;
  lx: number;
  ly: number;
  /** Progress from (x, y) to (nx, ny), 0..1. */
  t: number;
  route: number[] | null;
  /** Slot in the WASM core's walker table (hidden, never saved). See core.ts. */
  _w?: number;
}

export interface Guest extends Walker {
  type: GuestTypeKey;
  shirt: string;
  state: 'walk' | 'queue' | 'ride' | 'busy' | 'sit' | 'downed';
  target: number | null;
  busy: number;
  queueT: number;
  queueAt: number;
  thought: string;
  thoughtT: number;
  litterT: number;
  decideIn: number;
  ridden: Record<number, number>;
  rides: number;
  gone: boolean;
  leaving: boolean;
  cash: number;
  happy: number;
  hunger: number;
  thirst: number;
  bladder: number;
  energy: number;
  nausea: number;
  /** Max ride intensity they enjoy (1–10). */
  pref: number;
  thrift: number;
  timeIn: number;
  umbrella: boolean;
  map: boolean;
  souvenir: boolean;
  atmUsed: boolean;
  // Crime
  crime: CrimeKind | null;
  crimeT: number;
  crimes: number;
  loot: number;
  heistLoot: boolean;
  heist: number | null;
  spotted: boolean;
  injured: boolean;
  record: CriminalRecord;
  gang: string | null;
  high: number;
  arrested?: boolean;
  // Pandemonium members
  hp?: number;
  maxHp?: number;
  acc?: number;
  cool?: number;
  robT?: number;
  lastT?: number;
}

export interface Staff extends Walker {
  role: StaffRole;
  task: number | null;
  busy: number;
  chase: number | null;
  cool: number;
  hp: number;
  maxHp: number;
  acc: number;
  /** Seconds left knocked out. */
  down: number;
  traits: string[];
  job?: number;
}

/** Ledger categories that earn() and spend() book money against. */
export type LedgerCategory = Exclude<keyof Ledger, 'income' | 'expenses' | 'crimeCount'>;

export interface Ledger {
  income: number;
  expenses: number;
  admissions: number;
  rides: number;
  shops: number;
  wages: number;
  upkeep: number;
  construction: number;
  crime: number;
  shows: number;
  fines: number;
  insurance: number;
  events: number;
  crimeCount: number;
}

export interface DayHistory {
  day: number;
  income: number;
  expenses: number;
  guests: number;
  crimes?: number;
}

export interface Incident {
  type: 'theft' | 'assault' | 'heist' | 'homicide' | 'arrest' | 'raid' | 'execution' | 'drugs' | 'gang' | 'sentence';
  text: string;
  day: number;
}

export interface CustodyCase {
  id: number;
  name: string;
  kind: CrimeKind;
  gang: string | null;
  record: CriminalRecord;
  by: string;
  day: number;
}

export interface Raid {
  startedAt: number;
  size: number;
  captured: number;
  escaped: number;
  loot: number;
}

export interface PandemoniumStats {
  raids: number;
  defeated: number;
  escaped: number;
  captured: number;
  executions: number;
  nextRaidDay: number;
}

export interface FallenOfficer {
  name: string;
  role: StaffRole;
  by: string;
  day: number;
  payout: number;
}

/** UI notification produced by the sim (drained each frame). */
export interface SimEvent {
  type: 'info' | 'warn' | 'goal' | 'raid' | 'custody' | 'weather' | 'event';
  text: string;
}

/** Visual effect produced by the sim (drained by the renderer). */
export type Fx =
  | { type: 'blood'; x: number; y: number; amount: number }
  | { type: 'burn' | 'splash'; x: number; y: number }
  | { type: 'shot' | 'bamboo'; x0: number; y0: number; x1: number; y1: number; hit: boolean }
  | { type: 'lightning' };

export interface Park {
  version: number;
  name: string;
  seed: number;
  rngState: number;
  time: number;
  cash: number;
  settings: Settings;
  weather: { type: WeatherType; day: number };
  buzz: number;
  effects: { id: 'outage' | 'protest'; until: number }[];
  eventLog: { id: string; text: string; day: number }[];
  pathStyles: number[];
  uniforms: Partial<Record<StaffRole, string>>;
  entranceFee: number;
  open: boolean;
  rating: number;
  safety: number;
  nextId: number;
  tiles: TileKind[];
  litter: number[];
  stains: number[];
  objects: ParkObject[];
  guests: Guest[];
  staff: Staff[];
  stats: {
    totalGuests: number;
    peakGuests: number;
    arrests: number;
    crimes: number;
    drugDeals: number;
    gangRecruits: number;
    today: Ledger;
    history: DayHistory[];
  };
  thoughts: { text: string; who: string; day: number }[];
  incidents: Incident[];
  objectives: string[];
  raid: Raid | null;
  captives: { name: string }[];
  custody: CustodyCase[];
  fallen: FallenOfficer[];
  fence: boolean;
  locked: boolean;
  pandemonium: PandemoniumStats;

  // Transient (rebuilt on load, never saved)
  _objAt: Int32Array;
  /** Bumped on every object placement change, so the WASM core knows to resync. */
  _objGen?: number;
  _byId: Map<number, ParkObject>;
  _guestById: Map<number, Guest>;
  _events: SimEvent[];
  _fx?: Fx[];
  _spawnAcc?: number;
  _slowT?: number;
}

/** Derived numbers for the HUD, goals and leaderboard (parkStats()). */
export interface ParkStats {
  rides: number;
  coasters: number;
  customCoasters: number;
  stalls: number;
  broken: number;
  excitement: number;
  beauty: number;
  litter: number;
  guards: number;
  arrests: number;
  safety: number;
  stains: number;
  raidsDefeated: number;
  executions: number;
  guests: number;
  avgHappy: number;
  rating: number;
  value: number;
}

/** Result of a player action. */
export type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: string; cash?: boolean; silent?: boolean };
