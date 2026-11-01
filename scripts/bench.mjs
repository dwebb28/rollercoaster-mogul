// Headless performance benchmark for the simulation and worker snapshots.
//
//   npm run bench            sim cost and snapshot cost at several crowd sizes
//   npm run bench -- --profile   also CPU-profiles a 600-guest run and lists hot functions
//
// Runs on V8, the same JavaScript engine as Chrome, so the numbers transfer
// reasonably well to the browser's worker (allow for hardware differences).

import v8 from 'node:v8';
import { Session } from 'node:inspector/promises';
import { buildStressPark } from '../src/shared/stress.ts';
import { step } from '../src/shared/sim.ts';
import { plainWalker } from '../src/shared/core.ts';

const STEP = 0.1;
const sizes = [100, 300, 600, 1000];
const fmt = (n, d = 2) => n.toFixed(d).padStart(8);

/** The same shape the worker posts (see src/client/sim.worker.ts). */
const snapshot = (p) => ({
  ...p,
  guests: p.guests.map((g) => ({ ...plainWalker(g), route: null })),
  staff: p.staff.map((s) => ({ ...plainWalker(s), route: null })),
  _guestById: new Map(), _events: [], _fx: [],
});

function time(fn, reps) {
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn();
  return (performance.now() - t0) / reps;
}

console.log('Simulation (one step = 0.1 game-seconds; 4× speed runs 40 steps per second)\n');
console.log('  guests   ms/step   p95 ms   steps/s max   CPU at 1×   CPU at 4×   snapshot KB   encode ms   decode ms   motion ms   page ms/s at 4× (all full → full+motion)');
for (const n of sizes) {
  const park = buildStressPark(n, 7);
  for (let i = 0; i < 200; i++) step(park, STEP); // warm up the JIT
  const samples = [];
  let guests = 0;
  for (let i = 0; i < 600; i++) {
    const t0 = performance.now();
    step(park, STEP);
    samples.push(performance.now() - t0);
    guests += park.guests.length;
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const snap = snapshot(park);
  const bytes = v8.serialize(snap);
  const encode = time(() => v8.serialize(snapshot(park)), 30);
  const decode = time(() => v8.deserialize(bytes), 30);
  // Motion frame: pack walkers into a Float64Array (worker) and patch a mirror (page).
  const mirror = v8.deserialize(bytes);
  const byId = new Map(mirror.guests.map((g) => [g.id, g]));
  const motion = time(() => {
    const buf = new Float64Array((park.guests.length + park.staff.length) * 8);
    let o = 0;
    for (const g of park.guests) { buf[o] = g.id; buf[o + 1] = g.x; buf[o + 2] = g.y; buf[o + 3] = g.nx; buf[o + 4] = g.ny; buf[o + 5] = g.t; o += 8; }
    const copy = structuredClone(buf, { transfer: [buf.buffer] });
    for (let i = 0; i < park.guests.length; i++) {
      const m = byId.get(copy[i * 8]);
      if (m) { m.x = copy[i * 8 + 1]; m.y = copy[i * 8 + 2]; m.nx = copy[i * 8 + 3]; m.ny = copy[i * 8 + 4]; m.t = copy[i * 8 + 5]; }
    }
  }, 200);
  const before = 40 * decode;
  const after = 8 * decode + 32 * motion;
  console.log(
    `  ${String(Math.round(guests / samples.length)).padStart(6)}  ${fmt(mean, 3)}  ${fmt(p95, 3)}  ${fmt(1000 / mean, 0).padStart(12)}`
    + `  ${fmt((mean * 10) / 10, 1)}%   ${fmt((mean * 40) / 10, 1)}%   ${fmt(bytes.length / 1024, 0).padStart(11)}   ${fmt(encode)}  ${fmt(decode)}`
    + `   ${fmt(motion, 3)}   ${fmt(before, 0)} → ${fmt(after, 0).trim()}`,
  );
}
console.log('\nCPU columns: share of one core spent simulating at that game speed.');
console.log('Snapshots: encode runs in the worker, decode on the page (main thread).');
console.log('Page cost at 4×: sending a full snapshot every step (40/s) vs. 8 full snapshots/s plus 32 motion frames/s.');
console.log('A 60 fps frame has ~16.7 ms; 1000 ms/s of page time is the whole main thread.');

if (process.argv.includes('--profile')) {
  const park = buildStressPark(600, 7);
  for (let i = 0; i < 200; i++) step(park, STEP);
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 100 });
  await session.post('Profiler.start');
  for (let i = 0; i < 1200; i++) step(park, STEP);
  const { profile } = await session.post('Profiler.stop');
  const self = new Map();
  const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
  const counts = new Map();
  for (const id of profile.samples) counts.set(id, (counts.get(id) || 0) + 1);
  let total = 0;
  for (const [id, c] of counts) {
    const nd = byId.get(id);
    const f = nd.callFrame;
    const key = `${f.functionName || '(anonymous)'}  ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + c);
    total += c;
  }
  console.log('\nHot functions (self time, 600 guests, 120 game-seconds):');
  for (const [k, c] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${((c / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
}
