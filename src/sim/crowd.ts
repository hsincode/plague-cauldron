// Crowd side of the bath (SPEC 2.7): the pen gate, the manual release, the usher and the queue at the cauldron.
// Villagers in the states toQueue / queued are moved here; sim/bath.ts takes them over when a batch starts.
import { L, P, UNLOCKS } from '../config'
import { approach, damp, dist2, headingOf, lerpAngle } from '../core/math'
import { rand } from '../core/rng'
import { CROWD_SLOTS } from '../world/crowd'
import { freeBedCount } from './beds'
import { emit } from './events'
import { followPath, pathDone } from './npc'
import type { GameState, Villager } from './types'

const USHER_PAD = UNLOCKS.find(u => u.id === 'usher')!
/** The usher stays inside the unlock light pillar this long before she runs to her post (SPEC 9, effect 18). */
const USHER_APPEAR = 0.2
const TURN_RATE = 14

export const queueMax = (s: GameState) => (s.unlocks.bigCauldron ? P.QUEUE_MAX_BIG : P.QUEUE_MAX)
/** The ad's line of four ends at the pen bay; the big cauldron's extra places (L.QUEUE_REAR) turn along the fence. */
const rearSlot = (i: number) => L.QUEUE_REAR[Math.min(i - P.QUEUE_MAX, L.QUEUE_REAR.length - 1)]!
export const queueSlotX = (i: number) => (i < P.QUEUE_MAX ? L.QUEUE_SLOT0.x + i * L.QUEUE_STEP.x : rearSlot(i).x)
export const queueSlotZ = (i: number) => (i < P.QUEUE_MAX ? L.QUEUE_SLOT0.z + i * L.QUEUE_STEP.z : rearSlot(i).z)

// Scratch: the new slot of each villager, by index in s.villagers.
const newSlot: number[] = []

export function stepCrowd(s: GameState, dt: number) {
  stepUsher(s, dt)
  // Bathers that have not leapt yet still stand in their queue slots: the line behind them holds its place.
  let line = 0
  let hold = 0
  const vs = s.villagers
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i]!
    if (v.state === 'toQueue' || v.state === 'queued') line++
    else if (v.state === 'preHop' && v.slot >= hold) hold = v.slot + 1
  }
  // Gaps are closed before anybody is let out: the newcomer's slot (hold + line) is then the one behind the last
  // villager of the line. Assigned the other way round he would take a slot ahead of people still standing in
  // the rear slots and jump the queue.
  closeGaps(s, hold)
  stepRelease(s, dt, hold, line)
  walkQueue(s, dt)
}

function stepUsher(s: GameState, dt: number) {
  const u = s.usher
  if (!s.unlocks.usher) return
  if (!u.present) {
    u.present = true
    u.arrived = false
    u.age = 0
    u.x = USHER_PAD.x
    u.z = USHER_PAD.z
    u.heading = headingOf(L.USHER_POST.x - u.x, L.USHER_POST.z - u.z)
  }
  u.age += dt
  if (u.arrived) {
    // One arm points at the cauldron.
    u.heading = lerpAngle(u.heading, headingOf(L.CAULDRON.x - u.x, L.CAULDRON.z - u.z), damp(TURN_RATE, dt))
    return
  }
  if (u.age < USHER_APPEAR) return
  const dx = L.USHER_POST.x - u.x
  const dz = L.USHER_POST.z - u.z
  const d = Math.hypot(dx, dz)
  const reach = P.USHER_RUN_SPEED * dt
  if (d <= reach) {
    u.x = L.USHER_POST.x
    u.z = L.USHER_POST.z
    u.arrived = true
  } else {
    u.x += (dx / d) * reach
    u.z += (dz / d) * reach
  }
}

/**
 * True while the doctor stands where he pays the usher pad and can afford it. The pad lies inside the
 * manual-release radius, yet the ad shows no release while he buys the usher (27.2-28.4 s): there, standing
 * means paying. Anywhere else, or with a pad he cannot afford, the manual release works as before.
 */
function buyingUsher(s: GameState): boolean {
  for (let i = 0; i < s.pads.length; i++) {
    const p = s.pads[i]!
    if (p.id !== 'usher') continue
    if (p.state === 'hidden' || s.wallet + p.paid < p.price) return false
    return dist2(s.player.x, s.player.z, p.x, p.z) <= P.PAD_PAY_RADIUS * P.PAD_PAY_RADIUS
  }
  return false
}

function stepRelease(s: GameState, dt: number, hold: number, line: number) {
  const c = s.crowd
  const g = s.gate
  const pot = s.cauldron
  const occupied = hold + line
  if (s.unlocks.usher) {
    c.manualT = 0
    // One at a time: the rule is checked again for every villager.
    c.pendingRelease = s.usher.arrived && c.remaining > 0 && occupied < queueMax(s) && freeBedCount(s) >= 1 ? 1 : 0
  } else if (c.pendingRelease === 0) {
    // "Exactly BATH_SLOTS come out" (fewer at the very end of the crowd); topping up instead of requiring an
    // empty queue is the same thing in normal play and cannot strand a short queue.
    const group = Math.min(pot.slots, occupied + c.remaining)
    const p = s.player
    const near = dist2(p.x, p.z, L.MANUAL_RELEASE.x, L.MANUAL_RELEASE.z) <= P.MANUAL_RELEASE_RADIUS * P.MANUAL_RELEASE_RADIUS
    // Potion of a batch that is still in the air is spoken for.
    const committed = pot.bath === 'preHop' || pot.bath === 'hopIn' ? pot.bathers.length : 0
    const ok = group > occupied && near && pot.potion >= (group + committed) * P.POTION_PER_BATHER && freeBedCount(s) >= group && !buyingUsher(s)
    c.manualT = ok ? c.manualT + dt : 0
    if (ok && c.manualT >= P.MANUAL_RELEASE_DELAY) {
      c.pendingRelease = group - occupied
      c.manualT = 0
    }
  }
  if (c.pendingRelease > c.remaining) c.pendingRelease = c.remaining

  if (c.pendingRelease > 0 && !g.wantOpen) {
    g.wantOpen = true
    emit(s, { type: 'gateOpen' })
  }
  g.open = approach(g.open, g.wantOpen ? 1 : 0, dt / P.GATE_SWING_TIME)
  g.idleT += dt
  // releaseT keeps the remainder of the interval, so the single file is paced the same at any dt. A timer that
  // has run out and was not waited for owes nothing: the villager it lets through starts a whole interval. A step
  // of zero length lets nobody out, like every other motion.
  let wait = c.releaseT > 0 ? c.releaseT - dt : 0
  if (dt > 0 && c.pendingRelease > 0 && g.open >= 1 && wait <= 1e-9) {
    releaseVillager(s, occupied)
    c.pendingRelease--
    g.idleT = 0
    wait += P.USHER_RELEASE_INTERVAL
  }
  c.releaseT = Math.max(0, wait)
  if (g.wantOpen && c.pendingRelease === 0 && g.idleT >= P.GATE_CLOSE_DELAY) {
    g.wantOpen = false
    emit(s, { type: 'gateClose' })
  }
}

function releaseVillager(s: GameState, slot: number) {
  const c = s.crowd
  const gate = L.PEN_GATE
  const sx = queueSlotX(slot)
  const sz = queueSlotZ(slot)
  // The rear slots lie inside the bay, west of the usual waypoint: going through it would mean walking back.
  const path = sx > L.PEN_INNER.x + 0.3 ? [L.PEN_INNER.x, L.PEN_INNER.z, sx, sz] : [sx, sz]
  const v: Villager = {
    id: s.nextId++,
    state: 'toQueue',
    t: 0,
    x: gate.x,
    z: gate.z,
    y: 0,
    heading: headingOf(path[0]! - gate.x, path[1]! - gate.z),
    look: 'sick',
    path,
    pathI: 0,
    speed: P.SICK_WALK_SPEED,
    slot,
    bed: -1,
    fromX: gate.x,
    fromZ: gate.z,
    toX: sx,
    toZ: sz,
    delay: 0,
    // He is the crowd instance that disappears (the farthest occupied slot), so he keeps its variation.
    seed: CROWD_SLOTS[CROWD_SLOTS.length - c.remaining]?.seed ?? rand(s.rng),
    alpha: 1,
  }
  s.villagers.push(v)
  c.remaining--
  c.released++
  emit(s, { type: 'villagerRelease', id: v.id })
}

function retarget(v: Villager, slot: number) {
  v.slot = slot
  const sx = queueSlotX(slot)
  const sz = queueSlotZ(slot)
  v.toX = sx
  v.toZ = sz
  const viaInner = v.state === 'toQueue' && v.pathI === 0 && v.path.length === 4 && sx > L.PEN_INNER.x + 0.3
  if (viaInner) {
    v.path[2] = sx
    v.path[3] = sz
    return
  }
  v.path.length = 2
  v.path[0] = sx
  v.path[1] = sz
  v.pathI = 0
}

/** Everyone keeps his place in the line; the line starts right behind the bathers still standing. */
function closeGaps(s: GameState, hold: number) {
  const vs = s.villagers
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i]!
    newSlot[i] = -1
    if (v.state !== 'toQueue' && v.state !== 'queued') continue
    let ahead = 0
    for (let j = 0; j < vs.length; j++) {
      const w = vs[j]!
      if (j === i || (w.state !== 'toQueue' && w.state !== 'queued')) continue
      if (w.slot < v.slot || (w.slot === v.slot && j < i)) ahead++
    }
    newSlot[i] = hold + ahead
  }
  for (let i = 0; i < vs.length; i++) {
    const slot = newSlot[i]!
    if (slot >= 0 && slot !== vs[i]!.slot) retarget(vs[i]!, slot)
  }
}

function walkQueue(s: GameState, dt: number) {
  const vs = s.villagers
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i]!
    if (v.state !== 'toQueue' && v.state !== 'queued') continue
    v.t += dt
    if (!pathDone(v)) followPath(v, v.speed, dt)
    if (!pathDone(v)) continue
    if (v.state === 'toQueue') {
      v.state = 'queued'
      v.t = 0
    }
    v.heading = lerpAngle(v.heading, headingOf(L.CAULDRON.x - v.x, L.CAULDRON.z - v.z), damp(TURN_RATE, dt))
  }
}
