// Production package: grinder, flasks, crowd/gate/usher/queue, bath. Only the package's own step functions are
// called, so these tests hold whether the other packages are stubs or real.
import { describe, expect, test } from 'bun:test'
import { L, P, UNLOCKS, type BubbleSize } from '../src/config'
import { TAU } from '../src/core/math'
import { BATH_SEAT_Y, stepBath } from '../src/sim/bath'
import { freeBedCount, releaseBed } from '../src/sim/beds'
import { queueMax, queueSlotX, queueSlotZ, stepCrowd } from '../src/sim/crowd'
import type { EventOf, EventType, GameEvent } from '../src/sim/events'
import { cauldronRoom, depositFlasks, pickupFlasks, stackTopY, stepFlasks } from '../src/sim/flasks'
import { GROUND_FLASK_MAX, stepGrinder } from '../src/sim/grinder'
import { createState } from '../src/sim/state'
import type { Bubble, GameState, Villager } from '../src/sim/types'

const DT = 1 / 60
type Sys = (s: GameState, dt: number) => void
interface Stamped<E = GameEvent> {
  /** Seconds since the start of the run() call. */
  t: number
  e: E
}

/** Runs the systems for `seconds` and returns every event with the time at which it was emitted. */
function run(s: GameState, seconds: number, systems: Sys[], dt = DT, each?: (t: number) => void): Stamped[] {
  const log: Stamped[] = []
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i++) {
    const before = s.events.length
    s.time += dt
    for (const sys of systems) sys(s, dt)
    for (let k = before; k < s.events.length; k++) log.push({ t: (i + 1) * dt, e: s.events[k]! })
    each?.((i + 1) * dt)
  }
  return log
}
const of = <T extends EventType>(log: Stamped[], type: T) => log.filter(x => x.e.type === type) as Stamped<EventOf<T>>[]
const expectNear = (actual: number, expected: number, tol = DT + 1e-6) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol)
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
/** Reads a state without the narrowing TypeScript applies after an assignment in the test. */
const stateOf = (x: { state: string }): string => x.state

function dock(s: GameState, size: BubbleSize, x: number, z: number, tool = 0): Bubble {
  const b: Bubble = { id: s.nextId++, size, r: P.BUBBLE_DIAMETER[size] / 2, x, z, vx: 0, vz: 0, roll: 0, state: 'docked', t: 1, tool, age: 5 }
  s.bubbles.push(b)
  s.tools[tool]!.bubble = b.id
  return b
}

function dropFlask(s: GameState, x: number, z: number, age = 1) {
  s.groundFlasks.push({ id: s.nextId++, x, z, fromX: x, fromZ: z, age, rot: 0 })
}

function queued(s: GameState, slot: number): Villager {
  const v: Villager = {
    id: s.nextId++, state: 'queued', t: 0, x: queueSlotX(slot), z: queueSlotZ(slot), y: 0, heading: Math.PI / 2, look: 'sick',
    path: [], pathI: 0, speed: P.SICK_WALK_SPEED, slot, bed: -1, fromX: 0, fromZ: 0, toX: 0, toZ: 0, delay: 0, seed: 0.5, alpha: 1,
  }
  s.villagers.push(v)
  return v
}

const inLine = (s: GameState) => s.villagers.filter(v => v.state === 'toQueue' || v.state === 'queued')
const standing = (s: GameState) => s.villagers.filter(v => v.state === 'queued' && Math.hypot(v.x - queueSlotX(v.slot), v.z - queueSlotZ(v.slot)) < 1e-6)
const occupyBeds = (s: GameState, n: number) => {
  for (let i = 0; i < n; i++) s.beds[i]!.state = 'occupied'
}
/** Gold thrown at the pallet so far (economy.ts is not stepped here, so nothing has landed). */
const fountainGold = (s: GameState) => sum(s.pallet.incoming.filter((_, i) => i % 2 === 1))
const BAY = { x: -3.2, z: -1.8 } // inside the manual-release radius
const AWAY = { x: 6, z: -8 } // outside every station radius
const place = (s: GameState, p: { x: number; z: number }) => {
  s.player.x = p.x
  s.player.z = p.z
}

// ---------------------------------------------------------------------------------------------------------------

describe('grinder', () => {
  const [X0, Z0, X1, Z1] = L.GRINDER

  test('takes a docked bubble inside the grown tray rectangle, only when idle', () => {
    const s = createState()
    const b = dock(s, 'M', X1 + P.GRINDER_ACCEPT_MARGIN + 0.1, -2.8)
    stepGrinder(s, DT)
    expect(stateOf(b)).toBe('docked')
    expect(s.grinder.state).toBe('idle')

    b.state = 'docking'
    b.x = X1 + 0.2
    stepGrinder(s, DT)
    expect(s.grinder.state).toBe('idle') // still snapping into the scoop

    b.state = 'docked'
    stepGrinder(s, DT)
    expect(stateOf(b)).toBe('grinder')
    expect(b.tool).toBe(-1)
    expect(s.grinder.state).toBe('grinding')
    expect(s.grinder.bubble).toBe(b.id)

    // A second delivery waits docked until the tray is free again.
    const second = dock(s, 'S', X1 + 0.3, -1.5, 1)
    const log = run(s, 1.0, [stepGrinder])
    expect(second.state).toBe('docked')
    expect(of(log, 'grindEnd').length).toBe(0)
    const log2 = run(s, 1.0, [stepGrinder])
    expect(of(log2, 'grindEnd').length).toBe(1)
    expect(second.state).toBe('grinder')
    expect(s.grinder.size).toBe('S')
  })

  test('slides to rest on the tray, then runs the SPEC 2.4 timeline', () => {
    const s = createState()
    const b = dock(s, 'M', X1 + 0.4, -2.85)
    let maxStep = 0
    let px = b.x
    const log = run(s, 2.0, [stepGrinder, stepFlasks], DT, () => {
      maxStep = Math.max(maxStep, Math.abs(b.x - px))
      px = b.x
    })
    const start = of(log, 'grindStart')[0]!
    // Accepted in the first step, at rest GRIND_SLIDE_TIME later.
    expectNear(start.t, DT + P.GRIND_SLIDE_TIME)
    expect(start.e.size).toBe('M')
    // An M bubble is wider than the tray: centred across it, kept where it was along it.
    expect(start.e.x).toBeCloseTo((X0 + X1) / 2, 6)
    expect(start.e.z).toBeCloseTo(-2.85, 6)
    expect(start.e.r).toBe(1.3)
    // The slide is a constant-speed move, not a jump.
    const slide = X1 + 0.4 - (X0 + X1) / 2
    expect(maxStep).toBeLessThanOrEqual((slide / P.GRIND_SLIDE_TIME) * DT + 1e-6)

    const t0 = start.t
    expectNear(of(log, 'grindCrack')[0]!.t, t0 + P.GRIND_CRACK)
    expectNear(of(log, 'grindShell')[0]!.t, t0 + P.GRIND_SHELL)
    expectNear(of(log, 'grindShatter')[0]!.t, t0 + P.GRIND_SHARDS)
    const ejects = of(log, 'flaskEject')
    expect(ejects.length).toBe(10)
    expectNear(ejects[0]!.t, t0 + P.FLASK_EJECT_START)
    expectNear(ejects[9]!.t, t0 + P.FLASK_EJECT_START + 9 * P.FLASK_EJECT_INTERVAL)
    expectNear(of(log, 'grindEnd')[0]!.t, t0 + P.GRIND_FREE)
    expect(s.grinder.state).toBe('idle')
    // The Bubble object is gone, its rest pose stays for the shard effect.
    expect(s.bubbles.some(x => x.id === b.id)).toBe(false)
    expect(s.grinder.bubble).toBe(-1)
    expect(s.grinder.bx).toBeCloseTo((X0 + X1) / 2, 6)
    expect(s.grinder.br).toBe(1.3)
    for (const e of ejects) expect(e.e.fromX).toBe(X0) // west long side
  })

  test('the bubble exists until the shatter and is removed exactly then', () => {
    const s = createState()
    const b = dock(s, 'L', X1, -3)
    let removedAt = -1
    const log = run(s, 1.0, [stepGrinder], DT, t => {
      if (removedAt < 0 && !s.bubbles.includes(b)) removedAt = t
    })
    expect(removedAt).toBe(of(log, 'grindShatter')[0]!.t)
    expect(b.state).toBe('gone')
  })

  test('a small bubble rests fully on the tray', () => {
    const s = createState()
    const b = dock(s, 'S', X1 + 0.4, Z1 + 0.3)
    run(s, 0.3, [stepGrinder])
    expect(b.x).toBeCloseTo(X1 - b.r, 6)
    expect(b.z).toBeCloseTo(Z1 - b.r, 6)
  })

  for (const size of ['S', 'M', 'L'] as const) {
    test(`yield of a ${size} bubble: ${P.FLASK_YIELD[size]} units as ${P.FLASK_YIELD[size] * 2} flasks inside the landing area`, () => {
      const s = createState()
      dock(s, size, X1, -2.8)
      const log = run(s, 2.0, [stepGrinder, stepFlasks])
      const units = P.FLASK_YIELD[size]
      expect(of(log, 'flaskEject').length).toBe(units * P.GROUND_MESHES_PER_UNIT)
      expect(s.groundFlasks.length).toBe(units * P.GROUND_MESHES_PER_UNIT)
      expect(s.stats.flasksMade).toBe(units)
      const a = L.FLASK_AREA
      for (const f of s.groundFlasks) {
        expect(Math.abs(f.x - a.x)).toBeLessThanOrEqual(a.w / 2)
        expect(Math.abs(f.z - a.z)).toBeLessThanOrEqual(a.d / 2)
        expect(f.fromZ).toBeGreaterThan(Z0)
        expect(f.fromZ).toBeLessThan(Z1)
        expect(f.age).toBeGreaterThan(P.FLASK_EJECT_FLIGHT) // all have landed by now
      }
      let closest = Infinity
      for (let i = 0; i < s.groundFlasks.length; i++)
        for (let j = 0; j < i; j++) closest = Math.min(closest, Math.hypot(s.groundFlasks[i]!.x - s.groundFlasks[j]!.x, s.groundFlasks[i]!.z - s.groundFlasks[j]!.z))
      expect(closest).toBeGreaterThan(0.3) // no two flasks on the same spot
      expect(new Set(s.groundFlasks.map(f => f.id)).size).toBe(s.groundFlasks.length)
    })
  }

  test('the timeline does not depend on the step size', () => {
    const times = [1 / 60, 1 / 144, 1 / 97].map(dt => {
      const s = createState()
      dock(s, 'L', X1, -2.8)
      const log = run(s, 2.0, [stepGrinder, stepFlasks], dt)
      const t0 = of(log, 'grindStart')[0]!.t
      const ejects = of(log, 'flaskEject')
      expect(ejects.length).toBe(18)
      expectNear(ejects[17]!.t - t0, P.FLASK_EJECT_START + 17 * P.FLASK_EJECT_INTERVAL, dt + 1e-6)
      expectNear(of(log, 'grindShatter')[0]!.t - t0, P.GRIND_SHARDS, dt + 1e-6)
      expectNear(of(log, 'grindEnd')[0]!.t - t0, P.GRIND_FREE, dt + 1e-6)
      return t0
    })
    for (const t of times) expectNear(t, P.GRIND_SLIDE_TIME, 2 * DT)
  })

  test('discs turn at 0.5 rev/s idle and 4 rev/s while grinding', () => {
    const s = createState()
    run(s, 0.5, [stepGrinder])
    expect(s.grinder.spin).toBeCloseTo(0.25 * TAU, 5)
    dock(s, 'M', X1, -2.8)
    stepGrinder(s, DT) // accepted at the end of this step, which still counts as idle... or not: either way < 1 step
    const before = s.grinder.spin
    run(s, 0.1, [stepGrinder])
    expect((s.grinder.spin - before + TAU) % TAU).toBeCloseTo(0.4 * TAU, 5)
  })

  test('the pile on the ground is capped', () => {
    const s = createState()
    for (let i = 0; i < GROUND_FLASK_MAX - 5; i++) dropFlask(s, L.FLASK_AREA.x, L.FLASK_AREA.z)
    dock(s, 'L', X1, -2.8)
    run(s, 2.0, [stepGrinder])
    expect(s.groundFlasks.length).toBe(GROUND_FLASK_MAX)
    expect(s.stats.flasksMade).toBe(9)
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('flask pickup', () => {
  const C = { x: L.FLASK_AREA.x, z: L.FLASK_AREA.z }

  test('14 units per second, two ground flasks per unit', () => {
    const s = createState()
    place(s, C)
    for (let i = 0; i < 10; i++) dropFlask(s, C.x + 0.2 * (i % 5) - 0.4, C.z + (i < 5 ? 0.3 : -0.3))
    const log = run(s, 0.2, [stepFlasks])
    // 28 meshes/s for 0.2 s = 5 meshes = 2 units and a half
    expect(of(log, 'flaskPickup').length).toBe(5)
    expect(s.player.flasks).toBe(2)
    expect(s.flaskHalf).toBe(1)
    expect(s.groundFlasks.length).toBe(5)
    const log2 = run(s, 0.3, [stepFlasks])
    const picks = of(log2, 'flaskPickup')
    expect(s.player.flasks).toBe(5)
    expect(s.flaskHalf).toBe(0)
    expect(s.groundFlasks.length).toBe(0) // nothing is left on the ground
    // 5 units in 10/28 s = 0.36 s, as in the ad (7.63-8.00)
    expectNear(0.2 + picks[picks.length - 1]!.t, 10 / (P.FLASK_PICKUP_RATE * 2))
    expect([...of(log, 'flaskPickup'), ...picks].map(p => p.e.unitAdded)).toEqual([false, true, false, true, false, true, false, true, false, true])
    expect(picks.every(p => p.e.by === 'player')).toBe(true)
  })

  test('nearest first, only inside the radius, only landed flasks', () => {
    const s = createState()
    place(s, C)
    const dists = [1.4, 0.2, 1.1, 0.5, 0.8]
    for (const d of dists) dropFlask(s, C.x + d, C.z)
    dropFlask(s, C.x, C.z + P.FLASK_PICKUP_RADIUS + 0.05) // too far
    dropFlask(s, C.x - 0.1, C.z, 0) // nearest of all, but still in the air
    const log = run(s, 0.16, [stepFlasks])
    const order = of(log, 'flaskPickup').map(p => +(p.e.fromX - C.x).toFixed(3))
    expect(order).toEqual([0.2, 0.5, 0.8, 1.1])
    run(s, 1, [stepFlasks])
    // the airborne one landed and was taken, the far one stays
    expect(s.groundFlasks.length).toBe(1)
    expect(s.groundFlasks[0]!.z).toBeCloseTo(C.z + P.FLASK_PICKUP_RADIUS + 0.05, 6)
    expect(s.player.flasks).toBe(3)
  })

  test('carry limit', () => {
    const s = createState()
    place(s, C)
    for (let i = 0; i < 30; i++) dropFlask(s, C.x + 0.05 * i - 0.7, C.z)
    run(s, 3, [stepFlasks])
    expect(s.player.flasks).toBe(P.FLASK_CARRY_MAX)
    expect(s.groundFlasks.length).toBe(30 - 2 * P.FLASK_CARRY_MAX)
    expect(pickupFlasks(s, s.player, P.FLASK_CARRY_MAX, 'player', DT)).toBe(false)
  })

  test('shared helper: any carrier, its own limit, reports while collecting', () => {
    const s = createState()
    place(s, AWAY)
    const porter = { x: C.x, z: C.z, flasks: 0, pickupAcc: 0 }
    expect(pickupFlasks(s, porter, P.PORTER_CARRY, 'porter', DT)).toBe(false)
    for (let i = 0; i < 20; i++) dropFlask(s, C.x + 0.05 * i - 0.5, C.z)
    let busy = 0
    for (let i = 0; i < 120; i++) if (pickupFlasks(s, porter, P.PORTER_CARRY, 'porter', DT)) busy++
    expect(porter.flasks).toBe(P.PORTER_CARRY)
    expect(s.groundFlasks.length).toBe(20 - 2 * P.PORTER_CARRY)
    expectNear(busy * DT, P.PORTER_CARRY / P.FLASK_PICKUP_RATE, 2 * DT)
    expect(s.events.filter(e => e.type === 'flaskPickup').every(e => e.type === 'flaskPickup' && e.by === 'porter')).toBe(true)
  })
})

describe('flask deposit', () => {
  const POUR = { x: 0.2, z: -3.6 } // a pouring spot seen in the ad

  /** The doctor walks in with n flasks: one step outside first, as in play. */
  function arrive(s: GameState, n: number) {
    place(s, AWAY)
    s.player.flasks = n
    stepFlasks(s, DT)
    place(s, POUR)
  }

  test('delay, interval, flight; thrown from the top of the stack', () => {
    const s = createState()
    arrive(s, 5)
    const log = run(s, 1.2, [stepFlasks])
    const throws = of(log, 'flaskThrow')
    const lands = of(log, 'flaskLand')
    expect(throws.length).toBe(5)
    expect(lands.length).toBe(5)
    for (let i = 0; i < 5; i++) {
      expectNear(throws[i]!.t, P.DEPOSIT_DELAY + i * P.DEPOSIT_INTERVAL)
      expectNear(lands[i]!.t, P.DEPOSIT_DELAY + i * P.DEPOSIT_INTERVAL + P.DEPOSIT_FLIGHT)
      expect(lands[i]!.e.potion).toBe(i + 1)
      expect(throws[i]!.e.fromY).toBeCloseTo(stackTopY(5 - i), 6)
      expect(throws[i]!.e.by).toBe('player')
      // from behind his back, not from his feet
      expect(Math.hypot(throws[i]!.e.fromX - POUR.x, throws[i]!.e.fromZ - POUR.z)).toBeCloseTo(0.45, 6)
    }
    expect(stackTopY(5)).toBeCloseTo(0.3 + 4 * P.FLASK_STACK_PITCH + P.FLASK_BULB / 2, 6)
    expect(s.cauldron.potion).toBe(5)
    expect(s.player.flasks).toBe(0)
    expect(s.cauldron.incoming.length).toBe(0)
    expect(s.cauldron.sinceFill).toBeLessThan(0.5)
  })

  test('nothing happens outside the radius', () => {
    const s = createState()
    place(s, { x: P.DEPOSIT_RADIUS + 0.1, z: 0 })
    s.player.flasks = 5
    const log = run(s, 1, [stepFlasks])
    expect(of(log, 'flaskThrow').length).toBe(0)
    expect(s.player.flasks).toBe(5)
    place(s, { x: P.DEPOSIT_RADIUS - 0.1, z: 0 })
    run(s, 1.5, [stepFlasks])
    expect(s.cauldron.potion).toBe(5)
  })

  test('flasks in flight count toward the capacity; the extra ones stay on the back', () => {
    const s = createState()
    s.cauldron.potion = 8
    arrive(s, 5)
    const log = run(s, 2, [stepFlasks], DT, () => {
      expect(s.cauldron.potion + s.cauldron.incoming.length).toBeLessThanOrEqual(s.cauldron.capacity)
      expect(cauldronRoom(s)).toBeGreaterThanOrEqual(0)
    })
    expect(of(log, 'flaskThrow').length).toBe(2)
    expect(s.cauldron.potion).toBe(10)
    expect(s.player.flasks).toBe(3)
    expect(depositFlasks(s, s.player, 'player', DT)).toBe(false)

    // Room appears (a batch bathed): the deposit resumes after the delay.
    s.cauldron.potion = 8
    const log2 = run(s, 2, [stepFlasks])
    expectNear(of(log2, 'flaskThrow')[0]!.t, P.DEPOSIT_DELAY)
    expect(s.cauldron.potion).toBe(10)
    expect(s.player.flasks).toBe(1)
  })

  test('same cadence at any step size', () => {
    for (const dt of [1 / 60, 1 / 144, 1 / 75]) {
      const s = createState()
      place(s, AWAY)
      s.player.flasks = 9
      stepFlasks(s, dt)
      place(s, POUR)
      const log = run(s, 1.5, [stepFlasks], dt)
      const lands = of(log, 'flaskLand')
      expect(lands.length).toBe(9)
      expectNear(lands[8]!.t, P.DEPOSIT_DELAY + 8 * P.DEPOSIT_INTERVAL + P.DEPOSIT_FLIGHT, dt + 1e-6)
    }
  })

  test('shared helper reports a deposit in progress', () => {
    const s = createState()
    place(s, AWAY)
    const porter = { x: L.PORTER_POUR.x, z: L.PORTER_POUR.z, flasks: 3, depositT: P.DEPOSIT_DELAY }
    let busy = 0
    for (let i = 0; i < 120; i++) {
      if (depositFlasks(s, porter, 'porter', DT)) busy++
      stepFlasks(s, DT)
    }
    expect(porter.flasks).toBe(0)
    expect(s.cauldron.potion).toBe(3)
    expectNear(busy * DT, P.DEPOSIT_DELAY + 2 * P.DEPOSIT_INTERVAL, 2 * DT)
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('gate and manual release', () => {
  test('releases exactly two when the doctor is near, with potion and beds', () => {
    const s = createState()
    s.cauldron.potion = 5
    place(s, BAY)
    const log = run(s, 3, [stepCrowd])
    const open = of(log, 'gateOpen')
    const out = of(log, 'villagerRelease')
    expect(open.length).toBe(1)
    expectNear(open[0]!.t, P.MANUAL_RELEASE_DELAY)
    expect(out.length).toBe(2)
    // they come out once the gate has swung open, in single file
    expectNear(out[0]!.t, P.MANUAL_RELEASE_DELAY + P.GATE_SWING_TIME, 2 * DT)
    expectNear(out[1]!.t - out[0]!.t, P.USHER_RELEASE_INTERVAL)
    expect(s.crowd.remaining).toBe(P.TOTAL_VILLAGERS - 2)
    expect(s.crowd.released).toBe(2)
    expect(s.crowd.pendingRelease).toBe(0)
    // the gate closes after the last one and no third villager follows while two are queued
    const close = of(log, 'gateClose')
    expect(close.length).toBe(1)
    expectNear(close[0]!.t, out[1]!.t + P.GATE_CLOSE_DELAY)
    expect(s.gate.open).toBe(0)
    expect(standing(s).map(v => v.slot).sort()).toEqual([0, 1])
    for (const v of s.villagers) {
      expect(v.look).toBe('sick')
      expect(v.y).toBe(0)
      expect(v.bed).toBe(-1)
    }
  })

  test('the gate swings in GATE_SWING_TIME', () => {
    const s = createState()
    s.cauldron.potion = 2
    place(s, BAY)
    const opening: number[] = []
    run(s, 0.6, [stepCrowd], DT, t => {
      if (s.gate.open > 0 && s.gate.open < 1) opening.push(t)
    })
    expectNear(opening[opening.length - 1]! - opening[0]!, P.GATE_SWING_TIME, 2 * DT)
  })

  test('villagers walk gate -> bay -> slot at SICK_WALK_SPEED', () => {
    const s = createState()
    s.cauldron.potion = 2
    place(s, BAY)
    let first: Villager | undefined
    let passedBay = false
    let maxStep = 0
    let prev = { x: 0, z: 0 }
    run(s, 2.5, [stepCrowd], DT, () => {
      const v = s.villagers[0]
      if (!v) return
      if (!first) {
        first = v
        expect(v.state).toBe('toQueue')
        expect(Math.hypot(v.x - L.PEN_GATE.x, v.z - L.PEN_GATE.z)).toBeLessThan(P.SICK_WALK_SPEED * DT + 1e-6)
      } else maxStep = Math.max(maxStep, Math.hypot(v.x - prev.x, v.z - prev.z))
      prev = { x: v.x, z: v.z }
      if (Math.hypot(v.x - L.PEN_INNER.x, v.z - L.PEN_INNER.z) < 0.1) passedBay = true
    })
    expect(passedBay).toBe(true)
    expect(maxStep).toBeLessThanOrEqual(P.SICK_WALK_SPEED * DT + 1e-6)
    expect(first!.state).toBe('queued')
    expect(first!.x).toBeCloseTo(L.QUEUE_SLOT0.x, 6)
    expect(first!.z).toBeCloseTo(L.QUEUE_SLOT0.z, 6)
  })

  test('no release without potion, without two free beds, or with the doctor away', () => {
    const cases: [string, (s: GameState) => void][] = [
      ['potion', s => (s.cauldron.potion = 1)],
      ['beds', s => occupyBeds(s, 3)],
      ['doctor', s => place(s, { x: L.MANUAL_RELEASE.x + P.MANUAL_RELEASE_RADIUS + 0.2, z: L.MANUAL_RELEASE.z })],
    ]
    for (const [, spoil] of cases) {
      const s = createState()
      s.cauldron.potion = 5
      place(s, BAY)
      spoil(s)
      const log = run(s, 2, [stepCrowd])
      expect(of(log, 'villagerRelease').length).toBe(0)
      expect(of(log, 'gateOpen').length).toBe(0)
      expect(s.crowd.remaining).toBe(P.TOTAL_VILLAGERS)
    }
    // ...and each of them again once the condition is met
    const s = createState()
    place(s, BAY)
    occupyBeds(s, 3)
    s.cauldron.potion = 1
    run(s, 1, [stepCrowd])
    s.cauldron.potion = 2
    run(s, 1, [stepCrowd])
    expect(s.crowd.released).toBe(0)
    releaseBed(s, 0)
    run(s, 1, [stepCrowd])
    expect(s.crowd.released).toBe(2)
  })

  test('standing at the affordable usher pad pays it instead of releasing (ad 27.2-28.4 s)', () => {
    const s = createState()
    s.cauldron.potion = 5
    const pad = s.pads.find(p => p.id === 'usher')!
    pad.state = 'idle'
    s.wallet = pad.price
    place(s, BAY) // inside both the release radius and the pad's pay radius
    expect(Math.hypot(BAY.x - pad.x, BAY.z - pad.z)).toBeLessThan(P.PAD_PAY_RADIUS)
    run(s, 2, [stepCrowd])
    expect(s.crowd.released).toBe(0)
    // deeper in the bay he is away from the pad: the manual release works as before
    place(s, { x: -7.0, z: -1.8 })
    run(s, 2, [stepCrowd])
    expect(s.crowd.released).toBe(2)

    // a pad he cannot afford never takes the release away
    const t = createState()
    t.cauldron.potion = 5
    const padT = t.pads.find(p => p.id === 'usher')!
    padT.state = 'idle'
    t.wallet = padT.price - 1
    place(t, BAY)
    run(t, 2, [stepCrowd])
    expect(t.crowd.released).toBe(2)
  })

  test('the last villagers of the crowd come out even if they are fewer than the slots', () => {
    const s = createState()
    s.crowd.remaining = 1
    s.cauldron.potion = 1
    place(s, BAY)
    run(s, 2, [stepCrowd])
    expect(s.crowd.remaining).toBe(0)
    expect(s.crowd.released).toBe(1)
    run(s, 2, [stepCrowd])
    expect(s.crowd.remaining).toBe(0)
    expect(s.villagers.length).toBe(1)
  })
})

describe('usher and queue', () => {
  test('appears at her pad, runs to the post, then keeps four queued', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.usher = true
    stepCrowd(s, DT)
    expect(s.usher.present).toBe(true)
    const padB = UNLOCKS.find(u => u.id === 'usher')!
    expect(s.usher.x).toBeCloseTo(padB.x, 6)
    expect(s.usher.z).toBeCloseTo(padB.z, 6)
    let arrivedAt = -1
    let maxStep = 0
    let px = s.usher.x
    let pz = s.usher.z
    const log = run(s, 6, [stepCrowd], DT, t => {
      maxStep = Math.max(maxStep, Math.hypot(s.usher.x - px, s.usher.z - pz))
      px = s.usher.x
      pz = s.usher.z
      if (arrivedAt < 0 && s.usher.arrived) arrivedAt = t
      expect(inLine(s).length).toBeLessThanOrEqual(P.QUEUE_MAX)
    })
    expect(maxStep).toBeLessThanOrEqual(P.USHER_RUN_SPEED * DT + 1e-6)
    expect(s.usher.x).toBe(L.USHER_POST.x)
    expect(s.usher.z).toBe(L.USHER_POST.z)
    const run2post = Math.hypot(L.USHER_POST.x - padB.x, L.USHER_POST.z - padB.z) / P.USHER_RUN_SPEED
    expect(arrivedAt).toBeGreaterThan(run2post)
    expect(arrivedAt).toBeLessThan(run2post + 0.4)

    const out = of(log, 'villagerRelease')
    expect(out.length).toBe(4)
    expect(out[0]!.t).toBeGreaterThan(arrivedAt) // nobody before she stands at the gate
    for (let i = 1; i < 4; i++) expectNear(out[i]!.t - out[i - 1]!.t, P.USHER_RELEASE_INTERVAL)
    expect(s.crowd.released).toBe(4)
    expect(s.crowd.remaining).toBe(P.TOTAL_VILLAGERS - 4)
    expect(standing(s).map(v => v.slot).sort()).toEqual([0, 1, 2, 3])
    // slots trail west toward the bay, 1 m apart
    const v3 = s.villagers.find(v => v.slot === 3)!
    expect(v3.x).toBeCloseTo(-5.8, 6)
    expect(v3.z).toBeCloseTo(-1.45, 6)
    expect(s.gate.open).toBe(0)
    expect(of(log, 'gateOpen').length).toBe(1)
    expect(of(log, 'gateClose').length).toBe(1)
  })

  test('release cadence is the same at 144 Hz', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.usher = true
    const out = of(run(s, 4, [stepCrowd], 1 / 144), 'villagerRelease')
    expect(out.length).toBe(4)
    expectNear(out[3]!.t - out[0]!.t, 3 * P.USHER_RELEASE_INTERVAL, 1 / 144 + 1e-6)
  })

  test('the usher sends nobody while no bed is free', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.usher = true
    occupyBeds(s, 4)
    run(s, 3, [stepCrowd])
    expect(s.crowd.released).toBe(0)
    releaseBed(s, 2)
    run(s, 3, [stepCrowd])
    expect(s.crowd.released).toBe(4)
  })

  test('the line steps forward and is refilled when a batch leaves', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.usher = true
    s.cauldron.potion = 2
    const log = run(s, 8, [stepCrowd, stepBath], DT, () => {
      // nobody ever stands behind the last slot
      for (const v of inLine(s)) expect(v.slot).toBeLessThan(P.QUEUE_MAX)
    })
    expect(of(log, 'bathSplash').length).toBe(1)
    expect(s.crowd.released).toBe(6)
    expect(standing(s).map(v => v.slot).sort()).toEqual([0, 1, 2, 3])
    // the two that were third and fourth are now first and second
    const ids = s.villagers.map(v => v.id)
    const bySlot = (slot: number) => s.villagers.find(v => v.state === 'queued' && v.slot === slot)!.id
    expect(bySlot(0)).toBe(ids[2]!)
    expect(bySlot(1)).toBe(ids[3]!)
  })

  test('the big cauldron has a queue of six', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.usher = true
    s.unlocks.bigCauldron = true
    expect(queueMax(s)).toBe(P.QUEUE_MAX_BIG)
    run(s, 6, [stepCrowd, stepBath])
    expect(standing(s).map(v => v.slot).sort()).toEqual([0, 1, 2, 3, 4, 5])
    expect(s.crowd.released).toBe(6)
  })

  test('the crowd runs out', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.usher = true
    s.crowd.remaining = 3
    run(s, 5, [stepCrowd])
    expect(s.crowd.remaining).toBe(0)
    expect(s.crowd.released).toBe(3)
    expect(s.villagers.length).toBe(3)
    expect(s.crowd.pendingRelease).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('bath', () => {
  /** Time from the start of a batch of n to each milestone. */
  const landIn = (n: number) => P.BATH_PRE_HOP_WAIT + (n - 1) * P.BATH_HOP_STAGGER + P.BATH_HOP_IN
  const cured = (n: number) => landIn(n) + P.BATH_CURE
  const done = (n: number) => cured(n) + P.BATH_CHECK + (n - 1) * P.BATH_HOP_STAGGER + P.BATH_HOP_OUT

  test('a batch needs two queued villagers, potion for both and two free beds', () => {
    const spoilers: ((s: GameState) => void)[] = [
      s => void s.villagers.pop(),
      s => (s.cauldron.potion = 1),
      s => occupyBeds(s, 3),
      s => (s.villagers[1]!.state = 'toQueue'), // the second one has not arrived yet
    ]
    for (const spoil of spoilers) {
      const s = createState()
      place(s, AWAY)
      queued(s, 0)
      queued(s, 1)
      s.cauldron.potion = 5
      spoil(s)
      const log = run(s, 4, [stepBath])
      expect(s.cauldron.bath).toBe('empty')
      expect(log.length).toBe(0)
      expect(s.cauldron.potion).toBeLessThanOrEqual(5)
      expect(s.stats.bathed).toBe(0)
    }
    const s = createState()
    queued(s, 0)
    queued(s, 1)
    s.cauldron.potion = 2
    stepBath(s, DT)
    expect(s.cauldron.bath).toBe('preHop')
    expect(s.cauldron.bathers.length).toBe(2)
  })

  test('batch timeline: hop in, potion used on landing, cure, hop out, beds reserved', () => {
    const s = createState()
    place(s, AWAY)
    const a = queued(s, 0)
    const b = queued(s, 1)
    s.cauldron.potion = 5
    let lookAt = -1
    let potionBeforeSplash = -1
    const log = run(s, 2.5, [stepBath], DT, t => {
      if (lookAt < 0 && a.look === 'bathed') lookAt = t
      if (s.cauldron.bath === 'hopIn') potionBeforeSplash = s.cauldron.potion
      if (s.cauldron.bath === 'curing' || s.cauldron.bath === 'check') {
        // standing in the pot at their seats
        expect(a.x).toBeCloseTo(L.BATH_SEATS[0]!.x, 6)
        expect(a.z).toBeCloseTo(L.BATH_SEATS[0]!.z, 6)
        expect(b.x).toBeCloseTo(L.BATH_SEATS[1]!.x, 6)
        expect(a.y).toBe(BATH_SEAT_Y)
        expect(b.y).toBe(BATH_SEAT_Y)
        expect(a.state).toBe('bathing')
      }
    })
    const t0 = DT // the batch starts in the first step
    const ins = of(log, 'bathHopIn')
    expect(ins.map(e => e.e.id)).toEqual([a.id, b.id])
    expectNear(ins[0]!.t, t0 + P.BATH_PRE_HOP_WAIT)
    expectNear(ins[1]!.t, t0 + P.BATH_PRE_HOP_WAIT + P.BATH_HOP_STAGGER)
    const splash = of(log, 'bathSplash')
    expect(splash.length).toBe(1)
    expect(splash[0]!.e.count).toBe(2)
    expectNear(splash[0]!.t, t0 + landIn(2))
    expect(potionBeforeSplash).toBe(5) // not consumed before the landing
    expect(s.cauldron.potion).toBe(3)
    expectNear(lookAt, t0 + landIn(2) + 0.85 * P.BATH_CURE)
    const cure = of(log, 'bathCured')
    expectNear(cure[0]!.t, t0 + cured(2))
    expect(cure[0]!.e.count).toBe(2)
    const outs = of(log, 'bathHopOut')
    expect(outs.map(e => e.e.id)).toEqual([a.id, b.id])
    expectNear(outs[0]!.t, t0 + cured(2) + P.BATH_CHECK)
    expect(s.cauldron.bath).toBe('empty')
    expect(s.cauldron.bathers.length).toBe(0)
    expect(s.cauldron.batches).toBe(1)
    expect(s.stats.bathed).toBe(2)
    // one bed each, in fill order A, C
    expect(a.bed).toBe(0)
    expect(b.bed).toBe(1)
    expect(s.beds[0]!.villager).toBe(a.id)
    expect(s.beds[1]!.villager).toBe(b.id)
    expect(freeBedCount(s)).toBe(2)
    expect(a.look).toBe('bathed')
    // about one second in the pot (SPEC: 0.95-1.0 s between landing and leaving)
    expect(outs[1]!.t - splash[0]!.t).toBeGreaterThan(0.7)
    expect(outs[1]!.t - splash[0]!.t).toBeLessThan(1.0)
  })

  test('hops clear the rim and end chest-deep in the pot / on the ground outside', () => {
    const s = createState()
    place(s, AWAY)
    const a = queued(s, 0)
    queued(s, 1)
    s.cauldron.potion = 2
    let topIn = 0
    let topOut = 0
    let overRimIn = Infinity
    let overRimOut = Infinity
    const rim = P.CAULDRON_RIM_DIAMETER / 2
    run(s, 2.5, [stepBath], 1 / 1000, () => {
      const r = Math.hypot(a.x, a.z)
      if (a.state === 'hopIn') {
        topIn = Math.max(topIn, a.y)
        if (Math.abs(r - rim) < 0.15) overRimIn = Math.min(overRimIn, a.y)
      }
      if (a.state === 'hopOut' && s.cauldron.bathers.includes(a.id)) {
        topOut = Math.max(topOut, a.y)
        if (Math.abs(r - rim) < 0.15) overRimOut = Math.min(overRimOut, a.y)
      }
    })
    expect(topIn).toBeCloseTo(P.CAULDRON_RIM_HEIGHT + 1.2, 2)
    expect(topOut).toBeCloseTo(P.CAULDRON_RIM_HEIGHT + 1.2, 2)
    expect(overRimIn).toBeGreaterThan(P.CAULDRON_RIM_HEIGHT + 0.3)
    expect(overRimOut).toBeGreaterThan(P.CAULDRON_RIM_HEIGHT + 0.3)
  })

  test('hop positions are continuous: no teleport at any state change', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.usher = true
    s.cauldron.potion = 10
    const mine = new Set(['toQueue', 'queued', 'preHop', 'hopIn', 'bathing', 'hopOut'])
    const last = new Map<number, { x: number; y: number; z: number; mine: boolean }>()
    const seen = new Set<string>()
    let worst = 0
    // 2 kHz: the fastest hop moves 3 cm per step, so a real jump (a seat, a rim, a slot) stands out.
    run(s, 6, [stepCrowd, stepBath], 1 / 2000, () => {
      for (const v of s.villagers) {
        const p = last.get(v.id)
        // followed through the step in which the bath lets go of him as well (the pose is still the bath's)
        if (p?.mine) worst = Math.max(worst, Math.hypot(v.x - p.x, v.y - p.y, v.z - p.z))
        const own = mine.has(v.state) && (v.state !== 'hopOut' || s.cauldron.bathers.includes(v.id))
        if (own) seen.add(v.state)
        if (p) {
          p.x = v.x
          p.y = v.y
          p.z = v.z
          p.mine = own
        } else last.set(v.id, { x: v.x, y: v.y, z: v.z, mine: own })
      }
    })
    expect([...seen].sort()).toEqual([...mine].sort())
    expect(s.stats.bathed).toBeGreaterThanOrEqual(4)
    expect(worst).toBeGreaterThan(0.01)
    expect(worst).toBeLessThan(0.05)
  })

  test('the batch period does not depend on the step size', () => {
    const periods = [1 / 60, 1 / 144, 1 / 83].map(dt => {
      const s = createState()
      place(s, AWAY)
      for (let i = 0; i < 4; i++) queued(s, i)
      s.cauldron.potion = 10
      // stepCrowd moves the second pair up to the front slots
      const log = run(s, 5, [stepCrowd, stepBath], dt)
      const splash = of(log, 'bathSplash')
      expect(splash.length).toBe(2)
      expectNear(splash[0]!.t, dt + landIn(2), dt + 1e-6)
      return splash[1]!.t - splash[0]!.t
    })
    // SPEC: a new pair lands about 1.5 s after the previous one when the queue is waiting
    for (const p of periods) {
      expectNear(p, periods[0]!, 2 * DT)
      expect(p).toBeGreaterThan(1.35)
      expect(p).toBeLessThan(1.6)
    }
  })

  test('potion accounting over several batches', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.usher = true
    for (const b of s.beds) b.exists = true // ten beds
    s.cauldron.potion = 7
    const potionAtSplash: number[] = []
    let seenSplashes = 0
    const log = run(s, 15, [stepCrowd, stepBath], DT, () => {
      const n = s.events.filter(e => e.type === 'bathSplash').length
      if (n > seenSplashes) potionAtSplash.push(s.cauldron.potion)
      seenSplashes = n
    })
    expect(potionAtSplash).toEqual([5, 3, 1]) // one unit per bather
    expect(of(log, 'bathSplash').length).toBe(3)
    expect(s.stats.bathed).toBe(6)
    expect(s.cauldron.batches).toBe(3)
    expect(s.cauldron.potion).toBe(1)
    // waiting for potion, not for beds
    expect(s.cauldron.bath).toBe('empty')
    expect(s.cauldron.blockedT).toBeGreaterThan(1)
    expect(s.cauldron.blockedByBeds).toBe(false)
    expect(inLine(s).length).toBe(4)

    s.cauldron.potion = 10 // the doctor pours
    run(s, 15, [stepCrowd, stepBath])
    // 4 beds were left: two more batches, then the beds are the limit
    expect(s.stats.bathed).toBe(10)
    expect(s.cauldron.potion).toBe(6)
    expect(freeBedCount(s)).toBe(0)
    expect(new Set(s.beds.map(b => b.villager)).size).toBe(10)
    expect(s.cauldron.blockedByBeds).toBe(true)
  })

  test('the first batch of the game pays double, through a fountain per bather', () => {
    const s = createState()
    place(s, AWAY)
    for (let i = 0; i < 4; i++) queued(s, i)
    s.cauldron.potion = 10
    const log = run(s, 2.2, [stepCrowd, stepBath])
    const first = of(log, 'coinFountain')
    expect(first.length).toBe(2)
    expectNear(first[0]!.t, DT + done(2) - P.BATH_HOP_STAGGER + P.FOUNTAIN_DELAY)
    expectNear(first[1]!.t, DT + done(2) + P.FOUNTAIN_DELAY)
    for (const f of first) {
      expect(f.e.gold).toBe(P.BATH_FEE * P.FIRST_BATCH_MULTIPLIER)
      expect(f.e.meshes).toBe(13) // SPEC 2.8: as many meshes as any other batch, each worth twice as much
      expect(f.e.duration).toBe(P.FOUNTAIN_DURATION)
      // it rises from the bather, who stands east of the pot
      expect(f.e.x).toBeGreaterThan(P.CAULDRON_COLLIDER_RADIUS)
    }
    expect(fountainGold(s)).toBe(100)
    const inc = s.pallet.incoming
    expect(inc.length).toBe(2 * 26)
    for (let i = 0; i < inc.length; i += 2) {
      // twelve coins of 4 gold and one of 2 per bather
      expect(inc[i + 1]).toBe(i % 26 === 24 ? P.GOLD_PER_COIN_MESH : P.GOLD_PER_COIN_MESH * P.FIRST_BATCH_MULTIPLIER)
      // every coin is in the air for COIN_FLIGHT, the last one lands FOUNTAIN_DURATION after the start
      expect(inc[i]!).toBeGreaterThanOrEqual(P.COIN_FLIGHT - DT)
      expect(inc[i]!).toBeLessThanOrEqual(P.FOUNTAIN_DURATION)
    }
    expect(Math.max(...inc.filter((_, i) => i % 2 === 0))).toBeGreaterThan(P.FOUNTAIN_DURATION - DT)

    const later = of(run(s, 3, [stepCrowd, stepBath]), 'coinFountain')
    expect(later.length).toBe(2)
    for (const f of later) {
      expect(f.e.gold).toBe(P.BATH_FEE)
      expect(f.e.meshes).toBe(13)
    }
    expect(fountainGold(s)).toBe(150)
    expect(s.pallet.incoming.every((v, i) => i % 2 === 0 || Number.isInteger(v))).toBe(true)
    expect(s.cauldron.fountains.length).toBe(0)
  })

  test('blockedByBeds when the beds run out (the ad at 47.9 s)', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.usher = true
    s.cauldron.potion = 10
    let everBlocked = false
    run(s, 6, [stepCrowd, stepBath], DT, () => {
      if (s.cauldron.bath !== 'empty' || s.stats.bathed < 4) everBlocked ||= s.cauldron.blockedByBeds
    })
    expect(everBlocked).toBe(false) // not flagged while batches still run
    // batches 3 and 4 of the ad: potion 10 -> 6, four beds reserved, two villagers left in the queue
    expect(s.stats.bathed).toBe(4)
    expect(s.cauldron.potion).toBe(6)
    expect(freeBedCount(s)).toBe(0)
    expect(inLine(s).length).toBe(2)
    expect(s.cauldron.bath).toBe('empty')
    expect(s.cauldron.blockedByBeds).toBe(true)
    expect(s.cauldron.blockedT).toBeGreaterThan(0)

    // one bed is not enough for the two-slot bath, and it never takes a single bather
    releaseBed(s, 0)
    run(s, 5, [stepCrowd, stepBath])
    expect(s.stats.bathed).toBe(4)
    expect(s.cauldron.blockedByBeds).toBe(true)
    expect(inLine(s).length).toBe(4) // but the usher fills the queue again
    releaseBed(s, 1)
    run(s, 3, [stepCrowd, stepBath])
    expect(s.stats.bathed).toBe(6)
    expect(s.cauldron.potion).toBe(4)
    expect(s.cauldron.blockedByBeds).toBe(true) // both beds are taken again and two villagers are left waiting
  })

  test('big cauldron: four at a time, capacity 20', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.bigCauldron = true
    for (let i = 0; i < 4; i++) queued(s, i)
    s.cauldron.potion = 3
    run(s, 1, [stepBath])
    expect(s.cauldron.slots).toBe(P.BATH_SLOTS_BIG)
    expect(s.cauldron.capacity).toBe(P.POTION_CAPACITY_BIG)
    expect(s.cauldron.bath).toBe('empty') // 3 potion is not enough for four
    expect(s.cauldron.blockedByBeds).toBe(false)
    s.cauldron.potion = 9
    const log = run(s, 3, [stepBath])
    expect(of(log, 'bathHopIn').length).toBe(4)
    expect(of(log, 'bathSplash')[0]!.e.count).toBe(4)
    expect(s.cauldron.potion).toBe(5)
    expect(s.stats.bathed).toBe(4)
    expect(freeBedCount(s)).toBe(0)
    expect(of(log, 'coinFountain').length).toBe(4)
    // a deposit may now fill it to 20
    s.cauldron.potion = 0
    place(s, AWAY)
    s.player.flasks = 12
    stepFlasks(s, DT)
    place(s, { x: 0, z: -3.8 })
    run(s, 3, [stepFlasks])
    expect(s.cauldron.potion).toBe(12)
  })

  test('big cauldron: partial batch after BATH_PARTIAL_WAIT when only some beds are free', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.bigCauldron = true
    for (let i = 0; i < 4; i++) queued(s, i)
    s.cauldron.potion = 8
    occupyBeds(s, 2) // two beds left
    const log = run(s, P.BATH_PARTIAL_WAIT - 0.1, [stepBath])
    expect(log.length).toBe(0)
    expect(s.cauldron.bath).toBe('empty')
    expect(s.cauldron.blockedByBeds).toBe(true)
    const log2 = run(s, 2.5, [stepBath])
    expect(of(log2, 'bathSplash')[0]!.e.count).toBe(2)
    expectNear(of(log2, 'bathHopIn')[0]!.t, 0.1 + P.BATH_PRE_HOP_WAIT, 2 * DT)
    expect(s.stats.bathed).toBe(2)
    expect(s.cauldron.potion).toBe(6)
    expect(freeBedCount(s)).toBe(0)
    // the front two went, the other two are still in the line
    expect(inLine(s).map(v => v.slot).sort()).toEqual([2, 3])
  })

  test('big cauldron: no partial batch without any free bed, and the wait restarts', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.bigCauldron = true
    for (let i = 0; i < 4; i++) queued(s, i)
    s.cauldron.potion = 8
    occupyBeds(s, 4)
    run(s, 5, [stepBath])
    expect(s.cauldron.bath).toBe('empty')
    expect(s.cauldron.blockedByBeds).toBe(true)
    releaseBed(s, 0)
    // a bed has just come free: others may follow, so it still waits BATH_PARTIAL_WAIT
    run(s, P.BATH_PARTIAL_WAIT - 0.2, [stepBath])
    expect(s.cauldron.bath).toBe('empty')
    for (let i = 1; i < 4; i++) releaseBed(s, i)
    stepBath(s, DT)
    expect(s.cauldron.bathers.length).toBe(4) // all four beds free: the full batch goes at once
  })

  test('end of the crowd: the odd villager is still bathed', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.usher = true
    s.crowd.remaining = 3
    s.cauldron.potion = 5
    const log = run(s, 9, [stepCrowd, stepBath])
    const splash = of(log, 'bathSplash')
    expect(splash.map(x => x.e.count)).toEqual([2, 1])
    expect(s.stats.bathed).toBe(3)
    expect(s.cauldron.potion).toBe(2)
    expect(s.crowd.remaining).toBe(0)
    expect(inLine(s).length).toBe(0)
    expect(s.cauldron.bath).toBe('empty')
    expect(freeBedCount(s)).toBe(1)
    // he waited BATH_LAST_WAIT at the front of the queue before going in alone
    const lone = of(log, 'bathHopIn')[2]!
    const prevOut = of(log, 'bathHopOut')[1]!
    expect(lone.t - prevOut.t).toBeGreaterThan(P.BATH_LAST_WAIT)
    expect(lone.t - prevOut.t).toBeLessThan(P.BATH_LAST_WAIT + 1.2)
  })

  test('end of the crowd: leftovers still need a dose and a bed each', () => {
    const s = createState()
    place(s, AWAY)
    s.crowd.remaining = 0
    queued(s, 0)
    run(s, 3, [stepCrowd, stepBath])
    expect(s.stats.bathed).toBe(0)
    expect(s.cauldron.blockedT).toBeGreaterThan(1)
    expect(s.cauldron.blockedByBeds).toBe(false) // no potion
    s.cauldron.potion = 1
    occupyBeds(s, 4)
    run(s, 2, [stepCrowd, stepBath])
    expect(s.stats.bathed).toBe(0)
    expect(s.cauldron.blockedByBeds).toBe(true)
    releaseBed(s, 3)
    run(s, 2, [stepCrowd, stepBath])
    expect(s.stats.bathed).toBe(1)
    expect(s.cauldron.potion).toBe(0)
  })

  test('a lone villager waits for a partner while the crowd is not empty', () => {
    const s = createState()
    place(s, AWAY)
    queued(s, 0)
    s.cauldron.potion = 5
    run(s, 5, [stepCrowd, stepBath])
    expect(s.stats.bathed).toBe(0)
    expect(s.cauldron.blockedT).toBe(0)
    // the doctor comes to the bay: one more is let out to complete the pair
    place(s, BAY)
    run(s, 4, [stepCrowd, stepBath], DT, () => {
      if (s.crowd.released === 1) place(s, AWAY)
    })
    expect(s.crowd.released).toBe(1)
    expect(s.stats.bathed).toBe(2)
  })
})

// ---------------------------------------------------------------------------------------------------------------

test('first loop of the game: M bubble -> 5 flasks -> potion 5 -> two bathers -> potion 3, 100 gold', () => {
  const s = createState()
  place(s, AWAY)
  dock(s, 'M', L.GRINDER[2] + 0.3, -2.8)
  const chain: Sys[] = [stepGrinder, stepFlasks, stepCrowd, stepBath]
  run(s, 2, chain)
  expect(s.groundFlasks.length).toBe(10)
  place(s, { x: L.FLASK_AREA.x, z: L.FLASK_AREA.z })
  run(s, 1, chain, DT, t => {
    // he walks up and down through the pile
    s.player.z = L.FLASK_AREA.z + Math.sin(t * TAU) * 1.2
  })
  expect(s.player.flasks).toBe(5)
  expect(s.groundFlasks.length).toBe(0)
  place(s, { x: 0.7, z: -4.2 })
  run(s, 1.5, chain)
  expect(s.cauldron.potion).toBe(5)
  expect(s.player.flasks).toBe(0)
  expect(s.crowd.released).toBe(0)
  place(s, BAY)
  const log = run(s, 5, chain, DT, () => {
    if (s.crowd.released === 2) place(s, AWAY) // he leaves for the pallet
  })
  expect(s.crowd.released).toBe(2)
  expect(s.stats.bathed).toBe(2)
  expect(s.cauldron.potion).toBe(3)
  expect(fountainGold(s)).toBe(100)
  const order = log.map(x => x.e.type).filter(t => ['gateOpen', 'villagerRelease', 'bathHopIn', 'bathSplash', 'bathCured', 'bathHopOut', 'coinFountain'].includes(t))
  expect(order).toEqual(['gateOpen', 'villagerRelease', 'villagerRelease', 'bathHopIn', 'bathHopIn', 'bathSplash', 'bathCured', 'bathHopOut', 'bathHopOut', 'coinFountain', 'coinFountain'])
})
