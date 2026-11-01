# The WebAssembly core

The simulation is moving from TypeScript to Rust, compiled to WebAssembly. The move happens one system at a time, behind a small, stable boundary, so the game keeps working, and stays bit-for-bit deterministic, after every step.

## Layout

```
core/                     Rust crate `mogul-core` (no dependencies)
  src/lib.rs              exported ABI: plain extern "C" functions and buffer pointers
  src/path.rs             pathfinding (BFS over the path grid)
public/wasm/
  mogul_core.wasm         the compiled core (committed, so deploys need no Rust)
src/shared/core.ts        the loader, used by the worker, the page, the server and tests
tests/core.test.js        parity tests: WASM output vs. the original TypeScript
```

## Building

```bash
rustup target add wasm32-unknown-unknown   # once
npm run build:wasm   # cargo build --release, then copies the .wasm into public/wasm/
npm run test:core    # Rust unit tests
npm test             # includes WASM-vs-TypeScript parity tests
```

You only need Rust installed to change the core. `npm start` and `npm test` use the committed `public/wasm/mogul_core.wasm`. After you change `core/`, run `npm run build:wasm` and commit the new `.wasm` alongside the source.

## Design rules

1. **A plain numeric ABI.** Exports take and return numbers. Bulk data moves through buffers in the module's linear memory, which `core.ts` wraps in typed-array views. There is no wasm-bindgen or generated JS glue, so one file loads the same way in browsers, workers and Node.
2. **Allocate once.** `init(size)` allocates every buffer. Nothing allocates after that, so memory never grows and the views in `core.ts` never go stale. If a future system needs growth, re-create its views after any call that can grow memory.
3. **Results are borrowed.** `core.dist` and `core.prev` hold the most recent BFS result. Use them before the next `bfs` call; never store them.
4. **Determinism is part of the contract.** Saves, replays and tests depend on seeded runs being identical. Ported code has to give exactly the TypeScript result:
   - Visit and iterate in the same order. For example, BFS checks neighbours as +x, −x, +y, −y.
   - Use `f64` everywhere the TypeScript uses `number`. `+ − × ÷` and `sqrt` are IEEE-exact in both languages, but `sin`, `cos`, `exp` and `pow` are not guaranteed to match V8's `Math`. Keep trigonometry in TypeScript until the whole system it feeds has moved, or replace it with a shared table or polynomial.
   - Random numbers: when a system that draws from `park.rngState` moves over, move mulberry32 with it, passing the state in and out each call so both sides share one stream.
5. **Bump `abi_version()`** in `lib.rs` and `ABI_VERSION` in `core.ts` when an export changes meaning. The loader refuses a mismatched `.wasm`.
6. **Every port gets a parity test** that runs the old TypeScript as a reference against the WASM output (see `tests/core.test.js`).

## Keeping core memory in sync

Pathfinding reads tile kinds from `core.tiles`, a mirror of `park.tiles`:
- `syncTiles(park, true)` runs at the start of every `step()`.
- `buildPath` and `bulldoze` update single tiles with `setTile`.
- `bfs` re-syncs whenever it's handed a different park, which happens in tests, the server and the benchmark.

## Migration status and order

The order comes from profiling (`npm run bench -- --profile`, 600 guests):

| # | System | TS share of a step | Status |
|---|---|---|---|
| 1 | Pathfinding (`bfs`) | 29% | **In WASM.** Its share is now ~12%; a step is 20–35% faster. |
| 2 | Movement: `advance`, `walkGuest`, route following | ~5% | Next. Needs guest positions in core memory. |
| 3 | Guest update loop: `updateGuest`, `onArrive`, `decide`, `pickGoal` | ~35% | Needs guest state as struct-of-arrays in the core, plus the RNG. |
| 4 | Staff and security: `updateStaff`, guard chases, fights | ~3% | After guests. |
| 5 | Rides, shops and economy | ~3% | Small; port with the guest loop. |
| 6 | Coaster physics (`coaster.ts`) | builder only | Needs a decision on trigonometry (rule 4). |

**End state:** the core owns the park as flat arrays in its own memory. TypeScript keeps the UI, the save format (`types.ts` stays the schema; serialize/deserialize read and write core memory) and the actions allow-list. Snapshots for the page then become a straight copy of core buffers instead of a structured clone of objects. That removes the main-thread decode cost that profiling found to be the real bottleneck.
