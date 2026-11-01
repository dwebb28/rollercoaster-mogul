// Custom roller coasters: track pieces, 3D layout, and train physics.
// Pure logic shared by the sim, the renderer, and the server.
//
// Units: 1 tile = 1 world unit = 4 m. Track height is measured in "steps"
// of a quarter world unit (1 m).

import type { CoasterStart, CoasterDesign, PieceType } from './types.ts';

export interface PieceDef {
  name: string;
  cost: number;
  /** Tiles travelled forward. */
  len: number;
  /** Height change in steps (1 m each). */
  dh: number;
  icon: string;
  station?: boolean;
  /** −1 left, +1 right. */
  turn?: -1 | 1;
  wide?: boolean;
  chain?: boolean;
  boost?: boolean;
  brake?: boolean;
  loop?: boolean;
}

/** One placed piece: its tiles and heights. */
export interface Segment {
  type: PieceType;
  x: number;
  y: number;
  dirIn: number;
  dirOut: number;
  h0: number;
  h1: number;
  cells: { x: number; y: number }[];
}

/** Where the next piece would start. */
export interface Cursor {
  x: number;
  y: number;
  dir: number;
  h: number;
}

export interface Layout {
  segs: Segment[];
  cursor: Cursor;
  error?: string;
}

/** A point on the track centreline (world units) with the rider's "up". */
export interface TrackSample {
  x: number;
  y: number;
  z: number;
  up: Vec3;
  seg: number;
  chain: boolean;
  boost: boolean;
  brake: boolean;
  station: boolean;
  loop: boolean;
}

type Vec3 = [number, number, number];

export const DIRS: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
export const STEP = 0.25; // world units per height step
export const METERS = 4; // meters per world unit
export const MAX_STEPS = 48; // 48 m tall
export const CROSS_CLEARANCE = 4; // height steps needed to pass over own track
const G = 9.81;

export const PIECES: Record<PieceType, PieceDef> = {
  station: { name: 'Station', cost: 300, len: 1, dh: 0, icon: '🚉', station: true },
  straight: { name: 'Straight', cost: 60, len: 1, dh: 0, icon: '⬆' },
  left: { name: 'Tight left', cost: 90, len: 1, dh: 0, icon: '↰', turn: -1 },
  right: { name: 'Tight right', cost: 90, len: 1, dh: 0, icon: '↱', turn: 1 },
  wideLeft: { name: 'Wide left', cost: 200, len: 1, dh: 0, icon: '⮪', turn: -1, wide: true },
  wideRight: { name: 'Wide right', cost: 200, len: 1, dh: 0, icon: '⮫', turn: 1, wide: true },
  up: { name: 'Slope up', cost: 80, len: 1, dh: 1, icon: '↗' },
  down: { name: 'Slope down', cost: 80, len: 1, dh: -1, icon: '↘' },
  steepUp: { name: 'Steep climb', cost: 110, len: 1, dh: 3, icon: '⤴' },
  steepDown: { name: 'Steep drop', cost: 110, len: 1, dh: -3, icon: '⤵' },
  lift: { name: 'Chain lift', cost: 200, len: 1, dh: 2, icon: '⛓', chain: true },
  booster: { name: 'Launch booster', cost: 450, len: 1, dh: 0, icon: '⚡', boost: true },
  brake: { name: 'Brakes', cost: 150, len: 1, dh: 0, icon: '⏸', brake: true },
  loop: { name: 'Vertical loop', cost: 900, len: 4, dh: 0, icon: '➰', loop: true },
};

export const PHYSICS = {
  stationSpeed: 2, // m/s, tyres push the train out of (and into) the station
  chainSpeed: 4, // m/s up a chain lift
  boostAccel: 1.2, // m/s gained per meter of booster
  boostMax: 32, // m/s (115 km/h)
  brakeSpeed: 5, // m/s: brake runs hold the train at this speed
  drag: 0.0006, // air resistance per meter, proportional to v²
  rolling: 0.012, // rolling resistance coefficient
  loopRadius: 2.0, // world units (8 m)
  maxBank: Math.PI / 3, // turns bank up to 60° to cancel sideways force
};

/**
 * Lays out pieces from the start tile. Returns each segment's tiles and
 * heights plus the cursor where the next piece would begin.
 */
export function layout(start: CoasterStart, pieces: readonly string[]): Layout {
  let x = start.x, y = start.y, d = start.dir, h = 0;
  const segs: Segment[] = [];
  for (const type of pieces as PieceType[]) {
    const def: PieceDef | undefined = PIECES[type];
    if (!def) return { segs, cursor: { x, y, dir: d, h }, error: `Unknown piece ${type}` };
    const dirOut = def.turn ? (d + def.turn + 4) % 4 : d;
    const cells: Segment['cells'] = [];
    if (def.wide) {
      const [dx, dy] = DIRS[d]!, [ox, oy] = DIRS[dirOut]!;
      cells.push({ x, y }, { x: x + dx, y: y + dy }, { x: x + dx + ox, y: y + dy + oy });
    } else {
      for (let k = 0; k < def.len; k++) cells.push({ x: x + DIRS[d]![0] * k, y: y + DIRS[d]![1] * k });
    }
    const seg: Segment = { type, x, y, dirIn: d, dirOut, h0: h, h1: h + def.dh, cells };
    segs.push(seg);
    const last = cells[cells.length - 1];
    x = last.x + DIRS[dirOut][0];
    y = last.y + DIRS[dirOut][1];
    d = dirOut;
    h = seg.h1;
  }
  return { segs, cursor: { x, y, dir: d, h } };
}

export function isComplete(start: CoasterStart, pieces: readonly string[]): boolean {
  if (pieces.length < 2 || pieces[0] !== 'station') return false;
  const { cursor } = layout(start, pieces);
  return cursor.x === start.x && cursor.y === start.y && cursor.dir === start.dir && cursor.h === 0;
}

export const designCost = (pieces: readonly string[]): number =>
  pieces.reduce((n, p) => n + (PIECES[p as PieceType]?.cost || 0), 0);

// ---------------------------------------------------------------------------
// Geometry: sample the track centreline in world units.
// x/z are tile coordinates, y is height. Each sample also carries the
// rider's "up" direction (inverted at the top of a loop).
// ---------------------------------------------------------------------------

const hermite = (p0: number, p1: number, m0: number, m1: number, t: number): number => {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
};

export function samples(start: CoasterStart, pieces: readonly string[], perTile = 10): TrackSample[] {
  const { segs } = layout(start, pieces);
  const grades = segs.map((s) => (s.h1 - s.h0) * STEP / PIECES[s.type].len);
  const n = segs.length;
  const out: TrackSample[] = [];
  segs.forEach((s, i) => {
    const def = PIECES[s.type];
    // Smooth height: slopes at each joint are the average of neighbouring grades.
    const prev = grades[(i - 1 + n) % n]!, next = grades[(i + 1) % n]!, g = grades[i]!;
    const m0 = ((prev + g) / 2) * def.len, m1 = ((g + next) / 2) * def.len;
    const y0 = s.h0 * STEP, y1 = s.h1 * STEP;
    const [dx, dz] = DIRS[s.dirIn]!;
    const ex = s.x + 0.5 - dx * 0.5, ez = s.y + 0.5 - dz * 0.5; // entry edge midpoint
    const count = def.loop ? perTile * 8 : def.wide ? perTile * 3 : perTile * def.len;
    for (let k = 0; k < count; k++) {
      const u = k / count;
      let px: number, pz: number, py: number, up: Vec3 = [0, 1, 0];
      if (def.wide) {
        // Quarter circle of radius 1.5 tiles around a point beside the entry.
        const [ox, oz] = DIRS[s.dirOut]!;
        const cx = ex + ox * 1.5, cz = ez + oz * 1.5;
        const a = u * Math.PI / 2;
        px = cx - ox * 1.5 * Math.cos(a) + dx * 1.5 * Math.sin(a);
        pz = cz - oz * 1.5 * Math.cos(a) + dz * 1.5 * Math.sin(a);
        py = hermite(y0, y1, m0, m1, u);
      } else if (def.turn) {
        const [ox, oz] = DIRS[s.dirOut]!;
        const cx = s.x + 0.5, cz = s.y + 0.5;
        const xx = cx + ox * 0.5, xz = cz + oz * 0.5; // exit edge midpoint
        px = (1 - u) ** 2 * ex + 2 * u * (1 - u) * cx + u * u * xx;
        pz = (1 - u) ** 2 * ez + 2 * u * (1 - u) * cz + u * u * xz;
        py = hermite(y0, y1, m0, m1, u);
      } else if (def.loop) {
        const r = PHYSICS.loopRadius, a = u * Math.PI * 2;
        const along = u * def.len + r * Math.sin(a) * 0.95;
        const side = (u - 0.5) * 0.6; // corkscrew offset so the loop clears itself
        px = ex + dx * along - dz * side;
        pz = ez + dz * along + dx * side;
        py = y0 + r * (1 - Math.cos(a));
        up = [-dx * Math.sin(a), Math.cos(a), -dz * Math.sin(a)]; // points at the loop centre
      } else {
        px = ex + dx * u * def.len;
        pz = ez + dz * u * def.len;
        py = hermite(y0, y1, m0, m1, u);
      }
      out.push({
        x: px, y: Math.max(0.05, py), z: pz, up, seg: i,
        chain: !!def.chain, boost: !!def.boost, brake: !!def.brake, station: !!def.station, loop: !!def.loop,
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = len(a) || 1; return scale(a, 1 / l); };
const toM = (s: TrackSample): Vec3 => [s.x * METERS, s.y * METERS, s.z * METERS];

/**
 * Runs a train once around the circuit. Returns ride statistics, or
 * { ok: false, reason, seg } if the train can't make it.
 */
export function simulate(start: CoasterStart, pieces: readonly string[]): CoasterDesign {
  if (!isComplete(start, pieces)) return { ok: false, reason: 'The track must return to the station.' };
  const pts = samples(start, pieces);
  const n = pts.length;
  const P = pts.map(toM);
  const speed = new Float64Array(n + 1);
  const time = new Float64Array(n + 1);
  let v = PHYSICS.stationSpeed;
  speed[0] = v;
  let length = 0;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n], q = pts[(i + 1) % n];
    const ds = len(sub(b, a));
    const dy = b[1] - a[1];
    let v2 = v * v - 2 * G * dy - 2 * (PHYSICS.drag * v * v + PHYSICS.rolling * G) * ds;
    if (q.chain) v2 = Math.max(v2, PHYSICS.chainSpeed ** 2);
    if (q.boost) v2 = Math.min((Math.sqrt(Math.max(0, v2)) + PHYSICS.boostAccel * ds) ** 2, PHYSICS.boostMax ** 2);
    if (q.brake) v2 = PHYSICS.brakeSpeed ** 2; // brakes double as drive tyres
    if (q.station) v2 = PHYSICS.stationSpeed ** 2;
    if (v2 <= 0.05) {
      const seg = q.seg;
      return {
        ok: false, seg,
        reason: pts[i].loop || q.loop
          ? `The train didn't have enough speed for the loop (piece ${seg + 1}) and fell back.`
          : `The train ran out of speed on piece ${seg + 1} and rolled back. Add a chain lift or a bigger drop.`,
      };
    }
    const vn = Math.sqrt(v2);
    time[i + 1] = time[i] + ds / ((v + vn) / 2);
    speed[i + 1] = vn;
    length += ds;
    v = vn;
  }

  // Forces felt by riders, from the curvature of the path.
  let maxSpeed = 0, maxG = 1, minG = 1, maxLat = 0, airtime = 0;
  const gv = new Float64Array(n), gl = new Float64Array(n), bank = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n];
    const d1 = sub(b, a), d2 = sub(c, b);
    const l1 = len(d1), l2 = len(d2);
    const t = norm([d1[0] + d2[0], d1[1] + d2[1], d1[2] + d2[2]]);
    const k = scale(sub(scale(d2, 1 / l2), scale(d1, 1 / l1)), 2 / (l1 + l2)); // curvature vector
    const vi = speed[i];
    const felt: Vec3 = [vi * vi * k[0], vi * vi * k[1] + G, vi * vi * k[2]];
    let up = pts[i].up;
    up = norm(sub(up, scale(t, dot(up, t)))); // perpendicular to the track
    const side = cross(t, up);
    const fv = dot(felt, up), fs = dot(felt, side);
    // Banking: outside loops the track rolls into turns, up to maxBank.
    const roll = pts[i].loop ? 0 : Math.max(-PHYSICS.maxBank, Math.min(PHYSICS.maxBank, Math.atan2(fs, Math.max(0.1, fv))));
    bank[i] = roll;
    gv[i] = (fv * Math.cos(roll) + fs * Math.sin(roll)) / G;
    gl[i] = Math.abs(-fv * Math.sin(roll) + fs * Math.cos(roll)) / G;
  }
  // Smoothing over ~2 m removes sampling noise at piece joints.
  const W = 2;
  for (let i = 0; i < n; i++) {
    let v3 = 0, l3 = 0;
    for (let k = -W; k <= W; k++) { v3 += gv[(i + k + n) % n]; l3 += gl[(i + k + n) % n]; }
    v3 /= 2 * W + 1;
    l3 /= 2 * W + 1;
    maxG = Math.max(maxG, v3);
    minG = Math.min(minG, v3);
    maxLat = Math.max(maxLat, l3);
    maxSpeed = Math.max(maxSpeed, speed[i]);
    if (v3 < 0.25 && !pts[i].loop) airtime += time[i + 1] - time[i];
  }

  const { segs } = layout(start, pieces);
  let drops = 0, biggestDrop = 0, run = 0, turns = 0, inversions = 0, maxHeight = 0;
  for (const s of segs) {
    if (s.h1 < s.h0) run += s.h0 - s.h1;
    else if (run) { if (run >= 2) drops++; biggestDrop = Math.max(biggestDrop, run); run = 0; }
    if (PIECES[s.type].turn) turns++;
    if (PIECES[s.type].loop) inversions++;
    maxHeight = Math.max(maxHeight, s.h0, s.h1);
  }
  if (run >= 2) { drops++; biggestDrop = Math.max(biggestDrop, run); }

  const kmh = maxSpeed * 3.6;
  const clamp10 = (x: number) => Math.round(Math.max(0, Math.min(10, x)) * 10) / 10;
  let intensity = (maxG - 1) * 1.6 + Math.max(0, -minG) * 2.5 + maxLat * 2.2 + kmh / 35;
  let excitement = 0.5 + kmh / 22 + inversions * 0.9 + Math.min(airtime, 6) * 0.6 + drops * 0.35
    + Math.min(length / 250, 2) + Math.min(turns, 12) * 0.05;
  if (intensity > 10) excitement -= (intensity - 10) * 1.5;
  const nausea = maxLat * 1.8 + inversions * 1.1 + turns * 0.08 + airtime * 0.25;
  intensity = Math.round(Math.max(0, Math.min(12, intensity)) * 10) / 10;

  const warnings = [];
  if (maxG > 6) warnings.push(`Crushing ${maxG.toFixed(1)} G: riders may black out.`);
  if (maxLat > 2.5) warnings.push(`Violent ${maxLat.toFixed(1)} G sideways: tighten fewer turns at speed.`);
  if (minG < -1.5) warnings.push(`${minG.toFixed(1)} G ejector airtime: very intense.`);

  return {
    ok: true,
    maxSpeed: Math.round(kmh), maxG: round1(maxG), minG: round1(minG), maxLat: round1(maxLat),
    airtime: round1(airtime), length: Math.round(length), duration: round1(time[n]),
    drops, biggestDrop: biggestDrop * STEP * METERS, maxHeight: maxHeight * STEP * METERS, inversions, turns,
    excitement: clamp10(excitement), intensity, nausea: clamp10(nausea),
    warnings,
    // Per-sample timing and banking for animating the train.
    times: Array.from(time),
    bank: Array.from(bank),
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
