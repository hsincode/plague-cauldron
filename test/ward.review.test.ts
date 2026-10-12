// Adversarial review of the ward package (sim/ward.ts, sim/drill.ts): edge cases, bad hand-overs, unlock order,
// step-length independence and seeded fuzz runs with invariants checked after every step.
// Like test/ward.test.ts the scenarios drive stepWard + stepDrill directly; only the last block adds the crowd and the bath.
import { describe, expect, test } from 'bun:test'
import { BEDS, L, P, UNLOCKS } from '../src/config'
import { makeRng, rand, randRange } from '../src/core/rng'
import { stepBath } from '../src/sim/bath'
import { freeBedCount, reserveBed } from '../src/sim/beds'
import { stepCrowd } from '../src/sim/crowd'
import { crewSlotX, crewSlotZ, stepDrill } from '../src/sim/drill'
import type { EventOf, EventType, GameEvent } from '../src/sim/events'
import { stepGuide } from '../src/sim/guide'
import { createState } from '../src/sim/state'
import type { GameState, Villager, VillagerState } from '../src/sim/types'
import { BED_LIE_Y, sendToBed, stepWard } from '../src/sim/ward'

const DTS = [1 / 60, 1 / 97, 1 / 144]
const TREAT_TOTAL = P.NURSE_START_DELAY + P.TREAT_END

interface Sim {
  s: GameState
  /** Step length; `vary` draws a new one in [1/144, 1/60] for every step. */
  dt: number
  vary: ReturnType<typeof makeRng> | null
  log: { t: number; e: GameEvent }[]
  firstSeen: Map<string, number>
  probe: ((s: GameState, dt: number) => void) | null
  /** Remove 'gone' villagers after every step, as sim/guide.ts does. */
  sweep: boolean
  /** Keep the swarm away for good (a regrow timer set from outside is capped at the regrow time). */
  noRats: boolean
}

function sim(dt = 1 / 60, seed = 1): Sim {
  return { s: createState(seed), dt, vary: null, log: [], firstSeen: new Map(), probe: null, sweep: false, noRats: false }
}

function tick(w: Sim) {
  const s = w.s
  const dt = w.vary ? randRange(w.vary, 1 / 144, 1 / 60) : w.dt
  s.time += dt
  if (w.noRats) {
    s.swarm.ready = false
    s.swarm.regrowT = P.RAT_REGROW
  }
  stepWard(s, dt)
  stepDrill(s, dt)
  for (const e of s.events) w.log.push({ t: s.time, e })
  s.events.length = 0
  for (const v of s.villagers) {
    const k = `${v.id}:${v.state}`
    if (!w.firstSeen.has(k)) w.firstSeen.set(k, s.time)
  }
  w.probe?.(s, dt)
  if (w.sweep) for (let i = s.villagers.length - 1; i >= 0; i--) if (s.villagers[i]!.state === 'gone') s.villagers.splice(i, 1)
}

function run(w: Sim, seconds: number) {
  const end = w.s.time + seconds
  while (w.s.time < end - 1e-9) tick(w)
}

function runUntil(w: Sim, pred: () => boolean, max = 60): number {
  const end = w.s.time + max
  while (!pred()) {
    if (w.s.time > end) throw new Error(`condition not reached within ${max} s`)
    tick(w)
  }
  return w.s.time
}

const events = <T extends EventType>(w: Sim, type: T) => w.log.filter(l => l.e.type === type).map(l => l.e as EventOf<T>)
const times = (w: Sim, type: EventType) => w.log.filter(l => l.e.type === type).map(l => l.t)
const seenAt = (w: Sim, v: Villager, state: VillagerState) => w.firstSeen.get(`${v.id}:${state}`)

/** A villager that has just landed outside the pot, handed over like sim/bath.ts does. `bed` undefined = reserve one. */
function bather(w: Sim, exit = 0, bed?: number): Villager {
  const s = w.s
  const e = L.BATH_EXITS[exit % L.BATH_EXITS.length]!
  const id = s.nextId++
  const v = {
    id, state: 'hopOut', t: 0, x: e.x, z: e.z, y: 0, heading: Math.PI / 2, look: 'sick', path: [], pathI: 0, speed: 0,
    slot: exit, bed: bed === undefined ? reserveBed(s, id) : bed, fromX: e.x, fromZ: e.z, toX: e.x, toZ: e.z, delay: 0, seed: 0.5, alpha: 1,
  } as Villager
  s.villagers.push(v)
  sendToBed(s, v)
  return v
}

function withNurses(w: Sim) {
  w.s.unlocks.nurses = true
  run(w, 2)
  expect(w.s.nurses.every(n => n.state === 'idle')).toBe(true)
}

/** The swarm stays away for the whole test, so healed ward-1 patients simply walk out. */
function noRats(w: Sim) {
  w.noRats = true
  w.s.swarm.ready = false
  w.s.swarm.regrowT = P.RAT_REGROW
}

const CREW_STATES: VillagerState[] = ['toDrill', 'atDrill', 'pushing']
const ON_BED: VillagerState[] = ['inBed', 'cheer', 'hopOff']
/** A bed is reserved from the start of the bath batch (sim/bath.ts) until its patient lies on it. */
const ON_THE_WAY: VillagerState[] = ['preHop', 'hopIn', 'bathing', 'hopOut', 'toBed', 'lieDown']

/** Everything that must hold after every single step, whatever happened before. */
function invariants(s: GameState): string[] {
  const bad: string[] = []
  for (const b of s.beds) {
    if (!b.exists && b.state !== 'free') bad.push(`bed ${b.id} is used before it exists`)
    if (b.state === 'free') {
      if (b.villager !== -1) bad.push(`free bed ${b.id} still names villager ${b.villager}`)
      continue
    }
    const v = s.villagers.find(x => x.id === b.villager)
    if (!v) bad.push(`bed ${b.id} is ${b.state} for a villager that does not exist`)
    else if (v.bed !== b.id) bad.push(`bed ${b.id} is ${b.state} for villager ${v.id} whose bed is ${v.bed}`)
    else if (b.state === 'occupied' && !ON_BED.includes(v.state)) bad.push(`bed ${b.id} occupied by a villager in state ${v.state}`)
    else if (b.state === 'reserved' && !ON_THE_WAY.includes(v.state)) bad.push(`bed ${b.id} reserved for a villager in state ${v.state}`)
    if (!(b.lieT >= 0)) bad.push(`bed ${b.id} lieT ${b.lieT}`)
  }
  for (const v of s.villagers) {
    if (!Number.isFinite(v.x + v.z + v.y + v.heading + v.alpha + v.t + v.speed)) bad.push(`villager ${v.id} (${v.state}) has a non-finite field`)
    if (v.alpha < 0 || v.alpha > 1) bad.push(`villager ${v.id} alpha ${v.alpha}`)
    if (v.y < -1e-9) bad.push(`villager ${v.id} below the ground`)
    if (v.bed >= 0 && s.beds[v.bed]?.villager !== v.id) bad.push(`villager ${v.id} (${v.state}) points at bed ${v.bed} which is not his`)
    if ((ON_BED.includes(v.state) || v.state === 'toBed' || v.state === 'lieDown') && v.bed < 0) bad.push(`villager ${v.id} is ${v.state} without a bed`)
    if (CREW_STATES.includes(v.state) && !s.drill.crew.includes(v.id)) bad.push(`villager ${v.id} is ${v.state} but not in the crew`)
    if (v.state !== 'gone' && v.state !== 'toExit' && v.alpha !== 1) bad.push(`villager ${v.id} fades in state ${v.state}`)
  }
  const crew = s.drill.crew
  if (crew.length > P.DRILL_CREW || new Set(crew).size !== crew.length) bad.push(`crew ${crew}`)
  for (const id of crew) {
    const v = s.villagers.find(x => x.id === id)
    if (!v || !CREW_STATES.includes(v.state)) bad.push(`crew member ${id} is ${v?.state}`)
  }
  if (s.drill.state !== 'parked' && crew.some(id => s.villagers.find(x => x.id === id)?.state !== 'pushing')) bad.push('crew not pushing during a sortie')
  if (s.drill.state !== 'parked' && s.swarm.ready) bad.push('swarm ready during a sortie')
  const lo = 1 - P.RATS_KILLED_PER_SORTIE / P.RAT_COUNT
  if (!(s.swarm.fill >= lo - 1e-9 && s.swarm.fill <= 1)) bad.push(`swarm fill ${s.swarm.fill}`)
  if (s.swarm.ready && s.swarm.fill !== 1) bad.push('ready swarm is not full')
  if (!(s.swarm.regrowT >= 0)) bad.push(`regrowT ${s.swarm.regrowT}`)
  for (const d of [s.doors.south, s.doors.north]) if (!(d >= 0 && d <= 1)) bad.push(`door ${d}`)
  if (!Number.isInteger(s.wallet) || s.wallet < 0) bad.push(`wallet ${s.wallet}`)
  if (!Number.isFinite(s.drill.x + s.drill.z + s.drill.heading + s.drill.spin + s.drill.t)) bad.push('drill pose')
  if (s.nurses.length > BEDS.length || new Set(s.nurses.map(n => n.bed)).size !== s.nurses.length) bad.push('nurses')
  for (const n of s.nurses) if (!Number.isFinite(n.x + n.z + n.heading + n.age)) bad.push(`nurse ${n.id} pose`)
  return bad
}

describe('treatment timeline at every step length', () => {
  for (const dt of DTS) {
    test(`the SPEC 2.10 table holds to within two steps at ${Math.round(1 / dt)} Hz`, () => {
      const w = sim(dt)
      withNurses(w)
      noRats(w)
      const v = bather(w)
      const bed = w.s.beds[0]!
      let treatAtFree = -2
      w.probe = () => {
        if (bed.state === 'occupied') treatAtFree = bed.treatT
      }
      runUntil(w, () => v.state === 'gone', 20)
      const lay = times(w, 'patientLie')[0]!
      const tol = 2 * dt + 1e-9
      const t0 = lay + P.NURSE_START_DELAY
      expect(Math.abs(times(w, 'treatStart')[0]! - t0)).toBeLessThan(tol)
      expect(Math.abs(times(w, 'treatJab')[0]! - (t0 + P.TREAT_JAB))).toBeLessThan(tol)
      expect(Math.abs(times(w, 'healed')[0]! - (t0 + P.TREATMENT_TIME))).toBeLessThan(tol)
      expect(Math.abs(seenAt(w, v, 'cheer')! - (t0 + P.TREAT_SIT_UP))).toBeLessThan(tol)
      expect(Math.abs(seenAt(w, v, 'hopOff')! - (t0 + P.TREAT_HOP_OFF))).toBeLessThan(tol)
      expect(Math.abs(seenAt(w, v, 'toExit')! - (t0 + P.TREAT_END))).toBeLessThan(tol)
      expect(treatAtFree).toBeGreaterThan(P.TREAT_HOP_OFF)
      for (const type of ['patientLie', 'treatStart', 'treatJab', 'healed', 'discharged'] as const) expect(events(w, type).length).toBe(1)
      expect(events(w, 'needsNurse').length).toBe(0)
    })
  }

  test('a nurse who arrives before the patient has lain NURSE_START_DELAY waits for the rest of it', () => {
    for (const dt of DTS) {
      const w = sim(dt)
      noRats(w)
      const v = bather(w)
      const lay = runUntil(w, () => v.state === 'inBed', 5)
      run(w, 1.0)
      w.s.unlocks.nurses = true
      const nurse = () => w.s.nurses.find(n => n.bed === 0)!
      const atPost = runUntil(w, () => w.s.nurses.length > 0 && nurse().state !== 'running', 3)
      expect(atPost).toBeLessThan(lay + P.NURSE_START_DELAY - 0.5)
      expect(w.s.beds[0]!.treatT).toBe(-1)
      expect(nurse().state).toBe('idle')
      runUntil(w, () => w.s.beds[0]!.treatT >= 0, 5)
      expect(Math.abs(times(w, 'treatStart')[0]! - (lay + P.NURSE_START_DELAY))).toBeLessThan(2 * dt + 1e-9)
      expect(v.look).toBe('bathed')
      // the bubble was shown before the nurses existed and is not announced again
      expect(events(w, 'needsNurse').length).toBe(1)
    }
  })

  test('needsNurse is per lie-down: it fires again for the next patient of a nurseless bed, never with a nurse', () => {
    const w = sim()
    const first = bather(w)
    runUntil(w, () => first.state === 'inBed', 5)
    run(w, 1)
    expect(events(w, 'needsNurse')).toEqual([{ type: 'needsNurse', bed: 0 }])
    // nurses bought a moment after the second patient lay down (before NEEDS_NURSE_DELAY): no bubble for him
    const second = bather(w)
    expect(second.bed).toBe(1)
    runUntil(w, () => second.state === 'inBed', 5)
    w.s.unlocks.nurses = true
    run(w, 1)
    expect(events(w, 'needsNurse').length).toBe(1)
    runUntil(w, () => first.state === 'gone' && second.state === 'gone', 30)
    // with nurses at their posts nobody ever needs one again
    const third = bather(w)
    runUntil(w, () => third.state === 'gone', 30)
    expect(events(w, 'needsNurse').length).toBe(1)
    expect(events(w, 'healed').map(e => e.id).sort()).toEqual([first.id, second.id, third.id].sort())
  })

  test('the patient is posed on the bed and back on the ground at every stage', () => {
    for (const dt of DTS) {
      const w = sim(dt)
      withNurses(w)
      noRats(w)
      const v = bather(w, 0, 3)
      const def = BEDS[3]!
      let maxY = 0
      let lyingOff = 0
      w.probe = () => {
        maxY = Math.max(maxY, v.y)
        if (v.state === 'toBed' || v.state === 'toExit') expect(v.y).toBe(0)
        if (v.state === 'inBed' || v.state === 'cheer') lyingOff = Math.max(lyingOff, Math.hypot(v.x - def.x, v.z - def.z), Math.abs(v.y - BED_LIE_Y))
        if (v.state === 'inBed' && w.s.beds[3]!.treatT < P.TREATMENT_TIME) expect(v.look).toBe('bathed')
        if (v.state === 'cheer' || v.state === 'hopOff') expect(v.look).toBe('healed')
      }
      runUntil(w, () => v.state === 'gone', 30)
      expect(lyingOff).toBeLessThan(1e-9)
      expect(maxY).toBeGreaterThan(BED_LIE_Y)
      expect(maxY).toBeLessThan(BED_LIE_Y + 0.6)
    }
  })
})

describe('bad hand-overs never strand anybody', () => {
  test('a bed id out of range, a ward-2 bed that does not exist yet and an occupied bed all end in a discharge', () => {
    const w = sim()
    withNurses(w)
    noRats(w)
    const owner = bather(w)
    runUntil(w, () => owner.state === 'inBed', 5)
    const strays = [bather(w, 0, 99), bather(w, 1, 7), bather(w, 2, owner.bed), bather(w, 3, -1), bather(w, 0, Number.NaN)]
    for (const v of strays) {
      expect(v.state).toBe('toExit')
      expect(v.bed).toBe(-1)
      expect(v.look).toBe('healed')
    }
    expect(w.s.beds[7]!.state).toBe('free')
    expect(w.s.beds[owner.bed]!.villager).toBe(owner.id)
    w.probe = s => expect(invariants(s)).toEqual([])
    runUntil(w, () => strays.every(v => v.state === 'gone') && owner.state === 'gone', 30)
    expect(w.s.stats.discharged).toBe(strays.length + 1)
    expect(events(w, 'patientLie').length).toBe(1)
    expect(w.s.drill.crew.length).toBe(0)
    expect(w.s.beds.every(b => b.state === 'free')).toBe(true)
  })

  test('a patient whose bed is taken from under him goes home; the bed keeps serving its new owner', () => {
    const w = sim()
    withNurses(w)
    noRats(w)
    const walker = bather(w)
    run(w, 0.5)
    expect(walker.state).toBe('toBed')
    // somebody else's bookkeeping hands his bed to another villager while he is on the way
    w.s.beds[0]!.villager = 777
    runUntil(w, () => walker.state === 'gone', 20)
    expect(events(w, 'patientLie').length).toBe(0)
    expect(w.s.beds[0]!.villager).toBe(777)
    expect(w.s.beds[0]!.state).toBe('reserved')

    const sleeper = bather(w)
    expect(sleeper.bed).toBe(1)
    runUntil(w, () => sleeper.state === 'inBed', 5)
    w.s.beds[1]!.state = 'free'
    w.s.beds[1]!.villager = -1
    runUntil(w, () => sleeper.state === 'gone', 20)
    expect(w.s.stats.discharged).toBe(2)
  })

  test('handing the same villager over twice does not duplicate him or his bed', () => {
    const w = sim()
    withNurses(w)
    noRats(w)
    const v = bather(w)
    run(w, 0.3)
    sendToBed(w.s, v)
    expect(v.state).toBe('toBed')
    expect(w.s.beds.filter(b => b.villager === v.id).length).toBe(1)
    w.probe = s => expect(invariants(s)).toEqual([])
    runUntil(w, () => v.state === 'gone', 30)
    expect(events(w, 'patientLie').length).toBe(1)
    expect(w.s.stats.discharged).toBe(1)
  })

  test('the hand-over leaves no bath seat behind in Villager.slot', () => {
    const w = sim()
    const v = bather(w, 3)
    expect(v.slot).toBe(-1)
    const lost = bather(w, 2, -1)
    expect(lost.slot).toBe(-1)
  })
})

describe('unlock flags', () => {
  test('every order of the three flags gives 4 + 6 nurses once, at their posts, with one event per ward', () => {
    const orders: ('nurses' | 'ward2' | 'drill2')[][] = [
      ['nurses', 'ward2', 'drill2'],
      ['ward2', 'nurses', 'drill2'],
      ['drill2', 'ward2', 'nurses'],
    ]
    for (const order of orders) {
      const w = sim(1 / 144)
      for (const id of order) {
        w.s.unlocks[id] = true
        run(w, 0.7)
      }
      run(w, 3)
      expect(w.s.nurses.length).toBe(10)
      expect(w.s.nurses.map(n => n.bed).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
      for (const n of w.s.nurses) {
        expect(n.state).toBe('idle')
        expect(n.x).toBeCloseTo(BEDS[n.bed]!.x + L.NURSE_POST.x)
        expect(n.z).toBeCloseTo(BEDS[n.bed]!.z + L.NURSE_POST.z)
      }
      const spawns = events(w, 'nursesSpawn')
      expect(spawns.map(e => e.ward).sort()).toEqual([1, 2])
      const pad = UNLOCKS.find(u => u.id === 'nurses')!
      expect(spawns.find(e => e.ward === 1)).toEqual({ type: 'nursesSpawn', ward: 1, x: pad.x, z: pad.z })
      const two = spawns.find(e => e.ward === 2)!
      expect(two.x).toBeGreaterThan(L.WARD2[0])
      expect(two.x).toBeLessThan(L.WARD2[2])
      expect(two.z).toBeGreaterThan(L.WARD2[1])
      expect(two.z).toBeLessThan(L.WARD2[3])
      expect(w.s.beds.every(b => b.exists && b.state === 'free')).toBe(true)
    }
  })

  test('ward 2 bought before the nurses: its beds are staffed, ward 1 still waits for pad A', () => {
    const w = sim()
    w.s.unlocks.ward2 = true
    tick(w)
    expect(w.s.nurses.map(n => n.bed).sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8, 9])
    const a = bather(w)
    expect(a.bed).toBe(0)
    runUntil(w, () => a.state === 'inBed', 5)
    run(w, 10)
    expect(a.state).toBe('inBed')
    expect(events(w, 'needsNurse')).toEqual([{ type: 'needsNurse', bed: 0 }])
    const far = bather(w, 1, 9)
    runUntil(w, () => far.state === 'gone', 30)
    expect(events(w, 'healed').map(e => e.bed)).toEqual([9])
  })

  test('bed and nurse ages advance and the ward-2 glow starts exactly once', () => {
    const w = sim()
    run(w, 1)
    expect(w.s.beds[0]!.age).toBeGreaterThan(99.9)
    w.s.unlocks.ward2 = true
    w.s.unlocks.nurses = true
    run(w, 2)
    for (const b of w.s.beds.filter(b => b.ward === 2)) expect(b.age).toBeCloseTo(2, 1)
    for (const n of w.s.nurses) expect(n.age).toBeCloseTo(2, 1)
  })

  test('an idle world stays silent and unchanged for ten minutes', () => {
    for (const flags of [[], ['nurses', 'ward2', 'drill2']] as const) {
      const w = sim()
      for (const id of flags) w.s.unlocks[id] = true
      run(w, 3)
      const before = w.log.length
      const nurses = w.s.nurses.map(n => [n.x, n.z, n.state])
      run(w, 600)
      expect(w.log.length).toBe(before)
      expect(w.s.nurses.map(n => [n.x, n.z, n.state])).toEqual(nurses)
      expect(w.s.villagers.length).toBe(0)
      expect(w.s.drill.state).toBe('parked')
      expect(w.s.drill.crew.length).toBe(0)
      expect(w.s.drill.x).toBe(L.DRILL_PARK.x)
      expect(w.s.drill.z).toBe(L.DRILL_PARK.z)
      expect(w.s.drill.spin).toBe(0)
      expect(w.s.swarm).toEqual({ ready: true, regrowT: 0, fill: 1 })
      expect(w.s.doors).toEqual({ south: 0, north: 0 })
      expect(w.s.wallet).toBe(0)
      expect(w.s.stats.discharged).toBe(0)
    }
  })
})

describe('drill crew rules', () => {
  /** A healed ward-1 patient standing at the handle; returns the time he joined. */
  function loneAtHandle(w: Sim): { v: Villager; joined: number } {
    const v = bather(w)
    const joined = runUntil(w, () => v.state === 'atDrill', 20)
    return { v, joined }
  }

  test('a partner who enlists just before the lone wait ends is waited for and both push one sortie', () => {
    for (const dt of DTS) {
      const w = sim(dt)
      withNurses(w)
      const { v: first, joined } = loneAtHandle(w)
      // the second patient is timed to hop off his bed 0.3 s before the lone wait runs out
      const second = bather(w, 1, 1)
      const bed = w.s.beds[1]!
      runUntil(w, () => second.state === 'inBed', 5)
      bed.lieT = P.NURSE_START_DELAY
      const hopsOffIn = P.TREAT_END
      w.s.drill.loneT = P.DRILL_LONE_WAIT - hopsOffIn - 0.3
      runUntil(w, () => second.state === 'toDrill', 5)
      expect(w.s.drill.state).toBe('parked')
      const enlisted = w.s.time
      const push = runUntil(w, () => w.s.drill.state === 'pushing', 5)
      expect(w.s.drill.crew.length).toBe(2)
      expect(push - enlisted).toBeGreaterThan(0.4) // the lone wait ended 0.3 s after he enlisted; the cart waited for him
      expect(first.state).toBe('pushing')
      expect(second.state).toBe('pushing')
      expect(new Set([first.slot, second.slot])).toEqual(new Set([0, 1]))
      runUntil(w, () => first.state === 'gone' && second.state === 'gone', 15)
      expect(w.s.wallet).toBe(P.DRILL_REWARD)
      expect(events(w, 'drillPush').length).toBe(1)
      expect(events(w, 'drillPaid').length).toBe(1)
      expect(events(w, 'drillCrewJoin').map(e => e.crew)).toEqual([1, 2])
      expect(joined).toBeLessThan(push)
    }
  })

  test('nobody joins a sortie in progress or a regrowing swarm, and nobody ever waits at the handle for the rats', () => {
    for (const dt of DTS) {
      const w = sim(dt)
      w.s.unlocks.ward2 = true
      withNurses(w)
      const s = w.s
      const { v: first } = loneAtHandle(w)
      // three more patients lie in beds C, B and D; their treatment is held back until the sortie starts
      const late = [bather(w, 1, 1), bather(w, 2, 2), bather(w, 3, 3)]
      const hold = () => {
        for (const v of late) s.beds[v.bed]!.lieT = 0
      }
      w.probe = hold
      runUntil(w, () => late.every(v => v.state === 'inBed'), 8)
      s.drill.loneT = P.DRILL_LONE_WAIT // the lone wait is over: the sortie starts in this step
      tick(w)
      expect(s.drill.state).toBe('pushing')
      const push = s.time
      // they hop off their beds while the cart is being pushed, during the coin burst and on its way back
      const hopOffAfter = [0.4, 1.2, 2.35]
      late.forEach((v, i) => (s.beds[v.bed]!.treatT = P.TREAT_END - hopOffAfter[i]!))
      let waitedForRats = 0
      w.probe = () => {
        expect(invariants(s)).toEqual([])
        if (!s.swarm.ready) for (const v of s.villagers) if (v !== first && CREW_STATES.includes(v.state)) waitedForRats++
        if (!s.swarm.ready) expect(s.drill.crew.length).toBeLessThanOrEqual(1)
      }
      runUntil(w, () => late.every(v => v.state === 'toExit' || v.state === 'gone'), 5)
      late.forEach((v, i) => expect(Math.abs(seenAt(w, v, 'toExit')! - (push + hopOffAfter[i]!))).toBeLessThan(3 * dt))
      // two more are healed while the rats trickle back
      const duringRegrow = [bather(w, 0, 0), bather(w, 1, 1)]
      runUntil(w, () => duringRegrow.every(v => v.state === 'gone'), 16)
      expect(s.swarm.ready).toBe(false)
      runUntil(w, () => first.state === 'gone' && late.every(v => v.state === 'gone'), 5)
      expect(waitedForRats).toBe(0)
      for (const v of [...late, ...duringRegrow]) for (const st of CREW_STATES) expect(seenAt(w, v, st)).toBeUndefined()
      expect(s.wallet).toBe(P.DRILL_REWARD)
      expect(events(w, 'drillPush').length).toBe(1)
      expect(s.stats.discharged).toBe(6)
      // once the swarm is back the next healed patient takes the handle again
      runUntil(w, () => s.swarm.ready, P.RAT_REGROW)
      const again = bather(w, 0, 0)
      runUntil(w, () => again.state === 'atDrill', 12)
      expect(s.drill.crew).toEqual([again.id])
    }
  })

  test('the sortie pays the reward exactly once, in whole gold, whatever the step length does', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const w = sim(1 / 60, seed)
      w.vary = makeRng(seed)
      if (seed % 2) w.s.unlocks.drill2 = true
      const reward = seed % 2 ? P.DRILL_REWARD_MK2 : P.DRILL_REWARD
      withNurses(w)
      bather(w, 0)
      bather(w, 1)
      let last = 0
      let steps = 0
      let maxJump = 0
      let maxDt = 0
      w.probe = (s, dt) => {
        expect(invariants(s)).toEqual([])
        expect(s.wallet).toBeGreaterThanOrEqual(last)
        if (s.wallet > last) steps++
        maxJump = Math.max(maxJump, s.wallet - last)
        maxDt = Math.max(maxDt, dt)
        last = s.wallet
        expect(s.drill.paid).toBeLessThanOrEqual(s.drill.reward)
        expect(s.stats.totalGold).toBe(s.wallet)
        expect(s.flags.firstSortiePaid === true).toBe(s.drill.sorties > 0)
      }
      runUntil(w, () => w.s.villagers.every(v => v.state === 'gone'), 40)
      expect(w.s.wallet).toBe(reward)
      expect(steps).toBeGreaterThan(20) // a count-up, not a jump
      // linear in the time since the heap lifted off: at most two steps' worth in one step (the lift-off step itself pays nothing)
      expect(maxJump).toBeLessThanOrEqual(Math.ceil((reward * 2 * maxDt) / P.DRILL_FLY_TO_HUD) + 1)
      expect(events(w, 'drillPaid')).toEqual([{ type: 'drillPaid', gold: reward }])
      expect(events(w, 'drillHeapLift')).toEqual([{ type: 'drillHeapLift', gold: reward }])
      expect(w.s.drill.x).toBe(L.DRILL_PARK.x)
      expect(w.s.drill.z).toBe(L.DRILL_PARK.z)
      expect(w.s.drill.heading).toBe(L.DRILL_PARK.heading)
    }
  })

  test('the cart and its crew move as one along PARK -> END and back; phases last what the config says', () => {
    for (const dt of DTS) {
      const w = sim(dt)
      withNurses(w)
      const a = bather(w, 0)
      const c = bather(w, 1)
      const s = w.s
      const span = Math.hypot(L.DRILL_END.x - L.DRILL_PARK.x, L.DRILL_END.z - L.DRILL_PARK.z)
      const entered = new Map<string, number>()
      let prevState = s.drill.state
      let offLine = 0
      let lastTravel = 0
      let fillAtPushEnd = -1
      let maxTurn = 0
      let facingError = 0
      const lastHeading = new Map<number, number>()
      w.probe = () => {
        const d = s.drill
        // nobody snaps round: the partner whose arrival starts the push turns to the push direction at a rate
        for (const v of [a, c]) {
          const h0 = lastHeading.get(v.id)
          if (h0 !== undefined && (v.state === 'atDrill' || v.state === 'pushing')) maxTurn = Math.max(maxTurn, Math.abs(Math.atan2(Math.sin(v.heading - h0), Math.cos(v.heading - h0))) / dt)
          lastHeading.set(v.id, v.heading)
          if (v.state === 'pushing' && d.state !== 'pushing') facingError = Math.max(facingError, Math.abs(Math.atan2(Math.sin(v.heading - d.heading), Math.cos(v.heading - d.heading))))
        }
        if (d.state !== prevState) entered.set(d.state, s.time)
        if (prevState === 'pushing' && d.state === 'burst') fillAtPushEnd = s.swarm.fill
        const dx = d.x - L.DRILL_PARK.x
        const dz = d.z - L.DRILL_PARK.z
        const travel = Math.hypot(dx, dz)
        // on the straight line between the two landmarks
        offLine = Math.max(offLine, Math.abs(dx * (L.DRILL_END.z - L.DRILL_PARK.z) - dz * (L.DRILL_END.x - L.DRILL_PARK.x)) / span)
        if (d.state === 'pushing') expect(travel).toBeGreaterThanOrEqual(lastTravel - 1e-9)
        if (d.state === 'return') expect(travel).toBeLessThanOrEqual(lastTravel + 1e-9)
        if (d.state === 'burst' || d.state === 'heap' || d.state === 'collect') expect(travel).toBeCloseTo(span, 6)
        if (d.state === 'parked') expect(travel).toBe(0)
        lastTravel = travel
        for (const v of [a, c]) {
          if (v.state !== 'pushing') continue
          expect(v.x).toBeCloseTo(crewSlotX(v.slot) + dx, 9)
          expect(v.z).toBeCloseTo(crewSlotZ(v.slot) + dz, 9)
          expect(v.y).toBe(0)
          expect(v.alpha).toBe(1)
        }
        if (d.state === 'parked') expect(d.spin === 0 || entered.has('parked')).toBe(true)
        prevState = d.state
      }
      runUntil(w, () => a.state === 'gone' && c.state === 'gone', 40)
      const tol = 2 * dt + 1e-9
      const push = entered.get('pushing')!
      expect(Math.abs(entered.get('burst')! - (push + P.DRILL_PUSH_TIME))).toBeLessThan(tol)
      expect(Math.abs(entered.get('heap')! - (push + P.DRILL_PUSH_TIME + P.DRILL_COIN_FOUNTAIN))).toBeLessThan(tol)
      expect(Math.abs(entered.get('collect')! - (push + P.DRILL_PUSH_TIME + P.DRILL_COIN_FOUNTAIN + P.DRILL_HEAP_HOLD))).toBeLessThan(tol)
      const paid = push + P.DRILL_PUSH_TIME + P.DRILL_COIN_FOUNTAIN + P.DRILL_HEAP_HOLD + P.DRILL_FLY_TO_HUD
      expect(Math.abs(entered.get('return')! - paid)).toBeLessThan(tol)
      expect(Math.abs(entered.get('parked')! - (paid + P.DRILL_RETURN_TIME))).toBeLessThan(tol)
      expect(Math.abs(times(w, 'drillKill')[0]! - (push + P.DRILL_KILL_START))).toBeLessThan(tol)
      expect(offLine).toBeLessThan(1e-9)
      expect(maxTurn).toBeLessThan(30) // rad/s; a snap of a quarter turn in one step would be 90 and more
      expect(facingError).toBeLessThan(0.01) // and by the end of the push both face the way they pushed
      expect(fillAtPushEnd).toBeCloseTo(1 - P.RATS_KILLED_PER_SORTIE / P.RAT_COUNT, 2)
      // the crew is released where the handle is and walks off; nobody is left at the cart
      for (const v of [a, c]) {
        expect(v.slot).toBe(-1)
        expect(Math.hypot(v.x - L.SOUTH_EXIT.x, v.z - L.SOUTH_EXIT.z)).toBeLessThan(0.3)
      }
      // swarm: ready again RAT_REGROW after the push began, exactly once
      runUntil(w, () => s.swarm.ready, P.RAT_REGROW)
      expect(Math.abs(times(w, 'swarmReady')[0]! - (push + P.RAT_REGROW))).toBeLessThan(tol)
      run(w, 30)
      expect(events(w, 'swarmReady').length).toBe(1)
    }
  })

  test('Mk II bought during a sortie: that sortie still pays 250, the next one 500', () => {
    const w = sim()
    withNurses(w)
    const s = w.s
    bather(w, 0)
    bather(w, 1)
    runUntil(w, () => s.drill.state === 'burst', 30)
    s.unlocks.drill2 = true
    runUntil(w, () => s.villagers.every(v => v.state === 'gone'), 20)
    expect(s.wallet).toBe(P.DRILL_REWARD)
    expect(s.swarm.regrowT).toBeLessThanOrEqual(P.RAT_REGROW_MK2)
    runUntil(w, () => s.swarm.ready, P.RAT_REGROW_MK2 + 1)
    bather(w, 0)
    bather(w, 1)
    runUntil(w, () => s.villagers.every(v => v.state === 'gone'), 40)
    expect(s.wallet).toBe(P.DRILL_REWARD + P.DRILL_REWARD_MK2)
    expect(events(w, 'drillPaid').map(e => e.gold)).toEqual([P.DRILL_REWARD, P.DRILL_REWARD_MK2])
  })

  test('four patients healed in the same step: two crew the drill, two walk out, nobody collides at the handle', () => {
    for (const dt of DTS) {
      const w = sim(dt)
      w.s.unlocks.nurses = true
      run(w, 2)
      const vs = [0, 1, 2, 3].map(i => bather(w, i))
      runUntil(w, () => vs.every(v => v.state === 'inBed'), 8)
      for (const b of w.s.beds) if (b.ward === 1) b.lieT = P.NURSE_START_DELAY
      w.probe = s => expect(invariants(s)).toEqual([])
      runUntil(w, () => vs.some(v => v.state === 'atDrill'), 10)
      runUntil(w, () => vs.every(v => v.state === 'gone'), 30)
      expect(times(w, 'healed').every(t => Math.abs(t - times(w, 'healed')[0]!) < 1e-9)).toBe(true)
      const crewed = vs.filter(v => seenAt(w, v, 'pushing') !== undefined)
      expect(crewed.length).toBe(2)
      expect(events(w, 'drillCrewJoin').map(e => e.crew)).toEqual([1, 2])
      expect(new Set(events(w, 'drillCrewJoin').map(e => e.id))).toEqual(new Set(crewed.map(v => v.id)))
      expect(w.s.wallet).toBe(P.DRILL_REWARD)
      expect(w.s.stats.discharged).toBe(4)
    }
  })
})

describe('leaving the map', () => {
  test('doors are fully open when a villager passes them and shut again afterwards', () => {
    for (const dt of DTS) {
      for (const bed of [0, 1, 2, 3, 4, 6, 7, 9]) {
        for (const crew of [false, true]) {
          const w = sim(dt)
          w.s.unlocks.ward2 = true
          withNurses(w)
          if (!crew) noRats(w)
          const v = bather(w, 0, bed)
          const south = BEDS[bed]!.ward === 1
          let prevZ = v.z
          let crossed = 0
          let otherDoor = 0
          w.probe = s => {
            if (south && prevZ < L.WARD1_DOOR.z && v.z >= L.WARD1_DOOR.z) {
              crossed++
              expect(s.doors.south).toBe(1)
            }
            if (!south && prevZ > L.NORTH_DOOR.z && v.z <= L.NORTH_DOOR.z) {
              crossed++
              expect(s.doors.north).toBe(1)
            }
            otherDoor = Math.max(otherDoor, south ? s.doors.north : s.doors.south)
            if (v.state === 'toBed' || v.state === 'inBed') expect(s.doors.south + s.doors.north).toBe(0)
            prevZ = v.z
          }
          runUntil(w, () => v.state === 'gone', 40)
          expect(crossed).toBe(1)
          expect(otherDoor).toBe(0)
          run(w, 1)
          expect(w.s.doors).toEqual({ south: 0, north: 0 })
        }
      }
    }
  })

  test('a fading villager fades at one rate, is counted once and stays gone even if nobody removes him', () => {
    for (const dt of DTS) {
      const w = sim(dt)
      w.s.unlocks.ward2 = true
      withNurses(w)
      const vs = [bather(w, 0), bather(w, 1), bather(w, 2, 5), bather(w, 3, -1)]
      const fadeStart = new Map<number, number>()
      const goneAt = new Map<number, number>()
      w.probe = s => {
        for (const v of vs) {
          if (v.alpha < 1 && !fadeStart.has(v.id)) fadeStart.set(v.id, s.time)
          if (v.state === 'gone' && !goneAt.has(v.id)) goneAt.set(v.id, s.time)
          if (v.state === 'gone') expect(v.alpha).toBe(0)
        }
      }
      runUntil(w, () => vs.every(v => v.state === 'gone'), 40)
      for (const v of vs) expect(Math.abs(goneAt.get(v.id)! - fadeStart.get(v.id)! - 1)).toBeLessThan(2 * dt + 1e-9)
      const n = w.s.stats.discharged
      expect(n).toBe(4)
      run(w, 30)
      expect(w.s.stats.discharged).toBe(n)
      expect(events(w, 'discharged').map(e => e.count)).toEqual([1, 2, 3, 4])
      expect(new Set(events(w, 'discharged').map(e => e.id)).size).toBe(4)
      expect(w.s.villagers.length).toBe(4)
    }
  })

  test('walkers sharing a lane keep apart and still all arrive', () => {
    for (const dt of DTS) {
      const w = sim(dt)
      w.s.unlocks.ward2 = true
      withNurses(w)
      noRats(w)
      // ten bathers leave the same exit point at the same instant
      const vs = BEDS.map((_, i) => bather(w, 0))
      expect(freeBedCount(w.s)).toBe(0)
      let closeSteps = 0
      let steps = 0
      w.probe = s => {
        expect(invariants(s)).toEqual([])
        if (s.time < 2.6) return
        steps++
        const walking = vs.filter(v => (v.state === 'toBed' || v.state === 'toExit') && v.alpha >= 1)
        for (let i = 0; i < walking.length; i++) for (let j = i + 1; j < walking.length; j++) if (Math.hypot(walking[i]!.x - walking[j]!.x, walking[i]!.z - walking[j]!.z) < 0.25) closeSteps++
      }
      runUntil(w, () => vs.every(v => v.state === 'gone'), 60)
      expect(events(w, 'patientLie').length).toBe(10)
      expect(new Set(events(w, 'patientLie').map(e => e.bed)).size).toBe(10)
      expect(w.s.stats.discharged).toBe(10)
      expect(closeSteps).toBeLessThan(steps * 0.05)
    }
  })
})

describe('step-length independence', () => {
  /** A fixed timetable of hand-overs; everything else follows from the package. */
  function scripted(dt: number) {
    const w = sim(dt)
    const s = w.s
    const r = makeRng(99)
    const plan: number[] = []
    let t = 0.5
    for (let i = 0; i < 70; i++) {
      t += randRange(r, 0.3, 2.2)
      plan.push(t)
    }
    let next = 0
    let fed = 0
    let skipped = 0
    w.sweep = true
    w.probe = st => expect(invariants(st)).toEqual([])
    while (next < plan.length || s.villagers.length > 0) {
      if (s.time > 600) throw new Error('stuck')
      if (s.time >= 6) s.unlocks.nurses = true
      if (s.time >= 45) s.unlocks.ward2 = true
      if (s.time >= 90) s.unlocks.drill2 = true
      while (next < plan.length && s.time >= plan[next]!) {
        next++
        if (freeBedCount(s) > 0) {
          bather(w, fed)
          fed++
        } else skipped++
      }
      tick(w)
    }
    return { w, fed, skipped }
  }

  /**
   * Hand-overs at fixed times into fixed beds, laid out so that no decision is a close call (a crew decision is
   * never within a second of the swarm becoming ready, a bed is never reused within 12 s). [time, bed, bath exit]
   */
  const TIMETABLE: readonly (readonly [number, number, number])[] = [
    [1.0, 0, 0], [1.0, 1, 1], // the first pair: sortie 1
    [1.5, 2, 2], // healed while the crew is full: walks out
    [12, 3, 3], // healed while the rats regrow: walks out
    [33, 0, 0], // alone: sortie 2 after the lone wait
    [46, 4, 0], [48, 5, 1], [50, 6, 2], [52, 7, 3], [54, 8, 0], [56, 9, 1], [62, 4, 2], [64, 7, 3], // ward 2 (bought at 45 s)
    [75, 0, 0], [75, 1, 1], // sortie 3, with Mk II (bought at 80 s)
    [86, 2, 2], // healed 1.7 s before the Mk II swarm is back: walks out
    [100, 3, 3], // alone again: sortie 4
  ]

  function timetabled(dt: number) {
    const w = sim(dt)
    const s = w.s
    s.unlocks.nurses = true
    let next = 0
    w.sweep = true
    w.probe = st => expect(invariants(st)).toEqual([])
    while (next < TIMETABLE.length || s.villagers.length > 0) {
      if (s.time > 300) throw new Error('stuck')
      if (s.time >= 45) s.unlocks.ward2 = true
      if (s.time >= 80) s.unlocks.drill2 = true
      while (next < TIMETABLE.length && s.time >= TIMETABLE[next]![0] - 1e-9) {
        const [, bed, exit] = TIMETABLE[next++]!
        expect(bather(w, exit, bed).state).toBe('toBed')
      }
      tick(w)
    }
    return w
  }

  test('a timetabled two-minute run gives the same story at 60, 97 and 144 steps per second', () => {
    const runs = DTS.map(timetabled)
    const base = runs[0]!
    expect(base.s.stats.discharged).toBe(TIMETABLE.length)
    expect(events(base, 'drillPaid').map(e => e.gold)).toEqual([P.DRILL_REWARD, P.DRILL_REWARD, P.DRILL_REWARD_MK2, P.DRILL_REWARD_MK2])
    expect(events(base, 'drillCrewJoin').map(e => e.crew)).toEqual([1, 2, 1, 1, 2, 1])
    expect(base.s.wallet).toBe(2 * P.DRILL_REWARD + 2 * P.DRILL_REWARD_MK2)
    const order = (w: Sim, type: 'patientLie' | 'healed') => events(w, type).map(e => e.bed)
    for (const other of runs.slice(1)) {
      expect(other.s.stats.discharged).toBe(base.s.stats.discharged)
      expect(other.s.wallet).toBe(base.s.wallet)
      expect(other.s.drill.sorties).toBe(base.s.drill.sorties)
      expect(order(other, 'patientLie')).toEqual(order(base, 'patientLie'))
      expect(order(other, 'healed')).toEqual(order(base, 'healed'))
      for (const type of ['patientLie', 'treatStart', 'treatJab', 'healed', 'drillCrewJoin', 'drillPush', 'drillKill', 'drillHeapLift', 'drillPaid', 'swarmReady', 'discharged', 'nursesSpawn'] as const) {
        const a = times(base, type)
        const b = times(other, type)
        expect(b.length).toBe(a.length)
        // a handful of step boundaries along the way (hand-over, lie-down, treatment start, hop-off, handle)
        for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(0.06)
      }
    }
  })

  test('a random plan discharges everybody at every step length', () => {
    for (const dt of DTS) {
      const { w, fed, skipped } = scripted(dt)
      expect(fed + skipped).toBe(70)
      expect(fed).toBeGreaterThan(50)
      expect(w.s.stats.discharged).toBe(fed)
      expect(w.s.drill.sorties).toBeGreaterThan(2)
    }
  })

  test('the same seed and step length reproduce the run exactly (no Math.random, no clock)', () => {
    const snapshot = () => {
      const { w } = scripted(1 / 60)
      return JSON.stringify(w.log)
    }
    expect(snapshot()).toBe(snapshot())
  })
})

describe('seeded fuzz', () => {
  /** Random hand-overs (some of them broken), random unlock times, a new step length every step. */
  function fuzz(seed: number, total: number) {
    const w = sim(1 / 60, seed)
    const s = w.s
    const r = makeRng(seed * 7919 + 1)
    w.vary = makeRng(seed * 104729 + 3)
    w.sweep = true
    const tNurses = randRange(r, 0, 30)
    const tWard2 = randRange(r, 0, 80)
    const tDrill2 = randRange(r, 0, 120)
    let fed = 0
    let nextFeed = 0
    let peak = 0
    w.probe = st => {
      const bad = invariants(st)
      if (bad.length) throw new Error(`seed ${seed} at ${st.time.toFixed(3)} s: ${bad.join('; ')}`)
      peak = Math.max(peak, st.villagers.length)
    }
    while (fed < total || s.villagers.length > 0) {
      if (s.time > 3000) throw new Error(`seed ${seed} stuck: ${s.stats.discharged}/${fed}, ${s.villagers.map(v => v.state)}, drill ${s.drill.state}`)
      if (s.time > tNurses) s.unlocks.nurses = true
      if (s.time > tWard2) s.unlocks.ward2 = true
      if (s.time > tDrill2) s.unlocks.drill2 = true
      if (fed < total && s.time >= nextFeed) {
        const batch = 1 + Math.floor(rand(r) * 4)
        for (let i = 0; i < batch && fed < total; i++) {
          const k = rand(r)
          if (k < 0.05) bather(w, i, -1)
          else if (k < 0.1) bather(w, i, Math.floor(rand(r) * 12))
          else if (freeBedCount(s) > 0) bather(w, i)
          else continue
          fed++
        }
        nextFeed = s.time + randRange(r, 0.05, 2.5)
      }
      tick(w)
    }
    run(w, 2)
    expect(s.stats.discharged).toBe(fed)
    const ids = events(w, 'discharged').map(e => e.id)
    expect(new Set(ids).size).toBe(fed)
    expect(events(w, 'discharged').map(e => e.count)).toEqual(ids.map((_, i) => i + 1))
    expect(events(w, 'healed').length).toBe(events(w, 'patientLie').length)
    expect(events(w, 'treatStart').length).toBe(events(w, 'patientLie').length)
    expect(s.beds.every(b => b.state === 'free' && b.villager === -1 && b.treatT === -1)).toBe(true)
    expect(s.nurses.every(n => n.state === 'idle')).toBe(true)
    expect(s.drill.state).toBe('parked')
    expect(s.drill.crew.length).toBe(0)
    expect(s.wallet).toBe(events(w, 'drillPaid').reduce((sum, e) => sum + e.gold, 0))
    expect(events(w, 'drillPush').length).toBe(s.drill.sorties)
    expect(events(w, 'drillKill').length).toBe(s.drill.sorties)
    expect(events(w, 'swarmReady').length).toBeGreaterThanOrEqual(s.drill.sorties - 1)
    expect(events(w, 'swarmReady').length).toBeLessThanOrEqual(s.drill.sorties)
    expect(peak).toBeGreaterThan(3)
    return w
  }

  test('40 random games of 60 patients each: every invariant holds after every step and everybody is discharged', () => {
    for (let seed = 1; seed <= 40; seed++) fuzz(seed, 60)
  })

  test('one long random game of 400 patients', () => {
    fuzz(4242, 400)
  })
})

describe('together with the crowd and the bath', () => {
  // The production systems drive this block, so nothing here may depend on how they behave: only on what the ward
  // does with the villagers it is handed. (With stub packages nobody is handed over and the checks are vacuous.)
  // The river, the player and the economy are left out: they do not touch the ward and cost most of a step.
  for (const dt of [1 / 60, 1 / 144]) {
    test(`every villager the bath hands over ends up discharged, at ${Math.round(1 / dt)} Hz`, () => {
      const s = createState(11)
      s.unlocks.nurses = true
      s.unlocks.usher = true
      const handed = new Set<number>()
      const discharged = new Set<number>()
      let lastHandOver = 0
      const advance = () => {
        s.time += dt
        s.cauldron.potion = s.cauldron.capacity
        stepCrowd(s, dt)
        stepBath(s, dt)
        stepWard(s, dt)
        stepDrill(s, dt)
        for (const e of s.events) if (e.type === 'discharged') discharged.add(e.id)
        s.events.length = 0
        for (const v of s.villagers) {
          if (v.state !== 'toBed' || handed.has(v.id)) continue
          handed.add(v.id)
          lastHandOver = s.time
          expect(v.look).toBe('bathed')
          expect(s.beds[v.bed]?.villager).toBe(v.id)
        }
        const bad = invariants(s)
        if (bad.length) throw new Error(`at ${s.time.toFixed(3)} s: ${bad.join('; ')}`)
        stepGuide(s, dt) // removes the 'gone' villagers
      }
      while (s.time < 150) {
        if (s.time > 40) s.unlocks.ward2 = true
        if (s.time > 90) s.unlocks.drill2 = true
        advance()
      }
      // whoever was handed over more than a bed cycle plus a lone drill wait ago must be out by now
      const cutoff = s.time
      const settled = new Set(handed)
      while (s.time < cutoff + 30) advance()
      for (const id of settled) expect(discharged.has(id)).toBe(true)
      expect(s.stats.discharged).toBe(discharged.size)
      if (handed.size > 0) expect(lastHandOver).toBeGreaterThan(0)
    })
  }
})
