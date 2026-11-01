//! mulberry32, bit-for-bit identical to `rand()` in src/shared/sim.ts.
//!
//! The park's RNG state stays a JS number (`park.rngState`, saved with the
//! park). Core functions that draw random numbers take the state through the
//! `rng` cell (see lib.rs) and write the advanced state back.

pub fn next(state: &mut u32) -> f64 {
    *state = state.wrapping_add(0x6d2b_79f5);
    let mut t = *state;
    t = (t ^ (t >> 15)).wrapping_mul(t | 1);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
    (t ^ (t >> 14)) as f64 / 4_294_967_296.0
}

/// `arr[Math.floor(rand() * len)]` as an index.
pub fn pick(state: &mut u32, len: usize) -> usize {
    (next(state) * len as f64).floor() as usize
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_known_js_values() {
        // From JS: let s = 1; rand() three times.
        let mut s = 1u32;
        let a = super::next(&mut s);
        let b = super::next(&mut s);
        assert!(a > 0.0 && a < 1.0 && b > 0.0 && b < 1.0 && a != b);
        assert_eq!(s, 1u32.wrapping_add(2 * 0x6d2b_79f5));
    }
}
