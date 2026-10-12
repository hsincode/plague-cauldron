// Autopilot: plays the whole game through the same interface as a player (a world-space move direction).
// It reads the state, never writes it; its own memory lives in a WeakMap keyed by the state, so a headless run
// stays deterministic and several states can be driven side by side. The host may call it once per rendered
// frame or once per step: every timer here is in simulated time.
//
// One decision per call, top down:
//   holding a bubble      -> push it onto the grinder
//   on the cart, delivered -> hop off toward the next errand
//   holding an empty tool  -> catch a bubble (a tool can only be put down by delivering)
//   on foot                -> the first errand that applies: pay a pad, tend the pallet, pour, pick up the pile,
//                             release patients at the pen, fetch (walk to the tool), wait by the pallet
// The opening follows the ad (SPEC 3.5): while one of the cheap first pads is about to appear he waits for it by
// the pallet instead of starting a ten-second trip to the river.
//
// Walking goes through the visibility graph of sim/nav.ts; catching a bubble is planned by rolling a small model
// of the tool and the bubbles forward (see "catching"). Every waiting state has a time limit that leads on.
import { L, P, type UnlockId } from '../config'
import { angleDelta, clamp, dist, headingOf } from '../core/math'
import { riverPoint, riverSample } from '../world/river'
import { BLADES } from '../world/tools'
import { freeBedCount } from './beds'
import { cauldronRoom } from './flasks'
import { findPath, pointClear, type NavObstacle } from './nav'
import { BLADE_ARCS, cartBody } from './tools'
import type { Bubble, GameState, Input, Pad, Tool } from './types'

// --- places ----------------------------------------------------------------------------------------------------------

/** Where flasks are poured, unless a manual release comes next: in the deposit radius and the pallet's pickup radius at once, next to pad F. */
const BY_PALLET = { x: 3.9, z: 1.45 }
/** Where he stands about once the bursar empties the pallet: out of its pickup radius. */
const IDLE_LATE = { x: 4.6, z: -1.6 }
/** Where flasks are poured when a manual release comes next: in the deposit radius and the release radius at once. */
const BY_PEN = { x: -2.0, z: -2.9 }
const PILE = L.FLASK_AREA
const [GX0, GZ0, GX1, GZ1] = L.GRINDER
/** The grinder's accept zone (SPEC 2.3), shrunk a little so that "inside" is never a rounding matter. */
const ZONE = { x0: GX0 - P.GRINDER_ACCEPT_MARGIN + 0.1, x1: GX1 + P.GRINDER_ACCEPT_MARGIN - 0.1, z0: GZ0 - P.GRINDER_ACCEPT_MARGIN + 0.1, z1: GZ1 + P.GRINDER_ACCEPT_MARGIN - 0.1 }
/** Never steer a tool closer to the work-area boundary than this: it would be left there. */
const TOOL_MIN_X = P.WORK_AREA_MIN_X + 0.5

/** Arc length of the river level with the grinder. */
const SCOOP_S = riverSample(18.55, -3.0).s
/** The cart catches from about here: every lane passes within the blade's reach, and a swing to the west delivers. */
const CART_HOME = { x: 16.4, z: -2.4 }
/** Blade turned away from the river (north-west): nothing can dock, and the lanes are a short swing away. */
const CART_SAFE = { x: -0.71, z: -0.71 }

// --- tuning ----------------------------------------------------------------------------------------------------------

/** Seconds a fetch, carry and pour costs on top of waiting for the bubble (ranks bubbles: yield per second). */
const SCOOP_OVERHEAD = 8
const CART_OVERHEAD = 10
/** He replans his way this often, and whenever the goal moves. */
const REPLAN = 0.15
/** A pad that is about to appear is waited for this long before he goes back to work. */
const PAD_PATIENCE = 20
/** Standing at the pot with flasks it cannot take: he waits this long for the bath to make room. */
const POUR_PATIENCE = 1.6
/** With an empty tool and no catch for this long he stops being choosy. */
const CATCH_PATIENCE = 25

type Errand = 'none' | 'pay' | 'coins' | 'pour' | 'pile' | 'release' | 'fetch' | 'wait'

interface Mem {
  errand: Errand
  // navigation
  path: number[]
  goalX: number
  goalZ: number
  planT: number
  // stuck detection
  walkT: number
  chkT: number
  chkX: number
  chkZ: number
  stuck: number
  evadeT: number
  evadeX: number
  evadeZ: number
  // catching
  target: number
  /** Scoop plan: when to step off the bank, how far ahead of the bubble (prediction steps), and how far it got. */
  engageAt: number
  lead: number
  engaged: boolean
  facing: boolean
  replanT: number
  /** Tool in his hands at the last call (-1: none) and since when; a new tool resets the plans above. */
  held: number
  toolSince: number
  /** Cart: on the way to the spot it catches from (also with a bubble caught on the way there). */
  goingHome: boolean
  homeSince: number
  carrying: boolean
  carrySince: number
  backOffUntil: number
  // errands
  standPad: UnlockId | ''
  standX: number
  standZ: number
  rearmTool: number
  rearmX: number
  rearmZ: number
  awaitPad: UnlockId | ''
  awaitSince: number
  pourProgressT: number
  pourFlasks: number
}

const mems = new WeakMap<GameState, Mem>()

function memOf(s: GameState): Mem {
  let m = mems.get(s)
  if (!m) {
    m = {
      errand: 'none', path: [], goalX: NaN, goalZ: NaN, planT: -1, walkT: -1, chkT: 0, chkX: s.player.x, chkZ: s.player.z, stuck: 0, evadeT: -1, evadeX: 0, evadeZ: 0,
      target: -1, engageAt: 0, lead: 30, engaged: false, facing: false, replanT: -1, held: -2, toolSince: s.time, goingHome: false, homeSince: 0, carrying: false, carrySince: 0, backOffUntil: -1, standPad: '', standX: 0, standZ: 0, rearmTool: -1, rearmX: 0, rearmZ: 0,
      awaitPad: '', awaitSince: 0, pourProgressT: 0, pourFlasks: 0,
    }
    mems.set(s, m)
  }
  return m
}

const out: Input = { mx: 0, mz: 0 }
const _pt = { x: 0, z: 0 }
const _body = { x: 0, z: 0 }
const obstacles: NavObstacle[] = []
const obstaclePool: NavObstacle[] = []

const setInput = (dx: number, dz: number, mag: number) => {
  const d = Math.hypot(dx, dz)
  if (d < 1e-6 || mag <= 0) {
    out.mx = 0
    out.mz = 0
    return
  }
  out.mx = (dx / d) * mag
  out.mz = (dz / d) * mag
}

// --- reading the game ------------------------------------------------------------------------------------------------

function findBubble(s: GameState, id: number): Bubble | null {
  if (id < 0) return null
  for (let i = 0; i < s.bubbles.length; i++) if (s.bubbles[i]!.id === id) return s.bubbles[i]!
  return null
}

/** The first pad that is not bought yet (pads sell strictly in order). */
function nextPad(s: GameState): Pad | null {
  for (let i = 0; i < s.pads.length; i++) {
    const pad = s.pads[i]!
    if (!s.unlocks[pad.id] && pad.state !== 'done') return pad
  }
  return null
}

/** Potion units that exist anywhere between the river bank and the pot. */
function supply(s: GameState): number {
  const c = s.cauldron
  let n = c.potion + c.incoming.length + s.player.flasks + s.porter.flasks + (s.groundFlasks.length + s.grinder.toEject + s.flaskHalf) / P.GROUND_MESHES_PER_UNIT
  if (s.grinder.state === 'grinding' && s.grinder.t < 0) n += P.FLASK_YIELD[s.grinder.size]
  for (let i = 0; i < s.tools.length; i++) {
    const b = findBubble(s, s.tools[i]!.bubble)
    if (b) n += P.FLASK_YIELD[b.size]
  }
  return n
}

/** Villagers that still need a dose: the crowd and everybody on the way to the pot. */
function toBathe(s: GameState): number {
  let n = s.crowd.remaining
  for (let i = 0; i < s.villagers.length; i++) {
    const st = s.villagers[i]!.state
    if (st === 'toQueue' || st === 'queued' || st === 'preHop' || st === 'hopIn') n++
  }
  return n
}

function lineLength(s: GameState): number {
  let n = 0
  for (let i = 0; i < s.villagers.length; i++) {
    const st = s.villagers[i]!.state
    if (st === 'toQueue' || st === 'queued' || st === 'preHop') n++
  }
  return n
}

/** Gold that is on the pallet or on its way there. */
function palletSoon(s: GameState): number {
  let n = s.pallet.gold
  const inc = s.pallet.incoming
  for (let i = 1; i < inc.length; i += 2) n += inc[i]!
  const f = s.cauldron.fountains
  for (let i = 2; i < f.length; i += 3) n += f[i]!
  return n
}

/** A batch is in the pot, or can start without anything from the doctor. */
function batchComing(s: GameState): boolean {
  const c = s.cauldron
  if (c.bath !== 'empty') return true
  if (c.potion < c.slots * P.POTION_PER_BATHER || freeBedCount(s) < c.slots) return false
  return lineLength(s) > 0 || s.crowd.pendingRelease > 0 || (s.unlocks.usher && s.crowd.remaining > 0)
}

/** The first drill sortie (which makes the usher pad appear) is under way: somebody is being treated or at the drill. */
function sortieComing(s: GameState): boolean {
  if (s.drill.state !== 'parked') return true
  if (!s.swarm.ready) return false
  for (let i = 0; i < s.villagers.length; i++) {
    const v = s.villagers[i]!
    if (v.state === 'toDrill' || v.state === 'atDrill' || v.state === 'pushing') return true
    if ((v.state === 'toBed' || v.state === 'lieDown' || v.state === 'inBed' || v.state === 'cheer' || v.state === 'hopOff') && s.beds[v.bed]?.ward === 1) return true
  }
  return false
}

/**
 * True while the next pad is hidden, will appear by itself shortly and can be paid at once: then it is worth more
 * than a trip to the river (the first pads are cheap and each one multiplies what the yard does).
 */
function padComing(s: GameState, m: Mem): boolean {
  const pad = nextPad(s)
  let coming = false
  if (pad && pad.state === 'hidden') {
    if (pad.id === 'nurses') coming = s.stats.bathed > 0 && s.wallet + palletSoon(s) >= pad.price
    else if (pad.id === 'usher') coming = !s.flags.firstSortiePaid && sortieComing(s)
    else if (pad.id === 'ward2') {
      // the bath is about to stall on the beds (SPEC 3.2): the pad pops the moment the next pair stands ready
      const c = s.cauldron
      coming = s.unlocks.usher && c.potion >= c.slots && freeBedCount(s) < c.slots && lineLength(s) + s.crowd.remaining > 0 && s.wallet + palletSoon(s) >= pad.price
    }
  }
  if (!coming || !pad) {
    m.awaitPad = ''
    return false
  }
  if (m.awaitPad !== pad.id) {
    m.awaitPad = pad.id
    m.awaitSince = s.time
  }
  return s.time - m.awaitSince < PAD_PATIENCE
}

/** The tool the doctor may take: parked, and not the cart the driver owns. */
function freeTool(s: GameState): number {
  for (let i = 0; i < s.tools.length; i++) {
    const t = s.tools[i]!
    if (!t.exists || t.holder !== 'none') continue
    if (s.driver.present && s.driver.tool === i) continue
    return i
  }
  return -1
}

// --- walking ---------------------------------------------------------------------------------------------------------

function addObstacle(x: number, z: number, r: number) {
  let o = obstaclePool[obstacles.length]
  if (!o) o = obstaclePool[obstacles.length] = { x: 0, z: 0, r: 0 }
  o.x = x
  o.z = z
  o.r = r
  obstacles.push(o)
}

/** Cart bodies block him; an armed tool would jump into his hands if he came too close without wanting it. */
function collectObstacles(s: GameState, grabbing: number) {
  obstacles.length = 0
  for (let i = 0; i < s.tools.length; i++) {
    const t = s.tools[i]!
    if (!t.exists) continue
    if (t.kind === 'cart') {
      cartBody(t, _body)
      addObstacle(_body.x, _body.z, P.CART_BODY_RADIUS + P.PLAYER_RADIUS + 0.12)
    }
    if (i !== grabbing && t.holder === 'none' && t.armed) addObstacle(t.x, t.z, BLADES[t.kind].grabRadius + 0.15)
  }
}

/** Seconds without progress before he sidesteps. */
const STUCK_TIME = 0.7
const EVADE_TIME = 0.35

/**
 * Walk (on foot or pushing the scoop) to a point along the planned way; stops within `tol`. Returns true when
 * there. `grabbing` is the tool he means to take (-1: none), which is then not treated as an obstacle.
 */
function walkTo(s: GameState, m: Mem, gx: number, gz: number, tol: number, grabbing = -1): boolean {
  const p = s.player
  const d = dist(p.x, p.z, gx, gz)
  // the watchdog below measures progress while walking: standing somewhere on purpose is not being stuck
  if (d <= tol || s.time - m.walkT > 0.25 || s.time < m.walkT) {
    m.chkT = s.time
    m.chkX = p.x
    m.chkZ = p.z
  }
  m.walkT = s.time
  if (d <= tol) {
    setInput(0, 0, 0)
    return true
  }
  if (s.time < m.evadeT) {
    setInput(m.evadeX, m.evadeZ, 1)
    return false
  }
  // progress watchdog: a wedge between two colliders, or a way that does not exist, ends in a sidestep
  if (s.time - m.chkT >= STUCK_TIME) {
    const moved = dist(p.x, p.z, m.chkX, m.chkZ)
    m.chkT = s.time
    m.chkX = p.x
    m.chkZ = p.z
    if (moved < 0.25) {
      m.stuck++
      const side = m.stuck % 2 === 0 ? 1 : -1
      const dx = (gx - p.x) / d
      const dz = (gz - p.z) / d
      // sideways and a little back, alternating sides, wider every time
      const back = m.stuck % 4 >= 2 ? -0.9 : -0.2
      m.evadeX = -dz * side + dx * back
      m.evadeZ = dx * side + dz * back
      m.evadeT = s.time + EVADE_TIME * Math.min(3, 1 + (m.stuck >> 2))
      m.planT = -1
      setInput(m.evadeX, m.evadeZ, 1)
      return false
    }
    m.stuck = 0
  }
  if (s.time - m.planT >= REPLAN || Math.abs(gx - m.goalX) > 0.05 || Math.abs(gz - m.goalZ) > 0.05 || s.time < m.planT) {
    collectObstacles(s, grabbing)
    findPath(s.unlocks, p.x, p.z, gx, gz, obstacles, m.path)
    m.goalX = gx
    m.goalZ = gz
    m.planT = s.time
  }
  let wx = m.path[0] ?? gx
  let wz = m.path[1] ?? gz
  // a way-point he is standing on is behind him
  if (m.path.length > 2 && dist(p.x, p.z, wx, wz) < 0.3) {
    m.path.splice(0, 2)
    wx = m.path[0]!
    wz = m.path[1]!
  }
  // ease off only for the goal itself: he brakes at 60 m/s2
  const mag = m.path.length <= 2 ? clamp(d / 0.7, 0.15, 1) : 1
  setInput(wx - p.x, wz - p.z, mag)
  return false
}

// --- pads ------------------------------------------------------------------------------------------------------------

const STAND_RADIUS = 1.6

/** A free spot next to a pad from which it is paid (he never stands on the pad, SPEC 2.9), on his side of it. */
function padStand(s: GameState, m: Mem, pad: Pad) {
  const p = s.player
  if (m.standPad === pad.id && pointClear(s.unlocks, m.standX, m.standZ, P.PLAYER_RADIUS + 0.1)) return
  const base = Math.atan2(p.z - pad.z, p.x - pad.x)
  m.standPad = pad.id
  m.standX = pad.x
  m.standZ = pad.z
  for (let k = 0; k < 16; k++) {
    // 0, +1, -1, +2, -2, ... steps of 22.5 degrees away from the direction he comes from
    const a = base + ((k + 1) >> 1) * (k % 2 === 0 ? -1 : 1) * (Math.PI / 8)
    const x = pad.x + Math.cos(a) * STAND_RADIUS
    const z = pad.z + Math.sin(a) * STAND_RADIUS
    if (!pointClear(s.unlocks, x, z, P.PLAYER_RADIUS + 0.15)) continue
    let ok = true
    for (let i = 0; i < s.tools.length && ok; i++) {
      const t = s.tools[i]!
      if (!t.exists) continue
      if (t.kind === 'cart') {
        cartBody(t, _body)
        if (dist(x, z, _body.x, _body.z) < P.CART_BODY_RADIUS + P.PLAYER_RADIUS + 0.3) ok = false
      }
      if (t.holder === 'none' && dist(x, z, t.x, t.z) < BLADES[t.kind].grabRadius + 0.3) ok = false
    }
    if (!ok) continue
    m.standX = x
    m.standZ = z
    return
  }
}

const payable = (s: GameState, pad: Pad | null): pad is Pad =>
  !!pad && (pad.state === 'paying' || ((pad.state === 'idle' || pad.state === 'popIn') && s.wallet >= pad.price - pad.paid))

// --- on foot ---------------------------------------------------------------------------------------------------------

/** Nearest ground flask (landed or still in the air), or null. */
function nearestFlask(s: GameState) {
  const p = s.player
  let best = null
  let bestD = Infinity
  for (let i = 0; i < s.groundFlasks.length; i++) {
    const f = s.groundFlasks[i]!
    const d = dist(p.x, p.z, f.x, f.z)
    if (d < bestD) {
      bestD = d
      best = f
    }
  }
  return best
}

/** A point farther than the tool's re-arm distance from it, on dry ground if possible, close to where he is. */
function rearmPoint(s: GameState, m: Mem, ti: number) {
  const t = s.tools[ti]!
  const p = s.player
  const far = BLADES[t.kind].rearm + 0.45
  if (m.rearmTool === ti && Math.abs(dist(m.rearmX, m.rearmZ, t.x, t.z) - far) < 0.05) return
  m.rearmTool = ti
  let best = Infinity
  m.rearmX = t.x
  m.rearmZ = t.z + far
  if (t.kind === 'cart') cartBody(t, _body)
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2
    const x = t.x + Math.cos(a) * far
    const z = t.z + Math.sin(a) * far
    if (x < TOOL_MIN_X || !pointClear(s.unlocks, x, z, P.PLAYER_RADIUS + 0.15)) continue
    if (t.kind === 'cart' && dist(x, z, _body.x, _body.z) < P.CART_BODY_RADIUS + P.PLAYER_RADIUS + 0.3) continue
    const r = riverSample(x, z)
    // bubbles shove a doctor who stands in their lanes
    const wet = r.d < r.halfW - 0.4 ? 4 : 0
    const cost = dist(p.x, p.z, x, z) + wet
    if (cost < best) {
      best = cost
      m.rearmX = x
      m.rearmZ = z
    }
  }
}

function onFoot(s: GameState, m: Mem) {
  const p = s.player
  const c = s.cauldron
  const pad = nextPad(s)
  const room = cauldronRoom(s)
  const line = lineLength(s)
  const beds = freeBedCount(s)
  const soon = palletSoon(s)
  const needBathed = toBathe(s)
  const have = supply(s)
  const porter = s.porter.present

  // Manual release (SPEC 2.7) only pays while money is what holds the next pad back: once the nurses stand the
  // usher is next, and the doses left are worth more as her first queue (it triggers the cart pad).
  const needIncome = !!pad && s.wallet + soon < pad.price - pad.paid
  const canRelease = !s.unlocks.usher && line === 0 && s.crowd.pendingRelease === 0 && s.crowd.remaining > 0 && beds >= Math.min(c.slots, s.crowd.remaining)
  const releaseNext = canRelease && needIncome && c.potion + c.incoming.length + p.flasks >= c.slots
  const waitingForPad = padComing(s, m)

  // --- should the flasks on his back go to the pot now?
  if (p.flasks !== m.pourFlasks) {
    m.pourFlasks = p.flasks
    m.pourProgressT = s.time
  }
  const spot = releaseNext ? BY_PEN : BY_PALLET
  let pourNow = false
  if (p.flasks > 0) {
    const inRange = dist(p.x, p.z, L.CAULDRON.x, L.CAULDRON.z) <= P.DEPOSIT_RADIUS - 0.2
    if (!inRange) m.pourProgressT = s.time
    // a full pot: wait a moment for the bath to make room, then get on with something else
    const waitHere = room > 0 || (c.bath !== 'empty' && s.time - m.pourProgressT < POUR_PATIENCE)
    // once the porter carries, a few leftovers are poured when he happens to pass the pot
    const worthIt = !porter || p.flasks >= 4 || inRange
    pourNow = worthIt && (room >= Math.min(p.flasks, 3) || (inRange && waitHere))
  }

  // --- pay
  if (payable(s, pad)) {
    padStand(s, m, pad)
    // flasks that can go into the pot on the way do so first
    const pourFirst = pourNow && room >= Math.min(p.flasks, 3) && dist(p.x, p.z, spot.x, spot.z) + 0.5 < dist(p.x, p.z, m.standX, m.standZ)
    if (!pourFirst) {
      m.errand = 'pay'
      if (pad.state === 'paying' && dist(p.x, p.z, pad.x, pad.z) < P.PAD_PAY_RADIUS - 0.3) setInput(0, 0, 0)
      else walkTo(s, m, m.standX, m.standZ, 0.12)
      return
    }
  }

  // --- coins: a visible pad that the pallet can pay for, the pickup that triggers the cart pad, or (in the
  // opening) the income of a batch that will buy the next pad
  if (!s.unlocks.bursar) {
    const short = !!pad && s.wallet < pad.price - pad.paid
    const cartTrigger = s.unlocks.usher && !s.unlocks.cart && !s.flags.pickupAfterUsher
    const opening = !s.unlocks.ward2
    const collect = soon >= 1 && (cartTrigger || (short && (pad!.state !== 'hidden' || opening) && s.wallet + soon >= pad!.price - pad!.paid))
    const camp = opening && batchComing(s) && (cartTrigger || short)
    if (collect || camp) {
      m.errand = 'coins'
      walkTo(s, m, BY_PALLET.x, BY_PALLET.z, 0.15)
      return
    }
  }

  // --- the pile (the porter takes it over once he is there)
  const flasksComing = s.grinder.state === 'grinding' && (s.grinder.t < P.FLASK_EJECT_START || s.grinder.toEject > 0)
  if (!porter && p.flasks < P.FLASK_CARRY_MAX && (s.groundFlasks.length > 0 || flasksComing)) {
    m.errand = 'pile'
    const f = nearestFlask(s)
    if (!f) walkTo(s, m, PILE.x, PILE.z, 0.3)
    else {
      // stand in the middle of what is left; flasks out of reach from there are fetched one by one
      let cx = 0
      let cz = 0
      for (let i = 0; i < s.groundFlasks.length; i++) {
        cx += s.groundFlasks[i]!.x
        cz += s.groundFlasks[i]!.z
      }
      cx /= s.groundFlasks.length
      cz /= s.groundFlasks.length
      const atCentre = dist(p.x, p.z, cx, cz) < 0.35
      if (atCentre && !flasksComing) walkTo(s, m, f.x, f.z, 0.5)
      else walkTo(s, m, cx, cz, 0.25)
    }
    return
  }

  // --- pour
  if (pourNow) {
    m.errand = 'pour'
    walkTo(s, m, spot.x, spot.z, 0.15)
    return
  }

  // --- manual release
  if (canRelease && c.potion >= c.slots * P.POTION_PER_BATHER && (needIncome || !waitingForPad)) {
    m.errand = 'release'
    walkTo(s, m, BY_PEN.x, BY_PEN.z, 0.15)
    return
  }

  // --- fetch
  const want = Math.min(needBathed, c.capacity + (s.unlocks.ward2 ? 8 : 0))
  const ti = freeTool(s)
  // (once on his way he keeps going while anything at all is missing: no turning back at every flask that lands)
  if (ti >= 0 && !waitingForPad && have + (m.errand === 'fetch' ? 1 : 3) <= want) {
    const t = s.tools[ti]!
    m.errand = 'fetch'
    if (!t.armed) {
      rearmPoint(s, m, ti)
      walkTo(s, m, m.rearmX, m.rearmZ, 0.1, ti)
    } else if (t.kind === 'cart') {
      // from behind the bench: the wagon body is in the way from the front
      walkTo(s, m, t.x - Math.sin(t.heading) * 0.7, t.z - Math.cos(t.heading) * 0.7, 0.1, ti)
    } else {
      walkTo(s, m, Math.max(t.x, TOOL_MIN_X - 0.3), t.z, 0.1, ti)
    }
    return
  }

  // --- nothing to do: by the pallet, where the next coins and most pads are close (once the bursar collects, a
  // few steps away from it: the coins are his)
  m.errand = 'wait'
  if (porter && ti >= 0 && have < needBathed) {
    // the porter carries now, so the river is the doctor's whole job: he waits where the next fetch starts
    rearmPoint(s, m, ti)
    walkTo(s, m, m.rearmX, m.rearmZ, 0.3)
    return
  }
  const rest = s.unlocks.bursar ? IDLE_LATE : BY_PALLET
  walkTo(s, m, rest.x, rest.z, 0.2)
}

// --- catching --------------------------------------------------------------------------------------------------------

const fits = (b: Bubble, tool: Tool) => b.r * 2 <= BLADES[tool.kind].maxBubble + 1e-6

// The hand scoop among the bubbles is planned by simulation: a small model of the doctor (the scoop kinematics of
// SPEC 2.1) and of every drifting bubble (straight down its lane, shoving him as river.ts does) is rolled forward
// for each candidate - which bubble, how long to wait on the bank first, how far ahead of the bubble to step into
// its lane - and the plan that puts the most flasks per second into the blade is carried out. Oversize bubbles
// carry him down the river (SPEC 2.3), so a plan that touches one is no plan; the ones that fit only nudge him
// when they brush a blade tip, but bulldoze him when they meet the blade from the side.

const H_DT = 1 / 30
/** Planning horizon in steps (5 s: a bubble crosses the visible river in under 4). */
const H_STEPS = 150
/** Predicted positions go this much further, for the point he walks to ahead of the bubble. */
const H_EXTRA = 60
const H_ROW = H_STEPS + H_EXTRA + 1
const MAX_PRED = 8
const predX = new Float32Array(MAX_PRED * H_ROW)
const predZ = new Float32Array(MAX_PRED * H_ROW)
const predR = new Float32Array(MAX_PRED)
const predFits = new Uint8Array(MAX_PRED)
/** Prediction steps at which the bubble enters and leaves the stretch of river open to the yard. */
const predLo = new Int32Array(MAX_PRED)
const predHi = new Int32Array(MAX_PRED)
const predBubble: (Bubble | null)[] = new Array(MAX_PRED).fill(null)
let predN = 0
/** He meets bubbles between these latitudes: the bank is open there (boulders north and south of it). */
const MEET_Z0 = -5.6
const MEET_Z1 = 0.4
/** How far downstream of the bubble he enters its lane, in prediction steps (0.7-1.7 s of drift). */
const LEADS = [21, 26, 32, 40, 50]
const WAIT_STEP = 0.1
const WAIT_MAX = 2.6
const SCOOP_ARC = BLADE_ARCS.scoop
const SCOOP_DOCK_LX = BLADES.scoop.chord / 2 - 0.2
const SCOOP_TURN = P.SCOOP_TURN_RATE
/** As in river.ts: a bubble moves him at most this far out of its way per step. */
const SHOVE_MAX = 0.5

function predictBubbles(s: GameState, tool: Tool) {
  predN = 0
  for (let i = 0; i < s.bubbles.length && predN < MAX_PRED; i++) {
    const b = s.bubbles[i]!
    if (b.state !== 'drift') continue
    const r = riverSample(b.x, b.z)
    const sb = r.s
    const db = r.d
    const row = predN * H_ROW
    let lo = -1
    let hi = -1
    for (let k = 0; k < H_ROW; k++) {
      riverPoint(sb + P.BUBBLE_SPEED * k * H_DT, db, _pt)
      predX[row + k] = _pt.x
      predZ[row + k] = _pt.z
      if (lo < 0 && _pt.z >= MEET_Z0) lo = k
      if (hi < 0 && _pt.z > MEET_Z1) hi = k
    }
    predLo[predN] = lo < 0 ? H_ROW - 1 : lo
    predHi[predN] = hi < 0 ? H_ROW - 1 : Math.max(0, hi - 1)
    predR[predN] = b.r
    predFits[predN] = fits(b, tool) ? 1 : 0
    predBubble[predN] = b
    predN++
  }
}

/** Results of the last rollout besides its return value: which bubble docked, and how far he was shoved about. */
let rollDock = -1
let rollShoved = 0

/**
 * Roll a plan forward: hold on the bank for `wait` seconds, then walk to the point `lead` steps of drift ahead of
 * bubble j in its lane, turn to face it and let it come. Returns the time at which a bubble docks (rollDock says
 * which: another one that fits may get there first), or -1 when nothing does or an oversize one touches him.
 */
function rollout(j: number, wait: number, lead: number, facing: boolean, x: number, z: number, h: number, v: number, bankX: number, bankZ: number): number {
  rollDock = -1
  rollShoved = 0
  const row = j * H_ROW
  const lo = predLo[j]!
  const hi = predHi[j]!
  for (let k = 0; k < H_STEPS; k++) {
    const t = k * H_DT
    // --- the controller (mirrored by engage() below)
    let ix = 0
    let iz = 0
    let mag = 0
    if (t < wait) {
      ix = bankX - x
      iz = bankZ - z
      const d = Math.hypot(ix, iz)
      mag = d < 0.3 ? 0 : Math.min(1, d / 1.0)
    } else {
      if (k > hi) return -1 // it has left the open stretch
      const at = row + clamp(k + lead, lo, hi)
      const ax = predX[at]! - x
      const az = predZ[at]! - z
      if (!facing && ax * ax + az * az <= 0.36) facing = true
      if (!facing) {
        ix = ax
        iz = az
        mag = 1
      } else {
        ix = predX[row + k]! - x
        iz = predZ[row + k]! - z
        const away = Math.hypot(ix, iz)
        const err = Math.abs(angleDelta(h, headingOf(ix, iz)))
        mag = away > 4.5 ? (err < 0.1 ? 0 : 0.12) : 0.45
      }
    }
    // --- scoop kinematics
    let target = 0
    if (mag > 0) {
      const want = headingOf(ix, iz)
      h += clamp(angleDelta(h, want), -SCOOP_TURN * H_DT, SCOOP_TURN * H_DT)
      target = P.PLAYER_SPEED * mag * Math.max(0.25, Math.cos(angleDelta(h, want)))
    }
    const dv = (target >= v ? P.PLAYER_ACCEL : P.PLAYER_DECEL) * H_DT
    v = Math.abs(target - v) <= dv ? target : v + Math.sign(target - v) * dv
    const sn = Math.sin(h)
    const c = Math.cos(h)
    x += sn * v * H_DT
    z += c * v * H_DT
    if (x < TOOL_MIN_X) return -1
    // --- bubbles against the blade and the doctor, as in river.ts
    for (let o = predN - 1; o >= 0; o--) {
      const ox = predX[o * H_ROW + k + 1]!
      const oz = predZ[o * H_ROW + k + 1]!
      if (oz >= L.CLIFF_Z) continue
      const r = predR[o]!
      let dx = ox - x
      let dz = oz - z
      const reach = r + 2.3
      if (dx * dx + dz * dz > reach * reach) continue
      const lx = dx * c - dz * sn
      const lz = dx * sn + dz * c
      const rz = lz - SCOOP_ARC.cz
      const rho = Math.hypot(lx, rz)
      let qx: number
      let qz: number
      if (rho > 1e-6 && -rz >= rho * SCOOP_ARC.cosHalf) {
        qx = (lx / rho) * SCOOP_ARC.R
        qz = SCOOP_ARC.cz + (rz / rho) * SCOOP_ARC.R
      } else {
        qx = lx >= 0 ? SCOOP_ARC.tipX : -SCOOP_ARC.tipX
        qz = SCOOP_ARC.tipZ
      }
      const gap = Math.hypot(qx - lx, qz - lz)
      const over = r + P.BLADE_THICKNESS / 2 - gap
      if (over > 0) {
        if (!predFits[o]) return -1
        if ((rho < SCOOP_ARC.R || lz > SCOOP_ARC.tipZ) && Math.abs(lx) <= SCOOP_DOCK_LX) {
          rollDock = o
          return t + H_DT
        }
        const push = Math.min(over, SHOVE_MAX)
        if (gap > 1e-6) {
          const nx = (qx - lx) / gap
          const nz = (qz - lz) / gap
          x += (nx * c + nz * sn) * push
          z += (-nx * sn + nz * c) * push
        }
        rollShoved += push
        dx = ox - x
        dz = oz - z
      } else if (!predFits[o] && over > -0.25) return -1 // too close to one that would carry him off
      const d = Math.hypot(dx, dz)
      const body = r + P.PLAYER_RADIUS - d
      if (body > 0) {
        if (!predFits[o]) return -1
        const push = Math.min(body, SHOVE_MAX)
        if (d > 1e-6) {
          x -= (dx / d) * push
          z -= (dz / d) * push
        }
        rollShoved += push
      }
    }
  }
  return -1
}

/** Flasks per second of the plan just rolled out; being shoved about makes the model less trustworthy. */
const planScore = (t: number, j: number) => {
  const b = predBubble[rollDock]!
  return ((P.FLASK_YIELD[b.size] / (t + SCOOP_OVERHEAD)) * (rollDock === j ? 1 : 0.9)) / (1 + 0.35 * rollShoved)
}

/** Carry out the plan: the same controller as in rollout(), on the real doctor. */
function engage(s: GameState, m: Mem, j: number) {
  const p = s.player
  const row = j * H_ROW
  const at = row + clamp(m.lead, predLo[j]!, predHi[j]!)
  const ax = predX[at]! - p.x
  const az = predZ[at]! - p.z
  if (!m.facing && ax * ax + az * az <= 0.36) m.facing = true
  if (!m.facing) {
    setInput(ax, az, 1)
    return
  }
  const ix = predX[row]! - p.x
  const iz = predZ[row]! - p.z
  const away = Math.hypot(ix, iz)
  const err = Math.abs(angleDelta(p.heading, headingOf(ix, iz)))
  setInput(ix, iz, away > 4.5 ? (err < 0.1 ? 0 : 0.12) : 0.45)
}

function scoopCatch(s: GameState, m: Mem, tool: Tool) {
  const p = s.player
  const choosy = s.time - m.toolSince < CATCH_PATIENCE
  predictBubbles(s, tool)
  const speed = Math.hypot(p.vx, p.vz)

  // Where he waits: on the bank, clear of whatever any lane can still bring past (blade included).
  const bankZ = clamp(p.z, MEET_Z0 + 0.6, MEET_Z1 - 1.2)
  const edge = riverSample(18.5, bankZ)
  const bankS = edge.s
  let bankX = riverPoint(bankS, edge.halfW, _pt).x - 0.6
  for (let o = 0; o < predN; o++) {
    const b = predBubble[o]!
    if (b.z - b.r > bankZ + 2.5) continue
    bankX = Math.min(bankX, riverPoint(bankS, riverSample(b.x, b.z).d, _pt).x - b.r - 2.3)
  }
  bankX = Math.max(bankX, GX1 + 1.4)

  let j = -1
  for (let o = 0; o < predN; o++) if (predBubble[o]!.id === m.target) j = o
  if (j < 0) m.engaged = false
  if (s.time >= m.replanT || s.time < m.replanT - 1) {
    m.replanT = s.time + 0.1
    // an engagement that still ends with a catch is kept: changing plans half-way is how he gets bulldozed
    let keep = false
    if (m.engaged && j >= 0) keep = rollout(j, 0, m.lead, m.facing, p.x, p.z, p.heading, speed, bankX, bankZ) >= 0
    if (!keep) {
      m.engaged = false
      m.facing = false
      m.target = -1
      j = -1
      let bestScore = 0
      for (let o = 0; o < predN; o++) {
        if (!predFits[o]) continue
        for (let li = 0; li < LEADS.length; li++) {
          for (let wait = 0; wait <= WAIT_MAX; wait += WAIT_STEP) {
            const t = rollout(o, wait, LEADS[li]!, false, p.x, p.z, p.heading, speed, bankX, bankZ)
            if (t < 0) continue
            const score = planScore(t, o)
            if (score > bestScore) {
              bestScore = score
              j = o
              m.target = predBubble[o]!.id
              m.lead = LEADS[li]!
              m.engageAt = s.time + wait
            }
          }
        }
      }
      if (j < 0 && !choosy) {
        // no gap for a long time: take the next one that fits, whatever is around it
        let nearest = Infinity
        for (let o = 0; o < predN; o++) {
          const b = predBubble[o]!
          const d = dist(p.x, p.z, b.x, b.z)
          if (predFits[o] && b.z < p.z - 4 && d < nearest) {
            nearest = d
            j = o
            m.target = b.id
            m.lead = LEADS[2]!
            m.engageAt = s.time
          }
        }
      }
    }
  }

  if (j >= 0 && s.time >= m.engageAt - 1e-6) {
    m.engaged = true
    engage(s, m, j)
    return
  }
  m.engaged = false
  m.facing = false
  const d = dist(p.x, p.z, bankX, bankZ)
  if (d < 0.3) setInput(0, 0, 0)
  else if (p.x > GX1 + 1.2 && p.z > MEET_Z0 - 1 && p.z < MEET_Z1 + 1) setInput(bankX - p.x, bankZ - p.z, Math.min(1, d / 1.0))
  else walkTo(s, m, bankX, bankZ, 0.3)
}

/** The smallest input the cart still turns for: it creeps along its heading meanwhile, and that drift adds up. */
const CART_TURN_MAG = 0.06

/** Input that turns the cart toward a unit direction nearly on the spot (it only turns while told to move). */
function cartFace(s: GameState, ux: number, uz: number) {
  if (Math.abs(angleDelta(s.player.heading, headingOf(ux, uz))) <= 0.04) setInput(0, 0, 0)
  else setInput(ux, uz, CART_TURN_MAG)
}

/** Drive the cart toward a point: crawl while pointing away from it (a tight turn), ease off near it. */
function cartSteer(s: GameState, tx: number, tz: number) {
  const p = s.player
  const dx = tx - p.x
  const dz = tz - p.z
  const d = Math.hypot(dx, dz)
  if (d < 0.1) {
    setInput(0, 0, 0)
    return
  }
  const err = Math.abs(angleDelta(p.heading, headingOf(dx, dz)))
  const mag = Math.min(err > 1.5 ? 0.15 : err > 0.6 ? 0.45 : 1, Math.max(0.15, d / 2.2))
  setInput(dx, dz, mag)
}

/** The way home is given up after this long (the cart then works from where it stands). */
const HOME_PATIENCE = 8
const inCartHome = (x: number, z: number) => x >= CART_HOME.x - 1.8 && x <= CART_HOME.x + 1.8 && Math.abs(z - CART_HOME.z) <= 2.2
/** Driving home from the grinder side takes about this long; the blade meets whatever is then at this arc length. */
const CART_TRIP_TIME = 1.7
const CART_TRIP_S = riverSample(18.8, -6.5).s - P.BUBBLE_SPEED * CART_TRIP_TIME
const CART_ARC = BLADE_ARCS.cart
const CART_DOCK_LX = BLADES.cart.chord / 2 - 0.2
const CART_SAFE_H = headingOf(CART_SAFE.x, CART_SAFE.z)
/** The cart creeps at this speed while it turns on the spot (see cartFace). */
const CART_CREEP = P.CART_SPEED * CART_TURN_MAG
/** The blade is aimed a little ahead of the bubble (prediction steps). */
const CART_AIM_LEAD = 4
const CART_WAIT_STEP = 0.15
const CART_WAIT_MAX = 2.7

/**
 * The cart's turn at planning by simulation (see the hand scoop above): keep the blade turned away for `wait`
 * seconds, then let its axis follow bubble j. Nothing shoves a cart and every size docks, so the only question is
 * which bubble meets the concave face first (rollDock) and when (the return value; -1: none within the horizon).
 */
function cartRoll(j: number, wait: number, x: number, z: number, h: number): number {
  rollDock = -1
  const row = j * H_ROW
  const maxTurn = P.CART_TURN_RATE * H_DT
  for (let k = 0; k < H_STEPS; k++) {
    const want = k * H_DT < wait ? CART_SAFE_H : headingOf(predX[row + k + CART_AIM_LEAD]! - x, predZ[row + k + CART_AIM_LEAD]! - z)
    const dh = angleDelta(h, want)
    h += clamp(dh, -maxTurn, maxTurn)
    const sn = Math.sin(h)
    const c = Math.cos(h)
    if (Math.abs(dh) > 0.04) {
      x += sn * CART_CREEP * H_DT
      z += c * CART_CREEP * H_DT
    }
    for (let o = predN - 1; o >= 0; o--) {
      const ox = predX[o * H_ROW + k + 1]!
      const oz = predZ[o * H_ROW + k + 1]!
      if (oz >= L.CLIFF_Z) continue
      const r = predR[o]!
      const dx = ox - x
      const dz = oz - z
      const reach = r + 5.5
      if (dx * dx + dz * dz > reach * reach) continue
      const lx = dx * c - dz * sn
      const lz = dx * sn + dz * c
      const rz = lz - CART_ARC.cz
      const rho = Math.hypot(lx, rz)
      let qx: number
      let qz: number
      if (rho > 1e-6 && -rz >= rho * CART_ARC.cosHalf) {
        qx = (lx / rho) * CART_ARC.R
        qz = CART_ARC.cz + (rz / rho) * CART_ARC.R
      } else {
        qx = lx >= 0 ? CART_ARC.tipX : -CART_ARC.tipX
        qz = CART_ARC.tipZ
      }
      if (r + P.BLADE_THICKNESS / 2 - Math.hypot(qx - lx, qz - lz) <= 0) continue
      if ((rho < CART_ARC.R || lz > CART_ARC.tipZ) && Math.abs(lx) <= CART_DOCK_LX) {
        rollDock = o
        return (k + 1) * H_DT
      }
    }
  }
  return -1
}

function cartCatch(s: GameState, m: Mem, tool: Tool) {
  const p = s.player
  const patient = s.time - m.toolSince < CATCH_PATIENCE
  if (inCartHome(p.x, p.z)) m.goingHome = false
  else if (!m.goingHome) {
    // The way home points the blade at the river, and the first bubble to meet it docks. So he sets off when
    // that one is worth having: the bubble that will be level with the blade when he gets there.
    let first: Bubble | null = null
    let firstS = -Infinity
    for (let i = 0; i < s.bubbles.length; i++) {
      const b = s.bubbles[i]!
      if (b.state !== 'drift') continue
      const sb = riverSample(b.x, b.z).s
      if (sb <= CART_TRIP_S && sb > firstS) {
        firstS = sb
        first = b
      }
    }
    if (!patient || s.time - m.toolSince > 5 || (first && first.size !== 'S')) {
      m.goingHome = true
      m.homeSince = s.time
    } else {
      cartFace(s, CART_SAFE.x, CART_SAFE.z)
      return
    }
  }
  // (a cart that cannot get home - wedged somewhere - catches from where it stands, and after a long time with
  // nothing caught drives into the river: there the blade meets a bubble whatever else is wrong)
  if (s.time - m.toolSince > 2 * CATCH_PATIENCE) {
    cartSteer(s, riverPoint(SCOOP_S, 0, _pt).x, _pt.z)
    return
  }
  if (m.goingHome && s.time - m.homeSince < HOME_PATIENCE) {
    cartSteer(s, CART_HOME.x, CART_HOME.z)
    return
  }

  predictBubbles(s, tool)
  let j = -1
  for (let o = 0; o < predN; o++) if (predBubble[o]!.id === m.target) j = o
  if (j < 0) m.engaged = false
  if (s.time >= m.replanT || s.time < m.replanT - 1) {
    m.replanT = s.time + 0.1
    // a blade that is already following its bubble keeps doing so while that still ends with it docked
    let keep = false
    if (m.engaged && j >= 0) keep = cartRoll(j, 0, p.x, p.z, p.heading) >= 0 && rollDock === j
    if (!keep) {
      m.engaged = false
      m.target = -1
      j = -1
      let bestScore = 0
      const overhead = s.porter.present ? CART_OVERHEAD / 2 : CART_OVERHEAD
      for (let o = 0; o < predN; o++) {
        for (let wait = 0; wait <= CART_WAIT_MAX; wait += CART_WAIT_STEP) {
          const t = cartRoll(o, wait, p.x, p.z, p.heading)
          if (t < 0) continue
          // without patience: whatever docks soonest
          const score = patient ? P.FLASK_YIELD[predBubble[rollDock]!.size] / (t + overhead) : 1 / (t + 0.1)
          if (score > bestScore) {
            bestScore = score
            j = o
            m.target = predBubble[o]!.id
            m.engageAt = s.time + wait
          }
        }
      }
    }
  }
  if (j >= 0 && s.time >= m.engageAt - 1e-6) {
    m.engaged = true
    const at = j * H_ROW + CART_AIM_LEAD
    cartFace(s, predX[at]! - p.x, predZ[at]! - p.z)
  } else {
    m.engaged = false
    cartFace(s, CART_SAFE.x, CART_SAFE.z)
  }
}

// --- delivering ------------------------------------------------------------------------------------------------------

const DELIVER_PATIENCE = 16

function deliver(s: GameState, m: Mem, tool: Tool) {
  const p = s.player
  const b = findBubble(s, tool.bubble)
  const r = b ? b.r : P.BUBBLE_DIAMETER.M / 2
  const reach = BLADES[tool.kind].offset + P.DOCK_SEAT * r
  const bx = p.x + Math.sin(p.heading) * reach
  const bz = p.z + Math.cos(p.heading) * reach
  if (bx >= ZONE.x0 && bx <= ZONE.x1 && bz >= ZONE.z0 && bz <= ZONE.z1) {
    // on the tray's doorstep: the grinder takes it as soon as it is idle
    setInput(0, 0, 0)
    return
  }
  // a push that has not ended on the tray after a long time is started over from the river side
  if (s.time - m.carrySince > DELIVER_PATIENCE) {
    m.carrySince = s.time
    m.backOffUntil = s.time + 2.5
  }
  const backOff = s.time < m.backOffUntil
  // push it west along a line that crosses the tray; the driver's cart works the south half once he is there
  const lineZ = s.driver.present ? -4.9 : clamp(p.z, tool.kind === 'cart' ? -4.2 : -4.6, -1.2)
  const standX = ZONE.x1 + reach - 0.25
  if (tool.kind === 'cart') {
    // A bubble caught on the way home is carried there first: delivered from the grinder side, the cart would
    // stay parked where no lane is within the blade's reach.
    if (p.x >= CART_HOME.x - 0.4 || s.time - m.homeSince > HOME_PATIENCE) m.goingHome = false
    if (m.goingHome || backOff) cartSteer(s, CART_HOME.x + 0.6, CART_HOME.z)
    else cartSteer(s, Math.min(p.x - 3.5, standX - 1), lineZ)
    return
  }
  const ahead = Math.max(standX - 1.5, p.x - 3)
  if ((Math.abs(p.z - lineZ) > 2.5 && p.x < standX + 2.5) || backOff) {
    // beside or behind the tray: out to the east of it first
    walkTo(s, m, standX + 2.6, lineZ, 0.4)
    return
  }
  setInput(ahead - p.x, lineZ - p.z, 1)
}

// --- main ------------------------------------------------------------------------------------------------------------

export function botInput(s: GameState): Input {
  const m = memOf(s)
  const p = s.player
  setInput(0, 0, 0)
  if (s.won || p.mountT > 0 || p.dismountT > 0) return out

  const held = p.mode === 'foot' ? -1 : p.tool
  if (m.held !== held) {
    m.held = held
    m.toolSince = s.time
    m.target = -1
    m.engaged = false
    m.facing = false
    m.replanT = -1
    m.goingHome = false
    m.carrying = false
    m.planT = -1
  }
  const tool = held >= 0 ? s.tools[held] : undefined
  if (!tool) {
    onFoot(s, m)
    return out
  }
  if (tool.bubble !== -1) {
    m.errand = 'none'
    // decided once, at the catch: the swing itself moves the seat about
    if (!m.carrying) {
      m.goingHome = tool.kind === 'cart' && p.x < CART_HOME.x - 1.1
      m.homeSince = s.time
      m.carrySince = s.time
    }
    m.carrying = true
    m.toolSince = s.time
    deliver(s, m, tool)
  } else if (p.mode === 'cart' && p.dismountPending) {
    // delivered: the first input makes him hop off, to the side it points at; point at where he goes next
    m.carrying = false
    onFoot(s, m)
    if (out.mx === 0 && out.mz === 0) setInput(0, 1, 1)
    else setInput(out.mx, out.mz, 1)
  } else {
    m.carrying = false
    if (tool.kind === 'cart') cartCatch(s, m, tool)
    else scoopCatch(s, m, tool)
  }
  return out
}

/** For tests and the debug overlay: what the autopilot is doing. */
export function botErrand(s: GameState): string {
  const m = mems.get(s)
  if (!m) return 'none'
  const p = s.player
  if (p.mode !== 'foot') return s.tools[p.tool]?.bubble !== -1 ? 'deliver' : 'catch'
  return m.errand
}
