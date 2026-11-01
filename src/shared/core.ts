// Loads the Rust simulation core (core/ → public/wasm/mogul_core.wasm).
//
// One loader for every place the simulation runs: the Web Worker, the page,
// the server (save validation) and Node tests/benchmarks. Module-level
// `await` means anything that imports sim.ts gets a ready core.
//
// The core exports plain numeric functions and pointers into its memory (no
// wasm-bindgen). Buffers are allocated once by init(), memory never grows,
// so the typed-array views below stay valid for the life of the page.

import { GRID } from './catalog.ts';

/** Walker table row: x, y, nx, ny, lx, ly, t, spare (matches core/src/walkers.rs). */
const WALKER_STRIDE = 8;
let walkerCap = 1024;
let walkerHeap: Float64Array;

const ABI_VERSION = 3;

interface CoreExports {
  memory: WebAssembly.Memory;
  abi_version(): number;
  init(size: number): void;
  tiles_ptr(): number;
  dist_ptr(): number;
  prev_ptr(): number;
  bfs(start: number, allowEntrance: number): number;
  walkers_reserve(slots: number): void;
  walkers_ptr(): number;
  walker_step(slot: number, dt: number, speed: number): number;
  rng_ptr(): number;
  rng_next(): number;
  trace_route(slot: number, start: number, goal: number): number;
  walker_advance(slot: number, allowEntrance: number): number;
  route_len(slot: number): number;
  route_clear(slot: number): void;
  route_begin(slot: number): void;
  route_push(slot: number, tile: number): void;
  route_ptr(slot: number): number;
}

export interface Core {
  /** Tile kinds mirrored from park.tiles (0 grass, 1 path, 2 entrance). */
  tiles: Uint8Array;
  /** Last BFS result. Overwritten by the next bfs() call: read it, don't keep it. */
  dist: Int16Array;
  prev: Int32Array;
  bfs(start: number, allowEntrance: boolean): number;
  /** Moves walker `slot`; true when it's standing on a tile, ready to decide. */
  walkerStep(slot: number, dt: number, speed: number): boolean;
  /** Next route step or a random wander, drawing from `rng`. False if boxed in. */
  walkerAdvance(slot: number, allowEntrance: boolean, rng: { rngState: number }): boolean;
  /** Route for `slot` from `start` to `goal` using the last bfs() result. False if unreachable. */
  traceRoute(slot: number, start: number, goal: number): boolean;
  /** Steps left on the route; -1 when there is none. */
  routeLen(slot: number): number;
  clearRoute(slot: number): void;
  /** One mulberry32 draw from `rng` (parity tests). */
  rand(rng: { rngState: number }): number;
}

async function wasmBytes(): Promise<BufferSource | Response> {
  if (import.meta.url.startsWith('file:')) {
    // Node: running TS source (src/shared) or built JS (public/js/gen/shared).
    const fs = (await import('node:fs/promises' as string)) as { readFile(u: URL): Promise<Uint8Array<ArrayBuffer>> };
    for (const rel of ['../../public/wasm/mogul_core.wasm', '../../../wasm/mogul_core.wasm']) {
      try { return await fs.readFile(new URL(rel, import.meta.url)); } catch { /* try next */ }
    }
    throw new Error('mogul_core.wasm not found: run `npm run build:wasm`');
  }
  // Browser: public/js/gen/shared/core.js → public/wasm/
  return fetch(new URL('../../../wasm/mogul_core.wasm', import.meta.url));
}

async function instantiate(): Promise<CoreExports> {
  const src = await wasmBytes();
  if (src instanceof Response) {
    if (!src.ok) throw new Error(`mogul_core.wasm: HTTP ${src.status}`);
    try {
      return (await WebAssembly.instantiateStreaming(src.clone(), {})).instance.exports as unknown as CoreExports;
    } catch { // wrong MIME type from some static hosts: fall back to bytes
      return (await WebAssembly.instantiate(await src.arrayBuffer(), {})).instance.exports as unknown as CoreExports;
    }
  }
  return (await WebAssembly.instantiate(src, {})).instance.exports as unknown as CoreExports;
}

let X!: CoreExports;
let rngCell: Uint32Array;
let viewBuffer: ArrayBuffer | null = null;

/** (Re)builds every typed-array view. Needed after anything that can grow memory. */
function views(c: Core) {
  const n = GRID * GRID, buf = X.memory.buffer;
  c.tiles = new Uint8Array(buf, X.tiles_ptr(), n);
  c.dist = new Int16Array(buf, X.dist_ptr(), n);
  c.prev = new Int32Array(buf, X.prev_ptr(), n);
  walkerHeap = new Float64Array(buf, X.walkers_ptr(), walkerCap * WALKER_STRIDE);
  rngCell = new Uint32Array(buf, X.rng_ptr(), 1);
  viewBuffer = buf;
}

/** After a call that may allocate: rebuild views if memory grew or the walker table moved. */
function afterAlloc() {
  if (X.memory.buffer !== viewBuffer || walkerHeap.byteOffset !== X.walkers_ptr()) views(core);
}

async function load(): Promise<Core> {
  X = await instantiate();
  if (X.abi_version() !== ABI_VERSION) throw new Error(`mogul_core.wasm ABI ${X.abi_version()}, expected ${ABI_VERSION}: rebuild it`);
  X.init(GRID);
  X.walkers_reserve(walkerCap);
  const c = {
    bfs: (start: number, allowEntrance: boolean) => X.bfs(start, allowEntrance ? 1 : 0),
    walkerStep: (slot: number, dt: number, speed: number) => X.walker_step(slot, dt, speed) === 1,
    walkerAdvance(slot: number, allowEntrance: boolean, rng: { rngState: number }) {
      rngCell[0] = rng.rngState;
      const moved = X.walker_advance(slot, allowEntrance ? 1 : 0) === 1;
      rng.rngState = rngCell[0]!;
      return moved;
    },
    traceRoute(slot: number, start: number, goal: number) {
      const ok = X.trace_route(slot, start, goal) === 1;
      afterAlloc();
      return ok;
    },
    routeLen: (slot: number) => X.route_len(slot),
    clearRoute: (slot: number) => X.route_clear(slot),
    rand(rng: { rngState: number }) {
      rngCell[0] = rng.rngState;
      const r = X.rng_next();
      rng.rngState = rngCell[0]!;
      return r;
    },
  } as Core;
  views(c);
  return c;
}

export const core: Core = await load();

/** Which park's tiles the core currently holds. */
let owner: object | null = null;

/** Copies a park's tiles into the core if it holds another park's (or stale) tiles. */
export function syncTiles(park: { tiles: ArrayLike<number> }, force = false) {
  if (!force && owner === park) return;
  core.tiles.set(park.tiles);
  owner = park;
}

/** Records a single tile change (keeps the core in step without a full copy). */
export function setTile(park: object, i: number, kind: number) {
  if (owner === park) core.tiles[i] = kind;
}

// ---------------------------------------------------------------------------
// Walkers: guests and staff whose position lives in core memory
// ---------------------------------------------------------------------------
//
// A walker (guest or staff member) is an instance of a CoreWalker subclass
// (see walkers.ts). Its x, y, nx, ny, lx, ly and t are getters/setters on the
// prototype that read and write its row in the core's walker table. Every
// other field is an ordinary own property, declared up front as a class
// field, so all guests share one V8 object shape and property access stays
// fast. (Measured: per-object accessors, or swapping the prototype of an
// object literal, made the simulation 2x to 10x slower.)
//
// Spread and structuredClone copy own properties only, so code that copies a
// walker uses plainWalker(); JSON.stringify goes through toJSON(). A freed
// walker has _w = -1: reads give undefined and writes go nowhere, so a stale
// reference can't corrupt a reused slot.

let nextSlot = 0;
const freeSlots: number[] = [];
// Backstop for walkers dropped without freeWalker (e.g. a whole park replaced).
const reclaim = new FinalizationRegistry<number>((slot) => freeSlots.push(slot));

function takeSlot(): number {
  const free = freeSlots.pop();
  if (free !== undefined) return free;
  if (nextSlot >= walkerCap) {
    walkerCap *= 2;
    X.walkers_reserve(walkerCap);
    views(core);
  }
  return nextSlot++;
}

/** Position fields a walker is created from. */
export interface WalkerInit { x?: number; y?: number; nx?: number; ny?: number; lx?: number; ly?: number; t?: number }

export class CoreWalker {
  /** Slot in the core's walker table; -1 once freed. Never saved. */
  _w: number;

  constructor(f: WalkerInit) {
    const slot = takeSlot();
    this._w = slot;
    const r = slot * WALKER_STRIDE;
    walkerHeap[r] = Number(f.x) || 0;
    walkerHeap[r + 1] = Number(f.y) || 0;
    walkerHeap[r + 2] = Number(f.nx) || 0;
    walkerHeap[r + 3] = Number(f.ny) || 0;
    walkerHeap[r + 4] = Number(f.lx) || 0;
    walkerHeap[r + 5] = Number(f.ly) || 0;
    walkerHeap[r + 6] = Number(f.t) || 0;
    walkerHeap[r + 7] = 0;
    X.route_clear(slot);
    reclaim.register(this, slot, this);
  }

  get x() { return walkerHeap[this._w * WALKER_STRIDE]!; }
  set x(v: number) { walkerHeap[this._w * WALKER_STRIDE] = v; }
  get y() { return walkerHeap[this._w * WALKER_STRIDE + 1]!; }
  set y(v: number) { walkerHeap[this._w * WALKER_STRIDE + 1] = v; }
  get nx() { return walkerHeap[this._w * WALKER_STRIDE + 2]!; }
  set nx(v: number) { walkerHeap[this._w * WALKER_STRIDE + 2] = v; }
  get ny() { return walkerHeap[this._w * WALKER_STRIDE + 3]!; }
  set ny(v: number) { walkerHeap[this._w * WALKER_STRIDE + 3] = v; }
  get lx() { return walkerHeap[this._w * WALKER_STRIDE + 4]!; }
  set lx(v: number) { walkerHeap[this._w * WALKER_STRIDE + 4] = v; }
  get ly() { return walkerHeap[this._w * WALKER_STRIDE + 5]!; }
  set ly(v: number) { walkerHeap[this._w * WALKER_STRIDE + 5] = v; }
  get t() { return walkerHeap[this._w * WALKER_STRIDE + 6]!; }
  set t(v: number) { walkerHeap[this._w * WALKER_STRIDE + 6] = v; }

  /**
   * The route as an array of tiles, or null. A compatibility view for tests
   * and debugging: it copies out of core memory. Simulation code uses the
   * route helpers in sim.ts (traceRoute, hasRoute, routeLeft) instead.
   */
  get route(): number[] | null {
    const n = X.route_len(this._w);
    if (n < 0) return null;
    const steps = new Uint16Array(X.memory.buffer, X.route_ptr(this._w), n);
    return Array.from(steps).reverse();
  }
  set route(r: number[] | null) {
    if (!r) { X.route_clear(this._w); return; }
    X.route_begin(this._w);
    for (let i = r.length - 1; i >= 0; i--) X.route_push(this._w, r[i]!);
    afterAlloc();
  }

  toJSON() { return plainWalker(this); }
}

/** A plain-object copy of a walker, positions included and slot blanked. */
export function plainWalker<T extends object>(w: T): T {
  if (!(w instanceof CoreWalker)) return { ...w };
  // Spread-then-override measured ~2x faster than rest-destructuring.
  return { ...w, _w: undefined, x: w.x, y: w.y, nx: w.nx, ny: w.ny, lx: w.lx, ly: w.ly, t: w.t };
}

/** Returns a walker's slot to the pool. Call when it leaves the park. */
export function freeWalker(o: object) {
  const w = o as { _w?: number };
  if (w._w === undefined || w._w < 0) return;
  X.route_clear(w._w); // release the route (its buffer stays allocated for reuse)
  reclaim.unregister(o);
  freeSlots.push(w._w);
  w._w = -1;
}

/** Slots in use (for tests and the perf overlay). */
export const walkerSlotsInUse = () => nextSlot - freeSlots.length;
