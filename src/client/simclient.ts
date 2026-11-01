// Page-side handle on the simulation worker.
//
// `park` is a read-only mirror, replaced by each snapshot. Read helpers from
// sim.ts (getObject, parkStats, canPlace...) work on it synchronously.
// Changes go through `act()`, which resolves after the worker has applied
// them and the mirror has been updated.

import type { Park, SimEvent, Fx, Settings, Staff } from '../shared/types.ts';
import type { SaveData } from '../shared/sim.ts';
import { MOTION_STRIDE, GUEST_STATES } from './protocol.ts';
import type { ToWorker, FromWorker } from './protocol.ts';
import type { MethodName } from './sim.worker.ts';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface SimStats {
  /** Full snapshots received per second. */
  snapshotsPerSec: number;
  /** Motion frames received per second. */
  motionPerSec: number;
  /** Share of wall-clock time the worker spends stepping the sim. */
  workerLoad: number;
  /** Average main-thread ms to decode one full snapshot. */
  snapshotMs: number;
  /** Main-thread ms per second spent receiving everything from the worker. */
  receiveMsPerSec: number;
}

export class SimClient {
  park: Park | null = null;
  /** Called after each snapshot (simulated = game seconds advanced). */
  onSnapshot: ((park: Park, simulated: number) => void) | null = null;
  /** Called after each completed action. */
  onAction: (() => void) | null = null;
  readonly stats: SimStats = { snapshotsPerSec: 0, motionPerSec: 0, workerLoad: 0, snapshotMs: 0, receiveMsPerSec: 0 };

  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private events: SimEvent[] = [];
  private fx: Fx[] = [];
  private windowStart = performance.now();
  private windowSnapshots = 0;
  private windowMotion = 0;
  private windowStepMs = 0;
  private windowSnapshotMs = 0;
  private windowReceiveMs = 0;
  private staffById = new Map<number, Staff>();

  constructor(url: URL | string) {
    this.worker = new Worker(url, { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      // Reading e.data is where the browser decodes the message: time it.
      const t0 = performance.now();
      const msg = e.data;
      const decodeMs = performance.now() - t0;
      this.receive(msg, decodeMs);
      this.windowReceiveMs += performance.now() - t0;
    };
    this.worker.onerror = (e) => console.error('Simulation worker error', e.message);
  }

  private send(msg: ToWorker) { this.worker.postMessage(msg); }

  private request<T>(msg: DistributiveOmit<Extract<ToWorker, { id: number }>, 'id'>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ ...msg, id } as ToWorker);
    });
  }

  private rollStats() {
    const now = performance.now();
    if (now - this.windowStart < 1000) return;
    const span = now - this.windowStart;
    this.stats.snapshotsPerSec = (this.windowSnapshots * 1000) / span;
    this.stats.motionPerSec = (this.windowMotion * 1000) / span;
    this.stats.workerLoad = this.windowStepMs / span;
    this.stats.snapshotMs = this.windowSnapshots ? this.windowSnapshotMs / this.windowSnapshots : this.stats.snapshotMs;
    this.stats.receiveMsPerSec = (this.windowReceiveMs * 1000) / span;
    this.windowStart = now;
    this.windowSnapshots = this.windowMotion = 0;
    this.windowStepMs = this.windowSnapshotMs = this.windowReceiveMs = 0;
  }

  private receive(msg: FromWorker, decodeMs: number) {
    if (msg.type === 'snapshot') {
      const park = msg.park;
      park._guestById = new Map(park.guests.map((g) => [g.id, g]));
      this.staffById = new Map(park.staff.map((s) => [s.id, s]));
      this.park = park;
      this.events.push(...msg.events);
      this.fx.push(...msg.fx);
      this.windowSnapshots++;
      this.windowSnapshotMs += decodeMs;
      this.windowStepMs += msg.stepMs;
      this.rollStats();
      this.onSnapshot?.(park, msg.simulated);
      return;
    }
    if (msg.type === 'motion') {
      this.applyMotion(msg.walkers, msg.guestCount);
      this.events.push(...msg.events);
      this.fx.push(...msg.fx);
      this.windowMotion++;
      this.windowStepMs += msg.stepMs;
      this.rollStats();
      if (this.park) this.onSnapshot?.(this.park, msg.simulated);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.message));
    else {
      p.resolve(msg.value);
      this.onAction?.();
    }
  }

  /** Moves walkers in the mirror to their latest positions. New walkers appear with the next full snapshot. */
  private applyMotion(w: Float64Array, guestCount: number) {
    const park = this.park;
    if (!park) return;
    const n = w.length / MOTION_STRIDE;
    for (let i = 0; i < n; i++) {
      const o = i * MOTION_STRIDE;
      const id = w[o]!;
      if (i < guestCount) {
        const g = park._guestById.get(id);
        if (!g) continue;
        g.x = w[o + 1]!; g.y = w[o + 2]!; g.nx = w[o + 3]!; g.ny = w[o + 4]!; g.t = w[o + 5]!;
        g.state = GUEST_STATES[w[o + 6]!] ?? 'walk';
        if (g.crime === 'panda') g.hp = w[o + 7]!;
      } else {
        const s = this.staffById.get(id);
        if (!s) continue;
        s.x = w[o + 1]!; s.y = w[o + 2]!; s.nx = w[o + 3]!; s.ny = w[o + 4]!; s.t = w[o + 5]!;
        s.busy = w[o + 6]!; s.down = w[o + 7]!;
      }
    }
  }

  /** Replaces the park with a large generated one for performance testing (not saved). */
  stress(guests: number, seed = 1): Promise<unknown> { return this.request({ type: 'stress', guests, seed }); }

  load(data: SaveData): Promise<unknown> { return this.request({ type: 'load', data }); }

  newPark(name: string, seed: number, settings?: Partial<Settings>): Promise<unknown> {
    return this.request({ type: 'newPark', name, seed, settings });
  }

  serialize(): Promise<SaveData> { return this.request({ type: 'serialize' }); }

  setSpeed(speed: number) { this.send({ type: 'speed', speed }); }

  /** Applies a player action in the worker. Resolves with the action's result. */
  act<T = any>(method: MethodName, ...args: unknown[]): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return this.request({ type: 'call', method, args });
  }

  /** Several actions in one round trip (used by tests and tools). */
  batch(calls: [MethodName, ...unknown[]][]): Promise<unknown[]> { return this.request({ type: 'batch', calls }); }

  /** Notifications and effects since the last call. */
  drainEvents(): SimEvent[] { return this.events.splice(0); }
  drainFx(): Fx[] { return this.fx.splice(0); }
}
