//! The park's objects as the simulation's decisions see them (rides, shops,
//! scenery), one row per object in `park.objects` order, plus their access
//! tiles. JS rebuilds the table when placement changes and updates a row's
//! live fields (open, broken, price, queue length, ride stats) whenever they
//! change. See `syncObjects` / `touchObject` in sim.ts.
//!
//! Hosts `pick_goal`, the scoring loop of the former TypeScript `pickGoal`.

use crate::rng;

pub const STRIDE: usize = 10;
pub const FLAGS: usize = 0;
pub const SELLS: usize = 1;
pub const INTENSITY: usize = 2;
pub const EXCITEMENT: usize = 3;
pub const PRICE: usize = 4;
pub const QUEUE: usize = 5;
pub const ACCESS_START: usize = 6;
pub const ACCESS_LEN: usize = 7;
/// Times the deciding guest has ridden this object (JS fills it per call).
pub const RIDDEN: usize = 8;

pub const IS_RIDE: f64 = 1.0; // has a ride definition and a queue
pub const SEAT: f64 = 2.0; // scenery you can sit on
pub const OPEN: f64 = 4.0;
pub const BROKEN: f64 = 8.0;

/// `need` value for "somewhere to sit"; other needs are SELLS codes (> 0).
pub const NEED_SEAT: u32 = 255;

#[derive(Default)]
pub struct Objects {
    pub rows: Vec<f64>,
    pub access: Vec<u16>,
    pub count: usize,
}

fn has(flags: f64, bit: f64) -> bool {
    (flags as u32) & (bit as u32) != 0
}

impl Objects {
    pub fn reserve(&mut self, objects: usize, access: usize) {
        if self.rows.len() < objects * STRIDE {
            self.rows.resize(objects * STRIDE, 0.0);
        }
        if self.access.len() < access {
            self.access.resize(access, 0);
        }
    }

    /// The scoring loop of `pickGoal`. With `need` 0 the guest wants a ride;
    /// otherwise a shop selling `need`, or a seat. Uses the last BFS `dist`.
    /// Returns (object index, goal tile), or None when nothing qualifies.
    pub fn pick_goal(&self, need: u32, pref: f64, cash: f64, dist: &[i16], rng_state: &mut u32) -> Option<(usize, usize)> {
        let mut best: Option<(usize, usize)> = None;
        let mut best_score = f64::NEG_INFINITY;
        for i in 0..self.count {
            let r = &self.rows[i * STRIDE..i * STRIDE + STRIDE];
            let (start, len) = (r[ACCESS_START] as usize, r[ACCESS_LEN] as usize);
            if len == 0 {
                continue;
            }
            let flags = r[FLAGS];
            let mut score;
            if need != 0 {
                let ok = if need == NEED_SEAT {
                    has(flags, SEAT)
                } else {
                    r[SELLS] as u32 == need && has(flags, OPEN)
                };
                if !ok {
                    continue;
                }
                score = 0.0;
            } else {
                if !has(flags, IS_RIDE) || !has(flags, OPEN) || has(flags, BROKEN)
                    || r[INTENSITY] > pref + 2.0 || r[PRICE] > cash
                {
                    continue;
                }
                score = r[EXCITEMENT] * 10.0 - r[RIDDEN] * 18.0 - r[QUEUE] * 1.5 + rng::next(rng_state) * 12.0;
            }
            // nearestAccess: the first access tile with the smallest distance.
            let mut goal: Option<usize> = None;
            for &a in &self.access[start..start + len] {
                let a = a as usize;
                if dist[a] >= 0 && goal.is_none_or(|g| dist[a] < dist[g]) {
                    goal = Some(a);
                }
            }
            let Some(goal) = goal else { continue };
            score -= dist[goal] as f64 * if need != 0 { 1.0 } else { 0.6 };
            if score > best_score {
                best_score = score;
                best = Some((i, goal));
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(rows: &[[f64; STRIDE]], access: &[u16]) -> Objects {
        let mut o = Objects::default();
        o.reserve(rows.len(), access.len());
        for (i, r) in rows.iter().enumerate() {
            o.rows[i * STRIDE..i * STRIDE + STRIDE].copy_from_slice(r);
        }
        o.access[..access.len()].copy_from_slice(access);
        o.count = rows.len();
        o
    }

    #[test]
    fn needs_pick_the_nearest_matching_shop() {
        // Two drink stalls (sells 3), one closed; one food stall (sells 4).
        let mut r = [[0.0; STRIDE]; 3];
        r[0][FLAGS] = OPEN; r[0][SELLS] = 3.0; r[0][ACCESS_START] = 0.0; r[0][ACCESS_LEN] = 1.0;
        r[1][FLAGS] = 0.0; r[1][SELLS] = 3.0; r[1][ACCESS_START] = 1.0; r[1][ACCESS_LEN] = 1.0;
        r[2][FLAGS] = OPEN; r[2][SELLS] = 4.0; r[2][ACCESS_START] = 2.0; r[2][ACCESS_LEN] = 1.0;
        let o = table(&r, &[5, 1, 2]);
        let dist = [0, 1, 2, 3, 4, 5];
        let mut rng = 1;
        assert_eq!(o.pick_goal(3, 5.0, 100.0, &dist, &mut rng), Some((0, 5)));
        assert_eq!(o.pick_goal(4, 5.0, 100.0, &dist, &mut rng), Some((2, 2)));
        assert_eq!(o.pick_goal(9, 5.0, 100.0, &dist, &mut rng), None);
        assert_eq!(rng, 1, "need-based choices draw no random numbers");
    }

    #[test]
    fn rides_respect_intensity_price_and_reachability() {
        let mut r = [[0.0; STRIDE]; 2];
        r[0][FLAGS] = IS_RIDE + OPEN; r[0][INTENSITY] = 9.0; r[0][EXCITEMENT] = 9.0; r[0][ACCESS_LEN] = 1.0;
        r[1][FLAGS] = IS_RIDE + OPEN; r[1][INTENSITY] = 3.0; r[1][EXCITEMENT] = 2.0; r[1][PRICE] = 5.0;
        r[1][ACCESS_START] = 1.0; r[1][ACCESS_LEN] = 1.0;
        let o = table(&r, &[0, 1]);
        let dist = [3, -1];
        let mut rng = 1;
        assert_eq!(o.pick_goal(0, 5.0, 100.0, &dist, &mut rng), None, "too intense, and the other is unreachable");
        let dist = [3, 2];
        assert_eq!(o.pick_goal(0, 5.0, 4.0, &dist, &mut rng), None, "can't afford it");
        assert_eq!(o.pick_goal(0, 5.0, 10.0, &dist, &mut rng), Some((1, 1)));
    }
}
