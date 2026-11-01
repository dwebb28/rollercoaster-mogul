// Customization data: park settings, difficulty presets, climates, weather,
// random events, guest types, staff traits and path styles.
//
// Everything here is data. The sim reads it, the UI renders forms from it,
// and the server validates saves against it (see docs/PERSISTENCE.md).
// To add an option, add an entry here; the setup screen and Rules panel
// pick it up automatically.

import type {
  SettingDef, SettingKey, Settings, Difficulty, Climate, ClimateDef, WeatherType, WeatherDef, EventDef,
  GuestTypeKey, GuestTypeDef, StaffTraitDef, PathStyle,
} from './types.ts';

// ---------------------------------------------------------------------------
// Park settings
// ---------------------------------------------------------------------------

/**
 * Each setting: key, label, help, type ('range' | 'bool' | 'select' | 'number'),
 * bounds/options, default, and `live` (can be changed mid-game from the Rules
 * panel) or not (fixed when the park is created).
 */
export const SETTINGS_SCHEMA: SettingDef[] = [
  { key: 'difficulty', label: 'Difficulty', type: 'select', group: 'Park', options: ['sandbox', 'easy', 'normal', 'hard', 'nightmare'], default: 'normal', live: false,
    help: 'Sets sensible defaults for everything below. You can still tweak each one.' },
  { key: 'climate', label: 'Climate', type: 'select', group: 'Park', options: ['temperate', 'desert', 'tropical', 'alpine', 'autumn'], default: 'temperate', live: false,
    help: 'Changes the ground, the trees on the starting map and the weather you get.' },
  { key: 'startCash', label: 'Starting cash', type: 'number', group: 'Park', min: 0, max: 10000000, step: 5000, default: 25000, live: false },
  { key: 'treeDensity', label: 'Starting trees', type: 'range', group: 'Park', min: 0, max: 3, step: 0.25, default: 1, live: false,
    help: 'How wooded the starting map is.' },

  { key: 'guestRate', label: 'Guest arrivals', type: 'range', group: 'Guests', min: 0.25, max: 3, step: 0.25, default: 1, live: true },
  { key: 'guestWealth', label: 'Guest wealth', type: 'range', group: 'Guests', min: 0.25, max: 3, step: 0.25, default: 1, live: true,
    help: 'How much money guests bring.' },
  { key: 'priceTolerance', label: 'Price tolerance', type: 'range', group: 'Guests', min: 0.5, max: 2, step: 0.1, default: 1, live: true,
    help: 'How much guests are willing to pay before refusing.' },

  { key: 'breakdowns', label: 'Breakdowns', type: 'range', group: 'Operations', min: 0, max: 3, step: 0.25, default: 1, live: true,
    help: 'Multiplies how often rides break down. 0 means never.' },
  { key: 'ageing', label: 'Ride ageing', type: 'bool', group: 'Operations', default: true, live: true,
    help: 'Rides get less reliable with age until refurbished.' },
  { key: 'wages', label: 'Staff wages', type: 'range', group: 'Operations', min: 0.5, max: 2, step: 0.1, default: 1, live: true },

  { key: 'crimeRate', label: 'Crime', type: 'range', group: 'Crime', min: 0, max: 3, step: 0.25, default: 1, live: true,
    help: 'Multiplies how many visitors are criminals. 0 turns crime off.' },
  { key: 'drugs', label: 'Drugs & gangs', type: 'bool', group: 'Crime', default: true, live: true },
  { key: 'pandemonium', label: 'Pandemonium raids', type: 'select', group: 'Crime', options: ['off', 'normal', 'aggressive'], default: 'normal', live: true },
  { key: 'officerDeaths', label: 'Officers can die', type: 'bool', group: 'Crime', default: true, live: true },
  { key: 'executions', label: 'Executions', type: 'bool', group: 'Crime', default: true, live: true,
    help: 'Allows the Retribution Rig and execution verdicts.' },
  { key: 'gore', label: 'Blood & gore', type: 'bool', group: 'Crime', default: true, live: true },

  { key: 'weather', label: 'Weather', type: 'bool', group: 'World', default: true, live: true },
  { key: 'events', label: 'Random events', type: 'bool', group: 'World', default: true, live: true },
  { key: 'eventRate', label: 'Event frequency', type: 'range', group: 'World', min: 0.25, max: 3, step: 0.25, default: 1, live: true },
];

export const DIFFICULTIES: Record<Difficulty, { label: string } & Partial<Settings>> = {
  sandbox: { label: 'Sandbox', startCash: 1000000, crimeRate: 0, pandemonium: 'off', breakdowns: 0.5, guestWealth: 1.5, wages: 0.5, priceTolerance: 1.3 },
  easy: { label: 'Easy', startCash: 60000, crimeRate: 0.5, pandemonium: 'normal', breakdowns: 0.75, guestWealth: 1.25, priceTolerance: 1.15 },
  normal: { label: 'Normal' },
  hard: { label: 'Hard', startCash: 15000, crimeRate: 1.5, pandemonium: 'aggressive', breakdowns: 1.5, guestWealth: 0.85, wages: 1.25, priceTolerance: 0.85 },
  nightmare: { label: 'Nightmare', startCash: 8000, crimeRate: 2.5, pandemonium: 'aggressive', breakdowns: 2.5, guestWealth: 0.7, wages: 1.5, priceTolerance: 0.7, guestRate: 0.75 },
};

const SCHEMA_BY_KEY = Object.fromEntries(SETTINGS_SCHEMA.map((s) => [s.key, s])) as Record<SettingKey, SettingDef>;
const isDifficulty = (d: unknown): d is Difficulty => typeof d === 'string' && d in DIFFICULTIES;

/** Full settings for a difficulty preset. */
export function defaultSettings(difficulty: string = 'normal'): Settings {
  const base = Object.fromEntries(SETTINGS_SCHEMA.map((s) => [s.key, s.default])) as unknown as Settings;
  const key = isDifficulty(difficulty) ? difficulty : 'normal';
  const { label: _label, ...values } = DIFFICULTIES[key];
  return { ...base, ...values, difficulty: key };
}

/** Validates untrusted settings against the schema, filling defaults. */
export function sanitizeSettings(raw?: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = defaultSettings(isDifficulty(r.difficulty) ? r.difficulty : 'normal');
  const write = out as unknown as Record<string, unknown>;
  for (const s of SETTINGS_SCHEMA) {
    const v = r[s.key];
    if (v === undefined) continue;
    if (s.type === 'bool') write[s.key] = v === true;
    else if (s.type === 'select') { if (typeof v === 'string' && s.options.includes(v)) write[s.key] = v; }
    else if (typeof v === 'number' && Number.isFinite(v)) write[s.key] = Math.max(s.min, Math.min(s.max, v));
  }
  return out;
}

export const settingDef = (key: string): SettingDef | undefined => SCHEMA_BY_KEY[key as SettingKey];

// ---------------------------------------------------------------------------
// Climates & weather
// ---------------------------------------------------------------------------

export const WEATHER: Record<WeatherType, WeatherDef> = {
  sunny: { label: 'Sunny', icon: '☀️', arrivals: 1, thirst: 1, happyDrain: 0, breakdown: 1, sky: 0x9fd3f2, light: 1 },
  cloudy: { label: 'Cloudy', icon: '⛅', arrivals: 0.95, thirst: 0.9, happyDrain: 0, breakdown: 1, sky: 0xaebccb, light: 0.8 },
  rain: { label: 'Rain', icon: '🌧️', arrivals: 0.6, thirst: 0.7, happyDrain: 0.15, breakdown: 1.2, sky: 0x7d8a99, light: 0.6, precip: 'rain', umbrella: true },
  storm: { label: 'Thunderstorm', icon: '⛈️', arrivals: 0.35, thirst: 0.7, happyDrain: 0.3, breakdown: 3, sky: 0x4a5160, light: 0.4, precip: 'rain', umbrella: true, lightning: true },
  heatwave: { label: 'Heatwave', icon: '🔥', arrivals: 0.9, thirst: 1.8, happyDrain: 0.05, breakdown: 1.3, sky: 0xbfd8e6, light: 1.25 },
  snow: { label: 'Snow', icon: '🌨️', arrivals: 0.6, thirst: 0.6, happyDrain: 0.1, breakdown: 1.4, sky: 0xc5cfd8, light: 0.75, precip: 'snow', umbrella: true },
  fog: { label: 'Fog', icon: '🌫️', arrivals: 0.85, thirst: 0.9, happyDrain: 0.02, breakdown: 1, sky: 0xc9cfd3, light: 0.7, fog: true },
};

export const CLIMATES: Record<Climate, ClimateDef> = {
  temperate: {
    label: 'Temperate', weather: { sunny: 4, cloudy: 3, rain: 2, storm: 0.5, heatwave: 0.5, fog: 0.7 },
    trees: { tree: 5, pine: 4, cherry: 1 }, grass: [104, 178, 82], outer: 0x3f7a3c,
  },
  desert: {
    label: 'Desert', weather: { sunny: 6, heatwave: 3, cloudy: 1, storm: 0.3 },
    trees: { cactus: 6, palm: 3, rock: 3 }, grass: [214, 186, 128], outer: 0xb8955a,
  },
  tropical: {
    label: 'Tropical', weather: { sunny: 4, rain: 3, storm: 1.2, heatwave: 1, cloudy: 1 },
    trees: { palm: 7, tree: 2 }, grass: [86, 176, 92], outer: 0x2f7d4a,
  },
  alpine: {
    label: 'Alpine', weather: { cloudy: 3, snow: 3, sunny: 2, fog: 1.5, storm: 0.5 },
    trees: { pine: 8, rock: 2, snowman: 0.3 }, grass: [196, 214, 204], outer: 0xa9bdb1,
  },
  autumn: {
    label: 'Autumn', weather: { cloudy: 4, rain: 3, sunny: 2, fog: 1.5, storm: 0.5 },
    trees: { tree: 6, pine: 2, cherry: 1 }, grass: [148, 160, 82], outer: 0x6b6a35, foliage: [0xd2691e, 0xc0392b, 0xe6a23c, 0x8e5a2b],
  },
};

// ---------------------------------------------------------------------------
// Random events (rolled at the start of each day)
// ---------------------------------------------------------------------------

/**
 * weight: relative chance. when(park, stats): eligibility. The effect itself
 * lives in sim.js `applyEvent`, keyed by id, so this table stays pure data.
 */
export const EVENTS: EventDef[] = [
  { id: 'tourBus', label: 'Tour bus', icon: '🚌', weight: 3 },
  { id: 'sponsor', label: 'Sponsorship deal', icon: '🤝', weight: 1.5 },
  { id: 'vip', label: 'VIP visit', icon: '🕴️', weight: 1.2 },
  { id: 'inspector', label: 'Health inspector', icon: '📋', weight: 1.5 },
  { id: 'powerOutage', label: 'Power outage', icon: '🔌', weight: 1 },
  { id: 'viral', label: 'Viral post', icon: '📱', weight: 1.5 },
  { id: 'lottery', label: 'Lottery winner', icon: '🎟️', weight: 1 },
  { id: 'celebrity', label: 'Celebrity sighting', icon: '⭐', weight: 0.8 },
  { id: 'pickpocketRing', label: 'Pickpocket ring', icon: '👛', weight: 1, crime: true },
  { id: 'donation', label: 'Memorial donation', icon: '💐', weight: 1, needsFallen: true },
  { id: 'protest', label: 'Protest', icon: '🪧', weight: 1, needsExecutions: true },
  { id: 'heatAdvisory', label: 'Ice cream rush', icon: '🍦', weight: 0.8, needsWeather: 'heatwave' },
];

// ---------------------------------------------------------------------------
// Guest types
// ---------------------------------------------------------------------------

export const GUEST_TYPES: Record<GuestTypeKey, GuestTypeDef> = {
  family: { label: 'Family', icon: '👨‍👩‍👧', weight: 4, cash: [30, 90], pref: [1, 5], speed: 0.9, energy: 1.1, hunger: 1.1, litter: 0.7, souvenir: 0.3 },
  thrill: { label: 'Thrill-seeker', icon: '🤘', weight: 3, cash: [40, 120], pref: [6, 10], speed: 1.1, energy: 0.9, hunger: 1, litter: 0.75, souvenir: 0.1 },
  teen: { label: 'Teenager', icon: '🛹', weight: 2, cash: [15, 55], pref: [4, 9], speed: 1.2, energy: 0.8, hunger: 1.3, litter: 0.95, souvenir: 0.15, crime: 1.5 },
  senior: { label: 'Senior', icon: '👴', weight: 1.5, cash: [50, 150], pref: [1, 3], speed: 0.65, energy: 1.5, hunger: 0.8, litter: 0.4, souvenir: 0.4 },
  tourist: { label: 'Tourist', icon: '📸', weight: 1.5, cash: [80, 220], pref: [2, 7], speed: 0.9, energy: 1, hunger: 1, litter: 0.6, souvenir: 0.8 },
  influencer: { label: 'Influencer', icon: '🤳', weight: 0.4, cash: [60, 160], pref: [3, 8], speed: 1, energy: 1, hunger: 0.9, litter: 0.6, souvenir: 0.5, influencer: true },
};

// ---------------------------------------------------------------------------
// Staff traits (0–2 rolled per hire)
// ---------------------------------------------------------------------------

export const STAFF_TRAITS: Record<string, StaffTraitDef> = {
  speedy: { label: 'Speedy', icon: '💨', speed: 1.3 },
  lazy: { label: 'Lazy', icon: '😴', speed: 0.75, wage: 0.85 },
  sharpshooter: { label: 'Sharpshooter', icon: '🎯', accuracy: 0.1, roles: ['squad'] },
  clumsy: { label: 'Clumsy', icon: '🙃', accuracy: -0.1, roles: ['squad'] },
  tough: { label: 'Tough', icon: '💪', hp: 2 },
  fragile: { label: 'Fragile', icon: '🩹', hp: -1 },
  eagleEye: { label: 'Eagle-eyed', icon: '🦅', deter: 2, roles: ['guard'] },
  veteran: { label: 'Veteran', icon: '🎖️', hp: 1, accuracy: 0.05, wage: 1.25 },
  rookie: { label: 'Rookie', icon: '🐣', accuracy: -0.05, wage: 0.8 },
  meticulous: { label: 'Meticulous', icon: '🧽', speed: 0.9, roles: ['janitor', 'mechanic'], workSpeed: 1.5 },
};

// ---------------------------------------------------------------------------
// Path styles & colour palettes
// ---------------------------------------------------------------------------

export const PATH_STYLES: PathStyle[] = [
  { label: 'Sandstone', color: 0xd7c4a3, edge: 0x9c8a6e },
  { label: 'Concrete', color: 0xc4c8cc, edge: 0x8a8f95 },
  { label: 'Red brick', color: 0xb85c4a, edge: 0x7a3a2e },
  { label: 'Boardwalk', color: 0xa77b4f, edge: 0x6b4a2a },
  { label: 'Cobblestone', color: 0x8f8a84, edge: 0x5e5a55 },
  { label: 'Tarmac', color: 0x4a4d52, edge: 0x2c2e31 },
];

export const PAINT = ['#e5484d', '#ef6fa8', '#f2b84b', '#ffd23f', '#7bd389', '#2bb3a3', '#5aa9e6', '#3a86ff', '#9b6bd6', '#c47a3d', '#ffffff', '#333333'];

export const isHexColor = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

/** Weighted pick from {key: weight} (or {key: {weight}}) using a 0..1 random number. */
export function weighted<K extends string>(table: Partial<Record<K, number | { weight: number }>>, r: number): K {
  const entries = Object.entries(table) as [K, number | { weight: number }][];
  const weightOf = (w: number | { weight: number }) => (typeof w === 'number' ? w : w.weight);
  const total = entries.reduce((n, [, w]) => n + weightOf(w), 0);
  let x = r * total;
  for (const [k, w] of entries) {
    x -= weightOf(w);
    if (x < 0) return k;
  }
  return entries[entries.length - 1]![0];
}
