// Everything a player can build or hire. All sim balancing lives here.

import type { RideDef, StallDef, SceneryDef, SpecialDef, StaffDef, StaffRole, ItemDef, ItemCategory, Objective, Sells } from './types.ts';

export const GRID = 40;
export const DAY_SECONDS = 60; // game-seconds per in-game day
export const START_CASH = 25000;
export const PATH_COST = 10;
export const REFUND_RATE = 0.5;

export const RIDES: Record<string, RideDef> = {
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
  chairswing: {
    name: 'Sky Swinger', w: 2, h: 2, cost: 2600, capacity: 12, duration: 8,
    excitement: 5, intensity: 4, nausea: 4, price: 3, upkeep: 25, reliability: 0.98,
    color: '#2bb3a3',
  },
  pirateship: {
    name: 'Buccaneer Swing', w: 3, h: 2, cost: 3800, capacity: 20, duration: 10,
    excitement: 5, intensity: 5, nausea: 6, price: 3, upkeep: 30, reliability: 0.98,
    color: '#8b5a2b',
  },
};

/** Base definition for player-designed coasters; stats come from physics. */
export const CUSTOM_COASTER: RideDef = {
  name: 'Custom Coaster', w: 1, h: 1, cost: 0, capacity: 16, duration: 30,
  excitement: 0, intensity: 0, nausea: 0, price: 0, upkeep: 30, reliability: 0.975,
  color: '#3a86ff', coaster: true, custom: true,
};

export const STALLS: Record<string, StallDef> = {
  burger: { name: 'Burger Shack', w: 1, h: 1, cost: 400, sells: 'food', price: 4, unitCost: 1.5, upkeep: 10, icon: '🍔', color: '#e8833a' },
  pizza: { name: 'Pizza Slice', w: 1, h: 1, cost: 500, sells: 'food', price: 5, unitCost: 1.8, upkeep: 12, icon: '🍕', color: '#d9534f' },
  lemonade: { name: 'Lemonade Stand', w: 1, h: 1, cost: 300, sells: 'drink', price: 2, unitCost: 0.5, upkeep: 8, icon: '🍋', color: '#f5d33f' },
  soda: { name: 'Fizz Pop', w: 1, h: 1, cost: 350, sells: 'drink', price: 3, unitCost: 0.7, upkeep: 8, icon: '🥤', color: '#4aa3df' },
  restroom: { name: 'Restrooms', w: 1, h: 1, cost: 600, sells: 'restroom', price: 0, unitCost: 0, upkeep: 12, icon: '🚻', color: '#8fa3b8' },
  firstaid: { name: 'First Aid Post', w: 1, h: 1, cost: 700, sells: 'firstaid', price: 0, unitCost: 0, upkeep: 20, icon: '⛑️', color: '#d64545' },
  icecream: { name: 'Ice Cream Cart', w: 1, h: 1, cost: 450, sells: 'food', snack: true, price: 3, unitCost: 0.8, upkeep: 9, icon: '🍦', color: '#f7a8c8' },
  coffee: { name: 'Coffee Kiosk', w: 1, h: 1, cost: 500, sells: 'drink', energy: 30, price: 3, unitCost: 0.6, upkeep: 9, icon: '☕', color: '#6f4e37' },
  souvenir: { name: 'Souvenir Shop', w: 1, h: 1, cost: 900, sells: 'souvenir', price: 8, unitCost: 3, upkeep: 15, icon: '🎁', color: '#9b6bd6' },
  umbrella: { name: 'Umbrella Stand', w: 1, h: 1, cost: 400, sells: 'umbrella', price: 6, unitCost: 2, upkeep: 8, icon: '☂️', color: '#3a86ff' },
  atm: { name: 'Cash Machine', w: 1, h: 1, cost: 1200, sells: 'atm', price: 2, unitCost: 0, upkeep: 10, icon: '🏧', color: '#2bb3a3' },
  info: { name: 'Information Kiosk', w: 1, h: 1, cost: 600, sells: 'info', price: 1, unitCost: 0.2, upkeep: 10, icon: 'ℹ️', color: '#3a86ff' },
};

/** Base value guests place on each kind of purchase (before tolerance & thrift). */
export const SHOP_VALUE: Record<Sells, number> = { food: 7, drink: 4.5, restroom: 2, firstaid: 2, souvenir: 12, umbrella: 9, atm: 3, info: 2 };

export const SCENERY: Record<string, SceneryDef> = {
  tree: { name: 'Oak Tree', w: 1, h: 1, cost: 25, beauty: 2 },
  pine: { name: 'Pine Tree', w: 1, h: 1, cost: 25, beauty: 2 },
  flowers: { name: 'Flower Bed', w: 1, h: 1, cost: 15, beauty: 3 },
  fountain: { name: 'Fountain', w: 2, h: 2, cost: 400, beauty: 10 },
  bench: { name: 'Bench', w: 1, h: 1, cost: 50, beauty: 0, seat: true },
  bin: { name: 'Litter Bin', w: 1, h: 1, cost: 40, beauty: 0, bin: true },
  lamp: { name: 'Lamp Post', w: 1, h: 1, cost: 60, beauty: 1, lamp: true },
  camera: { name: 'Security Camera', w: 1, h: 1, cost: 300, beauty: 0, camera: true },
  palm: { name: 'Palm Tree', w: 1, h: 1, cost: 40, beauty: 3, plant: true },
  cactus: { name: 'Cactus', w: 1, h: 1, cost: 30, beauty: 2, plant: true },
  cherry: { name: 'Cherry Blossom', w: 1, h: 1, cost: 60, beauty: 4, plant: true },
  hedge: { name: 'Hedge', w: 1, h: 1, cost: 30, beauty: 2, plant: true },
  rock: { name: 'Boulder', w: 1, h: 1, cost: 30, beauty: 1 },
  statue: { name: 'Statue', w: 1, h: 1, cost: 350, beauty: 6 },
  snowman: { name: 'Snowman', w: 1, h: 1, cost: 40, beauty: 3 },
};
SCENERY.tree.plant = SCENERY.pine.plant = SCENERY.flowers.plant = true;

/** Ride ageing: reliability lost per day, and refurbishment cost as a share of build cost. */
export const AGEING = { perDay: 0.0012, maxLoss: 0.06, refurbishShare: 0.3 };

/** Shared coaster design codes are prefixed with this. */
export const DESIGN_CODE_PREFIX = 'RCM1:';

export const STAFF: Record<StaffRole, StaffDef> = {
  janitor: { name: 'Janitor', wage: 30, color: '#3fa34d', hp: 3 },
  mechanic: { name: 'Mechanic', wage: 45, color: '#e07b24', hp: 3 },
  guard: { name: 'Security Guard', wage: 55, color: '#2b4c7e', hp: 5 },
  squad: { name: 'Hot Dog Squad Officer', wage: 90, color: '#d63c2f', requires: 'securityhq', hp: 6, accuracy: [0.65, 0.8] },
};

/** Special structures for dealing with the Pandemonium heist crew. */
export const SPECIAL: Record<string, SpecialDef> = {
  securityhq: { name: 'Security HQ', w: 2, h: 2, cost: 5000, upkeep: 60, color: '#2b4c7e' },
  retribution: { name: 'Retribution Rig', w: 4, h: 3, cost: 12000, upkeep: 40, color: '#5a1a1a' },
  // Placed automatically when an officer is killed; cannot be bought or bulldozed.
  memorial: { name: 'Fallen Officers Memorial', w: 2, h: 2, cost: 0, upkeep: 0, color: '#8a8f98', auto: true },
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
  hp: [3, 5], // hot dog hits to bring one down (random per panda)
  speed: 1.8,
  raidSeconds: 100, // after this the crew heads for the exit with the loot
  actEvery: [5, 10],
  tillLoot: [100, 350],
  robCooldown: 12, // seconds between robberies per member
  sabotageChance: 0.35,
  assaultChance: 0.6,
  shotRange: 5,
  shotCooldown: 1.1,
  // Pandas fight back with thrown bamboo, but are weaker than the squad on
  // average: less health, worse aim, slower throws.
  pandaAccuracy: [0.4, 0.6],
  throwRange: 4,
  throwCooldown: 1.3,
  knockoutSeconds: 35, // staff out of action when their health runs out
  killChance: 0.25, // chance a knockout is fatal instead
  lifeInsurance: { squad: 5000, guard: 3000 }, // paid to the family of a fallen officer
  memorialSafetyBonus: 2, // the memorial reassures guests a little
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
  types: { pickpocket: 0.6, brawler: 0.3, robber: 0.1, dealer: 0 },
  dealerRate: 0.04, // share of arriving guests who are drug dealers (on top of baseRate)
  gangs: ['The Sticky Fingers', 'Cotton Candy Cartel', 'The Funnel Cake Mob', 'Teacup Triad', 'The Loop-de-Loopers'],
  gangChance: 0.5, // chance a born criminal belongs to a gang (dealers always do)
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
  safetyHit: { theft: 2, assault: 6, heist: 8, homicide: 40, drugs: 1 },
  // Drugs
  dealPrice: [10, 25],
  dealAcceptBase: 0.2, // plus up to +0.5 for unhappy guests
  highSeconds: [60, 120],
  gangRecruitChance: 0.3, // chance a guest joins a gang when their high wears off
  corruptVendorChance: 0.2, // chance a new food/drink stall's vendor deals on the side
  corruptOfferChance: 0.25,
  corruptExposeChance: 0.5, // per deal, if a guard or camera is watching the stall
  replaceVendorCost: 250,
  // Sentencing
  fineBase: 150,
  finePerOffence: 75,
  fineStolenMultiplier: 1.5,
  pandaFine: 1000,
  releaseSafetyHit: 3,
  // Barbed wire perimeter
  fenceCost: 15000,
  fenceUpkeep: 120,
  lockedRatingPenalty: 60,
  safetyRecovery: 0.03, // safety points per game-second
};

export function itemDef(kind: string): ItemDef | null {
  return RIDES[kind] || STALLS[kind] || SCENERY[kind] || SPECIAL[kind] || (kind === 'custom' ? CUSTOM_COASTER : null);
}

export function itemCategory(kind: string): ItemCategory | null {
  if (RIDES[kind] || kind === 'custom') return 'ride';
  if (STALLS[kind]) return 'stall';
  if (SCENERY[kind]) return 'scenery';
  if (SPECIAL[kind]) return 'special';
  return null;
}

export const OBJECTIVES: Objective[] = [
  { id: 'first-ride', text: 'Build your first ride', test: (s) => s.rides >= 1 },
  { id: 'guests-25', text: 'Have 25 guests in the park', test: (s) => s.guests >= 25 },
  { id: 'coaster', text: 'Build a roller coaster', test: (s) => s.coasters >= 1 },
  { id: 'designer', text: 'Open a coaster of your own design', test: (s) => s.customCoasters >= 1 },
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
