import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Sim from '../public/js/sim.js';
import { START_CASH, PATH_COST, RIDES } from '../public/js/catalog.js';

/** A small park with a path loop, rides, food, and staff. */
function samplePark(seed = 7) {
  const p = Sim.createPark('Test Park', seed);
  for (let y = 20; y < 39; y++) for (let x = 10; x < 31; x++) if (Sim.objectAt(p, x, y)) Sim.bulldoze(p, x, y);
  for (let x = 14; x <= 26; x++) Sim.buildPath(p, x, 26);
  for (let y = 27; y <= 32; y++) Sim.buildPath(p, 20, y);
  assert.ok(Sim.build(p, 'teacups', 14, 24).ok);
  assert.ok(Sim.build(p, 'skywheel', 22, 23).ok);
  assert.ok(Sim.build(p, 'woodie', 14, 27).ok);
  assert.ok(Sim.build(p, 'burger', 17, 25).ok);
  assert.ok(Sim.build(p, 'lemonade', 18, 25).ok);
  assert.ok(Sim.build(p, 'restroom', 19, 25).ok);
  Sim.hire(p, 'janitor');
  Sim.hire(p, 'mechanic');
  return p;
}

const run = (p, seconds) => { for (let i = 0; i < seconds * 10; i++) Sim.step(p, 0.1); };

test('new park has an entrance, starter path and starting cash', () => {
  const p = Sim.createPark('Fresh', 1);
  assert.equal(p.cash, START_CASH);
  assert.equal(p.tiles[Sim.idx(Sim.ENTRANCE.x, Sim.ENTRANCE.y)], Sim.TILE.ENTRANCE);
  assert.equal(p.tiles[Sim.idx(Sim.ENTRANCE.x, Sim.ENTRANCE.y - 1)], Sim.TILE.PATH);
  assert.ok(p.objects.length > 50, 'scatters trees');
});

test('building charges cash and blocks overlaps; bulldozing refunds half', () => {
  const p = Sim.createPark('Build', 2);
  for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) Sim.bulldoze(p, x, y);
  const before = p.cash;
  const res = Sim.build(p, 'teacups', 10, 10);
  assert.ok(res.ok);
  assert.equal(p.cash, before - RIDES.teacups.cost);
  assert.equal(Sim.build(p, 'teacups', 11, 11).ok, false);
  assert.equal(Sim.buildPath(p, 10, 10).ok, false, 'cannot path over a ride');
  Sim.bulldoze(p, 11, 11);
  assert.equal(p.cash, before - RIDES.teacups.cost / 2);
  assert.equal(Sim.objectAt(p, 10, 10), null);
});

test('cannot build without enough cash or remove the entrance', () => {
  const p = Sim.createPark('Broke', 3);
  p.cash = 5;
  const r = Sim.buildPath(p, 0, 0);
  assert.equal(r.ok, false);
  assert.equal(Sim.bulldoze(p, Sim.ENTRANCE.x, Sim.ENTRANCE.y).ok, false);
  p.cash = 100;
  Sim.bulldoze(p, 0, 0);
  if (!Sim.objectAt(p, 0, 0)) assert.equal(Sim.buildPath(p, 0, 0).ok, true);
  assert.equal(p.cash, 100 - PATH_COST);
});

test('guests arrive, ride rides, buy food and generate income', () => {
  const p = samplePark();
  run(p, 240);
  const s = Sim.parkStats(p);
  assert.ok(s.guests > 20, `expected guests, got ${s.guests}`);
  assert.ok(p.stats.totalGuests > s.guests - 1);
  const riders = p.objects.filter((o) => o.queue).reduce((n, o) => n + o.stats.riders, 0);
  assert.ok(riders > 50, `expected riders, got ${riders}`);
  const burger = p.objects.find((o) => o.kind === 'burger');
  assert.ok(burger.stats.riders > 0, 'food was sold');
  assert.ok(p.stats.history.length >= 3, 'days were recorded');
  assert.ok(p.stats.history.every((h) => h.income > 0));
  assert.ok(p.objectives.includes('first-ride'));
});

test('mechanics repair broken rides', () => {
  const p = samplePark(11);
  run(p, 5);
  const wheel = p.objects.find((o) => o.kind === 'skywheel');
  wheel.broken = true;
  run(p, 60);
  assert.equal(wheel.broken, false);
});

test('janitors sweep litter', () => {
  const p = samplePark(12);
  const i = Sim.idx(20, 30);
  p.litter[i] = 3;
  run(p, 60);
  assert.equal(p.litter[i], 0);
});

test('expensive tickets drive guests away', () => {
  const p = samplePark(13);
  for (const o of p.objects) if (o.queue) Sim.setPrice(p, o.id, 50);
  run(p, 120);
  const riders = p.objects.filter((o) => o.queue).reduce((n, o) => n + o.stats.riders, 0);
  assert.equal(riders, 0);
});

test('simulation is deterministic for a given seed', () => {
  const a = samplePark(5), b = samplePark(5);
  run(a, 90);
  run(b, 90);
  assert.deepEqual(Sim.serialize(a), Sim.serialize(b));
});

test('serialize/deserialize round-trips and keeps simulating', () => {
  const p = samplePark();
  run(p, 120);
  const json = JSON.parse(JSON.stringify(Sim.serialize(p)));
  const q = Sim.deserialize(json);
  assert.equal(q.objects.length, p.objects.length);
  assert.equal(q.guests.length, p.guests.length);
  assert.equal(Math.round(q.cash), Math.round(p.cash));
  assert.deepEqual(Sim.parkSummary(q), Sim.parkSummary(p));
  run(q, 60);
  assert.ok(q.guests.length > 0);
});

test('deserialize rejects malformed or tampered saves', () => {
  const good = Sim.serialize(Sim.createPark('X', 9));
  assert.throws(() => Sim.deserialize(null));
  assert.throws(() => Sim.deserialize({ ...good, version: 2 }));
  assert.throws(() => Sim.deserialize({ ...good, tiles: 'abc' }));
  assert.throws(() => Sim.deserialize({ ...good, objects: [{ id: 1, kind: 'nuke', x: 0, y: 0 }] }));
  const overlap = structuredClone(good);
  overlap.objects.push({ ...overlap.objects[0], id: 99999 });
  assert.throws(() => Sim.deserialize(overlap));
  const noEntrance = structuredClone(good);
  noEntrance.tiles = noEntrance.tiles.replace('2', '0');
  assert.throws(() => Sim.deserialize(noEntrance));
  // Out-of-range numbers are clamped rather than trusted.
  const p = Sim.deserialize({ ...good, entranceFee: 1e9, rating: 5000 });
  assert.equal(p.entranceFee, 100);
  assert.equal(p.rating, 999);
});

// ---------------------------------------------------------------------------
// Crime & security
// ---------------------------------------------------------------------------

/** Places a criminal guest of `type` on the path at (x, y). */
function plantCriminal(p, type, x = 20, y = 26) {
  run(p, 1);
  const g = p.guests[0] ?? (run(p, 30), p.guests[0]);
  Object.assign(g, { crime: type, crimeT: 0, x, y, nx: x, ny: y, t: 0, state: 'walk', leaving: false, target: null, route: null });
  return g;
}

function crowdAround(p, x, y, except) {
  for (const v of p.guests) {
    if (v === except) continue;
    Object.assign(v, { x, y, nx: x, ny: y, t: 0, state: 'sit', busy: 30, cash: 50 });
  }
}

test('pickpockets steal from nearby guests and lower safety', () => {
  const p = samplePark(21);
  run(p, 60);
  const thief = plantCriminal(p, 'pickpocket');
  crowdAround(p, 20, 26, thief);
  p.time = 0; // daytime
  let tries = 0;
  while (p.stats.crimes === 0 && tries++ < 400) { thief.crimeT = 0; Sim.step(p, 0.1); }
  assert.ok(p.stats.crimes >= 1, 'a theft happened');
  assert.equal(p.incidents.find((i) => i.type !== 'arrest').type, 'theft');
  assert.ok(thief.loot > 0);
  assert.ok(p.safety < 100);
});

test('guards deter crime and arrest identified criminals', () => {
  const quiet = (guards, seed) => {
    const p = samplePark(seed);
    for (let i = 0; i < guards; i++) Sim.hire(p, 'guard');
    run(p, 600);
    return p;
  };
  let unguarded = 0, guarded = 0, arrests = 0;
  for (const seed of [31, 32, 33]) {
    unguarded += quiet(0, seed).stats.crimes;
    const g = quiet(4, seed);
    guarded += g.stats.crimes;
    arrests += g.stats.arrests;
  }
  assert.ok(unguarded > 0, 'crime happens without security');
  assert.ok(guarded < unguarded, `guards reduce crime (${guarded} vs ${unguarded})`);
  assert.ok(arrests > 0, 'guards make arrests');
});

test('arrested robbers return stolen money', () => {
  const p = samplePark(41);
  run(p, 60);
  const robber = plantCriminal(p, 'robber');
  const guard = Sim.hire(p, 'guard').staff;
  const cashBefore = p.cash;
  Object.assign(robber, { loot: 500, heistLoot: true, spotted: true, leaving: true });
  Object.assign(guard, { x: 20, y: 27, nx: 20, ny: 27, t: 0 });
  run(p, 5);
  assert.equal(p.stats.arrests, 1);
  assert.ok(p.cash >= cashBefore + 500 - 200, 'loot recovered (minus any daily costs)');
  assert.equal(p.incidents[0].type, 'arrest');
});

test('assaults injure guests, who seek first aid', () => {
  const p = samplePark(51);
  assert.ok(Sim.build(p, 'firstaid', 21, 25).ok);
  run(p, 60);
  const victim = p.guests.find((g) => g.state === 'walk' && !g.crime);
  victim.injured = true;
  victim.decideIn = 0;
  let healed = false;
  for (let i = 0; i < 1200 && !healed; i++) { Sim.step(p, 0.1); healed = !victim.injured; }
  assert.ok(healed || victim.leaving, 'injured guest either treated or went home');
});

test('crime state survives save/load', () => {
  const p = samplePark(61);
  run(p, 60);
  const g = plantCriminal(p, 'brawler');
  g.spotted = true;
  p.incidents.unshift({ type: 'assault', text: 'x', day: 1 });
  p.safety = 42;
  const q = Sim.deserialize(JSON.parse(JSON.stringify(Sim.serialize(p))));
  assert.equal(q.safety, 42);
  assert.equal(q.incidents[0].type, 'assault');
  const g2 = q.guests.find((x) => x.id === g.id);
  assert.equal(g2.crime, 'brawler');
  assert.equal(g2.spotted, true);
  // Unknown crime types from a tampered save are dropped.
  const data = Sim.serialize(p);
  data.guests[0].crime = 'arson';
  assert.equal(Sim.deserialize(data).guests[0].crime, null);
});
