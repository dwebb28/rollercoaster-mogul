//! Grid pathfinding: the hottest code in the simulation (~30% of a step).

pub const GRASS: u8 = 0;
pub const PATH: u8 = 1;
pub const ENTRANCE: u8 = 2;

pub struct Grid {
    pub size: usize,
    pub tiles: Vec<u8>,
    /// Beauty of the scenery standing on each tile (0 for none), synced by JS.
    pub beauty: Vec<u8>,
    pub dist: Vec<i16>,
    pub prev: Vec<i32>,
    queue: Vec<u32>,
}

impl Grid {
    pub fn new(size: usize) -> Self {
        let n = size * size;
        Grid { size, tiles: vec![GRASS; n], beauty: vec![0; n], dist: vec![-1; n], prev: vec![-1; n], queue: vec![0; n] }
    }

    /// Total scenery beauty in the 5x5 square around (x, y): the former
    /// TypeScript loop in onArrive. Whole numbers, so summation order is moot.
    pub fn beauty_near(&self, x: i64, y: i64) -> u32 {
        let size = self.size as i64;
        let mut sum = 0u32;
        for yy in (y - 2)..=(y + 2) {
            for xx in (x - 2)..=(x + 2) {
                if xx >= 0 && yy >= 0 && xx < size && yy < size {
                    sum += self.beauty[(yy * size + xx) as usize] as u32;
                }
            }
        }
        sum
    }

    /// Same visiting order as the original TypeScript (+x, -x, +y, -y), so
    /// routes, and therefore the seeded simulation, are bit-for-bit identical.
    pub fn bfs(&mut self, start: usize, allow_entrance: bool) -> usize {
        let size = self.size;
        let n = size * size;
        self.dist.fill(-1);
        self.prev.fill(-1);
        if start >= n {
            return 0;
        }
        let (mut head, mut tail) = (0usize, 0usize);
        self.queue[tail] = start as u32;
        tail += 1;
        self.dist[start] = 0;
        while head < tail {
            let c = self.queue[head] as usize;
            head += 1;
            let (cx, cy) = (c % size, c / size);
            let d = self.dist[c] + 1;
            let mut visit = |i: usize, this: &mut Self| {
                if this.dist[i] >= 0 {
                    return;
                }
                let t = this.tiles[i];
                if t == PATH || (t == ENTRANCE && allow_entrance) {
                    this.dist[i] = d;
                    this.prev[i] = c as i32;
                    this.queue[tail] = i as u32;
                    tail += 1;
                }
            };
            if cx + 1 < size { visit(c + 1, self); }
            if cx > 0 { visit(c - 1, self); }
            if cy + 1 < size { visit(c + size, self); }
            if cy > 0 { visit(c - size, self); }
        }
        tail
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_shortest_route_and_respects_entrance() {
        let mut g = Grid::new(4);
        // Row 0: path path path entrance
        g.tiles[0] = PATH; g.tiles[1] = PATH; g.tiles[2] = PATH; g.tiles[3] = ENTRANCE;
        assert_eq!(g.bfs(0, false), 3);
        assert_eq!(g.dist[2], 2);
        assert_eq!(g.dist[3], -1);
        assert_eq!(g.bfs(0, true), 4);
        assert_eq!(g.dist[3], 3);
        assert_eq!(g.prev[3], 2);
    }

    #[test]
    fn beauty_sums_the_5x5_square_and_clips_at_edges() {
        let mut g = Grid::new(6);
        g.beauty[0] = 3; // (0,0)
        g.beauty[2 * 6 + 2] = 10; // (2,2)
        g.beauty[5 * 6 + 5] = 7; // (5,5): outside the square around (1,1)
        assert_eq!(g.beauty_near(1, 1), 13);
        assert_eq!(g.beauty_near(4, 4), 17);
        assert_eq!(g.beauty_near(0, 5), 0);
    }

    #[test]
    fn start_tile_is_reached_even_if_not_walkable() {
        let mut g = Grid::new(3);
        g.tiles[1] = PATH;
        assert_eq!(g.bfs(0, false), 2);
        assert_eq!(g.dist[0], 0);
        assert_eq!(g.dist[1], 1);
    }
}
