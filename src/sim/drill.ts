// Drill sortie and rat swarm (SPEC 2.10, 2.12). Healed ward-1 patients gather at the push handle, shove the
// cart into the rats, the coin heap flies straight to the wallet and the swarm then needs time to regrow.
// Owns the villager states toDrill, atDrill and pushing; the crew is handed back to ward.ts as 'toExit'.
import { L, P } from '../config'
import { TAU, clamp01, damp, easeInOutQuad, lerp, lerpAngle } from '../core/math'
import { emit } from './events'
import { followPath, setPath } from './npc'
import type { Drill, DrillState, GameState, Villager } from './types'

const PARK = L.DRILL_PARK
/** Unit vector across the handle (perpendicular to the push direction): the cart's +x, east when parked. */
const ACROSS_X = Math.cos(PARK.heading)
const ACROSS_Z = -Math.sin(PARK.heading)
const CREW_SPACING = 0.8
/** Share of the rat carpet wiped out by one sortie. */
const KILL_FRACTION = P.RATS_KILLED_PER_SORTIE / P.RAT_COUNT
/** The crew "walk away south" (SPEC 2.10): a walk rather than the healed sprint, so the fade can be seen. */
const CREW_LEAVE_SPEED = P.BATHED_WALK_SPEED
/** Beside the parked cart, clear of its west wheel: everybody who walks home through the swarm passes here first. */
export const DRILL_BYPASS = {
  x: PARK.x - ACROSS_X * 1.65 - Math.sin(PARK.heading) * 0.5,
  z: PARK.z - ACROSS_Z * 1.65 - Math.cos(PARK.heading) * 0.5,
}
/** The first step out of the south gate is taken straight toward the crew member's own place, clear of his partner. */
const DOOR_STEP_Z = L.WARD1_DOOR.z + 0.3
const SPIN_RATE = 28
const SPIN_UP = 0.2
const SPIN_DOWN = P.DRILL_HEAP_HOLD + P.DRILL_FLY_TO_HUD
const TURN_RATE = 14

const slotOffset = (i: number) => (i - (P.DRILL_CREW - 1) / 2) * CREW_SPACING
/**
 * Standing spot of crew slot i while the drill is parked: side by side across L.DRILL_HANDLE. Slot 0 (the west one)
 * is taken first. While the cart moves the crew keeps the same offsets from it. A crew member's slot is stored in
 * Villager.slot.
 */
export const crewSlotX = (i: number) => L.DRILL_HANDLE.x + ACROSS_X * slotOffset(i)
export const crewSlotZ = (i: number) => L.DRILL_HANDLE.z + ACROSS_Z * slotOffset(i)

export function villagerById(s: GameState, id: number): Villager | null {
  const vs = s.villagers
  for (let i = 0; i < vs.length; i++) if (vs[i]!.id === id) return vs[i]!
  return null
}

const regrowTime = (s: GameState) => (s.unlocks.drill2 ? P.RAT_REGROW_MK2 : P.RAT_REGROW)

/**
 * SPEC 2.10: asked by the ward at the moment a healed ward-1 patient leaves his bed. He crews the drill only if
 * the swarm is ready and the crew is not full; nobody ever waits for the swarm to regrow. On true he is in the
 * crew with state 'toDrill'; the caller gives him the path to the south door and stepDrill takes over from there.
 */
export function enlistForDrill(s: GameState, v: Villager): boolean {
  const d = s.drill
  if (!s.swarm.ready || d.state !== 'parked' || d.crew.length >= P.DRILL_CREW) return false
  d.crew.push(v.id)
  v.state = 'toDrill'
  v.slot = -1
  return true
}

function freeSlot(s: GameState): number {
  const crew = s.drill.crew
  for (let i = 0; i < P.DRILL_CREW; i++) {
    let taken = false
    for (let k = 0; k < crew.length; k++) if (villagerById(s, crew[k]!)?.slot === i) taken = true
    if (!taken) return i
  }
  return 0
}

/** Walks the crew to the handle. Returns how many stand at it. */
function stepCrew(s: GameState, dt: number): number {
  const d = s.drill
  let atHandle = 0
  for (let i = 0; i < d.crew.length; i++) {
    const v = villagerById(s, d.crew[i]!)
    if (!v || (v.state !== 'toDrill' && v.state !== 'atDrill' && v.state !== 'pushing')) {
      // Stale entry (should not happen): never let it hold the drill back.
      d.crew.splice(i--, 1)
      continue
    }
    v.t += dt
    if (v.state === 'toDrill' && followPath(v, v.speed, dt)) {
      if (v.slot < 0) {
        // In the doorway: take a place at the handle.
        v.slot = freeSlot(s)
        setPath(v, [crewSlotX(v.slot), DOOR_STEP_Z, crewSlotX(v.slot), crewSlotZ(v.slot)])
      } else {
        v.state = 'atDrill'
        v.t = 0
        atHandle++
        emit(s, { type: 'drillCrewJoin', id: v.id, crew: atHandle + countAtHandle(s, i + 1) })
        continue
      }
    }
    // Turning to the push direction takes a moment, also for the partner whose arrival starts the push.
    if (v.state !== 'toDrill') v.heading = lerpAngle(v.heading, d.heading, damp(TURN_RATE, dt))
    if (v.state === 'atDrill') atHandle++
  }
  return atHandle
}

function countAtHandle(s: GameState, from: number): number {
  const crew = s.drill.crew
  let n = 0
  for (let k = from; k < crew.length; k++) if (villagerById(s, crew[k]!)?.state === 'atDrill') n++
  return n
}

function placeDrill(d: Drill, k: number) {
  d.x = lerp(PARK.x, L.DRILL_END.x, k)
  d.z = lerp(PARK.z, L.DRILL_END.z, k)
  d.heading = PARK.heading
}

/** Enter the next state of the sortie, carrying the overshoot so the timeline does not depend on dt. */
function next(d: Drill, state: DrillState, elapsed: number) {
  d.state = state
  d.t -= elapsed
}

function startSortie(s: GameState) {
  const d = s.drill
  d.state = 'pushing'
  d.t = 0
  d.loneT = 0
  d.paid = 0
  d.reward = s.unlocks.drill2 ? P.DRILL_REWARD_MK2 : P.DRILL_REWARD
  s.swarm.ready = false
  s.swarm.regrowT = regrowTime(s)
  for (let i = 0; i < d.crew.length; i++) {
    const v = villagerById(s, d.crew[i]!)
    if (!v) continue
    v.state = 'pushing'
    v.t = 0
  }
  emit(s, { type: 'drillPush' })
}

/** The crew holds the handle: same offsets from the cart as at the parking spot. */
function carryCrew(s: GameState) {
  const d = s.drill
  for (let i = 0; i < d.crew.length; i++) {
    const v = villagerById(s, d.crew[i]!)
    if (!v || v.state !== 'pushing') continue
    v.x = crewSlotX(v.slot) + d.x - PARK.x
    v.z = crewSlotZ(v.slot) + d.z - PARK.z
    v.y = 0
  }
}

function releaseCrew(s: GameState) {
  const d = s.drill
  for (let i = 0; i < d.crew.length; i++) {
    const v = villagerById(s, d.crew[i]!)
    if (!v) continue
    v.state = 'toExit' // ward.ts fades him out and counts him as discharged
    v.t = 0
    v.slot = -1
    v.alpha = 1
    v.speed = CREW_LEAVE_SPEED
    setPath(v, [DRILL_BYPASS.x, DRILL_BYPASS.z, L.SOUTH_EXIT.x, L.SOUTH_EXIT.z])
  }
  d.crew.length = 0
}

function pay(s: GameState, gold: number) {
  if (gold <= 0) return
  s.wallet += gold
  s.stats.totalGold += gold
  s.drill.paid += gold
}

function stepSwarm(s: GameState, dt: number) {
  const w = s.swarm
  if (w.ready) return
  const total = regrowTime(s)
  if (w.regrowT > total) w.regrowT = total // Mk II bought while the rats were coming back
  w.regrowT = Math.max(0, w.regrowT - dt)
  // The carpet refills at a steady rate from the end of the kill, so that it is full exactly when ready.
  if (s.drill.state !== 'pushing') w.fill = Math.min(1, w.fill + (KILL_FRACTION / (total - P.DRILL_PUSH_TIME)) * dt)
  if (w.regrowT <= 0 && s.drill.state === 'parked') {
    w.ready = true
    w.fill = 1
    emit(s, { type: 'swarmReady' })
  }
}

function spinRate(d: Drill): number {
  switch (d.state) {
    case 'pushing':
      return SPIN_RATE * (0.3 + 0.7 * clamp01(d.t / SPIN_UP))
    case 'burst':
      return SPIN_RATE
    case 'heap':
      return SPIN_RATE * clamp01(1 - d.t / SPIN_DOWN)
    case 'collect':
      return SPIN_RATE * clamp01(1 - (P.DRILL_HEAP_HOLD + d.t) / SPIN_DOWN)
    default:
      return 0
  }
}

export function stepDrill(s: GameState, dt: number) {
  const d = s.drill
  const t0 = d.t
  d.t = t0 + dt
  const atHandle = stepCrew(s, dt)

  switch (d.state) {
    case 'parked':
      if (atHandle === 0) {
        d.loneT = 0
        break
      }
      if (atHandle < P.DRILL_CREW) d.loneT += dt
      // A short crew leaves after DRILL_LONE_WAIT, but not while a partner is already running to the handle.
      if (s.swarm.ready && (atHandle >= P.DRILL_CREW || (d.loneT >= P.DRILL_LONE_WAIT && atHandle === d.crew.length))) startSortie(s)
      break
    case 'pushing':
      placeDrill(d, easeInOutQuad(d.t / P.DRILL_PUSH_TIME))
      if (t0 < P.DRILL_KILL_START && d.t >= P.DRILL_KILL_START) {
        emit(s, { type: 'drillKill', x: L.DRILL_END.x, z: L.DRILL_END.z, rats: P.RATS_KILLED_PER_SORTIE })
      }
      s.swarm.fill = 1 - KILL_FRACTION * clamp01((d.t - P.DRILL_KILL_START) / (P.DRILL_PUSH_TIME - P.DRILL_KILL_START))
      if (d.t >= P.DRILL_PUSH_TIME) next(d, 'burst', P.DRILL_PUSH_TIME)
      break
    case 'burst':
      if (d.t >= P.DRILL_COIN_FOUNTAIN) next(d, 'heap', P.DRILL_COIN_FOUNTAIN)
      break
    case 'heap':
      if (d.t >= P.DRILL_HEAP_HOLD) {
        next(d, 'collect', P.DRILL_HEAP_HOLD)
        emit(s, { type: 'drillHeapLift', gold: d.reward })
      }
      break
    case 'collect': {
      const done = d.t >= P.DRILL_FLY_TO_HUD
      pay(s, (done ? d.reward : Math.floor((d.reward * d.t) / P.DRILL_FLY_TO_HUD)) - d.paid)
      if (done) {
        d.sorties++
        s.flags.firstSortiePaid = true
        emit(s, { type: 'drillPaid', gold: d.reward })
        next(d, 'return', P.DRILL_FLY_TO_HUD)
      }
      break
    }
    case 'return':
      placeDrill(d, 1 - easeInOutQuad(d.t / P.DRILL_RETURN_TIME))
      if (d.t >= P.DRILL_RETURN_TIME) {
        next(d, 'parked', P.DRILL_RETURN_TIME)
        placeDrill(d, 0)
        carryCrew(s)
        releaseCrew(s)
      }
      break
  }

  if (d.state !== 'parked') carryCrew(s)
  stepSwarm(s, dt)
  d.spin = (d.spin + spinRate(d) * dt) % TAU
}
