// The simulation worker. It owns the authoritative park, runs the fixed-step
// simulation off the main thread, applies player actions sent by the page,
// and posts snapshots for rendering and UI.

/// <reference lib="webworker" />
import * as Sim from '../shared/sim.ts';
import type { Park } from '../shared/types.ts';
import { MOTION_STRIDE, GUEST_STATES } from './protocol.ts';
import type { ToWorker, FromWorker } from './protocol.ts';
import { buildStressPark } from '../shared/stress.ts';

const STEP = 0.1; // game-seconds per simulation step
const MAX_STEPS_PER_TICK = 60;
const TICK_MS = 16;
/**
 * Full snapshots are the expensive part of talking to the page (hundreds of
 * KB to decode on the main thread), so they're capped at this interval.
 * Between them, compact motion frames keep walkers moving smoothly.
 */
const FULL_SNAPSHOT_MS = 125;

/**
 * Every action the page may perform. Each takes the park first; the page
 * passes the remaining arguments. Reads stay on the page (against its
 * snapshot); only these may change the park.
 */
const METHODS = {
  build: Sim.build,
  buildPath: Sim.buildPath,
  bulldoze: Sim.bulldoze,
  setPrice: Sim.setPrice,
  setOpen: Sim.setOpen,
  setEntranceFee: Sim.setEntranceFee,
  setParkOpen: Sim.setParkOpen,
  renamePark: Sim.renamePark,
  hire: Sim.hire,
  fire: Sim.fire,
  renameStaff: Sim.renameStaff,
  setUniform: Sim.setUniform,
  renameObject: Sim.renameObject,
  setColor: Sim.setColor,
  refurbish: Sim.refurbish,
  replaceVendor: Sim.replaceVendor,
  setSetting: Sim.setSetting,
  installFence: Sim.installFence,
  setLocked: Sim.setLocked,
  sentence: Sim.sentence,
  execute: Sim.execute,
  setRigMode: Sim.setRigMode,
  startCoaster: Sim.startCoaster,
  addPiece: Sim.addPiece,
  removePiece: Sim.removePiece,
  testCoaster: Sim.testCoaster,
  openCoaster: Sim.openCoaster,
  editCoaster: Sim.editCoaster,
  renameRide: Sim.renameRide,
  setCoasterCars: Sim.setCoasterCars,
  importDesign: Sim.importDesign,
  startRaid: Sim.startRaid,
  triggerEvent: Sim.triggerEvent,
  /** Debug/test helper: overwrite top-level park fields (the page can already cheat its own save). */
  debugPatch: (park: Park, fields: Partial<Park>) => { Object.assign(park, fields); return { ok: true }; },
} satisfies Record<string, (park: Park, ...args: never[]) => unknown>;

export type MethodName = keyof typeof METHODS;

const scope = self as unknown as DedicatedWorkerGlobalScope;
let park: Park | null = null;
let speed = 1;
let acc = 0;
let last = performance.now();
let simulated = 0;
let stepMs = 0;
let dirty = false;
let lastFull = 0;
/** Something besides walker motion changed (an action, a load): send a full snapshot. */
let structural = false;

const post = (msg: FromWorker) => scope.postMessage(msg);

/** A structured-clone-friendly copy without the bulky per-walker routes. */
function snapshot(p: Park): Park {
  return {
    ...p,
    guests: p.guests.map((g) => ({ ...g, route: null })),
    staff: p.staff.map((s) => ({ ...s, route: null })),
    _guestById: new Map(),
    _events: [],
    _fx: [],
  };
}

function flush() {
  if (!park) return;
  const events = park._events.splice(0);
  const fx = (park._fx || []).splice(0);
  post({ type: 'snapshot', park: snapshot(park), events, fx, simulated, stepMs });
  simulated = 0;
  stepMs = 0;
  dirty = false;
  structural = false;
  lastFull = performance.now();
}

const STATE_CODE = new Map<string, number>(GUEST_STATES.map((s, i) => [s, i]));

/** Positions and states of every walker, in a buffer the page receives without copying. */
function flushMotion() {
  if (!park) return;
  const { guests, staff } = park;
  const buf = new Float64Array((guests.length + staff.length) * MOTION_STRIDE);
  let o = 0;
  for (const g of guests) {
    buf[o] = g.id; buf[o + 1] = g.x; buf[o + 2] = g.y; buf[o + 3] = g.nx; buf[o + 4] = g.ny; buf[o + 5] = g.t;
    buf[o + 6] = STATE_CODE.get(g.state) ?? 0; buf[o + 7] = g.hp ?? 0;
    o += MOTION_STRIDE;
  }
  for (const s of staff) {
    buf[o] = s.id; buf[o + 1] = s.x; buf[o + 2] = s.y; buf[o + 3] = s.nx; buf[o + 4] = s.ny; buf[o + 5] = s.t;
    buf[o + 6] = s.busy; buf[o + 7] = s.down;
    o += MOTION_STRIDE;
  }
  const events = park._events.splice(0);
  const fx = (park._fx || []).splice(0);
  const msg: FromWorker = { type: 'motion', walkers: buf, guestCount: guests.length, events, fx, simulated, stepMs };
  scope.postMessage(msg, [buf.buffer]);
  simulated = 0;
  stepMs = 0;
  dirty = false;
}

function call(method: MethodName, args: unknown[]): unknown {
  if (!park) throw new Error('No park loaded');
  const fn = METHODS[method] as ((p: Park, ...a: unknown[]) => unknown) | undefined;
  if (!fn) throw new Error(`Unknown action ${String(method)}`);
  dirty = true;
  structural = true;
  return fn(park, ...args);
}

function tick() {
  const now = performance.now();
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (park && speed > 0) {
    acc += dt * speed;
    const t0 = performance.now();
    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS_PER_TICK) {
      Sim.step(park, STEP);
      acc -= STEP;
      steps++;
    }
    if (steps) {
      simulated += steps * STEP;
      stepMs += performance.now() - t0;
      dirty = true;
    }
  }
  if (!dirty) return;
  if (structural || now - lastFull >= FULL_SNAPSHOT_MS) flush();
  else flushMotion();
}

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'speed':
        speed = Math.max(0, Math.min(8, msg.speed));
        return;
      case 'load':
        park = Sim.deserialize(msg.data);
        acc = 0;
        flush();
        post({ type: 'result', id: msg.id, value: { ok: true } });
        return;
      case 'newPark':
        park = Sim.createPark(msg.name, msg.seed, msg.settings);
        acc = 0;
        flush();
        post({ type: 'result', id: msg.id, value: { ok: true } });
        return;
      case 'stress':
        park = buildStressPark(msg.guests, msg.seed);
        acc = 0;
        flush();
        post({ type: 'result', id: msg.id, value: { ok: true, guests: park.guests.length } });
        return;
      case 'serialize':
        if (!park) throw new Error('No park loaded');
        post({ type: 'result', id: msg.id, value: Sim.serialize(park) });
        return;
      case 'call': {
        const value = call(msg.method, msg.args);
        flush(); // snapshot first, so the page sees the change when the result arrives
        post({ type: 'result', id: msg.id, value });
        return;
      }
      case 'batch': {
        const value = msg.calls.map(([method, ...args]) => call(method, args));
        flush();
        post({ type: 'result', id: msg.id, value });
        return;
      }
    }
  } catch (err) {
    if ('id' in msg) post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};

setInterval(tick, TICK_MS);
