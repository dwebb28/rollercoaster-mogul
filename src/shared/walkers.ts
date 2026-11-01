// Guest and staff classes backed by the WASM core's walker table.
//
// Every field is declared here, in a fixed order, so each guest (and each
// staff member) has the same V8 object shape from birth. `implements` makes
// the compiler insist the lists match types.ts: add a field there and you
// must add it here.
//
// Positions (x, y, nx, ny, lx, ly, t) are not fields: they're accessors on
// CoreWalker that read core memory. See core.ts.

import { CoreWalker } from './core.ts';
import type { WalkerInit } from './core.ts';
import type {
  Guest, Staff, GuestTypeKey, CrimeKind, CriminalRecord, StaffRole,
} from './types.ts';

/** The fields of `T` other than positions and the slot. */
type Fields<T> = Omit<T, 'x' | 'y' | 'nx' | 'ny' | 'lx' | 'ly' | 't' | '_w'>;

function assignFields(target: object, f: object) {
  const { x, y, nx, ny, lx, ly, t, _w, ...rest } = f as Record<string, unknown>;
  Object.assign(target, rest);
}

export class GuestWalker extends CoreWalker implements Guest {
  id!: number;
  name!: string;
  route: number[] | null = null;
  type!: GuestTypeKey;
  shirt!: string;
  state!: Guest['state'];
  target!: number | null;
  busy!: number;
  queueT!: number;
  queueAt!: number;
  thought!: string;
  thoughtT!: number;
  litterT!: number;
  decideIn!: number;
  ridden!: Record<number, number>;
  rides!: number;
  gone!: boolean;
  leaving!: boolean;
  cash!: number;
  happy!: number;
  hunger!: number;
  thirst!: number;
  bladder!: number;
  energy!: number;
  nausea!: number;
  pref!: number;
  thrift!: number;
  timeIn!: number;
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
  route: number[] | null = null;
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
