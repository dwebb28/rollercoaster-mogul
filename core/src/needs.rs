//! Guest needs, owned by the core: the per-tick part of `updateGuest`.
//!
//! One row of `STRIDE` f64 per walker slot (staff slots stay unused):
//! happy, hunger, thirst, bladder, energy, nausea, thoughtT, timeIn.
//!
//! Every expression keeps the TypeScript evaluation order (`0.42 * h * dt *
//! pace` is `((0.42 * h) * dt) * pace`), so results are bit-identical.

use crate::rng;

pub const STRIDE: usize = 8;
pub const HAPPY: usize = 0;
pub const HUNGER: usize = 1;
pub const THIRST: usize = 2;
pub const BLADDER: usize = 3;
pub const ENERGY: usize = 4;
pub const NAUSEA: usize = 5;
pub const THOUGHT_T: usize = 6;
pub const TIME_IN: usize = 7;

/// Thoughts a needs tick can trigger. JS turns these into text.
pub const STARVING: u32 = 1;
pub const THIRSTY: u32 = 2;
pub const RESTROOM: u32 = 3;
pub const SICK: u32 = 4;
pub const WEATHER: u32 = 5;
/// Set alongside a thought when it also goes in the park's thought log.
pub const LOGGED: u32 = 0x100;

#[derive(Default)]
pub struct Needs {
    pub rows: Vec<f64>,
}

/// Inputs from the guest's type and the weather, resolved by JS.
pub struct Tick {
    pub dt: f64,
    /// 0.3 while riding, otherwise 1.
    pub pace: f64,
    pub type_hunger: f64,
    pub type_energy: f64,
    pub weather_thirst: f64,
    /// The weather's happiness drain, or 0 when it doesn't apply (indoors on a
    /// ride, sheltered by an umbrella, or the weather is pleasant).
    pub weather_drain: f64,
}

impl Needs {
    pub fn reserve(&mut self, slots: usize) {
        if self.rows.len() < slots * STRIDE {
            self.rows.resize(slots * STRIDE, 0.0);
        }
    }

    /// Advances one guest's needs. Returns the thought it had (0 for none),
    /// with `LOGGED` set when that thought also goes in the park log.
    pub fn tick(&mut self, slot: usize, k: &Tick, rng_state: &mut u32) -> u32 {
        let r = &mut self.rows[slot * STRIDE..slot * STRIDE + STRIDE];
        r[TIME_IN] += k.dt;
        r[THOUGHT_T] -= k.dt;
        r[HUNGER] = f64_min(100.0, r[HUNGER] + 0.42 * k.type_hunger * k.dt * k.pace);
        r[THIRST] = f64_min(100.0, r[THIRST] + 0.5 * k.weather_thirst * k.dt * k.pace);
        r[BLADDER] = f64_min(100.0, r[BLADDER] + 0.28 * k.dt * k.pace);
        r[ENERGY] = f64_max(0.0, r[ENERGY] - 0.18 * k.type_energy * k.dt * k.pace);
        r[NAUSEA] = f64_max(0.0, r[NAUSEA] - 1.2 * k.dt);

        let mut said = 0;
        // think(): a guest who's already thinking something stays quiet (and
        // draws no number); otherwise the thought sticks for 12 s and has a
        // 30% chance of going in the park log.
        let mut think = |r: &mut [f64], code: u32, rng_state: &mut u32| {
            if r[THOUGHT_T] > 0.0 {
                return;
            }
            r[THOUGHT_T] = 12.0;
            said = code | if rng::next(rng_state) < 0.3 { LOGGED } else { 0 };
        };

        let mut drain = 0.0;
        if r[HUNGER] > 85.0 { drain += 0.5; if rng::next(rng_state) < 0.02 { think(r, STARVING, rng_state); } }
        if r[THIRST] > 85.0 { drain += 0.5; if rng::next(rng_state) < 0.02 { think(r, THIRSTY, rng_state); } }
        if r[BLADDER] > 90.0 { drain += 0.8; if rng::next(rng_state) < 0.02 { think(r, RESTROOM, rng_state); } }
        if r[NAUSEA] > 60.0 { drain += 0.4; if rng::next(rng_state) < 0.02 { think(r, SICK, rng_state); } }
        if r[ENERGY] < 20.0 { drain += 0.2; }
        if k.weather_drain != 0.0 {
            drain += k.weather_drain;
            if rng::next(rng_state) < 0.004 { think(r, WEATHER, rng_state); }
        }
        r[HAPPY] = f64_max(0.0, f64_min(100.0, r[HAPPY] - drain * k.dt));
        said
    }
}

// JS Math.min / Math.max (no NaNs reach here, but keep the JS argument order).
fn f64_min(a: f64, b: f64) -> f64 { if b < a { b } else { a } }
fn f64_max(a: f64, b: f64) -> f64 { if b > a { b } else { a } }

#[cfg(test)]
mod tests {
    use super::*;

    fn tick(dt: f64) -> Tick {
        Tick { dt, pace: 1.0, type_hunger: 1.0, type_energy: 1.0, weather_thirst: 1.0, weather_drain: 0.0 }
    }

    #[test]
    fn needs_grow_and_cap() {
        let mut n = Needs::default();
        n.reserve(1);
        n.rows[HUNGER] = 99.9;
        n.rows[ENERGY] = 50.0;
        n.rows[HAPPY] = 80.0;
        let mut rng = 1;
        n.tick(0, &tick(1.0), &mut rng);
        assert_eq!(n.rows[HUNGER], 100.0);
        assert!((n.rows[ENERGY] - 49.82).abs() < 1e-12);
        assert_eq!(n.rows[HAPPY], 80.0 - 0.5);
        assert_eq!(n.rows[TIME_IN], 1.0);
    }

    #[test]
    fn a_thinking_guest_stays_quiet() {
        let mut n = Needs::default();
        n.reserve(1);
        n.rows[HUNGER] = 100.0;
        n.rows[THOUGHT_T] = 100.0;
        let mut rng = 7;
        for _ in 0..1000 {
            assert_eq!(n.tick(0, &tick(0.01), &mut rng), 0);
        }
    }
}
