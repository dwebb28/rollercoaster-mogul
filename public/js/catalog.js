// Everything a player can build or hire. All sim balancing lives here.

export const GRID = 40;
export const DAY_SECONDS = 60; // game-seconds per in-game day
export const START_CASH = 25000;
export const PATH_COST = 10;
export const REFUND_RATE = 0.5;

export const RIDES = {
  teacups: {
    name: 'Whirly Teacups', w: 2, h: 2, cost: 1200, capacity: 8, duration: 6,
    excitement: 3, intensity: 2, nausea: 4, price: 2, upkeep: 15, reliability: 0.985,
    color: '#ef6fa8',
  },
  carousel: {
    name: 'Gallop Carousel', w: 2, h: 2, cost: 1500, capacity: 10, duration: 7,
    excitement: 3, intensity: 1, nausea: 1, price: 2, upkeep: 15, reliability: 0.99,
    color: '#f2b84b',
  },
  skywheel: {
    name: 'Sky Wheel', w: 3, h: 3, cost: 2800, capacity: 12, duration: 10,
    excitement: 4, intensity: 1, nausea: 1, price: 3, upkeep: 25, reliability: 0.985,
    color: '#5aa9e6',
  },
  bumper: {
    name: 'Bumper Bash', w: 3, h: 2, cost: 3200, capacity: 10, duration: 8,
    excitement: 5, intensity: 3, nausea: 2, price: 3, upkeep: 30, reliability: 0.975,
    color: '#7bd389',
  },
  droptower: {
    name: 'Plummet Tower', w: 2, h: 2, cost: 4500, capacity: 8, duration: 6,
    excitement: 6, intensity: 8, nausea: 5, price: 4, upkeep: 40, reliability: 0.97,
    color: '#9b6bd6',
  },
  woodie: {
    name: 'Timber Rattler', w: 5, h: 3, cost: 9000, capacity: 16, duration: 12,
    excitement: 8, intensity: 6, nausea: 4, price: 6, upkeep: 70, reliability: 0.965,
    color: '#c47a3d', coaster: true,
  },
  looper: {
    name: 'Comet Corkscrew', w: 6, h: 4, cost: 16000, capacity: 20, duration: 14,
    excitement: 9, intensity: 9, nausea: 7, price: 8, upkeep: 110, reliability: 0.96,
    color: '#e5484d', coaster: true, loop: true,
  },
};

export const STALLS = {
  burger: { name: 'Burger Shack', w: 1, h: 1, cost: 400, sells: 'food', price: 4, unitCost: 1.5, upkeep: 10, icon: '🍔', color: '#e8833a' },
  pizza: { name: 'Pizza Slice', w: 1, h: 1, cost: 500, sells: 'food', price: 5, unitCost: 1.8, upkeep: 12, icon: '🍕', color: '#d9534f' },
  lemonade: { name: 'Lemonade Stand', w: 1, h: 1, cost: 300, sells: 'drink', price: 2, unitCost: 0.5, upkeep: 8, icon: '🍋', color: '#f5d33f' },
  soda: { name: 'Fizz Pop', w: 1, h: 1, cost: 350, sells: 'drink', price: 3, unitCost: 0.7, upkeep: 8, icon: '🥤', color: '#4aa3df' },
  restroom: { name: 'Restrooms', w: 1, h: 1, cost: 600, sells: 'restroom', price: 0, unitCost: 0, upkeep: 12, icon: '🚻', color: '#8fa3b8' },
  firstaid: { name: 'First Aid Post', w: 1, h: 1, cost: 700, sells: 'firstaid', price: 0, unitCost: 0, upkeep: 20, icon: '⛑️', color: '#d64545' },
};

export const SCENERY = {
  tree: { name: 'Oak Tree', w: 1, h: 1, cost: 25, beauty: 2 },
  pine: { name: 'Pine Tree', w: 1, h: 1, cost: 25, beauty: 2 },
  flowers: { name: 'Flower Bed', w: 1, h: 1, cost: 15, beauty: 3 },
  fountain: { name: 'Fountain', w: 2, h: 2, cost: 400, beauty: 10 },
  bench: { name: 'Bench', w: 1, h: 1, cost: 50, beauty: 0, seat: true },
  bin: { name: 'Litter Bin', w: 1, h: 1, cost: 40, beauty: 0, bin: true },
  lamp: { name: 'Lamp Post', w: 1, h: 1, cost: 60, beauty: 1, lamp: true },
  camera: { name: 'Security Camera', w: 1, h: 1, cost: 300, beauty: 0, camera: true },
};

export const STAFF = {
  janitor: { name: 'Janitor', wage: 30, color: '#3fa34d' },
  mechanic: { name: 'Mechanic', wage: 45, color: '#e07b24' },
  guard: { name: 'Security Guard', wage: 55, color: '#2b4c7e' },
  squad: { name: 'Hot Dog Squad Officer', wage: 90, color: '#d63c2f', requires: 'securityhq' },
};

/** Special structures for dealing with the Pandemonium heist crew. */
export const SPECIAL = {
  securityhq: { name: 'Security HQ', w: 2, h: 2, cost: 5000, upkeep: 60, color: '#2b4c7e' },
  retribution: { name: 'Retribution Rig', w: 4, h: 3, cost: 12000, upkeep: 40, color: '#5a1a1a' },
};

/** Pandemonium: a raiding heist crew in panda costumes. */
export const PANDEMONIUM = {
  firstRaidDay: 4,
  raidChance: 0.45, // chance per day once the cooldown has passed
  cooldownDays: 2,
  minGuests: 15,
  crewBase: 4,
  crewGrowth: 1, // extra members per previous raid
  crewMax: 9,
  hp: 4, // hot dog hits to bring one down
  speed: 1.8,
  raidSeconds: 100, // after this the crew heads for the exit with the loot
  actEvery: [5, 10],
  tillLoot: [100, 350],
  robCooldown: 12, // seconds between robberies per member
  sabotageChance: 0.35,
  assaultChance: 0.6,
  shotRange: 5,
  shotCooldown: 1.1,
  hitChance: 0.7,
  downedSeconds: 3,
  escapeSafetyHit: 25,
  defeatSafetyBonus: 20,
  showSecondsPerVictim: 4,
  spectatorFee: 6,
  showHappiness: 25,
  names: ['Bamboo Bandit', 'Big Bao', 'Dim Sum', 'Kung Pow', 'Mochi', 'Sir Chomps', 'Tumbles', 'Fluffernutter', 'The Patch', 'Snowball', 'Chopsticks'],
};

/** Crime balancing. Probabilities are per arriving guest / per attempt. */
export const CRIME = {
  baseRate: 0.035, // share of arriving guests who are criminals
  lowRatingRate: 0.03, // extra share when the park rating is below 400
  types: { pickpocket: 0.6, brawler: 0.3, robber: 0.1 },
  guardDeterRadius: 4,
  guardDeterFactor: 0.15, // attempt chance multiplier with a guard close by
  guardChaseRadius: 8,
  cameraRadius: 5,
  cameraDeterFactor: 0.6,
  cameraSpotChance: 0.8,
  lampRadius: 3,
  daytimeFactor: 0.6, // crime is less likely in daylight (or under lamps at dusk)
  gateArrestChance: 0.5, // spotted criminals stopped when leaving
  homicideChance: 0.03, // chance an assault turns fatal
  firstAidHomicideFactor: 0.4,
  homicideLegalCost: 2000,
  safetyHit: { theft: 2, assault: 6, heist: 8, homicide: 40 },
  safetyRecovery: 0.03, // safety points per game-second
};

export function itemDef(kind) {
  return RIDES[kind] || STALLS[kind] || SCENERY[kind] || SPECIAL[kind] || null;
}

export function itemCategory(kind) {
  if (RIDES[kind]) return 'ride';
  if (STALLS[kind]) return 'stall';
  if (SCENERY[kind]) return 'scenery';
  if (SPECIAL[kind]) return 'special';
  return null;
}

export const OBJECTIVES = [
  { id: 'first-ride', text: 'Build your first ride', test: (s) => s.rides >= 1 },
  { id: 'guests-25', text: 'Have 25 guests in the park', test: (s) => s.guests >= 25 },
  { id: 'coaster', text: 'Build a roller coaster', test: (s) => s.coasters >= 1 },
  { id: 'rating-600', text: 'Reach a park rating of 600', test: (s) => s.rating >= 600 },
  { id: 'rides-6', text: 'Operate 6 rides', test: (s) => s.rides >= 6 },
  { id: 'guests-100', text: 'Have 100 guests in the park', test: (s) => s.guests >= 100 },
  { id: 'value-75k', text: 'Reach a park value of $75,000', test: (s) => s.value >= 75000 },
  { id: 'rating-800', text: 'Reach a park rating of 800', test: (s) => s.rating >= 800 },
  { id: 'guard', text: 'Hire a security guard', test: (s) => s.guards >= 1 },
  { id: 'arrests-10', text: 'Make 10 arrests', test: (s) => s.arrests >= 10 },
  { id: 'pandemonium', text: 'Defeat a Pandemonium raid', test: (s) => s.raidsDefeated >= 1 },
  { id: 'justice', text: 'Stage a public execution', test: (s) => s.executions >= 1 },
];
