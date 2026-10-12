// River package binding (SPEC 2.2-2.5, 9): the small balls, the big bubbles (drift, dock, grinder timeline, the fall
// over the cliff), the grinder with its shards and sparks, the hand scoop and the cart, and every flask: the pile west
// of the grinder, the pickup streaks, the stacks on the doctor's and the porter's back and the throws into the pot.
//
// Everything that persists is rebuilt from the GameState on every update(). Events only start one-shot motion
// (wobbles, pops, streaks, the fall of a bubble that has already left the state) and particles, so a skipped stretch
// of simulation leaves nothing behind and nothing missing.
import * as THREE from 'three'
import { L, P, PAL, type ToolKind } from '../config'
import { angleDelta, clamp, clamp01, damp, dist2, easeOutBack, easeOutCubic, lerp, smoothstep } from '../core/math'
import type { GameEvent } from '../sim/events'
import { GROUND_FLASK_MAX } from '../sim/grinder'
import { BALL_FALL, type Bubble, type GameState, type Tool } from '../sim/types'
import { inRiverBed } from '../world/river'
import { BLADES } from '../world/tools'
import { offsetRight, stackSides } from './anchors'
import type { Fx, FxOpts, FxTex } from './fx'
import { FLASK_CHAIN_TILT, FLASK_RADIUS, commitFlasks, createFlaskMesh, createFlaskShadowMesh, flaskChainLean, setFlask, setFlaskFlight, setFlaskLying, setFlaskPale, setFlaskShadow } from './models/flask'
import { GRINDER_DISC_TOP, GRINDER_ROW_X, makeGrinder } from './models/grinder'
import { CAPTURE_BURST_TIME, SHARDS_MAX, createBallMesh, createShardMesh, makeBubble, poseCaptureBurst, poseShards, setBallPositions, type BubbleModel } from './models/river'
import { SCOOP_GRIP, makeCart, makeScoop, type CartModel, type ScoopModel } from './models/tools'
import type { ViewCtx, ViewModule } from './types'

const [GX0, GZ0, GX1, GZ1] = L.GRINDER
const GCX = (GX0 + GX1) / 2
const GCZ = (GZ0 + GZ1) / 2

const rnd = Math.random
const rs = () => Math.random() * 2 - 1

// --- particles -------------------------------------------------------------------------------------------------------

const FXO: FxOpts = { x: 0, y: 0, z: 0, life: 0, size: 0, color: 0 }
/** The shared scratch particle with every optional field back at its default; set what differs, then fx.spawn(it). */
function part(tex: FxTex, x: number, y: number, z: number, life: number, size: number, color: number): FxOpts {
  const o = FXO
  o.tex = tex
  o.x = x
  o.y = y
  o.z = z
  o.life = life
  o.size = o.size1 = size
  o.color = o.color1 = color
  o.vx = o.vy = o.vz = 0
  o.alpha = 1
  o.fadeIn = 0.08
  o.fadeOut = 0.6
  o.gravity = o.drag = 0
  o.additive = false
  o.rot = o.spin = 0
  o.flat = false
  o.stretch = 1
  o.delay = 0
  o.floor = false
  return o
}

// --- bubbles ---------------------------------------------------------------------------------------------------------

/** Balls looked at per second for spray at the cliff lip (96 a frame at 60 fps). */
const SPRAY_SAMPLES = 5760
/** Visual-only balls added to the capture burst on top of the real ones the simulation throws. */
const BURST_BALLS = 10
/** Seconds a new bubble takes to swell and fade in at the source (the simulation grows its footprint over the same time). */
const BUBBLE_GROW = 0.4
/** The smear of a bubble snapping into the blade (SPEC 9 row 2): a faint, swelling afterimage round the solid bubble. */
const SMEAR_TIME = 0.16
const SMEAR_OPACITY = 0.42
const SMEAR_SWELL = 0.14
const FALL_GRAVITY = 20
/**
 * A fallen bubble is drawn this long: it lands on the lowland and at once sinks between the rocks and fades (in the ad
 * it has dropped out of sight 0.4 s after tipping over the lip, 3.2-3.6 s).
 */
const FALL_FADE_START = 0.45
const FALL_TIME = 1.1

interface BubbleSlot {
  model: BubbleModel
  /** Bubble id, -1 = free. */
  id: number
  seen: boolean
  x: number
  z: number
  r: number
  vx: number
  vz: number
  roll: number
  /** In a blade on the previous frame. */
  held: boolean
  /** Seconds since it docked / since an oversize hit (drive the wobbles). */
  dockT: number
  hitT: number
  /** >= 0 while it is going over the cliff (the simulation has already dropped it). */
  fallT: number
}

/** Decaying vertical wobble of a bubble t seconds after an impact, as a height factor (1 = round): squash first, then a rebound. */
const wobble = (t: number, amp: number) => (t < 0.7 ? 1 - amp * Math.exp(-8 * t) * Math.sin(28 * t) : 1)

/** How far a bubble centred on (x, z) has ridden up onto the grinder: 0 on the dirt, the disc tops once it is on the tray. */
function trayLift(x: number, z: number, r: number): number {
  const inside = Math.min(x - GX0, GX1 - x, z - GZ0, GZ1 - z)
  return GRINDER_DISC_TOP * smoothstep(-0.55 * r, 0.45, inside)
}

// --- grinder ---------------------------------------------------------------------------------------------------------

/** Seconds after the shatter between which the heap of shards falls apart along the shafts (ad, 6.2-6.6 s). */
const SLUMP_START = 0.08
const SLUMP_END = 0.5
/** The shards keep this far inside the tray rim. */
const SLUMP_MARGIN = 0.4
const SLUMP_FLATTEN = 0.4

/**
 * poseShards() lets the shards sink where the bubble stood. In the ad the heap falls apart along the two shafts, from
 * one end of the tray to the other, and the plates lie flat on the discs while they are eaten: this moves and flattens
 * the instances it has just posed. t = seconds since the shatter; returns how far the slump has got (0..1).
 */
function slumpShards(mesh: THREE.InstancedMesh, bz: number, br: number, t: number): number {
  const k = smoothstep(SLUMP_START, SLUMP_END, t)
  if (k <= 0) return 0
  const a = mesh.instanceMatrix.array as Float32Array
  const north = bz - (GZ0 + SLUMP_MARGIN)
  const south = GZ1 - SLUMP_MARGIN - bz
  const flat = 1 - SLUMP_FLATTEN * k
  for (let i = 0, o = 0; i < mesh.count; i++, o += 16) {
    // its place in the ball, north to south, becomes its place along the shafts
    const u = clamp((a[o + 14]! - bz) / (0.5 * br), -1, 1)
    a[o + 14] = lerp(a[o + 14]!, bz + u * (u < 0 ? north : south), k)
    a[o + 12] = lerp(a[o + 12]!, clamp(a[o + 12]!, GX0 + SLUMP_MARGIN, GX1 - SLUMP_MARGIN), k)
    // squash along world y (the y row of the rotation part)
    a[o + 1] = a[o + 1]! * flat
    a[o + 5] = a[o + 5]! * flat
    a[o + 9] = a[o + 9]! * flat
  }
  return k
}

// --- tools -----------------------------------------------------------------------------------------------------------

/** Golden unlock glow of a tool that has just appeared (SPEC 9 row 19), driven by Tool.age. */
const GLOW_PEAK = 0.1
const GLOW_FADE = 0.28
const GLOW_END = 0.5
const GLOW_HEIGHT = 2.7
/**
 * The block of gold the tool stands in while the curtain is up: in the ad the new cart is half hidden in it for seven
 * frames (36.3-36.5 s: half of the box is bright gold) and it has thinned to the outline three frames later.
 */
const BLOCK_HOLD = 0.22
const BLOCK_END = 0.34
const BLOCK_OPACITY = 0.9
const POP_TIME = 0.14
/** Rate (1/s) at which a tool swings from where it was to where the simulation has just put it. */
const TOOL_SWING = 20

interface Glow {
  root: THREE.Group
  block: THREE.Mesh
  blockMat: THREE.MeshBasicMaterial
  walls: THREE.Mesh
  wallMat: THREE.MeshBasicMaterial
  fillMat: THREE.MeshBasicMaterial
  lineMat: THREE.MeshBasicMaterial
  hw: number
  hd: number
  cz: number
}

/** Footprint of a tool in its own frame: half width, half depth, the z of the centre and the height that clears it. */
const FOOTPRINT: Record<ToolKind, readonly [number, number, number, number]> = {
  scoop: [P.SCOOP_CHORD / 2 + 0.45, 1.45, 1.0, 1.5],
  cart: [P.CART_CHORD / 2 + 0.35, 3.0, 2.25, 1.9],
}

/** Closed outline [x, z, ...] of a rounded rectangle. */
function roundedRect(hw: number, hd: number, rad: number, seg: number): number[] {
  const out: number[] = []
  const cx = [hw - rad, -(hw - rad), -(hw - rad), hw - rad]
  const cz = [hd - rad, hd - rad, -(hd - rad), -(hd - rad)]
  for (let c = 0; c < 4; c++)
    for (let k = 0; k <= seg; k++) {
      const a = ((c + k / seg) * Math.PI) / 2
      out.push(cx[c]! + Math.cos(a) * rad, cz[c]! + Math.sin(a) * rad)
    }
  return out
}

/** The same closed outline with points added so that no side is longer than `step`. */
function densify(o: number[], step: number): number[] {
  const out: number[] = []
  const n = o.length / 2
  for (let j = 0; j < n; j++) {
    const ax = o[j * 2]!
    const az = o[j * 2 + 1]!
    const bx = o[((j + 1) % n) * 2]!
    const bz = o[((j + 1) % n) * 2 + 1]!
    const parts = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step))
    for (let k = 0; k < parts; k++) out.push(lerp(ax, bx, k / parts), lerp(az, bz, k / parts))
  }
  return out
}

function makeGlow(kind: ToolKind): Glow {
  const [hw, hd, cz, top] = FOOTPRINT[kind]
  const rim = roundedRect(hw, hd, 0.35, 5)
  const inner = roundedRect(hw - 0.09, hd - 0.09, 0.3, 5)
  const n = rim.length / 2

  // block: the footprint filled with gold up over the tool, dense at the foot and thin along its top edge. Only the
  // faces turned to the camera are drawn, so every view ray crosses it once and the tool inside is veiled evenly.
  // The ad's burst is yellow gold with a near-white foot, not fire orange (36.2 s: #fbef83 at the foot, #d1aa4f above).
  const foot = new THREE.Color(PAL.gold)
  const haze = new THREE.Color(0xd1aa4f)
  const bp: number[] = [0, top, 0]
  const bc: number[] = [haze.r, haze.g, haze.b, 0.75]
  const bi: number[] = []
  for (let j = 0; j < n; j++) {
    bp.push(rim[j * 2]!, 0, rim[j * 2 + 1]!, rim[j * 2]!, top, rim[j * 2 + 1]!)
    bc.push(foot.r, foot.g, foot.b, 1, haze.r, haze.g, haze.b, 0.4)
    const a = 1 + j * 2
    const b = 1 + ((j + 1) % n) * 2
    bi.push(a, a + 1, b, b, a + 1, b + 1, 0, b + 1, a + 1)
  }
  const blockGeo = new THREE.BufferGeometry()
  blockGeo.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3))
  blockGeo.setAttribute('color', new THREE.Float32BufferAttribute(bc, 4))
  blockGeo.setIndex(bi)
  const blockMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false })
  const block = new THREE.Mesh(blockGeo, blockMat)

  const core = new THREE.Color(PAL.goldCore).multiplyScalar(1.2)
  const body = new THREE.Color(PAL.goldCore).multiplyScalar(0.7)
  const fringe = new THREE.Color(PAL.gold).multiplyScalar(0.24)
  const dark = new THREE.Color(0)

  // curtain: three nested walls fading upward, so that the box reads as a volume of light from the game camera. Every
  // column ends at its own height and some shoot up as rays, which gives the ragged, flickering top edge of the ad.
  const wp: number[] = []
  const wc: number[] = []
  const wi: number[] = []
  const tone = [core, body, fringe, dark]
  const cols = densify(rim, 0.2)
  const m = cols.length / 2
  for (const shrink of [1, 0.72, 0.42]) {
    const base = wp.length / 3
    const dim = shrink === 1 ? 1 : 0.5
    for (let j = 0; j < m; j++) {
      const top = rnd() < 0.2 ? 0.95 + 0.4 * rnd() : 0.3 + 0.45 * rnd()
      for (let k = 0; k < 4; k++) {
        wp.push(cols[j * 2]! * shrink, k === 0 ? 0 : k === 1 ? 0.12 : k === 2 ? 0.55 * top : top, cols[j * 2 + 1]! * shrink)
        wc.push(tone[k]!.r * dim, tone[k]!.g * dim, tone[k]!.b * dim)
      }
    }
    for (let j = 0; j < m; j++) {
      const a = base + j * 4
      const b = base + ((j + 1) % m) * 4
      for (let k = 0; k < 3; k++) wi.push(a + k, b + k, a + k + 1, b + k, b + k + 1, a + k + 1)
    }
  }
  const wallGeo = new THREE.BufferGeometry()
  wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3))
  wallGeo.setAttribute('color', new THREE.Float32BufferAttribute(wc, 3))
  wallGeo.setIndex(wi)
  const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }
  const wallMat = new THREE.MeshBasicMaterial({ vertexColors: true, ...additive })
  const walls = new THREE.Mesh(wallGeo, wallMat)

  // floor of light inside the outline
  const fp: number[] = [0, 0, 0]
  const fi: number[] = []
  for (let j = 0; j < n; j++) {
    fp.push(rim[j * 2]!, 0, rim[j * 2 + 1]!)
    fi.push(0, 1 + ((j + 1) % n), 1 + j)
  }
  const fillGeo = new THREE.BufferGeometry()
  fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3))
  fillGeo.setIndex(fi)
  const fillMat = new THREE.MeshBasicMaterial({ color: PAL.gold, ...additive })
  const fill = new THREE.Mesh(fillGeo, fillMat)
  fill.position.y = 0.03

  // the yellow outline that lingers a few frames after the curtain
  const lp: number[] = []
  const li: number[] = []
  for (let j = 0; j < n; j++) {
    lp.push(rim[j * 2]!, 0, rim[j * 2 + 1]!, inner[j * 2]!, 0, inner[j * 2 + 1]!)
    const a = j * 2
    const b = ((j + 1) % n) * 2
    li.push(a, b, a + 1, b, b + 1, a + 1)
  }
  const lineGeo = new THREE.BufferGeometry()
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3))
  lineGeo.setIndex(li)
  const lineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PAL.goldCore).lerp(new THREE.Color(0xffffff), 0.3), transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false })
  const line = new THREE.Mesh(lineGeo, lineMat)
  line.position.y = 0.035

  const root = new THREE.Group()
  root.name = 'toolGlow'
  const box = new THREE.Group()
  box.position.z = cz
  box.add(block, walls, fill, line)
  root.add(box)
  for (const m of [block, walls, fill, line]) m.frustumCulled = false
  return { root, block, blockMat, walls, wallMat, fillMat, lineMat, hw, hd, cz }
}

interface ToolView {
  scoop: ScoopModel | null
  cart: CartModel | null
  glow: Glow | null
  glowKind: ToolKind
  /** Kind of the model on show, null while the tool does not exist. */
  kind: ToolKind | null
  /** Pose and flags of the previous frame. */
  x: number
  z: number
  heading: number
  age: number
  armed: boolean
  /** Cart animation state. */
  travel: number
  steer: number
  throttle: number
  cog: number
  idle: number
  /** Squash spring (fraction of the height; 0 = at rest) for grabs, landings and impacts. */
  bump: number
  bumpV: number
  /**
   * Offset of the drawn pose from the simulated one. The simulation moves a tool at once when it is grabbed (into the
   * hands) or let go at the grinder (0.3 m back): the model swings there over a few frames instead.
   */
  ox: number
  oz: number
  oh: number
}

// --- flask stacks ----------------------------------------------------------------------------------------------------

const STACK_MAX = Math.max(P.FLASK_CARRY_MAX, P.PORTER_CARRY) + 2
/** Lean of the chain per m/s of the carrier: 38 deg at the doctor's cruise speed (SPEC 2.5). */
const LEAN_RUN = (38 * Math.PI) / 180
const LEAN_GAIN = LEAN_RUN / P.PLAYER_SPEED
const LEAN_MAX = (46 * Math.PI) / 180
/** Spring of the lowest flask (rad/s); every flask above is a little slower, which is what makes the stack whip. */
const LEAN_W = 24
const LEAN_W_FALLOFF = 0.075
const LEAN_DAMPING = 0.5
/** Extra pitch at full lean (SPEC 2.5: 0.76 m -> about 1.0 m). */
const STRETCH = 0.3
const FLASK_POP = 0.15
const FLASK_POP_SWELL = 0.3

interface Stack {
  /** Bulb centres [x, y, z, ...] and the unit direction of every flask's neck (nearly upright however the chain bends). */
  nodes: Float32Array
  dirs: Float32Array
  /** Lean of every flask (radians, as a horizontal world vector) and its rate. */
  lx: Float32Array
  lz: Float32Array
  lvx: Float32Array
  lvz: Float32Array
  /** Seconds since each flask arrived (pop-in). */
  pop: Float32Array
  n: number
  /** Where the next flask will sit (target of the pickup streaks). */
  topX: number
  topY: number
  topZ: number
  /** Pitch spring: squashes when a flask lands on top, stretches when one is thrown. */
  squash: number
  squashV: number
  /** Carrier position of the previous frame (to derive a velocity where the state has none). */
  px: number
  pz: number
  vx: number
  vz: number
  live: boolean
  /** Flasks thrown by events since the last update. */
  thrown: number
}

function makeStack(): Stack {
  const f = (k = 1) => new Float32Array(STACK_MAX * k)
  return { nodes: f(3), dirs: f(3), lx: f(), lz: f(), lvx: f(), lvz: f(), pop: f(), n: 0, topX: 0, topY: 0, topZ: 0, squash: 0, squashV: 0, px: 0, pz: 0, vx: 0, vz: 0, live: false, thrown: 0 }
}

/**
 * Advances the lagging chain and lays out the bulb centres above the foot (bx, by, bz).
 * @param n      flasks standing in the stack
 * @param vx,vz  velocity of the carrier
 * @param still  true to put the chain at rest at once (first picture, teleports)
 */
function poseStack(st: Stack, bx: number, by: number, bz: number, n: number, vx: number, vz: number, dt: number, time: number, still: boolean) {
  n = Math.min(n, STACK_MAX)
  if (!st.live || still) {
    st.live = true
    st.lx.fill(0)
    st.lz.fill(0)
    st.lvx.fill(0)
    st.lvz.fill(0)
    st.pop.fill(1)
    st.squash = st.squashV = 0
  } else if (n > st.n) {
    for (let j = st.n; j < n; j++) {
      st.pop[j] = 0
      st.lx[j] = j > 0 ? st.lx[j - 1]! : 0
      st.lz[j] = j > 0 ? st.lz[j - 1]! : 0
      st.lvx[j] = st.lvz[j] = 0
    }
    st.squashV -= 3.2
  } else if (n < st.n) st.squashV += 2.2
  st.n = n

  // target lean: back against the motion
  let tx = -vx * LEAN_GAIN
  let tz = -vz * LEAN_GAIN
  const tl = Math.hypot(tx, tz)
  if (tl > LEAN_MAX) {
    tx *= LEAN_MAX / tl
    tz *= LEAN_MAX / tl
  }
  const steps = Math.max(1, Math.min(10, Math.ceil(dt / 0.008)))
  const h = dt / steps
  for (let k = 0; k < steps; k++) {
    for (let j = 0; j < n; j++) {
      const w = LEAN_W / (1 + j * LEAN_W_FALLOFF)
      // a breath of idle sway so that a standing stack is not a rigid pole
      const sway = 0.012 * Math.sin(time * 1.9 + j * 0.55)
      st.lvx[j] = st.lvx[j]! + (w * w * (tx + sway - st.lx[j]!) - 2 * LEAN_DAMPING * w * st.lvx[j]!) * h
      st.lvz[j] = st.lvz[j]! + (w * w * (tz - st.lz[j]!) - 2 * LEAN_DAMPING * w * st.lvz[j]!) * h
      st.lx[j] = st.lx[j]! + st.lvx[j]! * h
      st.lz[j] = st.lz[j]! + st.lvz[j]! * h
    }
    st.squashV += (-34 * 34 * st.squash - 2 * 0.38 * 34 * st.squashV) * h
    st.squash += st.squashV * h
  }

  let x = bx
  let y = by + FLASK_RADIUS
  let z = bz
  for (let j = 0; j < n; j++) {
    st.nodes[j * 3] = x
    st.nodes[j * 3 + 1] = y
    st.nodes[j * 3 + 2] = z
    st.pop[j] = st.pop[j]! + dt
    // the link to the flask above leans with that flask; the foot of a tall stack stays planted on the back
    const k = Math.min(j + 1, n - 1)
    const plant = flaskChainLean(Math.max(0, n - 2 - j))
    const ax = st.lx[k]! * plant
    const az = st.lz[k]! * plant
    const a = Math.min(LEAN_MAX, Math.hypot(ax, az))
    const sn = a > 1e-5 ? Math.sin(a) / Math.hypot(ax, az) : 0
    const dx = ax * sn
    const dy = Math.cos(a)
    const dz = az * sn
    const tilt = 1 / Math.hypot(dx * FLASK_CHAIN_TILT, dy, dz * FLASK_CHAIN_TILT)
    st.dirs[j * 3] = dx * FLASK_CHAIN_TILT * tilt
    st.dirs[j * 3 + 1] = dy * tilt
    st.dirs[j * 3 + 2] = dz * FLASK_CHAIN_TILT * tilt
    const pitch = P.FLASK_STACK_PITCH * clamp(1 + STRETCH * Math.min(1, a / LEAN_RUN) + st.squash, 0.8, 1 + STRETCH)
    x += dx * pitch
    y += dy * pitch
    z += dz * pitch
  }
  st.topX = x
  st.topY = y
  st.topZ = z
}

/** Draws a posed stack into `mesh` from instance `first`; returns the next free instance. */
function drawStack(mesh: THREE.InstancedMesh, first: number, st: Stack): number {
  const n = st.n
  for (let j = 0; j < n; j++) {
    const o = j * 3
    // a flask lands on the stack swollen and settles (ad, 7.8-7.93 s)
    const u = st.pop[j]! / FLASK_POP
    const scale = u < 1 ? 1 + FLASK_POP_SWELL * (1 - u) * (1 - u) : 1
    setFlask(mesh, first + j, st.nodes[o]!, st.nodes[o + 1]!, st.nodes[o + 2]!, st.dirs[o]!, st.dirs[o + 1]!, st.dirs[o + 2]!, scale)
    // the lower flasks of a tall stack are paler (ad, 43-44 s)
    setFlaskPale(mesh, first + j, n > 6 && j < 4 ? 0.7 - j * 0.16 : 0)
  }
  return first + n
}

// --- flasks in the air -----------------------------------------------------------------------------------------------

const STREAK_MAX = 32
const STREAK_TIME = 0.12
const THROW_MAX = 32
/** Throw: the arc peaks this far above the launch point and at least this far above the rim (SPEC 2.6: rises 0.6 m). */
const THROW_RISE = 0.6
const THROW_RIM_CLEAR = 0.9
const THROW_TUMBLE = 1.3 * Math.PI
/** The flask disappears into the pot at this fraction of the rim height. */
const THROW_SINK = 0.62

export function createRiverView(ctx: ViewCtx): ViewModule {
  const { scene, stage, anchors } = ctx
  const fx: Fx = ctx.fx
  const root = new THREE.Group()
  root.name = 'river'
  scene.add(root)

  // --- balls ---
  const balls = createBallMesh(P.BALL_COUNT)
  const burstBalls = createBallMesh(BURST_BALLS)
  burstBalls.count = 0
  root.add(balls, burstBalls)
  stage.noOutline(balls)
  stage.noOutline(burstBalls)
  const burst = { t: CAPTURE_BURST_TIME, x: 0, z: 0, r: 1 }
  let sprayCursor = 0
  let sprayAcc = 0

  // --- bubbles ---
  const slots: BubbleSlot[] = []
  const newSlot = (): BubbleSlot => {
    const model = makeBubble()
    model.root.visible = false
    root.add(model.root)
    // like the balls, the ad's bubbles have a soft lighter rim and no ink line
    stage.noOutline(model.root)
    const slot: BubbleSlot = { model, id: -1, seen: false, x: 0, z: 0, r: 1, vx: 0, vz: 0, roll: 0, held: false, dockT: 9, hitT: 9, fallT: -1 }
    slots.push(slot)
    return slot
  }
  for (let i = 0; i < P.BUBBLE_MAX_ALIVE + 2; i++) newSlot()
  const slotOf = (id: number): BubbleSlot | null => {
    for (let i = 0; i < slots.length; i++) if (slots[i]!.id === id) return slots[i]!
    return null
  }
  const takeSlot = (b: Bubble): BubbleSlot => {
    let slot: BubbleSlot | null = null
    for (let i = 0; i < slots.length && !slot; i++) if (slots[i]!.id < 0) slot = slots[i]!
    slot ??= newSlot()
    slot.id = b.id
    slot.held = b.state === 'docking' || b.state === 'docked'
    slot.dockT = slot.hitT = 9
    slot.fallT = -1
    slot.roll = b.roll
    slot.model.reset()
    slot.model.setRoll(b.roll, 0, 0)
    slot.model.root.visible = true
    return slot
  }
  const smear = { model: makeBubble(), slot: null as BubbleSlot | null, t: 0 }
  smear.model.root.visible = false
  root.add(smear.model.root)
  const freeSlot = (slot: BubbleSlot) => {
    slot.id = -1
    slot.fallT = -1
    slot.model.root.visible = false
  }

  // --- grinder ---
  const grinder = makeGrinder()
  grinder.root.position.set(GCX, 0, GCZ)
  const shards = createShardMesh(SHARDS_MAX)
  root.add(grinder.root, shards)
  stage.noOutline(shards)
  let sparkAcc = 0

  // --- tools ---
  const toolViews: ToolView[] = []
  const newToolView = (): ToolView => ({ scoop: null, cart: null, glow: null, glowKind: 'scoop', kind: null, x: 0, z: 0, heading: 0, age: -1, armed: false, travel: 0, steer: 0, throttle: 0, cog: 0, idle: 0, bump: 0, bumpV: 0, ox: 0, oz: 0, oh: 0 })
  const foamAcc = [0, 0]
  let mounted = false

  // --- flasks ---
  const pile = createFlaskMesh(GROUND_FLASK_MAX)
  const pileShadows = createFlaskShadowMesh(GROUND_FLASK_MAX)
  const carried = createFlaskMesh(STACK_MAX * 2 + STREAK_MAX + THROW_MAX)
  root.add(pileShadows, pile, carried)
  stage.noOutline(pile)
  stage.noOutline(carried)
  const stacks: Record<'player' | 'porter', Stack> = { player: makeStack(), porter: makeStack() }
  // pickup streaks (ring of fixed records) and the launch points of the flasks on their way to the pot (FIFO, in step
  // with s.cauldron.incoming)
  const streaks = Array.from({ length: STREAK_MAX }, () => ({ t: -1, x: 0, z: 0, yaw: 0, porter: false, unit: false }))
  const throwsFrom = new Float32Array(THROW_MAX * 3)
  let throwHead = 0
  let throwN = 0
  const pushThrow = (x: number, y: number, z: number) => {
    if (throwN >= THROW_MAX) {
      throwHead = (throwHead + 1) % THROW_MAX
      throwN--
    }
    const o = ((throwHead + throwN) % THROW_MAX) * 3
    throwsFrom[o] = x
    throwsFrom[o + 1] = y
    throwsFrom[o + 2] = z
    throwN++
  }

  let stackSide = 0
  let lastTime = -1
  const v3 = new THREE.Vector3()

  // ------------------------------------------------------------------------------------------------------------------

  const updateBalls = (s: GameState, dt: number) => {
    const b = s.balls
    setBallPositions(balls, b.x, b.z, b.y, b.n)
    // spray where the curtain of balls tips over the lip: droplets from a rotating sample of the river, so many balls
    // a second whatever the frame rate
    sprayAcc += SPRAY_SAMPLES * dt
    const samples = Math.floor(sprayAcc)
    sprayAcc -= samples
    for (let k = 0; k < samples; k++) {
      const i = sprayCursor
      sprayCursor = (sprayCursor + 1) % b.n
      if (b.state[i] !== BALL_FALL || b.t[i]! > 0.1 || rnd() > 0.55) continue
      const o = part('dot', b.x[i]! + rs() * 0.15, 0.1, b.z[i]! + 0.1, 0.3 + rnd() * 0.25, 0.1, PAL.foam)
      o.size1 = 0.03
      o.color1 = PAL.ballHi
      o.alpha = 0.75
      o.vx = b.vx[i]! * 0.5 + rs() * 0.5
      o.vy = 0.9 + rnd() * 1.6
      o.vz = b.vz[i]! * 0.7 + rnd() * 0.6
      o.gravity = 9
      fx.spawn(o)
      if (rnd() < 0.12) {
        const m = part('puff', b.x[i]!, -0.2, b.z[i]! + 0.35, 0.7, 0.5, PAL.foam)
        m.size1 = 1.2
        m.alpha = 0.1
        m.vy = 0.5
        m.vz = 0.8
        m.fadeIn = 0.3
        fx.spawn(m)
      }
    }
  }

  const updateBubbles = (s: GameState, dt: number, jumped: boolean) => {
    const g = s.grinder
    if (jumped) burst.t = CAPTURE_BURST_TIME
    for (let i = 0; i < slots.length; i++) {
      slots[i]!.seen = false
      if (jumped) slots[i]!.fallT = -1
    }
    for (let i = 0; i < s.bubbles.length; i++) {
      const b = s.bubbles[i]!
      if (b.state === 'gone') continue
      const slot = slotOf(b.id) ?? takeSlot(b)
      const m = slot.model
      slot.seen = true
      const held = b.state === 'docking' || b.state === 'docked'
      if (held && !slot.held && !jumped) {
        slot.dockT = 0
        smear.slot = slot
        smear.t = 0
        smear.model.root.visible = true
      }
      slot.held = held
      slot.dockT += dt
      slot.hitT += dt
      slot.x = b.x
      slot.z = b.z
      slot.r = b.r
      slot.vx = b.vx
      slot.vz = b.vz
      slot.roll = b.roll

      const grow = b.state === 'drift' ? clamp01(b.age / BUBBLE_GROW) : 1
      m.setRadius(b.r * (0.72 + 0.28 * easeOutCubic(grow)))
      m.root.position.set(b.x, trayLift(b.x, b.z, b.r), b.z)
      m.setRoll(b.roll, b.vx, b.vz)
      if (b.state === 'grinder' && g.bubble === b.id && g.t >= P.GRIND_CRACK) m.setGrindTime(g.t)
      else {
        // still whole: it only wobbles from the snap into the blade, an oversize hit or the drop onto the discs
        m.setCrack(0)
        m.setShell(0, 0, b.state === 'grinder' ? wobble(Math.max(0, g.t), 0.1) : wobble(slot.dockT, 0.09) * wobble(slot.hitT, 0.12))
      }
      m.setOpacity(smoothstep(0, 0.3, b.age))
      if (smear.slot === slot) {
        const u = smear.t / SMEAR_TIME
        smear.model.root.position.copy(m.root.position)
        smear.model.setRadius(b.r * (1 + SMEAR_SWELL * easeOutCubic(u)))
        smear.model.setOpacity(SMEAR_OPACITY * (1 - u))
      }
    }
    smear.t += dt
    if (smear.slot && (smear.t >= SMEAR_TIME || !smear.slot.seen)) {
      smear.slot = null
      smear.model.root.visible = false
    }
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!
      if (slot.seen || slot.id < 0) continue
      if (slot.fallT < 0) {
        freeSlot(slot)
        continue
      }
      // over the lip: it tips, drops onto the lowland, rolls on and fades
      slot.fallT += dt
      const t = slot.fallT
      const speed = Math.hypot(slot.vx, slot.vz)
      slot.x += slot.vx * dt
      slot.z += slot.vz * dt
      slot.roll += (speed * dt) / slot.r
      const land = Math.sqrt((2 * L.FALL_DROP) / FALL_GRAVITY)
      const gone = smoothstep(FALL_FADE_START, FALL_TIME, t)
      const y = (t < land ? -0.5 * FALL_GRAVITY * t * t : -L.FALL_DROP) - gone * slot.r
      const m = slot.model
      m.root.position.set(slot.x, y, slot.z)
      m.setRoll(slot.roll, slot.vx, slot.vz)
      m.setShell(0, 0, wobble(Math.max(0, t - land), 0.14))
      m.setRadius(slot.r * (1 - 0.25 * gone))
      m.setOpacity(1 - gone)
      if (t >= FALL_TIME) freeSlot(slot)
    }

    if (burstBalls.count > 0 || burst.t < CAPTURE_BURST_TIME) {
      // (past the end this only empties the mesh, however long the frame was)
      poseCaptureBurst(burstBalls, burst.x, burst.z, burst.r, burst.t, BURST_BALLS)
      // these balls are not in the simulation: they sink into the bed as they land instead of popping out of existence
      const sink = 0.3 * smoothstep(0.82, 1, burst.t / CAPTURE_BURST_TIME)
      const a = burstBalls.instanceMatrix.array as Float32Array
      for (let i = 0; i < burstBalls.count; i++) a[i * 16 + 13] = a[i * 16 + 13]! - sink
      burst.t += dt
    }
  }

  const updateGrinder = (s: GameState, dt: number) => {
    const g = s.grinder
    grinder.setSpin(g.spin)
    const grinding = g.state === 'grinding'
    const shatterT = grinding ? g.t - P.GRIND_SHARDS : -1
    poseShards(shards, g.bx, g.bz, g.br, shatterT)
    const slump = slumpShards(shards, g.bz, g.br, shatterT)
    if (!grinding || g.t < P.GRIND_SHELL) {
      sparkAcc = 0
      return
    }
    // fine cyan / white specks spraying up along both roller rows while the crystal is being eaten (SPEC 9 row 5);
    // they follow the shards as these spread over the whole tray
    const strength = g.t < P.GRIND_SHARDS ? 0.35 : 1 - 0.5 * smoothstep(P.GRIND_FREE - 0.4, P.GRIND_FREE, g.t)
    const mid = lerp(g.bz, GCZ, slump)
    const reach = lerp(g.br + 0.35, (GZ1 - GZ0) / 2, slump)
    sparkAcc += 170 * strength * dt
    while (sparkAcc >= 1) {
      sparkAcc--
      const row = rnd() < 0.5 ? -1 : 1
      const z = clamp(mid + rs() * reach, GZ0 + 0.35, GZ1 - 0.35)
      const tone = rnd()
      const o = part('dot', GCX + row * GRINDER_ROW_X + rs() * 0.25, GRINDER_DISC_TOP + 0.05, z, 0.22 + rnd() * 0.32, 0.09 + rnd() * 0.1, tone < 0.25 ? PAL.bubbleHi : tone < 0.7 ? PAL.shardLit : PAL.shard)
      o.color1 = tone < 0.25 ? PAL.shardLit : PAL.shardDark
      o.size1 = 0.04
      o.stretch = 2.2
      o.vx = -row * (0.3 + rnd() * 1.2) + rs() * 0.6
      o.vy = 2.2 + rnd() * 3.8
      o.vz = rs() * 1.3
      o.gravity = 13
      o.additive = tone < 0.25
      fx.spawn(o)
    }
  }

  /** Chips that keep hopping on the rollers (SPEC 2.4: +1.3 .. +2.2 s) and at every stage of the break-up. */
  const chips = (x: number, z: number, r: number, n: number, up: number, spread: number, linger: number) => {
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2
      const d = Math.sqrt(rnd()) * r
      const cx = clamp(x + Math.cos(a) * d, GX0 + 0.25, GX1 - 0.25)
      const cz = clamp(z + Math.sin(a) * d, GZ0 + 0.3, GZ1 - 0.3)
      const o = part('dot', cx, GRINDER_DISC_TOP + rnd() * 0.3, cz, 0.3 + rnd() * 0.35, 0.09 + rnd() * 0.09, rnd() < 0.4 ? PAL.shardLit : PAL.shard)
      o.color1 = PAL.shardDark
      o.size1 = 0.04
      o.vx = Math.cos(a) * spread * rnd()
      o.vz = Math.sin(a) * spread * rnd()
      o.vy = up * (0.5 + rnd())
      o.gravity = 14
      o.delay = rnd() * linger
      o.fadeOut = 0.75
      fx.spawn(o)
    }
  }

  /** Grey dust puffing out from under something heavy at (x, z). */
  const dust = (x: number, z: number, r: number, n: number, color: number = PAL.dirtLit) => {
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2
      const o = part('puff', x + Math.cos(a) * r, 0.15, z + Math.sin(a) * r, 0.35 + rnd() * 0.25, 0.45, color)
      o.size1 = 1.1
      o.alpha = 0.3
      o.vx = Math.cos(a) * 1.4
      o.vz = Math.sin(a) * 1.4
      o.vy = 0.5
      o.drag = 3
      fx.spawn(o)
    }
  }

  /** Droplets thrown up and outward from a ring of radius r around (x, z). */
  const droplets = (x: number, z: number, r: number, n: number, up: number) => {
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2
      const o = part('dot', x + Math.cos(a) * r, 0.2 + rnd() * 0.3, z + Math.sin(a) * r, 0.28 + rnd() * 0.2, 0.11, PAL.foam)
      o.color1 = PAL.ballHi
      o.size1 = 0.03
      o.alpha = 0.85
      o.vx = Math.cos(a) * (1 + rnd() * 2)
      o.vz = Math.sin(a) * (1 + rnd() * 2)
      o.vy = up * (0.6 + rnd() * 0.6)
      o.gravity = 12
      fx.spawn(o)
    }
  }

  const ensureModel = (v: ToolView, kind: ToolKind): THREE.Group => {
    if (kind === 'cart') {
      if (!v.cart) {
        v.cart = makeCart()
        root.add(v.cart.root)
      }
      return v.cart.root
    }
    if (!v.scoop) {
      v.scoop = makeScoop()
      root.add(v.scoop.root)
    }
    return v.scoop.root
  }

  const updateTools = (s: GameState, dt: number, simDt: number, jumped: boolean) => {
    for (let i = 0; i < s.tools.length; i++) {
      const t = s.tools[i]!
      const v = (toolViews[i] ??= newToolView())
      const kind = t.exists ? t.kind : null
      if (kind !== v.kind) {
        if (v.scoop) v.scoop.root.visible = false
        if (v.cart) v.cart.root.visible = false
        v.kind = kind
        v.age = -1
        v.bump = v.bumpV = 0
      }
      if (!kind) {
        if (v.glow) v.glow.root.visible = false
        continue
      }
      const model = ensureModel(v, kind)
      model.visible = true
      const fresh = v.age < 0 || t.age < v.age
      if (fresh || jumped) {
        v.x = t.x
        v.z = t.z
        v.heading = t.heading
        v.armed = t.armed
        v.steer = v.throttle = 0
        v.ox = v.oz = v.oh = 0
      }
      v.age = t.age

      // motion since the previous frame, along the heading
      const sh = Math.sin(t.heading)
      const ch = Math.cos(t.heading)
      const along = (t.x - v.x) * sh + (t.z - v.z) * ch
      const speed = simDt > 0 ? along / simDt : 0
      if (v.cart && kind === 'cart') {
        const c = v.cart
        v.travel += along
        const turn = simDt > 0 ? angleDelta(v.heading, t.heading) / simDt / P.CART_TURN_RATE : 0
        v.steer += (clamp(turn, -1, 1) - v.steer) * damp(10, dt)
        v.throttle += (clamp01(Math.abs(speed) / P.CART_SPEED) - v.throttle) * damp(8, dt)
        // the cogs keep ticking over while somebody sits on the bench
        v.idle += ((t.holder === 'none' ? 0 : 1) - v.idle) * damp(3, dt)
        v.cog += v.idle * 1.6 * dt
        c.setTravel(v.travel)
        c.setSteer(v.steer)
        c.setThrottle(v.throttle)
        c.setCogSpin(v.cog)
      }

      // foam at the blade tips where they plough through packed balls
      if (t.holder !== 'none' && Math.abs(speed) > 1.5) ploughFoam(s, t, Math.abs(speed), dt)

      // the tool is free to be taken again: a glint on the handle and a small hop
      if (t.armed && !v.armed && t.holder === 'none' && t.age > 1) {
        v.bumpV -= 1.1
        const gz = kind === 'cart' ? 0.5 : SCOOP_GRIP.z
        const o = part('spark', t.x + sh * gz, kind === 'cart' ? 1.6 : SCOOP_GRIP.y + 0.1, t.z + ch * gz, 0.35, 0.2, PAL.goldCore)
        o.size1 = 0.9
        o.additive = true
        o.spin = 3
        o.fadeOut = 0.3
        fx.spawn(o)
      }
      v.armed = t.armed
      v.x = t.x
      v.z = t.z
      v.heading = t.heading

      v.bumpV += (-26 * 26 * v.bump - 2 * 0.4 * 26 * v.bumpV) * Math.min(dt, 0.03)
      v.bump += v.bumpV * Math.min(dt, 0.03)
      const pop = t.age < POP_TIME ? lerp(0.35, 1, easeOutBack(t.age / POP_TIME)) : 1
      const ease = Math.exp(-TOOL_SWING * dt)
      v.ox *= ease
      v.oz *= ease
      v.oh *= ease
      model.position.set(t.x + v.ox, 0, t.z + v.oz)
      model.rotation.y = t.heading + v.oh
      model.scale.set(pop * (1 + v.bump * 0.35), pop * (1 - v.bump), pop * (1 + v.bump * 0.35))

      updateGlow(v, t, kind, fresh)
    }
  }

  const updateGlow = (v: ToolView, t: Tool, kind: ToolKind, fresh: boolean) => {
    if (t.age >= GLOW_END) {
      if (v.glow) v.glow.root.visible = false
      return
    }
    if (!v.glow || v.glowKind !== kind) {
      if (v.glow) {
        root.remove(v.glow.root)
        v.glow.root.traverse(o => {
          if (!(o instanceof THREE.Mesh)) return
          o.geometry.dispose()
          o.material.dispose()
        })
      }
      v.glow = makeGlow(kind)
      v.glowKind = kind
      root.add(v.glow.root)
    }
    const g = v.glow
    const a = t.age
    g.root.visible = true
    g.root.position.set(t.x, 0, t.z)
    g.root.rotation.y = t.heading
    const k = smoothstep(0, GLOW_PEAK, a) * (1 - smoothstep(GLOW_FADE, GLOW_FADE + 0.12, a))
    g.blockMat.opacity = BLOCK_OPACITY * smoothstep(0, 0.04, a) * (1 - smoothstep(BLOCK_HOLD, BLOCK_END, a))
    g.block.visible = g.blockMat.opacity > 0.003
    g.walls.scale.y = GLOW_HEIGHT * (0.35 + 0.65 * easeOutCubic(a / 0.16))
    g.wallMat.color.setScalar(0.85 * k)
    g.fillMat.color.set(PAL.gold).multiplyScalar(0.45 * k)
    g.lineMat.opacity = smoothstep(0, 0.04, a) * (1 - smoothstep(GLOW_END - 0.1, GLOW_END, a))
    if (!fresh || a > 0.2) return
    // fine vertical streaks and sparkles rising out of the footprint
    const sh = Math.sin(t.heading)
    const ch = Math.cos(t.heading)
    const n = kind === 'cart' ? 46 : 24
    for (let i = 0; i < n; i++) {
      const edge = i % 3 !== 0
      let lx = rs() * g.hw
      let lz = rs() * g.hd
      if (edge) {
        if (rnd() < g.hd / (g.hw + g.hd)) lx = Math.sign(lx) * g.hw
        else lz = Math.sign(lz) * g.hd
      }
      lz += g.cz
      const wx = t.x + lx * ch + lz * sh
      const wz = t.z - lx * sh + lz * ch
      const o = part('streak', wx, 0.4 + rnd() * 1.2, wz, 0.22 + rnd() * 0.2, 0.28, rnd() < 0.5 ? PAL.goldCore : PAL.gold)
      o.stretch = 4 + rnd() * 5
      o.vy = 3 + rnd() * 5
      o.additive = true
      o.delay = rnd() * 0.22
      o.alpha = 0.85
      fx.spawn(o)
      if (i % 4 === 0) {
        const p = part('spark', wx, 0.3 + rnd() * 2.2, wz, 0.3 + rnd() * 0.2, 0.15, PAL.goldCore)
        p.size1 = 0.5
        p.additive = true
        p.vy = 1.5 + rnd() * 2
        p.spin = rs() * 6
        p.delay = 0.05 + rnd() * 0.25
        fx.spawn(p)
      }
    }
  }

  const ploughFoam = (s: GameState, t: Tool, speed: number, dt: number) => {
    const poly = BLADES[t.kind].poly
    const sh = Math.sin(t.heading)
    const ch = Math.cos(t.heading)
    const b = s.balls
    for (let side = 0; side < 2; side++) {
      const k = side === 0 ? 0 : poly.length - 2
      const tipX = t.x + poly[k]! * ch + poly[k + 1]! * sh
      const tipZ = t.z - poly[k]! * sh + poly[k + 1]! * ch
      if (!inRiverBed(tipX, tipZ, 0.3)) continue
      // only where balls are really streaming round the tip
      let near = 0
      for (let i = 0; i < b.n && near < 6; i++) {
        const dx = b.x[i]! - tipX
        const dz = b.z[i]! - tipZ
        if (dx * dx + dz * dz < 0.2) near++
      }
      if (near < 3) continue
      foamAcc[side] = foamAcc[side]! + (near / 6) * (speed / P.PLAYER_SPEED) * 16 * dt
      while (foamAcc[side]! >= 1) {
        foamAcc[side] = foamAcc[side]! - 1
        const out = side === 0 ? -1 : 1
        const o = part('dot', tipX + rs() * 0.2, 0.2 + rnd() * 0.25, tipZ + rs() * 0.2, 0.22 + rnd() * 0.14, 0.09, PAL.foam)
        o.color1 = PAL.ballHi
        o.size1 = 0.03
        o.alpha = 0.6
        o.vx = out * ch * (0.6 + rnd()) + sh * speed * 0.2
        o.vz = -out * sh * (0.6 + rnd()) + ch * speed * 0.2
        o.vy = 0.8 + rnd() * 1.2
        o.gravity = 8
        fx.spawn(o)
      }
    }
  }

  const updateFlasks = (s: GameState, dt: number, simDt: number, time: number, jumped: boolean) => {
    // --- the pile west of the grinder ---
    let n = 0
    const fl = s.groundFlasks
    for (let i = 0; i < fl.length && n < GROUND_FLASK_MAX; i++, n++) {
      const f = fl[i]!
      const k = f.age / P.FLASK_EJECT_FLIGHT
      if (k < 1) {
        setFlaskFlight(pile, n, f.fromX, f.fromZ, f.x, f.z, k, f.rot, 0.5 + 0.5 * ((f.id * 0.618) % 1))
        setFlaskShadow(pileShadows, n, f.x, f.z, f.rot, 0, 0.3 + 0.7 * k)
        continue
      }
      // it lands with one small hop and rocks to rest
      const u = (f.age - P.FLASK_EJECT_FLIGHT) / 0.22
      const settle = u < 1 ? (1 - u) * (1 - u) : 0
      setFlaskLying(pile, n, f.x, f.z, f.rot + settle * 0.5 * Math.sin(u * 9 + f.id), settle * 0.16 * Math.abs(Math.sin(u * Math.PI)))
      setFlaskShadow(pileShadows, n, f.x, f.z, f.rot)
      if (u * 0.22 < simDt) {
        const o = part('puff', f.x, 0.12, f.z, 0.28, 0.3, PAL.dirtLit)
        o.size1 = 0.8
        o.alpha = 0.22
        o.vy = 0.3
        fx.spawn(o)
      }
    }
    commitFlasks(pile, n)
    commitFlasks(pileShadows, n)

    // --- the stacks ---
    let pending = 0
    let pendingPorter = 0
    for (let i = 0; i < STREAK_MAX; i++) {
      const k = streaks[i]!
      if (k.t >= 0 && k.unit) k.porter ? pendingPorter++ : pending++
    }
    const p = s.player
    const doc = stacks.player
    // the stack steps aside when a coin column joins it on the back (and back again), rather than jumping
    stackSide = jumped ? stackSides(s).flask : stackSide + (stackSides(s).flask - stackSide) * damp(14, dt)
    offsetRight(anchors.playerBack, anchors.playerHeading, stackSide, v3)
    poseStack(doc, v3.x, v3.y, v3.z, Math.max(0, p.flasks - pending), p.vx, p.vz, dt, time, jumped)
    doc.thrown = 0
    const o = s.porter
    const por = stacks.porter
    if (simDt > 0 && !jumped) {
      por.vx += ((o.x - por.px) / simDt - por.vx) * damp(18, dt)
      por.vz += ((o.z - por.pz) / simDt - por.vz) * damp(18, dt)
    } else por.vx = por.vz = 0
    por.px = o.x
    por.pz = o.z
    poseStack(por, anchors.porterCarry.x, anchors.porterCarry.y, anchors.porterCarry.z, o.present ? Math.max(0, o.flasks - pendingPorter) : 0, por.vx, por.vz, dt, time, jumped)
    por.thrown = 0
    let c = drawStack(carried, 0, doc)
    c = drawStack(carried, c, por)

    // --- pickup streaks: a flask stretched into a blue streak from the pile to the top of the stack ---
    for (let i = 0; i < STREAK_MAX; i++) {
      const k = streaks[i]!
      if (k.t < 0) continue
      k.t += dt
      if (k.t >= STREAK_TIME || jumped) {
        k.t = -1
        continue
      }
      const st = k.porter ? por : doc
      const u = k.t / STREAK_TIME
      const e = u * u * (3 - 2 * u)
      const x = lerp(k.x, st.topX, e)
      const z = lerp(k.z, st.topZ, e)
      const y = lerp(FLASK_RADIUS, st.topY, e) + 0.5 * Math.sin(Math.PI * u)
      // aim along the path: from lying toward the stack, ending upright
      let ax = (st.topX - k.x) * (1 - e) + Math.sin(k.yaw) * (1 - u) * 0.4
      let ay = (st.topY - FLASK_RADIUS) * (1 - e) + e * 2 + 0.3
      let az = (st.topZ - k.z) * (1 - e) + Math.cos(k.yaw) * (1 - u) * 0.4
      const al = Math.hypot(ax, ay, az)
      ax /= al
      ay /= al
      az /= al
      setFlask(carried, c, x, y, z, ax, ay, az, 1 - 0.2 * e, 1 + 1.1 * Math.sin(Math.PI * Math.min(1, u * 1.25)))
      setFlaskPale(carried, c++, 0.25 * Math.sin(Math.PI * u))
    }

    // --- throws: one flask per entry of cauldron.incoming, on an arc from where it left the stack into the pot ---
    const inc = s.cauldron.incoming
    while (throwN > inc.length) {
      throwHead = (throwHead + 1) % THROW_MAX
      throwN--
    }
    // flights whose launch was not seen (a view built mid-game): from the top of whoever is pouring
    const lost = o.present && o.state === 'pour' && dist2(p.x, p.z, L.CAULDRON.x, L.CAULDRON.z) > P.DEPOSIT_RADIUS * P.DEPOSIT_RADIUS ? por : doc
    while (throwN < Math.min(inc.length, THROW_MAX)) pushThrow(lost.topX, lost.topY, lost.topZ)
    const big = s.unlocks.bigCauldron ? 1.15 : 1
    const rimY = P.CAULDRON_RIM_HEIGHT * big
    for (let i = 0; i < throwN; i++) {
      const q = ((throwHead + i) % THROW_MAX) * 3
      const x0 = throwsFrom[q]!
      const y0 = throwsFrom[q + 1]!
      const z0 = throwsFrom[q + 2]!
      const u = clamp01(1 - inc[i]! / P.DEPOSIT_FLIGHT)
      const y1 = rimY * THROW_SINK
      const arc = Math.max(THROW_RISE, rimY + THROW_RIM_CLEAR - y0) - (y1 - y0) / 2
      const dx = L.CAULDRON.x - x0
      const dz = L.CAULDRON.z - z0
      const dl = Math.hypot(dx, dz) || 1
      const a = THROW_TUMBLE * u
      const sn = Math.sin(a)
      setFlask(carried, c, x0 + dx * u, y0 + (y1 - y0) * u + Math.max(0.3, arc) * 4 * u * (1 - u), z0 + dz * u, (dx / dl) * sn, Math.cos(a), (dz / dl) * sn, 1 - 0.15 * smoothstep(0.7, 1, u))
      setFlaskPale(carried, c++, 1 - smoothstep(0.05, 0.35, u))
    }
    commitFlasks(carried, c)
  }

  return {
    update(s, dt, time) {
      const simDt = lastTime < 0 ? 0 : s.time - lastTime
      // a fast-forward or a restart: nothing may be animated across it
      const jumped = lastTime < 0 || simDt < 0 || simDt > 0.25
      lastTime = s.time

      updateBalls(s, dt)
      updateBubbles(s, dt, jumped)
      updateGrinder(s, dt)
      updateTools(s, dt, jumped ? 0 : simDt, jumped)
      updateFlasks(s, dt, jumped ? 0 : simDt, time, jumped)

      // the wagon dips when the doctor lands on the bench
      const riding = s.player.mode === 'cart'
      if (riding && !mounted && !jumped) {
        const v = toolViews[s.player.tool]
        if (v) v.bumpV += 1.6
      }
      mounted = riding
    },

    onEvent(e: GameEvent, s) {
      switch (e.type) {
        case 'bubbleDock': {
          burst.t = 0
          burst.x = e.x
          burst.z = e.z
          burst.r = e.r
          // a ripple running out through the balls
          for (let i = 0; i < 2; i++) {
            const ring = part('ring', e.x, 0.3, e.z, 0.3 + i * 0.1, e.r * 1.9, PAL.ballHi)
            ring.size1 = e.r * 2 + 2.2 + i * 1.2
            ring.flat = true
            ring.additive = true
            ring.alpha = 0.32
            ring.delay = i * 0.07
            ring.fadeOut = 0.25
            fx.spawn(ring)
          }
          droplets(e.x, e.z, e.r * 0.9, 12, 3.2)
          const v = toolViews[e.tool]
          if (v) v.bumpV += 1.3
          break
        }
        case 'bubbleReject': {
          const slot = slotOf(e.id)
          if (slot) slot.hitT = 0
          // spray where the bubble meets the blade
          const p = s.player
          const dx = p.x - e.x
          const dz = p.z - e.z
          const d = Math.hypot(dx, dz) || 1
          const r = slot ? slot.r : 1.8
          const cx = e.x + (dx / d) * r
          const cz = e.z + (dz / d) * r
          droplets(cx, cz, 0.5, 14, 3.6)
          const v = toolViews[p.tool]
          if (v) v.bumpV += 1.8
          break
        }
        case 'bubbleFall': {
          const slot = slotOf(e.id)
          if (slot) slot.fallT = 0
          droplets(e.x, e.z + e.r * 0.4, e.r * 0.7, 16, 2.6)
          for (let i = 0; i < 3; i++) {
            const o = part('puff', e.x + rs() * e.r * 0.6, -0.3, e.z + 0.6 + rnd() * 0.6, 0.8, 0.9, PAL.foam)
            o.size1 = 2.2
            o.alpha = 0.14
            o.vy = 0.7
            o.vz = 1.2
            o.fadeIn = 0.25
            fx.spawn(o)
          }
          break
        }
        case 'grindStart':
          dust(e.x, e.z, e.r * 0.75, 6)
          break
        case 'grindCrack':
          for (let i = 0; i < 7; i++) {
            const a = rnd() * Math.PI * 2
            const o = part('spark', e.x + Math.cos(a) * e.r * 0.6, GRINDER_DISC_TOP + e.r * (1.1 + rnd() * 0.7), e.z + Math.sin(a) * e.r * 0.6, 0.16 + rnd() * 0.1, 0.25, PAL.bubbleHi)
            o.size1 = 0.75
            o.additive = true
            o.spin = rs() * 5
            o.delay = rnd() * 0.12
            fx.spawn(o)
          }
          break
        case 'grindShell':
          chips(e.x, e.z, e.r, 10, 3.5, 3, 0)
          break
        case 'grindShatter': {
          chips(e.x, e.z, e.r, 30, 4.5, 4, 0.1)
          dust(e.x, e.z, e.r * 0.9, 5, PAL.shardLit)
          break
        }
        case 'grindEnd':
          chips(s.grinder.bx, s.grinder.bz, s.grinder.br + 0.4, 22, 2.6, 1.2, 0.75)
          break
        case 'flaskEject': {
          // small pale flash at the tray edge
          const o = part('dot', e.fromX - 0.05, 0.4, e.fromZ, 0.09, 0.35, PAL.bubbleHi)
          o.size1 = 0.9
          o.additive = true
          o.alpha = 0.8
          o.fadeOut = 0.2
          fx.spawn(o)
          break
        }
        case 'flaskPickup': {
          for (let i = 0; i < STREAK_MAX; i++) {
            const k = streaks[i]!
            if (k.t >= 0) continue
            k.t = 0
            k.x = e.fromX
            k.z = e.fromZ
            k.yaw = rnd() * Math.PI * 2
            k.porter = e.by === 'porter'
            k.unit = e.unitAdded
            break
          }
          break
        }
        case 'flaskThrow': {
          // from where the top flask really is (the stack may be leaning), not from the simulation's upright estimate
          const st = stacks[e.by]
          const j = st.n - 1 - st.thrown
          st.thrown++
          if (j >= 0) pushThrow(st.nodes[j * 3]!, st.nodes[j * 3 + 1]!, st.nodes[j * 3 + 2]!)
          else pushThrow(e.fromX, e.fromY, e.fromZ)
          // the flask flashes white as it leaves (the pale glass is drawn by the flight itself; this is its halo)
          const q = ((throwHead + throwN - 1) % THROW_MAX) * 3
          const o = part('dot', throwsFrom[q]!, throwsFrom[q + 1]! + 0.1, throwsFrom[q + 2]!, 0.12, 0.7, PAL.bubbleHi)
          o.size1 = 1.3
          o.additive = true
          o.alpha = 0.55
          o.fadeOut = 0.2
          fx.spawn(o)
          break
        }
        case 'toolPark':
        case 'toolGrab': {
          const v = toolViews[e.tool]
          const t = s.tools[e.tool]
          if (!v || !t || v.kind !== t.kind) break
          v.bumpV += e.type === 'toolPark' ? 1.2 : -0.9
          // the simulated pose has just jumped: keep the model where it was drawn and let update() swing it over
          const dx = v.x - t.x
          const dz = v.z - t.z
          if (dx * dx + dz * dz < 9) {
            v.ox += dx
            v.oz += dz
            v.oh += angleDelta(t.heading, v.heading)
          }
          v.x = t.x
          v.z = t.z
          v.heading = t.heading
          break
        }
      }
    },
  }
}
