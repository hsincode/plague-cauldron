// Ward package: beds, nurses, healed patients (sim/ward.ts) and the drill sortie / rat swarm (sim/drill.ts).
// Scenarios drive stepWard + stepDrill directly, so they do not depend on the other packages.
import { describe, expect, test } from 'bun:test'
import { BEDS, L, P, UNLOCKS } from '../src/config'
import { makeRng, rand, randRange } from '../src/core/rng'
import { freeBedCount, reserveBed } from '../src/sim/beds'
import { crewSlotX, crewSlotZ, stepDrill } from '../src/sim/drill'
import type { EventOf, EventType, GameEvent } from '../src/sim/events'
import { createState } from '../src/sim/state'
import type { GameState, Villager, VillagerState } from '../src/sim/types'
import { BED_LIE_Y, EXIT_FADE, sendToBed, stepWard } from '../src/sim/ward'

const DT = 1 / 60

interface Sim {
  s: GameState
  dt: number
  /** Every event with the simulated time of the step that emitted it (the host drains s.events the same way). */
  log: { t: number; e: GameEvent }[]
  /** First time each villager was seen in each state, keyed `${id}:${state}`. */
  firstSeen: Map<string, number>
  /** Called after every step. */
  probe: ((s: GameState) => void) | null
}

function sim(dt = DT, seed = 1): Sim {
  return { s: createState(seed), dt, log: [], firstSeen: new Map(), probe: null }
}

function tick(w: Sim) {
  const s = w.s
  s.time += w.dt
  stepWard(s, w.dt)
  stepDrill(s, w.dt)
  for (const e of s.events) w.log.push({ t: s.time, e })
  s.events.length = 0
  for (const v of s.villagers) {
    const k = `${v.id}:${v.state}`
    if (!w.firstSeen.has(k)) w.firstSeen.set(k, s.time)
  }
  w.probe?.(s)
}

function run(w: Sim, seconds: number) {
  const n = Math.round(seconds / w.dt)
  for (let i = 0; i < n; i++) tick(w)
}

/** Steps until pred holds; fails the test if it does not within `max` simulated seconds. Returns s.time. */
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
/** Two step lengths of slack: discrete transitions land on a step boundary. */
const near = (w: Sim, actual: number | undefined, expected: number) => {
  expect(actual).toBeDefined()
  expect(Math.abs(actual! - expected)).toBeLessThan(2 * w.dt + 1e-9)
}

/** A villager that has just landed outside the pot, as the bath hands him over. `bed` undefined = reserve one. */
function bather(w: Sim, exit = 0, bed?: number): Villager {
  const s = w.s
  const e = L.BATH_EXITS[exit % L.BATH_EXITS.length]!
  const id = s.nextId++
  // Cast, not annotated: a field another package adds to Villager later must not break this file.
  const v = {
    id, state: 'hopOut', t: 0, x: e.x, z: e.z, y: 0, heading: Math.PI / 2, look: 'sick', path: [], pathI: 0, speed: 0,
    slot: exit, bed: bed ?? reserveBed(s, id), fromX: e.x, fromZ: e.z, toX: e.x, toZ: e.z, delay: 0, seed: 0.5, alpha: 1,
  } as Villager
  s.villagers.push(v)
  sendToBed(s, v)
  return v
}

const insideBed = (x: number, z: number, onlyExisting: GameState) =>
  BEDS.some(b => onlyExisting.beds[b.id]!.exists && Math.abs(x - b.x) < P.BED_W / 2 && Math.abs(z - b.z) < P.BED_D / 2)

const postOf = (bed: number) => ({ x: BEDS[bed]!.x + L.NURSE_POST.x, z: BEDS[bed]!.z + L.NURSE_POST.z })

/** Nurses bought and standing at their posts. */
function withNurses(w: Sim) {
  w.s.unlocks.nurses = true
  run(w, 2)
  expect(w.s.nurses.every(n => n.state === 'idle')).toBe(true)
}

describe('patient to bed', () => {
  test('a bathed villager walks to his reserved bed and lies down', () => {
    const w = sim()
    const v = bather(w)
    expect(v.state).toBe('toBed')
    expect(v.look).toBe('bathed')
    expect(v.speed).toBe(P.BATHED_WALK_SPEED)
    expect(v.bed).toBe(0)
    expect(w.s.beds[0]!.state).toBe('reserved')

    let nearEntry = Infinity
    let nearSide = Infinity
    w.probe = () => {
      if (v.state !== 'toBed') return
      nearEntry = Math.min(nearEntry, Math.hypot(v.x - L.WARD1_ENTRY.x, v.z - L.WARD1_ENTRY.z))
      nearSide = Math.min(nearSide, Math.hypot(v.x - (BEDS[0]!.x + L.BED_SIDE.x), v.z - (BEDS[0]!.z + L.BED_SIDE.z)))
    }
    const t = runUntil(w, () => v.state === 'inBed', 5)
    // SPEC 2.10: bed A is reached about 1.3 s after leaving the pot, then a 0.3 s roll onto it.
    expect(t).toBeGreaterThan(1.3)
    expect(t).toBeLessThan(2.3)
    expect(nearEntry).toBeLessThan(0.1)
    expect(nearSide).toBeLessThan(0.1)
    near(w, seenAt(w, v, 'inBed')! - seenAt(w, v, 'lieDown')!, P.LIE_DOWN_TIME)
    expect(v.x).toBeCloseTo(BEDS[0]!.x)
    expect(v.z).toBeCloseTo(BEDS[0]!.z)
    expect(v.y).toBeCloseTo(BED_LIE_Y)
    expect(v.look).toBe('bathed')
    expect(w.s.beds[0]!.state).toBe('occupied')
    expect(w.s.beds[0]!.villager).toBe(v.id)
    expect(events(w, 'patientLie')).toEqual([{ type: 'patientLie', bed: 0, id: v.id }])
  })

  test('every ward-1 bed is reached without walking through a bed', () => {
    const w = sim()
    let clipped = 0
    w.probe = s => {
      for (const v of s.villagers) if (v.state === 'toBed' && insideBed(v.x, v.z, s)) clipped++
    }
    const vs = [0, 1, 2, 3].map(i => bather(w, i))
    expect(vs.map(v => v.bed).sort()).toEqual([0, 1, 2, 3])
    runUntil(w, () => vs.every(v => v.state === 'inBed'), 8)
    for (const v of vs) {
      expect(v.x).toBeCloseTo(BEDS[v.bed]!.x)
      expect(v.z).toBeCloseTo(BEDS[v.bed]!.z)
      expect(w.s.beds[v.bed]!.state).toBe('occupied')
    }
    expect(clipped).toBe(0)
    expect(freeBedCount(w.s)).toBe(0)
  })

  test('without nurses he stays in bed and needsNurse fires exactly once', () => {
    const w = sim()
    const v = bather(w)
    const lay = runUntil(w, () => v.state === 'inBed', 5)
    run(w, 20)
    expect(v.state).toBe('inBed')
    expect(v.look).toBe('bathed')
    const bed = w.s.beds[0]!
    expect(bed.state).toBe('occupied')
    expect(bed.treatT).toBe(-1)
    expect(bed.lieT).toBeCloseTo(20, 1)
    expect(events(w, 'needsNurse')).toEqual([{ type: 'needsNurse', bed: 0 }])
    near(w, times(w, 'needsNurse')[0], lay + P.NEEDS_NURSE_DELAY)
    expect(events(w, 'treatStart').length).toBe(0)
    expect(w.s.stats.discharged).toBe(0)
  })

  test('a villager without a bed of his own is sent home instead of waiting forever', () => {
    const w = sim()
    const lost = bather(w, 0, -1)
    expect(lost.state).toBe('toExit')
    expect(lost.look).toBe('healed')
    const owner = bather(w, 1) // owns bed 0
    const intruder = bather(w, 2, owner.bed)
    expect(intruder.state).toBe('toExit')
    expect(w.s.beds[owner.bed]!.villager).toBe(owner.id)
    runUntil(w, () => lost.state === 'gone' && intruder.state === 'gone', 10)
    expect(w.s.stats.discharged).toBe(2)
    expect(w.s.drill.crew.length).toBe(0)
    expect(owner.state).toBe('inBed')
  })
})

describe('nurses', () => {
  test('they spawn at the pad when the flag is set and run to their posts', () => {
    const w = sim()
    run(w, 1)
    expect(w.s.nurses.length).toBe(0)
    w.s.unlocks.nurses = true
    tick(w)
    const pad = UNLOCKS.find(u => u.id === 'nurses')!
    expect(w.s.nurses.length).toBe(4)
    expect(w.s.nurses.map(n => n.bed).sort()).toEqual([0, 1, 2, 3])
    for (const n of w.s.nurses) {
      expect(n.state).toBe('running')
      expect(Math.hypot(n.x - pad.x, n.z - pad.z)).toBeLessThan(0.8)
    }
    expect(events(w, 'nursesSpawn')).toEqual([{ type: 'nursesSpawn', ward: 1, x: pad.x, z: pad.z }])

    const t0 = w.s.time
    const arrived = runUntil(w, () => w.s.nurses.every(n => n.state !== 'running'), 3)
    expect(arrived - t0).toBeLessThan(1.3) // SPEC 3.2: about 0.9 s at 6.5 m/s
    run(w, 1)
    for (const n of w.s.nurses) {
      const p = postOf(n.bed)
      expect(n.x).toBeCloseTo(p.x)
      expect(n.z).toBeCloseTo(p.z)
      expect(n.state).toBe('idle')
      expect(Math.cos(n.heading)).toBeLessThan(-0.99) // facing the bed (north)
      expect(n.age).toBeGreaterThan(1.5)
    }
    expect(w.s.nurses.length).toBe(4)
    expect(events(w, 'nursesSpawn').length).toBe(1)
  })

  test('treatment waits NURSE_START_DELAY after lying down, then follows the timeline', () => {
    const w = sim()
    withNurses(w)
    const v = bather(w)
    const bed = w.s.beds[0]!
    const nurse = w.s.nurses.find(n => n.bed === 0)!
    const lay = runUntil(w, () => v.state === 'inBed', 5)

    run(w, P.NURSE_START_DELAY - 0.1)
    expect(bed.treatT).toBe(-1)
    expect(nurse.state).toBe('idle')
    expect(v.look).toBe('bathed')

    const t0 = lay + P.NURSE_START_DELAY
    runUntil(w, () => bed.treatT >= 0, 1)
    expect(nurse.state).toBe('treating')
    runUntil(w, () => v.state === 'toDrill' || v.state === 'toExit', 5)

    near(w, times(w, 'treatStart')[0], t0)
    near(w, times(w, 'treatJab')[0], t0 + P.TREAT_JAB)
    near(w, times(w, 'healed')[0], t0 + P.TREATMENT_TIME)
    near(w, seenAt(w, v, 'cheer'), t0 + P.TREAT_SIT_UP)
    near(w, seenAt(w, v, 'hopOff'), t0 + P.TREAT_HOP_OFF)
    near(w, w.s.time, t0 + P.TREAT_END)
    expect(events(w, 'healed')).toEqual([{ type: 'healed', bed: 0, id: v.id, x: BEDS[0]!.x, z: BEDS[0]!.z }])
    expect(events(w, 'needsNurse').length).toBe(0)

    // the bed is free again and he stands beside it, healed
    expect(bed.state).toBe('free')
    expect(bed.villager).toBe(-1)
    expect(bed.treatT).toBe(-1)
    expect(freeBedCount(w.s)).toBe(4)
    expect(v.look).toBe('healed')
    expect(v.bed).toBe(-1)
    expect(v.y).toBe(0)
    expect(Math.hypot(v.x - (BEDS[0]!.x + L.BED_SIDE.x), v.z - (BEDS[0]!.z + L.BED_SIDE.z))).toBeLessThan(0.3)
    expect(v.speed).toBe(P.HEALED_RUN_SPEED)
    tick(w)
    expect(nurse.state).toBe('idle')
  })

  test('a patient who has lain long enough is treated the moment his nurse reaches her post', () => {
    const w = sim()
    const v = bather(w)
    runUntil(w, () => v.state === 'inBed', 5)
    run(w, 5)
    expect(events(w, 'needsNurse').length).toBe(1)
    w.s.unlocks.nurses = true
    const bought = w.s.time
    const nurse = () => w.s.nurses.find(n => n.bed === 0)
    const atPost = runUntil(w, () => nurse()?.state !== undefined && nurse()!.state !== 'running', 3)
    expect(atPost - bought).toBeGreaterThan(0.3)
    near(w, times(w, 'treatStart')[0], atPost)
    runUntil(w, () => w.s.beds[0]!.state === 'free', 5)
    near(w, w.s.time, atPost + P.TREAT_END)
    expect(events(w, 'needsNurse').length).toBe(1)
  })

  test('a bed is freed by its own timeline even if its patient is unknown', () => {
    const w = sim()
    withNurses(w)
    const bed = w.s.beds[2]!
    bed.state = 'occupied'
    bed.villager = 4242
    run(w, P.NURSE_START_DELAY + P.TREAT_END + 0.1)
    expect(w.s.beds[2]!.state).toBe('free')
    expect(w.s.beds[2]!.villager).toBe(-1)
  })
})

describe('ward 2', () => {
  test('beds and nurses appear on the flag; patients are treated there and leave by the north door', () => {
    const w = sim()
    withNurses(w)
    expect(w.s.beds.filter(b => b.exists).length).toBe(4)
    w.s.unlocks.ward2 = true
    tick(w)
    expect(w.s.beds.filter(b => b.exists).length).toBe(10)
    for (const b of w.s.beds.filter(b => b.ward === 2)) {
      expect(b.age).toBeLessThan(0.05)
      expect(b.state).toBe('free')
      const n = w.s.nurses.find(n => n.bed === b.id)!
      expect(n.state).toBe('idle')
      expect(n.x).toBeCloseTo(postOf(b.id).x)
      expect(n.z).toBeCloseTo(postOf(b.id).z)
    }
    expect(w.s.nurses.length).toBe(10)
    expect(events(w, 'nursesSpawn').filter(e => e.ward === 2).length).toBe(1)
    expect(w.s.beds[0]!.age).toBeGreaterThan(99)

    for (let i = 0; i < 4; i++) reserveBed(w.s, 9000 + i) // ward 1 is full
    const v = bather(w)
    expect(v.bed).toBe(4)
    const def = BEDS[4]!
    const nearEntry = L.WARD2_ENTRY.map(() => Infinity)
    let nearDoor = Infinity
    let clipped = 0
    let northOpen = 0
    const drillStates: VillagerState[] = ['toDrill', 'atDrill', 'pushing']
    let crewed = false
    w.probe = s => {
      L.WARD2_ENTRY.forEach((p, i) => (nearEntry[i] = Math.min(nearEntry[i]!, Math.hypot(v.x - p.x, v.z - p.z))))
      nearDoor = Math.min(nearDoor, Math.hypot(v.x - L.NORTH_DOOR.x, v.z - L.NORTH_DOOR.z))
      if ((v.state === 'toBed' || v.state === 'toExit') && insideBed(v.x, v.z, s)) clipped++
      northOpen = Math.max(northOpen, s.doors.north)
      if (drillStates.includes(v.state)) crewed = true
      expect(s.doors.south).toBe(0)
    }
    runUntil(w, () => v.state === 'inBed', 10)
    expect(v.x).toBeCloseTo(def.x)
    expect(v.z).toBeCloseTo(def.z)
    for (const d of nearEntry) expect(d).toBeLessThan(0.1)

    runUntil(w, () => v.state === 'gone', 15)
    expect(v.look).toBe('healed')
    expect(nearDoor).toBeLessThan(0.1)
    expect(Math.hypot(v.x - L.NORTH_EXIT.x, v.z - L.NORTH_EXIT.z)).toBeLessThan(0.3)
    expect(clipped).toBe(0)
    expect(crewed).toBe(false)
    expect(northOpen).toBe(1)
    expect(w.s.stats.discharged).toBe(1)
    expect(w.s.wallet).toBe(0)
    expect(w.s.beds[4]!.state).toBe('free')
    run(w, 1)
    expect(w.s.doors.north).toBe(0)
  })
})

/** Two patients in beds A and C with nurses waiting: the first minute of the ad up to the sortie. */
function firstPair(dt = DT) {
  const w = sim(dt)
  withNurses(w)
  const a = bather(w, 0)
  const c = bather(w, 1)
  return { w, a, c }
}

describe('drill sortie', () => {
  test('the first two healed ward-1 patients crew the drill and the wallet gets +250', () => {
    const { w, a, c } = firstPair()
    const s = w.s
    let maxTravel = 0
    let handleError = 0
    let southOpen = 0
    let walletDuringFly: number[] = []
    w.probe = () => {
      maxTravel = Math.max(maxTravel, Math.hypot(s.drill.x - L.DRILL_PARK.x, s.drill.z - L.DRILL_PARK.z))
      southOpen = Math.max(southOpen, s.doors.south)
      for (const v of [a, c]) {
        if (v.state !== 'pushing') continue
        const ex = crewSlotX(v.slot) + s.drill.x - L.DRILL_PARK.x
        const ez = crewSlotZ(v.slot) + s.drill.z - L.DRILL_PARK.z
        handleError = Math.max(handleError, Math.hypot(v.x - ex, v.z - ez))
      }
      if (s.drill.state === 'collect') walletDuringFly.push(s.wallet)
    }
    runUntil(w, () => s.flags.firstSortiePaid === true, 30)
    expect(s.wallet).toBe(P.DRILL_REWARD)
    expect(s.wallet).toBe(250)
    expect(s.stats.totalGold).toBe(250)
    expect(s.drill.sorties).toBe(1)
    expect(s.drill.paid).toBe(250)

    const joins = events(w, 'drillCrewJoin')
    expect(joins.map(j => j.crew)).toEqual([1, 2])
    expect(joins.map(j => j.id).sort()).toEqual([a.id, c.id].sort())
    const push = times(w, 'drillPush')[0]!
    near(w, push, times(w, 'drillCrewJoin')[1]!)
    near(w, times(w, 'drillKill')[0], push + P.DRILL_KILL_START)
    const lift = push + P.DRILL_PUSH_TIME + P.DRILL_COIN_FOUNTAIN + P.DRILL_HEAP_HOLD
    near(w, times(w, 'drillHeapLift')[0], lift)
    near(w, times(w, 'drillPaid')[0], lift + P.DRILL_FLY_TO_HUD)
    expect(events(w, 'drillKill')[0]).toEqual({ type: 'drillKill', x: L.DRILL_END.x, z: L.DRILL_END.z, rats: P.RATS_KILLED_PER_SORTIE })
    expect(events(w, 'drillHeapLift')[0]!.gold).toBe(250)
    expect(events(w, 'drillPaid')).toEqual([{ type: 'drillPaid', gold: 250 }])

    // the cart went all the way into the swarm with the crew on the handle, and the coins counted up
    expect(maxTravel).toBeCloseTo(Math.hypot(L.DRILL_END.x - L.DRILL_PARK.x, L.DRILL_END.z - L.DRILL_PARK.z), 2)
    expect(handleError).toBeLessThan(1e-6)
    expect(southOpen).toBe(1)
    expect(walletDuringFly.length).toBeGreaterThan(20)
    for (let i = 1; i < walletDuringFly.length; i++) expect(walletDuringFly[i]!).toBeGreaterThanOrEqual(walletDuringFly[i - 1]!)
    const mid = walletDuringFly[Math.floor(walletDuringFly.length / 2)]!
    expect(mid).toBeGreaterThan(90)
    expect(mid).toBeLessThan(160)

    // afterwards the cart is parked again and the crew walks off south and is discharged
    runUntil(w, () => a.state === 'gone' && c.state === 'gone', 10)
    expect(s.drill.state).toBe('parked')
    expect(s.drill.x).toBeCloseTo(L.DRILL_PARK.x)
    expect(s.drill.z).toBeCloseTo(L.DRILL_PARK.z)
    expect(s.drill.crew.length).toBe(0)
    expect(s.stats.discharged).toBe(2)
    expect(events(w, 'discharged').map(e => e.count)).toEqual([1, 2])
    for (const v of [a, c]) expect(Math.hypot(v.x - L.SOUTH_EXIT.x, v.z - L.SOUTH_EXIT.z)).toBeLessThan(0.3)
    expect(s.wallet).toBe(250)
    run(w, 1)
    expect(s.doors.south).toBe(0)
  })

  test('a lone crew member makes the sortie alone after DRILL_LONE_WAIT', () => {
    const w = sim()
    withNurses(w)
    const v = bather(w)
    const joined = runUntil(w, () => v.state === 'atDrill', 20)
    expect(events(w, 'drillCrewJoin')).toEqual([{ type: 'drillCrewJoin', id: v.id, crew: 1 }])
    run(w, P.DRILL_LONE_WAIT - 0.2)
    expect(v.state).toBe('atDrill')
    expect(w.s.drill.state).toBe('parked')
    expect(w.s.drill.loneT).toBeGreaterThan(P.DRILL_LONE_WAIT - 0.3)
    runUntil(w, () => w.s.drill.state === 'pushing', 1)
    near(w, times(w, 'drillPush')[0], joined + P.DRILL_LONE_WAIT)
    runUntil(w, () => v.state === 'gone', 10)
    expect(w.s.wallet).toBe(250)
    expect(w.s.flags.firstSortiePaid).toBe(true)
    expect(w.s.stats.discharged).toBe(1)
  })

  test('while the swarm regrows healed patients leave without waiting; then it is ready again', () => {
    const { w, a, c } = firstPair()
    const s = w.s
    runUntil(w, () => a.state === 'gone' && c.state === 'gone', 30)
    const push = times(w, 'drillPush')[0]!
    expect(s.swarm.ready).toBe(false)
    expect(s.swarm.fill).toBeLessThan(0.75)
    expect(s.swarm.fill).toBeGreaterThanOrEqual(1 - P.RATS_KILLED_PER_SORTIE / P.RAT_COUNT - 1e-9)

    const late = bather(w)
    let crewed = false
    let lastFill = s.swarm.fill
    w.probe = () => {
      if (late.state === 'toDrill' || late.state === 'atDrill' || late.state === 'pushing') crewed = true
      expect(s.swarm.fill).toBeGreaterThanOrEqual(lastFill)
      lastFill = s.swarm.fill
    }
    const gone = runUntil(w, () => late.state === 'gone', 15)
    expect(gone).toBeLessThan(push + P.RAT_REGROW)
    expect(crewed).toBe(false)
    expect(late.look).toBe('healed')
    expect(Math.hypot(late.x - L.SOUTH_EXIT.x, late.z - L.SOUTH_EXIT.z)).toBeLessThan(0.3)
    expect(s.stats.discharged).toBe(3)
    expect(s.wallet).toBe(250)
    expect(events(w, 'drillPush').length).toBe(1)
    expect(s.drill.crew.length).toBe(0)

    runUntil(w, () => s.swarm.ready, P.RAT_REGROW)
    near(w, times(w, 'swarmReady')[0], push + P.RAT_REGROW)
    expect(s.swarm.fill).toBe(1)
    expect(events(w, 'swarmReady').length).toBe(1)

    // the next healed patient crews the drill again
    w.probe = null
    const next = bather(w)
    runUntil(w, () => next.state === 'gone', 30)
    expect(events(w, 'drillPush').length).toBe(2)
    expect(s.wallet).toBe(500)
  })

  test('a third patient healed while the crew is full walks out', () => {
    const w = sim()
    withNurses(w)
    const vs = [bather(w, 0), bather(w, 1), bather(w, 2)]
    const s = w.s
    const crewed = new Set<number>()
    w.probe = () => {
      for (const v of vs) if (v.state === 'toDrill' || v.state === 'atDrill' || v.state === 'pushing') crewed.add(v.id)
      expect(s.drill.crew.length).toBeLessThanOrEqual(P.DRILL_CREW)
    }
    runUntil(w, () => vs.every(v => v.state === 'gone'), 30)
    expect(crewed.size).toBe(2)
    expect(s.wallet).toBe(250)
    expect(s.stats.discharged).toBe(3)
  })

  test('Mk II doubles the reward and shortens the regrow', () => {
    const w = sim()
    const s = w.s
    s.unlocks.drill2 = true
    withNurses(w)
    const v = bather(w)
    runUntil(w, () => s.drill.state === 'pushing', 30)
    const push = times(w, 'drillPush')[0]!
    expect(s.drill.reward).toBe(P.DRILL_REWARD_MK2)
    expect(s.swarm.regrowT).toBeCloseTo(P.RAT_REGROW_MK2, 1)
    runUntil(w, () => v.state === 'gone', 10)
    expect(s.wallet).toBe(500)
    expect(s.stats.totalGold).toBe(500)
    expect(events(w, 'drillPaid')).toEqual([{ type: 'drillPaid', gold: 500 }])
    runUntil(w, () => s.swarm.ready, P.RAT_REGROW_MK2)
    near(w, times(w, 'swarmReady')[0], push + P.RAT_REGROW_MK2)
    expect(s.swarm.fill).toBe(1)
  })

  test('Mk II bought while the swarm regrows shortens the wait without the rats jumping', () => {
    const { w, a, c } = firstPair()
    const s = w.s
    runUntil(w, () => a.state === 'gone' && c.state === 'gone', 30)
    const push = times(w, 'drillPush')[0]!
    expect(s.drill.reward).toBe(250)
    s.unlocks.drill2 = true
    const bought = s.time
    let lastFill = s.swarm.fill
    w.probe = () => {
      expect(s.swarm.fill).toBeGreaterThanOrEqual(lastFill)
      expect(s.swarm.fill - lastFill).toBeLessThan(0.01)
      lastFill = s.swarm.fill
    }
    const ready = runUntil(w, () => s.swarm.ready, P.RAT_REGROW)
    expect(ready).toBeLessThan(push + P.RAT_REGROW - 1)
    expect(ready).toBeLessThanOrEqual(bought + P.RAT_REGROW_MK2 + 2 * DT)
    expect(s.swarm.fill).toBe(1)
  })
})

describe('routes', () => {
  /** Distance from a point to a bed's footprint (negative inside). */
  const bedDistance = (x: number, z: number, bed: number) => {
    const dx = Math.abs(x - BEDS[bed]!.x) - P.BED_W / 2
    const dz = Math.abs(z - BEDS[bed]!.z) - P.BED_D / 2
    return dx <= 0 && dz <= 0 ? Math.max(dx, dz) : Math.hypot(Math.max(dx, 0), Math.max(dz, 0))
  }

  test('nurses run from the pad to their posts without crossing a bed', () => {
    const w = sim()
    w.s.unlocks.nurses = true
    let clearance = Infinity
    w.probe = s => {
      for (const n of s.nurses) if (n.state === 'running') for (const b of BEDS) clearance = Math.min(clearance, bedDistance(n.x, n.z, b.id))
    }
    run(w, 2)
    expect(clearance).toBeGreaterThan(0.3)
  })

  for (const swarmReady of [true, false]) {
    test(`walking to and from each of the ten beds keeps clear of beds, nurses and the cauldron (${swarmReady ? 'drill crew' : 'straight home'})`, () => {
      for (const def of BEDS) {
        const w = sim()
        const s = w.s
        s.unlocks.ward2 = true
        withNurses(w)
        if (!swarmReady) {
          s.swarm.ready = false
          s.swarm.regrowT = 1000
        }
        const v = bather(w, def.id, def.id) // sendToBed reserves a free bed for him
        expect(s.beds[def.id]!.state).toBe('reserved')
        expect(s.beds[def.id]!.villager).toBe(v.id)
        let beds = Infinity
        let nurses = Infinity
        let pot = Infinity
        w.probe = () => {
          if (v.state !== 'toBed' && v.state !== 'toExit' && v.state !== 'toDrill') return
          for (const b of BEDS) beds = Math.min(beds, bedDistance(v.x, v.z, b.id))
          for (const n of s.nurses) nurses = Math.min(nurses, Math.hypot(v.x - n.x, v.z - n.z))
          pot = Math.min(pot, Math.hypot(v.x - L.CAULDRON.x, v.z - L.CAULDRON.z))
        }
        runUntil(w, () => v.state === 'inBed', 10)
        expect(v.bed).toBe(def.id)
        expect(v.x).toBeCloseTo(def.x)
        expect(v.z).toBeCloseTo(def.z)
        runUntil(w, () => v.state === 'gone', 30)
        const exit = def.ward === 1 ? L.SOUTH_EXIT : L.NORTH_EXIT
        expect(Math.hypot(v.x - exit.x, v.z - exit.z)).toBeLessThan(0.3)
        // the climbing spot itself (L.BED_SIDE) is 0.25 m from the bed
        expect(beds).toBeGreaterThan(0.2)
        expect(nurses).toBeGreaterThan(0.35)
        expect(pot).toBeGreaterThan(P.CAULDRON_COLLIDER_RADIUS + 0.4)
        expect(s.stats.discharged).toBe(1)
        expect(s.wallet).toBe(def.ward === 1 && swarmReady ? P.DRILL_REWARD : 0)
      }
    })
  }

  test('roughly reproduces the first-minute script of SPEC 3.5 (bath 14.6 s, nurses bought 20.3 s)', () => {
    const w = sim()
    const s = w.s
    s.time = 14.6
    const a = bather(w, 0)
    const c = bather(w, 1)
    runUntil(w, () => s.time >= 20.3, 10)
    // 16.0-17.2: patients in beds A and C (and still there, untreated, when the nurses are bought)
    const lie = times(w, 'patientLie')
    expect(lie.length).toBe(2)
    expect(lie[0]!).toBeGreaterThan(15.9)
    expect(lie[1]!).toBeLessThan(17.5)
    expect(events(w, 'needsNurse').length).toBe(2)
    s.unlocks.nurses = true
    runUntil(w, () => a.state === 'gone' && c.state === 'gone', 15)
    // 21.5-23.9: both had lain long enough, so they are treated as soon as their nurses arrive
    for (const t of times(w, 'treatStart')) expect(t).toBeLessThan(21.6)
    for (const t of times(w, 'healed')) {
      expect(t).toBeGreaterThan(22.0)
      expect(t).toBeLessThan(23.4)
    }
    // 24.4-26.6: drill sortie, +250
    expect(times(w, 'drillPush')[0]!).toBeGreaterThan(24.0)
    expect(times(w, 'drillPush')[0]!).toBeLessThan(25.0)
    expect(times(w, 'drillPaid')[0]!).toBeGreaterThan(26.2)
    expect(times(w, 'drillPaid')[0]!).toBeLessThan(27.2)
    expect(s.wallet).toBe(250)
  })
})

describe('leaving the map', () => {
  test('a healed patient fades over the last second of his path and is discharged once', () => {
    const w = sim()
    withNurses(w)
    w.s.swarm.ready = false // rats not back yet: he just walks out
    w.s.swarm.regrowT = 1000
    const v = bather(w)
    let fadeStart = -1
    let lastAlpha = 1
    let clipped = 0
    w.probe = s => {
      expect(v.alpha).toBeLessThanOrEqual(lastAlpha)
      expect(v.alpha).toBeGreaterThanOrEqual(0)
      lastAlpha = v.alpha
      if (fadeStart < 0 && v.alpha < 1) fadeStart = s.time
      if (v.state === 'toExit' && insideBed(v.x, v.z, s)) clipped++
    }
    const gone = runUntil(w, () => v.state === 'gone', 20)
    const startedRunning = seenAt(w, v, 'toExit')!
    expect(seenAt(w, v, 'toDrill')).toBeUndefined()
    expect(fadeStart).toBeGreaterThan(startedRunning + 0.2)
    near(w, gone - fadeStart, EXIT_FADE)
    expect(v.alpha).toBe(0)
    expect(Math.hypot(v.x - L.SOUTH_EXIT.x, v.z - L.SOUTH_EXIT.z)).toBeLessThan(0.3)
    expect(clipped).toBe(0)
    expect(events(w, 'discharged')).toEqual([{ type: 'discharged', id: v.id, count: 1 }])
    run(w, 3)
    expect(w.s.stats.discharged).toBe(1)
    expect(events(w, 'discharged').length).toBe(1)
  })

  /** Random batches of bathers for as long as beds are free, with the three unlocks arriving on the way. */
  function longScenario(dt: number, TOTAL: number, seed: number) {
    const w = sim(dt, seed)
    const s = w.s
    const r = makeRng(seed)
    let fed = 0
    let nextFeed = 0
    let maxAtOnce = 0
    w.probe = () => {
      maxAtOnce = Math.max(maxAtOnce, s.villagers.length)
      expect(s.drill.crew.length).toBeLessThanOrEqual(P.DRILL_CREW)
      for (const v of s.villagers) {
        if (v.bed >= 0) expect(s.beds[v.bed]!.villager).toBe(v.id)
        expect(Number.isFinite(v.x + v.z + v.y)).toBe(true)
      }
      // the housekeeping of sim/guide.ts: 'gone' villagers leave the array
      for (let i = s.villagers.length - 1; i >= 0; i--) if (s.villagers[i]!.state === 'gone') s.villagers.splice(i, 1)
    }
    while (fed < TOTAL || s.villagers.length > 0) {
      if (s.time > 1500) throw new Error(`stuck: ${s.stats.discharged}/${fed} discharged, states ${s.villagers.map(v => v.state)}`)
      if (s.time > 8) s.unlocks.nurses = true
      if (s.time > 60) s.unlocks.ward2 = true
      if (s.time > 110) s.unlocks.drill2 = true
      if (fed < TOTAL && s.time >= nextFeed) {
        const batch = 1 + Math.floor(rand(r) * 4)
        for (let i = 0; i < batch && fed < TOTAL && freeBedCount(s) > 0; i++, fed++) bather(w, i)
        nextFeed = s.time + randRange(r, 0.1, 3)
      }
      tick(w)
    }
    run(w, 3)
    expect(s.stats.discharged).toBe(TOTAL)
    const ids = events(w, 'discharged').map(e => e.id)
    expect(ids.length).toBe(TOTAL)
    expect(new Set(ids).size).toBe(TOTAL)
    expect(events(w, 'patientLie').length).toBe(TOTAL)
    expect(events(w, 'healed').length).toBe(TOTAL)
    expect(s.beds.every(b => b.state === 'free' && b.villager === -1)).toBe(true)
    expect(s.drill.state).toBe('parked')
    expect(s.drill.crew.length).toBe(0)
    expect(maxAtOnce).toBeGreaterThan(4)
    const paid = events(w, 'drillPaid').map(e => e.gold)
    expect(paid.length).toBe(s.drill.sorties)
    expect(paid.length).toBeGreaterThan(3)
    expect(new Set(paid)).toEqual(new Set([P.DRILL_REWARD, P.DRILL_REWARD_MK2]))
    expect(s.wallet).toBe(paid.reduce((x, y) => x + y, 0))
    expect(s.stats.totalGold).toBe(s.wallet)
    expect(Number.isInteger(s.wallet)).toBe(true)
  }

  test('every villager is eventually discharged in a long random scenario (no leaks, no deadlock)', () => longScenario(1 / 60, 180, 42))
  test('the same holds at 144 steps per second', () => longScenario(1 / 144, 90, 7))

  test('the timeline does not depend on the step length (1/60 vs 1/144)', () => {
    const outcome = (dt: number) => {
      const { w, a, c } = firstPair(dt)
      const third = bather(w, 2)
      runUntil(w, () => [a, c, third].every(v => v.state === 'gone'), 40)
      return {
        lie: times(w, 'patientLie'),
        healed: times(w, 'healed'),
        push: times(w, 'drillPush'),
        paid: times(w, 'drillPaid'),
        discharged: times(w, 'discharged'),
        wallet: w.s.wallet,
        count: w.s.stats.discharged,
      }
    }
    const slow = outcome(1 / 60)
    const fast = outcome(1 / 144)
    expect(fast.wallet).toBe(slow.wallet)
    expect(fast.count).toBe(slow.count)
    for (const k of ['lie', 'healed', 'push', 'paid', 'discharged'] as const) {
      expect(fast[k].length).toBe(slow[k].length)
      for (let i = 0; i < slow[k].length; i++) expect(Math.abs(fast[k][i]! - slow[k][i]!)).toBeLessThan(0.05)
    }
  })
})
