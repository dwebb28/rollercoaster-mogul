//! Rollercoaster Mogul simulation core.
//!
//! Compiled to `wasm32-unknown-unknown` and loaded by `src/shared/core.ts`.
//! The ABI is deliberately plain: exported `extern "C"` functions taking and
//! returning numbers, plus pointers into this module's linear memory that the
//! TypeScript side wraps in typed-array views. No wasm-bindgen, no JS glue, so
//! the same `.wasm` file loads in the browser, the Web Worker and Node.
//!
//! Memory rule: every buffer is allocated once in `init()`. Nothing allocates
//! afterwards, so linear memory never grows and JS views stay valid.
//!
//! Migration status: pathfinding lives here. More systems move over one at a
//! time; see docs/WASM.md.

pub mod path;

use path::Grid;

static mut GRID: Option<Grid> = None;

#[allow(static_mut_refs)]
fn grid() -> &'static mut Grid {
    // SAFETY: wasm32-unknown-unknown is single-threaded and `init` runs first.
    unsafe { GRID.as_mut().expect("mogul-core: init() not called") }
}

/// ABI version. Bump when an export's meaning changes; the loader checks it.
#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> u32 {
    1
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
