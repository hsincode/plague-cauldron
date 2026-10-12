// Coins (SPEC 2.8, 2.9, 2.12; section 9 rows 15-17): the pallet and its 2x2 stacks, the fountain from the bathers,
// the pickup chain, the column on the doctor's back, the stream that pays a pad, and the bursar's chest with its
// ribbon to the HUD.
//
// What exists is read from the state every frame: the pallet discs from pallet.gold, the column from
// player.carriedGold, the chest from unlocks.bursar. Coins in the air are an overlay driven by the changes of those
// numbers (plus the coinFountain event, which says where a fountain starts). A flight never owns gold: it only
// covers the trip of a disc that the state has already moved, so after a skip the picture is right without them.
//
// Disc worth: GOLD_PER_COIN_MESH gold, except the discs of the double-fee first batch, which are worth twice that
// (the sim sends the same 13 meshes per bather, and the ad's pallet is 6-7 layers high after the +100 batch).
import * as THREE from 'three'
import { L, P, PAL, SCREEN_RIGHT } from '../config'
import { clamp, clamp01, damp, easeOutBack, smoothstep } from '../core/math'
import type { GameEvent } from '../sim/events'
import { padPayDuration } from '../sim/pads'
import type { GameState } from '../sim/types'
import { offsetRight, stackSides } from './anchors'
import type { FxOpts } from './fx'
import { COIN_H, createCoinMesh } from './models/coin'
import { makeChest, makePallet, PALLET_SLOTS, palletCoinPos } from './models/furniture'
import type { ViewCtx, ViewModule } from './types'

/** Discs drawn on the pallet (60 layers); gold beyond that is still there but adds no height. */
const PALLET_MAX = 240
const COLUMN_MAX = P.BACK_COLUMN_MAX_DISCS
const MAX_FLIGHTS = 320
const GHOST_CAP = 32
const FIRST_WORTH = P.GOLD_PER_COIN_MESH * P.FIRST_BATCH_MULTIPLIER
/** Sim-time gap that is treated as a skip: nothing is launched for what happened inside it. */
const MAX_STEP = 0.3
/** A fountain coin has landed when the sim clock is within this of its landing time (the two clocks round differently). */
const LAND_EPS = 1e-6

// --- fountain (ad 14.63-15.73): the whole rope leaves the bather in a third of a second, reaches the pallet after
// COIN_FLIGHT and then pours onto it at the sim's pace ---
const FOUNTAIN_EMIT_SPAN = 0.36
const FOUNTAIN_APEX = 3.3
const FOUNTAIN_SOURCE_Y = 1.5
/** Tint of a fountain coin (CoinMesh.glow): the ad's rope is golden (#ffd87a on the faces), not lemon. */
const FOUNTAIN_GLOW = 0.45
/** Fountains that start within this time of each other (the bathers of one batch) pour through one rope, two by two. */
const ROPE_JOIN = 0.5
const ROPES = 4
// --- fresh disc on the pallet: squash and a fading glow (the very first ones fade in as ghosts) ---
const FRESH_GHOST = 0.05
const FRESH_SQUASH = 0.2
const FRESH_GLOW = 0.45
// --- pickup chain (ad 18.33-18.73): one speed for every coin, so the chain to a tall column is as dense as the first ---
const CHAIN_SPEED = 17
const CHAIN_FLIGHT = 0.28
const CHAIN_FLIGHT_MAX = 0.45
/** Apex above ctx.anchors.playerHead (the emoji point over the feather): 0.85 m over the hat crown, 1.9 m over the pallet stacks. */
const CHAIN_OVER_HEAD = 0.1
const GHOST_LIFE = 0.16
// --- pad payment (ad 19.77-20.23, 27.77-28.43): a parabola whose axis stands on the pad ---
const PAY_FLIGHT = 0.27
/** The last coins of a payment fly faster: they have to land before the pad is gone. */
const PAY_FLIGHT_MIN = 0.17
/** Height of the parabola's control point above the coin's start; less from a tall column. Apex 1.4 m over the belt, 0.4 m over 50 discs. */
const PAY_LIFT = 3.6
const PAY_LIFT_PER_DROP = 0.45
const PAY_LIFT_MIN = 1.8
const PAY_LINGER = 0.09
const PAY_SINK = 0.05
const PAD_Y = 0.04
/** Coins of one payment: dearer pads pay with fewer, worthier coins so that the stream stays a stream. */
const PAY_COINS = 50
const BELT_Y = 0.95
// --- bursar: pallet -> chest -> HUD ---
const BURSAR_IN = 0.26
const BURSAR_HOLD = 0.07
const BURSAR_OUT = 0.5
const CHEST_MOUTH_Y = 0.5
const CHEST_POP_DELAY = 0.2
const CHEST_POP_TIME = 0.28
const LID_AJAR = 0.12
const LID_OPEN = 0.92
/** Coins of one ribbon; a bigger collection sends the next ones along a second, mirrored curve. */
const RIBBON_COINS = 26
/** Height of the plane on which the HUD end of the ribbon lies: above every prop, so nothing hides the coins. */
const HUD_PLANE_Y = 6
/** Size of a coin arriving at the HUD icon relative to a coin at the camera target (icon 24 px, coin 35 px). */
const HUD_COIN_SIZE = 0.68
// --- back column: a few degrees when he starts, up to LEAN_MAX when he brakes hard or turns back ---
const LEAN_MAX = (10 * Math.PI) / 180
const LEAN_GAIN = 0.03 // radians per m/s of velocity change
const LEAN_LAG = 0.12
const LEAN_OMEGA = 21
const LEAN_ZETA = 0.38
const WOBBLE_MAX = 0.035
const WOBBLE_DECAY = 0.3

// flight kinds
const FOUNTAIN = 1
const CHAIN = 2
const PAY = 3
const BURSAR = 4
const GHOST = 5
// flight record layout (one row of STRIDE numbers per coin in the air)
const KIND = 0
const AGE = 1 // seconds since it left (not used by fountain coins, which run on the sim clock)
const DUR = 2 // flight time; fountain: delay of its launch after the rope started
const X = 3 // where it left from (fountain: only Y, the rope gives the rest)
const Y = 4
const Z = 5
const SEED = 6 // 0..1
const ORD = 7 // running number
const WHO = 8 // fountain: rope; pay: pad index; bursar: side its ribbon bends to
const FLAG = 9 // fountain: 1 = coin of the double-fee batch; pay / bursar: 1 = has landed / has dropped into the chest
const LAND = 10 // fountain: sim time at which the sim lands it
const START = 11 // fountain: sim time at which its rope started
const SLOW = 12 // fountain: speed of the rope once its head has landed (1 = unchanged)
const GOLD = 13 // fountain: what it is worth
const STRIDE = 14

const TAU = Math.PI * 2

export function createCoinsView(ctx: ViewCtx): ViewModule {
  const pallet = makePallet()
  pallet.root.position.set(L.PALLET.x, 0, L.PALLET.z)
  const chest = makeChest()
  chest.root.position.set(L.BURSAR_CHEST.x, 0, L.BURSAR_CHEST.z)
  chest.root.rotation.y = -0.3 // lock toward the camera
  chest.root.visible = false
  const coins = createCoinMesh(PALLET_MAX + COLUMN_MAX + MAX_FLIGHTS)
  const ghosts = createCoinMesh(GHOST_CAP, 'ghost')
  ctx.scene.add(pallet.root, chest.root, coins.mesh, ghosts.mesh)
  const M = coins.mesh.instanceMatrix.array as Float32Array
  let n = 0 // solid coins written this frame
  let g = 0 // ghost coins written this frame

  const v = new THREE.Vector3()
  const q = new THREE.Vector3()
  const fwd = new THREE.Vector3()

  let rs = 0x2545f491
  /** View-only randomness (the sim's rng must not be touched from here). */
  const rnd = () => {
    rs ^= rs << 13
    rs ^= rs >>> 17
    rs ^= rs << 5
    return (rs >>> 0) / 4294967296
  }
  /** Stable 0..1 hash of a flight's seed, for a second and third independent value. */
  const hash = (seed: number, k: number) => {
    const x = Math.sin(seed * 91.7 + k * 37.3) * 43758.5453
    return x - Math.floor(x)
  }

  const fxo: FxOpts = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0.2, size: 0.3, size1: 0.05, color: PAL.goldCore, color1: PAL.gold, alpha: 1, fadeIn: 0.1, fadeOut: 0.4, gravity: 0, drag: 0, tex: 'spark', additive: true, rot: 0, spin: 0, flat: false, stretch: 1, delay: 0, floor: false }
  const sparkle = (x: number, y: number, z: number, size: number, life: number) => {
    fxo.x = x
    fxo.y = y
    fxo.z = z
    fxo.vx = (rnd() - 0.5) * 0.8
    fxo.vy = 0.4 + rnd() * 0.8
    fxo.vz = (rnd() - 0.5) * 0.8
    fxo.size = size
    fxo.life = life
    fxo.rot = rnd() * TAU
    fxo.spin = (rnd() - 0.5) * 6
    ctx.fx.spawn(fxo)
  }

  // ---------------------------------------------------------------------------------------------------------------
  // instance writers (the CoinMesh setters only scale uniformly; squash and the leaning column need more)

  /** Solid coin lying flat, squashed: sxz across, sy along its axis. */
  const flat = (x: number, y: number, z: number, yaw: number, sxz: number, sy: number, glow: number) => {
    const o = n * 16
    const c = Math.cos(yaw) * sxz
    const s = Math.sin(yaw) * sxz
    M[o] = c
    M[o + 1] = 0
    M[o + 2] = -s
    M[o + 3] = 0
    M[o + 4] = 0
    M[o + 5] = sy
    M[o + 6] = 0
    M[o + 7] = 0
    M[o + 8] = s
    M[o + 9] = 0
    M[o + 10] = c
    M[o + 11] = 0
    M[o + 12] = x
    M[o + 13] = y
    M[o + 14] = z
    M[o + 15] = 1
    coins.glow(n++, glow)
  }
  /** Solid coin with a free orientation (Euler XYZ). */
  const tumbling = (x: number, y: number, z: number, rx: number, ry: number, rz: number, scale: number, glow: number) => {
    coins.putTumbling(n, x, y, z, rx, ry, rz, scale)
    coins.glow(n++, glow)
  }
  const ghost = (x: number, y: number, z: number, scale: number, glow: number) => {
    if (g >= GHOST_CAP) return
    ghosts.put(g, x, y, z, 0, scale)
    ghosts.glow(g++, glow)
  }

  /**
   * Point at fraction u of an arch that is run at an even pace: straight up from a, half an ellipse (at most rMax
   * high) over the top, straight down on b.
   */
  const arch = (u: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, top: number, rMax: number, out: THREE.Vector3) => {
    const half = Math.hypot(bx - ax, bz - az) / 2
    const r = Math.max(0.05, Math.min(rMax, top - Math.max(ay, by)))
    const up = Math.max(0, top - r - ay)
    const down = Math.max(0, top - r - by)
    const over = Math.PI * Math.sqrt((half * half + r * r) / 2)
    const d = u * (up + over + down)
    if (d <= up) return out.set(ax, ay + d, az)
    if (d >= up + over) return out.set(bx, by + (up + over + down - d), bz)
    const f = (d - up) / over
    // the angle is re-timed so that a tall or a flat ellipse is not crowded where it turns
    const a = Math.PI * (f - (((r - half) / (r + half)) * Math.sin(f * TAU)) / TAU)
    const go = 0.5 - 0.5 * Math.cos(a)
    return out.set(ax + (bx - ax) * go, top - r + r * Math.sin(a), az + (bz - az) * go)
  }
  /** Length of that arch. */
  const archLength = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, top: number, rMax: number) => {
    const half = Math.hypot(bx - ax, bz - az) / 2
    const r = Math.max(0.05, Math.min(rMax, top - Math.max(ay, by)))
    return Math.max(0, top - r - ay) + Math.PI * Math.sqrt((half * half + r * r) / 2) + Math.max(0, top - r - by)
  }
  /** Top of the pickup chain between two heights: a rainbow over the doctor's hat (ad 18.4 s), and over a column taller than him. */
  const chainTop = (ay: number, by: number) => Math.max(ctx.anchors.playerHead.y + CHAIN_OVER_HEAD, Math.max(ay, by) + 0.6)

  // ---------------------------------------------------------------------------------------------------------------
  // flights (swap-remove)

  const F = new Float64Array(MAX_FLIGHTS * STRIDE)
  let nF = 0
  let seq = 0
  /** New flight; returns the offset of its record, or -1 when the pool is full. */
  const alloc = (kind: number, x: number, y: number, z: number, dur: number, age: number): number => {
    if (nF >= MAX_FLIGHTS) return -1
    const o = nF++ * STRIDE
    F.fill(0, o, o + STRIDE)
    F[o + KIND] = kind
    F[o + AGE] = age
    F[o + DUR] = dur
    F[o + X] = x
    F[o + Y] = y
    F[o + Z] = z
    F[o + SEED] = rnd()
    F[o + ORD] = seq++
    return o
  }
  const free = (i: number) => {
    const last = --nF * STRIDE
    if (i * STRIDE !== last) F.copyWithin(i * STRIDE, last, last + STRIDE)
  }
  const count = (kind: number) => {
    let c = 0
    for (let o = 0; o < nF * STRIDE; o += STRIDE) if (F[o + KIND] === kind) c++
    return c
  }

  // ---------------------------------------------------------------------------------------------------------------
  // pallet, derived from the state

  let palFirst = 0 // gold of the double-fee batch still lying there
  let palLater = 0
  const landT = new Float64Array(PALLET_MAX).fill(-1e9) // sim time at which disc i appeared
  const stackTop = new Float32Array(4)
  const discsOf = (first: number, later: number) => Math.ceil(first / FIRST_WORTH - 1e-6) + Math.ceil(later / P.GOLD_PER_COIN_MESH - 1e-6)
  const readPallet = (s: GameState) => {
    const inc = s.pallet.incoming
    const wait = s.cauldron.fountains
    let air = 0
    for (let i = 1; i < inc.length; i += 2) air += inc[i]
    for (let i = 2; i < wait.length; i += 3) air += wait[i]
    const bathed = s.stats.bathed
    const firstBathers = s.cauldron.batches === 0 ? bathed : Math.min(bathed, s.cauldron.slots)
    const paid = P.BATH_FEE * (bathed + (P.FIRST_BATCH_MULTIPLIER - 1) * firstBathers)
    const gold = s.pallet.gold
    // gold that has left the pallet so far; the double-fee coins lie at the bottom but are counted out first, which
    // keeps the disc count continuous whatever the player does
    const taken = Math.max(0, paid - air - gold)
    const firstLanded = P.BATH_FEE * P.FIRST_BATCH_MULTIPLIER * firstBathers - (bathed <= firstBathers ? air : 0)
    palFirst = clamp(firstLanded - taken, 0, gold)
    palLater = gold - palFirst
  }
  /** World position of the centre of pallet disc `index` at rest. */
  const slotPos = (index: number, out: THREE.Vector3) => {
    palletCoinPos(index, out)
    out.x += L.PALLET.x
    out.z += L.PALLET.z
    return out
  }

  // ---------------------------------------------------------------------------------------------------------------
  // back column

  const base = new THREE.Vector3()
  const R = new Float32Array(9) // rotation taking +y to the leaning axis, after the yaw of the doctor's heading
  let heading = 0
  let side = 0 // metres to the doctor's right
  let ax = 0 // unit axis of the column
  let ay = 1
  let az = 0
  let leanX = 0
  let leanZ = 0
  let leanVx = 0
  let leanVz = 0
  let lagVx = 0
  let lagVz = 0
  let wobble = 0
  let wobblePhase = 0
  let topKick = 0
  let shown = 0 // discs standing in the column
  const columnPos = (k: number, out: THREE.Vector3) => {
    const h = (k + 0.5) * COIN_H
    const w = wobble * Math.min(1, k / 12) * Math.sin(k * 0.42 - wobblePhase)
    return out.set(base.x + ax * h + SCREEN_RIGHT.x * w, base.y + ay * h, base.z + az * h + SCREEN_RIGHT.z * w)
  }

  // ---------------------------------------------------------------------------------------------------------------
  // what the last frame looked like, to see what changed

  let lastNow = NaN
  let lastDiscs = 0
  let lastCarry = 0
  let lastShown = 0
  let wasCollecting = false
  let wasBursar = false
  let pickupEnded = false
  let bursarFired = false
  const lastPaid = new Float32Array(16)
  const payAcc = new Float32Array(16)
  let chainSeq = 0
  let bursarSeq = 0
  // fountains announced this frame, resolved against pallet.incoming at the start of update()
  const pendGold = new Float32Array(8)
  const pendMeshes = new Int32Array(8)
  const pendDuration = new Float32Array(8)
  const pendRope = new Uint8Array(8)
  let nPend = 0
  // ropes: where a fountain leaves the ground. It follows its bather for as long as coins are leaving him.
  const ropeX = new Float32Array(ROPES)
  const ropeZ = new Float32Array(ROPES)
  const ropeWho = new Int32Array(ROPES)
  const ropeUntil = new Float64Array(ROPES)
  let rope = 0
  let ropeT = -1e9
  let ropeCount = 0

  // chest
  let chestPop = Infinity // seconds since the unlock event (Infinity = it has always been there)
  let lid = LID_AJAR
  let lidV = 0
  let chestKick = 0
  const hud = new THREE.Vector3() // world point under the HUD coin icon
  let hudScale = HUD_COIN_SIZE
  let hudBound = false // a coin is on its way to the HUD
  const hudFallback = { x: 0, y: 0 }

  const resync = (s: GameState) => {
    nF = 0
    nPend = 0
    landT.fill(-1e9)
    readPallet(s)
    lastDiscs = Math.min(PALLET_MAX, discsOf(palFirst, palLater))
    lastCarry = Math.ceil(s.player.carriedGold / P.GOLD_PER_COIN_MESH - 1e-6)
    lastShown = Math.min(COLUMN_MAX, lastCarry)
    for (let i = 0; i < s.pads.length && i < lastPaid.length; i++) {
      lastPaid[i] = s.pads[i].paid
      payAcc[i] = 0
    }
    wasCollecting = s.pallet.collecting
    wasBursar = s.pallet.bursarLeft > 0
    leanX = leanZ = leanVx = leanVz = 0
    lagVx = s.player.vx
    lagVz = s.player.vz
    wobble = topKick = 0
  }

  const nearestBather = (s: GameState, x: number, z: number): number => {
    let best = -1
    let bd = 2.5 * 2.5
    for (let i = 0; i < s.villagers.length; i++) {
      const p = s.villagers[i]
      if (p.look !== 'bathed') continue
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z)
      if (d < bd) {
        bd = d
        best = p.id
      }
    }
    return best
  }

  /** Turns the fountains announced this frame into flights whose landing times are those of pallet.incoming. */
  const startFountains = (s: GameState) => {
    const inc = s.pallet.incoming
    let tail = inc.length - 2 // the newest fountain ends the array; each one's last entry lands a whole duration after its start
    for (let p = nPend - 1; p >= 0; p--) {
      const m = pendMeshes[p]
      const start = tail >= 0 ? s.time + inc[tail] - pendDuration[p] : s.time
      tail -= m * 2
      const span = Math.max(0, pendDuration[p] - P.COIN_FLIGHT)
      const emitSpan = Math.min(span, FOUNTAIN_EMIT_SPAN, P.COIN_FLIGHT * 0.9)
      const worth = Math.max(1, Math.round(pendGold[p] / m))
      let left = pendGold[p]
      for (let j = 0; j < m; j++) {
        const k = m > 1 ? j / (m - 1) : 0
        const land = start + span * k + P.COIN_FLIGHT
        const amount = Math.min(worth, left)
        left -= amount
        if (land <= s.time + LAND_EPS) continue
        const o = alloc(FOUNTAIN, 0, FOUNTAIN_SOURCE_Y, 0, emitSpan * k, 0)
        if (o < 0) break
        F[o + LAND] = land
        F[o + START] = start
        F[o + SLOW] = span > 0 ? emitSpan / span : 1
        F[o + GOLD] = amount
        F[o + WHO] = pendRope[p]
        F[o + FLAG] = pendGold[p] > P.BATH_FEE * 1.5 ? 1 : 0
      }
    }
    nPend = 0
    for (let r = 0; r < ROPES; r++) {
      if (s.time >= ropeUntil[r]) continue
      for (let i = 0; i < s.villagers.length; i++) {
        const p = s.villagers[i]
        if (p.id !== ropeWho[r]) continue
        ropeX[r] = p.x
        ropeZ[r] = p.z
        break
      }
    }
  }

  /** The stacks; discs that left since the last frame go to the bursar's chest or, the very last ones, fade as ghosts. */
  const drawPallet = (s: GameState, now: number, sdt: number): number => {
    const discs = Math.min(PALLET_MAX, discsOf(palFirst, palLater))
    for (let i = lastDiscs; i < discs; i++) {
      landT[i] = now
      if ((i & 1) === 0) {
        slotPos(i, v)
        sparkle(v.x + (rnd() - 0.5) * 0.3, v.y + 0.1, v.z + (rnd() - 0.5) * 0.3, 0.34 + rnd() * 0.2, 0.22)
      }
    }
    const toChest = wasBursar || bursarFired || s.pallet.bursarLeft > 0
    const toDoctor = wasCollecting || pickupEnded || s.pallet.collecting
    for (let i = lastDiscs - 1; i >= discs; i--) {
      slotPos(i, v)
      if (toChest) {
        const o = alloc(BURSAR, v.x, v.y, v.z, BURSAR_IN, (sdt * (i - discs)) / (lastDiscs - discs))
        if (o >= 0) F[o + WHO] = (bursarSeq++ / RIBBON_COINS) & 1 ? 1 : -1
      } else if (toDoctor && i < 4) alloc(GHOST, v.x, v.y, v.z, GHOST_LIFE, 0)
    }
    stackTop.fill(pallet.topY)
    for (let i = 0; i < discs; i++) {
      const slot = PALLET_SLOTS[i & 3]
      const x = L.PALLET.x + slot.x
      const z = L.PALLET.z + slot.z
      const y0 = stackTop[i & 3]
      const a = now - landT[i]
      let sy = 1
      let sxz = 1
      if (a < FRESH_GHOST + FRESH_SQUASH) {
        // lands squashed, springs past its height once and settles
        const k = clamp01((a - FRESH_GHOST) / FRESH_SQUASH)
        const spring = (1 - k) * (1 - k) * Math.cos(k * 7)
        sy = 1 - 0.42 * spring
        sxz = 1 + 0.16 * spring
      }
      stackTop[i & 3] = y0 + COIN_H * sy
      // the first coins on the bare planks fade in (ad 14.83 s)
      if (a < FRESH_GHOST && i < 4) ghost(x, y0 + COIN_H * 0.5, z, 1.06, FOUNTAIN_GLOW)
      else flat(x, y0 + COIN_H * sy * 0.5, z, 0, sxz, sy, a < FRESH_GLOW ? FOUNTAIN_GLOW * (1 - a / FRESH_GLOW) : 0)
    }
    return discs
  }

  /** Where the column stands and how it leans. */
  const poseColumn = (s: GameState, sdt: number) => {
    const pl = s.player
    // steps aside (or back to the middle) when the flask stack comes or goes
    side = sdt > 0 ? side + (stackSides(s).coin - side) * damp(14, sdt) : stackSides(s).coin
    offsetRight(ctx.anchors.playerBack, ctx.anchors.playerHeading, side, base)
    heading = ctx.anchors.playerHeading
    if (sdt > 0) {
      // the top lags behind every change of velocity; an under-damped spring turns that into a short wobble
      const k = damp(1 / LEAN_LAG, sdt)
      lagVx += (pl.vx - lagVx) * k
      lagVz += (pl.vz - lagVz) * k
      const h = Math.min(sdt, 1 / 30)
      for (let t = sdt; t > 1e-6; t -= h) {
        const step = Math.min(h, t)
        leanVx += (LEAN_OMEGA * LEAN_OMEGA * ((lagVx - pl.vx) * LEAN_GAIN - leanX) - 2 * LEAN_ZETA * LEAN_OMEGA * leanVx) * step
        leanVz += (LEAN_OMEGA * LEAN_OMEGA * ((lagVz - pl.vz) * LEAN_GAIN - leanZ) - 2 * LEAN_ZETA * LEAN_OMEGA * leanVz) * step
        leanX += leanVx * step
        leanZ += leanVz * step
      }
      wobble = Math.min(WOBBLE_MAX, wobble * Math.exp(-sdt / WOBBLE_DECAY) + Math.hypot(leanVx, leanVz) * 0.012 * sdt)
      wobblePhase += sdt * 13
      topKick *= Math.exp(-sdt / 0.07)
    }
    // soft limit: nearly the spring's own angle while that is small, never more than LEAN_MAX
    const raw = Math.hypot(leanX, leanZ)
    const lean = raw / Math.sqrt(Math.sqrt(1 + (raw / LEAN_MAX) ** 4))
    const sn = raw > 1e-6 ? Math.sin(lean) / raw : 0
    ax = leanX * sn
    az = leanZ * sn
    ay = Math.cos(lean)
    // tilt columns c0 = (1 - k ax^2, -ax, -k ax az) and c2 = (-k ax az, -az, 1 - k az^2); the yaw mixes them
    const k = 1 / (1 + ay)
    const ch = Math.cos(heading)
    const sh = Math.sin(heading)
    const c0x = 1 - k * ax * ax
    const c0z = -k * ax * az
    const c2z = 1 - k * az * az
    R[0] = ch * c0x - sh * c0z
    R[1] = -ch * ax + sh * az
    R[2] = ch * c0z - sh * c2z
    R[3] = ax
    R[4] = ay
    R[5] = az
    R[6] = sh * c0x + ch * c0z
    R[7] = -sh * ax - ch * az
    R[8] = sh * c0z + ch * c2z
  }

  /** Launches the coins that carry what changed since the last frame: gold onto the column, gold into a pad. */
  const launch = (s: GameState, sdt: number, discs: number) => {
    const pl = s.player
    const carry = Math.ceil(pl.carriedGold / P.GOLD_PER_COIN_MESH - 1e-6)
    if (carry > lastCarry && (wasCollecting || pickupEnded || s.pallet.collecting)) {
      // one chain coin per disc the column gains, leaving from the tops of the stacks in turn
      const add = Math.min(carry - lastCarry, 16)
      columnPos(Math.min(COLUMN_MAX - 1, carry), v)
      const fromY = pallet.topY + Math.max(1, (discs + 3) >> 2) * COIN_H + 0.05
      const flight = clamp(archLength(L.PALLET.x, fromY, L.PALLET.z, v.x, v.y, v.z, chainTop(fromY, v.y), 9) / CHAIN_SPEED, CHAIN_FLIGHT, CHAIN_FLIGHT_MAX)
      for (let k = 0; k < add; k++) {
        const slot = chainSeq++ & 3
        const layers = Math.max(1, (Math.max(discs, 1) + 3 - slot) >> 2)
        alloc(CHAIN, L.PALLET.x + PALLET_SLOTS[slot].x * 0.3, pallet.topY + layers * COIN_H + 0.05, L.PALLET.z + PALLET_SLOTS[slot].z * 0.3, flight, (sdt * (add - 1 - k)) / add)
      }
    }
    // a disc of the column appears when its chain coin arrives
    shown = Math.max(0, Math.min(COLUMN_MAX, carry - count(CHAIN)))

    for (let p = 0; p < s.pads.length && p < lastPaid.length; p++) {
      const pad = s.pads[p]
      const paid = pad.paid - lastPaid[p]
      lastPaid[p] = pad.paid
      if (paid <= 0) {
        if (pad.state !== 'paying') payAcc[p] = 0
        continue
      }
      // the column gives a coin for every disc it loses; what the column cannot cover comes from the belt
      payAcc[p] += paid
      const worth = Math.max(P.GOLD_PER_COIN_MESH, pad.price / PAY_COINS)
      let coinsOut = Math.floor(payAcc[p] / worth + 1e-6)
      payAcc[p] -= coinsOut * worth
      coinsOut = Math.max(coinsOut, Math.min(lastShown - shown, 8))
      // a coin has to land before its pad is gone
      const left = pad.state === 'paying' ? padPayDuration(pad.price) - pad.t + P.PAD_DONE_DELAY : pad.state === 'done' ? P.PAD_DONE_DELAY - pad.t : 0
      const flight = clamp(left, PAY_FLIGHT_MIN, PAY_FLIGHT)
      for (let k = 0; k < coinsOut; k++) {
        const from = lastShown - 1 - k
        if (from >= 0) columnPos(from, v)
        else v.set(pl.x + Math.sin(heading) * 0.2, BELT_Y, pl.z + Math.cos(heading) * 0.2)
        const o = alloc(PAY, v.x, v.y, v.z, from >= 0 ? flight : flight * 0.8, (sdt * (coinsOut - 1 - k)) / coinsOut)
        if (o >= 0) F[o + WHO] = p
      }
    }
    lastDiscs = discs
    lastCarry = carry
    wasCollecting = s.pallet.collecting
    wasBursar = s.pallet.bursarLeft > 0
    pickupEnded = false
    bursarFired = false
  }

  /** Ages the flights and retires those that have arrived. */
  const retire = (s: GameState, now: number, sdt: number) => {
    let landed = 0
    hudBound = false
    for (let i = nF - 1; i >= 0; i--) {
      const o = i * STRIDE
      const kind = F[o + KIND]
      if (kind === FOUNTAIN) {
        if (F[o + LAND] <= now + LAND_EPS) free(i)
        continue
      }
      const age = (F[o + AGE] += sdt)
      const dur = F[o + DUR]
      if (kind === CHAIN) {
        if (age < dur) continue
        landed++
        free(i)
      } else if (kind === PAY) {
        const pad = s.pads[F[o + WHO]]
        // the little stack does not outlive its pad
        if (age >= dur && age < dur + PAY_LINGER && pad.state === 'gone') F[o + AGE] = dur + PAY_LINGER
        if (age >= dur + PAY_LINGER + PAY_SINK) free(i)
        else if (age >= dur && F[o + FLAG] === 0) {
          F[o + FLAG] = 1
          if (F[o + ORD] % 4 === 0) sparkle(pad.x + (rnd() - 0.5) * 0.4, PAD_Y + 0.25, pad.z + (rnd() - 0.5) * 0.4, 0.3, 0.18)
        }
      } else if (kind === BURSAR) {
        if (age >= BURSAR_IN + BURSAR_HOLD + BURSAR_OUT) free(i)
        else if (age >= BURSAR_IN) {
          hudBound = true
          if (F[o + FLAG] === 0) {
            F[o + FLAG] = 1
            chestKick = 1
            if (F[o + ORD] % 4 === 0) sparkle(L.BURSAR_CHEST.x, CHEST_MOUTH_Y + 0.2, L.BURSAR_CHEST.z, 0.36, 0.2)
          }
        }
      } else if (age >= dur) free(i)
    }
    if (landed > 0) {
      topKick = 1
      wobble = Math.min(WOBBLE_MAX, wobble + 0.009 * landed)
      shown = Math.min(COLUMN_MAX, shown + landed)
    }
    lastShown = shown
  }

  /** World point that the camera sees under the HUD coin icon, and the scale that makes a coin there icon-sized. */
  const aimAtHud = () => {
    const t = ctx.hud ? ctx.hud.coinTarget() : hudFallback
    if (!ctx.hud) {
      // no HUD: where its coin icon would be (SPEC 8.1, reference frame 608 px wide)
      hudFallback.x = (ctx.frame.clientWidth * 511) / 608
      hudFallback.y = (ctx.frame.clientWidth * 20) / 608
    }
    ctx.fromScreen(t.x, t.y, HUD_PLANE_Y, hud)
    const cam = ctx.camera
    fwd.set(0, 0, -1).applyQuaternion(cam.quaternion)
    const depth = (hud.x - cam.position.x) * fwd.x + (hud.y - cam.position.y) * fwd.y + (hud.z - cam.position.z) * fwd.z
    hudScale = fwd.y < -0.05 ? (HUD_COIN_SIZE * depth * -fwd.y) / cam.position.y : HUD_COIN_SIZE
  }

  const drawFountain = (o: number, now: number) => {
    // The rope runs at one speed for all its coins: a full path length per COIN_FLIGHT until its head lands, then
    // slower, so that every coin arrives exactly when the sim lands it.
    const since = now - F[o + START]
    const delay = F[o + DUR]
    if (since < delay) return
    const run = since <= P.COIN_FLIGHT ? since : P.COIN_FLIGHT + (since - P.COIN_FLIGHT) * F[o + SLOW]
    const u = Math.min(1, (run - delay) / P.COIN_FLIGHT)
    // the disc it becomes: everything that lands before it lies below
    let first = palFirst
    let later = palLater
    for (let j = 0; j < nF * STRIDE; j += STRIDE) {
      if (F[j + KIND] !== FOUNTAIN || F[j + LAND] > F[o + LAND] || (F[j + LAND] === F[o + LAND] && j > o)) continue
      if (F[j + FLAG]) first += F[j + GOLD]
      else later += F[j + GOLD]
    }
    slotPos(Math.min(PALLET_MAX, discsOf(first, later)) - 1, v)
    // up from the bather, over, and down on the middle of the pallet; only at the very end does a coin step
    // sideways onto its own stack
    const spread = smoothstep(0.8, 1, u)
    const ex = L.PALLET.x + (v.x - L.PALLET.x) * spread
    const ez = L.PALLET.z + (v.z - L.PALLET.z) * spread
    const sx = ropeX[F[o + WHO]]
    const sz = ropeZ[F[o + WHO]]
    const dx = ex - sx
    const dz = ez - sz
    const span = Math.hypot(dx, dz) || 1
    arch(u, sx, F[o + Y], sz, ex, v.y, ez, FOUNTAIN_APEX, clamp(span / 2, 0.3, 1), q)
    // wobble: two waves that run along the coins, dying out where they leave and where they land
    const env = smoothstep(0, 0.12, u) * (1 - smoothstep(0.8, 1, u))
    const phase = (F[o + START] + delay) * 30 - now * 9
    const w1 = (0.12 * env * Math.sin(phase)) / span
    const w2 = (0.09 * env * Math.sin(phase * 0.63 + 1.9)) / span
    // tumbles all the way and comes to lie flat just before it lands
    const seed = F[o + SEED]
    const settle = 1 - smoothstep(0.86, 1, u)
    const spin = (since - delay) * 11
    tumbling(
      q.x - dz * w1 + dx * w2,
      q.y,
      q.z + dx * w1 + dz * w2,
      (seed * 5 + spin * (0.6 + hash(seed, 2))) * settle,
      seed * TAU,
      (hash(seed, 3) * 4 + spin * (0.4 + hash(seed, 4) * 0.8)) * settle,
      0.45 + 0.55 * smoothstep(0, 0.06, u),
      FOUNTAIN_GLOW,
    )
  }

  const drawChain = (o: number) => {
    const age = F[o + AGE]
    const u = Math.max(0, age / F[o + DUR])
    // it lands on the disc that tops the column when it arrives: the coins that land before it lie below
    const left = F[o + DUR] - age
    let rank = 0
    for (let j = 0; j < nF * STRIDE; j += STRIDE) {
      if (F[j + KIND] !== CHAIN) continue
      const lj = F[j + DUR] - F[j + AGE]
      if (lj < left || (lj === left && j < o)) rank++
    }
    columnPos(Math.min(COLUMN_MAX - 1, shown + rank), v)
    // the coins stay flat, with a slight roll in mid-air
    arch(u, F[o + X], F[o + Y], F[o + Z], v.x, v.y, v.z, chainTop(F[o + Y], v.y), 9, q)
    const tilt = Math.sin(u * Math.PI) * 0.22
    const a = F[o + SEED] * TAU
    tumbling(q.x, q.y, q.z, Math.sin(a) * tilt, heading, Math.cos(a) * tilt, 0.7 + 0.3 * smoothstep(0, 0.12, u), 0)
  }

  const drawPay = (o: number, s: GameState) => {
    const pad = s.pads[F[o + WHO]]
    const flight = F[o + DUR]
    const landedFor = F[o + AGE] - flight
    const yaw = F[o + SEED] * TAU
    // height of the little stack under this coin: the coins that landed before it and have not sunk yet
    let below = 0
    for (let j = 0; j < nF * STRIDE; j += STRIDE) {
      if (j === o || F[j + KIND] !== PAY || F[j + WHO] !== F[o + WHO]) continue
      const lj = F[j + AGE] - F[j + DUR]
      if (lj > landedFor || (lj === landedFor && j < o)) below += 1 - clamp01((lj - PAY_LINGER) / PAY_SINK)
    }
    const restY = PAD_Y + below * COIN_H
    if (landedFor >= 0) {
      // lies on the pad for a moment, then sinks away under the ones above it
      const sy = 1 - clamp01((landedFor - PAY_LINGER) / PAY_SINK)
      const hit = Math.max(0, 1 - landedFor / 0.08)
      flat(pad.x, restY + COIN_H * 0.5 * sy, pad.z, yaw, (1 + 0.2 * hit) * (0.6 + 0.4 * sy), sy * (1 - 0.35 * hit), 0)
      return
    }
    // A parabola (quadratic Bezier) that leaves toward a point high above the pad and comes down on it vertically:
    // over a tall column it is a hook and a long drop (ad 20.0 s), from a short one a high arc (ad 27.9 s, 35.5 s).
    const dx = pad.x - F[o + X]
    const dz = pad.z - F[o + Z]
    const drop = Math.max(0, F[o + Y] - restY - COIN_H * 0.5)
    const lift = Math.max(PAY_LIFT_MIN, PAY_LIFT - PAY_LIFT_PER_DROP * drop) + 0.3 * F[o + SEED]
    // even pace along it: the speed along the curve changes about linearly, from v0 where it leaves to v1 where it lands
    const f = Math.max(0, F[o + AGE] / flight)
    const v0 = Math.hypot(dx, dz, lift)
    const v1 = lift + drop
    const u = Math.abs(v1 - v0) < 1e-3 ? f : (Math.sqrt(v0 * v0 + f * (v1 * v1 - v0 * v0)) - v0) / (v1 - v0)
    const go = u * (2 - u)
    const tilt = Math.sin(f * Math.PI) * 0.35
    tumbling(F[o + X] + dx * go, F[o + Y] + 2 * u * (1 - u) * lift - u * u * drop, F[o + Z] + dz * go, Math.sin(yaw) * tilt, yaw, Math.cos(yaw) * tilt, 1, 0)
  }

  const drawBursar = (o: number) => {
    const cx = L.BURSAR_CHEST.x
    const cz = L.BURSAR_CHEST.z
    const age = F[o + AGE]
    const seed = F[o + SEED]
    if (age < BURSAR_IN) {
      // hops from its stack into the chest
      const u = Math.max(0, age / BURSAR_IN)
      const rise = 0.9 + seed * 0.5
      const settle = 1 - smoothstep(0.7, 1, u)
      tumbling(
        F[o + X] + (cx - F[o + X]) * u,
        F[o + Y] + (CHEST_MOUTH_Y - F[o + Y]) * u + rise * 4 * u * (1 - u),
        F[o + Z] + (cz - F[o + Z]) * u,
        (seed * 6 + u * 7) * settle,
        seed * TAU,
        u * 5 * settle,
        1 - 0.45 * smoothstep(0.75, 1, u),
        0,
      )
      return
    }
    const u = (age - BURSAR_IN - BURSAR_HOLD) / BURSAR_OUT
    if (u < 0) return
    // ribbon to the HUD icon: the coins leave nose to tail along one bent curve and gather speed (ad 26.0 s);
    // they face the camera and only shrink to the size of the icon at the very end
    const e = u * u * (0.65 + 0.35 * (3 - 2 * u))
    const side = F[o + WHO] * 3.5
    const mx = cx + (hud.x - cx) * 0.35 + SCREEN_RIGHT.x * side
    const my = CHEST_MOUTH_Y + (hud.y - CHEST_MOUTH_Y) * 0.75
    const mz = cz + (hud.z - cz) * 0.35 + SCREEN_RIGHT.z * side
    const a = (1 - e) * (1 - e)
    const b = 2 * e * (1 - e)
    const c = e * e
    tumbling(
      a * cx + b * mx + c * hud.x,
      a * CHEST_MOUTH_Y + b * my + c * hud.y,
      a * cz + b * mz + c * hud.z,
      0.45 + 0.3 * Math.sin(seed * TAU + u * 7),
      seed * TAU,
      0.4 + 0.3 * Math.cos(seed * 9 + u * 6),
      (0.55 + 0.45 * smoothstep(0, 0.1, u)) * (1 + (hudScale - 1) * smoothstep(0.55, 1, e)),
      0,
    )
  }

  const drawFlights = (s: GameState, now: number) => {
    for (let o = 0; o < nF * STRIDE; o += STRIDE) {
      const kind = F[o + KIND]
      if (kind === FOUNTAIN) drawFountain(o, now)
      else if (kind === CHAIN) drawChain(o)
      else if (kind === PAY) drawPay(o, s)
      else if (kind === BURSAR) drawBursar(o)
      else {
        // the last coins of a pickup fade where they lay (ad 18.6 s)
        const u = F[o + AGE] / F[o + DUR]
        ghost(F[o + X], F[o + Y] + 0.25 * u * u, F[o + Z], 1 + 0.25 * u, FOUNTAIN_GLOW * (1 - u))
      }
    }
  }

  const drawColumn = () => {
    for (let k = 0; k < shown; k++) {
      columnPos(k, v)
      // the top disc gives a little under the coin that has just landed on it
      const kick = k === shown - 1 ? topKick : 0
      const sxz = 1 + 0.14 * kick
      const sy = 1 - 0.3 * kick
      const o = n * 16
      M[o] = R[0] * sxz
      M[o + 1] = R[1] * sxz
      M[o + 2] = R[2] * sxz
      M[o + 3] = 0
      M[o + 4] = R[3] * sy
      M[o + 5] = R[4] * sy
      M[o + 6] = R[5] * sy
      M[o + 7] = 0
      M[o + 8] = R[6] * sxz
      M[o + 9] = R[7] * sxz
      M[o + 10] = R[8] * sxz
      M[o + 11] = 0
      M[o + 12] = v.x
      M[o + 13] = v.y - COIN_H * 0.15 * kick
      M[o + 14] = v.z
      M[o + 15] = 1
      coins.glow(n++, 0)
    }
  }

  const updateChest = (s: GameState, dt: number) => {
    // it pops in a moment into the unlock burst that stationsView draws on its footprint
    if (s.unlocks.bursar && chestPop < CHEST_POP_DELAY + CHEST_POP_TIME) chestPop += dt
    else chestPop = Infinity
    const pop = chestPop === Infinity ? 1 : chestPop < CHEST_POP_DELAY ? 0 : easeOutBack((chestPop - CHEST_POP_DELAY) / CHEST_POP_TIME)
    chest.root.visible = s.unlocks.bursar && pop > 0
    if (!chest.root.visible) return
    // the lid swings open (with a little bounce) for as long as coins come and go
    const busy = s.pallet.bursarLeft > 0 || count(BURSAR) > 0
    const h = Math.min(dt, 1 / 30)
    lidV += (380 * ((busy ? LID_OPEN : LID_AJAR) - lid) - 20 * lidV) * h
    lid += lidV * h
    chest.setOpen(lid)
    chestKick *= Math.exp(-dt / 0.09)
    // pops in taller than wide, and squashes a little under every coin that drops in
    const wide = pop * (1 + 0.04 * chestKick)
    chest.root.scale.set(wide, pop * (1 + (pop - 1) * 0.6) * (1 - 0.07 * chestKick), wide)
  }

  return {
    onEvent(e: GameEvent, s: GameState) {
      switch (e.type) {
        case 'coinFountain':
          if (nPend >= pendRope.length) break
          if (!(s.time - ropeT < ROPE_JOIN) || ropeCount >= 2) {
            rope = (rope + 1) % ROPES
            ropeT = s.time
            ropeX[rope] = e.x
            ropeZ[rope] = e.z
            ropeWho[rope] = nearestBather(s, e.x, e.z)
            ropeCount = 0
          }
          ropeCount++
          ropeUntil[rope] = s.time + FOUNTAIN_EMIT_SPAN
          pendGold[nPend] = e.gold
          pendMeshes[nPend] = e.meshes
          pendDuration[nPend] = e.duration
          pendRope[nPend] = rope
          nPend++
          break
        case 'coinPickupEnd':
          pickupEnded = true
          break
        case 'bursarCollect':
          bursarFired = true
          bursarSeq = 0
          break
        case 'unlock':
          if (e.id === 'bursar') chestPop = 0
          break
      }
    },

    update(s: GameState, dt: number) {
      // coins move on the sim clock, so that they stay in step with the numbers at any game speed
      const now = s.time
      let sdt = now - lastNow
      lastNow = now
      if (!(sdt >= 0 && sdt <= MAX_STEP)) {
        sdt = 0
        resync(s)
      }
      n = 0
      g = 0
      startFountains(s)
      readPallet(s)
      const discs = drawPallet(s, now, sdt)
      poseColumn(s, sdt)
      launch(s, sdt, discs)
      retire(s, now, sdt)
      if (hudBound) aimAtHud()
      drawFlights(s, now)
      drawColumn()
      coins.commit(n)
      ghosts.commit(g)
      updateChest(s, dt)
    },
  }
}
