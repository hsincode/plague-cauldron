// Binds the characters to the simulation: the plague doctor with his ring, lantern and emoji, the pooled villagers
// (queue, bath, beds, drill crew), the instanced crowd behind the pen and the staff (usher, nurses, porter, driver).
// It also publishes ctx.anchors (the doctor's back and head, the porter's pack) for the river and coins views.
//
// Everything that persists is a function of GameState: positions, poses, looks, pop-ins (from the age fields) and
// bubble scales (from the state timers). The view therefore shows the right picture one update after it was created
// or after the simulation jumped (__game.skip). Only dust, splashes, the give of a landing and the driver's emoji
// are one-shots.
import * as THREE from 'three'
import { L, P, PAL } from '../config'
import { angleDelta, clamp, clamp01, damp, headingOf, lerp, rotX, rotZ, smoothstep } from '../core/math'
import { BATH_SEAT_Y } from '../sim/bath'
import type { GameEvent } from '../sim/events'
import { HAPPY_TIME, SCARED_TIME } from '../sim/player'
import type { GameState, Tool, Villager } from '../sim/types'
import { BED_LIE_Y } from '../sim/ward'
import { makeBubble, type Bubble } from '../ui/bubbles'
import { makeRing } from '../ui/decals'
import { CROWD_SLOTS } from '../world/crowd'
import type { FxOpts } from './fx'
import { makeDoctor, mixHex, type DoctorPose } from './models/doctor'
import { DRILL } from './models/drill'
import { BED_TOP_Y } from './models/furniture'
import { makeDriver, makeNurse, makePorter, makeUsher, type DriverPose, type NurseModel, type NursePose, type PorterPose, type UsherPose } from './models/staff'
import { CART_SEAT_HEIGHT, makeCart, SCOOP_GRIP } from './models/tools'
import { createCrowd, makeVillager, villagerPoseOf, type VillagerModel, type VillagerPose } from './models/villager'
import type { ViewCtx, ViewModule } from './types'

/** Turn rates (1/s) of the visual headings. On foot the simulation turns the doctor at 900 deg/s: the model follows with a short lag. */
const FOOT_TURN = 22
/** Holding a tool the simulation already limits the turn rate, and the hands must stay on the grips. */
const HELD_TURN = 60
/** Villagers turn at the blend rate of their rig, so the roll onto the bed and the turn of the root stay in step. */
const NPC_TURN = 15
/**
 * The leap onto the cart (ad 37.0-37.3 s; the driver boards the same way): he comes down into the seat from well above
 * the backrest, which usually stands between him and the bench. The arc peaks at this height, late (hop progress ^
 * MOUNT_SKEW), and drops steeply.
 */
const MOUNT_APEX = 1.5
const MOUNT_SKEW = 1.5
/** The driver takes off for that leap this far (m) from the bench. */
const BOARD_DIST = 2
/** Apex of the hop off the bench (the default of models/doctor.ts). */
const DISMOUNT_APEX = 0.45
/**
 * Emoji over the doctor and the driver, measured at 2.2 s and 39.4 s of the ad against the 1.6 m ring and the cart
 * wheels: wider than the ui/bubbles.ts defaults, and the tail ends on the hat, well below the models' head anchors.
 */
const SCARED_SIZE = 1.3
const HAPPY_SIZE = 1.2
const DOCTOR_EMOJI_DROP = 0.6
const DRIVER_EMOJI_DROP = 0.25
const EMOJI_IN = 0.13
const EMOJI_OUT = 0.1
/** A staff member stays hidden inside the unlock pillar this long, then pops in (SPEC 9 row 18). */
const APPEAR_DELAY = 0.2
const APPEAR_TIME = 0.2
/**
 * The simulation sends the nurses running the moment the pad is paid; the ad shows them as a tight cluster inside
 * the pillar first (20.5 s) and fanning out after it. So each is drawn on the spot where she appeared until she pops
 * in, then dashes out and has caught up with her simulated run after this long.
 */
const NURSE_CATCH_UP = 0.4
/** A released villager steps out of the pack next to the gate and has caught up with his simulated position after this long. */
const RELEASE_TIME = 0.3
/** The crowd figure on his spot is gone while he steps out; the next one presses into the gap between these times (s). */
const REFILL_FROM = 0.14
const REFILL_TO = 0.46
/** The usher's arm comes up when the gate opens (ad 29.6 -> 30.0 s) and stays up this long after the last villager has walked in. */
const POINT_HOLD = 0.7
/** Scale of the instanced crowd figures (models/villager.ts): he grows to full size while he steps out. */
const CROWD_SCALE = 0.9
/** A lying patient's root faces the bed head (+x), see the 'lie' pose in models/villager.ts. */
const BED_HEADING = Math.PI / 2
/** Injection tint window on Bed.treatT (SPEC 2.10). */
const TINT_IN = 0.5
const TINT_OUT = 1.2
/** The needle is in at the end of the thrust of models/staff.ts makeNurse. */
const SPLASH_AT = P.TREAT_JAB + 0.05
/** She turns from north to the patient's chest while he lies in her bed (the needle is carried at her right side). */
const NURSE_AIM = angleDelta(Math.PI, headingOf(-L.NURSE_POST.x, -L.NURSE_POST.z))
/** Half the distance between the hands of a crew member on the drill crossbar. */
const CREW_GRIP = 0.13
/**
 * Sick emoji (ad 12.6 s, 30.8 s, 44.2 s): as wide as the villager, its tail on the hair of the bowed head; over a
 * walking villager it rides higher and trails about 0.6 m behind.
 */
const SICK_SIZE = 0.9
const SICK_Y = 1.5
const SICK_AHEAD = 0.45
const SICK_LIFT = 0.35
const SICK_FOLLOW = 9
/** Walkers closer than this are drawn apart: the simulation lets patients on the same path overlap by half a body. */
const BODY_GAP = 0.85
const MAX_VILLAGERS = 256
const DUST = mixHex(PAL.dirtLit, PAL.cream, 0.6)
const DUST_STRIDE = 0.9
/**
 * Run dust of the doctor (SPEC 9 row 25, ad 10.97-11.3 s and 33.6 s): a pale fan swept over the ground behind the hem
 * when his speed passes SWEEP_SPEED or his heading swings by more than SWEEP_TURN within about 0.12 s; 6 frames.
 */
const SWEEP_SPEED = 3
const SWEEP_TURN = 1.1
const SWEEP_COOL = 0.35
const SWEEP_PUFFS = 6
const SWEEP_LIFE = 0.26
/** Coming down from a hop a villager gives at the knees for this long (8 % shorter at the deepest point). */
const LAND_TIME = 0.14

/**
 * Bathers as the ad shows them (13.6-14.4 s): each stands on the bowl wall with his back against it, shoulders level
 * with the rim and (once cured) the arms spread on it, at a fixed height while the potion drains around his legs.
 * The simulation's seats (L.BATH_SEATS, feet at BATH_SEAT_Y) give the side of the pot; the drawn spot is farther out
 * and lower: [radius of the feet from the pot centre, their height on the inner wall of models/cauldron.ts] for the
 * small pot and for the big one (x 1.15), and the angle he leans back by.
 */
const BATH_STAND = [1.0, 0.67] as const
const BATH_STAND_BIG = [1.36, 0.92] as const
const BATH_LEAN = 0.35

/** Scale of a pop-in at progress k: 0, `over` at 70 %, then 1 (SPEC 8.3: a quick scale tween with a slight overshoot). */
const pop = (k: number, over = 1.1) => (k <= 0 ? 0 : k >= 1 ? 1 : k < 0.7 ? over * (1 - (1 - k / 0.7) ** 2) : over - (over - 1) * ((k - 0.7) / 0.3))
/** Emoji timeline: t counts up from 0 while it shows and it is gone at `total`. */
const emojiScale = (t: number, total: number) => (t < 0 || t >= total ? 0 : Math.min(pop(t / EMOJI_IN), (total - t) / EMOJI_OUT))

/** Ground track of one character: distance walked (step phase) and speed in simulated m/s. */
interface Track {
  x: number
  z: number
  odo: number
  speed: number
}
const newTrack = (): Track => ({ x: 0, z: 0, odo: 0, speed: 0 })
function follow(k: Track, x: number, z: number, simDt: number, snap: boolean) {
  if (snap) k.speed = 0
  else if (simDt > 0) {
    const d = Math.hypot(x - k.x, z - k.z)
    k.odo += d
    k.speed = d / simDt
  }
  k.x = x
  k.z = z
}

/** One pooled villager model and the little view state that smooths it. */
interface Vis {
  model: VillagerModel
  id: number
  stamp: number
  fresh: boolean
  heading: number
  /** Offset of the drawn position from the simulated one (drill handle, walkers kept apart), eased so that he never jumps. */
  ox: number
  oz: number
  track: Track
  dustAt: number
  /** Seconds since he came down from a hop. */
  landT: number
  hopping: boolean
  /** Ground point his emoji bubble hangs over (it lags behind him). */
  bx: number
  bz: number
}

interface NurseVis {
  model: NurseModel
  heading: number
  track: Track
  treatT: number
  /** The spot on the pad where she appeared, while she is still catching up with her simulated run. */
  held: boolean
  fromX: number
  fromZ: number
}

// Scratch (update() must not allocate).
const docPose: DoctorPose = { t: 0, dt: 0, mode: 'foot', speed: 0, odo: 0, hop: 0, hopApex: 0, shoved: 0 }
const vilPose: VillagerPose = { look: 'sick', pose: 'stand', phase: 0, t: 0, dt: 0, alpha: 1, tint: 0, seed: 0, height: 0, glow: 1 }
const nursePose: NursePose = { t: 0, dt: 0, speed: 0, odo: 0, treatT: -1 }
const usherPose: UsherPose = { t: 0, dt: 0, speed: 0, odo: 0, point: 0, pointDir: 0 }
const porterPose: PorterPose = { t: 0, dt: 0, speed: 0, odo: 0, load: 0 }
const driverPose: DriverPose = { t: 0, dt: 0, seated: false, speed: 0, odo: 0 }
const puff: FxOpts = { x: 0, y: 0, z: 0, life: 0.3, size: 0.3, color: DUST }
const fan: FxOpts = { x: 0, y: 0.05, z: 0, vy: 0, life: SWEEP_LIFE, size: 0.6, size1: 1.3, color: PAL.cream, alpha: 0.7, fadeIn: 0.12, fadeOut: 0.3, drag: 7, tex: 'puff', flat: true }
const _v = new THREE.Vector3()
const _q = new THREE.Quaternion()
const sepX = new Float32Array(MAX_VILLAGERS)
const sepZ = new Float32Array(MAX_VILLAGERS)

export function createActorsView(ctx: ViewCtx): ViewModule {
  const { fx, anchors, stage } = ctx
  const root = new THREE.Group()
  root.name = 'actors'
  ctx.scene.add(root)

  let lastTime = -1
  let stamp = 0

  // ------------------------------------------------------------------------------------------------ cart levers
  // riverView owns the cart and works its two levers from the cart's motion. The hands of whoever sits on the bench
  // must follow them, so the same two filters run here and an undrawn cart model turns them into the grip positions.
  const levers = makeCart()
  const gripL = new THREE.Vector3()
  const gripR = new THREE.Vector3()
  let leverSteer = 0
  let leverThrottle = 0
  let leverAge = -1
  let leverX = 0
  let leverZ = 0
  let leverHeading = 0

  function updateLevers(s: GameState, dt: number, simDt: number, snap: boolean) {
    let t: Tool | undefined
    for (let i = 0; i < s.tools.length && !t; i++) if (s.tools[i]!.exists && s.tools[i]!.kind === 'cart') t = s.tools[i]
    if (t) {
      if (snap || leverAge < 0 || t.age < leverAge) leverSteer = leverThrottle = 0
      else {
        const along = (t.x - leverX) * Math.sin(t.heading) + (t.z - leverZ) * Math.cos(t.heading)
        const turn = simDt > 0 ? angleDelta(leverHeading, t.heading) / simDt / P.CART_TURN_RATE : 0
        const speed = simDt > 0 ? Math.abs(along) / simDt : 0
        leverSteer += (clamp(turn, -1, 1) - leverSteer) * damp(10, dt)
        leverThrottle += (clamp01(speed / P.CART_SPEED) - leverThrottle) * damp(8, dt)
      }
      leverAge = t.age
      leverX = t.x
      leverZ = t.z
      leverHeading = t.heading
    } else leverAge = -1
    levers.setSteer(leverSteer)
    levers.setThrottle(leverThrottle)
    levers.getGrip(1, gripL)
    levers.getGrip(-1, gripR)
    gripR.x = -gripR.x
  }

  // ------------------------------------------------------------------------------------------------ doctor
  const doctor = makeDoctor()
  doctor.scoopGrip.set(SCOOP_GRIP.halfWidth, SCOOP_GRIP.y, SCOOP_GRIP.z)
  doctor.cartGrip = gripL
  doctor.cartGripRight = gripR
  doctor.seatHeight = CART_SEAT_HEIGHT
  const ring = makeRing()
  const scared = makeBubble('scared', SCARED_SIZE)
  const happy = makeBubble('happy', HAPPY_SIZE)
  scared.setScale(0)
  happy.setScale(0)
  root.add(doctor.root, ring.root, scared.root, happy.root)
  let docHeading = 0
  let ringK = 1
  let seatK = 0
  let wasHopping = false
  let lastSpeed = 0
  let lastHeading = 0
  let turned = 0
  let sweepCool = 0

  /** The fan opens behind him: puffs laid on the ground round the back of the hem slide outward and fade. */
  function sweep(x: number, z: number, heading: number) {
    for (let i = 0; i < SWEEP_PUFFS; i++) {
      const a = heading + Math.PI + ((i + Math.random()) / SWEEP_PUFFS - 0.5) * 2.4
      const sx = Math.sin(a)
      const sz = Math.cos(a)
      const v = 2.2 + Math.random() * 1.2
      fan.x = x + sx * 0.42
      fan.z = z + sz * 0.42
      fan.vx = sx * v
      fan.vz = sz * v
      fan.rot = Math.random() * 6.28
      fx.spawn(fan)
    }
  }

  function dust(x: number, z: number, size: number, alpha: number) {
    puff.x = x + (Math.random() - 0.5) * 0.2
    puff.y = 0.12
    puff.z = z + (Math.random() - 0.5) * 0.2
    puff.vx = (Math.random() - 0.5) * 0.5
    puff.vy = 0.35
    puff.vz = (Math.random() - 0.5) * 0.5
    puff.life = 0.32
    puff.size = size * 0.5
    puff.size1 = size
    puff.color = DUST
    puff.color1 = DUST
    puff.alpha = alpha
    puff.fadeIn = 0.1
    puff.fadeOut = 0.25
    puff.gravity = 0
    puff.drag = 2
    puff.tex = 'puff'
    puff.additive = false
    puff.rot = Math.random() * 6.28
    fx.spawn(puff)
  }

  function updateDoctor(s: GameState, dt: number, snap: boolean) {
    const p = s.player
    const mounting = p.mountT > 0
    const riding = p.mode === 'cart' || mounting
    const k = snap ? 1 : damp(p.mode === 'foot' && !mounting ? FOOT_TURN : HELD_TURN, dt)
    docHeading += angleDelta(docHeading, p.heading) * k
    doctor.root.position.set(p.x, 0, p.z)
    doctor.root.rotation.y = docHeading
    const hop = mounting ? clamp01(1 - p.mountT / P.CART_MOUNT_TIME) ** MOUNT_SKEW : p.dismountT > 0 ? 1 - p.dismountT / P.CART_DISMOUNT_TIME : 0
    const apex = mounting ? MOUNT_APEX : DISMOUNT_APEX
    docPose.t = s.time
    docPose.dt = snap ? 0 : dt
    docPose.mode = riding ? 'cart' : p.mode
    docPose.speed = Math.hypot(p.vx, p.vz)
    docPose.odo = p.odo
    docPose.hop = hop
    docPose.hopApex = apex
    docPose.shoved = clamp01(p.pushedT / 0.2)
    doctor.update(docPose)

    // he lands from the hop off the cart in a puff of dust
    const hopping = p.dismountT > 0
    if (wasHopping && !hopping && !snap) for (let i = 0; i < 5; i++) dust(p.x, p.z, 0.7, 0.4)
    wasHopping = hopping

    const speed = docPose.speed
    turned = snap ? 0 : turned * Math.exp(-dt / 0.12) + Math.abs(angleDelta(lastHeading, p.heading))
    sweepCool -= dt
    if (!snap && !riding && !hopping && sweepCool <= 0 && speed > SWEEP_SPEED && (lastSpeed <= SWEEP_SPEED || turned > SWEEP_TURN)) {
      sweep(p.x, p.z, p.heading)
      sweepCool = SWEEP_COOL
      turned = 0
    }
    lastSpeed = speed
    lastHeading = p.heading

    ringK += ((riding ? 0 : 1) - ringK) * (snap ? 1 : damp(14, dt))
    ring.root.position.set(p.x, 0, p.z)
    ring.setOpacity(ringK)
    ring.setVisible(ringK > 0.01)
    stage.lantern.position.x = p.x
    stage.lantern.position.z = p.z

    // anchors: the stacks stand behind his back (on the bench level while he rides), the emoji on his hat
    seatK += ((riding ? 1 : 0) - seatK) * (snap ? 1 : damp(16, dt))
    const back = doctor.backAnchor.position
    const head = doctor.headAnchor.position
    const lift = CART_SEAT_HEIGHT * seatK + apex * Math.sin(Math.PI * hop)
    anchors.playerBack.set(p.x + rotX(back.x, back.z, docHeading), back.y + lift, p.z + rotZ(back.x, back.z, docHeading))
    anchors.playerHead.set(p.x + rotX(head.x, head.z, docHeading), head.y, p.z + rotZ(head.x, head.z, docHeading))
    anchors.playerHeading = docHeading
    anchors.playerLean = doctor.lean

    scared.setScale(p.emoji === 'scared' ? emojiScale(p.emojiT, SCARED_TIME) : 0)
    happy.setScale(p.emoji === 'happy' ? emojiScale(p.emojiT, HAPPY_TIME) : 0)
    scared.root.position.copy(anchors.playerHead)
    scared.root.position.y -= DOCTOR_EMOJI_DROP
    happy.root.position.copy(scared.root.position)
  }

  // ------------------------------------------------------------------------------------------------ villagers
  const crowd = createCrowd(CROWD_SLOTS)
  root.add(crowd.root)

  const live: Vis[] = []
  const idle: Vis[] = []
  const byId = new Map<number, Vis>()
  const sick: Bubble[] = []
  let sickN = 0
  /** True while somebody is on his way from the gate to the queue. */
  let walkingIn = false

  function acquire(id: number): Vis {
    let vis = idle.pop()
    if (!vis) {
      vis = { model: makeVillager(), id, stamp: 0, fresh: true, heading: 0, ox: 0, oz: 0, track: newTrack(), dustAt: 0, landT: 1, hopping: false, bx: 0, bz: 0 }
      root.add(vis.model.root)
    }
    vis.id = id
    vis.fresh = true
    vis.ox = vis.oz = 0
    vis.track.odo = 0
    vis.dustAt = 0
    byId.set(id, vis)
    live.push(vis)
    return vis
  }

  function sickBubble(x: number, y: number, z: number, scale: number) {
    let b = sick[sickN]
    if (!b) {
      b = makeBubble('sick', SICK_SIZE)
      sick.push(b)
      root.add(b.root)
    }
    sickN++
    b.root.position.set(x, y, z)
    b.setScale(scale)
  }

  /** Wisps that come off a leaping bather: miasma on the way in, potion drops on the way out. */
  function trail(x: number, y: number, z: number, color: number, drops: boolean) {
    puff.x = x + (Math.random() - 0.5) * 0.5
    puff.y = y + 0.6 + Math.random() * 0.6
    puff.z = z + (Math.random() - 0.5) * 0.5
    puff.vx = (Math.random() - 0.5) * 0.8
    puff.vy = drops ? 0.5 : 0.3
    puff.vz = (Math.random() - 0.5) * 0.8
    puff.life = drops ? 0.4 : 0.34
    puff.size = drops ? 0.12 : 0.45
    puff.size1 = drops ? 0.05 : 0.85
    puff.color = color
    puff.color1 = color
    puff.alpha = drops ? 0.9 : 0.5
    puff.fadeIn = 0.1
    puff.fadeOut = 0.4
    puff.gravity = drops ? 12 : 0
    puff.drag = drops ? 0 : 2
    puff.tex = drops ? 'dot' : 'puff'
    puff.additive = false
    puff.rot = Math.random() * 6.28
    fx.spawn(puff)
  }

  const isWalker = (v: Villager) => (v.state === 'toBed' || v.state === 'toExit' || v.state === 'toDrill') && v.alpha >= 1

  /** Fills sepX / sepZ: how far each walker is drawn from his simulated spot so that bodies do not overlap. */
  function spread(vs: Villager[], n: number) {
    for (let i = 0; i < n; i++) sepX[i] = sepZ[i] = 0
    for (let i = 0; i < n; i++) {
      const a = vs[i]!
      if (!isWalker(a)) continue
      for (let j = i + 1; j < n; j++) {
        const b = vs[j]!
        if (!isWalker(b)) continue
        const dx = b.x - a.x
        const dz = b.z - a.z
        const d = Math.hypot(dx, dz)
        if (d >= BODY_GAP) continue
        // on the very same spot: apart along a fixed direction, so the pair does not flip from frame to frame
        const nx = d > 1e-3 ? dx / d : 0.6
        const nz = d > 1e-3 ? dz / d : 0.8
        const push = (BODY_GAP - d) / 2
        sepX[i]! -= nx * push
        sepZ[i]! -= nz * push
        sepX[j]! += nx * push
        sepZ[j]! += nz * push
      }
    }
  }

  function updateVillager(s: GameState, v: Villager, i: number, dt: number, simDt: number, snap: boolean) {
    const vis = byId.get(v.id) ?? acquire(v.id)
    vis.stamp = stamp
    const fresh = snap || vis.fresh
    vis.fresh = false
    const m = vis.model

    let x = v.x
    let y = 0
    let z = v.z
    let heading = v.heading
    let pose = villagerPoseOf(v.state)
    let phase = -1
    let tint = 0
    let scale = 1
    let offX = i < MAX_VILLAGERS ? sepX[i]! : 0
    let offZ = i < MAX_VILLAGERS ? sepZ[i]! : 0
    let bubble = 0
    let lean = 0
    let glow = 1
    let leanX = 0
    let leanZ = 0
    switch (v.state) {
      case 'toQueue': {
        // he is the figure of the pack that stands at the gate: he starts on its spot and catches up with the simulation.
        // The two figures nearest the gate take turns, by release order (the order of s.villagers).
        const k = 1 - smoothstep(0, RELEASE_TIME, v.t)
        const spot = Math.max(0, CROWD_SLOTS.length - 1 - ((s.crowd.released - s.villagers.length + i) & 1))
        if (v.t < REFILL_TO) crowd.setPresence(spot, smoothstep(REFILL_FROM, REFILL_TO, v.t))
        if (k > 0) {
          const from = CROWD_SLOTS[spot]!
          x += (from.x - L.PEN_GATE.x) * k
          z += (from.z - L.PEN_GATE.z) * k
          scale = lerp(1, CROWD_SCALE, k)
        }
        bubble = pop((v.t - 0.08) / EMOJI_IN)
        walkingIn = true
        break
      }
      case 'queued':
        bubble = 1
        break
      case 'preHop':
        bubble = clamp01((P.BATH_PRE_HOP_WAIT - v.t) / EMOJI_OUT)
        break
      case 'hopIn':
      case 'bathing':
      case 'hopOut': {
        // the simulated hop ends on the seat; the drawn one carries on to his place at the wall
        const seat = L.BATH_SEATS[v.slot % L.BATH_SEATS.length]!
        const stand = s.unlocks.bigCauldron ? BATH_STAND_BIG : BATH_STAND
        const k = stand[0] / Math.hypot(seat.x, seat.z) - 1
        let w = 1
        if (v.state === 'hopIn') w = phase = clamp01(v.t / P.BATH_HOP_IN)
        else if (v.state === 'hopOut') {
          phase = clamp01(v.t / P.BATH_HOP_OUT)
          w = 1 - phase
          lean = BATH_LEAN * (1 - smoothstep(0, 0.4, phase))
          glow = smoothstep(0.3, 1, phase)
        } else {
          // he gives at the knees as he lands, turns his back to the wall and settles against it
          heading = headingOf(-seat.x, -seat.z)
          lean = BATH_LEAN * smoothstep(0.04, 0.24, v.t)
          glow = 0
          y = -0.1 * Math.exp(-9 * v.t) * Math.sin(17 * v.t)
        }
        x += seat.x * k * w
        z += seat.z * k * w
        y += v.y + (stand[1] - BATH_SEAT_Y) * w
        if (!fresh && v.state === 'hopIn') trail(x, y, z, PAL.miasma, false)
        else if (!fresh && v.state === 'hopOut') trail(x, y, z, PAL.potion, true)
        leanX = seat.x
        leanZ = seat.z
        break
      }
      case 'lieDown':
        y = v.y - (BED_LIE_Y - BED_TOP_Y) * clamp01(v.t / P.LIE_DOWN_TIME)
        heading = BED_HEADING
        break
      case 'inBed': {
        y = BED_TOP_Y
        heading = BED_HEADING
        const tt = s.beds[v.bed]?.treatT ?? -1
        tint = smoothstep(TINT_IN, TINT_IN + 0.08, tt) * (1 - smoothstep(TINT_OUT, TINT_OUT + 0.12, tt))
        break
      }
      case 'cheer':
        y = BED_TOP_Y
        heading = BED_HEADING
        break
      case 'hopOff': {
        const u = clamp01(v.t / (P.TREAT_END - P.TREAT_HOP_OFF))
        y = v.y - (BED_LIE_Y - BED_TOP_Y) * (1 - u)
        phase = u
        break
      }
      case 'atDrill':
      case 'pushing': {
        // feet and hands by the drill model: the simulation keeps the crew on the crossbar itself
        const d = s.drill
        const c = DRILL.crew[v.slot === 1 ? 1 : 0]!
        offX = d.x + rotX(c.x, c.z, d.heading) - v.x
        offZ = d.z + rotZ(c.x, c.z, d.heading) - v.z
        heading = d.heading
        m.grip.set(CREW_GRIP, DRILL.crossbar.y, DRILL.crossbar.z - c.z)
        break
      }
    }

    const ease = fresh ? 1 : damp(12, dt)
    vis.ox += (offX - vis.ox) * ease
    vis.oz += (offZ - vis.oz) * ease
    x += vis.ox
    z += vis.oz
    follow(vis.track, x, z, simDt, fresh)
    const moving = fresh ? v.pathI * 2 < v.path.length : vis.track.speed > 0.6
    if (pose === 'stand' && moving) pose = 'walk'
    else if (pose === 'walk' && !moving) pose = 'stand'
    vis.heading += angleDelta(vis.heading, heading) * (fresh ? 1 : damp(NPC_TURN, dt))

    const hopping = pose === 'hop'
    if (fresh) vis.landT = 1
    else if (vis.hopping && !hopping && v.state !== 'bathing') {
      vis.landT = 0
      for (let k = 0; k < 2; k++) dust(x, z, 0.55, 0.3)
    } else vis.landT += dt
    vis.hopping = hopping
    const give = vis.landT < LAND_TIME ? Math.sin((Math.PI * vis.landT) / LAND_TIME) : 0

    m.root.position.set(x, y, z)
    m.root.rotation.set(0, vis.heading, 0)
    // leaning back against the pot wall: about the feet, away from the pot centre whichever way he is still turning
    if (lean > 0) m.root.quaternion.premultiply(_q.setFromAxisAngle(_v.set(leanZ, 0, -leanX).normalize(), lean))
    m.root.scale.set(scale * (1 + 0.04 * give), scale * (1 - 0.08 * give), scale * (1 + 0.04 * give))
    vilPose.look = v.look
    vilPose.pose = pose
    vilPose.phase = phase >= 0 ? phase : vis.track.odo
    vilPose.t = s.time
    vilPose.dt = fresh ? 0 : dt
    vilPose.alpha = v.alpha
    vilPose.tint = tint
    vilPose.seed = v.seed
    vilPose.height = hopping ? y : 0
    vilPose.glow = glow
    m.update(vilPose)

    const lag = fresh ? 1 : damp(SICK_FOLLOW, dt)
    const headX = x + Math.sin(vis.heading) * SICK_AHEAD
    const headZ = z + Math.cos(vis.heading) * SICK_AHEAD
    vis.bx += (headX - vis.bx) * lag
    vis.bz += (headZ - vis.bz) * lag
    if (bubble > 0) sickBubble(vis.bx, SICK_Y + SICK_LIFT * clamp01(Math.hypot(headX - vis.bx, headZ - vis.bz) / 0.6), vis.bz, bubble)
    if (pose === 'walk' && v.alpha >= 1 && vis.track.speed > 3 && vis.track.odo - vis.dustAt > DUST_STRIDE) {
      vis.dustAt = vis.track.odo
      dust(x, z, 0.5, 0.28)
    }
  }

  function updateVillagers(s: GameState, dt: number, simDt: number, snap: boolean, time: number) {
    crowd.setRemaining(s.crowd.remaining)
    crowd.setPresence(CROWD_SLOTS.length - 1, 1)
    crowd.setPresence(CROWD_SLOTS.length - 2, 1)

    stamp++
    sickN = 0
    walkingIn = false
    const vs = s.villagers
    spread(vs, Math.min(vs.length, MAX_VILLAGERS))
    for (let i = 0; i < vs.length; i++) if (vs[i]!.state !== 'gone') updateVillager(s, vs[i]!, i, dt, simDt, snap)
    for (let i = live.length - 1; i >= 0; i--) {
      const vis = live[i]!
      if (vis.stamp === stamp) continue
      vis.model.root.visible = false
      byId.delete(vis.id)
      live[i] = live[live.length - 1]!
      live.pop()
      idle.push(vis)
    }
    for (let i = sickN; i < sick.length; i++) sick[i]!.setScale(0)
    crowd.update(time, ctx.camera)
  }

  // ------------------------------------------------------------------------------------------------ staff
  /**
   * Pop-in of a staff member from his age: hidden inside the unlock pillar, then up with a stretch that settles.
   * Call it after the model's update(), which may switch the root back on.
   */
  function appear(obj: THREE.Object3D, age: number) {
    const k = (age - APPEAR_DELAY) / APPEAR_TIME
    obj.visible = k > 0
    if (k >= 1) obj.scale.setScalar(1)
    else if (k > 0) obj.scale.set(pop(k, 1.06), pop(k, 1.18), pop(k, 1.06))
  }

  const usher = makeUsher()
  usher.root.visible = false
  root.add(usher.root)
  const usherTrack = newTrack()
  let pointT = 0

  function updateUsher(s: GameState, dt: number, simDt: number, snap: boolean) {
    const u = s.usher
    if (!u.present) {
      usher.root.visible = false
      return
    }
    pointT = u.arrived && (s.gate.wantOpen || walkingIn) ? POINT_HOLD : snap ? 0 : pointT - simDt
    follow(usherTrack, u.x, u.z, simDt, snap)
    usher.root.position.set(u.x, 0, u.z)
    usher.root.rotation.y = u.heading
    usherPose.t = s.time
    usherPose.dt = snap ? 0 : dt
    usherPose.speed = usherTrack.speed
    usherPose.odo = usherTrack.odo
    usherPose.point = pointT > 0 ? 1 : 0
    usherPose.pointDir = headingOf(L.CAULDRON.x - u.x, L.CAULDRON.z - u.z)
    usher.update(usherPose)
    appear(usher.root, u.age)
  }

  const nurses: NurseVis[] = []

  function splash(x: number, y: number, z: number) {
    puff.color = PAL.syringe
    puff.color1 = PAL.syringe
    puff.additive = true
    puff.gravity = 0
    puff.drag = 0
    puff.vx = puff.vy = puff.vz = 0
    puff.x = x
    puff.y = y
    puff.z = z
    puff.tex = 'splash'
    puff.life = 0.2
    puff.size = 0.35
    puff.size1 = 1.1
    puff.alpha = 0.9
    puff.fadeIn = 0.05
    puff.fadeOut = 0.4
    puff.rot = Math.random() * 6.28
    fx.spawn(puff)
    puff.tex = 'dot'
    puff.gravity = 9
    puff.drag = 1.5
    puff.fadeOut = 0.5
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * 6.28
      const sp = 1.2 + Math.random() * 2.2
      puff.vx = Math.cos(a) * sp
      puff.vz = Math.sin(a) * sp
      puff.vy = 1.5 + Math.random() * 2.5
      puff.life = 0.22 + Math.random() * 0.16
      puff.size = 0.1 + Math.random() * 0.1
      puff.size1 = 0.04
      fx.spawn(puff)
    }
  }

  function updateNurses(s: GameState, dt: number, simDt: number, snap: boolean) {
    const ns = s.nurses
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i]!
      let vis = nurses[i]
      const fresh = snap || !vis
      if (!vis) {
        vis = { model: makeNurse(), heading: n.heading, track: newTrack(), treatT: -1, held: false, fromX: 0, fromZ: 0 }
        nurses.push(vis)
        root.add(vis.model.root)
      }
      const bed = s.beds[n.bed]
      const running = n.state === 'running'
      let x = n.x
      let z = n.z
      if (running && n.pathI === 0 && n.age < APPEAR_DELAY) {
        // still on the first leg at full speed since age 0: read back where she started
        const dx = n.path[0]! - x
        const dz = n.path[1]! - z
        const back = (P.NURSE_RUN_SPEED * n.age) / (Math.hypot(dx, dz) || 1)
        vis.fromX = x - dx * back
        vis.fromZ = z - dz * back
        vis.held = true
      }
      if (vis.held) {
        const w = smoothstep(APPEAR_DELAY, APPEAR_DELAY + NURSE_CATCH_UP, n.age)
        x = lerp(vis.fromX, x, w)
        z = lerp(vis.fromZ, z, w)
        vis.held = w < 1 && running
      }
      const track = vis.track
      const dx = x - track.x
      const dz = z - track.z
      follow(track, x, z, simDt, fresh)
      let aim = n.heading
      if (running && track.speed > 1) aim = headingOf(dx, dz)
      else if (!running && bed && bed.state === 'occupied') aim += NURSE_AIM
      vis.heading += angleDelta(vis.heading, aim) * (fresh ? 1 : damp(running ? 18 : 9, dt))
      const m = vis.model
      m.root.position.set(x, 0, z)
      m.root.rotation.y = vis.heading
      const tt = bed && bed.state === 'occupied' ? bed.treatT : -1
      nursePose.t = s.time
      nursePose.dt = fresh ? 0 : dt
      nursePose.speed = Math.min(track.speed, P.NURSE_RUN_SPEED)
      nursePose.odo = track.odo
      nursePose.treatT = tt
      m.update(nursePose)
      appear(m.root, n.age)
      if (!fresh && vis.treatT < SPLASH_AT && tt >= SPLASH_AT && tt < SPLASH_AT + 0.1) {
        m.needleTip.getWorldPosition(_v)
        splash(_v.x, _v.y, _v.z)
      }
      vis.treatT = tt
    }
    for (let i = ns.length; i < nurses.length; i++) nurses[i]!.model.root.visible = false
  }

  const porter = makePorter()
  porter.root.visible = false
  root.add(porter.root)
  const porterTrack = newTrack()

  function updatePorter(s: GameState, dt: number, simDt: number, snap: boolean) {
    const o = s.porter
    if (!o.present) {
      porter.root.visible = false
      return
    }
    follow(porterTrack, o.x, o.z, simDt, snap)
    porter.root.position.set(o.x, 0, o.z)
    porter.root.rotation.y = o.heading
    porterPose.t = s.time
    porterPose.dt = snap ? 0 : dt
    porterPose.speed = porterTrack.speed
    porterPose.odo = porterTrack.odo
    porterPose.load = o.flasks
    porter.update(porterPose)
    appear(porter.root, o.age)
    porter.carry.getWorldPosition(anchors.porterCarry)
    anchors.porterHeading = o.heading
  }

  const driver = makeDriver()
  driver.gripRight = gripR
  driver.seatHeight = CART_SEAT_HEIGHT
  driver.root.visible = false
  const driverHappy = makeBubble('happy', HAPPY_SIZE)
  driverHappy.setScale(0)
  root.add(driver.root, driverHappy.root)
  const driverTrack = newTrack()
  let driverHeading = 0
  let driverEmojiT = HAPPY_TIME

  function updateDriver(s: GameState, dt: number, simDt: number, snap: boolean) {
    const d = s.driver
    if (!d.present) {
      driver.root.visible = false
      driverHappy.setScale(0)
      return
    }
    // The simulation walks him straight to the bench and seats him there. Drawn, he takes off BOARD_DIST short of it,
    // tucks into the seated pose in the air and comes down on the bench at the moment he is seated.
    const seated = d.state !== 'toCart'
    const cart = s.tools[d.tool]
    let u = 0
    let heading = d.heading
    if (!seated) {
      follow(driverTrack, d.x, d.z, simDt, snap)
      if (cart) {
        u = clamp01(1 - Math.hypot(cart.x - d.x, cart.z - d.z) / BOARD_DIST)
        heading += angleDelta(heading, cart.heading) * u
      }
    }
    driverHeading += angleDelta(driverHeading, heading) * (snap ? 1 : damp(HELD_TURN, dt))
    driver.root.position.set(d.x, MOUNT_APEX * Math.sin(Math.PI * u ** MOUNT_SKEW), d.z)
    driver.root.rotation.y = driverHeading
    driverPose.t = s.time
    driverPose.dt = snap ? 0 : dt
    driverPose.seated = seated || u > 0.3
    driverPose.speed = driverTrack.speed
    driverPose.odo = driverTrack.odo
    driver.grip.copy(gripL)
    driver.update(driverPose)
    appear(driver.root, d.age)

    driverEmojiT = snap ? HAPPY_TIME : driverEmojiT + simDt
    const a = driver.headAnchor.position
    driverHappy.root.position.set(d.x + rotX(a.x, a.z, driverHeading), a.y - DRIVER_EMOJI_DROP, d.z + rotZ(a.x, a.z, driverHeading))
    driverHappy.setScale(emojiScale(driverEmojiT, HAPPY_TIME))
  }

  return {
    update(s, dt, time) {
      const simDt = s.time - lastTime
      const snap = lastTime < 0 || simDt < 0 || simDt > 0.5
      lastTime = s.time
      updateLevers(s, dt, simDt, snap)
      updateDoctor(s, dt, snap)
      updateVillagers(s, dt, simDt, snap, time)
      updateUsher(s, dt, simDt, snap)
      updateNurses(s, dt, simDt, snap)
      updatePorter(s, dt, simDt, snap)
      updateDriver(s, dt, simDt, snap)
    },
    onEvent(e: GameEvent) {
      if (e.type === 'emoji' && e.who === 'driver') driverEmojiT = 0
    },
  }
}
