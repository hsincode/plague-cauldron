// Binds the drill cart, the rat swarm and the sortie spectacle to the simulation (SPEC 2.10, 2.12, 8.2, 9 rows 23, 24, 28):
//   - the cart (pose, cone spin, wheel roll, heat, Mk II gold) and the dashed circle it is parked in;
//   - the rat carpet around the circle, whose live count follows swarm.fill;
//   - the sortie: dust and sparks, the massacre, the coin fountain that piles into a heap, the ribbons to the HUD.
// The crew at the handle is drawn by actorsView.
//
// Everything that persists is a function of the state alone. A sortie has one clock (sortieTime, from drill.state and
// drill.t), and the tables built below say where every coin and every rat is at any moment of it, so a view created
// in the middle of a sortie or after a skip shows the right picture at once. Events and state changes only add
// particles and springs that settle back to nothing.
import * as THREE from 'three'
import { L, P, PAL, SCREEN_RIGHT, SCREEN_UP } from '../config'
import { TAU, clamp, clamp01, damp, easeInOutQuad, headingOf, lerp, lerpAngle, smoothstep } from '../core/math'
import type { GameEvent } from '../sim/events'
import type { Drill, GameState } from '../sim/types'
import { makeBedOutline, makeDashedCircle } from '../ui/decals'
import type { FxOpts, FxTex } from './fx'
import { COIN_H, createCoinMesh } from './models/coin'
import { DRILL, makeDrill } from './models/drill'
import { createRats } from './models/rat'
import type { ViewCtx, ViewModule } from './types'

// ---------------------------------------------------------------------------------------------------------------
// The sortie clock and the push line
// ---------------------------------------------------------------------------------------------------------------

const T_KILL = P.DRILL_KILL_START
/** The first rats flash crimson, the coins start a moment later (ad 24.63 / 24.77 s). */
const T_COINS = T_KILL + 0.1
const T_PUSH = P.DRILL_PUSH_TIME
/** The last coin of the fountain has landed. */
const T_HEAP = T_PUSH + P.DRILL_COIN_FOUNTAIN
const T_LIFT = T_HEAP + P.DRILL_HEAP_HOLD
const T_PAID = T_LIFT + P.DRILL_FLY_TO_HUD
/** The heap has smothered the flame on the cone (ad 25.4 s). */
const T_SMOTHERED = T_KILL + 1.05

/** Seconds since the push began, continuous over the drill states of one sortie; -1 while parked. */
function sortieTime(d: Drill): number {
  switch (d.state) {
    case 'pushing':
      return d.t
    case 'burst':
      return T_PUSH + d.t
    case 'heap':
      return T_HEAP + d.t
    case 'collect':
      return T_LIFT + d.t
    case 'return':
      return T_PAID + d.t
    default:
      return -1
  }
}

const PARK = L.DRILL_PARK
const END = L.DRILL_END
const FWD_X = Math.sin(PARK.heading)
const FWD_Z = Math.cos(PARK.heading)
/** The cart's right-hand side. */
const SIDE_X = Math.cos(PARK.heading)
const SIDE_Z = -Math.sin(PARK.heading)
const PUSH_LEN = Math.hypot(END.x - PARK.x, END.z - PARK.z)
const CIRCLE = L.DASHED_CIRCLE
const RIM = P.DASHED_CIRCLE_RADIUS
/** Distance along the push line (from the parking spot) at which the cone tip leaves the dashed circle. */
const A_RIM = (() => {
  const px = PARK.x - CIRCLE.x
  const pz = PARK.z - CIRCLE.z
  const b = px * FWD_X + pz * FWD_Z
  return -b + Math.sqrt(Math.max(0, b * b - (px * px + pz * pz - RIM * RIM)))
})()

const UP_LEN = Math.hypot(SCREEN_UP.x, SCREEN_UP.z)
const UP_X = SCREEN_UP.x / UP_LEN
const UP_Z = SCREEN_UP.z / UP_LEN
const RIGHT_LEN = Math.hypot(SCREEN_RIGHT.x, SCREEN_RIGHT.z)
const RIGHT_X = SCREEN_RIGHT.x / RIGHT_LEN
const RIGHT_Z = SCREEN_RIGHT.z / RIGHT_LEN

/** Deterministic 0..1 noise for building the tables (never the simulation's rng). */
const hash = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453
  return x - Math.floor(x)
}

// ---------------------------------------------------------------------------------------------------------------
// The coin heap: where each coin of the sortie rests, how it gets there and how it leaves
// ---------------------------------------------------------------------------------------------------------------

const N_COINS = 1800
/** The rat coins are a good deal smaller than the ones on the pallet and on the doctor's back: 0.34 m (ad 25.9 s, half a rat wide). */
const COIN_SIZE = 0.62
/** Loose coins lying around the heap, some of them inside the dashed circle (ad 25.4-25.8 s). */
const STRAYS = 90
/**
 * The heap buries the cart where it stops (SPEC 2.10): a broad mound about 8 m across, centred a little ahead of the
 * axle and just high enough to cover wheels, housing and cone; the crew at the handle stands chest-deep in its edge.
 */
const HEAP_X = END.x + FWD_X * 1.1
const HEAP_Z = END.z + FWD_Z * 1.1
const HEAP_R = 3.8
const HEAP_PEAK = 1.5
const heapRadius = (a: number) => HEAP_R * (1 + 0.12 * Math.sin(2 * a + 1.1) + 0.09 * Math.sin(3 * a + 2.3) + 0.05 * Math.sin(5 * a + 0.4))
/** Height of the mound at rho = 0 (centre) .. 1 (edge): flat on top, so that the cart is under it. */
const moundAt = (rho: number) => (rho >= 1 ? 0 : HEAP_PEAK * Math.pow(1 - Math.pow(rho, 2.6), 1.3))
/** 0 at the heap's centre .. 1 on its edge. */
const heapRho = (x: number, z: number) => Math.hypot(x - HEAP_X, z - HEAP_Z) / heapRadius(Math.atan2(z - HEAP_Z, x - HEAP_X))
/** Rest height of the heap's surface at (x, z); 0 outside its footprint. */
const heapHeight = (x: number, z: number) => moundAt(heapRho(x, z))
/** The mound swells while the fountain feeds it. */
const heapGrow = (tau: number) => 0.3 + 0.7 * smoothstep(T_COINS, T_HEAP - 0.1, tau)

/**
 * The fountain (ad 24.77-25.9 s): a first burst of coins at T_COINS, then a steady stream until EMIT_SPAN later; the
 * longest flight is FLIGHT_MAX, so the last coin lands just before T_HEAP. The heap grows outward: a coin's place in
 * the queue is SPREAD parts its distance from the centre (by area), the rest chance.
 */
const FLIGHT_MIN = 0.32
const FLIGHT_MAX = 0.52
const EMIT_SPAN = T_HEAP - T_COINS - FLIGHT_MAX - 0.02
const EMIT_BURST = 0.06
const SPREAD = 0.5
/** Sortie time at which most of the coins that rest at `rho` have landed. */
const heapLanding = (rho: number) => T_COINS + EMIT_SPAN * (SPREAD * Math.min(1, rho * rho) + (1 - SPREAD) * 0.6) + FLIGHT_MAX
const SETTLE = 0.16
/** Coins in the air are a shade brighter and more golden than coins at rest (ad 24.8-25.2 s); it wears off after landing. */
const AIR_GLOW = 0.16
const GLOW_OUT = 0.25

/** The heap leaves in this many ribbons, the one nearest the HUD first (ad 26.0-26.4 s: about 12). */
const BANDS = 12
/**
 * Collect progress (0..1) between the launches of two neighbouring ribbons, extra delay toward a ribbon's left end,
 * flight. All ribbons are in the air well before half time and the ladder they form stays together (ad 26.1-26.4 s).
 */
const BAND_STEP = 0.4 / (BANDS - 1)
const BAND_LAG = 0.035
const BAND_FLIGHT = 1 - BAND_STEP * (BANDS - 1) - BAND_LAG
/** The whole heap rises this much over the first LIFT_Q of the collect phase, before the ribbons peel off. */
const LIFT_H = 0.55
const LIFT_Q = 0.12
/**
 * While it rises the heap turns into the ribbons (ad 26.0-26.1 s): every band sheds GATHER of its length and SLIT of
 * its depth, which opens a gap to its neighbours, and its coins tip their faces toward the camera (radians), so that
 * they overlap like scales.
 */
const GATHER = 0.45
const SLIT = 0.35
const FACE_TILT = 0.65
/** Height of the plane on which the ribbons meet the HUD coin: about as far from the camera as the heap, so coins keep their size. */
const HUD_Y = 7

interface CoinTable {
  /** Rest pose: centre (y = base + mound * heapGrow) and tilt. */
  x: Float32Array
  z: Float32Array
  base: Float32Array
  mound: Float32Array
  rx: Float32Array
  ry: Float32Array
  rz: Float32Array
  /** Fountain: sortie time of leaving the cone, flight time, extra arc height, start point, tumble (radians). */
  emit: Float32Array
  flight: Float32Array
  arc: Float32Array
  fromX: Float32Array
  fromY: Float32Array
  fromZ: Float32Array
  spin: Float32Array
  /** Ribbon: band, launch delay inside the band, offset from the band's centre along the flight direction and across it. */
  band: Uint8Array
  lag: Float32Array
  off: Float32Array
  side: Float32Array
  /** Per band: centre of its coins at rest and the lowest "along" coordinate that still belongs to it. */
  bandX: Float32Array
  bandY: Float32Array
  bandZ: Float32Array
  bandFloor: Float32Array
}

function buildCoins(): CoinTable {
  const f = () => new Float32Array(N_COINS)
  const t: CoinTable = {
    x: f(), z: f(), base: f(), mound: f(), rx: f(), ry: f(), rz: f(),
    emit: f(), flight: f(), arc: f(), fromX: f(), fromY: f(), fromZ: f(), spin: f(),
    band: new Uint8Array(N_COINS), lag: f(), off: f(), side: f(),
    bandX: new Float32Array(BANDS), bandY: new Float32Array(BANDS), bandZ: new Float32Array(BANDS), bandFloor: new Float32Array(BANDS),
  }
  const shell = N_COINS - STRAYS
  const golden = Math.PI * (3 - Math.sqrt(5))
  const along = f()
  const queue = f()
  for (let k = 0; k < N_COINS; k++) {
    // A sunflower spiral covers the footprint evenly from the centre outward (index order = radius order); the
    // jitter is as large as the spacing, so no pattern survives, and it frays the edge.
    const stray = k >= shell
    const even = Math.sqrt((k + 0.5) / shell)
    const rho = stray ? 1.03 + 0.42 * Math.pow(hash(k, 1), 1.6) : even * (1 + 0.1 * even * (hash(k, 2) - 0.5))
    const a = stray ? hash(k, 2) * TAU : k * golden
    const r = heapRadius(a) * rho
    t.x[k] = HEAP_X + Math.cos(a) * r + (hash(k, 3) - 0.5) * 0.5
    t.z[k] = HEAP_Z + Math.sin(a) * r + (hash(k, 4) - 0.5) * 0.5
    // a lumpy surface three coins deep, each coin at its own height: overlapping discs never share a plane
    const lumps = 1 + 0.1 * Math.sin(t.x[k] * 2.3 + 1.7) * Math.sin(t.z[k] * 2.9 + 0.4)
    const mound = stray ? 0 : moundAt(Math.min(rho, 0.999)) * lumps
    t.mound[k] = mound
    t.base[k] = COIN_SIZE * COIN_H * 0.5 + 0.012 + (stray ? 0 : (k % 3) * COIN_H * 0.5 + hash(k, 5) * 0.03)
    // coins lie nearly flat on the ground and ever more tumbled up the mound, a few of them on edge
    const slope = stray ? 0 : 0.6 * Math.atan((moundAt(Math.max(0, rho - 0.05)) - moundAt(Math.min(1, rho + 0.05))) / (0.1 * HEAP_R))
    const loose = stray ? 0.05 : hash(k, 19) < 0.07 ? 1.25 : 0.14 + 0.42 * clamp01(mound / 0.5)
    t.rx[k] = slope * Math.sin(a) + (hash(k, 6) - 0.5) * 2 * loose
    t.rz[k] = -slope * Math.cos(a) + (hash(k, 7) - 0.5) * 2 * loose
    t.ry[k] = hash(k, 8) * TAU

    queue[k] = stray ? 0.3 + 0.7 * hash(k, 9) : SPREAD * (k / shell) + (1 - SPREAD) * hash(k, 9)
    t.flight[k] = lerp(FLIGHT_MIN, FLIGHT_MAX, clamp01(0.6 * rho + 0.4 * hash(k, 11)))
    t.arc[k] = 0.8 + 2.4 * hash(k, 12) * hash(k, 13)
    t.fromY[k] = 0.5 + 0.5 * hash(k, 16)
    t.spin[k] = (5 + 9 * hash(k, 17)) * (hash(k, 18) < 0.5 ? -1 : 1)

    along[k] = (t.x[k] - HEAP_X) * UP_X + (t.z[k] - HEAP_Z) * UP_Z
  }
  // each coin starts from wherever the cone is when its turn comes
  const byQueue = Array.from({ length: N_COINS }, (_, k) => k).sort((p, q) => queue[p] - queue[q])
  byQueue.forEach((k, turn) => {
    t.emit[k] = T_COINS + EMIT_SPAN * Math.max(0, (turn / N_COINS - EMIT_BURST) / (1 - EMIT_BURST))
    const travel = PUSH_LEN * easeInOutQuad(t.emit[k] / T_PUSH) + lerp(0.9, DRILL.tip.z, hash(k, 14))
    t.fromX[k] = PARK.x + FWD_X * travel + SIDE_X * (hash(k, 15) - 0.5) * 0.7
    t.fromZ[k] = PARK.z + FWD_Z * travel + SIDE_Z * (hash(k, 15) - 0.5) * 0.7
  })
  // ribbons: slice the heap across the way to the HUD into bands of equal size
  const byAlong = Array.from({ length: N_COINS }, (_, k) => k).sort((p, q) => along[q] - along[p])
  const per = N_COINS / BANDS
  const bandAlong = new Float32Array(BANDS)
  byAlong.forEach((k, rank) => {
    const b = Math.min(BANDS - 1, Math.floor(rank / per))
    t.band[k] = b
    t.bandX[b] += t.x[k] / per
    t.bandY[b] += (t.base[k] + t.mound[k]) / per
    t.bandZ[b] += t.z[k] / per
    bandAlong[b] += along[k] / per
    t.bandFloor[b] = along[k]
  })
  for (let k = 0; k < N_COINS; k++) {
    const b = t.band[k]
    const side = clamp(((t.x[k] - HEAP_X) * RIGHT_X + (t.z[k] - HEAP_Z) * RIGHT_Z) / HEAP_R, -1, 1)
    // the end of a ribbon that is nearer the HUD (screen right) leads, which bends the ribbon into a crescent
    t.lag[k] = BAND_LAG * Math.pow((1 - side) / 2, 1.5)
    t.off[k] = along[k] - bandAlong[b]
    t.side[k] = (t.x[k] - t.bandX[b]) * RIGHT_X + (t.z[k] - t.bandZ[b]) * RIGHT_Z
  }
  return t
}

// ---------------------------------------------------------------------------------------------------------------
// The rat carpet: where each rat lives, who dies in a sortie and in which order
// ---------------------------------------------------------------------------------------------------------------

/**
 * P.RAT_COUNT and P.RATS_KILLED_PER_SORTIE count what is on screen (SPEC 11: RAT_COUNT_VISIBLE). The ad's carpet runs
 * off the screen on three sides, so the whole swarm is twice as big; the dead all lie around the cone, in full view.
 */
const N_RATS = 2 * P.RAT_COUNT
const KILLED = Math.min(N_RATS, P.RATS_KILLED_PER_SORTIE)
const SURVIVORS = N_RATS - KILLED
/** swarm.fill drops by this much in a sortie and climbs back to 1 while the dead are replaced. */
const FILL_DROP = Math.min(1, P.RATS_KILLED_PER_SORTIE / P.RAT_COUNT)
/** The swarm's rats are plump and about 0.8 m long (ad 24.6 s: three quarters of a wheel), a third bigger than the model. */
const RAT_SIZE = 1.3
/** Their ears are two small white ticks (ad 26.6 s), a good deal smaller than the single rat's wedges. */
const EAR_SIZE = 0.7
/** A rat's centre keeps this far outside the dashed line (half a body plus its lunge): rats never enter the circle. */
const RAT_CLEARANCE = 0.78
/**
 * The carpet reaches RAT_REACH from the circle's centre (SPEC 4.3 says 8 m); toward the camera it is DEPTH_NEAR times
 * as deep, because the ad's runs out of the bottom of the picture (24.6 s). L.RAT_FIELD gives its west, north and east
 * limits.
 */
const RAT_REACH = 9
const DEPTH_NEAR = 1.7
/** By how much the carpet is deeper in the direction (ux, uz) from the circle's centre than away from the camera. */
const ratDepth = (ux: number, uz: number) => 1 + (DEPTH_NEAR - 1) * Math.pow(Math.max(0, -(ux * UP_X + uz * UP_Z)), 2)
/** Elbow room of a rat: shoulder to shoulder for the first metres, fraying into loose groups at the far edge. */
const PITCH_RIM = 0.56
const PITCH_FAR = 1.3
const DARTS = 9000
/**
 * Regrow, as shares of the way from the massacre (0) to a full swarm (1): nothing comes back before RUN_IN_FROM,
 * because the heap is still there; a returning rat spends RUN_IN running in from the field edge.
 */
const RUN_IN_FROM = 0.16
const RUN_IN = 0.15
/** A killed rat is a crimson silhouette for this long (SPEC 9 row 23: 3-5 frames of the ad), then shrinks away. */
const FLASH = 0.15
const SHRINK = 0.05
const DEATH = FLASH + SHRINK
/** Tint of the silhouette: the ad's is a deep crimson (#7f3743 on average), darker than the model's full flash. */
const CRIMSON = 0.45
/** Half width of the swath the cone cuts through the swarm: the rats in it are tossed up and aside. */
const SWATH = 0.9
/** The rats make way for healed villagers who walk home through the swarm: at most this many at a time, this wide a berth. */
const WALKERS = 8
const BERTH = 1.0
/** The dying spreads from the heap's centre to its edge in this time (ad: crimson flashes from 24.63 to about 25.6 s). */
const MASSACRE = 0.75
/**
 * How much chance decides who dies, in heap radii: the kill zone has a ragged edge, a few rats outside the heap die
 * and some inside survive and sit on the coins (ad 25.4-25.9 s).
 */
const LUCK = 0.7

interface RatTable {
  /** Home spot and the heading that faces the circle. Indices >= SURVIVORS die in a sortie, the highest roughly first. */
  x: Float32Array
  z: Float32Array
  face: Float32Array
  /** Survivors: how far they back off from the heap at full panic. */
  fleeX: Float32Array
  fleeZ: Float32Array
  /** The killed: sortie time of the death, the toss of those in the cone's path (zero for the rest), the field edge they come back in from. */
  dieAt: Float32Array
  flingX: Float32Array
  flingZ: Float32Array
  fromX: Float32Array
  fromZ: Float32Array
  /** Heap under the home spot: rest height, sortie time at which its coins have landed, collect progress at which they leave. */
  heapY: Float32Array
  heapOn: Float32Array
  heapOff: Float32Array
}

const [FIELD_X0, FIELD_Z0, FIELD_X1] = L.RAT_FIELD

/** Poisson-disc darts over the field, tighter near the circle; returns how many rats found room. */
function scatterRats(scale: number, xs: number[], zs: number[]): number {
  const room: number[] = []
  xs.length = zs.length = 0
  for (let k = 0; k < DARTS; k++) {
    const x = lerp(FIELD_X0 + 0.3, FIELD_X1 - 0.3, hash(k, 21))
    const z = lerp(FIELD_Z0 + 0.3, CIRCLE.z + RIM + (RAT_REACH - RIM) * DEPTH_NEAR, hash(k, 22))
    const cd = Math.hypot(x - CIRCLE.x, z - CIRCLE.z)
    const d = cd - RIM
    // distance from the dashed line, measured as if the carpet were equally deep all round
    const far = d / ratDepth((x - CIRCLE.x) / cd, (z - CIRCLE.z) / cd)
    if (d < RAT_CLEARANCE || far > RAT_REACH - RIM) continue
    const r = scale * lerp(PITCH_RIM, PITCH_FAR, smoothstep(2.0, 6.2, far))
    let free = true
    for (let i = 0; i < xs.length && free; i++) {
      const m = (r + room[i]) / 2
      const dx = xs[i] - x
      const dz = zs[i] - z
      free = dx * dx + dz * dz >= m * m
    }
    if (free) {
      xs.push(x)
      zs.push(z)
      room.push(r)
    }
  }
  return xs.length
}

function buildRats(coins: CoinTable): RatTable {
  const xs: number[] = []
  const zs: number[] = []
  // loosen the whole field until it holds just the swarm, so that the far edge keeps its stragglers
  for (let scale = 1.6; scatterRats(scale, xs, zs) < N_RATS && scale > 0.4; ) scale *= 0.96
  // a few too many: the farthest go
  const rimDist = (i: number) => Math.hypot(xs[i] - CIRCLE.x, zs[i] - CIRCLE.z)
  const kept = xs.map((_, i) => i).sort((p, q) => rimDist(p) - rimDist(q)).slice(0, N_RATS)
  // Position of a rat along and beside the push line, and the sortie time at which the cone's tip gets to it.
  const along = (i: number) => (xs[i] - PARK.x) * FWD_X + (zs[i] - PARK.z) * FWD_Z
  const beside = (i: number) => (xs[i] - PARK.x) * SIDE_X + (zs[i] - PARK.z) * SIDE_Z
  const inPath = (i: number) => Math.abs(beside(i)) < SWATH && along(i) < PUSH_LEN + DRILL.tip.z + 0.4
  const tipAt = (i: number) => {
    const k = clamp01((along(i) - 0.3 - DRILL.tip.z) / PUSH_LEN)
    return T_PUSH * (k < 0.5 ? Math.sqrt(k / 2) : 1 - Math.sqrt((1 - k) / 2))
  }
  // The rats in the cone's path die, and so do most of those under the coming heap, roughly from its centre outward:
  // every patch of the swarm turns crimson before the coins rain on it.
  const doom = (i: number) => (inPath(i) ? 0 : heapRho(xs[i], zs[i]) + hash(i, 24) * LUCK)
  kept.sort((p, q) => doom(q) - doom(p))

  const f = () => new Float32Array(N_RATS)
  const t: RatTable = { x: f(), z: f(), face: f(), fleeX: f(), fleeZ: f(), dieAt: f(), flingX: f(), flingZ: f(), fromX: f(), fromZ: f(), heapY: f(), heapOn: f(), heapOff: f() }
  kept.forEach((src, i) => {
    const x = (t.x[i] = xs[src])
    const z = (t.z[i] = zs[src])
    const cx = x - CIRCLE.x
    const cz = z - CIRCLE.z
    const cd = Math.hypot(cx, cz)
    t.face[i] = headingOf(-cx, -cz) + (hash(i, 23) - 0.5) * 0.5
    const rho = heapRho(x, z)
    const hx = x - HEAP_X
    const hz = z - HEAP_Z
    const hd = Math.hypot(hx, hz) || 1
    if (i < SURVIVORS) {
      // back off from the heap's edge, but neither into the circle nor out of the field
      const amp = 0.8 * Math.exp(-Math.max(0, hd - HEAP_R) / 1.1)
      let fx = clamp(x + (hx / hd) * amp, FIELD_X0 + 0.3, FIELD_X1 - 0.3)
      let fz = Math.max(z + (hz / hd) * amp, FIELD_Z0 + 0.3)
      const fd = Math.hypot(fx - CIRCLE.x, fz - CIRCLE.z)
      if (fd < RIM + RAT_CLEARANCE) {
        fx = CIRCLE.x + ((fx - CIRCLE.x) / fd) * (RIM + RAT_CLEARANCE)
        fz = CIRCLE.z + ((fz - CIRCLE.z) / fd) * (RIM + RAT_CLEARANCE)
      }
      t.fleeX[i] = fx - x
      t.fleeZ[i] = fz - z
    } else {
      // regrown rats trickle in from the south and east edges (SPEC 2.10): straight in along the line from the circle
      const ux = cx / cd
      const uz = cz / cd
      const out = Math.min(RIM + (RAT_REACH - RIM) * ratDepth(ux, uz), ux > 0 ? (FIELD_X1 - CIRCLE.x) / ux : Infinity) + 1.5
      t.fromX[i] = CIRCLE.x + ux * out
      t.fromZ[i] = CIRCLE.z + uz * out
      if (inPath(src)) {
        const side = beside(src) < 0 ? -1 : 1
        t.flingX[i] = SIDE_X * side * 0.8 + FWD_X * 0.6
        t.flingZ[i] = SIDE_Z * side * 0.8 + FWD_Z * 0.6
        t.dieAt[i] = Math.max(T_KILL, tipAt(src)) + 0.08 * hash(i, 25)
      } else t.dieAt[i] = T_KILL + 0.03 + MASSACRE * clamp01(0.75 * rho * rho + 0.4 * hash(i, 25) - 0.1)
    }
    t.heapY[i] = heapHeight(x, z)
    t.heapOn[i] = heapLanding(rho)
    const up = (x - HEAP_X) * UP_X + (z - HEAP_Z) * UP_Z
    let band = 0
    while (band < BANDS - 1 && up < coins.bandFloor[band]) band++
    t.heapOff[i] = band * BAND_STEP
  })
  return t
}

// ---------------------------------------------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------------------------------------------

const COL = {
  sparkHot: 0xfff6d0,
  sparkCool: PAL.fireBright,
  flame: 0xff7a26,
  flameEnd: 0xb3261a,
  blood: 0x7a1626,
  bloodEnd: 0x2c0b14,
  dust: PAL.dirtLit,
} as const

const fxo: FxOpts = { x: 0, y: 0, z: 0, life: 0, size: 0, color: 0 }
/** Fills the one shared options object (Fx.spawn copies it), so emitting a particle allocates nothing. */
function particle(tex: FxTex, additive: boolean, x: number, y: number, z: number, life: number, size: number, size1: number, color: number, color1: number, alpha: number): FxOpts {
  const o = fxo
  o.tex = tex
  o.additive = additive
  o.x = x
  o.y = y
  o.z = z
  o.vx = o.vy = o.vz = 0
  o.life = life
  o.size = size
  o.size1 = size1
  o.color = color
  o.color1 = color1
  o.alpha = alpha
  o.fadeIn = 0.08
  o.fadeOut = 0.6
  o.gravity = o.drag = o.rot = o.spin = o.delay = 0
  o.stretch = 1
  o.flat = o.floor = false
  return o
}

let seed = 0x2f6e2b1
/** Throwaway randomness for particles. */
const rnd = () => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return (seed >>> 0) / 4294967296
}
const spread = (amount: number) => (rnd() - 0.5) * 2 * amount

// ---------------------------------------------------------------------------------------------------------------

/** Footprint of the cart for the Mk II unlock frame (SPEC 9 row 19: 1.3 x the footprint). */
const FOOT_W = DRILL.halfWidth * 2 * 1.3
const FOOT_L = (DRILL.tip.z - DRILL.rearZ) * 1.3
const FOOT_MID = (DRILL.tip.z + DRILL.rearZ) / 2
const UNLOCK_GLOW = 0.36

const target = new THREE.Vector3()

export function createDrillView(ctx: ViewCtx): ViewModule {
  const { fx } = ctx
  const drill = makeDrill()
  const circle = makeDashedCircle()
  circle.root.position.set(CIRCLE.x, 0, CIRCLE.z)
  const rats = createRats(N_RATS, EAR_SIZE)
  rats.setCount(N_RATS)
  const coins = createCoinMesh(N_COINS)
  const unlockFrame = makeBedOutline(FOOT_W, FOOT_L)
  unlockFrame.setOpacity(0)
  ctx.scene.add(drill.root, circle.root, rats.root, coins.mesh, unlockFrame.root)

  const C = buildCoins()
  const R = buildRats(C)
  /** Scale each rat is drawn at: it follows what the state wants, swelling in over a few frames. */
  const shown = new Float32Array(N_RATS)
  const walkX = new Float32Array(WALKERS)
  const walkZ = new Float32Array(WALKERS)
  const walkR = new Float32Array(WALKERS)
  const bandCtrl = new Float32Array(BANDS * 3)

  let lastTime = -1
  let lastTau = -1
  let heat = 0
  let rock = 0
  let rockV = 0
  let panic = 0
  let surge = 0
  let lastTravel = 0
  let dustAcc = 0
  let sparkAcc = 0
  let flameAcc = 0
  let arrived = 0
  /** Seconds since Mk II was bought while its unlock burst plays, else -1. */
  let unlockT = -1

  // --- drill -----------------------------------------------------------------------------------------------------

  function heatOf(d: Drill, tau: number): number {
    if (tau < T_SMOTHERED) return smoothstep(T_KILL - 0.05, T_PUSH, tau)
    // it cools under the coins and is almost cold steel again when the ribbons uncover it
    if (tau < T_PAID) return lerp(1, 0.12, smoothstep(T_SMOTHERED, T_LIFT + 0.1, tau))
    return 0.12 * (1 - clamp01(d.t / (0.5 * P.DRILL_RETURN_TIME)))
  }

  /** Pitch the cart wants from its own acceleration: the nose dips when it is shoved off, kicks up when it brakes. */
  function rockOf(d: Drill): number {
    const k = d.state === 'pushing' ? d.t / T_PUSH : d.state === 'return' ? 1 - d.t / P.DRILL_RETURN_TIME : -1
    if (k < 0 || k > 1) return 0
    const accel = (k < 0.5 ? 1 : -1) * (d.state === 'pushing' ? 1 : -1)
    return accel * 0.034
  }

  function updateDrill(s: GameState, dt: number, time: number, tau: number, jumped: boolean) {
    const d = s.drill
    const sh = Math.sin(d.heading)
    const ch = Math.cos(d.heading)
    const travel = (d.x - PARK.x) * sh + (d.z - PARK.z) * ch
    heat = jumped ? heatOf(d, tau) : heat + (heatOf(d, tau) - heat) * damp(14, dt)
    // the cone bites: a shudder for as long as it bores
    const bore = tau < T_LIFT ? smoothstep(T_KILL - 0.05, T_PUSH, tau) : 0
    const step = Math.min(dt, 1 / 30)
    if (jumped) rock = rockV = 0
    else {
      rockV += ((rockOf(d) - rock) * 330 - rockV * 11) * step
      rock += rockV * step
    }
    const shimmy = bore * 0.014 * Math.sin(time * 71)
    drill.root.position.set(d.x + ch * shimmy, 0, d.z - sh * shimmy)
    drill.root.rotation.y = d.heading
    drill.setSpin(d.spin)
    drill.setRoll(travel / DRILL.wheelRadius)
    drill.setRock(rock + bore * 0.007 * Math.sin(time * 93))
    drill.setGlow(heat * (1 - 0.08 * bore * (0.5 + 0.5 * Math.sin(time * 47) * Math.sin(time * 29))))
    drill.setGold(s.unlocks.drill2)

    if (!jumped && dt > 0) {
      // dust off the wheels for every stretch of ground covered, kicked back against the motion
      const moved = travel - lastTravel
      dustAcc += Math.abs(moved)
      while (dustAcc > 0.22) {
        dustAcc -= 0.22
        for (let side = -1; side <= 1; side += 2) {
          const lx = side * (DRILL.halfWidth - 0.1) + spread(0.1)
          const lz = -Math.sign(moved) * 0.3
          const o = particle('puff', false, d.x + lx * ch + lz * sh, 0.12, d.z - lx * sh + lz * ch, 0.45 + rnd() * 0.25, 0.35, 1.0 + rnd() * 0.4, COL.dust, COL.dust, 0.34)
          o.vx = -Math.sign(moved) * sh * 1.2 + spread(0.5)
          o.vz = -Math.sign(moved) * ch * 1.2 + spread(0.5)
          o.vy = 0.5 + rnd() * 0.5
          o.drag = 3
          o.rot = rnd() * TAU
          o.spin = spread(1.5)
          fx.spawn(o)
        }
      }
      emitSparks(d, dt, tau)
    }
    lastTravel = travel
  }

  /** World position of a point on the cone's axis, `lz` metres ahead of the cart's origin. */
  const coneX = (d: Drill, lz: number) => d.x + Math.sin(d.heading) * lz
  const coneZ = (d: Drill, lz: number) => d.z + Math.cos(d.heading) * lz

  function emitSparks(d: Drill, dt: number, tau: number) {
    if (tau < 0) return
    const boring = tau >= T_KILL && tau < T_LIFT
    // white specks at the spinning tip from the first shove (ad 24.4 s), a shower while it bores, embers while it cools
    sparkAcc += dt * (boring ? 70 : tau < T_KILL ? 16 : tau < T_PAID ? 12 : 0)
    while (sparkAcc >= 1) {
      sparkAcc -= 1
      const lz = lerp(1.3, DRILL.tip.z, Math.sqrt(rnd()))
      const a = rnd() * Math.PI
      const speed = (boring ? 3.5 : 1.8) + rnd() * 4
      const o = particle(rnd() < 0.3 ? 'spark' : 'dot', true, coneX(d, lz), DRILL.tip.y + 0.15 + rnd() * 0.3, coneZ(d, lz), 0.22 + rnd() * 0.25, 0.13 + rnd() * 0.14, 0.03, COL.sparkHot, COL.sparkCool, 1)
      const out = Math.cos(a) * speed
      o.vx = Math.cos(d.heading) * out + Math.sin(d.heading) * spread(2.5)
      o.vz = -Math.sin(d.heading) * out + Math.cos(d.heading) * spread(2.5)
      o.vy = Math.sin(a) * speed * 0.9 + 1
      o.gravity = 13
      o.drag = 1.2
      o.fadeOut = 0.5
      fx.spawn(o)
    }
    if (!boring) return
    // flame licking over the cone until the heap smothers it (ad 24.8-25.4 s), kept above the coins that bury it,
    // and its glow on the ground
    flameAcc += dt * 34 * (1 - smoothstep(T_KILL + 0.6, T_SMOTHERED, tau))
    while (flameAcc >= 1) {
      flameAcc -= 1
      const lz = lerp(1.4, DRILL.tip.z + 0.9, rnd())
      const x = coneX(d, lz) + spread(0.35)
      const z = coneZ(d, lz) + spread(0.35)
      const top = Math.max(0.6, heapHeight(x, z) * heapGrow(tau) * smoothstep(-0.05, 0.15, tau - heapLanding(heapRho(x, z))) + 0.25)
      // mostly opaque tongues (an additive flame would bleach on the bright coins), a few additive for the hot core
      const core = rnd() < 0.3
      const o = particle('puff', core, x, top + rnd() * 0.3, z, 0.26 + rnd() * 0.16, core ? 0.6 : 0.9 + rnd() * 0.5, core ? 1.2 : 1.8 + rnd() * 0.6, core ? COL.sparkCool : COL.flame, COL.flameEnd, core ? 0.45 : 0.85)
      o.vx = Math.sin(d.heading) * 2.4 + spread(0.6)
      o.vz = Math.cos(d.heading) * 2.4 + spread(0.6)
      o.vy = 1.4 + rnd() * 1.6
      o.rot = rnd() * TAU
      o.spin = spread(3)
      o.fadeIn = 0.15
      o.fadeOut = 0.35
      fx.spawn(o)
      if (rnd() < 0.4) {
        const g = particle('dot', true, coneX(d, DRILL.tip.z - 0.5), 0.05, coneZ(d, DRILL.tip.z - 0.5), 0.14, 3.6 + rnd(), 4.4, COL.flame, COL.flameEnd, 0.2)
        g.flat = true
        g.fadeIn = 0.3
        g.fadeOut = 0.3
        fx.spawn(g)
      }
    }
  }

  // --- rats ------------------------------------------------------------------------------------------------------

  function bloodPuff(x: number, y: number, z: number) {
    const o = particle('puff', false, x, y + 0.2, z, 0.34 + rnd() * 0.16, 0.45, 0.95 + rnd() * 0.3, COL.blood, COL.bloodEnd, 0.7)
    o.vx = spread(0.8)
    o.vz = spread(0.8)
    o.vy = 0.7 + rnd() * 0.6
    o.drag = 2
    o.rot = rnd() * TAU
    fx.spawn(o)
    for (let k = 0; k < 2; k++) {
      const e = particle('dot', true, x, y + 0.25, z, 0.25 + rnd() * 0.15, 0.14, 0.04, COL.sparkCool, COL.flameEnd, 1)
      e.vx = spread(3)
      e.vz = spread(3)
      e.vy = 2 + rnd() * 3
      e.gravity = 12
      fx.spawn(e)
    }
  }

  function updateRats(s: GameState, dt: number, time: number, tau: number, q: number, jumped: boolean) {
    const d = s.drill
    const fill = clamp01(s.swarm.fill)
    const pushing = d.state === 'pushing'
    /** 0 right after the massacre .. 1 when the gap is closed again. */
    const regrown = pushing ? 0 : clamp01((fill - (1 - FILL_DROP)) / FILL_DROP)
    // a carpet emptier than one sortie leaves it (never in a game) thins out the survivors as well
    const live = fill >= 1 - FILL_DROP ? SURVIVORS : Math.round((SURVIVORS * fill) / (1 - FILL_DROP))
    // survivors shrink back from the heap when the cone breaks in and drift home while the swarm regrows
    const fear = pushing ? smoothstep(T_KILL - 0.05, T_KILL + 0.15, d.t) : fill < 1 ? 1 - smoothstep(0, 0.5, regrown) : 0
    const fleeing = jumped ? 0 : clamp01((fear - panic) * 3)
    panic = jumped ? fear : panic + (fear - panic) * damp(6, dt)
    surge = jumped ? 0 : surge * Math.exp(-3 * dt)
    const heapUp = tau >= T_COINS && tau < T_PAID
    const grow = heapGrow(tau)
    const sh = Math.sin(d.heading)
    const ch = Math.cos(d.heading)
    rats.time = time
    rats.jitter = 1 + 1.4 * Math.max(panic * (1 - regrown), surge)
    // healed villagers on their way home through the swarm (the berth closes as they fade out)
    let walkers = 0
    for (let v = 0; v < s.villagers.length && walkers < WALKERS; v++) {
      const p = s.villagers[v]
      if (p.state !== 'toExit' || p.z < FIELD_Z0) continue
      walkX[walkers] = p.x
      walkZ[walkers] = p.z
      walkR[walkers++] = BERTH * p.alpha
    }

    for (let i = 0; i < N_RATS; i++) {
      const k = i * 1.618 + 0.37
      const hx = R.x[i]
      const hz = R.z[i]
      // milling: every rat drifts about its spot, looks around and now and then lunges at the circle
      let h = R.face[i] + 0.4 * Math.sin(time * 0.8 + k * 4.1) * Math.sin(time * 0.31 + k) + 1.2 * Math.pow(Math.max(0, Math.sin(time * 0.6 + k * 8.9)), 14) * (i & 1 ? 1 : -1)
      const lunge = 0.14 * Math.pow(Math.max(0, Math.sin(time * (0.9 + 0.5 * (k % 1)) + k * 11.3)), 10) + 0.08 * surge
      let x = hx + 0.07 * Math.sin(time * 1.7 + k * 3.1) + 0.04 * Math.sin(time * 3.9 + k * 7.7) + Math.sin(R.face[i]) * lunge
      let z = hz + 0.07 * Math.sin(time * 1.4 + k * 5.3) + 0.04 * Math.sin(time * 4.3 + k * 2.9) + Math.cos(R.face[i]) * lunge
      let want = 1
      let grown = 1
      let flash = 0
      let pitch = 0
      // a rat whose spot is under the coins rides on top of them until its ribbon leaves
      let y = 0
      if (heapUp && R.heapY[i] > 0) {
        const level = tau < T_LIFT ? smoothstep(-0.08, 0.12, tau - R.heapOn[i]) * grow : 1 - smoothstep(0, 0.12, q - R.heapOff[i])
        y = (R.heapY[i] + 0.1) * level
      }

      if (i < SURVIVORS) {
        want = i < live ? 1 : 0
        const p = clamp01(panic * 1.3 - 0.3 * (k % 1))
        x += R.fleeX[i] * p
        z += R.fleeZ[i] * p
        if (fleeing > 0 && (R.fleeX[i] !== 0 || R.fleeZ[i] !== 0)) h = lerpAngle(h, headingOf(R.fleeX[i], R.fleeZ[i]), fleeing)
      } else {
        // The simulation counts the dead within the push; on screen every rat of the kill zone has its own moment
        // on the sortie clock, when the fountain reaches it (ad: crimson flashes until 25.6 s).
        const t = tau < 0 ? DEATH : tau - R.dieAt[i]
        if (t < DEATH) {
          // shouldered aside by the cone while it passes
          const la = (x - d.x) * sh + (z - d.z) * ch
          const ls = (x - d.x) * ch - (z - d.z) * sh
          const girth = 0.2 + lerp(0.85, 0.3, clamp01((la - 0.8) / (DRILL.tip.z - 0.8)))
          if (la > -0.6 && la < DRILL.tip.z + 0.3 && Math.abs(ls) < girth) {
            const push = (ls < 0 ? -girth : girth) - ls
            x += ch * push
            z -= sh * push
          }
          if (t >= 0) {
            // a crimson silhouette where it stood, then gone; the cone tosses the ones in its path up and aside
            flash = CRIMSON
            grown = t < FLASH ? 1 + 0.12 * Math.sin(Math.min(1, t / 0.07) * Math.PI) : 1 - (t - FLASH) / SHRINK
            if (R.flingX[i] !== 0 || R.flingZ[i] !== 0) {
              const air = Math.min(t, FLASH)
              const turn = i & 1 ? 1 : -1
              x += R.flingX[i] * 3.4 * air
              z += R.flingZ[i] * 3.4 * air
              y += 7 * air - 16 * air * air
              pitch = turn * 11 * air
              h += turn * 7 * air
            }
          }
        } else {
          if (!jumped && tau >= 0 && lastTau >= 0 && lastTau - R.dieAt[i] < DEATH) {
            bloodPuff(x + R.flingX[i] * 3.4 * FLASH, y, z + R.flingZ[i] * 3.4 * FLASH)
            shown[i] = 0
          }
          // regrow: back in the order they died, the rim first, each running in from the field edge during its slice
          const u = (regrown - RUN_IN_FROM - ((N_RATS - 1 - i) / KILLED) * (1 - RUN_IN_FROM - RUN_IN)) / RUN_IN
          if (u <= 0) want = 0
          else if (u < 1) {
            const e = 1 - (1 - u) * (1 - u)
            x += (R.fromX[i] - hx) * (1 - e)
            z += (R.fromZ[i] - hz) * (1 - e)
            h = headingOf(hx - R.fromX[i], hz - R.fromZ[i]) + 0.25 * Math.sin(time * 19 + k)
          }
        }
      }

      for (let w = 0; w < walkers; w++) {
        const dx = x - walkX[w]
        const dz = z - walkZ[w]
        const dist = Math.hypot(dx, dz)
        if (dist < walkR[w] && dist > 1e-3) {
          x += (dx / dist) * (walkR[w] - dist)
          z += (dz / dist) * (walkR[w] - dist)
        }
      }
      // appear with a quick swell, vanish at once
      shown[i] = jumped || want < shown[i] ? want : Math.min(want, shown[i] + dt * 7)
      rats.set(i, x, z, h, shown[i] * grown * RAT_SIZE * (0.9 + 0.2 * (k % 1)), flash, y, pitch)
    }
    rats.commit()
  }

  // --- coins -----------------------------------------------------------------------------------------------------

  /** Fountain and heap: every coin leaves the cone at its time, arcs to its place and settles there. */
  function fountain(tau: number): number {
    const grow = heapGrow(tau)
    let n = 0
    for (let k = 0; k < N_COINS; k++) {
      const age = tau - C.emit[k]
      if (age <= 0) continue
      const rest = age - C.flight[k]
      const y1 = C.base[k] + C.mound[k] * grow
      if (rest < 0) {
        const u = age / C.flight[k]
        const e = 1 - (1 - u) * (1 - u)
        const turn = (1 - u) * (1 - u) * C.spin[k]
        // airborne coins read a little bigger (ad 24.8 s)
        const scale = COIN_SIZE * Math.min(1, 0.35 + u * 5) * (1 + 0.14 * (1 - u))
        coins.putTumbling(n, lerp(C.fromX[k], C.x[k], e), lerp(C.fromY[k], y1, u) + C.arc[k] * 4 * u * (1 - u), lerp(C.fromZ[k], C.z[k], e), C.rx[k] + turn, C.ry[k] + turn * 0.7, C.rz[k] + turn * 1.3, scale)
        coins.glow(n++, AIR_GLOW)
      } else {
        const bounce = rest < SETTLE ? 0.11 * Math.sin((rest / SETTLE) * Math.PI) * (1 - rest / SETTLE) : 0
        coins.putTumbling(n, C.x[k], y1 + bounce, C.z[k], C.rx[k], C.ry[k], C.rz[k], COIN_SIZE)
        coins.glow(n++, rest < GLOW_OUT ? AIR_GLOW * (1 - rest / GLOW_OUT) : 0)
      }
    }
    return n
  }

  /** `target` = the point under the HUD's coin icon where the ribbons end (it moves with the camera). */
  function aimAtHud() {
    const hud = ctx.hud?.coinTarget()
    ctx.fromScreen(hud ? hud.x : ctx.frame.clientWidth * 0.84, hud ? hud.y : 20, HUD_Y, target)
  }

  /** The heap lifts off as one and peels away in ribbons that converge on the HUD coin; q = share of the reward paid. */
  function ribbons(q: number): number {
    aimAtHud()
    const lift = smoothstep(0, LIFT_Q, q)
    for (let b = 0; b < BANDS; b++) {
      // Each ribbon swings out of the straight line, the later ones a little wider: to the right as in the ad when
      // the heap is in view, to the left (into view) when the heap lies beyond the right edge of the screen.
      const dx = target.x - C.bandX[b]
      const dz = target.z - C.bandZ[b]
      const side = clamp(0.6 + (dx * RIGHT_X + dz * RIGHT_Z) / 3, -1.5, 1)
      const bulge = Math.hypot(dx, dz) * (0.16 + 0.1 * (b / (BANDS - 1))) * side
      bandCtrl[b * 3] = C.bandX[b] + dx * 0.45 + RIGHT_X * bulge
      bandCtrl[b * 3 + 1] = lerp(C.bandY[b], target.y, 0.55)
      bandCtrl[b * 3 + 2] = C.bandZ[b] + dz * 0.45 + RIGHT_Z * bulge
    }
    let n = 0
    let gone = 0
    for (let k = 0; k < N_COINS; k++) {
      const b = C.band[k]
      const u = (q - b * BAND_STEP - C.lag[k]) / BAND_FLIGHT
      if (u >= 1) {
        gone++
        continue
      }
      // lifted and already drawn together into its band
      const slit = C.off[k] * SLIT * lift
      const gather = C.side[k] * GATHER * lift
      const sx = C.x[k] - UP_X * slit - RIGHT_X * gather
      const sy = C.base[k] + C.mound[k] + LIFT_H * lift
      const sz = C.z[k] - UP_Z * slit - RIGHT_Z * gather
      const flat = 1 - 0.6 * lift
      const face = FACE_TILT * lift
      if (u <= 0) coins.putTumbling(n, sx, sy, sz, C.rx[k] * flat + face, C.ry[k], C.rz[k] * flat, COIN_SIZE)
      else {
        const w = u * u * (3 - 2 * u)
        const a = (1 - w) * (1 - w)
        const m = 2 * w * (1 - w)
        const c = w * w
        const j = k * 2.4
        coins.putTumbling(
          n,
          a * sx + m * bandCtrl[b * 3] + c * (target.x + 0.12 * Math.sin(j)),
          a * sy + m * bandCtrl[b * 3 + 1] + c * target.y,
          a * sz + m * bandCtrl[b * 3 + 2] + c * (target.z + 0.12 * Math.cos(j)),
          C.rx[k] * flat * (1 - w) + face,
          C.ry[k] + w * 3,
          C.rz[k] * flat * (1 - w),
          COIN_SIZE * (1 - 0.5 * smoothstep(0.7, 1, w)),
        )
      }
      coins.glow(n++, 0)
    }
    // a glint on the HUD coin for the coins that just went in
    for (let k = Math.min(2, gone - arrived); k > 0; k--) {
      const o = particle('spark', true, target.x + spread(0.3), target.y + spread(0.3), target.z + spread(0.3), 0.2, 0.5, 1.1, PAL.goldCore, PAL.gold, 0.9)
      o.rot = rnd() * TAU
      fx.spawn(o)
    }
    arrived = gone
    return n
  }

  // --- one-shot effects ------------------------------------------------------------------------------------------

  /** Flat ring on the ground that grows from `size` to `size1` metres across. */
  function groundRing(x: number, z: number, size: number, size1: number, life: number, color: number, alpha: number) {
    const o = particle('ring', true, x, 0.06, z, life, size, size1, color, color, alpha)
    o.flat = true
    o.fadeIn = 0.05
    o.fadeOut = 0.3
    fx.spawn(o)
  }

  function onPush(d: Drill) {
    // a kick of dust where the crew digs in and the wheels break loose
    for (let k = 0; k < 12; k++) {
      const lx = spread(DRILL.halfWidth)
      const lz = DRILL.rearZ * rnd()
      const o = particle('puff', false, d.x + lx * SIDE_X + lz * FWD_X, 0.12, d.z + lx * SIDE_Z + lz * FWD_Z, 0.5 + rnd() * 0.3, 0.4, 1.2 + rnd() * 0.5, COL.dust, COL.dust, 0.38)
      o.vx = -FWD_X * (1.5 + rnd() * 1.5) + spread(0.8)
      o.vz = -FWD_Z * (1.5 + rnd() * 1.5) + spread(0.8)
      o.vy = 0.6 + rnd() * 0.6
      o.drag = 3
      o.rot = rnd() * TAU
      fx.spawn(o)
    }
  }

  function onKill() {
    // the cone breaks into the swarm where the push line crosses the dashed circle
    const x = PARK.x + FWD_X * (A_RIM + 0.4)
    const z = PARK.z + FWD_Z * (A_RIM + 0.4)
    const flash = particle('dot', true, x, 0.7, z, 0.12, 0.8, 2.2, COL.sparkHot, COL.flame, 0.6)
    flash.fadeOut = 0.3
    fx.spawn(flash)
    const glint = particle('spark', true, x, 0.7, z, 0.16, 1.2, 3.0, COL.sparkHot, COL.sparkHot, 0.9)
    glint.rot = rnd() * TAU
    glint.fadeOut = 0.3
    fx.spawn(glint)
    groundRing(x, z, 1.2, 7, 0.32, COL.flame, 0.7)
    for (let k = 0; k < 30; k++) {
      const a = rnd() * TAU
      const speed = 4 + rnd() * 6
      const o = particle(k % 3 ? 'dot' : 'spark', true, x, 0.5, z, 0.3 + rnd() * 0.25, 0.16 + rnd() * 0.14, 0.04, COL.sparkHot, COL.sparkCool, 1)
      o.vx = Math.cos(a) * speed
      o.vz = Math.sin(a) * speed
      o.vy = 2 + rnd() * 5
      o.gravity = 14
      o.drag = 1.5
      fx.spawn(o)
    }
    for (let k = 0; k < 14; k++) {
      const a = rnd() * TAU
      const o = particle('puff', false, x + Math.cos(a) * 0.5, 0.3, z + Math.sin(a) * 0.5, 0.45 + rnd() * 0.25, 0.5, 1.3 + rnd() * 0.5, k % 2 ? COL.blood : COL.dust, k % 2 ? COL.bloodEnd : COL.dust, 0.6)
      o.vx = Math.cos(a) * (2 + rnd() * 2)
      o.vz = Math.sin(a) * (2 + rnd() * 2)
      o.vy = 0.8 + rnd()
      o.drag = 3
      o.rot = rnd() * TAU
      fx.spawn(o)
    }
  }

  function onHeapLift() {
    // the director's kill shake has died away by now; the lift-off and the stream keep the ground humming
    ctx.director.shake(0.04, P.DRILL_FLY_TO_HUD)
    // glints where the coins leave the ground
    for (let k = 0; k < 22; k++) {
      const a = rnd() * TAU
      const r = heapRadius(a) * Math.sqrt(rnd())
      const x = HEAP_X + Math.cos(a) * r
      const z = HEAP_Z + Math.sin(a) * r
      const o = particle('spark', true, x, heapHeight(x, z) + 0.4, z, 0.25 + rnd() * 0.2, 0.15, 0.5 + rnd() * 0.25, 0xffffff, PAL.goldCore, 0.9)
      o.vy = 1.5 + rnd() * 2.5
      o.rot = rnd() * TAU
      o.delay = rnd() * 0.2
      fx.spawn(o)
    }
  }

  function onPaid() {
    aimAtHud()
    const flash = particle('spark', true, target.x, target.y, target.z, 0.22, 0.8, 2.6, PAL.goldCore, PAL.gold, 0.9)
    flash.spin = 5
    fx.spawn(flash)
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU
      const o = particle('spark', true, target.x, target.y, target.z, 0.3 + rnd() * 0.15, 0.5, 0.1, PAL.goldCore, PAL.gold, 1)
      // spread in the camera's image plane: screen right and (roughly) screen up
      o.vx = RIGHT_X * Math.cos(a) * 5
      o.vz = RIGHT_Z * Math.cos(a) * 5
      o.vy = Math.sin(a) * 5
      o.drag = 4
      fx.spawn(o)
    }
  }

  function onSwarmReady() {
    // the circle pings and the rats press in again
    surge = 1
    groundRing(CIRCLE.x, CIRCLE.z, RIM * 2.38, RIM * 2.38 + 2.2, 0.55, PAL.gold, 0.55)
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU + spread(0.15)
      const o = particle('spark', true, CIRCLE.x + Math.cos(a) * RIM, 0.25, CIRCLE.z + Math.sin(a) * RIM, 0.4 + rnd() * 0.2, 0.25, 0.6, PAL.goldCore, PAL.gold, 0.9)
      o.vy = 1 + rnd()
      o.rot = rnd() * TAU
      o.delay = rnd() * 0.12
      fx.spawn(o)
    }
  }

  function onUnlock(d: Drill) {
    unlockT = 0
    // golden curtain rising from the cart's outline (SPEC 9 row 19) and a flare on the new cone
    const sh = Math.sin(d.heading)
    const ch = Math.cos(d.heading)
    for (let k = 0; k < 44; k++) {
      const u = (k / 44) * 4
      const edge = Math.floor(u)
      const along = (u - edge) * 2 - 1
      const lx = (edge === 0 ? along : edge === 2 ? -along : edge === 1 ? 1 : -1) * FOOT_W * 0.5
      const lz = FOOT_MID + (edge === 1 ? along : edge === 3 ? -along : edge === 0 ? 1 : -1) * FOOT_L * 0.5
      const o = particle('streak', true, d.x + lx * ch + lz * sh, 0.3 + rnd() * 0.5, d.z - lx * sh + lz * ch, UNLOCK_GLOW * (0.7 + rnd() * 0.5), 0.5, 0.35, PAL.goldCore, PAL.gold, 0.55)
      o.stretch = 4 + rnd() * 3
      o.vy = 3 + rnd() * 3
      o.delay = rnd() * 0.08
      o.fadeIn = 0.2
      o.fadeOut = 0.4
      fx.spawn(o)
    }
    for (let k = 0; k < 20; k++) {
      const lz = lerp(DRILL.rearZ, DRILL.tip.z, rnd())
      const lx = spread(DRILL.halfWidth)
      const o = particle('spark', true, d.x + lx * ch + lz * sh, 0.4 + rnd() * 1.2, d.z - lx * sh + lz * ch, 0.35 + rnd() * 0.25, 0.2, 0.6, 0xffffff, PAL.goldCore, 1)
      o.vy = 1.5 + rnd() * 2
      o.rot = rnd() * TAU
      o.delay = rnd() * 0.2
      fx.spawn(o)
    }
    const flare = particle('dot', true, coneX(d, 1.9), 0.9, coneZ(d, 1.9), 0.3, 1.6, 3.4, PAL.goldCore, PAL.gold, 0.7)
    flare.fadeOut = 0.2
    fx.spawn(flare)
  }

  function updateUnlock(d: Drill, dt: number) {
    if (unlockT < 0) return
    unlockT += dt
    // the new cone pops in: a quick swell past full size that rings out
    drill.root.scale.setScalar(unlockT < 0.7 ? 1 - 0.28 * Math.exp(-9 * unlockT) * Math.cos(22 * unlockT) : 1)
    // the frame stays for the glow and lingers two or three frames of the ad as a thin outline
    unlockFrame.root.position.set(coneX(d, FOOT_MID), 0, coneZ(d, FOOT_MID))
    unlockFrame.root.rotation.y = d.heading
    unlockFrame.setOpacity(unlockT < UNLOCK_GLOW ? Math.min(1, unlockT / 0.05) : Math.max(0, 1 - (unlockT - UNLOCK_GLOW) / 0.1))
    if (unlockT >= 0.7) unlockT = -1
  }

  return {
    onEvent(e: GameEvent, s: GameState) {
      switch (e.type) {
        case 'drillPush':
          onPush(s.drill)
          break
        case 'drillKill':
          onKill()
          break
        case 'drillHeapLift':
          onHeapLift()
          break
        case 'drillPaid':
          onPaid()
          break
        case 'swarmReady':
          onSwarmReady()
          break
        case 'drillCrewJoin':
          groundRing(L.DRILL_HANDLE.x, L.DRILL_HANDLE.z, 0.5, 2.0, 0.3, PAL.gold, 0.45)
          break
        case 'unlock':
          if (e.id === 'drill2') onUnlock(s.drill)
          break
      }
    },
    update(s, frameDt, time) {
      // the very first frame of a page can come with a negative frame time
      const dt = Math.max(0, frameDt)
      const d = s.drill
      const jumped = lastTime < 0 || s.time < lastTime || s.time - lastTime > 0.25
      lastTime = s.time
      const tau = sortieTime(d)
      const q = d.state === 'collect' && d.reward > 0 ? d.paid / d.reward : 0

      updateDrill(s, dt, time, tau, jumped)
      updateUnlock(d, dt)
      circle.update(time)
      updateRats(s, dt, time, tau, q, jumped)
      if (d.state !== 'collect') arrived = 0
      coins.commit(tau < T_COINS || tau >= T_PAID ? 0 : tau < T_LIFT ? fountain(tau) : ribbons(q))
      lastTau = tau
    },
  }
}
