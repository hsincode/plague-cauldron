// The river (SPEC 2.3): the small balls driven down the bed by the flow field, and the big bubbles that drift on it,
// dock in a tool or shove the doctor. Balls are position-based: relax the velocity toward the flow, integrate, then
// resolve overlaps against neighbours (spatial hash) and against everything solid.
import { L, P, type BubbleSize, type ToolKind } from '../config'
import { clamp, clamp01, lerp } from '../core/math'
import { rand, randInt, randRange } from '../core/rng'
import { RIVER_ROCKS } from '../world/colliders'
import { flowSpeed, RIVER_LENGTH, riverPoint, riverSample } from '../world/river'
import { BLADES } from '../world/tools'
import { emit } from './events'
import { shovePlayer, showEmoji } from './player'
import { BLADE_ARCS, bladeAt, cartBody, dockSeat } from './tools'
import { BALL_FALL, BALL_FLOW, BALL_LOOSE, BALL_STRAY, type Balls, type Bubble, type GameState, type Tool } from './types'

const BALL_R = P.BALL_DIAMETER / 2
const BALL_D = P.BALL_DIAMETER
const BALL_D2 = BALL_D * BALL_D

// --- the bed ---------------------------------------------------------------------------------------------------------

const HW_N = L.RIVER_HALF_WIDTH_N
const HW_S = L.RIVER_HALF_WIDTH_S
const GAIN = P.FLOW_DOWNSTREAM_GAIN
/** Mean of the parabolic speed profile across the bed, at the source. */
const MEAN_SPEED = P.FLOW_SPEED_BANK + ((P.FLOW_SPEED_MID - P.FLOW_SPEED_BANK) * 2) / 3
/** Balls per m2 where the river enters the map (SPEC 2.3: "up to 16 per m2 in dense zones"). */
const SOURCE_DENSITY = 16
const FALL_GRAVITY = 20
/** A ball is recycled once it has dropped this far below the lip. */
const FALL_DEPTH = L.FALL_DROP + 0.4
const FALL_TIME = Math.sqrt((2 * FALL_DEPTH) / FALL_GRAVITY)
/** Balls per second through any cross-section in the steady state. */
const FLUX = SOURCE_DENSITY * 2 * HW_N * MEAN_SPEED
/** Seconds from the first centreline point to the fall at the mean lane speed (the flow speeds up by GAIN). */
const TRANSIT = (RIVER_LENGTH * Math.log(1 + GAIN)) / GAIN / MEAN_SPEED
/**
 * The flow speeds up toward the fall, so a river that is conserved cannot hold BALL_COUNT balls at the source
 * density on the map alone. The remainder flows in a feeder reach north of the first centreline point (behind the
 * cliffs); its length makes the steady state come out at SOURCE_DENSITY where the river enters the map.
 */
const FEED_LENGTH = clamp((P.BALL_COUNT / FLUX - TRANSIT - FALL_TIME) * MEAN_SPEED, 1.5, 11)
/** Arc length of the source (negative: upstream of the first centreline point). */
const SOURCE_S = -FEED_LENGTH
/** Recycled balls reappear within this stretch below the source. */
const SOURCE_BAND = 1.0
/** Lateral speed that keeps a ball in its lane while the bed widens. */
const WIDEN_RATE = (HW_S - HW_N) / RIVER_LENGTH
/** Soft spring that keeps untouched balls in the bed: rate (1/s) and speed limit. */
const BED_SPRING = 8
const BED_PULL_SPEED = 1.5
/** Beyond a ball's diameter a weak repulsion acts out to this distance: it spreads the flow into wakes and gaps. */
const SOFT_RANGE = 0.3
const SOFT_RANGE2 = SOFT_RANGE * SOFT_RANGE
/** Fraction of the soft gap closed per second and pass. */
const SOFT_RATE = 4
/** The lanes start to squeeze past a boulder that stands in the bed this far up- and downstream of its surface. */
const ROCK_RAMP = 2.5
const ROCK_CLEARANCE = 0.15
/** The corridor past a boulder is never narrower than this half-width. */
const CORRIDOR_MIN = 1.0
/** A flow ball that is pushed while it is this far beyond the edge of the bed has been bulldozed out: it turns loose. */
const ESCAPE_MARGIN = 0.15
/** Loose balls this close to the bed roll back into it; only those pushed further out stay on the bank. */
const RETURN_ZONE = 0.7
const RETURN_SPEED = 0.8
/** Everything south of the lip and east of ward 1 is the drop. */
const CLIFF_X0 = 6.5

// --- loose balls, strays, bursts -------------------------------------------------------------------------------------

const LOOSE_FRICTION_TIME = 0.12
/** Balls [0, PERMANENT) start as the permanent strays at L.STRAY_SEED; as strays they neither age nor get recycled. */
const PERMANENT = Math.min(L.STRAY_SEED.n, P.BALL_COUNT)
/** Capture burst (SPEC 2.3): apex 0.8-1.3 m and back down within about 0.27 s. */
const BURST_GRAVITY = 110
const BURST_MIN = 15
const BURST_MAX = 25
const AIRBORNE = 0.05
const DOCTOR_RADIUS = 0.45

// --- bubbles ---------------------------------------------------------------------------------------------------------

/** A bubble is a sphere resting on the ground: at ball height its footprint is smaller than its radius. */
const BUBBLE_FOOTPRINT = 0.8
const BUBBLE_GROW_TIME = 0.4
const LANE_MAX = 1.0
const LANE_BANK_MARGIN = 0.4
const LANE_PULL = 2.5
const LANE_SPEED = 1.5
/** Lateral tolerance of a capture (SPEC 2.3: chord/2 - 0.2). */
const DOCK_LATERAL_MARGIN = 0.2
const SHOVE_MAX = 0.5
/** Bubbles already on the river when the game starts: [size, arc length]. The first-minute script (SPEC 3.5) needs an L to bounce off at about 1.4 s and an M to catch at about 3.8 s. */
const START_BUBBLES: readonly (readonly [BubbleSize, number])[] = [['L', 15.0], ['S', 9.5], ['M', 3.4]]

const hash01 = (i: number) => {
  let t = (Math.imul(i, 0x9e3779b1) + 0x6d2b79f5) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * Boulders that stand in the bed narrow it: [arc length, ramp half-length, depth, side] each, where depth is how far
 * the boulder reaches in from its bank (side = sign of d there). The flow follows the narrowed corridor - lanes
 * squeeze together and speed up past the boulder and fan out again behind it - instead of running into the rock.
 */
const BED_ROCKS: number[] = []
for (const rock of RIVER_ROCKS) {
  const r = riverSample(rock.x, rock.z)
  const depth = r.halfW - (Math.abs(r.d) - rock.r) + ROCK_CLEARANCE
  if (depth > ROCK_CLEARANCE && r.s > 0 && r.s < RIVER_LENGTH + rock.r) BED_ROCKS.push(r.s, rock.r + ROCK_RAMP, depth, r.d > 0 ? 1 : -1)
}

/** Corridor at arc length sArc: centre offset and half-width (see BED_ROCKS). */
const _corridor = { shift: 0, halfW: 0 }
function corridor(sArc: number, halfW: number) {
  let shift = 0
  let narrow = 0
  for (let k = 0; k < BED_ROCKS.length; k += 4) {
    const a = sArc - BED_ROCKS[k]!
    const len = BED_ROCKS[k + 1]!
    if (a <= -len || a >= len) continue
    const bump = BED_ROCKS[k + 2]! * 0.25 * (1 + Math.cos((Math.PI * a) / len))
    shift -= BED_ROCKS[k + 3]! * bump
    narrow += bump
  }
  _corridor.shift = shift
  _corridor.halfW = Math.max(CORRIDOR_MIN, halfW - narrow)
  return _corridor
}

// --- scratch ---------------------------------------------------------------------------------------------------------

const CELL = 0.3
const INV_CELL = 1 / CELL
const GRID_X0 = 2
const GRID_Z0 = -36
// one ring of padding cells that never hold a ball, so that neighbour ranges need no edge cases
const GRID_W = Math.ceil((28 - GRID_X0) / CELL) + 2
const GRID_H = Math.ceil((6.6 - GRID_Z0) / CELL) + 2
const NCELL = GRID_W * GRID_H
/** After buildGrid: cellStart[c] .. cellStart[c + 1] is the range of cell c in `sorted`. */
const cellStart = new Int32Array(NCELL + GRID_W + 4)
/** Slack on grid queries: balls move a little after the grid was built. */
const QUERY_PAD = 0.35

let cap = 0
let sorted = new Int32Array(0)
let mov = new Float32Array(0)
let px = new Float32Array(0)
let pz = new Float32Array(0)
let speedJit = new Float32Array(0)
let touched = new Uint8Array(0)
let touchList = new Int32Array(0)
let touchN = 0
let strayCount = 0
const burstIdx = new Int32Array(BURST_MAX)
const burstD2 = new Float32Array(BURST_MAX)
const polyA = new Float32Array(18)
const polyB = new Float32Array(18)
const _pt = { x: 0, z: 0 }

function ensure(n: number) {
  if (n <= cap) return
  cap = n
  sorted = new Int32Array(n)
  mov = new Float32Array(n)
  px = new Float32Array(n)
  pz = new Float32Array(n)
  touched = new Uint8Array(n)
  touchList = new Int32Array(n)
  // every ball runs a few percent off the flow speed for good, which keeps lanes shearing instead of crystallising
  speedJit = new Float32Array(n)
  for (let i = 0; i < n; i++) speedJit[i] = 0.9 + 0.2 * hash01(i)
}

/** Blade poses at the end of the previous step, for the swept blade test. A cache: without it one step is unswept. */
interface BladeMemo {
  x: number
  z: number
  h: number
  kind: ToolKind | null
}
const bladeMemos = new WeakMap<GameState, BladeMemo[]>()

// --- balls: source, init ---------------------------------------------------------------------------------------------

/** Put ball i back into the flow at the source. Lanes are filled in proportion to their speed, so the density stays even across the bed. */
function respawn(s: GameState, i: number) {
  const b = s.balls
  let u = 0
  for (let tries = 0; tries < 8; tries++) {
    u = rand(s.rng) * 2 - 1
    const profile = 1 - u * u
    if (rand(s.rng) * P.FLOW_SPEED_MID <= lerp(P.FLOW_SPEED_BANK, P.FLOW_SPEED_MID, profile)) break
  }
  const d = u * (HW_N - BALL_R)
  riverPoint(SOURCE_S + rand(s.rng) * SOURCE_BAND, d, _pt)
  const r = riverSample(_pt.x, _pt.z)
  const sp = flowSpeed(d, HW_N, 0) * speedJit[i]!
  b.x[i] = _pt.x
  b.z[i] = _pt.z
  b.y[i] = 0
  b.vx[i] = r.tx * sp
  b.vz[i] = r.tz * sp
  b.vy[i] = 0
  b.state[i] = BALL_FLOW
  b.t[i] = 0
}

const _a = { x: 0, z: 0 }
const _b = { x: 0, z: 0 }
/** Rows are laid square to the centreline averaged over this distance, so they fan round its bends without gaps. */
const ROW_SMOOTHING = 2

function placeFlowBall(b: Balls, i: number, sArc: number, d: number) {
  const sc = Math.min(sArc, RIVER_LENGTH - 0.02)
  riverPoint(sc, 0, _pt)
  riverPoint(sc - ROW_SMOOTHING, 0, _a)
  riverPoint(sc + ROW_SMOOTHING, 0, _b)
  const len = Math.hypot(_b.x - _a.x, _b.z - _a.z)
  // the right-hand normal of the smoothed tangent
  let x = _pt.x - ((_b.z - _a.z) / len) * d
  let z = _pt.z + ((_b.x - _a.x) / len) * d
  const r = riverSample(x, z)
  const out = Math.abs(r.d) - (r.halfW - BALL_R)
  if (out > 0) {
    const pull = r.d > 0 ? out : -out
    x += r.tz * pull
    z -= r.tx * pull
  }
  const sp = flowSpeed(r.d, r.halfW, r.p) * speedJit[i]!
  b.x[i] = x
  b.z[i] = Math.min(z, L.CLIFF_Z - 0.01)
  b.y[i] = 0
  b.vx[i] = r.tx * sp
  b.vz[i] = r.tz * sp
  b.vy[i] = 0
  b.state[i] = BALL_FLOW
  b.t[i] = 0
}

const bedHalfWidth = (sArc: number) => lerp(HW_N, HW_S, clamp01(sArc / RIVER_LENGTH))
const thinning = (sArc: number) => 1 + GAIN * clamp01(sArc / RIVER_LENGTH)

export function initRiver(s: GameState) {
  const b = s.balls
  const n = b.n
  ensure(n)
  touched.fill(0)
  touchN = 0

  // permanent strays: a small sunflower around the seed point
  const seed = L.STRAY_SEED
  const strays = Math.min(PERMANENT, n)
  for (let i = 0; i < strays; i++) {
    const rad = 0.4 * Math.sqrt((i + 0.5) / strays)
    const ang = i * 2.39996 + rand(s.rng) * 0.4
    b.x[i] = seed.x + Math.cos(ang) * rad
    b.z[i] = seed.z + Math.sin(ang) * rad
    b.y[i] = 0
    b.vx[i] = b.vz[i] = b.vy[i] = 0
    b.state[i] = BALL_STRAY
    b.t[i] = 0
  }

  // The steady state of a conserved flow: density ~ 1 / speed, i.e. dense upstream and thinner toward the fall.
  // Balls are laid in jittered rows across the corridor whose pitch follows that density; rho0 makes the total n.
  const want = n - strays
  let area = 0
  const QUAD = 240
  for (let k = 0; k < QUAD; k++) {
    const sArc = SOURCE_S + ((k + 0.5) / QUAD) * (RIVER_LENGTH - SOURCE_S)
    area += (2 * (corridor(sArc, bedHalfWidth(sArc)).halfW - BALL_R)) / thinning(sArc)
  }
  area *= (RIVER_LENGTH - SOURCE_S) / QUAD
  const rho0 = want / area
  const JITTER = 0.3
  let i = strays
  let carry = 0
  let row = 0
  for (let sArc = SOURCE_S; sArc < RIVER_LENGTH && i < n; row++) {
    const cor = corridor(sArc, bedHalfWidth(sArc))
    const hw = cor.halfW - BALL_R
    const rho = rho0 / thinning(sArc)
    const pitch = Math.sqrt(1 / (rho * 0.866))
    const ds = Math.min(pitch * 0.866, RIVER_LENGTH - sArc)
    carry += rho * 2 * hw * ds
    const count = Math.min(Math.floor(carry), n - i)
    carry -= count
    const step = (2 * hw) / Math.max(1, count)
    const stagger = row & 1 ? 0.25 : 0.75
    for (let k = 0; k < count; k++, i++) {
      const d = cor.shift + clamp(-hw + (k + stagger + (rand(s.rng) - 0.5) * 2 * JITTER) * step, -hw, hw)
      placeFlowBall(b, i, sArc + (0.5 + (rand(s.rng) - 0.5) * 2 * JITTER) * ds, d)
    }
    sArc += ds
  }
  // rounding leftovers
  for (; i < n; i++) {
    const sArc = SOURCE_S + rand(s.rng) * (RIVER_LENGTH - SOURCE_S)
    const cor = corridor(sArc, bedHalfWidth(sArc))
    placeFlowBall(b, i, sArc, cor.shift + (rand(s.rng) * 2 - 1) * (cor.halfW - BALL_R))
  }
  // the bubbles that are on the river at the start: the balls under them move out into a band around the footprint
  for (const [size, sArc] of START_BUBBLES) {
    const bb = spawnBubble(s, size, sArc)
    bb.age = 10
    const R = bb.r * BUBBLE_FOOTPRINT + BALL_R
    for (let k = strays; k < n; k++) {
      const dx = b.x[k]! - bb.x
      const dz = b.z[k]! - bb.z
      const d2 = dx * dx + dz * dz
      if (d2 >= R * R || d2 < 1e-8) continue
      const f = (R + rand(s.rng) * R * 0.6) / Math.sqrt(d2)
      b.x[k] = bb.x + dx * f
      b.z[k] = bb.z + dz * f
    }
  }
  // take the worst overlaps out
  for (let pass = 0; pass < 3; pass++) {
    buildGrid(b)
    collideBalls(b, 0, (pass & 1) === 1)
  }
  bladeMemos.delete(s)
}

// --- balls: integration ----------------------------------------------------------------------------------------------

function integrate(s: GameState, dt: number) {
  const b = s.balls
  const x = b.x
  const z = b.z
  const y = b.y
  const vx = b.vx
  const vz = b.vz
  const vy = b.vy
  const state = b.state
  const t = b.t
  const n = b.n
  const kRelax = 1 - Math.exp(-dt / P.FLOW_RELAX_TIME)
  const kFric = Math.exp(-dt / LOOSE_FRICTION_TIME)
  const kSpring = 1 - Math.exp(-BED_SPRING * dt)
  const maxPull = BED_PULL_SPEED * dt
  let strays = 0
  for (let i = 0; i < n; i++) {
    const st = state[i]!
    if (st === BALL_FLOW) {
      const xi = x[i]!
      const zi = z[i]!
      const r = riverSample(xi, zi)
      const d = r.d
      const hw = r.halfW
      const tx = r.tx
      const tz = r.tz
      // the corridor: the bed, narrowed and shifted where a boulder stands in it
      let shift = 0
      let shiftSlope = 0
      let narrow = 0
      let widen = r.s > 0 && r.s < RIVER_LENGTH ? WIDEN_RATE : 0
      for (let k = 0; k < BED_ROCKS.length; k += 4) {
        const a = r.s - BED_ROCKS[k]!
        const len = BED_ROCKS[k + 1]!
        if (a <= -len || a >= len) continue
        const ph = (Math.PI * a) / len
        const quarter = BED_ROCKS[k + 2]! * 0.25
        const bump = quarter * (1 + Math.cos(ph))
        const slope = ((-quarter * Math.PI) / len) * Math.sin(ph)
        shift -= BED_ROCKS[k + 3]! * bump
        shiftSlope -= BED_ROCKS[k + 3]! * slope
        narrow += bump
        widen -= slope
      }
      const hwC = Math.max(CORRIDOR_MIN, hw - narrow)
      const rel = d - shift
      // continuity: the same flux through a narrower corridor
      const sp = flowSpeed(rel, hwC, r.p) * (hw / hwC) * speedJit[i]!
      // lateral speed that keeps the ball in its lane (constant rel / hwC); the right-hand normal (+d) is (-tz, tx)
      const lat = sp * (shiftSlope + (rel / hwC) * widen)
      const nvx = vx[i]! + (tx * sp - tz * lat - vx[i]!) * kRelax
      const nvz = vz[i]! + (tz * sp + tx * lat - vz[i]!) * kRelax
      let nx = xi + nvx * dt
      let nz = zi + nvz * dt
      const out = Math.abs(rel) - (hwC - BALL_R)
      if (out > 0) {
        const pull = Math.min(out * kSpring, maxPull) * (rel > 0 ? 1 : -1)
        nx += tz * pull
        nz -= tx * pull
      }
      if (r.s < SOURCE_S) {
        // keeps the crowd at the source from spilling backwards
        const push = (SOURCE_S - r.s) * kSpring
        nx += tx * push
        nz += tz * push
      }
      vx[i] = nvx
      vz[i] = nvz
      x[i] = nx
      z[i] = nz
      if (nz > L.CLIFF_Z) {
        state[i] = BALL_FALL
        t[i] = 0
        vy[i] = 0
      }
    } else if (st === BALL_LOOSE) {
      if (y[i]! > 0 || vy[i]! > 0) {
        // exact for constant gravity, so the apex (SPEC 2.3: 0.8-1.3 m) does not depend on the step length
        y[i] = y[i]! + (vy[i]! - 0.5 * BURST_GRAVITY * dt) * dt
        vy[i] = vy[i]! - BURST_GRAVITY * dt
        x[i] = x[i]! + vx[i]! * dt
        z[i] = z[i]! + vz[i]! * dt
        if (y[i]! <= 0) {
          y[i] = 0
          vy[i] = 0
        }
      } else {
        vx[i] = vx[i]! * kFric
        vz[i] = vz[i]! * kFric
        x[i] = x[i]! + vx[i]! * dt
        z[i] = z[i]! + vz[i]! * dt
      }
    } else if (st === BALL_STRAY) {
      strays++
      if (i >= PERMANENT) {
        t[i] = t[i]! + dt
        if (t[i]! > P.STRAY_LIFETIME) {
          respawn(s, i)
          strays--
        }
      }
    } else {
      vy[i] = vy[i]! - FALL_GRAVITY * dt
      y[i] = y[i]! + vy[i]! * dt
      x[i] = x[i]! + vx[i]! * dt
      z[i] = z[i]! + vz[i]! * dt
      t[i] = t[i]! + dt
      if (y[i]! < -FALL_DEPTH) respawn(s, i)
    }
  }
  strayCount = strays
}

// --- balls: spatial hash and overlap resolution ----------------------------------------------------------------------

const cellCol = (v: number) => {
  const c = Math.floor((v - GRID_X0) * INV_CELL) + 1
  return c < 1 ? 1 : c > GRID_W - 2 ? GRID_W - 2 : c
}
const cellRow = (v: number) => {
  const c = Math.floor((v - GRID_Z0) * INV_CELL) + 1
  return c < 1 ? 1 : c > GRID_H - 2 ? GRID_H - 2 : c
}

/** Counting sort of the grounded balls into cells. Falling and airborne balls are left out: nothing touches them. */
function buildGrid(b: Balls) {
  const x = b.x
  const z = b.z
  const y = b.y
  const state = b.state
  const n = b.n
  cellStart.fill(0)
  for (let i = 0; i < n; i++) {
    const st = state[i]!
    if (st === BALL_FALL || y[i]! > AIRBORNE) continue
    cellStart[cellRow(z[i]!) * GRID_W + cellCol(x[i]!)]!++
  }
  for (let c = 1; c < cellStart.length; c++) cellStart[c] = cellStart[c]! + cellStart[c - 1]!
  // cellStart[c] is now the END of cell c; filling backwards turns it into the start
  for (let i = 0; i < n; i++) {
    const st = state[i]!
    if (st === BALL_FALL || y[i]! > AIRBORNE) continue
    const c = cellRow(z[i]!) * GRID_W + cellCol(x[i]!)
    const a = cellStart[c]! - 1
    cellStart[c] = a
    sorted[a] = i
    mov[i] = st === BALL_STRAY ? 0 : 1
  }
}

/** Pile mode of collideBalls: the blade the pile leans on (arc centre, forward direction, geometry); radius 0 = off. */
let pileX = 0
let pileZ = 0
let pileFx = 0
let pileFz = 1
let pileR = 0
/** Tip line relative to the arc centre (negative), half chord, nose length. */
let pileTip = 0
let pileHalf = 1
let pileNose = 1
const OUTSIDE_PILE = 10

/**
 * How far out in the pile a ball is; the lower of two ranks stands firm. Inside the pocket it is the distance from
 * the blade, outside it the distance from the pocket's nose, and anything outside ranks above anything inside.
 * -1 = beside or behind the blade: not part of the pile.
 */
function pileRank(x: number, z: number): number {
  const dx = x - pileX
  const dz = z - pileZ
  const ahead = dx * pileFx + dz * pileFz
  const rho2 = dx * dx + dz * dz
  if (ahead <= pileTip) return rho2 < pileR * pileR ? pileR - Math.sqrt(rho2) : -1
  const side2 = Math.max(0, rho2 - ahead * ahead)
  const u = Math.sqrt(side2) / pileHalf + (ahead - pileTip) / pileNose
  if (u >= 1) return OUTSIDE_PILE + u
  return pileR - Math.sqrt(side2 + pileTip * pileTip) + (ahead - pileTip)
}

/**
 * One Gauss-Seidel pass of ball-ball overlap resolution over the cells [row0..row1] x [col0..col1]. Strays are
 * immovable. `soft` (0..1) is the fraction of the gap up to SOFT_RANGE that flowing balls open between each other
 * in this pass; 0 = hard contacts only. `reverse` sweeps the other way, so that a pair of passes has no bias.
 * In pile mode the ball of a pair that is nearer to the blade stands firm and the other one takes the whole
 * correction, so a push travels through the pile in one pass instead of being halved at every layer.
 */
function collideBalls(b: Balls, soft: number, reverse: boolean, row0 = 1, row1 = GRID_H - 2, col0 = 1, col1 = GRID_W - 2) {
  const x = b.x
  const z = b.z
  const state = b.state
  const range2 = soft > 0 ? SOFT_RANGE2 : BALL_D2
  const softGap = (SOFT_RANGE - BALL_D) * soft
  const first = row0 * GRID_W + col0
  const lastCell = row1 * GRID_W + col1
  const step = reverse ? -1 : 1
  for (let c = reverse ? lastCell : first; c >= first && c <= lastCell; c += step) {
    const a0 = cellStart[c]!
    const a1 = cellStart[c + 1]!
    if (a0 === a1) continue
    const col = c % GRID_W
    if (col < col0 || col > col1) continue
    // own cell and the east neighbour are one contiguous range; so are the three cells of the next row
    const eastEnd = cellStart[c + 2]!
    const south0 = cellStart[c + GRID_W - 1]!
    const south1 = cellStart[c + GRID_W + 2]!
    for (let a = reverse ? a1 - 1 : a0; a >= a0 && a < a1; a += step) {
      const i = sorted[a]!
      let xi = x[i]!
      let zi = z[i]!
      const mi = mov[i]!
      const si = state[i]!
      let k = a + 1
      let end = eastEnd
      for (let part = 0; part < 2; part++) {
        for (; k < end; k++) {
          const j = sorted[k]!
          const dx = x[j]! - xi
          const dz = z[j]! - zi
          const d2 = dx * dx + dz * dz
          if (d2 >= range2) continue
          const sj = state[j]!
          let push: number
          if (d2 >= BALL_D2) {
            if ((si | sj) !== BALL_FLOW) continue
            push = (SOFT_RANGE - Math.sqrt(d2)) * soft
          } else {
            push = BALL_D - Math.sqrt(d2)
            if ((si | sj) === BALL_FLOW) push += softGap
            // a loose ball shoving a flow ball passes the bulldozing on (settle() checks that it is outside the bed)
            else if (si + sj === BALL_LOOSE) touch(b, si === BALL_FLOW ? i : j)
          }
          let wi = mi
          let wj = mov[j]!
          if (pileR > 0 && wi + wj === 2) {
            const ri = pileRank(xi, zi)
            const rj = pileRank(x[j]!, z[j]!)
            if (ri >= 0 && rj >= 0) {
              if (ri < rj) wi = 0
              else wj = 0
            }
          }
          const w = wi + wj
          if (w === 0) continue
          if (d2 > 1e-10) {
            const f = push / (Math.sqrt(d2) * w)
            xi -= dx * f * wi
            zi -= dz * f * wi
            x[j] = x[j]! + dx * f * wj
            z[j] = z[j]! + dz * f * wj
          } else {
            xi -= 0.01 * wi
            x[j] = x[j]! + 0.01 * wj
          }
        }
        k = south0
        end = south1
      }
      x[i] = xi
      z[i] = zi
    }
  }
}

/**
 * Pushes shorter than this do not count as a touch. A ball that leans on something standing still is "pushed" by
 * rounding noise every step; counted as touches, those would keep it loose for ever (never a stray, never recycled).
 */
const TOUCH_EPS = 1e-4

/** A tool, the doctor or a held bubble pushed ball i. */
function touch(b: Balls, i: number) {
  const st = b.state[i]!
  if (st === BALL_FLOW) {
    if (touched[i] === 0) {
      touched[i] = 1
      touchList[touchN++] = i
    }
  } else {
    b.state[i] = BALL_LOOSE
    b.t[i] = 0
  }
}

/** Push every grounded ball out of a circle of radius R (already including the ball radius). */
function pushCircle(b: Balls, cx: number, cz: number, R: number, byTool: boolean) {
  const x = b.x
  const z = b.z
  const c0 = cellCol(cx - R - QUERY_PAD)
  const c1 = cellCol(cx + R + QUERY_PAD)
  const r1 = cellRow(cz + R + QUERY_PAD)
  const R2 = R * R
  for (let row = cellRow(cz - R - QUERY_PAD); row <= r1; row++) {
    const base = row * GRID_W
    const end = cellStart[base + c1 + 1]!
    for (let a = cellStart[base + c0]!; a < end; a++) {
      const i = sorted[a]!
      const dx = x[i]! - cx
      const dz = z[i]! - cz
      const d2 = dx * dx + dz * dz
      if (d2 >= R2) continue
      const d = Math.sqrt(d2)
      if (d2 > 1e-10) {
        const k = R / d
        x[i] = cx + dx * k
        z[i] = cz + dz * k
      } else {
        x[i] = cx + R
      }
      if (byTool && R - d > TOUCH_EPS) touch(b, i)
    }
  }
}

/** A blade may turn this fast and still count as moving (anything more is a teleport: grab, swap). */
const SWEEP_MAX_MOVE = 1.0
const SWEEP_MAX_TURN = 0.6
/** How far beyond the blade's thickness a ball can have been carried through it in one step. */
const SWEEP_REACH = 0.7

/**
 * Balls against one blade. The blade is the arc BLADE_ARCS[kind] in the tool's frame, so "which face" is a radius
 * comparison around the arc's centre. A fast blade (the tips turn at up to 15 m/s) would step over balls, so the
 * face a ball belongs on is the one it was on BEFORE the blade moved: (x0, z0, h0) is the previous pose and
 * px/pz the ball positions at that time.
 */
function collideBlade(b: Balls, kind: ToolKind, x1: number, z1: number, h1: number, x0: number, z0: number, h0: number) {
  const arc = BLADE_ARCS[kind]
  const capR = BALL_R + P.BLADE_THICKNESS / 2
  bladeAt(kind, x1, z1, h1, polyA)
  bladeAt(kind, x0, z0, h0, polyB)
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  const pts = BLADES[kind].poly.length
  for (let k = 0; k < pts; k += 2) {
    minX = Math.min(minX, polyA[k]!, polyB[k]!)
    maxX = Math.max(maxX, polyA[k]!, polyB[k]!)
    minZ = Math.min(minZ, polyA[k + 1]!, polyB[k + 1]!)
    maxZ = Math.max(maxZ, polyA[k + 1]!, polyB[k + 1]!)
  }
  const pad = capR + QUERY_PAD
  const col0 = cellCol(minX - pad)
  const col1 = cellCol(maxX + pad)
  const row1 = cellRow(maxZ + pad)

  const x = b.x
  const z = b.z
  const c1 = Math.cos(h1)
  const s1 = Math.sin(h1)
  const c0 = Math.cos(h0)
  const s0 = Math.sin(h0)
  const R = arc.R
  const cz = arc.cz
  const cosHalf = arc.cosHalf
  const tipZ = arc.tipZ - cz
  const reach = capR + SWEEP_REACH
  // A blade that stands still pushes nothing: a ball wedged between it and a stray would otherwise stay loose for ever.
  const still = x1 === x0 && z1 === z0 && h1 === h0
  for (let row = cellRow(minZ - pad); row <= row1; row++) {
    const base = row * GRID_W
    const end = cellStart[base + col1 + 1]!
    for (let a = cellStart[base + col0]!; a < end; a++) {
      const i = sorted[a]!
      // local position relative to the arc's centre of curvature
      let dx = x[i]! - x1
      let dz = z[i]! - z1
      let lx = dx * c1 - dz * s1
      let lz = dx * s1 + dz * c1 - cz
      const rho = Math.hypot(lx, lz)
      if (Math.abs(rho - R) > reach) continue
      let moved: number
      if (-lz >= rho * cosHalf) {
        dx = px[i]! - x0
        dz = pz[i]! - z0
        const lz0 = dx * s0 + dz * c0 - cz
        const rho0 = Math.hypot(dx * c0 - dz * s0, lz0)
        // over the blade before as well: it stays on that face; otherwise it came in round a tip
        const front = -lz0 >= rho0 * cosHalf ? rho0 < R : rho < R
        const want = front ? Math.min(rho, R - capR) : Math.max(rho, R + capR)
        if (want === rho) continue
        moved = Math.abs(want - rho)
        const k = want / rho
        lx *= k
        lz *= k
      } else {
        // beyond a tip: only the blade's rounded end can touch it
        const tipX = lx >= 0 ? arc.tipX : -arc.tipX
        const ex = lx - tipX
        const ez = lz - tipZ
        const e2 = ex * ex + ez * ez
        if (e2 >= capR * capR) continue
        const e = Math.sqrt(e2)
        moved = capR - e
        const k = e2 > 1e-10 ? capR / e : 0
        lx = tipX + ex * k
        lz = tipZ + (k > 0 ? ez * k : capR)
      }
      const wz = lz + cz
      x[i] = x1 + lx * c1 + wz * s1
      z[i] = z1 - lx * s1 + wz * c1
      if (moved > TOUCH_EPS && !still) touch(b, i)
    }
  }
}

/** Did the blade get from its remembered pose to where it is now by moving (as opposed to a grab or a swap)? */
const bladeSwept = (tool: Tool, m: BladeMemo) =>
  m.kind === tool.kind && Math.abs(tool.x - m.x) < SWEEP_MAX_MOVE && Math.abs(tool.z - m.z) < SWEEP_MAX_MOVE && Math.abs(Math.sin((tool.heading - m.h) / 2)) < SWEEP_MAX_TURN / 2

function collideSolids(s: GameState) {
  const b = s.balls
  for (let k = 0; k < RIVER_ROCKS.length; k++) {
    const rock = RIVER_ROCKS[k]!
    pushCircle(b, rock.x, rock.z, rock.r + BALL_R, false)
  }
  for (let k = 0; k < s.bubbles.length; k++) {
    const bb = s.bubbles[k]!
    if (bb.state === 'gone') continue
    // a fresh bubble swells out of the source instead of popping into the crowd
    const grow = bb.age < BUBBLE_GROW_TIME ? bb.age / BUBBLE_GROW_TIME : 1
    pushCircle(b, bb.x, bb.z, bb.r * BUBBLE_FOOTPRINT * grow + BALL_R, bb.state !== 'drift')
  }
  for (let k = 0; k < s.tools.length; k++) {
    const tool = s.tools[k]!
    if (!tool.exists || tool.kind !== 'cart') continue
    cartBody(tool, _pt)
    pushCircle(b, _pt.x, _pt.z, P.CART_BODY_RADIUS + BALL_R, true)
  }
  const p = s.player
  if (p.mode !== 'cart') pushCircle(b, p.x, p.z, DOCTOR_RADIUS + BALL_R, true)

  // blades last: a ball squeezed between a blade and anything else ends up on the right side of the blade
  let memos = bladeMemos.get(s)
  if (!memos) {
    memos = []
    bladeMemos.set(s, memos)
  }
  for (let k = 0; k < s.tools.length; k++) {
    const tool = s.tools[k]!
    let m = memos[k]
    if (!m) m = memos[k] = { x: 0, z: 0, h: 0, kind: null }
    if (!tool.exists) continue
    if (bladeSwept(tool, m)) collideBlade(b, tool.kind, tool.x, tool.z, tool.heading, m.x, m.z, m.h)
    else collideBlade(b, tool.kind, tool.x, tool.z, tool.heading, tool.x, tool.z, tool.heading)
  }
}

/** Extra relaxation passes around a held tool, enough for the pile on its blade to behave as incompressible. */
const PILE_PASSES = 3
const PILE_REACH = 1.3
/** The pile's nose reaches this far ahead of the line between the tips, as a fraction of half the chord. */
const PILE_NOSE = 0.7
/** Balls per m2 in a full pile. */
const PILE_DENSITY = 17
/** A docked bubble fills most of the pocket. */
const PILE_WITH_BUBBLE = 0.25

/**
 * The pile a blade carries (SPEC 2.2 "Ploughing": a wedge 2-3 deep on the concave face, the rest streams round both
 * tips). The pocket is the hollow of the blade plus a wedge-shaped nose ahead of the tips - the dead zone of a real
 * plough. Once it holds as many balls as fit, the nose turns solid for balls coming from outside: they slide along
 * its faces and off round the tips. (Left alone, this frictionless model pushes everything it meets ahead for ever.)
 */
interface Pocket {
  /** Half the chord, local z of the tip line, length of the nose ahead of it. */
  half: number
  tipZ: number
  nose: number
  capacity: number
}
function makePocket(kind: ToolKind): Pocket {
  const spec = BLADES[kind]
  const arc = BLADE_ARCS[kind]
  const half = spec.chord / 2
  const nose = half * PILE_NOSE
  const hollow = arc.R * arc.R * Math.acos(arc.cosHalf) - (arc.R - spec.sagitta) * half
  return { half, tipZ: arc.tipZ, nose, capacity: Math.round((hollow + half * nose) * PILE_DENSITY) }
}
const POCKETS: Record<ToolKind, Pocket> = { scoop: makePocket('scoop'), cart: makePocket('cart') }

/** Is the point (tool-local coordinates) in the pocket of this blade? */
function inPocket(kind: ToolKind, lx: number, lz: number): boolean {
  const pk = POCKETS[kind]
  if (lz > pk.tipZ) return Math.abs(lx) / pk.half + (lz - pk.tipZ) / pk.nose < 1
  const arc = BLADE_ARCS[kind]
  const rz = lz - arc.cz
  return lx * lx + rz * rz < arc.R * arc.R
}

/** Keep newcomers out of a full pocket: balls that were outside it before this step are put back on the nose's face. */
function capPile(b: Balls, kind: ToolKind, tx: number, tz: number, th: number, x0: number, z0: number, h0: number, hasBubble: boolean, row0: number, row1: number, col0: number, col1: number) {
  const x = b.x
  const z = b.z
  const pk = POCKETS[kind]
  const c1 = Math.cos(th)
  const s1 = Math.sin(th)
  let inside = 0
  for (let row = row0; row <= row1; row++) {
    const end = cellStart[row * GRID_W + col1 + 1]!
    for (let a = cellStart[row * GRID_W + col0]!; a < end; a++) {
      const i = sorted[a]!
      const dx = x[i]! - tx
      const dz = z[i]! - tz
      if (!inPocket(kind, dx * c1 - dz * s1, dx * s1 + dz * c1)) continue
      inside++
      // riding in the pile counts as being pushed by the tool
      if (b.state[i] !== BALL_FLOW) {
        b.state[i] = BALL_LOOSE
        b.t[i] = 0
      }
    }
  }
  if (inside < pk.capacity * (hasBubble ? PILE_WITH_BUBBLE : 1)) return
  const c0 = Math.cos(h0)
  const s0 = Math.sin(h0)
  // outward normal of the nose's face on the +x side: (nose, half) / len
  const len = Math.hypot(pk.nose, pk.half)
  const nx = pk.nose / len
  const nz = pk.half / len
  for (let row = row0; row <= row1; row++) {
    const end = cellStart[row * GRID_W + col1 + 1]!
    for (let a = cellStart[row * GRID_W + col0]!; a < end; a++) {
      const i = sorted[a]!
      if (mov[i] === 0) continue
      let dx = x[i]! - tx
      let dz = z[i]! - tz
      let lx = dx * c1 - dz * s1
      let lz = dx * s1 + dz * c1
      if (lz <= pk.tipZ) continue
      const sx = lx >= 0 ? 1 : -1
      const depth = -((lx * sx - pk.half) * nx + (lz - pk.tipZ) * nz)
      if (depth <= 0) continue
      dx = px[i]! - x0
      dz = pz[i]! - z0
      if (inPocket(kind, dx * c0 - dz * s0, dx * s0 + dz * c0)) continue
      lx += sx * nx * depth
      lz += nz * depth
      x[i] = tx + lx * c1 + lz * s1
      z[i] = tz - lx * s1 + lz * c1
    }
  }
}

/**
 * Around every held tool: the pile's nose, then a few more relaxation passes in pile mode. A blade moves half a ball
 * diameter per step, and two global passes cannot keep the pile in front of it from being squashed flat.
 */
function packPiles(s: GameState) {
  const b = s.balls
  const memos = bladeMemos.get(s)
  for (let pass = 0; pass < PILE_PASSES; pass++) {
    let any = false
    for (let k = 0; k < s.tools.length; k++) {
      const tool = s.tools[k]!
      if (!tool.exists || tool.holder === 'none') continue
      pileRegion(tool)
      const arc = BLADE_ARCS[tool.kind]
      pileFx = Math.sin(tool.heading)
      pileFz = Math.cos(tool.heading)
      pileX = tool.x + pileFx * arc.cz
      pileZ = tool.z + pileFz * arc.cz
      pileR = arc.R
      pileTip = arc.tipZ - arc.cz
      pileHalf = POCKETS[tool.kind].half
      pileNose = POCKETS[tool.kind].nose
      collideBalls(b, 0, (pass & 1) === 1, regRow0, regRow1, regCol0, regCol1)
      pileR = 0
      any = true
    }
    if (!any) return
    collideSolids(s)
    // the nose has the last word, or the passes above would feed the pocket from outside
    for (let k = 0; k < s.tools.length; k++) {
      const tool = s.tools[k]!
      if (!tool.exists || tool.holder === 'none') continue
      pileRegion(tool)
      const m = memos ? memos[k] : undefined
      const swept = m !== undefined && bladeSwept(tool, m)
      capPile(b, tool.kind, tool.x, tool.z, tool.heading, swept ? m.x : tool.x, swept ? m.z : tool.z, swept ? m.h : tool.heading, tool.bubble !== -1, regRow0, regRow1, regCol0, regCol1)
    }
  }
}

let regRow0 = 0
let regRow1 = 0
let regCol0 = 0
let regCol1 = 0

/** Grid cells around a tool's blade and pile. */
function pileRegion(tool: Tool) {
  bladeAt(tool.kind, tool.x, tool.z, tool.heading, polyA)
  let minX = tool.x
  let maxX = tool.x
  let minZ = tool.z
  let maxZ = tool.z
  const pts = BLADES[tool.kind].poly.length
  for (let q = 0; q < pts; q += 2) {
    minX = Math.min(minX, polyA[q]!)
    maxX = Math.max(maxX, polyA[q]!)
    minZ = Math.min(minZ, polyA[q + 1]!)
    maxZ = Math.max(maxZ, polyA[q + 1]!)
  }
  regRow0 = cellRow(minZ - PILE_REACH)
  regRow1 = cellRow(maxZ + PILE_REACH)
  regCol0 = cellCol(minX - PILE_REACH)
  regCol1 = cellCol(maxX + PILE_REACH)
}

function rememberBlades(s: GameState) {
  const memos = bladeMemos.get(s)
  if (!memos) return
  for (let k = 0; k < s.tools.length; k++) {
    const tool = s.tools[k]!
    const m = memos[k]
    if (!m) continue
    m.kind = tool.exists ? tool.kind : null
    m.x = tool.x
    m.z = tool.z
    m.h = tool.heading
  }
}

function recycleOldestStray(s: GameState): boolean {
  const b = s.balls
  let best = -1
  let age = -1
  for (let i = PERMANENT; i < b.n; i++) {
    if (b.state[i] === BALL_STRAY && b.t[i]! > age) {
      age = b.t[i]!
      best = i
    }
  }
  if (best < 0) return false
  respawn(s, best)
  return true
}

/** State changes after the collisions: bulldozed balls turn loose, loose balls rejoin the flow, fall, or come to rest as strays. */
function settle(s: GameState, dt: number) {
  const b = s.balls
  const x = b.x
  const z = b.z
  const state = b.state
  for (let k = 0; k < touchN; k++) {
    const i = touchList[k]!
    touched[i] = 0
    if (state[i] !== BALL_FLOW) continue
    const r = riverSample(x[i]!, z[i]!)
    if (Math.abs(r.d) > r.halfW + ESCAPE_MARGIN) {
      state[i] = BALL_LOOSE
      b.t[i] = 0
    }
  }
  touchN = 0

  const rollBack = RETURN_SPEED * dt
  const n = b.n
  for (let i = 0; i < n; i++) {
    if (state[i] !== BALL_LOOSE || b.y[i]! > 0 || b.vy[i]! > 0) continue
    const xi = x[i]!
    const zi = z[i]!
    if (zi > L.CLIFF_Z && xi > CLIFF_X0) {
      state[i] = BALL_FALL
      b.t[i] = 0
      b.vy[i] = 0
      continue
    }
    const r = riverSample(xi, zi)
    const out = Math.abs(r.d) - (r.halfW - BALL_R)
    if (out < RETURN_ZONE && r.s > SOURCE_S - 1 && zi <= L.CLIFF_Z) {
      if (out < 0) {
        state[i] = BALL_FLOW
      } else {
        // close to the bed: it rolls back in (toward the centreline is (tz, -tx) on the +d side)
        const pull = r.d > 0 ? rollBack : -rollBack
        x[i] = xi + r.tz * pull
        z[i] = zi - r.tx * pull
      }
      b.t[i] = 0
      continue
    }
    // out on the bank: once no tool has pushed it for a while it stays where it is
    b.t[i] = b.t[i]! + dt
    if (b.t[i]! >= P.STRAY_REST_TIME) {
      state[i] = BALL_STRAY
      b.t[i] = 0
      strayCount++
    }
  }
  while (strayCount > P.MAX_STRAYS && recycleOldestStray(s)) strayCount--
}

/** SPEC 2.3 capture burst: the nearest 15-25 balls are thrown up and outward. */
function burst(s: GameState, cx: number, cz: number, radius: number) {
  const b = s.balls
  const want = randInt(s.rng, BURST_MIN, BURST_MAX)
  const r2 = radius * radius
  let m = 0
  for (let i = 0; i < b.n; i++) {
    const st = b.state[i]!
    if ((st !== BALL_FLOW && st !== BALL_LOOSE) || b.y[i]! > 0) continue
    const dx = b.x[i]! - cx
    const dz = b.z[i]! - cz
    const d2 = dx * dx + dz * dz
    if (d2 > r2 || (m === want && d2 >= burstD2[m - 1]!)) continue
    // insertion into the shortlist of the nearest `want`
    let k = m < want ? m++ : m - 1
    for (; k > 0 && burstD2[k - 1]! > d2; k--) {
      burstD2[k] = burstD2[k - 1]!
      burstIdx[k] = burstIdx[k - 1]!
    }
    burstD2[k] = d2
    burstIdx[k] = i
  }
  for (let k = 0; k < m; k++) {
    const i = burstIdx[k]!
    let dx = b.x[i]! - cx
    let dz = b.z[i]! - cz
    const d = Math.hypot(dx, dz)
    if (d > 1e-4) {
      dx /= d
      dz /= d
    } else {
      const a = rand(s.rng) * Math.PI * 2
      dx = Math.cos(a)
      dz = Math.sin(a)
    }
    const out = randRange(s.rng, 1.5, 3.5)
    b.vx[i] = dx * out
    b.vz[i] = dz * out
    b.vy[i] = Math.sqrt(2 * BURST_GRAVITY * randRange(s.rng, 0.8, 1.3))
    b.y[i] = 1e-3
    b.state[i] = BALL_LOOSE
    b.t[i] = 0
  }
}

// --- bubbles ---------------------------------------------------------------------------------------------------------

/** Each bubble keeps its own lane a little off the centreline (from its id, so it needs no state). */
const laneOffset = (id: number, r: number, halfW: number) => (hash01(id) * 2 - 1) * Math.min(LANE_MAX, Math.max(0, halfW - r - LANE_BANK_MARGIN))

function spawnBubble(s: GameState, size: BubbleSize, sArc: number): Bubble {
  const id = s.nextId++
  const r = P.BUBBLE_DIAMETER[size] / 2
  const cor = corridor(sArc, bedHalfWidth(sArc))
  riverPoint(sArc, cor.shift + laneOffset(id, r, cor.halfW), _pt)
  const b: Bubble = { id, size, r, x: _pt.x, z: _pt.z, vx: 0, vz: 0, roll: 0, state: 'drift', t: 0, tool: -1, age: 0 }
  s.bubbles.push(b)
  return b
}

function pickSize(s: GameState): BubbleSize {
  const u = rand(s.rng)
  return u < P.BUBBLE_MIX.S ? 'S' : u < P.BUBBLE_MIX.S + P.BUBBLE_MIX.M ? 'M' : 'L'
}

/** Gap left between a new bubble and the one ahead of it at the source. */
const SOURCE_GAP = 0.1

/**
 * Room at the source for the biggest bubble, so that a new one never appears inside another. Only drifting bubbles
 * count: they always move on, so the wait always ends (a bubble somebody holds there is pushed apart from instead).
 * The room is measured from where the next bubble will really appear (its lane follows from its id) and is no
 * larger than two rigid spheres need: every extra metre here stretches the short end of the 0.4-2.9 s spawn
 * interval of SPEC 2.3 (4.5 m/s is 0.22 s per metre).
 */
function sourceClear(s: GameState): boolean {
  const biggest = P.BUBBLE_DIAMETER.L / 2
  const cor = corridor(0, bedHalfWidth(0))
  riverPoint(0, cor.shift + laneOffset(s.nextId, biggest, cor.halfW), _pt)
  // a smaller bubble may sit further out in its lane than the biggest one would
  const laneSlack = LANE_MAX - Math.min(LANE_MAX, Math.max(0, cor.halfW - biggest - LANE_BANK_MARGIN))
  for (let i = 0; i < s.bubbles.length; i++) {
    const o = s.bubbles[i]!
    if (o.state !== 'drift') continue
    const reach = biggest + o.r + SOURCE_GAP + laneSlack
    const dx = o.x - _pt.x
    const dz = o.z - _pt.z
    if (dx * dx + dz * dz < reach * reach) return false
  }
  return true
}

function drift(b: Bubble, dt: number) {
  const r = riverSample(b.x, b.z)
  const cor = corridor(r.s, r.halfW)
  const lat = clamp((cor.shift + laneOffset(b.id, b.r, cor.halfW) - r.d) * LANE_PULL, -LANE_SPEED, LANE_SPEED)
  b.vx = r.tx * P.BUBBLE_SPEED - r.tz * lat
  b.vz = r.tz * P.BUBBLE_SPEED + r.tx * lat
  b.x += b.vx * dt
  b.z += b.vz * dt
  b.roll += (P.BUBBLE_SPEED * dt) / b.r
}

/** Docking / docked: the bubble is part of its tool. `b.t` has already been advanced by dt. */
function follow(s: GameState, b: Bubble, dt: number) {
  const tool = s.tools[b.tool]
  if (!tool || !tool.exists || tool.bubble !== b.id) {
    // the tool let go of it without handing it to the grinder: back into the river
    b.state = 'drift'
    b.tool = -1
    b.t = 0
    return
  }
  dockSeat(tool, b.r, _pt)
  const x0 = b.x
  const z0 = b.z
  if (b.state === 'docking' && b.t < P.DOCK_SNAP_TIME) {
    // covering dt / timeLeft of what is left reaches the (moving) seat exactly when the snap time is up
    const k = dt / (P.DOCK_SNAP_TIME - b.t + dt)
    b.x += (_pt.x - b.x) * k
    b.z += (_pt.z - b.z) * k
  } else {
    if (b.state === 'docking') {
      b.state = 'docked'
      b.t = 0
    }
    b.x = _pt.x
    b.z = _pt.z
  }
  const mx = b.x - x0
  const mz = b.z - z0
  if (dt > 0) {
    b.vx = mx / dt
    b.vz = mz / dt
  }
  b.roll += Math.hypot(mx, mz) / b.r
}

const SEPARATE_ROUNDS = 3

function separateBubbles(s: GameState) {
  const list = s.bubbles
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!
    if (a.state === 'gone') continue
    for (let j = i + 1; j < list.length; j++) {
      const c = list[j]!
      if (c.state === 'gone') continue
      const wa = a.state === 'drift' ? 1 : 0
      const wc = c.state === 'drift' ? 1 : 0
      if (wa + wc === 0) continue
      let dx = c.x - a.x
      let dz = c.z - a.z
      const d = Math.hypot(dx, dz)
      const over = a.r + c.r - d
      if (over <= 0) continue
      if (d > 1e-6) {
        dx /= d
        dz /= d
      } else {
        dx = 1
        dz = 0
      }
      // only drifting bubbles give way: a held one belongs to its tool, one on the tray to the grinder
      const k = over / (wa + wc)
      a.x -= dx * k * wa
      a.z -= dz * k * wa
      c.x += dx * k * wc
      c.z += dz * k * wc
    }
  }
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!
    if (a.state !== 'drift') continue
    for (let k = 0; k < RIVER_ROCKS.length; k++) {
      const rock = RIVER_ROCKS[k]!
      const dx = a.x - rock.x
      const dz = a.z - rock.z
      const R = a.r + rock.r
      const d2 = dx * dx + dz * dz
      if (d2 >= R * R || d2 < 1e-10) continue
      const f = R / Math.sqrt(d2)
      a.x = rock.x + dx * f
      a.z = rock.z + dz * f
    }
  }
}

function dock(s: GameState, b: Bubble, toolIdx: number) {
  const tool = s.tools[toolIdx]!
  const byPlayer = tool.holder === 'player'
  b.state = 'docking'
  b.t = 0
  b.tool = toolIdx
  tool.bubble = b.id
  s.stats.bubblesCaught++
  emit(s, { type: 'bubbleDock', id: b.id, tool: toolIdx, x: b.x, z: b.z, r: b.r, byPlayer })
  burst(s, b.x, b.z, b.r + 0.9)
  if (byPlayer) {
    s.player.dismountPending = false
    if (tool.kind === 'cart') showEmoji(s, 'happy')
  }
}

/** True while an oversize bubble touched the doctor's scoop (or him, behind it) in the current step. */
let oversizeContact = false

/**
 * SPEC 2.1 bounds the shove of an oversize bubble: PUSHED lasts PUSHED_DURATION and carries him 1-3.5 m. The scoop's
 * hollow would otherwise hold the bubble like a socket and he would ride in front of it all the way to the fall.
 * So one PUSHED episode is: the bubble carries him while pushedT runs, then it rolls on over him and his scoop
 * without touching them. The push velocity stays set for as long as that takes (stepBubbles clears it once no
 * oversize bubble touches him any more): pushedT = 0 with a push velocity left over means "spent".
 */
const pushSpent = (s: GameState) => s.player.pushedT <= 0 && (s.player.pushVx !== 0 || s.player.pushVz !== 0)

/**
 * A drifting bubble against the tools and the doctor. A held tool with a free blade captures it (SPEC 2.3); any
 * other contact with the doctor on foot or his scoop shoves him out of the bubble's way, and an oversize bubble on
 * the hand scoop also puts him in the PUSHED state.
 */
function meetTools(s: GameState, b: Bubble) {
  const p = s.player
  for (let ti = 0; ti < s.tools.length; ti++) {
    const tool = s.tools[ti]!
    if (!tool.exists || tool.holder === 'none') continue
    const spec = BLADES[tool.kind]
    const arc = BLADE_ARCS[tool.kind]
    const c = Math.cos(tool.heading)
    const sn = Math.sin(tool.heading)
    const dx = b.x - tool.x
    const dz = b.z - tool.z
    const lx = dx * c - dz * sn
    const lz = dx * sn + dz * c
    // nearest point of the blade arc, in the tool's frame
    const rz = lz - arc.cz
    const rho = Math.hypot(lx, rz)
    let qx: number
    let qz: number
    if (rho > 1e-6 && -rz >= rho * arc.cosHalf) {
      qx = (lx / rho) * arc.R
      qz = arc.cz + (rz / rho) * arc.R
    } else {
      qx = lx >= 0 ? arc.tipX : -arc.tipX
      qz = arc.tipZ
    }
    const gap = Math.hypot(qx - lx, qz - lz)
    const over = b.r + P.BLADE_THICKNESS / 2 - gap
    if (over <= 0) continue

    const fits = b.r * 2 <= spec.maxBubble + 1e-9
    // concave side: inside the arc's circle, or out in front of the tips
    const front = rho < arc.R || lz > arc.tipZ
    if (fits && front && tool.bubble === -1 && Math.abs(lx) <= spec.chord / 2 - DOCK_LATERAL_MARGIN) {
      dock(s, b, ti)
      return
    }
    if (tool.holder !== 'player' || p.mode !== 'scoop' || p.tool !== ti) continue // a cart is not shoved about

    const speed = Math.hypot(b.vx, b.vz)
    const ux = speed > 1e-6 ? b.vx / speed : 0
    const uz = speed > 1e-6 ? b.vz / speed : 1
    if (!fits) {
      oversizeContact = true
      if (p.pushedT <= 0) {
        if (pushSpent(s)) continue // it has carried him for the whole PUSHED time: now it rolls on over him
        p.pushedT = P.PUSHED_DURATION
        showEmoji(s, 'scared')
        emit(s, { type: 'bubbleReject', id: b.id, x: b.x, z: b.z })
      }
      p.pushVx = ux * P.PUSH_SPEED
      p.pushVz = uz * P.PUSH_SPEED
    }
    // move the blade (that is, the doctor) out of the bubble along the contact normal
    const push = Math.min(over, SHOVE_MAX)
    if (gap > 1e-6) {
      const nx = (qx - lx) / gap
      const nz = (qz - lz) / gap
      shovePlayer(s, (nx * c + nz * sn) * push, (-nx * sn + nz * c) * push)
    } else {
      shovePlayer(s, ux * push, uz * push)
    }
  }

  if (p.mode === 'cart' || p.mountT > 0 || p.dismountT > 0) return
  const dx = p.x - b.x
  const dz = p.z - b.z
  const d = Math.hypot(dx, dz)
  const over = b.r + P.PLAYER_RADIUS - d
  if (over <= 0) return
  if (p.mode === 'scoop' && b.r * 2 > BLADES.scoop.maxBubble + 1e-9) {
    oversizeContact = true
    if (pushSpent(s)) return
  }
  const push = Math.min(over, SHOVE_MAX)
  if (d > 1e-6) shovePlayer(s, (dx / d) * push, (dz / d) * push)
  else shovePlayer(s, push, 0)
}

function stepBubbles(s: GameState, dt: number) {
  // a tool can only hold a bubble that is really seated on it (otherwise it could never catch another one)
  for (let ti = 0; ti < s.tools.length; ti++) {
    const tool = s.tools[ti]!
    if (tool.bubble === -1) continue
    let held = false
    for (let i = 0; i < s.bubbles.length; i++) {
      const b = s.bubbles[i]!
      if (b.id === tool.bubble && b.tool === ti && (b.state === 'docking' || b.state === 'docked')) held = true
    }
    if (!held) tool.bubble = -1
  }

  s.bubbleSpawnT -= dt
  if (s.bubbleSpawnT <= 0 && s.bubbles.length < P.BUBBLE_MAX_ALIVE && sourceClear(s)) {
    const b = spawnBubble(s, pickSize(s), 0)
    s.bubbleSpawnT = randRange(s.rng, P.BUBBLE_SPAWN_MIN, P.BUBBLE_SPAWN_MAX)
    emit(s, { type: 'bubbleSpawn', id: b.id, size: b.size })
  }

  for (let i = 0; i < s.bubbles.length; i++) {
    const b = s.bubbles[i]!
    b.age += dt
    b.t += dt
    if (b.state === 'drift') drift(b, dt)
    else if (b.state === 'docking' || b.state === 'docked') follow(s, b, dt)
    // 'grinder': grinder.ts moves it
  }
  // a rock can push a bubble back into the one behind it: a few rounds settle the chain (at most 6 bubbles)
  for (let round = 0; round < SEPARATE_ROUNDS; round++) separateBubbles(s)
  oversizeContact = false
  for (let i = s.bubbles.length - 1; i >= 0; i--) {
    const b = s.bubbles[i]!
    if (b.state !== 'drift') continue
    meetTools(s, b)
    if (b.state === 'drift' && b.z >= L.CLIFF_Z) {
      b.state = 'gone'
      s.bubbles.splice(i, 1)
      emit(s, { type: 'bubbleFall', id: b.id, x: b.x, z: b.z, r: b.r })
    }
  }
  const p = s.player
  if (!oversizeContact && p.pushedT <= 0) {
    // the PUSHED episode is over: the next oversize bubble shoves him afresh
    p.pushVx = 0
    p.pushVz = 0
  }
  // a shove moved the doctor (and his tool) after follow() seated the bubble he carries: keep it rigidly in the socket
  for (let i = 0; i < s.bubbles.length; i++) {
    const b = s.bubbles[i]!
    if (b.state !== 'docked') continue
    const tool = s.tools[b.tool]
    if (!tool) continue
    dockSeat(tool, b.r, _pt)
    b.x = _pt.x
    b.z = _pt.z
  }
}

// --- step ------------------------------------------------------------------------------------------------------------

export function stepRiver(s: GameState, dt: number) {
  const b = s.balls
  ensure(b.n)
  px.set(b.x)
  pz.set(b.z)
  stepBubbles(s, dt)
  integrate(s, dt)
  buildGrid(b)
  // two relaxation passes (SPEC 2.3); the solids are applied after each so that they always have the last word
  const soft = Math.min(0.5, SOFT_RATE * dt)
  collideBalls(b, soft, false)
  collideSolids(s)
  collideBalls(b, soft, true)
  collideSolids(s)
  packPiles(s)
  rememberBlades(s)
  settle(s, dt)
}
