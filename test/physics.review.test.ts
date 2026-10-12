// Adversarial review of the physics package (player.ts, tools.ts, river.ts): regressions for the bugs the review
// found, long seeded random runs, and every scenario at both ends of the allowed step range (1/60 and 1/144).
// Only stepPlayer / stepRiver / the tools.ts entry points are driven; the grinder is played by a stand-in that calls
// onBubbleDelivered the way grinder.ts does, so nothing here depends on another package.
import { describe, expect, test } from 'bun:test'
import { L, P, type BubbleSize } from '../src/config'
import { angleDelta } from '../src/core/math'
import { makeRng, rand, type Rng } from '../src/core/rng'
import type { GameEvent } from '../src/sim/events'
import { staticPenetration, stepCartMover, stepPlayer, type Mover } from '../src/sim/player'
import { stepRiver } from '../src/sim/river'
import { createState } from '../src/sim/state'
import { BLADE_ARCS, cartBody, dockSeat, onBubbleDelivered, parkTool } from '../src/sim/tools'
import { BALL_FALL, BALL_FLOW, BALL_LOOSE, BALL_STRAY, type Bubble, type GameState } from '../src/sim/types'
import { RIVER_LENGTH, riverSample } from '../src/world/river'

const DTS = [1 / 60, 1 / 144] as const
const NORTH = Math.PI
const EAST = Math.PI / 2
const WEST = -Math.PI / 2
const hz = (dt: number) => `${Math.round(1 / dt)} Hz`

function quiet(seed = 1): GameState {
  const s = createState(seed)
  s.bubbles.length = 0
  s.bubbleSpawnT = 1e9
  return s
}

function onFoot(x: number, z: number, heading = 0): GameState {
  const s = quiet()
  parkTool(s, 0)
  s.tools[0]!.exists = false
  s.events.length = 0
  Object.assign(s.player, { x, z, heading, vx: 0, vz: 0 })
  return s
}

function withScoop(x: number, z: number, heading: number, seed = 1): GameState {
  const s = quiet(seed)
  Object.assign(s.player, { x, z, heading, vx: 0, vz: 0 })
  Object.assign(s.tools[0]!, { x, z, heading })
  return s
}

function onCart(x: number, z: number, heading: number, seed = 1): GameState {
  const s = quiet(seed)
  s.unlocks.cart = true
  Object.assign(s.tools[0]!, { kind: 'cart', x, z, heading, holder: 'player', armed: false })
  Object.assign(s.player, { x, z, heading, vx: 0, vz: 0, mode: 'cart', tool: 0 })
  return s
}

function addBubble(s: GameState, size: BubbleSize, x: number, z: number, state: Bubble['state'] = 'drift', tool = -1): Bubble {
  const b: Bubble = { id: s.nextId++, size, r: P.BUBBLE_DIAMETER[size] / 2, x, z, vx: 0, vz: 0, roll: 0, state, t: 0, tool, age: 5 }
  s.bubbles.push(b)
  if (tool >= 0) s.tools[tool]!.bubble = b.id
  return b
}

function run(s: GameState, mx: number, mz: number, seconds: number, dt: number, opts: { river?: boolean; each?: () => void } = {}) {
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i++) {
    stepPlayer(s, { mx, mz }, dt)
    if (opts.river) stepRiver(s, dt)
    opts.each?.()
  }
}

const speedOf = (s: GameState) => Math.hypot(s.player.vx, s.player.vz)
const eventsOf = <T extends GameEvent['type']>(s: GameState, type: T) => s.events.filter(e => e.type === type) as Extract<GameEvent, { type: T }>[]
const countState = (s: GameState, st: number) => {
  let n = 0
  for (let i = 0; i < s.balls.n; i++) if (s.balls.state[i] === st) n++
  return n
}
const bodyPen = (s: GameState) => {
  const body = cartBody(s.tools[0]!)
  return staticPenetration(s, body.x, body.z, P.CART_BODY_RADIUS)
}

/** What grinder.ts does when it takes a docked bubble: the bubble leaves the tool, the tool is told. */
function fakeGrinder(s: GameState): boolean {
  const [x0, z0, x1, z1] = L.GRINDER
  const m = P.GRINDER_ACCEPT_MARGIN
  for (let i = 0; i < s.bubbles.length; i++) {
    const b = s.bubbles[i]!
    if (b.state !== 'docked' || b.x < x0 - m || b.x > x1 + m || b.z < z0 - m || b.z > z1 + m) continue
    const tool = b.tool
    b.state = 'grinder'
    b.tool = -1
    onBubbleDelivered(s, tool)
    b.state = 'gone'
    s.bubbles.splice(i, 1)
    return true
  }
  return false
}

function assertFinite(s: GameState, where: string) {
  const p = s.player
  if (!Number.isFinite(p.x + p.z + p.vx + p.vz + p.heading + p.stillT + p.odo + p.pushedT + p.pushVx + p.pushVz + p.emojiT + p.mountT + p.dismountT)) throw new Error(`player not finite ${where}`)
  for (const t of s.tools) if (!Number.isFinite(t.x + t.z + t.heading + t.age)) throw new Error(`tool not finite ${where}`)
  for (const b of s.bubbles) if (!Number.isFinite(b.x + b.z + b.vx + b.vz + b.roll + b.t + b.age)) throw new Error(`bubble not finite ${where}`)
}

function assertBalls(s: GameState, where: string) {
  const b = s.balls
  let strays = 0
  for (let i = 0; i < b.n; i++) {
    if (!Number.isFinite(b.x[i]! + b.z[i]! + b.y[i]! + b.vx[i]! + b.vz[i]! + b.vy[i]! + b.t[i]!)) throw new Error(`ball ${i} not finite ${where}`)
    const st = b.state[i]!
    if (st > BALL_FALL) throw new Error(`ball ${i} in state ${st} ${where}`)
    if (st === BALL_STRAY) strays++
    else if (st === BALL_FLOW && b.y[i] !== 0) throw new Error(`flow ball ${i} off the ground ${where}`)
  }
  if (strays > P.MAX_STRAYS) throw new Error(`${strays} strays ${where}`)
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * A player who knows the way: drives the cart from wherever it is around the grinder back into the river. The cart
 * cannot reverse and the grinder, the boulders and the conifers leave it one route: round the grinder's north-west
 * corner, along the corridor north of it and through the slot between its north-east corner and the first boulder.
 * Returns the seconds it took, or -1 (thrown off, or not there within `limit`).
 */
function driveHome(s: GameState, dt: number, limit: number, each?: () => void): number {
  const p = s.player
  let still = 0
  let perturb = 0
  let sign = 1
  for (let t = 0; t < limit; t += dt) {
    if (p.x > 15.5 && p.z > -7) return t
    let tx = 17
    let tz = -4.5
    if (p.z > -0.6 && p.x > 8.5 && p.x < 12) {
      tx = 8.0 // the pocket south of the grinder: to its west end first
      tz = 1.3
    } else if (p.z > -6.9 && p.x < 11.3) {
      tx = p.x // west or south of the grinder: north, round its north-west corner
      tz = -9
    } else if (p.x < 9.2) {
      tx = 9.6 // the corridor north of it
      tz = -7.9
    } else if (p.z < -6.2 && p.x < 12.6) {
      tx = 13.4 // the slot between its corner and the boulder
      tz = -5.2
    }
    const d = Math.hypot(tx - p.x, tz - p.z) || 1
    let mx = (tx - p.x) / d
    let mz = (tz - p.z) / d
    if (perturb > 0) {
      // no headway: steer off to one side for a moment, the other side next time
      const c = Math.cos(1.2 * sign)
      const sn = Math.sin(1.2 * sign)
      const nx = mx * c - mz * sn
      mz = mx * sn + mz * c
      mx = nx
      perturb -= dt
    }
    if (s.tools[0]!.bubble === -1 && mx < 0) mx = 0 // steering west at the boundary is how he gets off
    const x = p.x
    const z = p.z
    const h = p.heading
    stepPlayer(s, { mx, mz }, dt)
    each?.()
    if (p.mode !== 'cart') return -1
    if (Math.hypot(p.x - x, p.z - z) < 0.3 * dt && p.heading === h) {
      still += dt
      if (still > 0.4) {
        perturb = 0.7
        sign = -sign
        still = 0
      }
    } else still = 0
  }
  return -1
}

describe('review: the cart at the work-area boundary', () => {
  for (const dt of DTS) {
    test(`a cart left at x = 8.2 can be mounted again and driven away (${hz(dt)})`, () => {
      const s = onCart(11, 1.5, WEST)
      run(s, -1, 0, 2, dt) // drive it west: left at the boundary, he walks on
      const tool = s.tools[0]!
      expect(s.player.mode).toBe('foot')
      expect(tool.holder).toBe('none')
      expect(tool.x).toBeCloseTo(P.WORK_AREA_MIN_X, 6)
      expect(Math.abs(angleDelta(tool.heading, WEST))).toBeLessThan(0.05)

      // away (to re-arm), then back to the seat from the east side and straight on east
      s.events.length = 0
      const goTo = (tx: number, tz: number, seconds: number, stopAtCart = false) => {
        for (let i = 0; i < seconds / dt; i++) {
          const dx = tx - s.player.x
          const dz = tz - s.player.z
          const d = Math.hypot(dx, dz)
          if (d < 0.1 || (stopAtCart && s.player.mode === 'cart')) return
          stepPlayer(s, { mx: dx / d, mz: dz / d }, dt)
        }
      }
      goTo(12, -1.5, 3)
      expect(tool.armed).toBe(true)
      goTo(tool.x + 0.7, tool.z - 0.3, 3, true)
      run(s, 1, 0, 0.5, dt) // finish the hop with the stick held east
      expect(s.player.mode).toBe('cart')
      expect(eventsOf(s, 'cartMount')).toHaveLength(1)
      // the stick stays east: the cart turns round at the boundary and drives back into the work area
      run(s, 1, 0, 3, dt, { each: () => expect(bodyPen(s)).toBeLessThanOrEqual(1e-3) })
      expect(s.player.mode).toBe('cart')
      expect(tool.holder).toBe('player')
      expect(eventsOf(s, 'cartDismount')).toHaveLength(0)
      expect(eventsOf(s, 'toolPark')).toHaveLength(0)
      expect(s.player.x).toBeGreaterThan(P.WORK_AREA_MIN_X + 1)
      expect(Math.abs(angleDelta(s.player.heading, EAST))).toBeLessThan(0.2)
    }, 30000)

    test(`the way a player really gets off: west along the corridor north of the grinder, then south-west (${hz(dt)})`, () => {
      const s = onCart(13.4, -5.3, WEST - 0.6) // coming out of the river through the slot beside the grinder
      const tool = s.tools[0]!
      let t = 0
      while (s.player.mode === 'cart' && t < 6) {
        const p = s.player
        stepPlayer(s, p.x > 9 ? { mx: 8.6 - p.x, mz: -7.9 - p.z } : { mx: -0.7, mz: 0.7 }, dt)
        t += dt
        if (s.player.mode === 'cart') expect(bodyPen(s)).toBeLessThanOrEqual(1e-3)
      }
      expect(t).toBeLessThan(4)
      expect(s.player.mode).toBe('foot')
      expect(tool.holder).toBe('none')
      expect(eventsOf(s, 'cartDismount')).toHaveLength(1)
      const park = eventsOf(s, 'toolPark')
      expect(park).toHaveLength(1)
      expect([park[0]!.x, park[0]!.z]).toEqual([tool.x, tool.z])
      expect(Math.abs(tool.x - P.WORK_AREA_MIN_X)).toBeLessThan(0.1)
      expect(tool.z).toBeGreaterThan(-8.6)
      expect(tool.z).toBeLessThan(-6.8)
      expect(bodyPen(s)).toBeLessThanOrEqual(1e-3)
      run(s, -1, 0.2, 1.5, dt) // he walks on, into the courtyard
      expect(s.player.x).toBeLessThan(P.WORK_AREA_MIN_X - 2)
      expect(staticPenetration(s, s.player.x, s.player.z, P.PLAYER_RADIUS)).toBe(0)
      expect([tool.holder, tool.armed]).toEqual(['none', true])

      // Later he comes back for it. (Parked there the wagon closes the gap between the yard wall and the grinder,
      // so the walk back leads round the grinder; the test skips it and puts him behind the bench.)
      s.events.length = 0
      Object.assign(s.player, { x: tool.x - Math.sin(tool.heading) * 1.0, z: tool.z - Math.cos(tool.heading) * 1.0, vx: 0, vz: 0 })
      expect(staticPenetration(s, s.player.x, s.player.z, P.PLAYER_RADIUS)).toBe(0)
      for (let i = 0; i < 1 / dt && s.player.mode !== 'cart'; i++) stepPlayer(s, { mx: Math.sin(tool.heading), mz: Math.cos(tool.heading) }, dt)
      expect(eventsOf(s, 'cartMount')).toHaveLength(1)
      expect(s.player.mode).toBe('cart')
      const took = driveHome(s, dt, 15, () => expect(bodyPen(s)).toBeLessThanOrEqual(1e-3))
      expect(took).toBeGreaterThan(0)
      expect(took).toBeLessThan(10)
      expect(eventsOf(s, 'cartDismount')).toHaveLength(0)
    }, 30000)
  }

  test('only steering west into the boundary leaves the cart; any other input is just blocked there', () => {
    for (const dt of DTS) {
      // sitting on a cart parked at the boundary, pointing west: north, south, east and no input keep him seated
      for (const [mx, mz] of [[0, -1], [0, 1], [1, 0], [0.7, 0.7], [0.1, -1], [0, 0]] as const) {
        const s = onCart(P.WORK_AREA_MIN_X, 1.5, WEST)
        run(s, mx, mz, 1.5, dt, {
          each: () => {
            expect(s.tools[0]!.x).toBe(s.player.x)
            expect(bodyPen(s)).toBeLessThanOrEqual(1e-3)
          },
        })
        expect(s.player.mode).toBe('cart')
        expect(s.events.filter(e => e.type === 'toolPark' || e.type === 'cartDismount')).toHaveLength(0)
      }
      // west, also diagonally: he hops off and the cart stays at the boundary
      for (const [mx, mz] of [[-1, 0], [-0.7, 0.7], [-0.7, -0.7], [-0.3, 0.95]] as const) {
        const s = onCart(P.WORK_AREA_MIN_X + 0.3, 1.5, WEST)
        run(s, mx, mz, 0.8, dt)
        expect(s.player.mode).toBe('foot')
        expect(s.tools[0]!.holder).toBe('none')
        expect(Math.abs(s.tools[0]!.x - P.WORK_AREA_MIN_X)).toBeLessThan(0.05)
        expect(eventsOf(s, 'cartDismount')).toHaveLength(1)
        expect(eventsOf(s, 'toolPark')).toHaveLength(1)
      }
      // in open ground the boundary holds the seat exactly, with or without a bubble
      const blocked = onCart(P.WORK_AREA_MIN_X + 1, 1.5, WEST)
      addBubble(blocked, 'L', 0, 0, 'docked', 0)
      run(blocked, -1, 0, 1, dt, { each: () => expect(blocked.player.x).toBeGreaterThanOrEqual(P.WORK_AREA_MIN_X) })
      expect(blocked.player.x).toBe(P.WORK_AREA_MIN_X)
      expect(blocked.player.mode).toBe('cart')
      expect(speedOf(blocked)).toBe(0)
      const turning = onCart(P.WORK_AREA_MIN_X, 1.5, WEST)
      run(turning, -0.15, -1, 0.25, dt, { each: () => expect(turning.player.x).toBe(P.WORK_AREA_MIN_X) }) // barely west: not a wish to get off
      expect(turning.player.mode).toBe('cart')
      expect(Math.abs(angleDelta(turning.player.heading, WEST))).toBeGreaterThan(0.4)
    }
  }, 30000)

  test('an obstacle may squeeze the cart across the boundary, but the wagon never ends up inside one and is never stuck', () => {
    const rng = makeRng(77)
    let west: number = P.WORK_AREA_MIN_X
    let slowest = 0
    for (let n = 0; n < 24; n++) {
      const dt = DTS[n % 2]!
      const startZ = n % 3 === 0 ? 1.6 : -7.6 // south or north of the grinder, at the boundary
      const withBubble = n % 4 < 2
      const s = onCart(P.WORK_AREA_MIN_X + 0.4, startZ, WEST)
      const tool = s.tools[0]!
      if (withBubble) addBubble(s, 'L', 0, 0, 'docked', 0)
      expect(bodyPen(s)).toBe(0)
      let mx = 0
      let mz = startZ < 0 ? 1 : -1 // toward the grinder, along the boundary
      for (let i = 0; i < 8 / dt; i++) {
        if (i % Math.round(0.7 / dt) === Math.round(0.35 / dt)) {
          // never west without a bubble (that would leave the cart)
          const a = (rand(rng) - 0.5) * Math.PI * (withBubble ? 2 : 1)
          mx = Math.cos(a)
          mz = Math.sin(a)
          if (rand(rng) < 0.4) {
            mx = 0
            mz = startZ < 0 ? 1 : -1
          }
        }
        if (s.player.x > P.WORK_AREA_MIN_X + 1.2) {
          mx = withBubble ? -1 : 0
          mz = s.player.z < -2.85 ? 1 : -1
        }
        stepPlayer(s, { mx, mz }, dt)
        if (s.player.mode !== 'cart') throw new Error(`thrown off at ${s.player.x}, ${s.player.z} with input ${mx}, ${mz} (run ${n})`)
        const pen = bodyPen(s)
        if (!(pen <= 1e-3)) throw new Error(`wagon inside a collider by ${pen} at ${s.player.x}, ${s.player.z} (run ${n}, step ${i})`)
        expect(tool.x).toBe(s.player.x)
        west = Math.min(west, s.player.x)
      }
      const took = driveHome(s, dt, 25, () => {
        const pen = bodyPen(s)
        if (!(pen <= 1e-3)) throw new Error(`wagon inside a collider by ${pen} on the way home (run ${n})`)
        west = Math.min(west, s.player.x)
      })
      if (took < 0) throw new Error(`run ${n}: not back in the river from ${s.player.x}, ${s.player.z} (${s.player.mode})`)
      slowest = Math.max(slowest, took)
    }
    expect(slowest).toBeLessThan(15)
    // squeezed past the grinder it reaches at most the tray's west face: body 1.3 m off it, the seat 1.5 m further
    expect(west).toBeLessThan(P.WORK_AREA_MIN_X - 0.5)
    expect(west).toBeGreaterThan(L.GRINDER[0] - P.CART_BODY_RADIUS - P.CART_BODY_OFFSET - 0.01)
  }, 30000)
})

// ---------------------------------------------------------------------------------------------------------------------

describe('review: frame-rate independence of the doctor', () => {
  test('a scoop or cart sliding along an obstacle makes the same headway at 60 and 144 Hz', () => {
    // against the east face of the grinder, `deg` off the head-on direction
    for (const deg of [5, 10, 15, 18, 22, 30, 40]) {
      const a = (deg * Math.PI) / 180
      const scoop = DTS.map(dt => {
        const s = withScoop(11.25, -4.8, WEST + a)
        run(s, -Math.cos(a), Math.sin(a), 1, dt)
        expect(s.player.x).toBeCloseTo(L.GRINDER[2] + P.PLAYER_RADIUS, 2)
        return { z: s.player.z + 4.8, v: speedOf(s) }
      })
      expect(Math.abs(scoop[0]!.v - scoop[1]!.v)).toBeLessThan(0.05)
      expect(Math.abs(scoop[0]!.z - scoop[1]!.z)).toBeLessThan(0.15)

      const cart = DTS.map(dt => {
        const s = quiet()
        const m: Mover = { x: 12.15 + 1.5 * Math.cos(a), z: -4.8 - 1.5 * Math.sin(a), vx: 0, vz: 0, heading: WEST + a }
        const z0 = m.z
        for (let i = 0; i < 1.2 / dt; i++) stepCartMover(s, m, -Math.cos(a), Math.sin(a), dt)
        return { z: m.z - z0, v: Math.hypot(m.vx, m.vz) }
      })
      expect(Math.abs(cart[0]!.v - cart[1]!.v)).toBeLessThan(0.05)
      expect(Math.abs(cart[0]!.z - cart[1]!.z)).toBeLessThan(0.15)
    }
  }, 30000)

  test('the slide speed rises steadily with the contact angle and a head-on contact stops', () => {
    let last = -1
    for (const deg of [0, 4, 8, 12, 16, 20, 24]) {
      const a = (deg * Math.PI) / 180
      const s = withScoop(11.25, -4.8, WEST + a)
      run(s, -Math.cos(a), Math.sin(a), 1, 1 / 60)
      const v = speedOf(s)
      expect(v).toBeGreaterThanOrEqual(last)
      last = v
    }
    expect(last).toBeCloseTo(P.PLAYER_SPEED, 1)
    const s = withScoop(11.25, -3, WEST)
    run(s, -1, 0, 1, 1 / 60)
    expect(speedOf(s)).toBeLessThan(0.01)
    expect(s.player.stillT).toBeGreaterThan(0.5)
  }, 30000)

  test('with a docked bubble he slides along the work-area boundary alike at both rates', () => {
    for (const [mx, mz] of [[-1, 0.2], [-1, 0.6], [-1, 1]] as const) {
      const ends = DTS.map(dt => {
        const s = withScoop(9.5, -9.5, WEST)
        addBubble(s, 'M', 7.2, -9.5, 'docked', 0)
        run(s, mx, mz, 0.6, dt, { river: true })
        expect(s.player.mode).toBe('scoop')
        expect(s.player.x).toBeCloseTo(P.WORK_AREA_MIN_X, 6)
        return s.player
      })
      expect(Math.abs(ends[0]!.z - ends[1]!.z)).toBeLessThan(0.12)
      expect(ends[0]!.z).toBeGreaterThan(-9.5 + 0.3)
    }
  }, 30000)

  test('mount, dismount and emoji timings do not depend on the step', () => {
    for (const dt of DTS) {
      const s = onFoot(18.5, -11.6)
      const tool = s.tools[0]!
      Object.assign(tool, { kind: 'cart', exists: true, holder: 'none', armed: true, x: 18.5, z: -10, heading: 0, age: 5 })
      let t = 0
      let mountAt = -1
      let seatedAt = -1
      run(s, 0, 1, 1, dt, {
        each: () => {
          t += dt
          if (mountAt < 0 && s.player.mountT > 0) mountAt = t
          if (seatedAt < 0 && s.player.mode === 'cart') seatedAt = t
        },
      })
      expect(seatedAt - mountAt).toBeGreaterThan(P.CART_MOUNT_TIME - 0.02)
      expect(seatedAt - mountAt).toBeLessThan(P.CART_MOUNT_TIME + 0.02)

      addBubble(s, 'L', 0, 0, 'docked', 0)
      onBubbleDelivered(s, 0)
      expect(s.player.dismountPending).toBe(true)
      // no input: he stays seated, however long, and the cart comes to rest
      run(s, 0, 0, 1, dt)
      expect(s.player.mode).toBe('cart')
      expect(speedOf(s)).toBe(0)
      const parkedAt = { x: tool.x, z: tool.z }
      t = 0
      let offAt = -1
      let downAt = -1
      run(s, -1, 0, 0.5, dt, {
        each: () => {
          t += dt
          if (offAt < 0 && s.player.dismountT > 0) offAt = t
          if (offAt >= 0 && downAt < 0 && s.player.dismountT === 0) downAt = t
        },
      })
      expect(offAt).toBeLessThanOrEqual(dt + 1e-9) // the first movement input
      expect(downAt - offAt).toBeGreaterThan(P.CART_DISMOUNT_TIME - 0.02)
      expect(downAt - offAt).toBeLessThan(P.CART_DISMOUNT_TIME + 0.02)
      expect([tool.x, tool.z]).toEqual([parkedAt.x, parkedAt.z])
      expect(s.player.x).toBeLessThan(tool.x - 1) // he hopped off to the side he steered toward
      expect(staticPenetration(s, s.player.x, s.player.z, P.PLAYER_RADIUS)).toBe(0)
    }
  }, 30000)
})

// ---------------------------------------------------------------------------------------------------------------------

describe('review: the PUSHED shove is bounded (SPEC 2.1: 0.8 s, 1-3.5 m)', () => {
  for (const dt of DTS) {
    test(`a doctor who just stands there is carried a few metres, then the bubble goes on without him (${hz(dt)})`, () => {
      for (const off of [-0.8, 0, 0.6]) {
        const s = withScoop(18.5 + off, -9, NORTH)
        const b = addBubble(s, 'L', 18.5, -9 - P.SCOOP_OFFSET - 1.8 - 2.5)
        const z0 = s.player.z
        let t = 0
        let rejectAt = -1
        let pushedFor = 0
        let fellAt = -1
        run(s, 0, 0, 6, dt, {
          river: true,
          each: () => {
            t += dt
            if (rejectAt < 0 && eventsOf(s, 'bubbleReject').length > 0) rejectAt = t
            if (s.player.pushedT > 0) pushedFor += dt
            if (fellAt < 0 && eventsOf(s, 'bubbleFall').length > 0) fellAt = t
          },
        })
        expect(rejectAt).toBeGreaterThan(0.2)
        const rejects = eventsOf(s, 'bubbleReject')
        expect(rejects).toHaveLength(1)
        // the event is at the bubble, which was then upstream of the doctor's start and touching his blade
        expect(rejects[0]!.id).toBe(b.id)
        expect(rejects[0]!.z).toBeLessThan(z0 - 1.5)
        expect(Math.hypot(rejects[0]!.x - 18.5 - off, rejects[0]!.z - z0)).toBeLessThan(P.SCOOP_OFFSET + P.SCOOP_SAGITTA + b.r + 0.8)
        const fall = eventsOf(s, 'bubbleFall')
        expect(fall).toHaveLength(1)
        expect(fall[0]).toMatchObject({ id: b.id, r: b.r })
        expect(fall[0]!.z).toBeGreaterThanOrEqual(L.CLIFF_Z)
        expect(fall[0]!.z).toBeLessThan(L.CLIFF_Z + 0.2)
        expect(Math.abs(fall[0]!.x - 18.5)).toBeLessThan(2.2)
        expect(eventsOf(s, 'emoji')).toEqual([{ type: 'emoji', kind: 'scared', who: 'player' }])
        expect(pushedFor).toBeGreaterThan(P.PUSHED_DURATION - 0.03)
        expect(pushedFor).toBeLessThan(P.PUSHED_DURATION + 0.03)
        // carried downstream, but nowhere near the fall 13 m away
        const carried = s.player.z - z0
        expect(carried).toBeGreaterThan(1)
        expect(carried).toBeLessThan(4)
        expect(Math.abs(s.player.x - 18.5 - off)).toBeLessThan(1.5)
        // the bubble kept going at its own pace and went over the cliff
        expect(b.state).toBe('gone')
        expect(fellAt).toBeGreaterThan(rejectAt + 2)
        expect(fellAt).toBeLessThan(rejectAt + 4.2)
        // the episode is over: nothing is left of the shove
        expect(s.player.pushedT).toBe(0)
        expect([s.player.pushVx, s.player.pushVz]).toEqual([0, 0])
        expect(s.player.mode).toBe('scoop')
        expect(s.tools[0]!.bubble).toBe(-1)
        expect(s.stats.bubblesCaught).toBe(0)
      }
    }, 30000)
  }

  test('pushing against the bubble does not drag him along either, and the next oversize bubble shoves him afresh', () => {
    const s = withScoop(18.5, -9, NORTH)
    addBubble(s, 'L', 18.5, -14.5)
    const z0 = s.player.z
    let far = 0
    run(s, 0, -1, 3.5, 1 / 60, { river: true, each: () => (far = Math.max(far, s.player.z - z0)) })
    expect(eventsOf(s, 'bubbleReject')).toHaveLength(1)
    expect(far).toBeGreaterThan(1)
    expect(far).toBeLessThan(4)
    expect(s.player.z).toBeLessThan(z0 + far - 1) // he walked back upstream through it
    // a second one, later
    run(s, 0, 0, 1, 1 / 60, { river: true })
    Object.assign(s.player, { x: 18.5, z: -4, heading: NORTH, vx: 0, vz: 0 })
    const b2 = addBubble(s, 'L', 18.5, -9.5)
    run(s, 0, 0, 1.5, 1 / 60, { river: true })
    const rejects = eventsOf(s, 'bubbleReject')
    expect(rejects).toHaveLength(2)
    expect(rejects[1]!.id).toBe(b2.id)
    expect(eventsOf(s, 'emoji')).toHaveLength(2)
  }, 30000)

  test('while the spent bubble rolls over him he can still catch a bubble that fits', () => {
    const s = withScoop(18.5, -9, NORTH)
    addBubble(s, 'L', 18.5, -14.5)
    // a small one right behind the big one, in the same lane
    const m = addBubble(s, 'S', 18.5, -18.5)
    run(s, 0, 0, 4, 1 / 60, { river: true })
    expect(eventsOf(s, 'bubbleReject')).toHaveLength(1)
    expect(s.tools[0]!.bubble).toBe(m.id)
    expect(m.state).toBe('docked')
    const seat = dockSeat(s.tools[0]!, m.r)
    expect(Math.hypot(m.x - seat.x, m.z - seat.z)).toBeLessThan(1e-9)
  }, 30000)

  test('steering out of the way ends the contact early (input still steers)', () => {
    const s = withScoop(18.5, -9, NORTH)
    addBubble(s, 'L', 18.5, -14.5)
    const z0 = s.player.z
    let rejected = false
    run(s, 0, 0, 3, 1 / 144, {
      river: true,
      each: () => {
        if (!rejected && s.player.pushedT > 0) rejected = true
      },
    })
    const passive = s.player.z - z0
    const s2 = withScoop(18.5, -9, NORTH)
    addBubble(s2, 'L', 18.5, -14.5)
    for (let i = 0; i < 3 * 144; i++) {
      stepPlayer(s2, s2.player.pushedT > 0 || s2.player.x < 18 ? { mx: -1, mz: 0 } : { mx: 0, mz: 0 }, 1 / 144)
      stepRiver(s2, 1 / 144)
    }
    expect(rejected).toBe(true)
    expect(s2.player.x).toBeLessThan(15.5)
    expect(s2.player.z - z0).toBeLessThan(passive)
  }, 30000)
})

// ---------------------------------------------------------------------------------------------------------------------

describe('review: bubbles', () => {
  for (const dt of DTS) {
    test(`capture burst: 15-25 balls, apex 0.8-1.3 m, down again within a third of a second (${hz(dt)})`, () => {
      for (const seed of [1, 2, 3]) {
        const s = withScoop(18.5, -4, NORTH, seed)
        const b = addBubble(s, 'M', 18.5, -4 - P.SCOOP_OFFSET - 1.3 - 2.5)
        const apex = new Float32Array(s.balls.n)
        let t = 0
        let first = -1
        let last = -1
        let dockAt = -1
        let seatedAt = -1
        run(s, 0, 0, 1.6, dt, {
          river: true,
          each: () => {
            t += dt
            if (dockAt < 0 && b.state === 'docking') dockAt = t
            if (seatedAt < 0 && b.state === 'docked') seatedAt = t
            let any = false
            for (let i = 0; i < s.balls.n; i++) {
              if (s.balls.state[i] === BALL_FALL || !(s.balls.y[i]! > 0)) continue
              any = true
              if (s.balls.state[i] !== BALL_LOOSE) throw new Error('an airborne ball must be loose')
              apex[i] = Math.max(apex[i]!, s.balls.y[i]!)
            }
            if (any && first < 0) first = t
            if (any) last = t
          },
        })
        let n = 0
        let lo = Infinity
        let hi = 0
        for (let i = 0; i < s.balls.n; i++) {
          if (apex[i] === 0) continue
          n++
          lo = Math.min(lo, apex[i]!)
          hi = Math.max(hi, apex[i]!)
        }
        expect(n).toBeGreaterThanOrEqual(15)
        expect(n).toBeLessThanOrEqual(25)
        expect(lo).toBeGreaterThan(0.78)
        expect(hi).toBeLessThan(1.32)
        expect(last - first).toBeLessThan(0.34)
        expect(first).toBeCloseTo(dockAt, 1)
        expect(seatedAt - dockAt).toBeGreaterThan(P.DOCK_SNAP_TIME - 0.02)
        expect(seatedAt - dockAt).toBeLessThan(P.DOCK_SNAP_TIME + 0.02)
        const docks = eventsOf(s, 'bubbleDock')
        expect(docks).toHaveLength(1)
        // the event carries where the bubble was at the moment of contact: just off the blade, upstream of the doctor
        expect(docks[0]).toMatchObject({ id: b.id, tool: 0, r: b.r, byPlayer: true })
        expect(docks[0]!.z).toBeLessThan(s.player.z - P.SCOOP_OFFSET - b.r * P.DOCK_SEAT + 0.01)
        expect(Math.hypot(docks[0]!.x - s.player.x, docks[0]!.z - s.player.z)).toBeLessThan(P.SCOOP_OFFSET + P.SCOOP_SAGITTA + b.r + 0.6)
        expect(s.stats.bubblesCaught).toBe(1)
        expect(countState(s, BALL_FLOW) + countState(s, BALL_LOOSE) + countState(s, BALL_STRAY) + countState(s, BALL_FALL)).toBe(P.BALL_COUNT)
      }
    }, 30000)
  }

  test('a docked bubble stays exactly in the socket while other bubbles shove the doctor about', () => {
    for (const dt of DTS) {
      const s = withScoop(18.5, -3, NORTH, 6)
      const tool = s.tools[0]!
      const held = addBubble(s, 'M', 18.5, -3 - P.SCOOP_OFFSET - P.DOCK_SEAT * 1.3, 'docked', 0)
      s.bubbleSpawnT = 0 // the river keeps sending them
      const rng = makeRng(8)
      let mx = 0
      let mz = 0
      let worst = 0
      let shoved = 0
      for (let i = 0; i < 25 / dt; i++) {
        if (i % Math.round(0.5 / dt) === 0) {
          const a = rand(rng) * Math.PI * 2
          const m = rand(rng) < 0.5 ? 0 : 1
          mx = Math.cos(a) * m
          mz = Math.sin(a) * m
        }
        if (s.player.x < 16.5 || s.player.x > 20.5 || s.player.z < -12 || s.player.z > 1) {
          mx = 18.5 - s.player.x
          mz = -5 - s.player.z
        }
        stepPlayer(s, { mx, mz }, dt)
        const px = s.player.x
        const pz = s.player.z
        stepRiver(s, dt)
        if (s.player.x !== px || s.player.z !== pz) shoved++
        expect(held.state).toBe('docked')
        expect(tool.x).toBe(s.player.x)
        expect(tool.z).toBe(s.player.z)
        const seat = dockSeat(tool, held.r)
        worst = Math.max(worst, Math.hypot(held.x - seat.x, held.z - seat.z))
      }
      expect(shoved).toBeGreaterThan(10) // the scenario really does shove him
      expect(worst).toBeLessThan(1e-9)
      expect(tool.bubble).toBe(held.id)
      expect(s.stats.bubblesCaught).toBe(0)
    }
  }, 30000)

  test('spawn timing, size mix and the cap on live bubbles', () => {
    for (const dt of DTS) {
      const s = createState(4)
      Object.assign(s.player, { x: 11, z: -8 })
      Object.assign(s.tools[0]!, { x: 11, z: -8 })
      const sizes: Record<BubbleSize, number> = { S: 0, M: 0, L: 0 }
      let t = 0
      let last = -1
      let minGap = Infinity
      let maxGap = 0
      let sum = 0
      let gaps = 0
      let closest = Infinity
      for (let i = 0; i < (dt === DTS[0] ? 160 : 60) / dt; i++) {
        stepRiver(s, dt)
        t += dt
        for (const e of s.events) {
          if (e.type !== 'bubbleSpawn') continue
          sizes[e.size]++
          if (last >= 0) {
            minGap = Math.min(minGap, t - last)
            maxGap = Math.max(maxGap, t - last)
            sum += t - last
            gaps++
          }
          last = t
          // it never appears inside another bubble
          const nb = s.bubbles.find(b => b.id === e.id)!
          expect(nb.r).toBe(P.BUBBLE_DIAMETER[e.size] / 2)
          for (const o of s.bubbles) if (o !== nb) closest = Math.min(closest, Math.hypot(o.x - nb.x, o.z - nb.z) - o.r - nb.r)
        }
        s.events.length = 0
        expect(s.bubbles.length).toBeLessThanOrEqual(P.BUBBLE_MAX_ALIVE)
        if (i % 30 === 0) for (const a of s.bubbles) for (const c of s.bubbles) if (a.id < c.id) expect(Math.hypot(a.x - c.x, a.z - c.z)).toBeGreaterThan(a.r + c.r - 0.05)
      }
      const total = sizes.S + sizes.M + sizes.L
      // SPEC 2.3: uniform 0.4-2.9 s; two rigid spheres in one lane cannot be closer than 0.44-0.8 s
      expect(minGap).toBeGreaterThanOrEqual(P.BUBBLE_SPAWN_MIN - 1e-6)
      expect(minGap).toBeLessThan(0.85)
      expect(maxGap).toBeLessThan(P.BUBBLE_SPAWN_MAX + 1.5)
      expect(sum / gaps).toBeGreaterThan(1.45)
      expect(sum / gaps).toBeLessThan(1.85)
      expect(closest).toBeGreaterThanOrEqual(0)
      expect(total).toBeGreaterThan(dt === DTS[0] ? 85 : 30)
      for (const k of ['S', 'M', 'L'] as const) expect(Math.abs(sizes[k] / total - P.BUBBLE_MIX[k])).toBeLessThan(dt === DTS[0] ? 0.13 : 0.22)
    }
  }, 120000)

  /**
   * Let the bubble drift into the straight reach below the bend (there its lane keeps a constant x), then put the
   * doctor and his tool further down that lane, `off` metres to the side, facing upstream.
   */
  function meetAt(s: GameState, b: Bubble, off: number, dt: number) {
    while (b.z < -5.5) stepRiver(s, dt)
    const z = s.player.mode === 'cart' ? 2.5 : 0
    Object.assign(s.player, { x: b.x + off, z })
    Object.assign(s.tools[0]!, { x: b.x + off, z })
    s.events.length = 0
  }

  test('capture tolerance: head-on within chord/2 - 0.2 docks, beyond it does not; sizes follow the tool limits', () => {
    for (const dt of DTS) {
      // (offset of the bubble's lane from the blade axis, expected to dock)
      for (const [off, docks] of [[0, true], [0.9, true], [-0.9, true], [1.6, false], [-1.6, false]] as const) {
        const s = withScoop(11, -9, NORTH)
        const b = addBubble(s, 'M', 18.5, -10)
        meetAt(s, b, off, dt)
        run(s, 0, 0, 2, dt, { river: true })
        expect(eventsOf(s, 'bubbleDock').length).toBe(docks ? 1 : 0)
        expect(s.tools[0]!.bubble).toBe(docks ? b.id : -1)
        expect(eventsOf(s, 'bubbleReject')).toHaveLength(0) // an M fits: never a scare
      }
      for (const size of ['S', 'M', 'L'] as const) {
        const s = withScoop(11, -9, NORTH)
        const b = addBubble(s, size, 18.5, -10)
        meetAt(s, b, 0, dt)
        run(s, 0, 0, 2, dt, { river: true })
        const fits = P.BUBBLE_DIAMETER[size] <= P.SCOOP_MAX_BUBBLE
        expect(eventsOf(s, 'bubbleDock').length).toBe(fits ? 1 : 0)
        expect(eventsOf(s, 'bubbleReject').length).toBe(fits ? 0 : 1)

        const c = onCart(11, -9, NORTH)
        const cb = addBubble(c, size, 18.5, -10)
        meetAt(c, cb, 0, dt)
        run(c, 0, 0, 2.5, dt, { river: true })
        expect(eventsOf(c, 'bubbleDock')).toHaveLength(1)
        expect(eventsOf(c, 'bubbleReject')).toHaveLength(0)
        expect(eventsOf(c, 'emoji')).toEqual([{ type: 'emoji', kind: 'happy', who: 'player' }])
        expect(cb.state).toBe('docked')
      }
    }
  }, 30000)

  test("unlock 'cart' with a bubble in the scoop: the bubble moves to the cart's socket and can still be delivered", () => {
    const s = withScoop(18, -3, WEST) // far enough for the cart's longer reach not to put the bubble on the tray at once
    const b = addBubble(s, 'M', 18 - P.SCOOP_OFFSET - P.DOCK_SEAT * 1.3, -3, 'docked', 0)
    run(s, 0, 0, 0.1, 1 / 60, { river: true })
    s.unlocks.cart = true
    s.events.length = 0
    run(s, 0, 0, 0.5, 1 / 60, { river: true })
    const tool = s.tools[0]!
    expect(tool.kind).toBe('cart')
    expect(tool.bubble).toBe(b.id)
    expect(b.tool).toBe(0)
    expect(b.state).toBe('docked')
    const seat = dockSeat(tool, b.r)
    expect(Math.hypot(b.x - seat.x, b.z - seat.z)).toBeLessThan(1e-9)
    expect(eventsOf(s, 'toolSwap')).toHaveLength(1)
    expect(s.player.mode).toBe('foot')
    // the cart re-arms once he has been away; he gets on and pushes it to the grinder
    for (let i = 0; i < 60 * 12 && !fakeGrinder(s); i++) {
      const p = s.player
      let tx = tool.x + 0.6
      let tz = tool.z
      if (p.mode === 'cart') {
        tx = p.x - 5
        tz = -3
      } else if (!tool.armed) {
        tx = tool.x + 4
        tz = tool.z + 1
      }
      const d = Math.hypot(tx - p.x, tz - p.z) || 1
      stepPlayer(s, { mx: (tx - p.x) / d, mz: (tz - p.z) / d }, 1 / 60)
      stepRiver(s, 1 / 60)
    }
    expect(tool.bubble).toBe(-1)
    expect(s.player.dismountPending).toBe(true)
    expect(s.bubbles).toHaveLength(0)
  }, 30000)
})

// ---------------------------------------------------------------------------------------------------------------------

describe('review: small balls', () => {
  test('balls left leaning on a parked tool or a standing doctor settle as strays instead of staying loose', () => {
    for (const dt of DTS) {
      for (const kind of ['scoop', 'cart'] as const) {
        const s = kind === 'scoop' ? withScoop(19, -3, WEST) : onCart(19, -3, WEST)
        run(s, -1, 0, kind === 'cart' ? 1.3 : 0.9, dt, { river: true }) // sweep out onto the west bank
        run(s, 0, 0, 0.3, dt, { river: true })
        parkTool(s, 0)
        expect(countState(s, BALL_LOOSE)).toBeGreaterThan(10)
        run(s, 0, -1, 1, dt, { river: true }) // he walks off
        run(s, 0, 0, 5, dt, { river: true })
        // what is still loose is on its way back into the bed (within the return zone), not resting on the bank
        const b = s.balls
        for (let i = 0; i < b.n; i++) {
          if (b.state[i] !== BALL_LOOSE) continue
          const r = riverSample(b.x[i]!, b.z[i]!)
          expect(Math.abs(r.d) - r.halfW).toBeLessThan(0.75)
        }
        expect(countState(s, BALL_STRAY)).toBeGreaterThan(L.STRAY_SEED.n + 5)
        expect(countState(s, BALL_STRAY)).toBeLessThanOrEqual(P.MAX_STRAYS)
        // ... and STRAY_LIFETIME later they have gone back to the river
        run(s, 0, 0, P.STRAY_LIFETIME + 1, dt === 1 / 60 ? dt : 1 / 60, { river: true })
        expect(countState(s, BALL_STRAY)).toBeLessThanOrEqual(L.STRAY_SEED.n)
      }
    }
  }, 60000)

  for (const dt of DTS) {
    test(`a blade sweep leaves a bare lane that refills in 0.3-1.1 s, scoop and cart (${hz(dt)})`, () => {
      for (const kind of ['scoop', 'cart'] as const) {
        const s = kind === 'scoop' ? withScoop(13.5, -3, EAST, 4) : onCart(10.5, -3, EAST, 4)
        for (let i = 0; i < 1 / dt; i++) stepRiver(s, dt)
        const b = s.balls
        const inBox = (x0: number, x1: number, z0: number, z1: number) => {
          let n = 0
          for (let i = 0; i < b.n; i++) if (b.y[i] === 0 && b.state[i] !== BALL_FALL && b.x[i]! >= x0 && b.x[i]! <= x1 && b.z[i]! >= z0 && b.z[i]! <= z1) n++
          return n
        }
        const lane: [number, number, number, number] = [16.5, 18.0, -2.6, -1.6]
        const before = inBox(...lane)
        expect(before).toBeGreaterThan(9)
        let t = 0
        let clearedAt = -1
        let refilledAt = -1
        let least = before
        const watch = () => {
          t += dt
          const n = inBox(...lane)
          least = Math.min(least, n)
          if (clearedAt < 0 && n <= before * 0.15) clearedAt = t
          else if (clearedAt >= 0 && refilledAt < 0 && n >= before * 0.7) refilledAt = t
        }
        run(s, 1, 0, kind === 'scoop' ? 1.0 : 2.2, dt, { river: true, each: watch })
        run(s, 0, 0, 1.5, dt, { river: true, each: watch })
        expect(least).toBe(0)
        expect(clearedAt).toBeGreaterThan(0)
        expect(refilledAt - clearedAt).toBeGreaterThan(0.3)
        expect(refilledAt - clearedAt).toBeLessThan(1.15)
        assertBalls(s, 'after the sweep')
      }
    }, 30000)
  }

  test('the river holds its density at 144 Hz too, and strays never exceed the cap', () => {
    const dt = 1 / 144
    const s = createState(12)
    Object.assign(s.player, { x: 11, z: -8 })
    Object.assign(s.tools[0]!, { x: 11, z: -8 })
    for (let i = 0; i < 80 / dt; i++) {
      stepRiver(s, dt)
      s.events.length = 0
      if (i % 1440 === 0) assertBalls(s, `at step ${i}`)
    }
    assertBalls(s, 'at the end')
    const b = s.balls
    const BIN = 3
    const bins = new Array<number>(Math.ceil(RIVER_LENGTH / BIN)).fill(0)
    for (let i = 0; i < b.n; i++) {
      if (b.state[i] !== BALL_FLOW) continue
      const r = riverSample(b.x[i]!, b.z[i]!)
      expect(Math.abs(r.d)).toBeLessThan(r.halfW + 0.6)
      if (r.s >= 0 && r.s < RIVER_LENGTH) bins[Math.floor(r.s / BIN)]!++
    }
    for (let k = 0; k < bins.length - 1; k++) expect(bins[k]!).toBeGreaterThan(6 * 6.4 * BIN)
    expect(countState(s, BALL_FLOW)).toBeGreaterThan(P.BALL_COUNT * 0.9)
    expect(countState(s, BALL_FALL)).toBeGreaterThan(20)
    expect(countState(s, BALL_STRAY)).toBe(L.STRAY_SEED.n)
    expect(countState(s, BALL_LOOSE)).toBe(0)
  }, 60000)

  test('falling balls drop below the lip and come back at the source', () => {
    const s = quiet(2)
    const b = s.balls
    const seen = new Uint8Array(b.n)
    let lowest = 0
    let recycled = 0
    for (let step = 0; step < 240; step++) {
      stepRiver(s, 1 / 60)
      for (let i = 0; i < b.n; i++) {
        if (b.state[i] === BALL_FALL) {
          seen[i] = 1
          expect(b.y[i]!).toBeLessThanOrEqual(0)
          lowest = Math.min(lowest, b.y[i]!)
        } else if (seen[i] === 1) {
          // back in the flow, far upstream, on the ground
          seen[i] = 0
          recycled++
          expect(b.state[i]).toBe(BALL_FLOW)
          expect(b.y[i]).toBe(0)
          expect(b.z[i]!).toBeLessThan(-24)
        }
      }
    }
    expect(recycled).toBeGreaterThan(200)
    expect(lowest).toBeLessThan(-L.FALL_DROP)
    expect(lowest).toBeGreaterThan(-L.FALL_DROP - 1.2)
  }, 30000)
})

// ---------------------------------------------------------------------------------------------------------------------

describe('review: long random runs', () => {
  /** Random stick with a bias toward the river and the grinder. */
  function stick(rng: Rng, s: GameState, cur: { mx: number; mz: number }) {
    const a = rand(rng) * Math.PI * 2
    const m = rand(rng) < 0.1 ? 0 : 1
    cur.mx = Math.cos(a) * m
    cur.mz = Math.sin(a) * m
    if (rand(rng) < 0.5) {
      const tx = 12 + rand(rng) * 9
      const tz = -12 + rand(rng) * 14
      const d = Math.hypot(tx - s.player.x, tz - s.player.z) || 1
      cur.mx = (tx - s.player.x) / d
      cur.mz = (tz - s.player.z) / d
    }
  }

  for (const dt of DTS) {
    test(`hand scoop, bubbles, deliveries: invariants hold every step (${hz(dt)})`, () => {
      for (const seed of dt === DTS[0] ? [1, 2] : [2]) {
        const s = createState(seed)
        const rng = makeRng(seed * 77 + 5)
        const cur = { mx: 0, mz: 0 }
        let docks = 0
        let rejects = 0
        let grabs = 0
        let parks = 0 // he starts with the scoop in his hands: parks - grabs is 0 while he holds it
        let delivered = 0
        for (let i = 0; i < 40 / dt; i++) {
          if (i % Math.round(0.4 / dt) === 0) stick(rng, s, cur)
          const tool = s.tools[0]!
          if (tool.bubble !== -1 && s.player.mode === 'scoop' && rand(rng) < 0.02) {
            // now and then he remembers what the bubble is for
            cur.mx = -1
            cur.mz = (-2.85 - s.player.z) * 0.5
          }
          stepPlayer(s, cur, dt)
          stepRiver(s, dt)
          if (fakeGrinder(s)) delivered++
          const p = s.player
          assertFinite(s, `seed ${seed} step ${i}`)
          for (const e of s.events) {
            if (e.type === 'bubbleDock') docks++
            else if (e.type === 'bubbleReject') rejects++
            else if (e.type === 'toolGrab') grabs++
            else if (e.type === 'toolPark') parks++
            else if (e.type === 'cartMount' || e.type === 'cartDismount' || e.type === 'toolSwap') throw new Error(`unexpected ${e.type}`)
          }
          s.events.length = 0
          // a tool is either in his hands (same pose) or parked; grabs and parks alternate
          expect(parks - grabs).toBe(p.mode === 'scoop' ? 0 : 1)
          if (p.mode === 'scoop') {
            if (tool.x !== p.x || tool.z !== p.z || tool.heading !== p.heading || tool.holder !== 'player' || p.tool !== 0) throw new Error('held tool out of his hands')
            if (p.x < P.WORK_AREA_MIN_X - 0.11) throw new Error(`scoop carried to x = ${p.x}`)
          } else {
            expect(p.mode).toBe('foot')
            expect(p.tool).toBe(-1)
            expect(tool.holder).toBe('none')
            expect(tool.x).toBeGreaterThanOrEqual(P.WORK_AREA_MIN_X - 0.11)
          }
          const pen = staticPenetration(s, p.x, p.z, P.PLAYER_RADIUS)
          if (!(pen <= 1e-3)) throw new Error(`doctor inside a collider by ${pen} at ${p.x}, ${p.z} (seed ${seed}, step ${i})`)
          expect(s.bubbles.length).toBeLessThanOrEqual(P.BUBBLE_MAX_ALIVE)
          for (const b of s.bubbles) {
            if (b.state === 'docked') {
              const seat = dockSeat(s.tools[b.tool]!, b.r)
              if (Math.hypot(b.x - seat.x, b.z - seat.z) > 1e-9) throw new Error('docked bubble off its seat')
              expect(s.tools[b.tool]!.bubble).toBe(b.id)
            } else if (b.state === 'drift') {
              expect(b.tool).toBe(-1)
            }
          }
          if (tool.bubble !== -1) expect(s.bubbles.some(b => b.id === tool.bubble && (b.state === 'docked' || b.state === 'docking'))).toBe(true)
          expect(p.pushedT).toBeGreaterThanOrEqual(0)
          expect(p.pushedT).toBeLessThanOrEqual(P.PUSHED_DURATION)
          if (i % 97 === 0) assertBalls(s, `seed ${seed} step ${i}`)
        }
        assertBalls(s, `seed ${seed} at the end`)
        expect(s.stats.bubblesCaught).toBe(docks)
        expect(delivered).toBeLessThanOrEqual(docks)
        expect(docks + rejects).toBeGreaterThan(0)
      }
    }, 60000)

    test(`cart: mount, drive, capture, deliver, hop off, again and again (${hz(dt)})`, () => {
      for (const seed of dt === DTS[0] ? [3, 4] : [3]) {
        const s = createState(seed)
        s.unlocks.cart = true
        const rng = makeRng(seed * 131 + 9)
        const tool = s.tools[0]!
        const cur = { mx: 0, mz: 0 }
        let mounts = 0
        let dismounts = 0
        let swaps = 0
        let docks = 0
        let happy = 0
        let delivered = 0
        let foot = 0
        let longestFoot = 0
        for (let i = 0; i < 60 / dt; i++) {
          const p = s.player
          if (p.mode === 'cart') {
            foot = 0
            if (i % Math.round(0.6 / dt) === 0) {
              stick(rng, s, cur)
              if (rand(rng) < 0.12) {
                cur.mx = -1 // toward the boundary
                cur.mz = rand(rng) - 0.5
              }
              if (tool.bubble !== -1 && rand(rng) < 0.7) {
                // take it to the grinder
                if (p.x < 17.5 && Math.abs(p.z + 2.8) < 2.5) {
                  cur.mx = -1
                  cur.mz = 0
                } else {
                  const d = Math.hypot(15 - p.x, -2.8 - p.z) || 1
                  cur.mx = (15 - p.x) / d
                  cur.mz = (-2.8 - p.z) / d
                }
              }
            }
          } else {
            foot += dt
            longestFoot = Math.max(longestFoot, foot)
            if (p.mountT <= 0 && p.dismountT <= 0 && i % Math.round(0.25 / dt) === 0) {
              // unarmed: wander off until it is armed again; armed: walk to just behind the bench
              let a = rand(rng) * Math.PI * 2
              if (tool.armed) {
                a = Math.atan2(tool.z - Math.cos(tool.heading) * 0.6 - p.z, tool.x - Math.sin(tool.heading) * 0.6 - p.x)
                if (p.stillT > 0.2) a += (rand(rng) - 0.5) * 3 // something is in the way
              }
              cur.mx = Math.cos(a)
              cur.mz = Math.sin(a)
            }
          }
          stepPlayer(s, cur, dt)
          stepRiver(s, dt)
          if (fakeGrinder(s)) delivered++
          assertFinite(s, `seed ${seed} step ${i}`)
          for (const e of s.events) {
            if (e.type === 'cartMount') mounts++
            else if (e.type === 'cartDismount') dismounts++
            else if (e.type === 'toolSwap') swaps++
            else if (e.type === 'bubbleDock') docks++
            else if (e.type === 'emoji' && e.kind === 'happy') happy++
            else if (e.type === 'bubbleReject') throw new Error('the cart takes every size')
          }
          s.events.length = 0
          if (p.mode === 'cart') {
            if (tool.x !== p.x || tool.z !== p.z || tool.heading !== p.heading) throw new Error('cart not under its driver')
            const pen = bodyPen(s)
            if (!(pen <= 1e-3)) throw new Error(`wagon inside a collider by ${pen} at ${p.x}, ${p.z} (seed ${seed}, step ${i})`)
            expect(speedOf(s)).toBeLessThanOrEqual(P.CART_SPEED + 1e-9)
          } else if (p.mountT <= 0) {
            const pen = staticPenetration(s, p.x, p.z, P.PLAYER_RADIUS)
            if (!(pen <= 1e-3)) throw new Error(`doctor inside a collider by ${pen} at ${p.x}, ${p.z} (seed ${seed}, step ${i})`)
          }
          // under its own power the seat stops at the boundary; an obstacle east of the wagon (the tray, a conifer) can
          // squeeze it a wagon's length further, never more
          if (tool.x < P.WORK_AREA_MIN_X - 3.3) throw new Error(`cart at x = ${tool.x}, z = ${tool.z} (seed ${seed}, step ${i})`)
          expect(mounts - dismounts).toBe(p.mode === 'cart' || p.mountT > 0 ? 1 : 0)
          for (const b of s.bubbles) {
            if (b.state !== 'docked') continue
            const seat = dockSeat(s.tools[b.tool]!, b.r)
            if (Math.hypot(b.x - seat.x, b.z - seat.z) > 1e-9) throw new Error('docked bubble off its seat')
          }
          if (i % 97 === 0) assertBalls(s, `seed ${seed} step ${i}`)
        }
        expect(swaps).toBe(1)
        expect(mounts).toBeGreaterThan(2)
        expect(longestFoot).toBeLessThan(20) // never locked out of the cart
        expect(docks).toBeGreaterThan(0)
        expect(s.stats.bubblesCaught).toBe(docks)
        expect(happy).toBeGreaterThanOrEqual(docks - 1)
        expect(happy).toBeLessThanOrEqual(docks)
        expect(delivered).toBeLessThanOrEqual(docks)
      }
    }, 90000)
  }

  test('on foot at 144 Hz, with a parked cart in the way and a driver circling: never inside a collider, never stuck', () => {
    const dt = 1 / 144
    const s = quiet()
    s.unlocks.cart = true
    parkTool(s, 0)
    Object.assign(s.tools[0]!, { kind: 'cart', exists: true, holder: 'driver', armed: false, x: 14, z: -3, heading: WEST })
    Object.assign(s.tools[1]!, { exists: true, armed: true })
    Object.assign(s.player, { x: 11.6, z: -1.2, heading: 0, vx: 0, vz: 0, mode: 'foot', tool: -1 })
    s.events.length = 0
    const cart = s.tools[0]!
    const d: Mover = { x: 14, z: -3, vx: 0, vz: 0, heading: WEST }
    const rng = makeRng(5)
    let mx = 0
    let mz = 0
    let grabs = 0
    let parks = 0
    const visited = new Set<number>()
    for (let i = 0; i < 40 / dt; i++) {
      // the driver (helpers.ts moves him only through stepCartMover) runs the doctor down
      const dd = Math.hypot(s.player.x - d.x, s.player.z - d.z) || 1
      stepCartMover(s, d, (s.player.x - d.x) / dd, (s.player.z - d.z) / dd, dt)
      cart.x = d.x
      cart.z = d.z
      cart.heading = d.heading
      if (i % Math.round(0.5 / dt) === 0) {
        const a = rand(rng) * Math.PI * 2
        mx = Math.cos(a)
        mz = Math.sin(a)
        if (s.player.x < 9) mx = 1
      }
      stepPlayer(s, { mx, mz }, dt)
      // stepPlayer leaves the driver's cart alone
      expect([cart.x, cart.z, cart.heading, cart.holder, cart.kind]).toEqual([d.x, d.z, d.heading, 'driver', 'cart'])
      const body = cartBody(d)
      expect(staticPenetration(s, body.x, body.z, P.CART_BODY_RADIUS)).toBeLessThanOrEqual(1e-3)
      stepRiver(s, dt)
      const p = s.player
      const pen = staticPenetration(s, p.x, p.z, P.PLAYER_RADIUS)
      if (!(pen <= 1e-3)) throw new Error(`doctor inside a collider by ${pen} at ${p.x}, ${p.z} (step ${i})`)
      expect(p.mode === 'foot' || (p.mode === 'scoop' && p.tool === 1)).toBe(true)
      for (const e of s.events) {
        if (e.type === 'toolGrab') {
          grabs++
          expect(e.tool).toBe(1)
        } else if (e.type === 'toolPark') parks++
      }
      s.events.length = 0
      visited.add(Math.floor(p.x / 2) * 100 + Math.floor(p.z / 2))
    }
    expect(grabs).toBeGreaterThan(0)
    expect(Math.abs(grabs - parks)).toBeLessThanOrEqual(1)
    expect(visited.size).toBeGreaterThan(8) // he got about
    assertFinite(s, 'at the end')
  }, 60000)
})

// ---------------------------------------------------------------------------------------------------------------------

describe('review: robustness', () => {
  test('garbage input is no input', () => {
    for (const make of [() => onFoot(12, -4), () => withScoop(14, -3, EAST), () => onCart(18.5, -7, 0)]) {
      const s = make()
      const x = s.player.x
      const z = s.player.z
      for (const inp of [{ mx: NaN, mz: 0 }, { mx: 0, mz: NaN }, { mx: NaN, mz: NaN }, { mx: 0.01, mz: -0.01 }]) for (let i = 0; i < 30; i++) stepPlayer(s, inp, 1 / 60)
      expect([s.player.x, s.player.z]).toEqual([x, z])
      assertFinite(s, 'after NaN input')
      // oversized input is clamped to the cruise speed
      for (let i = 0; i < 120; i++) stepPlayer(s, { mx: 30, mz: 0 }, 1 / 60)
      expect(speedOf(s)).toBeLessThanOrEqual(P.PLAYER_SPEED + 1e-9)
      assertFinite(s, 'after huge input')
    }
  }, 30000)

  test('the same seed and steps give the same river, and two games stepped in turn do not disturb each other', () => {
    const play = (interleave: boolean) => {
      const a = createState(3)
      const other = createState(8)
      const rng = makeRng(4)
      for (let i = 0; i < 600; i++) {
        const ang = rand(rng) * Math.PI * 2
        const inp = i % 30 > 15 ? { mx: 1, mz: -0.2 } : { mx: Math.cos(ang), mz: Math.sin(ang) }
        stepPlayer(a, inp, 1 / 60)
        if (interleave) stepPlayer(other, { mx: 1, mz: 0 }, 1 / 60)
        stepRiver(a, 1 / 60)
        if (interleave) stepRiver(other, 1 / 60)
      }
      return a
    }
    const a = play(false)
    const b = play(false)
    const c = play(true)
    for (const o of [b, c]) {
      expect(Array.from(o.balls.x)).toEqual(Array.from(a.balls.x))
      expect(Array.from(o.balls.z)).toEqual(Array.from(a.balls.z))
      expect(Array.from(o.balls.state)).toEqual(Array.from(a.balls.state))
      expect([o.player.x, o.player.z, o.player.heading, o.rng.s, o.nextId]).toEqual([a.player.x, a.player.z, a.player.heading, a.rng.s, a.nextId])
      expect(o.bubbles.map(q => [q.id, q.x, q.z, q.state])).toEqual(a.bubbles.map(q => [q.id, q.x, q.z, q.state]))
    }
  }, 30000)

  test('the first seconds of the game: the pre-seeded bubbles arrive on cue and the M can be caught and pushed to the grinder', () => {
    for (const dt of DTS) {
      const s = createState(1)
      expect(s.bubbles.map(b => b.size).sort()).toEqual(['L', 'M', 'S'])
      const m = s.bubbles.find(b => b.size === 'M')!
      const big = s.bubbles.find(b => b.size === 'L')!
      // when does each pass the river entry beside the grinder (z = -3)?
      const passAt = (b: Bubble) => {
        const probe = createState(1)
        const pb = probe.bubbles.find(q => q.id === b.id)!
        Object.assign(probe.player, { x: 11, z: -8 })
        Object.assign(probe.tools[0]!, { x: 11, z: -8 })
        for (let i = 0; i < 10 / dt; i++) {
          stepRiver(probe, dt)
          if (pb.z >= -3) return (i + 1) * dt
        }
        return Infinity
      }
      expect(passAt(big)).toBeGreaterThan(0.9)
      expect(passAt(big)).toBeLessThan(2.0) // SPEC 3.5: the L bounces off at about 1.4 s
      expect(passAt(m)).toBeGreaterThan(3.2)
      expect(passAt(m)).toBeLessThan(4.6) // the M is caught at about 3.8 s

      // a simple player: wait on the bank, step into the M's lane facing upstream, then west to the grinder
      let t = 0
      let dockedAt = -1
      let deliveredAt = -1
      for (let i = 0; i < 9 / dt && deliveredAt < 0; i++) {
        t += dt
        const p = s.player
        let mx = 0
        let mz = 0
        if (s.tools[0]!.bubble === -1) {
          // on the bank until the L and the S have gone by
          const waiting = s.bubbles.some(b => b !== m && b.id <= 3 && b.state === 'drift' && b.z < p.z + 2.5)
          const tx = waiting ? 14.6 : m.x
          const d = Math.hypot(tx - p.x, -2.6 - p.z)
          if (d > 0.15) {
            mx = (tx - p.x) / d
            mz = (-2.6 - p.z) / d
          } else {
            mz = -0.06 // only turns him upstream
          }
        } else {
          if (dockedAt < 0) dockedAt = t
          mx = -1
          mz = (-2.85 - p.z) * 0.5
        }
        stepPlayer(s, { mx, mz }, dt)
        stepRiver(s, dt)
        if (fakeGrinder(s)) deliveredAt = t
      }
      expect(dockedAt).toBeGreaterThan(3)
      expect(dockedAt).toBeLessThan(5)
      expect(s.stats.bubblesCaught).toBe(1)
      expect(deliveredAt).toBeGreaterThan(dockedAt)
      expect(deliveredAt).toBeLessThan(dockedAt + 2.2) // SPEC 3.5: on the grinder by 5.3 s
      // SPEC 2.2: the scoop is parked there, the doctor still at the handle
      expect(s.player.mode).toBe('foot')
      expect(s.tools[0]!.holder).toBe('none')
      expect(Math.hypot(s.player.x - s.tools[0]!.x, s.player.z - s.tools[0]!.z)).toBeLessThan(1e-9)
      expect(BLADE_ARCS.scoop.R).toBeGreaterThan(0)
    }
  }, 30000)
})
