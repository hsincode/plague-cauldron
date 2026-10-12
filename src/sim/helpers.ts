// Helpers bought late in the game (SPEC 2.12). The porter carries flasks from the pile to the pot; the cart
// driver fetches bubbles for the grinder forever. Each appears at its pad when its unlock flag turns true.
import { L, P, UNLOCKS, type UnlockId } from '../config'
import { angleDelta, clamp, dist, dist2, fwdX, fwdZ, headingOf, lerpAngle } from '../core/math'
import { riverPoint, riverSample } from '../world/river'
import { BLADES } from '../world/tools'
import { emit } from './events'
import { depositFlasks, pickupFlasks } from './flasks'
import { followPath } from './npc'
import { stepCartMover } from './player'
import { parkTool } from './tools'
import type { Bubble, Driver, GameState, Porter, Tool } from './types'

const padOf = (id: UnlockId) => UNLOCKS.find(u => u.id === id)!

export function stepHelpers(s: GameState, dt: number) {
  stepPorter(s, dt)
  stepDriver(s, dt)
}

// ---------------------------------------------------------------- porter

const PORTER_PAD = padOf('porter')
/** He stops this close to the flask he walks to; the magnet (FLASK_PICKUP_RADIUS) does the rest. */
const PORTER_REACH = 0.9
/** He stands at home at least this long between two rounds. */
const PORTER_REST = 0.5
/** Collecting ends when nothing has reached him for this long (bridges the gaps of an ejection in progress). */
const PORTER_PATIENCE = 0.4
/** He leaves what the doctor can reach to the doctor, but never for longer than this at a time. */
const PORTER_YIELD_MAX = 1.5
/** Pause after the last throw before he walks home. */
const PORTER_POUR_BEAT = 0.2
/** At a full pot he waits this long, then carries the rest home and tries again later. */
const PORTER_POT_WAIT = 3

function porterGo(p: Porter, state: Porter['state'], x: number, z: number) {
  p.state = state
  p.t = 0
  p.path.length = 2
  p.path[0] = x
  p.path[1] = z
  p.pathI = 0
}

const porterLeavePile = (p: Porter) => {
  if (p.flasks > 0) porterGo(p, 'toPot', L.PORTER_POUR.x, L.PORTER_POUR.z)
  else porterGo(p, 'toHome', L.PORTER_HOME.x, L.PORTER_HOME.z)
}

const potHasRoom = (s: GameState) => s.cauldron.potion + s.cauldron.incoming.length < s.cauldron.capacity

/** Index of the nearest ground flask that has landed, or -1. */
function nearestLandedFlask(s: GameState, x: number, z: number): number {
  const fl = s.groundFlasks
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < fl.length; i++) {
    const f = fl[i]!
    if (f.age < P.FLASK_EJECT_FLIGHT) continue
    const d = dist2(x, z, f.x, f.z)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** The doctor's own pickup always goes first: true while a landed flask is within his reach and he has room. */
function doctorCanReachPile(s: GameState): boolean {
  const pl = s.player
  if (pl.flasks >= P.FLASK_CARRY_MAX) return false
  const r2 = P.FLASK_PICKUP_RADIUS * P.FLASK_PICKUP_RADIUS
  const fl = s.groundFlasks
  for (let i = 0; i < fl.length; i++) {
    const f = fl[i]!
    if (f.age >= P.FLASK_EJECT_FLIGHT && dist2(pl.x, pl.z, f.x, f.z) <= r2) return true
  }
  return false
}

function stepPorter(s: GameState, dt: number) {
  const p = s.porter
  if (!p.present) {
    if (!s.unlocks.porter) return
    p.present = true
    p.x = PORTER_PAD.x
    p.z = PORTER_PAD.z
    p.heading = headingOf(L.PORTER_HOME.x - p.x, L.PORTER_HOME.z - p.z)
    p.age = 0
    p.flasks = 0
    p.pickupAcc = 0
    porterGo(p, 'toHome', L.PORTER_HOME.x, L.PORTER_HOME.z)
    return
  }
  p.age += dt
  p.t += dt
  switch (p.state) {
    case 'idle':
      p.heading = lerpAngle(p.heading, headingOf(L.FLASK_AREA.x - p.x, L.FLASK_AREA.z - p.z), Math.min(1, dt * 8))
      if (p.t < PORTER_REST || !potHasRoom(s)) break
      if (p.flasks < P.PORTER_CARRY && nearestLandedFlask(s, p.x, p.z) >= 0) {
        p.state = 'toPile'
        p.t = 0
      } else if (p.flasks > 0) porterGo(p, 'toPot', L.PORTER_POUR.x, L.PORTER_POUR.z)
      break
    case 'toPile': {
      const i = nearestLandedFlask(s, p.x, p.z)
      if (i < 0) {
        porterLeavePile(p)
        break
      }
      const f = s.groundFlasks[i]!
      if (dist2(p.x, p.z, f.x, f.z) <= PORTER_REACH * PORTER_REACH) {
        p.state = 'collect'
        p.t = 0
        break
      }
      // re-aimed every step: the doctor may take the flask he was walking to
      p.path.length = 2
      p.path[0] = f.x
      p.path[1] = f.z
      p.pathI = 0
      followPath(p, P.PORTER_SPEED, dt)
      break
    }
    case 'collect': {
      // p.t = seconds since a flask last reached him
      const yielding = p.t < PORTER_YIELD_MAX && doctorCanReachPile(s)
      if (!yielding && pickupFlasks(s, p, P.PORTER_CARRY, 'porter', dt)) p.t = 0
      if (p.flasks >= P.PORTER_CARRY) porterGo(p, 'toPot', L.PORTER_POUR.x, L.PORTER_POUR.z)
      else if (!yielding && p.t > PORTER_PATIENCE) {
        const i = nearestLandedFlask(s, p.x, p.z)
        const far = i >= 0 && dist2(p.x, p.z, s.groundFlasks[i]!.x, s.groundFlasks[i]!.z) > P.FLASK_PICKUP_RADIUS * P.FLASK_PICKUP_RADIUS
        if (far) {
          p.state = 'toPile' // more flasks lie out of reach
          p.t = 0
        } else porterLeavePile(p)
      }
      break
    }
    case 'toPot':
      if (followPath(p, P.PORTER_SPEED, dt)) {
        p.state = 'pour'
        p.t = 0
        p.depositT = P.DEPOSIT_DELAY
      }
      break
    case 'pour':
      // p.t = seconds since the deposit last made progress
      p.heading = lerpAngle(p.heading, headingOf(L.CAULDRON.x - p.x, L.CAULDRON.z - p.z), Math.min(1, dt * 12))
      if (depositFlasks(s, p, 'porter', dt)) p.t = 0
      if (p.t > (p.flasks > 0 ? PORTER_POT_WAIT : PORTER_POUR_BEAT)) porterGo(p, 'toHome', L.PORTER_HOME.x, L.PORTER_HOME.z)
      break
    case 'toHome':
      if (followPath(p, P.PORTER_SPEED, dt)) {
        p.state = 'idle'
        p.t = 0
      }
      break
  }
}

// ---------------------------------------------------------------- cart driver
//
// On foot ('toCart') he walks from his pad to the seat. Seated, he is a Mover that only ever moves through
// stepCartMover and whose pose is copied into the cart every step. One cycle:
//   backOff  after a delivery: watch the grinder for a while, then turn round (north about) and drive to his
//            post in the river (also the way there after taking the cart, and the way back when he has strayed)
//   seek     at his post: keep the blade pointed at the next bubble coming down the river until it docks
//   deliver  bubble docked: swing it round to the west and push it along the approach line onto the tray
// Every state has a timeout that leads to another one, so he cannot stay stuck.

const DRIVER_PAD = padOf('driver')
const SPARE_SCOOP = 1
const DRIVER_WALK_SPEED = P.NURSE_RUN_SPEED
/** He appears inside the unlock pillar and runs out of it a moment later (SPEC 9, effect 18). */
const DRIVER_SPAWN_HOLD = 0.2
const DRIVER_TAKE_RADIUS = 0.35
const DRIVER_WALK_TIMEOUT = 10
/** The happy emoji appears this long after a capture (SPEC 2.2), like the doctor's own. */
const HAPPY_DELAY = 0.3

/** Input magnitude for turning (nearly) on the spot: the cart only turns while it is told to move. */
const TURN_MAG = 0.15
const AIM_TOLERANCE = 0.05
/** Within this distance of a goal the speed eases off linearly. */
const EASE_DIST = 2.2

/** East edge of the grinder's accept zone, and the east-west line along which he pushes the bubble in. */
const ACCEPT_X = L.GRINDER[2] + P.GRINDER_ACCEPT_MARGIN
const APPROACH_Z = L.GRINDER[3] - 1.3
const LOOKAHEAD = 3.5
/** While the grinder is busy (or the cycle too young) the bubble is held this far short of the accept zone. */
const HOLD_GAP = 0.8
const DEFAULT_BUBBLE_R = P.BUBBLE_DIAMETER.M / 2
/** Seat x at which a docked bubble of radius r rests on the holding line. */
const holdX = (cart: Tool, r: number) => ACCEPT_X + HOLD_GAP + BLADES[cart.kind].offset + P.DOCK_SEAT * r

/**
 * His post: in the river beside the grinder, just east of the holding line of the biggest bubble. From there,
 * turning a docked bubble round to the west does not reach the accept zone yet, so every delivery ends with a push
 * along the approach line and leaves the cart at the same spot on the bank, whatever happened before.
 */
const POST = { x: ACCEPT_X + HOLD_GAP + P.CART_BLADE_OFFSET + (P.DOCK_SEAT * P.BUBBLE_DIAMETER.L) / 2 + 0.3, z: APPROACH_Z - 0.8 }
const POST_RADIUS = 0.7
/** He goes back to his post when he has strayed this far from it. */
const LEASH = 2.5
/** With no bubble in sight he faces this point on the centreline upstream. */
const UPSTREAM_AIM = riverPoint(Math.max(0, riverSample(POST.x, POST.z).s - 9), 0)
/** Within this distance of his post he only ever turns north about (see steerDir). */
const NEAR_POST = 6

/** He steers for his post this long; if he is still not there he swings wide to one side and starts over. */
const BACKOFF_PURSUE = 8
const BACKOFF_TIMEOUT = 9.5
const DETOUR_ANGLE = 1.75
const DETOUR_MAG = 0.6
const SEEK_TIMEOUT = 20
/**
 * After a delivery he watches the grinder this long before he turns to the river again. Facing the grinder is the
 * only pose in which no bubble can dock, so this is where most of DRIVER_MIN_CYCLE is spent.
 */
const DELIVERY_LINGER = 4.5
/** A new target must still be this far upstream of him (along the river), so that he can turn to face it in time. */
const TARGET_LEAD = 5

/**
 * A bubble that was docked west of its holding line (while he was still turning on the bank) or far from the
 * grinder is first carried to a point this far east of the holding line, on the approach line.
 */
const ENTRY_AHEAD = 1.2
const ENTRY_NORTH = 6.5
const ENTRY_SOUTH = 3.2
const ENTRY_EAST = 3.0
/** "Pointing at the grinder": within this angle of due west. */
const WESTISH = Math.PI / 3
/** A delivery that has not happened after DELIVER_PUSH seconds is retried after backing out to the river. */
const DELIVER_PUSH = 8
/** Still far from the approach line this long after the capture (or the last retry): see swingWide(). */
const DELIVER_SWING = 9.5
const DELIVER_RETRY = 11
/** Where the clock of a retried delivery restarts (past HAPPY_DELAY: one emoji per capture). */
const DELIVER_RESTART = 1

/**
 * North of the grinder the bank is closed off by a boulder row; the cart gets from there to his post along this
 * line, which runs through the gap between the grinder's corner and the first boulder.
 */
const NORTH_LANE = (() => {
  const ax = 9.5
  const az = -8.5
  const len = Math.hypot(POST.x - ax, POST.z - az)
  return { ax, az, dx: (POST.x - ax) / len, dz: (POST.z - az) / len, len }
})()
const NORTH_ZONE_Z = L.GRINDER[1] - 0.5
/** Farther north two conifers close the direct way to that lane; he passes east of them through this point. */
const CONIFER_Z = -10.2
const CONIFER_PASS = { x: 11.2, z: -9.6 }
/**
 * A cart left west or south of the grinder (the doctor can park it at the work-area boundary) cannot get past the
 * grinder's south-east corner; it goes round the north-west one, through this point, and then takes the lane.
 */
const WEST_PASS = { x: L.GRINDER[0] - 1.6, z: NORTH_ZONE_Z - 1.4 }

const setDriverState = (d: Driver, state: Driver['state']) => {
  d.state = state
  d.t = 0
}

function stepDriver(s: GameState, dt: number) {
  const d = s.driver
  if (!d.present) {
    if (s.unlocks.driver) spawnDriver(s, d)
    return
  }
  d.age += dt
  d.t += dt
  const cart = s.tools[d.tool]
  if (!cart) return
  if (d.state === 'toCart') {
    walkToCart(s, d, cart, dt)
    return
  }
  if (cart.holder !== 'driver') takeCart(s, d, cart) // nobody else may end up with his cart

  d.cycleT += dt
  if (cart.bubble >= 0) {
    if (d.state !== 'deliver') {
      d.target = -1
      setDriverState(d, 'deliver') // a capture; the happy emoji follows HAPPY_DELAY later
    } else if (d.t >= HAPPY_DELAY && d.t - dt < HAPPY_DELAY) emit(s, { type: 'emoji', kind: 'happy', who: 'driver' })
  } else if (d.state === 'deliver') {
    if (d.t < HAPPY_DELAY) emit(s, { type: 'emoji', kind: 'happy', who: 'driver' }) // delivered before it was due
    d.cycleT = 0
    setDriverState(d, 'backOff')
  }

  if (d.state === 'seek') driverSeek(s, d, cart, dt)
  else if (d.state === 'deliver') driverDeliver(s, d, cart, dt)
  else driverBackOff(s, d, cart, dt)

  cart.x = d.x
  cart.z = d.z
  cart.heading = d.heading
}

function spawnDriver(s: GameState, d: Driver) {
  d.present = true
  d.state = 'toCart'
  d.t = 0
  d.age = 0
  d.x = DRIVER_PAD.x
  d.z = DRIVER_PAD.z
  d.vx = 0
  d.vz = 0
  d.target = -1
  d.cycleT = P.DRIVER_MIN_CYCLE // nothing delays his first delivery
  const cart = s.tools[d.tool]
  if (cart) {
    d.heading = headingOf(cart.x - d.x, cart.z - d.z)
    if (cart.holder === 'player' || s.player.tool === d.tool) parkTool(s, d.tool)
    cart.armed = false
  }
  const spare = s.tools[SPARE_SCOOP]
  if (spare && !spare.exists) {
    spare.exists = true
    spare.armed = true
    spare.age = 0
    spare.holder = 'none'
    spare.bubble = -1
    spare.x = L.SPARE_SCOOP_REST.x
    spare.z = L.SPARE_SCOOP_REST.z
    spare.heading = L.SPARE_SCOOP_REST.heading
    // a tool appears: the same event (and unlock glow) as the cart taking the place of the first scoop
    emit(s, { type: 'toolSwap', tool: SPARE_SCOOP, kind: spare.kind, x: spare.x, z: spare.z })
  }
}

function takeCart(s: GameState, d: Driver, cart: Tool) {
  if (cart.holder === 'player') parkTool(s, d.tool)
  cart.holder = 'driver'
  cart.armed = false
  d.x = cart.x
  d.z = cart.z
  d.heading = cart.heading
  d.vx = 0
  d.vz = 0
  if (d.state === 'toCart') setDriverState(d, 'backOff')
}

// Scratch result of grinderDetour().
let detourX = 0
let detourZ = 0
const CORNER_OUT = 0.9
const GRINDER_CORNERS = [
  L.GRINDER[0] - CORNER_OUT, L.GRINDER[1] - CORNER_OUT,
  L.GRINDER[2] + CORNER_OUT, L.GRINDER[1] - CORNER_OUT,
  L.GRINDER[2] + CORNER_OUT, L.GRINDER[3] + CORNER_OUT,
  L.GRINDER[0] - CORNER_OUT, L.GRINDER[3] + CORNER_OUT,
]

/** Segment a-b against the grinder rectangle grown by 0.4 (slab test). */
function crossesGrinder(ax: number, az: number, bx: number, bz: number): boolean {
  const x0 = L.GRINDER[0] - 0.4
  const z0 = L.GRINDER[1] - 0.4
  const x1 = L.GRINDER[2] + 0.4
  const z1 = L.GRINDER[3] + 0.4
  const dx = bx - ax
  const dz = bz - az
  let t0 = 0
  let t1 = 1
  if (Math.abs(dx) < 1e-9) {
    if (ax < x0 || ax > x1) return false
  } else {
    const ta = (x0 - ax) / dx
    const tb = (x1 - ax) / dx
    t0 = Math.max(t0, Math.min(ta, tb))
    t1 = Math.min(t1, Math.max(ta, tb))
  }
  if (Math.abs(dz) < 1e-9) {
    if (az < z0 || az > z1) return false
  } else {
    const ta = (z0 - az) / dz
    const tb = (z1 - az) / dz
    t0 = Math.max(t0, Math.min(ta, tb))
    t1 = Math.min(t1, Math.max(ta, tb))
  }
  return t0 <= t1
}

/** When the straight walk a-b would cut through the grinder, picks the corner to walk to first (detourX/Z). */
function grinderDetour(ax: number, az: number, bx: number, bz: number): boolean {
  if (!crossesGrinder(ax, az, bx, bz)) return false
  let best = Infinity
  for (let i = 0; i < 8; i += 2) {
    const cx = GRINDER_CORNERS[i]!
    const cz = GRINDER_CORNERS[i + 1]!
    const first = dist(ax, az, cx, cz)
    if (first < 0.3 || crossesGrinder(ax, az, cx, cz)) continue
    // a corner from which the seat is still hidden only wins when no other corner can be reached
    const cost = first + dist(cx, cz, bx, bz) + (crossesGrinder(cx, cz, bx, bz) ? 100 : 0)
    if (cost < best) {
      best = cost
      detourX = cx
      detourZ = cz
    }
  }
  return best < Infinity
}

function walkToCart(s: GameState, d: Driver, cart: Tool, dt: number) {
  cart.armed = false // reserved for him: the doctor cannot hop back on
  if (d.t < DRIVER_SPAWN_HOLD) return
  const toSeat = dist(d.x, d.z, cart.x, cart.z)
  if (toSeat <= DRIVER_TAKE_RADIUS || d.t > DRIVER_WALK_TIMEOUT) {
    takeCart(s, d, cart)
    return
  }
  let tx = cart.x
  let tz = cart.z
  if (toSeat > 1.5 && grinderDetour(d.x, d.z, tx, tz)) {
    tx = detourX
    tz = detourZ
  }
  const dx = tx - d.x
  const dz = tz - d.z
  const dd = Math.hypot(dx, dz)
  if (dd < 1e-6) return
  const stepLen = Math.min(dd, DRIVER_WALK_SPEED * dt)
  d.vx = (dx / dd) * DRIVER_WALK_SPEED
  d.vz = (dz / dd) * DRIVER_WALK_SPEED
  d.x += (dx / dd) * stepLen
  d.z += (dz / dd) * stepLen
  d.heading = lerpAngle(d.heading, headingOf(dx, dz), Math.min(1, dt * 18))
}

/** The only way he moves the cart. A mover that returns garbage is rolled back instead of poisoning the state. */
function drive(s: GameState, d: Driver, ix: number, iz: number, dt: number) {
  const x = d.x
  const z = d.z
  const h = d.heading
  stepCartMover(s, d, ix, iz, dt)
  if (!(Number.isFinite(d.x) && Number.isFinite(d.z) && Number.isFinite(d.heading) && Number.isFinite(d.vx) && Number.isFinite(d.vz))) {
    d.x = x
    d.z = z
    d.heading = h
    d.vx = 0
    d.vz = 0
  }
}

// Scratch result of steerDir().
let sdx = 0
let sdz = 0
/** A turn is only sent the long way round for goals that do not themselves lie this close to due south. */
const SOUTH_GOAL = 0.5

/**
 * Unit direction to feed the mover so that the cart ends up heading along (ux, uz). With `northAbout` the turn
 * never passes through south: down there the blade would sweep across the stream below his post and catch (or
 * drag) bubbles sideways, over the boulders and the fall. Returns true when it picked the long way round.
 */
function steerDir(d: Driver, ux: number, uz: number, northAbout: boolean): boolean {
  sdx = ux
  sdz = uz
  if (!northAbout) return false
  const want = headingOf(ux, uz) // south is heading 0
  if (Math.abs(want) < SOUTH_GOAL) return false
  const h = angleDelta(0, d.heading)
  const turn = angleDelta(d.heading, want)
  if (!((h > 0 && h + turn < 0) || (h < 0 && h + turn > 0))) return false
  const a = d.heading - Math.sign(turn) * 1.3
  sdx = fwdX(a)
  sdz = fwdZ(a)
  return true
}

/**
 * Steer toward a point. Velocity is always along the heading, so he crawls while pointing away from the goal
 * (which keeps the turn tight) and eases off near it.
 */
function steerTo(s: GameState, d: Driver, tx: number, tz: number, maxMag: number, northAbout: boolean, dt: number) {
  const dx = tx - d.x
  const dz = tz - d.z
  const dd = Math.hypot(dx, dz)
  if (dd < 0.05) {
    drive(s, d, 0, 0, dt)
    return
  }
  const err = Math.abs(angleDelta(d.heading, headingOf(dx, dz)))
  let mag = err > 1.5 ? TURN_MAG : err > 0.6 ? 0.45 : 1
  mag = Math.min(mag, Math.max(TURN_MAG, maxMag), Math.max(TURN_MAG, dd / EASE_DIST))
  if (steerDir(d, dx / dd, dz / dd, northAbout)) mag = TURN_MAG
  drive(s, d, sdx * mag, sdz * mag, dt)
}

/** Turn toward a unit direction, then stand still. */
function faceDir(s: GameState, d: Driver, ux: number, uz: number, northAbout: boolean, dt: number) {
  if (Math.abs(angleDelta(d.heading, headingOf(ux, uz))) <= AIM_TOLERANCE) {
    drive(s, d, 0, 0, dt)
    return
  }
  steerDir(d, ux, uz, northAbout)
  drive(s, d, sdx * TURN_MAG, sdz * TURN_MAG, dt)
}

// Scratch result of passWaypoint().
let wayX = 0
let wayZ = 0

/**
 * From west or south of the grinder, and from the bank north of it, the straight way to his post is closed. True
 * there, with the way-point to steer for instead in wayX/wayZ. Way-points are placed beyond the line that ends
 * their use, so that he cannot end up circling one.
 */
function passWaypoint(d: Driver): boolean {
  const westOfGrinder = d.x < L.GRINDER[0] + 0.3 && d.z > WEST_PASS.z + 0.8
  const southOfGrinder = d.x < L.GRINDER[2] + 0.6 && d.z > L.GRINDER[3] + 0.5
  if (westOfGrinder || southOfGrinder) {
    wayX = WEST_PASS.x
    wayZ = WEST_PASS.z
    return true
  }
  if (d.z >= NORTH_ZONE_Z) return false
  const rs = riverSample(d.x, d.z)
  if (rs.d <= rs.halfW) return false
  // on the bank north of the grinder
  if (d.z < CONIFER_Z) {
    wayX = CONIFER_PASS.x
    wayZ = CONIFER_PASS.z
  } else {
    const along = (d.x - NORTH_LANE.ax) * NORTH_LANE.dx + (d.z - NORTH_LANE.az) * NORTH_LANE.dz
    const u = clamp(along + LOOKAHEAD, 0, NORTH_LANE.len)
    wayX = NORTH_LANE.ax + NORTH_LANE.dx * u
    wayZ = NORTH_LANE.az + NORTH_LANE.dz * u
  }
  return true
}

/** Still not there, so he is probably wedged between two obstacles: swing wide of the goal, to the other side each time. */
function swingWide(s: GameState, d: Driver, tx: number, tz: number, dt: number) {
  const a = headingOf(tx - d.x, tz - d.z) + (Math.floor(d.age / BACKOFF_TIMEOUT) % 2 === 0 ? DETOUR_ANGLE : -DETOUR_ANGLE)
  drive(s, d, fwdX(a) * DETOUR_MAG, fwdZ(a) * DETOUR_MAG, dt)
}

function driverBackOff(s: GameState, d: Driver, cart: Tool, dt: number) {
  if (d.cycleT < DELIVERY_LINGER) {
    drive(s, d, 0, 0, dt)
    d.t = 0 // the timeouts below count from the moment he sets off
    return
  }
  const toPost = dist(d.x, d.z, POST.x, POST.z)
  if (toPost <= POST_RADIUS || d.t > BACKOFF_TIMEOUT) {
    setDriverState(d, 'seek')
    driverSeek(s, d, cart, dt)
    return
  }
  let tx = POST.x
  let tz = POST.z
  let northAbout = toPost < NEAR_POST
  if (passWaypoint(d)) {
    northAbout = false
    tx = wayX
    tz = wayZ
  }
  if (d.t <= BACKOFF_PURSUE) steerTo(s, d, tx, tz, 1, northAbout, dt)
  else swingWide(s, d, tx, tz, dt)
}

function driverSeek(s: GameState, d: Driver, cart: Tool, dt: number) {
  const blade = BLADES[cart.kind]
  const sSeat = riverSample(d.x, d.z).s

  // Keep the bubble he is after while it is still upstream of him; otherwise take the nearest one that is far
  // enough upstream to be faced in time.
  let target: Bubble | null = null
  let fresh: Bubble | null = null
  let freshS = -Infinity
  for (let i = 0; i < s.bubbles.length; i++) {
    const b = s.bubbles[i]!
    if (b.state !== 'drift' || b.r * 2 > blade.maxBubble + 1e-6) continue
    const sb = riverSample(b.x, b.z).s
    if (b.id === d.target && sb < sSeat) target = b
    if (sb + TARGET_LEAD < sSeat && sb > freshS) {
      freshS = sb
      fresh = b
    }
  }
  if (!target) target = fresh
  d.target = target ? target.id : -1

  // The blade axis follows the bubble (every lane passes within the blade's reach of his post), so it docks by itself.
  const ax = (target ? target.x : UPSTREAM_AIM.x) - d.x
  const az = (target ? target.z : UPSTREAM_AIM.z) - d.z
  const al = Math.hypot(ax, az) || 1
  faceDir(s, d, ax / al, az / al, true, dt)

  if (dist2(d.x, d.z, POST.x, POST.z) > LEASH * LEASH || d.t > SEEK_TIMEOUT) setDriverState(d, 'backOff')
}

function driverDeliver(s: GameState, d: Driver, cart: Tool, dt: number) {
  if (d.t > DELIVER_RETRY) d.t = DELIVER_RESTART
  let r = DEFAULT_BUBBLE_R
  for (let i = 0; i < s.bubbles.length; i++) {
    if (s.bubbles[i]!.id === cart.bubble) {
      r = s.bubbles[i]!.r
      break
    }
  }
  const hx = holdX(cart, r)
  // distance the seat may still travel west before the bubble centre reaches the holding line
  const room = d.x - hx
  const westish = Math.abs(angleDelta(d.heading, -Math.PI / 2)) < WESTISH
  const far = d.z < APPROACH_Z - ENTRY_NORTH || d.z > APPROACH_Z + ENTRY_SOUTH || room > ENTRY_EAST
  // A bubble caught (or handed over with the cart) behind the grinder or on the north bank is carried out by the
  // same passes as an empty cart: the straight line to the approach would wedge the cart against the grinder.
  const pass = passWaypoint(d)
  if (pass || d.t > DELIVER_PUSH || far || (room < 0 && !westish)) {
    // Not in position (or the push failed): out to the river side of the holding line. Turning toward the grinder
    // from west of that line would swing the bubble straight onto the tray, from wherever he happens to be.
    const tx = pass ? wayX : hx + ENTRY_AHEAD
    const tz = pass ? wayZ : APPROACH_Z
    if ((pass || far) && d.t > DELIVER_SWING) swingWide(s, d, tx, tz, dt)
    else steerTo(s, d, tx, tz, 1, false, dt)
    return
  }
  const open = s.grinder.state === 'idle' && d.cycleT >= P.DRIVER_MIN_CYCLE
  if (!open && room <= 0.1) drive(s, d, 0, 0, dt) // holding
  else steerTo(s, d, d.x - LOOKAHEAD, APPROACH_Z, open ? 1 : room / EASE_DIST, true, dt)
}
