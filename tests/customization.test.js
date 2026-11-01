import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Sim from '../src/shared/sim.ts';
import { defaultSettings, sanitizeSettings, SETTINGS_SCHEMA, DIFFICULTIES, CLIMATES, EVENTS, GUEST_TYPES, PATH_STYLES } from '../src/shared/options.ts';

const run = (p, seconds) => { for (let i = 0; i < seconds * 10; i++) Sim.step(p, 0.1); };

function openPark(settings = defaultSettings('normal'), seed = 5) {
  const p = Sim.createPark('Custom', seed, settings);
  for (let y = 18; y < 39; y++) for (let x = 10; x < 31; x++) if (Sim.objectAt(p, x, y)) Sim.bulldoze(p, x, y);
  p.cash = 200000;
  for (let x = 14; x <= 26; x++) Sim.buildPath(p, x, 26);
  for (let y = 27; y <= 32; y++) Sim.buildPath(p, 20, y);
  for (const [k, x, y] of [['teacups', 14, 24], ['skywheel', 22, 23], ['burger', 17, 25], ['lemonade', 18, 25], ['restroom', 19, 25]]) {
    assert.ok(Sim.build(p, k, x, y).ok, k);
  }
  return p;
}

test('settings schema: every difficulty and option validates', () => {
  for (const d of Object.keys(DIFFICULTIES)) {
    const s = defaultSettings(d);
    assert.equal(s.difficulty, d);
    for (const def of SETTINGS_SCHEMA) assert.ok(def.key in s, def.key);
  }
  const bad = sanitizeSettings({ crimeRate: 99, climate: 'moon', gore: 'yes', startCash: -5, difficulty: 'impossible' });
  assert.equal(bad.crimeRate, 3);
  assert.equal(bad.climate, 'temperate');
  assert.equal(bad.gore, false, 'non-boolean is not true');
  assert.equal(bad.startCash, 0);
  assert.equal(bad.difficulty, 'normal');
});

test('new park uses its settings: cash, climate flora, seed reproducibility', () => {
  const a = Sim.createPark('A', 123, { ...defaultSettings('hard'), climate: 'desert', treeDensity: 2 });
  const b = Sim.createPark('A', 123, { ...defaultSettings('hard'), climate: 'desert', treeDensity: 2 });
  assert.equal(a.cash, DIFFICULTIES.hard.startCash);
  assert.deepEqual(Sim.serialize(a), Sim.serialize(b), 'same seed + settings = same park');
  const kinds = new Set(a.objects.map((o) => o.kind));
  for (const k of kinds) assert.ok(k in CLIMATES.desert.trees, `${k} grows in the desert`);
  const bare = Sim.createPark('B', 1, { ...defaultSettings(), treeDensity: 0 });
  assert.equal(bare.objects.length, 0);
});

test('v1 saves migrate to v2 with Normal settings', () => {
  const p = openPark();
  const v1 = Sim.serialize(p);
  v1.version = 1;
  for (const k of ['settings', 'weather', 'buzz', 'effects', 'eventLog', 'pathStyles', 'uniforms', 'seed']) delete v1[k];
  const q = Sim.deserialize(v1);
  assert.equal(q.version, Sim.SAVE_VERSION);
  assert.deepEqual(q.settings, defaultSettings('normal'));
  assert.equal(q.pathStyles.length, p.tiles.length);
});

test('crime, drugs, Pandemonium, gore and executions can be switched off', () => {
  const p = openPark({ ...defaultSettings(), crimeRate: 0, drugs: false, pandemonium: 'off', gore: false, executions: false });
  p.pandemonium.nextRaidDay = 1;
  run(p, 400);
  assert.equal(p.guests.filter((g) => g.crime).length, 0, 'no criminals');
  assert.equal(p.pandemonium.raids, 0, 'no raids');
  assert.equal(Sim.build(p, 'retribution', 22, 30).ok, false);
  p.custody.push({ id: 999, name: 'X', kind: 'robber', gang: null, record: { theft: 0, assault: 0, robbery: 1, drugs: 0, homicide: 0, stolen: 0 }, by: 'x', day: 1 });
  assert.equal(Sim.sentence(p, 999, 'execute').ok, false);
  // Gore off: violence leaves no blood.
  const v = p.guests[0];
  const i = Sim.idx(v.x, v.y);
  Sim.setSetting(p, 'crimeRate', 1);
  const thug = p.guests[1];
  Object.assign(thug, { crime: 'brawler', crimeT: 0 });
  run(p, 30);
  assert.equal(p.stains.reduce((a, b) => a + b, 0), 0);
  assert.ok(i >= 0);
});

test('live settings change mid-game; fixed ones refuse', () => {
  const p = openPark();
  assert.equal(Sim.setSetting(p, 'guestRate', 2.5).ok, true);
  assert.equal(p.settings.guestRate, 2.5);
  assert.equal(Sim.setSetting(p, 'guestRate', 50).value, 3, 'clamped');
  assert.equal(Sim.setSetting(p, 'climate', 'alpine').ok, false);
  assert.equal(Sim.setSetting(p, 'nonsense', 1).ok, false);
});

test('guest arrivals scale with the guestRate setting', () => {
  const count = (rate) => {
    const p = openPark({ ...defaultSettings(), guestRate: rate, weather: false, events: false, crimeRate: 0 });
    run(p, 240);
    return p.stats.totalGuests;
  };
  assert.ok(count(3) > count(0.25) * 3);
});

test('guest types vary and drive behaviour', () => {
  const p = openPark({ ...defaultSettings(), guestRate: 3 });
  const types = new Set();
  for (let i = 0; i < 3000; i++) { Sim.step(p, 0.1); for (const g of p.guests) types.add(g.type); }
  assert.ok(types.size >= 4, `saw ${[...types]}`);
  for (const g of p.guests.filter((x) => x.type === 'senior')) assert.ok(g.pref <= GUEST_TYPES.senior.pref[1]);
  for (const g of p.guests.filter((x) => x.type === 'thrill')) assert.ok(g.pref >= GUEST_TYPES.thrill.pref[0]);
});

test('weather rolls by climate and affects guests', () => {
  const p = openPark({ ...defaultSettings(), climate: 'alpine' });
  const seen = new Set();
  for (let d = 0; d < 40; d++) { run(p, 60); seen.add(p.weather.type); }
  for (const w of seen) assert.ok(w in CLIMATES.alpine.weather, `${w} in alpine`);
  assert.ok(seen.size >= 2);
  const off = openPark({ ...defaultSettings(), weather: false });
  off.weather.type = 'storm';
  assert.equal(Sim.weatherOf(off).label, 'Sunny', 'weather off means sunny');
});

test('umbrella stands sell in the rain', () => {
  const p = openPark({ ...defaultSettings(), crimeRate: 0, events: false, guestRate: 2 });
  assert.ok(Sim.build(p, 'umbrella', 21, 25).ok);
  Sim.hire(p, 'janitor');
  const stall = p.objects.find((o) => o.kind === 'umbrella');
  for (let i = 0; i < 3000; i++) { p.weather = { type: 'rain', day: Sim.day(p) }; Sim.step(p, 0.1); }
  assert.ok(stall.stats.riders > 0, 'umbrellas sold');
  assert.ok(p.guests.some((g) => g.umbrella));
});

test('every random event runs', () => {
  const p = openPark();
  p.fallen.push({ name: 'Officer', role: 'squad', by: 'Mochi', day: 1, payout: 5000 });
  p.pandemonium.executions = 1;
  p.weather.type = 'heatwave';
  for (const ev of EVENTS) assert.equal(Sim.triggerEvent(p, ev.id), true, ev.id);
  assert.ok(p.eventLog.length >= 10);
  assert.equal(Sim.triggerEvent(p, 'alienInvasion'), false);
});

test('staff traits change stats and wages', () => {
  const p = openPark();
  Sim.build(p, 'securityhq', 21, 27);
  const hires = [];
  for (let i = 0; i < 40; i++) hires.push(Sim.hire(p, i % 2 ? 'squad' : 'guard').staff);
  assert.ok(hires.some((s) => s.traits.length > 0));
  const tough = hires.find((s) => s.traits.includes('tough'));
  if (tough) assert.equal(tough.maxHp, ({ guard: 5, squad: 6 })[tough.role] + 2 + (tough.traits.includes('veteran') ? 1 : 0));
  const lazy = hires.find((s) => s.traits.includes('lazy'));
  if (lazy) assert.ok(Sim.wageOf(p, lazy) < Math.round(({ guard: 55, squad: 90 })[lazy.role]));
  for (const s of hires) {
    assert.ok(!(s.traits.includes('speedy') && s.traits.includes('lazy')), 'no clashing traits');
  }
  Sim.setSetting(p, 'wages', 2);
  const plain = hires.find((s) => !s.traits.length);
  assert.equal(Sim.wageOf(p, plain), ({ guard: 55, squad: 90 })[plain.role] * 2);
});

test('rides age and can be refurbished', () => {
  const p = openPark();
  const cups = p.objects.find((o) => o.kind === 'teacups');
  cups.builtDay = 1;
  p.time = 40 * 60;
  assert.ok(Sim.ageLoss(p, cups) > 0.04);
  const cash = p.cash;
  assert.equal(Sim.refurbish(p, cups.id).ok, true);
  assert.equal(Sim.ageLoss(p, cups), 0);
  assert.equal(p.cash, cash - Sim.refurbishCost(cups));
  Sim.setSetting(p, 'ageing', false);
  cups.builtDay = 1;
  assert.equal(Sim.ageLoss(p, cups), 0);
});

test('names, paint, path styles and uniforms persist', () => {
  const p = openPark();
  const cups = p.objects.find((o) => o.kind === 'teacups');
  Sim.renameObject(p, cups.id, 'Spin Cycle');
  assert.equal(Sim.rideDef(cups).name, 'Spin Cycle');
  assert.equal(Sim.setColor(p, cups.id, 'color', '#ABCDEF').ok, true);
  assert.equal(Sim.setColor(p, cups.id, 'color', 'red').ok, false);
  assert.ok(Sim.buildPath(p, 12, 30, 3).ok);
  assert.ok(Sim.buildPath(p, 14, 26, 2).repainted);
  Sim.setUniform(p, 'guard', '#00ff00');
  Sim.setUniform(p, 'guard', 'nope');
  const q = Sim.deserialize(JSON.parse(JSON.stringify(Sim.serialize(p))));
  const c2 = q.objects.find((o) => o.id === cups.id);
  assert.equal(Sim.rideDef(c2).name, 'Spin Cycle');
  assert.equal(c2.color, '#abcdef');
  assert.equal(q.pathStyles[Sim.idx(12, 30)], 3);
  assert.equal(q.pathStyles[Sim.idx(14, 26)], 2);
  assert.equal(q.uniforms.guard, '#00ff00');
  assert.ok(PATH_STYLES.length >= 5);
  Sim.renameObject(p, cups.id, '');
  assert.equal(Sim.rideDef(cups).name, 'Whirly Teacups', 'empty name resets');
});

test('coaster designs export, validate and import', () => {
  const p = openPark();
  for (let y = 4; y < 18; y++) for (let x = 2; x < 38; x++) if (Sim.objectAt(p, x, y)) Sim.bulldoze(p, x, y);
  const { obj } = Sim.startCoaster(p, 6, 10, 0);
  const L = (n, t) => Array(n).fill(t);
  for (const t of ['straight', ...L(5, 'lift'), 'straight', 'down', 'steepDown', 'steepDown', 'down', 'brake']) Sim.addPiece(p, obj.id, t);
  for (let h = obj._layout.cursor.h; h > 0; h--) Sim.addPiece(p, obj.id, 'down');
  Sim.addPiece(p, obj.id, 'wideLeft');
  Sim.addPiece(p, obj.id, 'wideLeft');
  const base = obj.track.pieces.length;
  outer: for (let k = 0; k < 30; k++) for (let m = 0; m < 10; m++) {
    for (const t of [...L(k, 'straight'), 'wideLeft', ...L(m, 'straight'), 'wideLeft']) if (!Sim.addPiece(p, obj.id, t).ok) break;
    if (Sim.coasterComplete(obj)) break outer;
    while (obj.track.pieces.length > base) Sim.removePiece(p, obj.id);
  }
  assert.ok(Sim.coasterComplete(obj));
  Sim.setColor(p, obj.id, 'trainColor', '#112233');
  Sim.setCoasterCars(p, obj.id, 6);
  assert.equal(Sim.rideDef(obj).capacity, 24);
  const code = Sim.exportDesign(obj);
  assert.match(code, /^RCM1:/);
  const parsed = Sim.parseDesign(code);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.design.pieces, obj.track.pieces);
  assert.equal(Sim.parseDesign('RCM1:not-base64!!').ok, false);
  assert.equal(Sim.parseDesign('hello').ok, false);

  // Import a copy two rows down; it should be identical and cost the design price.
  for (let y = 18; y < 32; y++) for (let x = 2; x < 38; x++) { const o = Sim.objectAt(p, x, y); if (o) Sim.bulldoze(p, x, y); }
  for (let y = 18; y < 40; y++) for (let x = 0; x < 40; x++) { const i = Sim.idx(x, y); if (p.tiles[i] === Sim.TILE.PATH) Sim.bulldoze(p, x, y); }
  const imp = Sim.importDesign(p, 6, 26, 0, code);
  assert.equal(imp.ok, true, imp.reason);
  assert.deepEqual(imp.obj.track.pieces, obj.track.pieces);
  assert.equal(imp.obj.trainColor, '#112233');
  assert.equal(imp.obj.cars, 6);
  // Blocked placement rolls back cleanly.
  const cash = p.cash;
  const blocked = Sim.importDesign(p, 6, 10, 0, code);
  assert.equal(blocked.ok, false);
  assert.equal(p.cash, cash, 'refunded');
});
