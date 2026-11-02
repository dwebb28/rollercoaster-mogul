// Guest and staff classes backed by the WASM core's walker table.
//
// Every field is declared here, in a fixed order, so each guest (and each
// staff member) has the same V8 object shape from birth. `implements` makes
// the compiler insist the lists match types.ts: add a field there and you
// must add it here.
//
// Positions (x, y, nx, ny, lx, ly, t) and `route`, and for guests the needs
// (happy, hunger, thirst, bladder, energy, nausea, thoughtT, timeIn), are not
// fields: they're accessors on CoreWalker / CoreGuest backed by core memory.
// assignFields sets them through those accessors. See core.ts.

import { CoreWalker, CoreGuest } from './core.ts';
import type { WalkerInit } from './core.ts';
import type {
  Guest, Staff, GuestTypeKey, CrimeKind, CriminalRecord, StaffRole,
} from './types.ts';

/** The fields of `T` other than positions and the slot. */
type Fields<T> = Omit<T, 'x' | 'y' | 'nx' | 'ny' | 'lx' | 'ly' | 't' | '_w' | 'route'> & { route?: number[] | null };

function assignFields(target: object, f: object) {
  const { x, y, nx, ny, lx, ly, t, _w, route, ...rest } = f as Record<string, unknown>;
  Object.assign(target, rest);
}

export class GuestWalker extends CoreGuest implements Guest {
  id!: number;
  name!: string;
  type!: GuestTypeKey;
  shirt!: string;
  state!: Guest['state'];
  target!: number | null;
  busy!: number;
  queueT!: number;
  queueAt!: number;
  thought!: string;
  litterT!: number;
  decideIn!: number;
  ridden!: Record<number, number>;
  rides!: number;
  gone!: boolean;
  leaving!: boolean;
  cash!: number;
  pref!: number;
  thrift!: number;
  umbrella!: boolean;
  map!: boolean;
  souvenir!: boolean;
  atmUsed!: boolean;
  crime!: CrimeKind | null;
  crimeT!: number;
  crimes!: number;
  loot!: number;
  heistLoot!: boolean;
  heist!: number | null;
  spotted!: boolean;
  injured!: boolean;
  record!: CriminalRecord;
  gang!: string | null;
  high!: number;
  arrested?: boolean;
  hp?: number;
  maxHp?: number;
  acc?: number;
  cool?: number;
  robT?: number;
  lastT?: number;

  constructor(f: Fields<Guest> & WalkerInit) {
    super(f);
    assignFields(this, f);
  }
}

export class StaffWalker extends CoreWalker implements Staff {
  id!: number;
  name!: string;
  role!: StaffRole;
  task!: number | null;
  busy!: number;
  chase!: number | null;
  cool!: number;
  hp!: number;
  maxHp!: number;
  acc!: number;
  down!: number;
  traits!: string[];
  job?: number;

  constructor(f: Fields<Staff> & WalkerInit) {
    super(f);
    assignFields(this, f);
  }
}
