// Replay guard for the WASM migration.
//
// Seeded parks must replay identically when code moves from TypeScript to
// the Rust core. These hashes were recorded with the pure-TypeScript
// simulation. A port that changes them changed behaviour, not just speed.
//
// If you change gameplay on purpose, update the hashes in the same commit
// and say so in the message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as Sim from '../src/shared/sim.ts';
import { buildStressPark } from '../src/shared/stress.ts';

const GOLDEN = { stress: 'b2edd3afff445718', default: '07ad226aff2d3c06' };

// Key order is irrelevant to a save, so hash a sorted-key form.
const canon = (v) => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);

const run = (park) => {
  for (let i = 0; i < 3000; i++) Sim.step(park, 0.1);
  return createHash('sha256').update(canon(Sim.serialize(park))).digest('hex').slice(0, 16);
};

test('a 300-guest stress park replays identically for 5 game-minutes', () => {
  assert.equal(run(buildStressPark(300, 5)), GOLDEN.stress);
});

test('a default new park replays identically for 5 game-minutes', () => {
  assert.equal(run(Sim.createPark('G', 42)), GOLDEN.default);
});
