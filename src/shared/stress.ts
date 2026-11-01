// A large, busy park for profiling: a street grid, dozens of rides and shops,
// a full staff and hundreds of guests already spread through the park.
// Used by `npm run bench` and the in-game performance overlay.

import { createPark, build, buildPath, hire, addGuests, objectAt, bulldoze, step } from './sim.ts';
import { defaultSettings } from './options.ts';
import { GRID } from './catalog.ts';
import type { Park, StaffRole } from './types.ts';

const RIDE_ROTATION = ['teacups', 'carousel', 'skywheel', 'bumper', 'droptower', 'chairswing', 'pirateship', 'woodie'];
const SHOP_ROTATION = ['burger', 'lemonade', 'restroom', 'pizza', 'soda', 'icecream', 'coffee', 'souvenir', 'atm', 'info', 'bin', 'bench'];

export function buildStressPark(guests = 600, seed = 1): Park {
  const park = createPark('Stress Test', seed, {
    ...defaultSettings('normal'), startCash: 50_000_000, treeDensity: 0.4,
    // Keep the workload steady: no raids or random events mid-measurement.
    pandemonium: 'off', events: false, weather: false,
  });
  // Clear everything off the land first.
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) if (objectAt(park, x, y)) bulldoze(park, x, y);

  // A main avenue from the entrance, and cross streets every 7 rows.
  const streets = [5, 12, 19, 26, 33];
  for (let y = 2; y < GRID - 1; y++) buildPath(park, GRID / 2, y);
  for (const y of streets) for (let x = 2; x < GRID - 2; x++) buildPath(park, x, y);
  for (const x of [3, GRID - 4]) for (let y = streets[0]!; y <= streets[streets.length - 1]!; y++) buildPath(park, x, y);

  // Rides on the blocks between streets, shops along the kerbs.
  let r = 0, s = 0;
  for (const y of streets) {
    for (let x = 4; x < GRID - 6; x += 4) {
      if (x >= GRID / 2 - 2 && x <= GRID / 2 + 1) continue;
      for (let tries = 0; tries < RIDE_ROTATION.length; tries++) {
        const kind = RIDE_ROTATION[(r + tries) % RIDE_ROTATION.length]!;
        if (build(park, kind, x, y + 1).ok) { r++; break; }
      }
    }
    for (let x = 5; x < GRID - 3; x += 3) {
      if (Math.abs(x - GRID / 2) < 2) continue;
      if (build(park, SHOP_ROTATION[s % SHOP_ROTATION.length]!, x, y - 1).ok) s++;
    }
  }
  const staff: [StaffRole, number][] = [['janitor', 10], ['mechanic', 6], ['guard', 8]];
  for (const [role, n] of staff) for (let k = 0; k < n; k++) hire(park, role);

  addGuests(park, guests);
  // Let the crowd settle into normal behaviour.
  for (let k = 0; k < 100; k++) step(park, 0.1);
  return park;
}
