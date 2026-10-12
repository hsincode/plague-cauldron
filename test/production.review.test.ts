// Adversarial review of the production package (grinder, flasks, crowd, bath): edge cases, long seeded runs and
// the same scenarios at 60 Hz and 144 Hz. Only the package's own step functions are called; the ward is replaced
// by a stand-in that frees a bed some time after the bath has let go of a villager, so nothing here depends on
// another package being a stub or real.
import { describe, expect, test } from 'bun:test'
import { L, P, type BubbleSize } from '../src/config'
import { TAU } from '../src/core/math'
import { makeRng, rand } from '../src/core/rng'
import { BATH_SEAT_Y, stepBath } from '../src/sim/bath'
import { freeBedCount, releaseBed } from '../src/sim/beds'
import { queueMax, queueSlotX, queueSlotZ, stepCrowd } from '../src/sim/crowd'
import type { EventOf, EventType, GameEvent } from '../src/sim/events'
import { cauldronRoom, depositFlasks, pickupFlasks, stepFlasks } from '../src/sim/flasks'
import { GROUND_FLASK_MAX, stepGrinder } from '../src/sim/grinder'
import { createState } from '../src/sim/state'
import type { Bubble, GameState, Villager } from '../src/sim/types'

const HZ = [60, 144] as const
type Sys = (s: GameState, dt: number) => void
interface Stamped<E = GameEvent> {
  t: number
  e: E
}

/** Runs the systems for `seconds`; events are stamped with the end time of the step that emitted them and drained. */
function run(s: GameState, seconds: number, systems: Sys[], dt: number, each?: (t: number, fresh: GameEvent[]) => void, t0 = 0): Stamped[] {
  const log: Stamped[] = []
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i++) {
    const t = t0 + (i + 1) * dt
    s.time += dt
    for (const sys of systems) sys(s, dt)
    for (const e of s.events) log.push({ t, e })
    each?.(t, s.events)
    s.events.length = 0
  }
  return log
}
const of = <T extends EventType>(log: Stamped[], type: T) => log.filter(x => x.e.type === type) as Stamped<EventOf<T>>[]
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)

const AWAY = { x: 6, z: -8 }
const BAY = { x: -3.2, z: -1.8 }
const place = (s: GameState, p: { x: number; z: number }) => {
  s.player.x = p.x
  s.player.z = p.z
}
const inLine = (s: GameState) => s.villagers.filter(v => v.state === 'toQueue' || v.state === 'queued')

function dock(s: GameState, size: BubbleSize, x: number, z: number, tool = 0): Bubble {
  const b: Bubble = { id: s.nextId++, size, r: P.BUBBLE_DIAMETER[size] / 2, x, z, vx: 0, vz: 0, roll: 0, state: 'docked', t: 1, tool, age: 5 }
  s.bubbles.push(b)
  if (tool >= 0) s.tools[tool]!.bubble = b.id
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

/**
 * Stand-in for the ward: `delay` seconds after the bath has let go of a villager he vanishes and his bed is free
 * again. Works on ids only, so it does not care what state the real (or stub) ward gives him.
 */
function makeWard(delay: (id: number) => number) {
  const wasBathing = new Set<number>()
  const leaves = new Map<number, number>()
  return (s: GameState, t: number) => {
    const now = s.cauldron.bathers
    for (const id of wasBathing) {
      if (now.includes(id)) continue
      wasBathing.delete(id)
      leaves.set(id, t + delay(id))
    }
    for (const id of now) wasBathing.add(id)
    for (const [id, at] of leaves) {
      if (t < at) continue
      leaves.delete(id)
      const i = s.villagers.findIndex(v => v.id === id)
      if (i < 0) continue
      const bed = s.villagers[i]!.bed
      if (bed >= 0 && s.beds[bed]!.villager === id) releaseBed(s, bed)
      s.villagers.splice(i, 1)
    }
    s.pallet.incoming.length = 0 // the economy would land these
  }
}

// ---------------------------------------------------------------------------------------------------------------

describe('review: grinder', () => {
  const [X0, Z0, X1, Z1] = L.GRINDER

  test('accepts exactly on the edge of the grown rectangle and nowhere beyond it', () => {
    const m = P.GRINDER_ACCEPT_MARGIN
    const inside: [number, number][] = [[X1 + m, -2.8], [X0 - m, -2.8], [9.6, Z0 - m], [9.6, Z1 + m], [X1 + m, Z1 + m]]
    for (const [x, z] of inside) {
      const s = createState()
      dock(s, 'S', x, z)
      stepGrinder(s, 1 / 60)
      expect(s.grinder.state).toBe('grinding')
    }
    const outside: [number, number][] = [[X1 + m + 0.01, -2.8], [X0 - m - 0.01, -2.8], [9.6, Z0 - m - 0.01], [9.6, Z1 + m + 0.01]]
    for (const [x, z] of outside) {
      const s = createState()
      dock(s, 'S', x, z)
      stepGrinder(s, 1 / 60)
      expect(s.grinder.state).toBe('idle')
    }
  })

  test('only a docked bubble is taken: drifting, docking and fallen ones are left alone', () => {
    for (const state of ['drift', 'docking', 'gone'] as const) {
      const s = createState()
      const b = dock(s, 'M', X1, -2.8)
      b.state = state
      run(s, 1, [stepGrinder], 1 / 60)
      expect(s.grinder.state).toBe('idle')
      expect(b.state).toBe(state)
    }
  })

  test('the bubble leaves its tool at the moment the grinder takes it', () => {
    const s = createState()
    const b = dock(s, 'M', X1 + 0.3, -2.8)
    stepGrinder(s, 1 / 60)
    expect(b.state).toBe('grinder')
    expect(b.tool).toBe(-1)
    expect(b.vx).toBe(0)
    expect(b.vz).toBe(0)
    expect(s.grinder.t).toBeLessThan(0) // sliding: the SPEC timeline has not started
    expect(s.grinder.toEject).toBe(0)
  })

  test('a docked bubble without a tool is still ground (no call into a missing tool)', () => {
    const s = createState()
    const b = dock(s, 'S', X1, -2.8, -1)
    const log = run(s, 2, [stepGrinder], 1 / 60)
    expect(of(log, 'grindEnd').length).toBe(1)
    expect(s.bubbles.includes(b)).toBe(false)
    expect(s.stats.flasksMade).toBe(P.FLASK_YIELD.S)
  })

  test('the bubble vanishing during the slide or the grind does not break the timeline', () => {
    for (const cutAt of [0.05, 0.3]) {
      const s = createState()
      const b = dock(s, 'L', X1 + 0.4, -2.8)
      const log = run(s, 2.5, [stepGrinder], 1 / 60, t => {
        if (Math.abs(t - cutAt) < 1e-9) s.bubbles.splice(s.bubbles.indexOf(b), 1)
      })
      expect(of(log, 'grindStart').length).toBe(1)
      expect(of(log, 'grindShatter').length).toBe(1)
      expect(of(log, 'grindEnd').length).toBe(1)
      expect(of(log, 'flaskEject').length).toBe(18)
      expect(s.grinder.state).toBe('idle')
      expect(s.grinder.bubble).toBe(-1)
    }
  })

  test('every timeline event fires exactly once and in order, at both frame rates', () => {
    for (const hz of HZ) {
      const dt = 1 / hz
      for (const size of ['S', 'M', 'L'] as const) {
        const s = createState()
        dock(s, size, X1 + 0.5, Z0 - 0.5) // the far corner: the longest slide
        const log = run(s, 2.5, [stepGrinder], dt)
        // (the tool that is let go may add events of its own: only the grinder's are looked at)
        const order = log.map(x => x.e.type).filter(t => t.startsWith('grind'))
        expect(order).toEqual(['grindStart', 'grindCrack', 'grindShell', 'grindShatter', 'grindEnd'])
        const t0 = of(log, 'grindStart')[0]!.t
        const ej = of(log, 'flaskEject')
        expect(ej.length).toBe(P.FLASK_YIELD[size] * P.GROUND_MESHES_PER_UNIT)
        ej.forEach((e, i) => {
          const due = t0 + P.FLASK_EJECT_START + i * P.FLASK_EJECT_INTERVAL
          expect(e.t).toBeGreaterThan(due - dt - 1e-6)
          expect(e.t).toBeLessThan(due + dt + 1e-6)
        })
        // the flask's age says how long ago it really left, so its flight does not depend on the step size
        for (let i = 0; i < ej.length; i++) {
          const f = s.groundFlasks[i]!
          const due = t0 + P.FLASK_EJECT_START + i * P.FLASK_EJECT_INTERVAL
          expect(f.age).toBeLessThan(dt + 1e-6) // not stepped by stepFlasks here: still the age it was born with
          expect(ej[i]!.t - f.age).toBeGreaterThan(due - dt - 1e-6)
        }
        // t0 is the end of the step in which the bubble came to rest, up to one step after the rest itself
        expect(of(log, 'grindEnd')[0]!.t - t0).toBeGreaterThan(P.GRIND_FREE - dt - 1e-6)
        expect(of(log, 'grindEnd')[0]!.t - t0).toBeLessThan(P.GRIND_FREE + dt + 1e-6)
        expect(of(log, 'grindShatter')[0]!.t - t0).toBeGreaterThan(P.GRIND_SHARDS - dt - 1e-6)
        expect(of(log, 'grindShatter')[0]!.t - t0).toBeLessThan(P.GRIND_SHARDS + dt + 1e-6)
      }
    }
  })

  test('the slide never overshoots and ends exactly at rest', () => {
    for (const hz of HZ) {
      const s = createState()
      const b = dock(s, 'S', X1 + 0.5, Z1 + 0.5)
      const x0 = b.x
      const z0 = b.z
      let px = b.x
      let pz = b.z
      let rested = false
      run(s, 0.4, [stepGrinder], 1 / hz, (_t, ev) => {
        // monotonic toward the rest point, never past it
        expect(b.x).toBeLessThanOrEqual(px + 1e-9)
        expect(b.z).toBeLessThanOrEqual(pz + 1e-9)
        expect(b.x).toBeGreaterThanOrEqual(s.grinder.bx - 1e-9)
        expect(b.z).toBeGreaterThanOrEqual(s.grinder.bz - 1e-9)
        px = b.x
        pz = b.z
        if (ev.some(e => e.type === 'grindStart')) {
          rested = true
          expect(b.x).toBe(s.grinder.bx)
          expect(b.z).toBe(s.grinder.bz)
        }
      })
      expect(rested).toBe(true)
      expect(s.grinder.bx).toBeLessThan(x0)
      expect(s.grinder.bz).toBeLessThan(z0)
      // the rest point is on the tray
      expect(s.grinder.bx).toBeGreaterThanOrEqual(X0 + 0.5)
      expect(s.grinder.bx).toBeLessThanOrEqual(X1 - 0.5)
      expect(s.grinder.bz).toBeGreaterThanOrEqual(Z0 + 0.5)
      expect(s.grinder.bz).toBeLessThanOrEqual(Z1 - 0.5)
    }
  })

  test('a waiting second bubble is taken in the very step the tray is free: no idle gap', () => {
    const s = createState()
    dock(s, 'M', X1, -2.8, 0)
    const second = dock(s, 'L', X1 + 0.3, -1.5, 1)
    const log = run(s, 4, [stepGrinder], 1 / 60)
    const ends = of(log, 'grindEnd')
    const starts = of(log, 'grindStart')
    expect(ends.length).toBe(2)
    expect(starts.length).toBe(2)
    // accepted in the step of the first grindEnd, at rest GRIND_SLIDE_TIME later
    expect(starts[1]!.t - ends[0]!.t).toBeGreaterThan(P.GRIND_SLIDE_TIME - 1e-6)
    expect(starts[1]!.t - ends[0]!.t).toBeLessThan(P.GRIND_SLIDE_TIME + 1 / 60 + 1e-6)
    expect(s.bubbles.includes(second)).toBe(false)
    expect(s.stats.flasksMade).toBe(P.FLASK_YIELD.M + P.FLASK_YIELD.L)
  })

  test('fifty bubbles in a row: yields add up, the pile stays capped, nothing leaks or goes NaN', () => {
    for (const hz of HZ) {
      const s = createState(11)
      const r = makeRng(5)
      let units = 0
      let made = 0
      const sizes: BubbleSize[] = ['S', 'M', 'L']
      const ids = new Set<number>()
      const before = s.bubbles.length
      run(s, 90, [stepGrinder, stepFlasks], 1 / hz, (_t, ev) => {
        if (s.grinder.state === 'idle' && made < 50 && !s.bubbles.some(b => b.state === 'docked')) {
          const size = sizes[Math.floor(rand(r) * 3)]!
          units += P.FLASK_YIELD[size]
          made++
          dock(s, size, X0 - 0.5 + rand(r) * (X1 - X0 + 1), Z0 - 0.5 + rand(r) * (Z1 - Z0 + 1))
        }
        for (const e of ev) {
          if (e.type !== 'flaskEject') continue
          expect(ids.has(e.id)).toBe(false)
          ids.add(e.id)
          expect(e.fromX).toBe(X0)
          expect(Math.abs(e.toX - L.FLASK_AREA.x)).toBeLessThanOrEqual(L.FLASK_AREA.w / 2)
          expect(Math.abs(e.toZ - L.FLASK_AREA.z)).toBeLessThanOrEqual(L.FLASK_AREA.d / 2)
        }
        expect(s.groundFlasks.length).toBeLessThanOrEqual(GROUND_FLASK_MAX)
        expect(s.grinder.spin).toBeGreaterThanOrEqual(0)
        expect(s.grinder.spin).toBeLessThan(TAU)
      })
      expect(made).toBe(50)
      expect(s.stats.flasksMade).toBe(units)
      expect(ids.size).toBe(units * P.GROUND_MESHES_PER_UNIT)
      expect(s.groundFlasks.length).toBe(GROUND_FLASK_MAX)
      expect(s.bubbles.length).toBe(before) // every ground bubble was removed
      expect(s.grinder.state).toBe('idle')
      for (const f of s.groundFlasks) expect(Number.isFinite(f.x + f.z + f.age + f.rot + f.fromZ)).toBe(true)
    }
  })

  test('flasks of one pile do not land on top of each other', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = createState(seed)
      dock(s, 'L', X1, -2.8)
      run(s, 2, [stepGrinder], 1 / 60)
      const fl = s.groundFlasks
      expect(fl.length).toBe(18)
      for (let i = 0; i < fl.length; i++) for (let j = 0; j < i; j++) expect(Math.hypot(fl[i]!.x - fl[j]!.x, fl[i]!.z - fl[j]!.z)).toBeGreaterThan(0.35)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('review: flasks', () => {
  const C = { x: L.FLASK_AREA.x, z: L.FLASK_AREA.z }

  test('pickup takes the same time at 60 and 144 Hz', () => {
    const times = HZ.map(hz => {
      const s = createState()
      place(s, C)
      for (let i = 0; i < 18; i++) dropFlask(s, C.x + 0.1 * (i % 6) - 0.25, C.z + 0.2 * Math.floor(i / 6) - 0.2)
      const log = run(s, 1.5, [stepFlasks], 1 / hz)
      const picks = of(log, 'flaskPickup')
      expect(picks.length).toBe(18)
      expect(s.player.flasks).toBe(9)
      picks.forEach((p, i) => {
        const due = (i + 1) / (P.FLASK_PICKUP_RATE * P.GROUND_MESHES_PER_UNIT)
        expect(p.t).toBeGreaterThan(due - 1e-6)
        expect(p.t).toBeLessThan(due + 1 / hz + 1e-6)
      })
      return picks[17]!.t
    })
    expect(Math.abs(times[0]! - times[1]!)).toBeLessThan(1 / 60 + 1e-6)
  })

  test('no credit is banked while there is nothing to take', () => {
    const s = createState()
    place(s, C)
    run(s, 2, [stepFlasks], 1 / 60) // standing on an empty area for a long time
    dropFlask(s, C.x + 0.1, C.z)
    dropFlask(s, C.x + 0.2, C.z)
    const log = run(s, 0.2, [stepFlasks], 1 / 60)
    const picks = of(log, 'flaskPickup')
    expect(picks.length).toBe(2)
    expect(picks[0]!.t).toBeGreaterThan(1 / 28 - 1e-6)
    expect(picks[1]!.t - picks[0]!.t).toBeGreaterThan(1 / 28 - 1 / 60 - 1e-6)
  })

  test('the half unit is shared: porter and doctor never lose or invent a flask', () => {
    for (const hz of HZ) {
      const s = createState()
      place(s, C)
      const porter = { x: C.x + 0.4, z: C.z, flasks: 0, pickupAcc: 0 }
      for (let i = 0; i < 31; i++) dropFlask(s, C.x + 0.03 * i - 0.4, C.z + (i % 2 ? 0.2 : -0.2))
      for (let i = 0; i < 3 * hz; i++) {
        pickupFlasks(s, porter, P.PORTER_CARRY, 'porter', 1 / hz)
        stepFlasks(s, 1 / hz)
        expect(s.player.flasks).toBeLessThanOrEqual(P.FLASK_CARRY_MAX)
        expect(porter.flasks).toBeLessThanOrEqual(P.PORTER_CARRY)
      }
      const meshes = 31 - s.groundFlasks.length
      expect(s.player.flasks + porter.flasks).toBe(Math.floor(meshes / 2))
      expect(s.flaskHalf).toBe(meshes % 2)
      expect(s.groundFlasks.length).toBe(0) // 15 units fit in 12 + 6
      expect(of(s.events.map(e => ({ t: 0, e })), 'flaskPickup').filter(p => p.e.unitAdded).length).toBe(15)
    }
  })

  test('a full carrier takes nothing, not even the mesh that would complete a half unit', () => {
    const s = createState()
    place(s, C)
    s.player.flasks = P.FLASK_CARRY_MAX
    s.flaskHalf = 1
    for (let i = 0; i < 4; i++) dropFlask(s, C.x + 0.1 * i, C.z)
    run(s, 1, [stepFlasks], 1 / 60)
    expect(s.groundFlasks.length).toBe(4)
    expect(s.player.flasks).toBe(P.FLASK_CARRY_MAX)
    expect(s.flaskHalf).toBe(1)
  })

  test('flasks still in the air after the eject are not magnetised, whatever the step size', () => {
    for (const hz of HZ) {
      const s = createState()
      place(s, C)
      dropFlask(s, C.x, C.z, 0)
      const log = run(s, 0.5, [stepFlasks], 1 / hz)
      const pick = of(log, 'flaskPickup')[0]!
      expect(pick.t).toBeGreaterThanOrEqual(P.FLASK_EJECT_FLIGHT - 1e-9)
      expect(pick.t).toBeLessThan(P.FLASK_EJECT_FLIGHT + 1 / 28 + 2 / hz + 1e-6)
    }
  })

  test('deposit: flasks are conserved and the capacity is never exceeded, doctor and porter pouring together', () => {
    for (const hz of HZ) {
      const dt = 1 / hz
      const s = createState()
      s.cauldron.potion = 3
      place(s, { x: 0.2, z: -3.6 })
      s.player.flasks = 9
      const porter = { x: L.PORTER_POUR.x, z: L.PORTER_POUR.z, flasks: 6, depositT: P.DEPOSIT_DELAY, heading: 0 }
      const total = 3 + 9 + 6
      let lands = 0
      for (let i = 0; i < 4 * hz; i++) {
        depositFlasks(s, porter, 'porter', dt)
        stepFlasks(s, dt)
        const c = s.cauldron
        expect(c.potion + c.incoming.length).toBeLessThanOrEqual(c.capacity)
        expect(cauldronRoom(s)).toBeGreaterThanOrEqual(0)
        expect(c.potion + c.incoming.length + s.player.flasks + porter.flasks).toBe(total)
        for (const t of c.incoming) expect(t).toBeGreaterThan(0)
      }
      for (const e of s.events) if (e.type === 'flaskLand') expect(e.potion).toBe(3 + ++lands)
      expect(lands).toBe(7)
      expect(s.cauldron.potion).toBe(P.POTION_CAPACITY)
      expect(s.player.flasks + porter.flasks).toBe(total - P.POTION_CAPACITY)
      expect(s.cauldron.incoming.length).toBe(0)
    }
  })

  test('walking out of range stops the throws; what is in the air still lands; coming back starts with the delay', () => {
    const s = createState()
    place(s, AWAY)
    s.player.flasks = 9
    stepFlasks(s, 1 / 60)
    place(s, { x: 0.2, z: -3.6 })
    run(s, P.DEPOSIT_DELAY + 2.5 * P.DEPOSIT_INTERVAL, [stepFlasks], 1 / 60) // three thrown
    expect(s.player.flasks).toBe(6)
    place(s, AWAY)
    const log = run(s, 1, [stepFlasks], 1 / 60)
    expect(of(log, 'flaskThrow').length).toBe(0)
    expect(of(log, 'flaskLand').length).toBe(3)
    expect(s.cauldron.potion).toBe(3)
    expect(s.cauldron.sinceFill).toBeGreaterThan(0.5)
    place(s, { x: 0.2, z: -3.6 })
    const log2 = run(s, 1.5, [stepFlasks], 1 / 60)
    expect(of(log2, 'flaskThrow')[0]!.t).toBeGreaterThan(P.DEPOSIT_DELAY - 1e-6)
    expect(of(log2, 'flaskThrow')[0]!.t).toBeLessThan(P.DEPOSIT_DELAY + 1 / 60 + 1e-6)
    expect(s.cauldron.potion).toBe(9)
    expect(s.player.flasks).toBe(0)
  })

  test('a flask is thrown from the stack behind his back; beside a coin column the stack stands to his right', () => {
    for (const h of [0, Math.PI / 2, 2.3, -1.1]) {
      for (const gold of [0, 40]) {
        const s = createState()
        place(s, { x: 0.2, z: -3.6 })
        s.player.heading = h
        s.player.flasks = 3
        s.player.carriedGold = gold
        s.player.depositT = 0
        stepFlasks(s, 1 / 60)
        const e = s.events.find(x => x.type === 'flaskThrow') as EventOf<'flaskThrow'>
        const dx = e.fromX - s.player.x
        const dz = e.fromZ - s.player.z
        // forward = (sin h, cos h); his right-hand side = (-cos h, sin h)
        expect(dx * Math.sin(h) + dz * Math.cos(h)).toBeCloseTo(-0.45, 6)
        expect(dx * -Math.cos(h) + dz * Math.sin(h)).toBeCloseTo(gold > 0 ? 0.3 : 0, 6)
        expect(e.fromY).toBeCloseTo(0.3 + 2 * P.FLASK_STACK_PITCH + P.FLASK_BULB / 2, 6)
      }
    }
  })

  test('the whole pour takes the same time at 60 and 144 Hz, also for a pot of 20', () => {
    const times = HZ.map(hz => {
      const s = createState()
      s.cauldron.capacity = P.POTION_CAPACITY_BIG
      place(s, AWAY)
      s.player.flasks = P.FLASK_CARRY_MAX
      stepFlasks(s, 1 / hz)
      place(s, { x: 0, z: -4 })
      const lands = of(run(s, 3, [stepFlasks], 1 / hz), 'flaskLand')
      expect(lands.length).toBe(P.FLASK_CARRY_MAX)
      const due = P.DEPOSIT_DELAY + (P.FLASK_CARRY_MAX - 1) * P.DEPOSIT_INTERVAL + P.DEPOSIT_FLIGHT
      expect(lands[lands.length - 1]!.t).toBeGreaterThan(due - 1e-6)
      expect(lands[lands.length - 1]!.t).toBeLessThan(due + 1 / hz + 1e-6)
      return lands[lands.length - 1]!.t
    })
    expect(Math.abs(times[0]! - times[1]!)).toBeLessThan(1 / 60 + 1e-6)
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('review: queue order', () => {
  test('a villager fresh out of the gate never gets a slot ahead of someone already in the line', () => {
    for (const big of [false, true]) {
      for (const hz of HZ) {
        const s = createState()
        place(s, AWAY)
        s.unlocks.usher = true
        s.unlocks.bigCauldron = big
        for (const b of s.beds) b.exists = true
        s.cauldron.potion = 20
        const ward = makeWard(() => 0.5)
        const hops: number[] = []
        run(s, 40, [stepCrowd, stepBath], 1 / hz, (t, ev) => {
          const line = inLine(s)
          for (const e of ev) {
            if (e.type === 'bathHopIn') hops.push(e.id)
            if (e.type !== 'villagerRelease') continue
            const me = line.find(v => v.id === e.id)!
            for (const v of line) if (v !== me) expect(v.slot).toBeLessThan(me.slot)
          }
          // the line is ordered by seniority (ids grow with the release order) and has no holes or doubles
          const bySlot = [...line].sort((a, b) => a.slot - b.slot)
          for (let i = 1; i < bySlot.length; i++) {
            expect(bySlot[i]!.slot).toBe(bySlot[i - 1]!.slot + 1)
            expect(bySlot[i]!.id).toBeGreaterThan(bySlot[i - 1]!.id)
          }
          ward(s, t)
          s.cauldron.potion = Math.max(s.cauldron.potion, 8)
        })
        expect(hops.length).toBeGreaterThan(40)
        for (let i = 1; i < hops.length; i++) expect(hops[i]!).toBeGreaterThan(hops[i - 1]!) // first come, first bathed
      }
    }
  })
})

describe('review: cadence does not depend on the frame rate', () => {
  const PERIOD = P.BATH_PRE_HOP_WAIT + P.BATH_HOP_STAGGER + P.BATH_HOP_IN + P.BATH_CURE + P.BATH_CHECK + P.BATH_HOP_STAGGER + P.BATH_HOP_OUT

  test('back-to-back batches keep the nominal period: no step is lost between two batches', () => {
    for (const dt of [1 / 60, 1 / 144, 1 / 97, 1 / 75]) {
      const s = createState()
      place(s, AWAY)
      for (const b of s.beds) b.exists = true
      for (let i = 0; i < 10; i++) queued(s, i) // five pairs, ten beds
      s.cauldron.potion = 10
      const splash = of(run(s, 9, [stepCrowd, stepBath], dt), 'bathSplash')
      expect(splash.length).toBe(5)
      const first = dt + P.BATH_PRE_HOP_WAIT + P.BATH_HOP_STAGGER + P.BATH_HOP_IN
      splash.forEach((x, i) => {
        const due = first + i * PERIOD
        expect(x.t).toBeGreaterThan(due - 1e-6)
        expect(x.t).toBeLessThan(due + dt + 1e-6) // one step of quantisation in total, not one per batch
      })
    }
  })

  test('the usher releases one villager every USHER_RELEASE_INTERVAL from the first one on', () => {
    for (const dt of [1 / 60, 1 / 144, 1 / 97, 1 / 75]) {
      const s = createState()
      place(s, AWAY)
      s.unlocks.usher = true
      s.unlocks.bigCauldron = true // a queue of six: five intervals
      const out = of(run(s, 5, [stepCrowd], dt), 'villagerRelease')
      expect(out.length).toBe(P.QUEUE_MAX_BIG)
      for (let k = 1; k < out.length; k++) {
        const gap = out[k]!.t - out[0]!.t
        expect(gap).toBeGreaterThan(k * P.USHER_RELEASE_INTERVAL - 1e-6) // never early
        expect(gap).toBeLessThan(k * P.USHER_RELEASE_INTERVAL + dt + 1e-6)
      }
    }
  })

  test('the manual pair comes out USHER_RELEASE_INTERVAL apart at any step size', () => {
    for (const dt of [1 / 60, 1 / 144, 1 / 97]) {
      const s = createState()
      s.cauldron.potion = 5
      place(s, BAY)
      const out = of(run(s, 2, [stepCrowd], dt), 'villagerRelease')
      expect(out.length).toBe(2)
      expect(out[1]!.t - out[0]!.t).toBeGreaterThan(P.USHER_RELEASE_INTERVAL - 1e-6)
      expect(out[1]!.t - out[0]!.t).toBeLessThan(P.USHER_RELEASE_INTERVAL + dt + 1e-6)
    }
  })

  test('the usher scenario at 60 and 144 Hz: same events, same order, and the times do not drift apart', () => {
    const logs = HZ.map(hz => {
      const s = createState()
      place(s, AWAY)
      s.unlocks.usher = true
      s.cauldron.potion = 10
      return run(s, 8, [stepCrowd, stepBath], 1 / hz).filter(x => x.e.type !== 'coinFountain')
    })
    const [a, b] = logs as [Stamped[], Stamped[]]
    const key = (x: Stamped) => x.e.type + ('id' in x.e ? ':' + x.e.id : '')
    // events of different kinds may swap places inside one step, so the order is compared per kind
    for (const type of ['gateOpen', 'gateClose', 'villagerRelease', 'bathHopIn', 'bathSplash', 'bathCured', 'bathHopOut'] as const) {
      const xa = of(a, type)
      const xb = of(b, type)
      expect(xa.map(key)).toEqual(xb.map(key))
      // A few one-shot timers in a row (her run, the gate, the walk) are each rounded to a step; that offset
      // must stay what it is and not grow with every release and every batch.
      xa.forEach((x, i) => expect(Math.abs(x.t - xb[i]!.t)).toBeLessThan(4 / 60))
    }
    expect(of(a, 'bathSplash').length).toBe(2) // four beds
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('review: gate, manual release, usher', () => {
  test('passing through the bay for less than MANUAL_RELEASE_DELAY releases nobody', () => {
    const s = createState()
    s.cauldron.potion = 5
    for (let k = 0; k < 20; k++) {
      place(s, BAY)
      run(s, P.MANUAL_RELEASE_DELAY - 2 / 60, [stepCrowd], 1 / 60)
      place(s, AWAY)
      run(s, 0.1, [stepCrowd], 1 / 60)
    }
    expect(s.crowd.released).toBe(0)
    expect(s.gate.open).toBe(0)
  })

  test('the doctor camping in the bay: a pair at a time, never more villagers than potion or beds allow', () => {
    for (const hz of HZ) {
      const s = createState()
      s.cauldron.potion = 7
      place(s, BAY)
      const ward = makeWard(() => 2)
      let opens = 0
      let closes = 0
      run(s, 30, [stepCrowd, stepBath], 1 / hz, (t, ev) => {
        for (const e of ev) {
          if (e.type === 'gateOpen') opens++
          if (e.type === 'gateClose') closes++
        }
        expect(opens - closes === 0 || opens - closes === 1).toBe(true)
        expect(s.gate.open).toBeGreaterThanOrEqual(0)
        expect(s.gate.open).toBeLessThanOrEqual(1)
        expect(inLine(s).length).toBeLessThanOrEqual(P.BATH_SLOTS)
        // nobody is let out who could not be bathed with the potion that is there
        const committed = s.cauldron.bath === 'preHop' || s.cauldron.bath === 'hopIn' ? s.cauldron.bathers.length : 0
        expect(inLine(s).length + committed).toBeLessThanOrEqual(s.cauldron.potion)
        ward(s, t)
      })
      expect(s.crowd.released).toBe(6) // 7 potion: three pairs, one unit left
      expect(s.stats.bathed).toBe(6)
      expect(s.cauldron.potion).toBe(1)
      expect(inLine(s).length).toBe(0)
      expect(s.gate.open).toBe(0)
      expect(opens).toBe(closes)
    }
  })

  test('the usher is bought while a manual pair is half out: nobody is stranded', () => {
    for (const hz of HZ) {
      const s = createState()
      s.cauldron.potion = 10
      place(s, BAY)
      const ward = makeWard(() => 1)
      let switched = false
      run(s, 20, [stepCrowd, stepBath], 1 / hz, t => {
        if (!switched && s.crowd.released === 1) {
          switched = true
          s.unlocks.usher = true
          place(s, AWAY)
        }
        ward(s, t)
        s.cauldron.potion = Math.max(s.cauldron.potion, 4)
      })
      expect(switched).toBe(true)
      expect(s.usher.arrived).toBe(true)
      expect(s.stats.bathed).toBeGreaterThanOrEqual(10)
      expect(s.crowd.released + s.crowd.remaining).toBe(P.TOTAL_VILLAGERS)
    }
  })

  test('the usher does not release before she stands at her post, and faces the cauldron there', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.usher = true
    let firstOut = -1
    let arrived = -1
    run(s, 3, [stepCrowd], 1 / 144, (t, ev) => {
      if (arrived < 0 && s.usher.arrived) arrived = t
      if (firstOut < 0 && ev.some(e => e.type === 'villagerRelease')) firstOut = t
      expect(Number.isFinite(s.usher.x + s.usher.z + s.usher.heading)).toBe(true)
    })
    expect(arrived).toBeGreaterThan(0)
    // the gate starts to swing in the step in which she arrives
    expect(firstOut).toBeGreaterThan(arrived + P.GATE_SWING_TIME - 1 / 144 - 1e-6)
    expect(firstOut).toBeLessThan(arrived + P.GATE_SWING_TIME + 1 / 144 + 1e-6)
    const want = Math.atan2(L.CAULDRON.x - L.USHER_POST.x, L.CAULDRON.z - L.USHER_POST.z)
    expect(Math.abs(Math.atan2(Math.sin(s.usher.heading - want), Math.cos(s.usher.heading - want)))).toBeLessThan(0.02)
  })

  test('walkers reach their slots in a bounded time and never leave the pen-to-pot corridor', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.usher = true
    s.unlocks.bigCauldron = true
    const born = new Map<number, number>()
    run(s, 6, [stepCrowd], 1 / 60, (t, ev) => {
      for (const e of ev) if (e.type === 'villagerRelease') born.set(e.id, t)
      for (const v of s.villagers) {
        expect(v.y).toBe(0)
        expect(v.x).toBeGreaterThan(L.PEN.x - L.PEN.r) // inside the fence arc
        expect(v.x).toBeLessThan(L.QUEUE_SLOT0.x + 1e-6)
        expect(Math.hypot(v.x, v.z)).toBeGreaterThan(P.CAULDRON_COLLIDER_RADIUS)
        if (v.state === 'toQueue') expect(t - born.get(v.id)!).toBeLessThan(1.5)
      }
    })
    expect(inLine(s).every(v => v.state === 'queued')).toBe(true)
    expect(inLine(s).length).toBe(P.QUEUE_MAX_BIG)
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('review: bath', () => {
  test('SPEC 2.8: the doubled first batch is the same fountain with coins worth twice as much', () => {
    const s = createState()
    place(s, AWAY)
    for (const b of s.beds) b.exists = true
    for (let i = 0; i < 4; i++) queued(s, i)
    s.cauldron.potion = 10
    const amounts: number[][] = []
    const fountains: EventOf<'coinFountain'>[] = []
    run(s, 5, [stepCrowd, stepBath], 1 / 60, (_t, ev) => {
      for (const e of ev) {
        if (e.type !== 'coinFountain') continue
        fountains.push(e)
        amounts.push(s.pallet.incoming.filter((_, i) => i % 2 === 1))
        s.pallet.incoming.length = 0
      }
    })
    expect(fountains.length).toBe(4)
    const meshes = Math.ceil(P.BATH_FEE / P.GOLD_PER_COIN_MESH)
    fountains.forEach((f, i) => {
      const first = i < 2
      expect(f.gold).toBe(first ? P.BATH_FEE * P.FIRST_BATCH_MULTIPLIER : P.BATH_FEE)
      expect(f.meshes).toBe(meshes) // 25-26 meshes per pair, first batch or not
      expect(amounts[i]!.length).toBe(meshes)
      expect(sum(amounts[i]!)).toBe(f.gold)
      const worth = P.GOLD_PER_COIN_MESH * (first ? P.FIRST_BATCH_MULTIPLIER : 1)
      for (const a of amounts[i]!) {
        expect(Number.isInteger(a)).toBe(true)
        expect(a).toBeGreaterThan(0)
        expect(a).toBeLessThanOrEqual(worth)
      }
      expect(amounts[i]!.filter(a => a === worth).length).toBe(meshes - 1)
    })
  })

  test('fountain coins: each COIN_FLIGHT in the air, the stream lasts FOUNTAIN_DURATION, at both frame rates', () => {
    for (const hz of HZ) {
      const s = createState()
      place(s, AWAY)
      queued(s, 0)
      queued(s, 1)
      s.cauldron.potion = 2
      let seen = 0
      let outAt: number[] = []
      run(s, 3, [stepBath], 1 / hz, (t, ev) => {
        for (const e of ev) {
          if (e.type === 'bathHopOut') outAt.push(t)
          if (e.type !== 'coinFountain') continue
          const times = s.pallet.incoming.filter((_, i) => i % 2 === 0)
          s.pallet.incoming.length = 0
          // landed outside HOP_OUT after the leap, fountain FOUNTAIN_DELAY later
          const due = outAt[seen]! + P.BATH_HOP_OUT + P.FOUNTAIN_DELAY
          expect(t).toBeGreaterThan(due - 1 / hz - 1e-6)
          expect(t).toBeLessThan(due + 1 / hz + 1e-6)
          expect(Math.min(...times)).toBeGreaterThan(P.COIN_FLIGHT - 1 / hz - 1e-6)
          expect(Math.min(...times)).toBeLessThanOrEqual(P.COIN_FLIGHT + 1e-9)
          expect(Math.max(...times)).toBeGreaterThan(P.FOUNTAIN_DURATION - 1 / hz - 1e-6)
          expect(Math.max(...times)).toBeLessThanOrEqual(P.FOUNTAIN_DURATION + 1e-9)
          for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!)
          seen++
        }
      })
      expect(seen).toBe(2)
      expect(s.cauldron.fountains.length).toBe(0)
    }
  })

  test('hops of the big cauldron are continuous too (four seats, four exits)', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.bigCauldron = true
    for (let i = 0; i < 4; i++) queued(s, i)
    s.cauldron.potion = 4
    const last = new Map<number, { x: number; y: number; z: number }>()
    let worst = 0
    let top = 0
    const exits = new Set<string>()
    const seats = new Set<string>()
    run(s, 3, [stepCrowd, stepBath], 1 / 2000, () => {
      for (const v of s.villagers) {
        const p = last.get(v.id)
        if (p) worst = Math.max(worst, Math.hypot(v.x - p.x, v.y - p.y, v.z - p.z))
        last.set(v.id, { x: v.x, y: v.y, z: v.z })
        top = Math.max(top, v.y)
        expect(v.y).toBeGreaterThanOrEqual(0)
        if (v.state === 'bathing') {
          expect(v.y).toBe(BATH_SEAT_Y)
          seats.add(v.x + ',' + v.z)
          expect(Math.hypot(v.x, v.z)).toBeLessThan(P.CAULDRON_RIM_DIAMETER / 2 - 0.5)
        }
      }
    })
    expect(s.stats.bathed).toBe(4)
    for (const v of s.villagers) {
      exits.add(v.x + ',' + v.z)
      expect(v.y).toBe(0)
      expect(Math.hypot(v.x, v.z)).toBeGreaterThan(P.CAULDRON_COLLIDER_RADIUS)
      expect(v.x).toBeGreaterThan(0) // east side
    }
    expect(seats.size).toBe(4)
    expect(exits.size).toBe(4)
    expect(top).toBeCloseTo(P.CAULDRON_RIM_HEIGHT + 1.2, 2)
    expect(worst).toBeLessThan(0.05)
  })

  test('buying the big cauldron in the middle of a batch: the pair finishes, then four go', () => {
    for (const hz of HZ) {
      const s = createState()
      place(s, AWAY)
      s.unlocks.usher = true
      for (const b of s.beds) b.exists = true
      s.cauldron.potion = 10
      const counts: number[] = []
      run(s, 12, [stepCrowd, stepBath], 1 / hz, (_t, ev) => {
        if (s.cauldron.bath === 'curing') s.unlocks.bigCauldron = true
        for (const e of ev) if (e.type === 'bathSplash') counts.push(e.count)
        expect(s.cauldron.bathers.length).toBeLessThanOrEqual(s.cauldron.slots)
        expect(inLine(s).length).toBeLessThanOrEqual(queueMax(s))
        expect(s.cauldron.potion).toBeGreaterThanOrEqual(0)
      })
      expect(counts).toEqual([2, 4, 4])
      expect(s.cauldron.potion).toBe(0)
      expect(s.cauldron.capacity).toBe(P.POTION_CAPACITY_BIG)
      expect(s.stats.bathed).toBe(10)
      expect(freeBedCount(s)).toBe(0)
    }
  })

  test('potion is checked before beds: short of both, the bath is not "blocked by beds"', () => {
    const s = createState()
    place(s, AWAY)
    queued(s, 0)
    queued(s, 1)
    s.cauldron.potion = 1
    for (let i = 0; i < 4; i++) s.beds[i]!.state = 'occupied'
    run(s, 2, [stepBath], 1 / 60)
    expect(s.cauldron.blockedByBeds).toBe(false)
    expect(s.cauldron.blockedT).toBeGreaterThan(1.9)
    s.cauldron.potion = 2
    run(s, 0.5, [stepBath], 1 / 60)
    expect(s.cauldron.blockedByBeds).toBe(true)
    // the time counts for the new reason only
    expect(s.cauldron.blockedT).toBeGreaterThan(0.4)
    expect(s.cauldron.blockedT).toBeLessThan(0.6)
    releaseBed(s, 0)
    releaseBed(s, 1)
    stepBath(s, 1 / 60)
    expect(s.cauldron.bath).toBe('preHop')
    expect(s.cauldron.blockedT).toBe(0)
    expect(s.cauldron.blockedByBeds).toBe(false)
  })

  test('an empty queue is never "blocked"', () => {
    const s = createState()
    place(s, AWAY)
    for (let i = 0; i < 4; i++) s.beds[i]!.state = 'occupied'
    s.unlocks.usher = true
    run(s, 3, [stepCrowd, stepBath], 1 / 60)
    expect(inLine(s).length).toBe(0)
    expect(s.cauldron.blockedT).toBe(0)
    expect(s.cauldron.blockedByBeds).toBe(false)
  })

  test('end of the crowd with the big cauldron: leftovers go in by what potion and beds allow, nobody is stuck', () => {
    for (const hz of HZ) {
      const s = createState()
      place(s, AWAY)
      s.unlocks.usher = true
      s.unlocks.bigCauldron = true
      for (const b of s.beds) b.exists = true
      s.crowd.remaining = 7
      s.cauldron.potion = 6
      const ward = makeWard(() => 1.5)
      const counts: number[] = []
      run(s, 14, [stepCrowd, stepBath], 1 / hz, (t, ev) => {
        for (const e of ev) if (e.type === 'bathSplash') counts.push(e.count)
        ward(s, t)
      })
      // four, then the three left would need 3 doses but only 2 are there: two go, the last one waits for potion
      expect(counts).toEqual([4, 2])
      expect(s.cauldron.potion).toBe(0)
      expect(inLine(s).length).toBe(1)
      expect(s.cauldron.blockedByBeds).toBe(false)
      s.cauldron.potion = 1
      run(s, 4, [stepCrowd, stepBath], 1 / hz, t => ward(s, t), 14)
      expect(s.stats.bathed).toBe(7)
      expect(s.villagers.length).toBe(0)
      expect(s.crowd.remaining).toBe(0)
      expect(s.cauldron.bath).toBe('empty')
    }
  })

  test('big cauldron: a partial batch never takes more than the free beds, and reserves one bed per bather', () => {
    for (let free = 1; free <= 3; free++) {
      const s = createState()
      place(s, AWAY)
      s.unlocks.bigCauldron = true
      for (let i = 0; i < 4; i++) queued(s, i)
      s.cauldron.potion = 8
      for (let i = 0; i < 4 - free; i++) s.beds[i]!.state = 'occupied'
      const log = run(s, P.BATH_PARTIAL_WAIT + 2.5, [stepCrowd, stepBath], 1 / 60)
      const splash = of(log, 'bathSplash')
      expect(splash.length).toBe(1)
      expect(splash[0]!.e.count).toBe(free)
      expect(s.cauldron.potion).toBe(8 - free)
      expect(freeBedCount(s)).toBe(0)
      expect(s.stats.bathed).toBe(free)
      const beds = s.villagers.filter(v => v.bed >= 0).map(v => v.bed)
      expect(new Set(beds).size).toBe(free)
      // the others closed up to the front and still wait
      expect(inLine(s).map(v => v.slot).sort()).toEqual([0, 1, 2, 3].slice(0, 4 - free))
    }
  })

  test('the two-slot bath never starts with one bather while the crowd is not empty', () => {
    const s = createState()
    place(s, AWAY)
    s.unlocks.usher = true
    s.cauldron.potion = 10
    for (let i = 0; i < 3; i++) s.beds[i]!.state = 'occupied' // one bed
    const log = run(s, 10, [stepCrowd, stepBath], 1 / 60)
    expect(of(log, 'bathSplash').length).toBe(0)
    expect(inLine(s).length).toBe(P.QUEUE_MAX) // one free bed is enough for the usher
    expect(s.cauldron.blockedByBeds).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------

describe('review: robustness', () => {
  test('a step of zero length moves nothing and advances no clock, in any state', () => {
    const s = createState(3)
    place(s, AWAY)
    s.unlocks.usher = true
    s.cauldron.potion = 6
    s.player.flasks = 4
    const systems = [stepGrinder, stepFlasks, stepCrowd, stepBath]
    // Everything that is a time or a position. (Decisions may still be taken in such a step: a system reacts
    // to what a later system did in the step before.)
    const snap = () =>
      JSON.stringify([
        s.grinder.t, s.grinder.spin, s.grinder.ejectT, s.groundFlasks, s.cauldron.t, s.cauldron.incoming, s.cauldron.sinceFill, s.cauldron.fountains,
        s.cauldron.potion, s.cauldron.blockedT, s.cauldron.waitT, s.crowd.releaseT, s.crowd.manualT, s.crowd.remaining, s.gate.open, s.gate.idleT, s.usher,
        s.villagers.map(v => [v.x, v.y, v.z, v.heading, v.t]), s.pallet.incoming, s.player.flasks, s.flaskHalf, s.stats,
      ])
    let stage = 0
    run(s, 9, systems, 1 / 60, t => {
      // the outside world changes something: the next real step reacts to it, so nothing is checked in this one
      if (stage === 0 && t > 0.5) return void (stage++, dock(s, 'M', L.GRINDER[2], -2.8))
      if (stage === 1 && t > 2) return void (stage++, place(s, { x: L.FLASK_AREA.x, z: L.FLASK_AREA.z }))
      if (stage === 2 && t > 3) return void (stage++, place(s, { x: 0.2, z: -3.6 }))
      const before = snap()
      const rng = s.rng.s
      for (const sys of systems) sys(s, 0)
      expect(snap()).toBe(before)
      expect(s.rng.s).toBe(rng)
    })
    expect(s.stats.bathed).toBeGreaterThanOrEqual(4)
    expect(s.stats.flasksMade).toBe(5)
  })

  test('very small steps: nothing goes NaN and the same things happen', () => {
    const s = createState(3)
    place(s, AWAY)
    s.unlocks.usher = true
    s.cauldron.potion = 4
    dock(s, 'S', L.GRINDER[2], -2.8)
    const log = run(s, 5, [stepGrinder, stepFlasks, stepCrowd, stepBath], 1 / 4000)
    expect(of(log, 'flaskEject').length).toBe(6)
    expect(of(log, 'bathSplash').length).toBe(2)
    expect(of(log, 'villagerRelease').length).toBe(6) // two pairs bathed, the queue refilled to four
    const flat = JSON.stringify([s.grinder, s.groundFlasks, s.cauldron, s.crowd, s.gate, s.usher, s.villagers])
    expect(flat.includes('null')).toBe(false) // JSON turns NaN and Infinity into null
  })

  test('a released villager is the crowd instance that disappears: the farthest one still standing', async () => {
    const { CROWD_SLOTS } = await import('../src/world/crowd')
    const s = createState()
    place(s, AWAY)
    s.unlocks.usher = true
    s.unlocks.bigCauldron = true
    run(s, 4, [stepCrowd], 1 / 60)
    expect(s.villagers.length).toBe(6)
    s.villagers.forEach((v, k) => {
      expect(v.seed).toBe(CROWD_SLOTS[CROWD_SLOTS.length - P.TOTAL_VILLAGERS + k]!.seed)
      expect(v.look).toBe('sick')
      expect(v.speed).toBe(P.SICK_WALK_SPEED)
      expect(v.alpha).toBe(1)
      expect(v.bed).toBe(-1)
    })
  })
})

describe('review: long seeded runs', () => {
  /**
   * A whole crowd through gate, queue and bath with a random schedule: when the usher and the big cauldron are
   * bought, how long beds stay taken, when potion arrives and where the doctor stands.
   */
  function soak(seed: number, hz: number) {
    const dt = 1 / hz
    const r = makeRng(seed)
    const s = createState(seed)
    place(s, AWAY)
    const total = 40 + Math.floor(rand(r) * 50)
    s.crowd.remaining = total
    const usherAt = rand(r) * 25
    const bigAt = rand(r) < 0.6 ? usherAt + 5 + rand(r) * 25 : Infinity
    const ward2At = rand(r) * 40
    const stay = 0.4 + rand(r) * 5
    const ward = makeWard(id => stay * (0.6 + 0.8 * ((id * 0.618) % 1)))
    let nextPour = 0
    let gate = 0
    const hops: number[] = []
    let gold = 0
    let potionIn = 0
    let lastBathed = 0
    let lastProgress = 0
    let worstStall = 0
    const counts: Partial<Record<EventType, number>> = {}
    const T = 420
    run(s, T, [stepCrowd, stepBath], dt, (t, ev) => {
      for (const e of ev) {
        counts[e.type] = (counts[e.type] ?? 0) + 1
        if (e.type === 'gateOpen') expect(++gate).toBe(1)
        if (e.type === 'gateClose') expect(--gate).toBe(0)
        if (e.type === 'bathHopIn') hops.push(e.id)
        if (e.type === 'coinFountain') {
          gold += e.gold
          expect(Number.isFinite(e.x + e.z)).toBe(true)
        }
        if (e.type === 'bathSplash') expect(e.count).toBe(s.cauldron.bathers.length)
      }
      const c = s.cauldron
      const line = inLine(s)
      expect(line.length).toBeLessThanOrEqual(queueMax(s))
      expect(new Set(line.map(v => v.slot)).size).toBe(line.length)
      for (const v of line) expect(v.slot).toBeLessThan(queueMax(s))
      expect(c.bathers.length).toBeLessThanOrEqual(c.slots)
      expect(Number.isInteger(c.potion)).toBe(true)
      expect(c.potion).toBeGreaterThanOrEqual(0)
      expect(s.crowd.released + s.crowd.remaining).toBe(total)
      expect(s.crowd.pendingRelease).toBeGreaterThanOrEqual(0)
      expect(s.gate.open).toBeGreaterThanOrEqual(0)
      expect(s.gate.open).toBeLessThanOrEqual(1)
      expect(c.fountains.length % 3).toBe(0)
      expect(c.fountains.length).toBeLessThanOrEqual(3 * P.BATH_SLOTS_BIG)
      for (const v of s.villagers) expect(Number.isFinite(v.x + v.y + v.z + v.heading + v.t)).toBe(true)
      // every bather holds a bed of his own
      for (const id of c.bathers) {
        const v = s.villagers.find(x => x.id === id)!
        expect(v.bed).toBeGreaterThanOrEqual(0)
        expect(s.beds[v.bed]!.villager).toBe(id)
      }

      if (t >= usherAt) s.unlocks.usher = true
      if (t >= bigAt) s.unlocks.bigCauldron = true
      if (t >= ward2At) for (const b of s.beds) b.exists = true
      // the doctor is in the bay one third of the time, and there whenever the queue needs him at the end
      const inBay = Math.floor(t / 2.5 + seed) % 3 === 0 || t > T - 120
      place(s, inBay ? { x: -6.9, z: -1.8 } : AWAY)
      if (t >= nextPour) {
        const add = Math.min(c.capacity - c.potion, 1 + Math.floor(rand(r) * 9))
        c.potion += add
        potionIn += add
        nextPour = t + 1 + rand(r) * 8
      }
      ward(s, t)
      if (s.stats.bathed !== lastBathed) {
        lastBathed = s.stats.bathed
        lastProgress = t
      }
      if (s.stats.bathed < total) worstStall = Math.max(worstStall, t - lastProgress)
    })
    return { s, total, hops, gold, potionIn, counts, worstStall }
  }

  for (const hz of HZ) {
    test(`twelve random crowds are bathed to the last villager at ${hz} Hz`, () => {
      for (let seed = 1; seed <= 12; seed++) {
        const { s, total, hops, gold, potionIn, counts, worstStall } = soak(seed, hz)
        expect(s.stats.bathed).toBe(total)
        expect(s.crowd.remaining).toBe(0)
        expect(s.crowd.released).toBe(total)
        expect(s.villagers.length).toBe(0)
        expect(s.cauldron.bath).toBe('empty')
        expect(s.cauldron.bathers.length).toBe(0)
        expect(s.cauldron.fountains.length).toBe(0)
        expect(s.gate.open).toBe(0)
        expect(counts.villagerRelease).toBe(total)
        expect(counts.bathHopIn).toBe(total)
        expect(counts.bathHopOut).toBe(total)
        expect(counts.coinFountain).toBe(total)
        expect(counts.bathSplash).toBe(s.cauldron.batches)
        expect(counts.bathCured).toBe(s.cauldron.batches)
        expect(counts.gateOpen).toBe(counts.gateClose)
        // one potion unit per bather, 25 gold each, the first batch doubled
        expect(potionIn - s.cauldron.potion).toBe(total)
        expect(gold).toBe(total * P.BATH_FEE + P.BATH_SLOTS * P.BATH_FEE * (P.FIRST_BATCH_MULTIPLIER - 1))
        expect(new Set(hops).size).toBe(total)
        for (let i = 1; i < hops.length; i++) expect(hops[i]!).toBeGreaterThan(hops[i - 1]!)
        expect(worstStall).toBeLessThan(60)
      }
    })
  }

  test('the same crowd at 60 and 144 Hz is bathed in the same order for the same gold', () => {
    for (let seed = 21; seed <= 24; seed++) {
      const a = soak(seed, 60)
      const b = soak(seed, 144)
      expect(a.s.stats.bathed).toBe(b.s.stats.bathed)
      expect(a.hops).toEqual(b.hops)
      expect(a.gold).toBe(b.gold)
    }
  })
})
