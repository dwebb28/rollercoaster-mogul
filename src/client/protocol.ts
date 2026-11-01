// Messages between the page (SimClient) and the simulation worker.
// Both sides import these types, so a change to one side that the other
// doesn't understand is a compile error.

import type { Park, SimEvent, Fx, Settings } from '../shared/types.ts';
import type { SaveData } from '../shared/sim.ts';
import type { MethodName } from './sim.worker.ts';

export type ToWorker =
  | { type: 'load'; id: number; data: SaveData }
  | { type: 'newPark'; id: number; name: string; seed: number; settings?: Partial<Settings> }
  | { type: 'call'; id: number; method: MethodName; args: unknown[] }
  | { type: 'batch'; id: number; calls: [MethodName, ...unknown[]][] }
  | { type: 'serialize'; id: number }
  | { type: 'speed'; speed: number };

export type FromWorker =
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
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string };
