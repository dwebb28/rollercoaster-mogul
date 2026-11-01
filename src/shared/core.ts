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

const ABI_VERSION = 1;

interface CoreExports {
  memory: WebAssembly.Memory;
  abi_version(): number;
  init(size: number): void;
  tiles_ptr(): number;
  dist_ptr(): number;
  prev_ptr(): number;
  bfs(start: number, allowEntrance: number): number;
}

export interface Core {
  /** Tile kinds mirrored from park.tiles (0 grass, 1 path, 2 entrance). */
  tiles: Uint8Array;
  /** Last BFS result. Overwritten by the next bfs() call: read it, don't keep it. */
  dist: Int16Array;
  prev: Int32Array;
  bfs(start: number, allowEntrance: boolean): number;
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

async function load(): Promise<Core> {
  const x = await instantiate();
  if (x.abi_version() !== ABI_VERSION) throw new Error(`mogul_core.wasm ABI ${x.abi_version()}, expected ${ABI_VERSION}: rebuild it`);
  x.init(GRID);
  const n = GRID * GRID, buf = x.memory.buffer;
  return {
    tiles: new Uint8Array(buf, x.tiles_ptr(), n),
    dist: new Int16Array(buf, x.dist_ptr(), n),
    prev: new Int32Array(buf, x.prev_ptr(), n),
    bfs: (start, allowEntrance) => x.bfs(start, allowEntrance ? 1 : 0),
  };
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
