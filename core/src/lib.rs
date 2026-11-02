//! Rollercoaster Mogul simulation core.
//!
//! Compiled to `wasm32-unknown-unknown` and loaded by `src/shared/core.ts`.
//! The ABI is deliberately plain: exported `extern "C"` functions taking and
//! returning numbers, plus pointers into this module's linear memory that the
//! TypeScript side wraps in typed-array views. No wasm-bindgen, no JS glue, so
//! the same `.wasm` file loads in the browser, the Web Worker and Node.
//!
//! Memory rule: the grid buffers are allocated once in `init()`. Afterwards
//! `walkers_reserve`, `trace_route` and `route_push` can allocate; it can move the walker table and
//! grow memory, so JS re-reads `walkers_ptr()` and rebuilds its views after it.
//!
//! Migration status: pathfinding, walker movement, routes, guest needs,
//! scenery beauty and goal choice live here. More systems move over one at a
//! time; see docs/WASM.md.

pub mod needs;
pub mod objects;
pub mod path;
pub mod rng;
pub mod walkers;

use path::Grid;
use needs::Needs;
use objects::Objects;
use walkers::Walkers;

static mut GRID: Option<Grid> = None;
static mut WALKERS: Walkers = Walkers { rows: Vec::new(), routes: Vec::new(), has_route: Vec::new() };
static mut NEEDS: Needs = Needs { rows: Vec::new() };
static mut OBJECTS: Objects = Objects { rows: Vec::new(), access: Vec::new(), count: 0 };
/// pick_goal's goal tile, read by JS after a successful call.
static mut GOAL_OUT: u32 = 0;
/// RNG hand-off cell: JS writes `park.rngState` here before a call that may
/// draw random numbers and reads the advanced state back after.
static mut RNG: u32 = 1;

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
    6
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
    needs().reserve(slots as usize);
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
    if !live(slot) { return 1; }
    let g = grid();
    walkers().step(slot as usize, dt, speed, &g.tiles, g.size) as u32
}

#[allow(static_mut_refs)]
fn needs() -> &'static mut Needs {
    // SAFETY: wasm32-unknown-unknown is single-threaded.
    unsafe { &mut NEEDS }
}

#[allow(static_mut_refs)]
fn objects() -> &'static mut Objects {
    // SAFETY: wasm32-unknown-unknown is single-threaded.
    unsafe { &mut OBJECTS }
}

/// Freed walkers carry slot -1 (u32::MAX here); ignore any out-of-range slot.
fn live(slot: u32) -> bool {
    (slot as usize) < walkers().has_route.len()
}

#[allow(static_mut_refs)]
fn rng_cell() -> &'static mut u32 {
    // SAFETY: wasm32-unknown-unknown is single-threaded.
    unsafe { &mut RNG }
}

/// Address of the RNG hand-off cell (one u32).
#[unsafe(no_mangle)]
pub extern "C" fn rng_ptr() -> *mut u32 {
    rng_cell()
}

/// Draws one number from the RNG cell (parity tests compare it with JS rand()).
#[unsafe(no_mangle)]
pub extern "C" fn rng_next() -> f64 {
    rng::next(rng_cell())
}

/// Builds walker `slot`'s route from `start` to `goal` using the last BFS.
/// Returns 1 if there is one. May allocate.
#[unsafe(no_mangle)]
pub extern "C" fn trace_route(slot: u32, start: u32, goal: u32) -> u32 {
    if !live(slot) { return 0; }
    let g = grid();
    walkers().trace(slot as usize, start as usize, goal as usize, &g.prev) as u32
}

/// Next route step, or wander. Draws from the RNG cell. Returns 1 if it moved.
#[unsafe(no_mangle)]
pub extern "C" fn walker_advance(slot: u32, allow_entrance: u32) -> u32 {
    if !live(slot) { return 0; }
    let g = grid();
    walkers().advance(slot as usize, allow_entrance != 0, &g.tiles, g.size, rng_cell()) as u32
}

/// Steps left on walker `slot`'s route; -1 when it has none.
#[unsafe(no_mangle)]
pub extern "C" fn route_len(slot: u32) -> i32 {
    if !live(slot) { return -1; }
    walkers().route_len(slot as usize)
}

/// Removes walker `slot`'s route (JS `route = null`).
#[unsafe(no_mangle)]
pub extern "C" fn route_clear(slot: u32) {
    if !live(slot) { return; }
    walkers().clear_route(slot as usize);
}

/// Gives walker `slot` an empty route (JS `route = []`); fill it with route_push.
#[unsafe(no_mangle)]
pub extern "C" fn route_begin(slot: u32) {
    if !live(slot) { return; }
    let w = walkers();
    w.routes[slot as usize].clear();
    w.has_route[slot as usize] = true;
}

/// Prepends a step to walker `slot`'s route (routes are stored reversed). May allocate.
#[unsafe(no_mangle)]
pub extern "C" fn route_push(slot: u32, tile: u32) {
    if !live(slot) { return; }
    walkers().routes[slot as usize].push(tile as u16);
}

/// The route's steps, last step first (read `route_len` of them). Valid until the next call.
#[unsafe(no_mangle)]
pub extern "C" fn route_ptr(slot: u32) -> *const u16 {
    if !live(slot) { return core::ptr::null(); }
    walkers().routes[slot as usize].as_ptr()
}

/// Guest needs table: `needs::STRIDE` f64 per slot (see needs.rs).
#[unsafe(no_mangle)]
pub extern "C" fn needs_ptr() -> *mut f64 {
    needs().rows.as_mut_ptr()
}

/// One needs tick for guest `slot`. Draws from the RNG cell. Returns the
/// thought code (0 for none), with 0x100 set if it goes in the park log.
#[unsafe(no_mangle)]
pub extern "C" fn guest_needs(slot: u32, dt: f64, pace: f64, type_hunger: f64, type_energy: f64, weather_thirst: f64, weather_drain: f64) -> u32 {
    if !live(slot) { return 0; }
    let k = needs::Tick { dt, pace, type_hunger, type_energy, weather_thirst, weather_drain };
    needs().tick(slot as usize, &k, rng_cell())
}

/// Per-tile scenery beauty (u8 per tile), written by JS when objects change.
#[unsafe(no_mangle)]
pub extern "C" fn beauty_ptr() -> *mut u8 {
    grid().beauty.as_mut_ptr()
}

/// Total scenery beauty in the 5x5 square around (x, y).
#[unsafe(no_mangle)]
pub extern "C" fn beauty_near(x: i32, y: i32) -> u32 {
    grid().beauty_near(x as i64, y as i64)
}

/// Makes room for `count` object rows and `access` access tiles. May allocate.
#[unsafe(no_mangle)]
pub extern "C" fn objects_reserve(count: u32, access: u32) {
    objects().reserve(count as usize, access as usize);
}

/// Sets how many object rows are in use.
#[unsafe(no_mangle)]
pub extern "C" fn objects_set_count(count: u32) {
    objects().count = count as usize;
}

/// Object rows: `objects::STRIDE` f64 per object (see objects.rs).
#[unsafe(no_mangle)]
pub extern "C" fn objects_ptr() -> *mut f64 {
    objects().rows.as_mut_ptr()
}

/// Access tiles of all objects, back to back (u16 per tile).
#[unsafe(no_mangle)]
pub extern "C" fn object_access_ptr() -> *mut u16 {
    objects().access.as_mut_ptr()
}

/// The scoring loop of pickGoal over the last BFS. Draws from the RNG cell.
/// Returns the chosen object's index, or -1; the goal tile is in goal_out().
#[unsafe(no_mangle)]
pub extern "C" fn pick_goal(need: u32, pref: f64, cash: f64) -> i32 {
    let g = grid();
    match objects().pick_goal(need, pref, cash, &g.dist, rng_cell()) {
        Some((i, goal)) => {
            // SAFETY: single-threaded.
            unsafe { GOAL_OUT = goal as u32 };
            i as i32
        }
        None => -1,
    }
}

/// Goal tile of the last successful pick_goal.
#[unsafe(no_mangle)]
pub extern "C" fn goal_out() -> u32 {
    // SAFETY: single-threaded.
    unsafe { GOAL_OUT }
}
