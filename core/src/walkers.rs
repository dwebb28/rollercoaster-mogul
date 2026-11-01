//! Walkers (guests and staff): positions, routes and movement, owned by the core.
//!
//! Positions: one row of `STRIDE` f64 per slot: x, y, nx, ny, lx, ly, t, spare.
//! f64 everywhere because the TypeScript side treats these as `number`, and
//! the arithmetic has to match it bit for bit (see docs/WASM.md, rule 4).
//!
//! Routes: per slot, the tiles still to walk, stored reversed (the next step
//! is the last element) so taking a step is a pop. A route is either absent
//! (JS `null`) or present, and a present route may be empty (JS `[]`, which is
//! truthy): the simulation distinguishes the two, so we do too.
//!
//! Slots are handed out by `core.ts`; the tables grow on request.

use crate::path::{ENTRANCE, PATH};
use crate::rng;

pub const STRIDE: usize = 8;
pub const X: usize = 0;
pub const Y: usize = 1;
pub const NX: usize = 2;
pub const NY: usize = 3;
pub const LX: usize = 4;
pub const LY: usize = 5;
pub const T: usize = 6;

#[derive(Default)]
pub struct Walkers {
    pub rows: Vec<f64>,
    pub routes: Vec<Vec<u16>>,
    pub has_route: Vec<bool>,
}

impl Walkers {
    pub fn reserve(&mut self, slots: usize) {
        if self.rows.len() < slots * STRIDE {
            self.rows.resize(slots * STRIDE, 0.0);
            self.routes.resize_with(slots, Vec::new);
            self.has_route.resize(slots, false);
        }
    }

    pub fn clear_route(&mut self, slot: usize) {
        self.routes[slot].clear();
        self.has_route[slot] = false;
    }

    /// Steps left on the route, or -1 when there is none.
    pub fn route_len(&self, slot: usize) -> i32 {
        if self.has_route[slot] { self.routes[slot].len() as i32 } else { -1 }
    }

    /// Route from `start` to `goal` along BFS predecessors (former `traceRoute`).
    /// Returns false, leaving no route, when `goal` wasn't reached.
    pub fn trace(&mut self, slot: usize, start: usize, goal: usize, prev: &[i32]) -> bool {
        let r = &mut self.routes[slot];
        r.clear();
        let mut c = goal as i64;
        while c != start as i64 {
            if c < 0 || c as usize >= prev.len() {
                r.clear();
                self.has_route[slot] = false;
                return false;
            }
            r.push(c as u16);
            c = prev[c as usize] as i64;
        }
        self.has_route[slot] = true;
        true
    }

    /// One movement tick toward (nx, ny) (former `moveActor`). Returns true
    /// when the walker is standing on a tile, ready for its next decision.
    pub fn step(&mut self, slot: usize, dt: f64, speed: f64, tiles: &[u8], size: usize) -> bool {
        let r = &mut self.rows[slot * STRIDE..slot * STRIDE + STRIDE];
        if r[NX] == r[X] && r[NY] == r[Y] {
            return true; // standing still: ready for a decision
        }
        if !walkable_at(tiles, size, r[NX], r[NY]) {
            r[NX] = r[X];
            r[NY] = r[Y];
            r[T] = 0.0;
            return true;
        }
        r[T] += speed * dt;
        if r[T] < 1.0 {
            return false;
        }
        r[LX] = r[X];
        r[LY] = r[Y];
        r[X] = r[NX];
        r[Y] = r[NY];
        r[T] = 0.0;
        true
    }

    /// Sets the next tile from the route, or wanders (former `advance`).
    /// Returns false if the walker is boxed in.
    pub fn advance(&mut self, slot: usize, allow_entrance: bool, tiles: &[u8], size: usize, rng_state: &mut u32) -> bool {
        let base = slot * STRIDE;
        let (x, y) = (self.rows[base + X], self.rows[base + Y]);
        if self.has_route[slot] {
            if let Some(n) = self.routes[slot].pop() {
                let n = n as usize;
                let (nx, ny) = ((n % size) as f64, (n / size) as f64);
                if (nx - x).abs() + (ny - y).abs() == 1.0 && walkable(tiles[n]) {
                    self.rows[base + NX] = nx;
                    self.rows[base + NY] = ny;
                    return true;
                }
                self.clear_route(slot);
            }
        }
        // Wander: same neighbour order as the TypeScript DIRS.
        let mut options = [(0f64, 0f64); 4];
        let mut count = 0;
        for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
            let (ox, oy) = (x + dx, y + dy);
            if ox < 0.0 || oy < 0.0 || ox >= size as f64 || oy >= size as f64 {
                continue;
            }
            let t = tiles[oy as usize * size + ox as usize];
            if !walkable(t) || (!allow_entrance && t == ENTRANCE) {
                continue;
            }
            options[count] = (ox, oy);
            count += 1;
        }
        if count == 0 {
            self.rows[base + NX] = x;
            self.rows[base + NY] = y;
            return false;
        }
        let (lx, ly) = (self.rows[base + LX], self.rows[base + LY]);
        let mut forward = [(0f64, 0f64); 4];
        let mut fcount = 0;
        for &(ox, oy) in &options[..count] {
            if ox != lx || oy != ly {
                forward[fcount] = (ox, oy);
                fcount += 1;
            }
        }
        let (list, len) = if fcount > 0 { (&forward, fcount) } else { (&options, count) };
        let (ox, oy) = list[rng::pick(rng_state, len)];
        self.rows[base + NX] = ox;
        self.rows[base + NY] = oy;
        true
    }
}

fn walkable(t: u8) -> bool {
    t == PATH || t == ENTRANCE
}

fn walkable_at(tiles: &[u8], size: usize, x: f64, y: f64) -> bool {
    // Mirrors `park.tiles[y * GRID + x]` in JS, where an out-of-range index
    // reads `undefined` (not walkable). Positions are always whole numbers.
    let i = y * size as f64 + x;
    if !(i >= 0.0) || i >= tiles.len() as f64 || i.fract() != 0.0 {
        return false;
    }
    walkable(tiles[i as usize])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walks_onto_next_tile_and_remembers_last() {
        let tiles = [PATH, PATH, 0, 0];
        let mut w = Walkers::default();
        w.reserve(1);
        w.rows[NX] = 1.0; // from (0,0) toward (1,0)
        assert!(!w.step(0, 0.1, 4.0, &tiles, 2));
        assert!((w.rows[T] - 0.4).abs() < 1e-12);
        assert!(!w.step(0, 0.1, 4.0, &tiles, 2));
        assert!(w.step(0, 0.1, 4.0, &tiles, 2)); // t reaches 1.2
        assert_eq!((w.rows[X], w.rows[LX], w.rows[T]), (1.0, 0.0, 0.0));
    }

    #[test]
    fn stops_when_next_tile_is_gone() {
        let tiles = [PATH, 0];
        let mut w = Walkers::default();
        w.reserve(1);
        w.rows[NX] = 1.0;
        w.rows[T] = 0.5;
        assert!(w.step(0, 0.1, 1.0, &tiles, 2));
        assert_eq!((w.rows[NX], w.rows[T]), (0.0, 0.0));
    }

    #[test]
    fn follows_a_traced_route_then_keeps_an_empty_one() {
        // 3x1 corridor; prev from a BFS rooted at 0.
        let tiles = [PATH, PATH, PATH];
        let prev = [-1, 0, 1];
        let mut w = Walkers::default();
        w.reserve(1);
        assert!(w.trace(0, 0, 2, &prev));
        assert_eq!(w.route_len(0), 2);
        let mut rng = 1;
        assert!(w.advance(0, false, &tiles, 3, &mut rng));
        assert_eq!(w.rows[NX], 1.0);
        assert_eq!(rng, 1, "route steps draw no random numbers");
        w.rows[X] = 1.0;
        assert!(w.advance(0, false, &tiles, 3, &mut rng));
        assert_eq!(w.rows[NX], 2.0);
        assert_eq!(w.route_len(0), 0, "an exhausted route stays present, like JS []");
    }

    #[test]
    fn unreachable_goal_leaves_no_route() {
        let mut w = Walkers::default();
        w.reserve(1);
        assert!(!w.trace(0, 0, 2, &[-1, 0, -1]));
        assert_eq!(w.route_len(0), -1);
    }
}
