// Messages between the page (SimClient) and the simulation worker.
// Both sides import these types, so a change to one side that the other
// doesn't understand is a compile error.

import type { Park, SimEvent, Fx, Settings } from '../shared/types.ts';
import type { SaveData } from '../shared/sim.ts';
import type { MethodName } from './sim.worker.ts';

/** Numbers per walker in a motion frame. */
export const MOTION_STRIDE = 8;
/** Guest states, encoded by index in motion frames. */
export const GUEST_STATES = ['walk', 'queue', 'ride', 'busy', 'sit', 'downed'] as const;

export type ToWorker =
  | { type: 'load'; id: number; data: SaveData }
  | { type: 'newPark'; id: number; name: string; seed: number; settings?: Partial<Settings> }
  | { type: 'call'; id: number; method: MethodName; args: unknown[] }
  | { type: 'batch'; id: number; calls: [MethodName, ...unknown[]][] }
  | { type: 'serialize'; id: number }
  | { type: 'stress'; id: number; guests: number; seed: number }
  | { type: 'speed'; speed: number };

export type FromWorker =
  /** Sent once the worker's modules (including the WASM core) have loaded. */
  | { type: 'ready' }
  | {
    type: 'snapshot';
    /** The park with transient lookups intact (except _guestById, rebuilt by the client). */
    park: Park;
    /** Notifications and visual effects produced since the last snapshot. */
    events: SimEvent[];
    fx: Fx[];
    /** Game seconds simulated since the last snapshot. */
    simulated: number;
    /** Wall-clock milliseconds spent stepping the sim since the last snapshot. */
    stepMs: number;
  }
  | {
    type: 'motion';
    /**
     * Walker positions between full snapshots, transferred without copying.
     * Guests then staff, MOTION_STRIDE numbers each: id, x, y, nx, ny, t, state, extra.
     */
    walkers: Float64Array;
    guestCount: number;
    events: SimEvent[];
    fx: Fx[];
    simulated: number;
    stepMs: number;
  }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string };
