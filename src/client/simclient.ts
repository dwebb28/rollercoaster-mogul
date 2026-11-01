// Page-side handle on the simulation worker.
//
// `park` is a read-only mirror, replaced by each snapshot. Read helpers from
// sim.ts (getObject, parkStats, canPlace...) work on it synchronously.
// Changes go through `act()`, which resolves after the worker has applied
// them and the mirror has been updated.

import type { Park, SimEvent, Fx, Settings } from '../shared/types.ts';
import type { SaveData } from '../shared/sim.ts';
import type { ToWorker, FromWorker } from './protocol.ts';
import type { MethodName } from './sim.worker.ts';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface SimStats {
  /** Snapshots received per second. */
  snapshotsPerSec: number;
  /** Share of wall-clock time the worker spends stepping the sim. */
  workerLoad: number;
  /** Main-thread milliseconds spent receiving the last snapshot. */
  receiveMs: number;
}

export class SimClient {
  park: Park | null = null;
  /** Called after each snapshot (simulated = game seconds advanced). */
  onSnapshot: ((park: Park, simulated: number) => void) | null = null;
  /** Called after each completed action. */
  onAction: (() => void) | null = null;
  readonly stats: SimStats = { snapshotsPerSec: 0, workerLoad: 0, receiveMs: 0 };

  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private events: SimEvent[] = [];
  private fx: Fx[] = [];
  private windowStart = performance.now();
  private windowSnapshots = 0;
  private windowStepMs = 0;

  constructor(url: URL | string) {
    this.worker = new Worker(url, { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
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

  private receive(msg: FromWorker) {
    if (msg.type === 'snapshot') {
      const t0 = performance.now();
      const park = msg.park;
      park._guestById = new Map(park.guests.map((g) => [g.id, g]));
      this.park = park;
      this.events.push(...msg.events);
      this.fx.push(...msg.fx);
      this.windowSnapshots++;
      this.windowStepMs += msg.stepMs;
      const now = performance.now();
      if (now - this.windowStart >= 1000) {
        const span = now - this.windowStart;
        this.stats.snapshotsPerSec = (this.windowSnapshots * 1000) / span;
        this.stats.workerLoad = this.windowStepMs / span;
        this.windowStart = now;
        this.windowSnapshots = 0;
        this.windowStepMs = 0;
      }
      this.onSnapshot?.(park, msg.simulated);
      this.stats.receiveMs = performance.now() - t0;
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
