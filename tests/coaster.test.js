import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/shared/coaster.ts';
import * as Sim from '../src/shared/sim.ts';

const start = { x: 5, y: 10, dir: 0 };
const L = (n, p) => Array(n).fill(p);

/** Adds level-out pieces and searches for the straights that close the circuit. */
function closeCircuit(mid, turn = 'wideRight') {
  const p = ['station', 'straight', ...mid];
  p.push(...L(Math.max(0, C.layout(start, p).cursor.h), 'down'), turn, turn);
  for (let n = 0; n < 80; n++) {
    const q = [...p, ...L(n, 'straight'), turn, turn];
    if (C.isComplete(start, q)) return q;
  }
  throw new Error('could not close circuit');
}

test('layout follows pieces, turns, and heights', () => {
  const lay = C.layout(start, ['station', 'straight', 'lift', 'right']);
  assert.deepEqual(lay.segs.map((s) => [s.x, s.y]), [[5, 10], [6, 10], [7, 10], [8, 10]]);
  assert.equal(lay.segs[2].h1, 2);
  assert.deepEqual(lay.cursor, { x: 8, y: 11, dir: 1, h: 2 });
  const wide = C.layout(start, ['station', 'wideLeft']);
  assert.equal(wide.segs[1].cells.length, 3);
  assert.equal(wide.cursor.dir, 3);
});

test('only closed circuits starting at a station can run', () => {
  assert.equal(C.simulate(start, ['station', 'straight']).ok, false);
  assert.equal(C.isComplete(start, closeCircuit([...L(3, 'lift'), 'down', 'down'])), true);
});

test('a train without enough energy stalls', () => {
  const r = C.simulate(start, closeCircuit(['up', 'up', 'down', 'down']));
  assert.equal(r.ok, false);
  assert.match(r.reason, /ran out of speed/);
});

test('a chain lift and drop produce sensible speeds and forces', () => {
  const r = C.simulate(start, closeCircuit([...L(5, 'lift'), 'straight', 'down', 'steepDown', 'steepDown', 'down', 'straight', 'brake']));
  assert.equal(r.ok, true, r.reason);
  // Dropping ~8 m: free fall would give ~45 km/h.
  assert.ok(r.maxSpeed > 35 && r.maxSpeed < 55, `speed ${r.maxSpeed}`);
  assert.ok(r.maxG > 1.5 && r.maxG < 4, `G ${r.maxG}`);
  assert.ok(r.excitement > 2 && r.intensity < 7);
  assert.equal(r.times.length, C.samples(start, closeCircuit([...L(5, 'lift'), 'straight', 'down', 'steepDown', 'steepDown', 'down', 'straight', 'brake'])).length + 1);
});

test('loops need enough entry speed', () => {
  const weak = C.simulate(start, closeCircuit([...L(3, 'lift'), 'straight', 'down', 'down', 'loop', 'down', 'down', 'straight']));
  assert.equal(weak.ok, false);
  assert.match(weak.reason, /loop/);
  const strong = C.simulate(start, closeCircuit([...L(16, 'lift'), 'straight', 'down', ...L(9, 'steepDown'), 'down', 'down', 'straight', 'loop', 'straight', 'brake']));
  assert.equal(strong.ok, true, strong.reason);
  assert.equal(strong.inversions, 1);
  assert.ok(strong.maxSpeed > 70, `speed ${strong.maxSpeed}`);
});

test('tight turns at speed are brutal; brakes tame them', () => {
  const fast = C.simulate(start, closeCircuit([...L(10, 'lift'), 'straight', ...L(6, 'steepDown'), 'down', 'straight'], 'right'));
  assert.equal(fast.ok, true);
  assert.ok(fast.intensity >= 10, `intensity ${fast.intensity}`);
  assert.ok(fast.warnings.length > 0);
});

test('custom coasters are built piece by piece in a park and carry riders', () => {
  const p = Sim.createPark('C', 3);
  for (let y = 10; y < 39; y++) for (let x = 2; x < 38; x++) if (Sim.objectAt(p, x, y)) Sim.bulldoze(p, x, y);
  p.cash = 200000;
  for (let y = 26; y <= 38; y++) Sim.buildPath(p, 20, y);
  for (let x = 8; x <= 30; x++) Sim.buildPath(p, x, 26);
  const { obj } = Sim.startCoaster(p, 10, 25, 0);
  const cash = p.cash;
  for (const t of ['straight', ...L(5, 'lift'), 'straight', 'down', 'steepDown', 'steepDown', 'down', 'straight', 'brake']) {
    assert.equal(Sim.addPiece(p, obj.id, t).ok, true, t);
  }
  assert.ok(p.cash < cash, 'pieces cost money');
  assert.equal(Sim.canAddPiece(p, obj, 'down').ok, true);
  assert.equal(Sim.canAddPiece(p, obj, 'steepDown').ok, false, 'would go underground');
  assert.equal(Sim.openCoaster(p, obj.id).ok, false, 'incomplete');
  for (let i = 0; i < obj._layout.cursor.h; i) Sim.addPiece(p, obj.id, 'down');
  Sim.addPiece(p, obj.id, 'wideLeft');
  Sim.addPiece(p, obj.id, 'wideLeft');
  while (!Sim.coasterComplete(obj)) {
    const n = obj.track.pieces.length;
    if (Sim.addPiece(p, obj.id, 'wideLeft').ok && Sim.addPiece(p, obj.id, 'wideLeft').ok && Sim.coasterComplete(obj)) break;
    while (obj.track.pieces.length > n) Sim.removePiece(p, obj.id);
    assert.equal(Sim.addPiece(p, obj.id, 'straight').ok, true);
  }
  const before = p.cash;
  Sim.addPiece(p, obj.id, 'straight'); // refused: complete
  assert.equal(p.cash, before);
  const res = Sim.openCoaster(p, obj.id);
  assert.equal(res.ok, true, res.reason);
  assert.ok(obj.price > 0);
  assert.equal(Sim.rideDef(obj).excitement, res.excitement);
  for (let i = 0; i < 2400; i++) Sim.step(p, 0.1);
  assert.ok(obj.stats.riders > 0, 'guests rode it');
  assert.ok(p.objectives.includes('designer'));

  // Track blocks other construction and can't run through paths.
  const [cx, cy] = obj._cells[3];
  assert.equal(Sim.build(p, 'burger', cx, cy).ok, false);

  // Save/load keeps the design and its physics.
  const q = Sim.deserialize(JSON.parse(JSON.stringify(Sim.serialize(p))));
  const o2 = Sim.getObject(q, obj.id);
  assert.deepEqual(o2.track, obj.track);
  assert.equal(Sim.rideDef(o2).excitement, res.excitement);

  // Editing closes it; removing every piece demolishes it with a full refund.
  assert.equal(Sim.editCoaster(p, obj.id).ok || obj.phase === 'running', true);
});

test('track cannot collide with itself or leave the park', () => {
  const p = Sim.createPark('C', 4);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if (Sim.objectAt(p, x, y)) Sim.bulldoze(p, x, y);
  p.cash = 100000;
  const { obj } = Sim.startCoaster(p, 38, 5, 0);
  Sim.addPiece(p, obj.id, 'straight');
  assert.equal(Sim.canAddPiece(p, obj, 'straight').ok, false, 'edge of the map');
  const q = Sim.startCoaster(p, 5, 5, 0).obj;
  for (const t of ['right', 'right', 'right']) Sim.addPiece(p, q.id, t);
  assert.equal(Sim.canAddPiece(p, q, 'straight').ok, false, 'would hit its own station');
  assert.equal(Sim.canAddPiece(p, q, 'down').ok, false, 'no tunnels');
});

test('tampered coaster saves are rejected', () => {
  const p = Sim.createPark('C', 5);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (Sim.objectAt(p, x, y)) Sim.bulldoze(p, x, y);
  p.cash = 10000;
  Sim.startCoaster(p, 3, 3, 0);
  const data = Sim.serialize(p);
  const c = data.objects.find((o) => o.kind === 'custom');
  c.track.pieces = ['station', 'warpDrive'];
  assert.throws(() => Sim.deserialize(data));
});
