// The WASM core must match the original TypeScript algorithms exactly:
// the simulation is seeded and deterministic, so any difference in route
// choice would change every park's history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { core, syncTiles } from '../src/shared/core.ts';
import { buildStressPark } from '../src/shared/stress.ts';
import { GRID } from '../src/shared/catalog.ts';

// The pre-WASM TypeScript BFS, kept verbatim as the reference.
function referenceBfs(tiles, start, allowEntrance) {
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
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= GRID || y >= GRID) continue;
      const i = y * GRID + x;
      if (dist[i] >= 0 || !(tiles[i] === 1 || tiles[i] === 2)) continue;
      if (!allowEntrance && tiles[i] === 2) continue;
      dist[i] = dist[c] + 1;
      prev[i] = c;
      queue[tail++] = i;
    }
  }
  return { dist, prev };
}

test('WASM bfs matches the TypeScript reference from every tile', () => {
  const park = buildStressPark(200, 3);
  syncTiles(park, true);
  for (let start = 0; start < GRID * GRID; start++) {
    for (const allow of [false, true]) {
      const ref = referenceBfs(park.tiles, start, allow);
      core.bfs(start, allow);
      assert.deepEqual(core.dist, ref.dist, `dist from ${start} allow=${allow}`);
      assert.deepEqual(core.prev, ref.prev, `prev from ${start} allow=${allow}`);
    }
  }
});

test('tile edits reach the core', async () => {
  const { createPark, buildPath, bulldoze, step } = await import('../src/shared/sim.ts');
  const park = createPark('Sync', 1);
  step(park, 0.1);
  for (let y = 9; y <= 11; y++) for (let x = 9; x <= 11; x++) bulldoze(park, x, y); // clear any scenery
  const i = 10 * GRID + 10;
  buildPath(park, 10, 10);
  assert.equal(core.tiles[i], 1);
  bulldoze(park, 10, 10);
  assert.equal(core.tiles[i], 0);
});

test('walkers keep positions in core memory and behave like plain objects', async () => {
  const { freeWalker, walkerSlotsInUse, plainWalker } = await import('../src/shared/core.ts');
  const { StaffWalker } = await import('../src/shared/walkers.ts');
  const walker = (f) => new StaffWalker(f);
  const before = walkerSlotsInUse();
  const a = walker({ id: 1, name: 'A', x: 3, y: 4, nx: 3, ny: 5, lx: 3, ly: 4, t: 0.25, route: null });
  assert.equal(walkerSlotsInUse(), before + 1);
  const plain = plainWalker(a);
  assert.deepEqual(
    Object.fromEntries(Object.entries(plain).filter(([, v]) => v !== undefined)),
    { x: 3, y: 4, nx: 3, ny: 5, lx: 3, ly: 4, t: 0.25, id: 1, name: 'A' });
  assert.equal(plain._w, undefined);
  assert.equal(JSON.parse(JSON.stringify(a)).ny, 5);
  assert.equal(structuredClone(plainWalker(a)).t, 0.25);
  a.x = 9;
  assert.equal(a.x, 9);
  freeWalker(a);
  assert.equal(walkerSlotsInUse(), before);
  // A reused slot starts clean.
  const b = walker({ id: 2, name: 'B', x: 1, y: 1, nx: 1, ny: 1, route: null });
  assert.equal(b.t, 0);
  assert.equal(b.lx, 0);
  freeWalker(b);
});

test('the walker table grows past its first allocation without losing data', async () => {
  const { freeWalker } = await import('../src/shared/core.ts');
  const { StaffWalker } = await import('../src/shared/walkers.ts');
  const walker = (f) => new StaffWalker(f);
  const list = [];
  for (let i = 0; i < 5000; i++) list.push(walker({ id: i, name: '', x: i % 40, y: (i / 40) | 0, nx: 0, ny: 0, lx: 0, ly: 0, t: i / 5000, route: null }));
  for (let i = 0; i < 5000; i++) {
    assert.equal(list[i].x, i % 40);
    assert.equal(list[i].t, i / 5000);
  }
  // Grid views survive memory growth too.
  assert.equal(core.tiles.length, GRID * GRID);
  for (const w of list) freeWalker(w);
});

test('guests leaving the park give their slots back', async () => {
  const { walkerSlotsInUse } = await import('../src/shared/core.ts');
  const Sim = await import('../src/shared/sim.ts');
  const park = buildStressPark(100, 9);
  const live = () => park.guests.length + park.staff.length;
  const base = walkerSlotsInUse() - live();
  for (let i = 0; i < 3000; i++) Sim.step(park, 0.1);
  // <= rather than ===: the GC may reclaim other tests' dropped walkers meanwhile.
  assert.ok(walkerSlotsInUse() - base <= live(), 'slots leaked by departed guests');
});

// The pre-WASM TypeScript mulberry32, kept verbatim as the reference.
function referenceRand(park) {
  park.rngState = (park.rngState + 0x6d2b79f5) >>> 0;
  let t = park.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

test('WASM mulberry32 matches the TypeScript RNG bit for bit', () => {
  for (const seed of [0, 1, 42, 0x7fffffff, 0x80000000, 0xffffffff, 123456789]) {
    const js = { rngState: seed }, wasm = { rngState: seed };
    for (let i = 0; i < 20000; i++) {
      assert.equal(core.rand(wasm), referenceRand(js));
      assert.equal(wasm.rngState, js.rngState);
    }
  }
});

test('routes live in the core and keep JS null-vs-empty semantics', async () => {
  const { StaffWalker } = await import('../src/shared/walkers.ts');
  const { freeWalker } = await import('../src/shared/core.ts');
  const a = new StaffWalker({ id: 1, name: 'R', x: 0, y: 0, nx: 0, ny: 0 });
  assert.equal(a.route, null);
  a.route = [5, 6, 7];
  assert.deepEqual(a.route, [5, 6, 7]);
  assert.equal(core.routeLen(a._w), 3);
  a.route = [];
  assert.deepEqual(a.route, [], 'an empty route is still a route');
  assert.equal(core.routeLen(a._w), 0);
  a.route = null;
  assert.equal(core.routeLen(a._w), -1);
  a.route = [1, 2];
  freeWalker(a);
  const b = new StaffWalker({ id: 2, name: 'S', x: 0, y: 0, nx: 0, ny: 0 });
  assert.equal(b.route, null, 'a reused slot starts without a route');
  freeWalker(b);
  // Freed walkers are ignored by the core rather than crashing it.
  assert.equal(core.routeLen(a._w), -1);
  core.clearRoute(a._w);
});

// The pre-WASM TypeScript needs tick (from updateGuest), kept as the
// reference. `think` is inlined: quiet while thinking, else 12 s + log roll.
function referenceNeeds(g, rng, dt, pace, T, W, umbrella, walking) {
  const said = [];
  const think = (code) => {
    if (g.thoughtT > 0) return;
    g.thoughtT = 12;
    said.push(code | (referenceRand(rng) < 0.3 ? 0x100 : 0));
  };
  g.timeIn += dt;
  g.thoughtT -= dt;
  g.hunger = Math.min(100, g.hunger + 0.42 * T.hunger * dt * pace);
  g.thirst = Math.min(100, g.thirst + 0.5 * W.thirst * dt * pace);
  g.bladder = Math.min(100, g.bladder + 0.28 * dt * pace);
  g.energy = Math.max(0, g.energy - 0.18 * T.energy * dt * pace);
  g.nausea = Math.max(0, g.nausea - 1.2 * dt);
  let drain = 0;
  if (g.hunger > 85) { drain += 0.5; if (referenceRand(rng) < 0.02) think(1); }
  if (g.thirst > 85) { drain += 0.5; if (referenceRand(rng) < 0.02) think(2); }
  if (g.bladder > 90) { drain += 0.8; if (referenceRand(rng) < 0.02) think(3); }
  if (g.nausea > 60) { drain += 0.4; if (referenceRand(rng) < 0.02) think(4); }
  if (g.energy < 20) drain += 0.2;
  if (W.happyDrain && !(W.umbrella && umbrella) && walking) {
    drain += W.happyDrain;
    if (referenceRand(rng) < 0.004) think(5);
  }
  g.happy = Math.max(0, Math.min(100, g.happy - drain * dt));
  return said[0] ?? 0;
}

test('WASM guest needs match the TypeScript reference, thoughts and RNG included', async () => {
  const { GuestWalker } = await import('../src/shared/walkers.ts');
  const { freeWalker } = await import('../src/shared/core.ts');
  const { GUEST_TYPES, WEATHER } = await import('../src/shared/options.ts');
  const types = Object.values(GUEST_TYPES), weathers = Object.values(WEATHER);
  const gen = { rngState: 99 };
  const fields = ['happy', 'hunger', 'thirst', 'bladder', 'energy', 'nausea', 'thoughtT', 'timeIn'];
  let thoughts = 0;
  for (let n = 0; n < 300; n++) {
    const start = Object.fromEntries(fields.map((f) => [f, referenceRand(gen) * 100]));
    start.thoughtT = referenceRand(gen) < 0.5 ? 0 : start.thoughtT / 10;
    const ref = { ...start };
    const g = new GuestWalker({ id: n, name: 'N', ...start });
    const js = { rngState: n * 7919 }, wasm = { rngState: n * 7919 };
    const T = types[n % types.length], W = weathers[n % weathers.length];
    const umbrella = n % 3 === 0, walking = n % 4 !== 0, pace = n % 5 === 0 ? 0.3 : 1;
    for (let k = 0; k < 400; k++) {
      const dt = k % 7 === 0 ? 0.25 : 0.1;
      const drainIn = W.happyDrain && !(W.umbrella && umbrella) && walking ? W.happyDrain : 0;
      const a = referenceNeeds(ref, js, dt, pace, T, W, umbrella, walking);
      const b = core.guestNeeds(g._w, dt, pace, T.hunger, T.energy, W.thirst, drainIn, wasm);
      assert.equal(b, a, `thought for guest ${n} tick ${k}`);
      if (a) thoughts++;
      assert.equal(wasm.rngState, js.rngState, `rng for guest ${n} tick ${k}`);
      for (const f of fields) assert.equal(g[f], ref[f], `${f} for guest ${n} tick ${k}`);
    }
    freeWalker(g);
  }
  assert.ok(thoughts > 50, `the test should exercise thoughts (got ${thoughts})`);
});

test('WASM scenery beauty matches the TypeScript loop on every tile, after edits too', async () => {
  const Sim = await import('../src/shared/sim.ts');
  const { SCENERY } = await import('../src/shared/catalog.ts');
  const { syncBeauty } = await import('../src/shared/core.ts');
  const park = Sim.createPark('Beauty', 1234);
  const reference = (x, y) => {
    let b = 0;
    for (let yy = y - 2; yy <= y + 2; yy++) for (let xx = x - 2; xx <= x + 2; xx++) {
      const o = Sim.objectAt(park, xx, yy);
      if (o && SCENERY[o.kind]) b += SCENERY[o.kind].beauty;
    }
    return b;
  };
  const check = (label) => {
    syncBeauty(park, park._objGen, (i) => { const o = park._byId.get(park._objAt[i]); return o ? SCENERY[o.kind]?.beauty ?? 0 : 0; });
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) assert.equal(core.beautyNear(x, y), reference(x, y), `${label} at ${x},${y}`);
  };
  check('new park');
  park.cash = 1e6;
  assert.ok(Sim.build(park, 'fountain', 5, 5).ok);
  assert.ok(Sim.build(park, 'statue', 0, 0).ok || Sim.build(park, 'statue', 1, 1).ok);
  check('after building');
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) Sim.bulldoze(park, x, y);
  check('after bulldozing');
});
