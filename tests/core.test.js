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
