//! Walker positions (guests and staff), owned by the core.
//!
//! One row of `STRIDE` f64 per walker slot: x, y, nx, ny, lx, ly, t, spare.
//! f64 everywhere because the TypeScript side treats these as `number`, and
//! the arithmetic has to match it bit for bit (see docs/WASM.md, rule 4).
//! Slots are handed out by `core.ts`; the table grows on request.

use crate::path::{ENTRANCE, PATH};

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
}

impl Walkers {
    pub fn reserve(&mut self, slots: usize) {
        if self.rows.len() < slots * STRIDE {
            self.rows.resize(slots * STRIDE, 0.0);
        }
    }

    /// One movement tick toward (nx, ny). Returns true when the walker is
    /// standing on a tile and ready for its next decision. This is the
    /// former TypeScript `moveActor`, step for step.
    pub fn step(&mut self, slot: usize, dt: f64, speed: f64, tiles: &[u8], size: usize) -> bool {
        let r = &mut self.rows[slot * STRIDE..slot * STRIDE + STRIDE];
        if r[NX] == r[X] && r[NY] == r[Y] {
            return true; // standing still: ready for a decision
        }
        if !walkable(tiles, size, r[NX], r[NY]) {
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
}

fn walkable(tiles: &[u8], size: usize, x: f64, y: f64) -> bool {
    // Mirrors `park.tiles[y * GRID + x]` in JS, where an out-of-range index
    // reads `undefined` (not walkable). Positions are always whole numbers.
    let i = y * size as f64 + x;
    if !(i >= 0.0) || i >= tiles.len() as f64 || i.fract() != 0.0 {
        return false;
    }
    let t = tiles[i as usize];
    t == PATH || t == ENTRANCE
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
}
