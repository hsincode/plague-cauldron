// Bath (SPEC 2.6, the fountain of 2.8, the big cauldron of 2.12): a batch of queued villagers hops into the pot,
// is cured, hops out on the far side, pays through a coin fountain and is handed to the ward.
import { L, P } from '../config'
import { headingOf, lerp } from '../core/math'
import { freeBedCount, reserveBed } from './beds'
import { emit } from './events'
import { hopY, pathDone } from './npc'
import type { Cauldron, GameState, Villager } from './types'
import { sendToBed } from './ward'

/** Height of a bather's feet while he stands in the pot (Villager.y in the state 'bathing'). */
export const BATH_SEAT_Y = 0.9
/** Both hops peak this far above the rim (SPEC 2.6). */
const HOP_CLEARANCE = 1.2
const HOP_TOP = P.CAULDRON_RIM_HEIGHT + HOP_CLEARANCE
// A hop between the ground and a seat is the straight line plus hopY(u, HOP_ARC); this value puts its peak at HOP_TOP.
const HOP_ARC = (Math.sqrt(HOP_TOP) + Math.sqrt(HOP_TOP - BATH_SEAT_Y)) ** 2 / 4
/** Fraction of the cure after which the bathers look healthy. */
const LOOK_CHANGE = 0.85

// Scratch: the villagers standing in the front queue slots, by slot.
const front: (Villager | undefined)[] = new Array(P.BATH_SLOTS_BIG).fill(undefined)
// Scratch: how long before the end of this step the previous batch ended (0 if it did not end in this step).
// A batch that starts in the same step inherits it, so back-to-back batches lose no time to the step size.
let carry = 0

export function stepBath(s: GameState, dt: number) {
  const c = s.cauldron
  if (s.unlocks.bigCauldron && c.slots < P.BATH_SLOTS_BIG) {
    c.slots = P.BATH_SLOTS_BIG
    c.capacity = P.POTION_CAPACITY_BIG
  }
  stepFountains(s, dt)
  for (let i = 0; i < c.bathers.length; i++) {
    const v = findVillager(s, c.bathers[i]!)
    if (v) v.t += dt
  }
  c.t += dt
  carry = 0
  // A state that ends part-way through the step hands the remainder to the next one, so the batch period
  // is the same at any dt.
  for (let pass = 0; pass < 6 && advance(s, dt); pass++);
}

/** Runs the current bath state; returns true when it ended and the next state should run in the same step. */
function advance(s: GameState, dt: number): boolean {
  const c = s.cauldron
  switch (c.bath) {
    case 'empty':
      tryStart(s, dt)
      return false
    case 'preHop':
      if (c.t < P.BATH_PRE_HOP_WAIT) return false
      c.t -= P.BATH_PRE_HOP_WAIT
      c.bath = 'hopIn'
      return true
    case 'hopIn':
      return hopIn(s)
    case 'curing': {
      const cured = c.t >= P.BATH_CURE
      if (cured || c.t >= P.BATH_CURE * LOOK_CHANGE) {
        for (let i = 0; i < c.bathers.length; i++) {
          const v = findVillager(s, c.bathers[i]!)
          if (v) v.look = 'bathed'
        }
      }
      if (!cured) return false
      c.t -= P.BATH_CURE
      c.bath = 'check'
      emit(s, { type: 'bathCured', count: c.bathers.length })
      return true
    }
    case 'check':
      if (c.t < P.BATH_CHECK) return false
      c.t -= P.BATH_CHECK
      c.bath = 'hopOut'
      for (let i = 0; i < c.bathers.length; i++) {
        const v = findVillager(s, c.bathers[i]!)
        if (!v) continue
        const exit = L.BATH_EXITS[v.slot % L.BATH_EXITS.length]!
        v.fromX = v.x
        v.fromZ = v.z
        v.toX = exit.x
        v.toZ = exit.z
      }
      return true
    case 'hopOut':
      return hopOut(s)
  }
}

function findVillager(s: GameState, id: number): Villager | undefined {
  const vs = s.villagers
  for (let i = 0; i < vs.length; i++) if (vs[i]!.id === id) return vs[i]
  return undefined
}

function idle(c: Cauldron) {
  c.blockedT = 0
  c.blockedByBeds = false
  c.waitT = 0
}

/** The 'empty' state: start a batch when the SPEC 2.6 / 2.12 conditions hold, else keep the blocked bookkeeping. */
function tryStart(s: GameState, dt: number) {
  const c = s.cauldron
  const slots = Math.min(c.slots, front.length)
  let line = 0
  for (let i = 0; i < slots; i++) front[i] = undefined
  const vs = s.villagers
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i]!
    if (v.state === 'toQueue') line++
    else if (v.state === 'queued') {
      line++
      if (v.slot >= 0 && v.slot < slots && pathDone(v)) front[v.slot] = v
    }
  }
  let ready = 0
  while (ready < slots && front[ready]) ready++
  if (ready === 0) return idle(c)

  const free = freeBedCount(s)
  const doses = Math.floor(c.potion / P.POTION_PER_BATHER)
  let n = 0
  let byBeds = false
  if (ready >= slots) {
    if (doses < slots) c.waitT = 0
    else if (free >= slots) n = slots
    else {
      byBeds = true
      // SPEC 2.12: only the big cauldron takes a partial batch; with two slots the label never shows "1/2".
      if (slots > P.BATH_SLOTS && free >= 1) {
        c.waitT += dt
        if (c.waitT > P.BATH_PARTIAL_WAIT) n = free
      } else c.waitT = 0
    }
  } else if (line > ready) {
    return idle(c) // the rest of the group is still walking up
  } else if (s.crowd.remaining <= 0) {
    // End of the crowd: nobody else will ever join, so whoever stands here goes in.
    c.waitT += dt
    if (c.waitT < P.BATH_LAST_WAIT) {
      c.blockedT = 0
      c.blockedByBeds = false
      return
    }
    n = Math.min(ready, doses, free)
    byBeds = doses >= 1
  } else if (s.unlocks.usher && free === 0) {
    byBeds = true // the usher sends nobody while no bed is free
    c.waitT = 0
  } else {
    return idle(c)
  }

  if (n > 0) return startBatch(s, n)
  // blockedT is the time blocked for the current reason; pad D reads it together with blockedByBeds.
  if (c.blockedByBeds !== byBeds) {
    c.blockedByBeds = byBeds
    c.blockedT = 0
  }
  c.blockedT += dt
}

function startBatch(s: GameState, n: number) {
  const c = s.cauldron
  c.bathers.length = 0
  for (let i = 0; i < n; i++) {
    const v = front[i]!
    const seat = L.BATH_SEATS[i % L.BATH_SEATS.length]!
    v.state = 'preHop'
    v.t = carry
    // v.slot stays i: his queue slot until he leaps (crowd.ts keeps the line behind it), then his seat.
    v.delay = i * P.BATH_HOP_STAGGER
    v.bed = reserveBed(s, v.id)
    v.fromX = v.x
    v.fromZ = v.z
    v.toX = seat.x
    v.toZ = seat.z
    c.bathers.push(v.id)
    front[i] = undefined
  }
  c.bath = 'preHop'
  c.t = carry
  idle(c)
}

function poseHop(v: Villager, u: number, y0: number, y1: number) {
  v.x = lerp(v.fromX, v.toX, u)
  v.z = lerp(v.fromZ, v.toZ, u)
  v.y = lerp(y0, y1, u) + hopY(u, HOP_ARC)
}

/** Bathers leap one after the other (BATH_HOP_STAGGER apart); the batch has landed when the last one has. */
function hopIn(s: GameState): boolean {
  const c = s.cauldron
  let last = 0
  let landed = true
  for (let i = 0; i < c.bathers.length; i++) {
    const v = findVillager(s, c.bathers[i]!)
    if (!v) continue
    if (v.delay > last) last = v.delay
    const local = c.t - v.delay
    if (local < 0) {
      landed = false
      continue
    }
    if (v.state === 'preHop') {
      v.state = 'hopIn'
      v.heading = headingOf(v.toX - v.fromX, v.toZ - v.fromZ)
      emit(s, { type: 'bathHopIn', id: v.id })
    }
    if (local < P.BATH_HOP_IN) {
      poseHop(v, local / P.BATH_HOP_IN, 0, BATH_SEAT_Y)
      v.t = local
      landed = false
      continue
    }
    if (v.state === 'hopIn') {
      v.state = 'bathing'
      v.t = local - P.BATH_HOP_IN
    }
    v.x = v.toX
    v.z = v.toZ
    v.y = BATH_SEAT_Y
  }
  if (!landed) return false
  const n = c.bathers.length
  c.t -= last + P.BATH_HOP_IN
  c.potion = Math.max(0, c.potion - n * P.POTION_PER_BATHER)
  c.bath = 'curing'
  emit(s, { type: 'bathSplash', count: n })
  return true
}

/** Each bather leaves the batch (and this package) when he lands outside; the bath is empty when all have. */
function hopOut(s: GameState): boolean {
  const c = s.cauldron
  let late = 0
  for (let i = 0; i < c.bathers.length; ) {
    const v = findVillager(s, c.bathers[i]!)
    if (v) {
      const local = c.t - v.delay
      if (local < 0) {
        i++
        continue
      }
      if (v.state === 'bathing') {
        v.state = 'hopOut'
        v.heading = headingOf(v.toX - v.fromX, v.toZ - v.fromZ)
        emit(s, { type: 'bathHopOut', id: v.id })
      }
      if (local < P.BATH_HOP_OUT) {
        poseHop(v, local / P.BATH_HOP_OUT, BATH_SEAT_Y, 0)
        v.t = local
        i++
        continue
      }
      late = local - P.BATH_HOP_OUT
      v.x = v.toX
      v.z = v.toZ
      v.y = 0
      handOver(s, v, late)
    }
    c.bathers.splice(i, 1)
  }
  if (c.bathers.length > 0) return false
  c.t = late
  carry = late
  c.bath = 'empty'
  c.batches++
  return true
}

function handOver(s: GameState, v: Villager, late: number) {
  const c = s.cauldron
  const fee = P.BATH_FEE * (c.batches === 0 ? P.FIRST_BATCH_MULTIPLIER : 1)
  c.fountains.push(P.FOUNTAIN_DELAY - late, v.id, fee)
  s.stats.bathed++
  v.look = 'bathed'
  sendToBed(s, v)
}

function stepFountains(s: GameState, dt: number) {
  const f = s.cauldron.fountains
  let w = 0
  for (let i = 0; i + 2 < f.length; i += 3) {
    const t = f[i]! - dt
    if (t > 0) {
      f[w++] = t
      f[w++] = f[i + 1]!
      f[w++] = f[i + 2]!
    } else {
      startFountain(s, f[i + 1]!, f[i + 2]!, -t)
    }
  }
  f.length = w
}

/**
 * The fee leaves the bather as coin meshes of GOLD_PER_COIN_MESH gold: launched evenly over the fountain, each
 * COIN_FLIGHT in the air, the last one landing FOUNTAIN_DURATION after the start. economy.ts lands them.
 * A multiplied fee is the same number of meshes, each worth more (SPEC 2.8: "25 meshes per pair, 4 gold each
 * for the first batch"; the pallet of the ad holds as many coins after the +100 batch as after a +50 one).
 */
function startFountain(s: GameState, villagerId: number, gold: number, late: number) {
  const v = findVillager(s, villagerId)
  const worth = P.GOLD_PER_COIN_MESH * Math.max(1, Math.round(gold / P.BATH_FEE))
  const meshes = Math.ceil(gold / worth)
  const span = Math.max(0, P.FOUNTAIN_DURATION - P.COIN_FLIGHT)
  const inc = s.pallet.incoming
  let left = gold
  for (let j = 0; j < meshes; j++) {
    const amount = Math.min(worth, left)
    left -= amount
    const launch = meshes > 1 ? (j / (meshes - 1)) * span : 0
    inc.push(Math.max(1e-6, launch + P.COIN_FLIGHT - late), amount)
  }
  const exit = L.BATH_EXITS[0]!
  emit(s, { type: 'coinFountain', x: v ? v.x : exit.x, z: v ? v.z : exit.z, gold, meshes, duration: P.FOUNTAIN_DURATION })
}
