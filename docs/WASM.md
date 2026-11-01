# The WebAssembly core

The simulation is moving from TypeScript to Rust, compiled to WebAssembly. The move happens one system at a time, behind a small, stable boundary, so the game keeps working, and stays bit-for-bit deterministic, after every step.

## Layout

```
core/                     Rust crate `mogul-core` (no dependencies)
  src/lib.rs              exported ABI: plain extern "C" functions and buffer pointers
  src/path.rs             pathfinding (BFS over the path grid)
  src/walkers.rs          walkers: positions, routes, movement, route following and wandering
  src/rng.rs              mulberry32, bit-identical to rand() in sim.ts
public/wasm/
  mogul_core.wasm         the compiled core (committed, so deploys need no Rust)
src/shared/core.ts        the loader, used by the worker, the page, the server and tests; CoreWalker base class
src/shared/walkers.ts     GuestWalker / StaffWalker: guests and staff whose positions live in the core
tests/core.test.js        parity tests: WASM output vs. the original TypeScript
tests/replay.test.js      replay guard: seeded parks must hash the same before and after a port
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
2. **Know when memory can grow.** `init(size)` allocates the grid buffers once. Later, `walkers_reserve` (more than 1,024, 2,048… walkers), `trace_route` and `route_push` (route buffers growing) can allocate. Growing WebAssembly memory detaches every existing typed-array view, and growing a table can move it. So `core.ts` calls `afterAlloc()` after those calls, which rebuilds the views (`views()`) when either happened. Any new export that can allocate must do the same.
3. **Results are borrowed.** `core.dist` and `core.prev` hold the most recent BFS result. Use them before the next `bfs` call; never store them.
4. **Determinism is part of the contract.** Saves, replays and tests depend on seeded runs being identical. Ported code has to give exactly the TypeScript result:
   - Visit and iterate in the same order. For example, BFS checks neighbours as +x, −x, +y, −y.
   - Use `f64` everywhere the TypeScript uses `number`. `+ − × ÷` and `sqrt` are IEEE-exact in both languages, but `sin`, `cos`, `exp` and `pow` are not guaranteed to match V8's `Math`. Keep trigonometry in TypeScript until the whole system it feeds has moved, or replace it with a shared table or polynomial.
   - Random numbers: `park.rngState` stays the single source of truth, and it's saved with the park. A core call that draws random numbers gets it through the RNG cell (`rng_ptr`): JS writes the state in and reads the advanced state back (see `walkerAdvance` in `core.ts`). Both sides then draw from one stream in the same order. `rng.rs` is tested bit for bit against the TypeScript `rand()`.
5. **Bump `abi_version()`** in `lib.rs` and `ABI_VERSION` in `core.ts` when an export changes meaning. The loader refuses a mismatched `.wasm`.
6. **Every port gets a parity test** that runs the old TypeScript as a reference against the WASM output (see `tests/core.test.js`). **And the replay hashes in `tests/replay.test.js` must not change.** They were recorded with the pure-TypeScript simulation. They change only for deliberate gameplay changes, which update them in the same commit.
7. **Benchmark A/B, not once.** Timings on a shared machine vary by about ±30%. Run `npm run bench` on the previous commit and on yours, alternating two or three times each (`git worktree add` makes this easy).

## Walkers: state that lives in the core

Guests and staff are `GuestWalker` / `StaffWalker` instances (`walkers.ts`). Their `x, y, nx, ny, lx, ly, t` and `route` are getters and setters on the `CoreWalker` prototype. They read and write the walker's row in the core's table (`walkers.rs`, 8 f64 per slot). Everything else is an ordinary field. To the other ~200 places that use positions, a walker looks like a plain object, and movement (`walker_step`) runs in Rust on the same memory with no copying.

The rules that keep this fast and safe:
- **Routes never become JS arrays.** `traceRoute(walker, start, goal)` builds the route in the core from the last `bfs()`, and `advance()` follows it there. Simulation code uses `hasRoute`, `routeLeft` and `clearRoute`. A route can be absent or present-but-empty (JS `null` vs `[]`), and the simulation treats those differently, so the core tracks both. The `route` accessor copies the route in or out as an array, for tests and debugging only.
- **Create walkers only with `new GuestWalker(...)` / `new StaffWalker(...)`.** `moveActor` throws for anything else.
- **Declare every field in the class.** `implements Guest` makes the compiler enforce it. All walkers then share one V8 object shape. Two shortcuts were measured and rejected: per-object accessors were 2× slower, and swapping an object literal's prototype was 10× slower. Copying fields one at a time onto a fresh object also pushed V8 into dictionary mode.
- **Copy with `plainWalker()`, not spread.** Spread and `structuredClone` copy own properties only, so positions would be missing. `JSON.stringify` uses `toJSON()`, so saves need nothing special.
- **Free slots with `freeWalker()`** when a walker leaves: departed guests, fired or killed staff, or pandas dropped on load. A `FinalizationRegistry` reclaims slots of walkers dropped any other way, such as a whole park being replaced. A freed walker reads `undefined` and its writes go nowhere, so a stale reference can't corrupt a reused slot.

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
| 2 | Walker positions and movement (`moveActor`) | ~5% | **In WASM.** Positions are owned by the core. Speed is level with TypeScript, and replays are identical. |
| 2b | Routes, route following and wandering (`traceRoute`, `advance`) and the RNG | ~3% | **In WASM.** Routes live per walker in the core, wandering draws from the shared RNG stream, and replays are identical. |
| 3 | Guest update loop: `updateGuest`, `onArrive`, `decide`, `pickGoal` | ~35% | Next. Extend the walker table with needs (hunger, thirst, …) the same way as positions, then port the loop. Thoughts (strings) stay in JS, reported back as event codes. |
| 4 | Staff and security: `updateStaff`, guard chases, fights | ~3% | After guests. |
| 5 | Rides, shops and economy | ~3% | Small; port with the guest loop. |
| 6 | Coaster physics (`coaster.ts`) | builder only | Needs a decision on trigonometry (rule 4). |

**End state:** the core owns the park as flat arrays in its own memory. TypeScript keeps the UI, the save format (`types.ts` stays the schema; serialize/deserialize read and write core memory) and the actions allow-list. Snapshots for the page then become a straight copy of core buffers instead of a structured clone of objects. That removes the main-thread decode cost that profiling found to be the real bottleneck.
