//! Rollercoaster Mogul simulation core.
//!
//! Compiled to `wasm32-unknown-unknown` and loaded by `src/shared/core.ts`.
//! The ABI is deliberately plain: exported `extern "C"` functions taking and
//! returning numbers, plus pointers into this module's linear memory that the
//! TypeScript side wraps in typed-array views. No wasm-bindgen, no JS glue, so
//! the same `.wasm` file loads in the browser, the Web Worker and Node.
//!
//! Memory rule: the grid buffers are allocated once in `init()`. Only
//! `walkers_reserve` allocates afterwards; it can move the walker table and
//! grow memory, so JS re-reads `walkers_ptr()` and rebuilds its views after it.
//!
//! Migration status: pathfinding and walker movement live here. More systems move over one at a
//! time; see docs/WASM.md.

pub mod path;
pub mod walkers;

use path::Grid;
use walkers::Walkers;

static mut GRID: Option<Grid> = None;
static mut WALKERS: Walkers = Walkers { rows: Vec::new() };

#[allow(static_mut_refs)]
fn grid() -> &'static mut Grid {
    // SAFETY: wasm32-unknown-unknown is single-threaded and `init` runs first.
    unsafe { GRID.as_mut().expect("mogul-core: init() not called") }
}

#[allow(static_mut_refs)]
fn walkers() -> &'static mut Walkers {
    // SAFETY: wasm32-unknown-unknown is single-threaded.
    unsafe { &mut WALKERS }
}

/// ABI version. Bump when an export's meaning changes; the loader checks it.
#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> u32 {
    2
}

/// Allocates all buffers for a `size × size` map. Call once before anything else.
#[unsafe(no_mangle)]
pub extern "C" fn init(size: u32) {
    // SAFETY: single-threaded; called before any other export.
    unsafe { GRID = Some(Grid::new(size as usize)) };
}

/// Tile kinds, one byte per tile (0 grass, 1 path, 2 entrance). JS writes these.
#[unsafe(no_mangle)]
pub extern "C" fn tiles_ptr() -> *mut u8 {
    grid().tiles.as_mut_ptr()
}

/// BFS distances (-1 = unreachable), valid until the next `bfs` call.
#[unsafe(no_mangle)]
pub extern "C" fn dist_ptr() -> *const i16 {
    grid().dist.as_ptr()
}

/// BFS predecessors (-1 = none), valid until the next `bfs` call.
#[unsafe(no_mangle)]
pub extern "C" fn prev_ptr() -> *const i32 {
    grid().prev.as_ptr()
}

/// Breadth-first search over walkable tiles from `start`. Returns tiles reached.
#[unsafe(no_mangle)]
pub extern "C" fn bfs(start: u32, allow_entrance: u32) -> u32 {
    grid().bfs(start as usize, allow_entrance != 0) as u32
}

/// Makes room for at least `slots` walkers. May move the table and grow memory.
#[unsafe(no_mangle)]
pub extern "C" fn walkers_reserve(slots: u32) {
    walkers().reserve(slots as usize);
}

/// Walker table: `walkers::STRIDE` f64 per slot (x, y, nx, ny, lx, ly, t, spare).
#[unsafe(no_mangle)]
pub extern "C" fn walkers_ptr() -> *mut f64 {
    walkers().rows.as_mut_ptr()
}

/// Moves one walker for `dt` seconds at `speed` tiles/s. Returns 1 when it's
/// standing on a tile, ready for its next decision.
#[unsafe(no_mangle)]
pub extern "C" fn walker_step(slot: u32, dt: f64, speed: f64) -> u32 {
    let g = grid();
    walkers().step(slot as usize, dt, speed, &g.tiles, g.size) as u32
}
