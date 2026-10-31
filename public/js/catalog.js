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
};

export const SCENERY = {
  tree: { name: 'Oak Tree', w: 1, h: 1, cost: 25, beauty: 2 },
  pine: { name: 'Pine Tree', w: 1, h: 1, cost: 25, beauty: 2 },
  flowers: { name: 'Flower Bed', w: 1, h: 1, cost: 15, beauty: 3 },
  fountain: { name: 'Fountain', w: 2, h: 2, cost: 400, beauty: 10 },
  bench: { name: 'Bench', w: 1, h: 1, cost: 50, beauty: 0, seat: true },
  bin: { name: 'Litter Bin', w: 1, h: 1, cost: 40, beauty: 0, bin: true },
};

export const STAFF = {
  janitor: { name: 'Janitor', wage: 30, color: '#3fa34d' },
  mechanic: { name: 'Mechanic', wage: 45, color: '#e07b24' },
};

export function itemDef(kind) {
  return RIDES[kind] || STALLS[kind] || SCENERY[kind] || null;
}

export function itemCategory(kind) {
  if (RIDES[kind]) return 'ride';
  if (STALLS[kind]) return 'stall';
  if (SCENERY[kind]) return 'scenery';
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
];
