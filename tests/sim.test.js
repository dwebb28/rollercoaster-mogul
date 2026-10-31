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
  let repaired = false;
  for (let i = 0; i < 600 && !repaired; i++) { Sim.step(p, 0.1); repaired = !wheel.broken; }
  assert.ok(repaired, 'a mechanic fixed it');
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
  assert.throws(() => Sim.deserialize({ ...good, version: 99 }));
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
    p.pandemonium.nextRaidDay = Infinity; // isolate ordinary crime from Pandemonium raids
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

// ---------------------------------------------------------------------------
// Pandemonium
// ---------------------------------------------------------------------------

function securePark(seed, officers) {
  const p = samplePark(seed);
  p.cash = 100000;
  assert.ok(Sim.build(p, 'securityhq', 21, 27).ok);
  assert.ok(Sim.build(p, 'retribution', 21, 30).ok);
  for (let i = 0; i < officers; i++) assert.ok(Sim.hire(p, 'squad').ok);
  run(p, 60);
  return p;
}

const runRaid = (p) => { for (let i = 0; i < 2000 && p.raid; i++) Sim.step(p, 0.1); };

test('the Hot Dog Squad requires a Security HQ', () => {
  const p = samplePark(70);
  const res = Sim.hire(p, 'squad');
  assert.equal(res.ok, false);
  assert.match(res.reason, /Security HQ/);
});

test('an undefended park loses money to Pandemonium and they escape', () => {
  const p = securePark(71, 0);
  const cash = p.cash;
  assert.ok(Sim.startRaid(p));
  assert.ok(Sim.activePandas(p).length >= 4);
  runRaid(p);
  assert.equal(p.raid, null);
  assert.ok(p.pandemonium.escaped > 0);
  assert.equal(p.pandemonium.defeated, 0);
  assert.ok(p.cash < cash);
  assert.equal(p.custody.length, 0);
});

test('the squad shoots down the crew, recovers loot and takes prisoners', () => {
  const p = securePark(72, 4);
  Sim.startRaid(p);
  const size = Sim.activePandas(p).length;
  runRaid(p);
  assert.equal(p.pandemonium.defeated, 1);
  assert.equal(p.pandemonium.escaped, 0);
  assert.equal(p.custody.length, size, 'captured raiders await sentencing');
  assert.ok(p.custody.every((c) => c.kind === 'panda' && c.record.robbery + c.record.assault >= 0));
  assert.ok(p.objectives.includes('pandemonium'));
});

test('public execution consumes prisoners, entertains guests and restores safety', () => {
  const p = securePark(73, 4);
  Sim.startRaid(p);
  runRaid(p);
  const rig = p.objects.find((o) => o.kind === 'retribution');
  const prisoners = p.custody.length;
  p.safety = 40;
  for (const c of [...p.custody]) assert.equal(Sim.sentence(p, c.id, 'execute', 'water').ok, true);
  assert.equal(p.custody.length, 0);
  assert.equal(rig.pit, 'water');
  assert.ok(rig.show, 'first sentence starts the show');
  assert.equal(Sim.execute(p, rig.id, 'fire').ok, false, 'one show at a time');
  run(p, prisoners * (4 + 2) + 10);
  assert.equal(rig.show, null);
  assert.equal(p.pandemonium.executions, prisoners);
  assert.ok(p.safety > 90, `safety restored (${p.safety})`);
  assert.ok(p.objectives.includes('justice'));
  assert.equal(p.incidents.find((i) => i.type === 'execution').type, 'execution');
});

test('blood stains upset guests and janitors scrub them', () => {
  const p = samplePark(74);
  const i = Sim.idx(20, 29);
  p.stains[i] = 3;
  run(p, 60);
  assert.equal(p.stains[i], 0);
});

test('raids, prisoners and stains survive save/load', () => {
  const p = securePark(75, 0);
  Sim.startRaid(p);
  run(p, 5);
  p.captives.push({ name: 'Mochi' });
  p.stains[Sim.idx(20, 30)] = 2;
  const q = Sim.deserialize(JSON.parse(JSON.stringify(Sim.serialize(p))));
  assert.ok(q.raid);
  assert.equal(Sim.activePandas(q).length, Sim.activePandas(p).length);
  assert.equal(q.captives[0].name, 'Mochi');
  assert.equal(q.stains[Sim.idx(20, 30)], 2);
  assert.equal(q.pandemonium.raids, 1);
});

// ---------------------------------------------------------------------------
// Sentencing, drugs, gangs, lockdown
// ---------------------------------------------------------------------------

test('arrested suspects keep their record and go into custody for sentencing', () => {
  const p = samplePark(81);
  run(p, 60);
  const thief = plantCriminal(p, 'pickpocket');
  crowdAround(p, 20, 26, thief);
  const guard = Sim.hire(p, 'guard').staff;
  Object.assign(guard, { x: 20, y: 27, nx: 20, ny: 27, t: 0 });
  let tries = 0;
  while (!p.custody.length && tries++ < 600) { if (thief.crimeT > 1) thief.crimeT = 0; Sim.step(p, 0.1); }
  assert.equal(p.custody.length, 1);
  const c = p.custody[0];
  assert.equal(c.name, thief.name);
  assert.ok(c.record.theft >= 1);
  assert.ok(Sim.knownSuspects(p).every((g) => g.id !== thief.id), 'no longer at large');
});

test('sentencing: release, fine, and execute', () => {
  const p = samplePark(82);
  p.cash = 100000;
  const mk = (id) => ({ id, name: `S${id}`, kind: 'robber', gang: null, by: 'x', day: 1,
    record: { theft: 1, assault: 0, robbery: 2, drugs: 0, homicide: 0, stolen: 400 } });
  p.custody.push(mk(9001), mk(9002), mk(9003));
  const safety = p.safety;
  assert.equal(Sim.sentence(p, 9001, 'release').ok, true);
  assert.ok(p.safety < safety || safety === 0);
  const cash = p.cash;
  const fine = Sim.fineFor(mk(0));
  assert.equal(fine, 150 + 3 * 75 + 600);
  assert.equal(Sim.sentence(p, 9002, 'fine').fine, fine);
  assert.equal(p.cash, cash + fine);
  assert.equal(Sim.sentence(p, 9003, 'execute').ok, false, 'needs a rig');
  assert.equal(p.custody.length, 1, 'still in custody after a refused execution');
  assert.ok(Sim.build(p, 'retribution', 21, 30).ok);
  assert.equal(Sim.sentence(p, 9003, 'execute', 'fire').ok, true);
  run(p, 10);
  assert.equal(p.pandemonium.executions, 1);
  assert.equal(p.custody.length, 0);
});

test('dealers sell drugs; high guests cannot find the exit and may join gangs', () => {
  const p = samplePark(83);
  run(p, 60);
  const dealer = plantCriminal(p, 'dealer');
  dealer.gang = 'Teacup Triad';
  crowdAround(p, 20, 26, dealer);
  for (const v of p.guests) if (v !== dealer) v.happy = 0; // miserable guests always say yes
  let tries = 0;
  while (!p.stats.drugDeals && tries++ < 600) { if (dealer.crimeT > 1) dealer.crimeT = 0; Sim.step(p, 0.1); }
  assert.ok(p.stats.drugDeals >= 1);
  assert.ok(dealer.record.drugs >= 1);
  const high = p.guests.find((g) => g.high > 0);
  assert.ok(high, 'someone is high');

  // A high guest who wants to leave wanders instead of heading for the gate.
  Object.assign(high, { leaving: true, route: null, state: 'walk', busy: 0, high: 30 });
  run(p, 20);
  assert.ok(p.guests.includes(high) && high.leaving, 'still lost in the park');

  // Coming down can recruit them into a gang.
  let recruited = 0;
  for (let i = 0; i < 40; i++) {
    const g = p.guests.find((x) => !x.crime && x.state === 'walk');
    if (!g) break;
    g.high = 0.05;
    Sim.step(p, 0.1);
    if (g.crime) { recruited++; assert.ok(g.gang); }
  }
  assert.ok(recruited > 0, 'some guests joined gangs');
});

test('corrupt vendors can be exposed and replaced', () => {
  const p = samplePark(84);
  const lemon = p.objects.find((o) => o.kind === 'lemonade');
  Object.assign(lemon, { corrupt: true, exposed: false, deals: 0 });
  Sim.build(p, 'camera', 18, 27);
  for (const g of p.guests) g.happy = 0;
  run(p, 300);
  assert.ok(lemon.deals > 0, 'vendor sold drugs');
  const res = Sim.replaceVendor(p, lemon.id);
  assert.equal(res.wasCorrupt, true);
  assert.equal(lemon.corrupt, false);
});

test('barbed wire lockdown keeps everyone inside', () => {
  const p = samplePark(85);
  run(p, 60);
  assert.equal(Sim.setLocked(p, true).ok, false, 'needs the fence');
  p.cash = 100000;
  assert.equal(Sim.installFence(p).ok, true);
  assert.equal(Sim.setLocked(p, true).ok, true);
  const before = new Set(p.guests.map((g) => g.id));
  for (const g of p.guests) { g.leaving = true; g.route = null; }
  const total = p.stats.totalGuests;
  run(p, 60);
  assert.equal(p.stats.totalGuests, total, 'nobody new gets in');
  assert.ok([...before].every((id) => p.guests.some((g) => g.id === id)), 'nobody gets out');
  Sim.setLocked(p, false);
  run(p, 60);
  assert.ok([...before].some((id) => !p.guests.some((g) => g.id === id)), 'guests leave once unlocked');
  const q = Sim.deserialize(JSON.parse(JSON.stringify(Sim.serialize(p))));
  assert.equal(q.fence, true);
});

test('pandas fight back but are weaker than the squad on average', async () => {
  const { PANDEMONIUM, STAFF } = await import('../public/js/catalog.js');
  const avg = ([a, b]) => (a + b) / 2;
  const pandaDps = avg(PANDEMONIUM.pandaAccuracy) / PANDEMONIUM.throwCooldown;
  const squadDps = avg(STAFF.squad.accuracy) / PANDEMONIUM.shotCooldown;
  assert.ok(pandaDps < squadDps, 'pandas hit less often');
  assert.ok(avg(PANDEMONIUM.hp) < STAFF.squad.hp, 'pandas have less health');

  // A lone officer against a full crew gets knocked out at some point.
  const p = securePark(91, 1);
  p.pandemonium.nextRaidDay = Infinity;
  Sim.startRaid(p);
  let knocked = false;
  for (let i = 0; i < 2000 && p.raid; i++) {
    Sim.step(p, 0.1);
    if (p.staff.some((s) => s.role === 'squad' && s.down > 0) || p.fallen.length) knocked = true;
  }
  assert.ok(knocked, 'the officer was knocked out (or killed)');
  const officer = p.staff.find((s) => s.role === 'squad') || Sim.hire(p, 'squad').staff;
  for (const g of p.guests) if (g.crime === 'panda') g.gone = true; // end the fight
  Object.assign(officer, { down: 1, hp: 0 });
  run(p, 2);
  assert.equal(officer.down, 0);
  assert.equal(officer.hp, officer.maxHp, 'recovers to full health');
});

test('officers killed by pandas are insured, buried and memorialised', async () => {
  const { PANDEMONIUM } = await import('../public/js/catalog.js');
  const p = securePark(95, 6);
  p.pandemonium.nextRaidDay = Infinity;
  // Fight raids until someone falls.
  for (let r = 0; r < 12 && !p.fallen.length; r++) {
    Sim.startRaid(p);
    for (let i = 0; i < 2000 && p.raid; i++) {
      for (const g of p.guests) if (g.crime === 'panda') g.acc = 1; // deadly aim speeds this up
      Sim.step(p, 0.1);
    }
    while (Sim.hire(p, 'squad').ok && p.staff.filter((s) => s.role === 'squad').length < 6);
  }
  assert.ok(p.fallen.length > 0, 'an officer fell');
  const f = p.fallen[0];
  assert.equal(f.payout, PANDEMONIUM.lifeInsurance[f.role]);
  assert.ok(!p.staff.some((s) => s.name === f.name && s.role === f.role && s.down === 0 && s.hp <= 0));
  const memorial = p.objects.find((o) => o.kind === 'memorial');
  assert.ok(memorial, 'a memorial was placed');
  assert.equal(memorial.graves, p.fallen.length);
  assert.equal(Sim.bulldoze(p, memorial.x, memorial.y).ok, false, 'memorial is protected');
  const q = Sim.deserialize(JSON.parse(JSON.stringify(Sim.serialize(p))));
  assert.equal(q.fallen.length, p.fallen.length);
  assert.equal(q.objects.find((o) => o.kind === 'memorial').graves, memorial.graves);
});
