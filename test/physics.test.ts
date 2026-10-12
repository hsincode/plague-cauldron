// Physics package: the doctor (player.ts), the tools (tools.ts) and the river (river.ts).
// Every scenario drives stepPlayer / stepRiver directly, so nothing here depends on the other packages.
import { describe, expect, test } from 'bun:test'
import { L, P, type BubbleSize } from '../src/config'
import { angleDelta } from '../src/core/math'
import { makeRng, rand } from '../src/core/rng'
import type { GameEvent } from '../src/sim/events'
import { HAPPY_DELAY, resolveStatic, SCARED_DELAY, staticPenetration, stepCartMover, stepPlayer, type Mover } from '../src/sim/player'
import { stepRiver } from '../src/sim/river'
import { createState } from '../src/sim/state'
import { BLADE_ARCS, bladeCenter, bladeWorld, cartBody, dockSeat, onBubbleDelivered, parkTool } from '../src/sim/tools'
import { BALL_FALL, BALL_FLOW, BALL_LOOSE, BALL_STRAY, type Bubble, type GameState } from '../src/sim/types'
import { RIVER_LENGTH, riverSample } from '../src/world/river'
import { BLADES } from '../src/world/tools'

const DT = 1 / 60
const NORTH = Math.PI // heading whose forward vector is (0, -1): upstream
const EAST = Math.PI / 2
const WEST = -Math.PI / 2

/** A state with an empty, silent river (no bubbles, none spawning) unless a test adds its own. */
function quiet(seed = 1): GameState {
  const s = createState(seed)
  s.bubbles.length = 0
  s.bubbleSpawnT = 1e9
  return s
}

/** The doctor on foot at (x, z) with no tool in the world. */
function onFoot(x: number, z: number, heading = 0): GameState {
  const s = quiet()
  parkTool(s, 0)
  s.tools[0]!.exists = false
  s.events.length = 0
  Object.assign(s.player, { x, z, heading, vx: 0, vz: 0 })
  return s
}

/** The doctor holding the hand scoop at (x, z). */
function withScoop(x: number, z: number, heading: number): GameState {
  const s = quiet()
  Object.assign(s.player, { x, z, heading, vx: 0, vz: 0 })
  Object.assign(s.tools[0]!, { x, z, heading })
  return s
}

/** The doctor seated on the cart at (x, z). */
function onCart(x: number, z: number, heading: number): GameState {
  const s = quiet()
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

/** Step the doctor (and the river when asked) for `seconds`; `each` runs after every step. */
function run(s: GameState, mx: number, mz: number, seconds: number, opts: { dt?: number; river?: boolean; each?: () => void } = {}) {
  const dt = opts.dt ?? DT
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
const bodyPenetration = (s: GameState) => staticPenetration(s, s.player.x, s.player.z, P.PLAYER_RADIUS)

// ---------------------------------------------------------------------------------------------------------------------

describe('doctor: movement', () => {
  test('on foot: accelerates at 45, cruises at 7, brakes at 60 m/s2 and faces the way he goes', () => {
    const s = onFoot(11.8, -7, 0)
    const dt = 1 / 120
    run(s, 0, 1, 0.1, { dt })
    expect(speedOf(s)).toBeCloseTo(P.PLAYER_ACCEL * 0.1, 1)
    run(s, 0, 1, 0.3, { dt })
    expect(speedOf(s)).toBeCloseTo(P.PLAYER_SPEED, 5)
    expect(s.player.stillT).toBe(0)
    const odo = s.player.odo
    expect(odo).toBeGreaterThan(1.5)
    run(s, 0, 0, 0.05, { dt })
    expect(speedOf(s)).toBeCloseTo(P.PLAYER_SPEED - P.PLAYER_DECEL * 0.05, 1)
    run(s, 0, 0, 0.3, { dt })
    expect(speedOf(s)).toBe(0)
    expect(s.player.stillT).toBeGreaterThan(0.15)
    // turning: 900 deg/s is practically instant
    run(s, 1, 0, 0.25, { dt })
    expect(Math.abs(angleDelta(s.player.heading, EAST))).toBeLessThan(1e-6)
    expect(s.player.vx).toBeGreaterThan(6.9)
  })

  test('on foot: analog input scales the cruise speed', () => {
    const s = onFoot(11.8, -7, 0)
    run(s, 0, 0.5, 0.5)
    expect(speedOf(s)).toBeCloseTo(P.PLAYER_SPEED * 0.5, 5)
  })

  test('hand scoop: same cruise speed, 400 deg/s turn, velocity along the heading times max(0.25, cos)', () => {
    const s = withScoop(13.5, -3, EAST)
    const check = () => {
      const p = s.player
      const t = s.tools[0]!
      // the tool is in his hands every step
      expect(t.x).toBe(p.x)
      expect(t.z).toBe(p.z)
      expect(t.heading).toBe(p.heading)
      // velocity never leaves the heading
      expect(Math.abs(p.vx * Math.cos(p.heading) - p.vz * Math.sin(p.heading))).toBeLessThan(1e-9)
    }
    run(s, 1, 0, 0.4, { each: check })
    expect(speedOf(s)).toBeCloseTo(P.PLAYER_SPEED, 5)
    expect(s.player.mode).toBe('scoop')

    // input straight back: he keeps rolling forward at a quarter of the speed while the scoop swings round
    const h0 = s.player.heading
    run(s, -1, 0, 0.1, { each: check })
    expect(Math.abs(angleDelta(h0, s.player.heading))).toBeCloseTo(P.SCOOP_TURN_RATE * 0.1, 2)
    expect(speedOf(s)).toBeCloseTo(P.PLAYER_SPEED * 0.25, 1)
    expect(s.player.vx).toBeGreaterThan(0)
    // 180 degrees take 0.45 s; then full speed the other way
    run(s, -1, 0, 0.8, { each: check })
    expect(Math.abs(angleDelta(s.player.heading, WEST))).toBeLessThan(1e-6)
    expect(s.player.vx).toBeCloseTo(-P.PLAYER_SPEED, 5)
  })

  test('cart: 12 m/s2 up to 5 m/s, 130 deg/s turn, velocity always along the heading', () => {
    const s = onCart(18.5, -7, 0)
    const check = () => {
      const p = s.player
      expect(Math.abs(p.vx * Math.cos(p.heading) - p.vz * Math.sin(p.heading))).toBeLessThan(1e-9)
      expect(s.tools[0]!.x).toBe(p.x)
      expect(s.tools[0]!.heading).toBe(p.heading)
    }
    run(s, 0, 1, 0.25, { each: check })
    expect(speedOf(s)).toBeCloseTo(P.CART_ACCEL * 0.25, 1)
    run(s, 0, 1, 0.5, { each: check })
    expect(speedOf(s)).toBeCloseTo(P.CART_SPEED, 5)
    const h0 = s.player.heading
    run(s, -1, 0, 0.2, { each: check })
    expect(Math.abs(angleDelta(h0, s.player.heading))).toBeCloseTo(P.CART_TURN_RATE * 0.2, 2)
    expect(speedOf(s)).toBeCloseTo(P.CART_SPEED, 5)
    // half a turn takes about 1.4 s (it comes round through the west, on a 2.2 m radius)
    run(s, 0, -1, 1.6, { each: check })
    expect(Math.abs(angleDelta(s.player.heading, NORTH))).toBeLessThan(1e-6)
    run(s, 0, 0, 0.5, { each: check })
    expect(speedOf(s)).toBe(0)
  })

  test('movement does not depend on the frame rate', () => {
    const script: [number, number, number][] = [[1, 0, 0.5], [0.3, -1, 0.4], [0, 0, 0.2], [-1, 0.2, 0.5], [0.4, 0.4, 0.6]]
    const end = (make: () => GameState, dt: number) => {
      const s = make()
      for (const [mx, mz, t] of script) run(s, mx, mz, t, { dt })
      return s.player
    }
    for (const make of [() => onFoot(12.5, -4), () => withScoop(14, -3, EAST), () => onCart(18.5, -7, 0)]) {
      const a = end(make, 1 / 60)
      const b = end(make, 1 / 144)
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(0.12)
      expect(Math.abs(angleDelta(a.heading, b.heading))).toBeLessThan(0.05)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------

describe('doctor: static collisions', () => {
  test('the cauldron, a wall and the outer bounds stop him', () => {
    let s = onFoot(5, 0)
    run(s, -1, 0, 2)
    expect(Math.hypot(s.player.x, s.player.z)).toBeCloseTo(P.CAULDRON_COLLIDER_RADIUS + P.PLAYER_RADIUS, 2)
    expect(s.player.stillT).toBeGreaterThan(0.5) // pushing against it counts as standing still

    s = onFoot(-3, 7.6)
    run(s, -1, 0, 2)
    // ward-1 west wall at x = -4.9, half thickness 0.175 + 0.05
    expect(s.player.x).toBeCloseTo(-4.9 + P.WALL_THICKNESS / 2 + 0.05 + P.PLAYER_RADIUS, 2)

    s = onFoot(19, -3)
    run(s, 1, 0, 2)
    expect(s.player.x).toBeCloseTo(L.BOUNDS.x1 - P.PLAYER_RADIUS, 6)

    s = onFoot(19, -19)
    run(s, 0, -1, 2)
    expect(s.player.z).toBeCloseTo(L.BOUNDS.z0 + P.PLAYER_RADIUS, 6)
  })

  test('he slides along a wall instead of sticking to it', () => {
    const s = onFoot(-3, 7.6)
    run(s, -1, -0.4, 1.5)
    expect(s.player.x).toBeLessThan(-4.2)
    expect(s.player.z).toBeLessThan(7.0)
  })

  test('random walking for minutes never leaves him inside a collider or outside the bounds', () => {
    const starts: [number, number][] = [[0, -4], [-6.5, -1.8], [0, 7.7], [0.6, -12], [12, -3], [8, 1.5], [19, -15], [-4, -5]]
    const rng = makeRng(7)
    let worst = 0
    for (let k = 0; k < starts.length; k++) {
      const s = onFoot(starts[k]![0], starts[k]![1])
      expect(bodyPenetration(s)).toBe(0)
      let mx = 0
      let mz = 0
      for (let i = 0; i < 60 * 40; i++) {
        if (i % 20 === 0) {
          const a = rand(rng) * Math.PI * 2
          const m = rand(rng) < 0.15 ? 0 : 1
          mx = Math.cos(a) * m
          mz = Math.sin(a) * m
        }
        if (i === 60 * 20) s.unlocks.ward2 = true // beds appear, the yard props go
        stepPlayer(s, { mx, mz }, DT)
        const pen = bodyPenetration(s)
        if (pen > worst) worst = pen
        if (!(pen <= 1e-3)) throw new Error(`inside a collider by ${pen} at ${s.player.x}, ${s.player.z} (start ${k}, step ${i})`)
      }
      expect(Number.isFinite(s.player.x + s.player.z + s.player.heading)).toBe(true)
    }
    expect(worst).toBeLessThanOrEqual(1e-3)
  })

  test('a collider that appears on top of him pushes him out', () => {
    const bed = { x: 3.4, z: -12.2 } // ward-2 bed 2
    const s = onFoot(bed.x, bed.z + 0.2)
    s.unlocks.ward2 = true
    run(s, 0, 0, 0.1)
    expect(bodyPenetration(s)).toBe(0)
  })

  test('resolveStatic and the cart mover keep the wagon body out of everything', () => {
    const s = quiet()
    const pos = resolveStatic(s, { x: 9.6, z: -2.8 }, P.CART_BODY_RADIUS) // centre of the grinder
    expect(staticPenetration(s, pos.x, pos.z, P.CART_BODY_RADIUS)).toBe(0)

    const rng = makeRng(11)
    const m: Mover = { x: 14, z: -3, vx: 0, vz: 0, heading: WEST }
    let ix = -1
    let iz = 0
    for (let i = 0; i < 60 * 90; i++) {
      if (i % 45 === 0) {
        const a = rand(rng) * Math.PI * 2
        ix = Math.cos(a)
        iz = Math.sin(a)
      }
      stepCartMover(s, m, ix, iz, DT)
      const body = cartBody(m)
      const pen = staticPenetration(s, body.x, body.z, P.CART_BODY_RADIUS)
      if (!(pen <= 1e-3)) throw new Error(`cart body inside a collider by ${pen} at ${body.x}, ${body.z} (step ${i})`)
      expect(Math.hypot(m.vx, m.vz)).toBeLessThanOrEqual(P.CART_SPEED + 1e-9)
    }
    // head-on into the grinder: the body stops at its east face and the speed drops to nothing
    Object.assign(m, { x: 16, z: -2.8, vx: 0, vz: 0, heading: WEST })
    for (let i = 0; i < 120; i++) stepCartMover(s, m, -1, 0, DT)
    expect(cartBody(m).x).toBeCloseTo(L.GRINDER[2] + P.CART_BODY_RADIUS, 2)
    expect(Math.hypot(m.vx, m.vz)).toBeLessThan(0.3)
  })

  test('scoop and cart glance off an obstacle they meet at an angle instead of getting stuck on it', () => {
    // the scoop against the east face of the grinder: he slides south along it
    const s = withScoop(13, -4.5, WEST)
    run(s, -1, 0.6, 0.65)
    expect(s.player.x).toBeCloseTo(L.GRINDER[2] + P.PLAYER_RADIUS, 2)
    expect(s.player.z).toBeGreaterThan(-3)
    expect(speedOf(s)).toBeGreaterThan(5)
    expect(s.player.mode).toBe('scoop')
    // the cart against the boulder at (13.2, 1.2) on its way west: it slips past to the north
    const m: Mover = { x: 18, z: 1.6, vx: 0, vz: 0, heading: WEST }
    for (let i = 0; i < 60 * 2; i++) stepCartMover(s, m, -1, -0.25, DT)
    expect(m.x).toBeLessThan(14.5) // 2.3 m clear of the boulder's centre is x = 17 for the seat
    expect(m.z).toBeLessThan(0)
    const body = cartBody(m)
    expect(staticPenetration(s, body.x, body.z, P.CART_BODY_RADIUS)).toBe(0)
  })

  test("a parked cart's body blocks him on foot without trapping him", () => {
    const s = onFoot(12, -3)
    Object.assign(s.tools[0]!, { kind: 'cart', exists: true, holder: 'none', armed: false, x: 16, z: -3, heading: WEST })
    const body = cartBody(s.tools[0]!)
    const clear = P.CART_BODY_RADIUS + P.PLAYER_RADIUS
    run(s, 1, 0, 2) // straight at it from the west
    expect(Math.hypot(s.player.x - body.x, s.player.z - body.z)).toBeGreaterThanOrEqual(clear - 1e-6)
    expect(s.player.x).toBeLessThan(body.x)
    run(s, 1, 0.6, 2) // steering a little gets him round it
    expect(s.player.x).toBeGreaterThan(body.x + 1)
    // a cart that materialises on top of him pushes him out, but never into a wall
    Object.assign(s.player, { x: body.x - 0.1, z: body.z, vx: 0, vz: 0 })
    run(s, 0, 0, 0.1)
    expect(Math.hypot(s.player.x - body.x, s.player.z - body.z)).toBeGreaterThanOrEqual(clear - 1e-6)
    expect(bodyPenetration(s)).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------

describe('tools', () => {
  test('blade geometry: centre ahead of the holder, tips on both sides, concave side forward', () => {
    const s = quiet()
    const tool = s.tools[0]!
    Object.assign(tool, { x: 10, z: 5, heading: EAST })
    const c = bladeCenter(tool)
    expect(c.x).toBeCloseTo(10 + P.SCOOP_OFFSET, 9)
    expect(c.z).toBeCloseTo(5, 9)
    const poly = bladeWorld(tool)
    const n = BLADES.scoop.poly.length / 2
    expect(n).toBe(9)
    // both tips are sagitta further ahead than the centre and half a chord to either side
    expect(poly[0]!).toBeCloseTo(c.x + P.SCOOP_SAGITTA, 6)
    expect(poly[(n - 1) * 2]!).toBeCloseTo(c.x + P.SCOOP_SAGITTA, 6)
    expect(Math.abs(poly[1]! - 5)).toBeCloseTo(P.SCOOP_CHORD / 2, 6)
    expect(poly[1]! + poly[(n - 1) * 2 + 1]!).toBeCloseTo(10, 6)
    expect(poly[8]!).toBeCloseTo(c.x, 6)
    // the polyline samples the arc the collision code uses
    const arc = BLADE_ARCS.scoop
    for (let i = 0; i < n; i++) expect(Math.hypot(poly[i * 2]! - (10 + arc.cz), poly[i * 2 + 1]! - 5)).toBeCloseTo(arc.R, 5)
    const seat = dockSeat(tool, 1.3)
    expect(seat.x).toBeCloseTo(c.x + P.DOCK_SEAT * 1.3, 9)
  })

  test('park, re-arm by distance, grab again', () => {
    const s = quiet()
    const tool = s.tools[0]!
    expect(s.player.mode).toBe('scoop')
    parkTool(s, 0)
    expect(s.player.mode).toBe('foot')
    expect(s.player.tool).toBe(-1)
    expect(tool.holder).toBe('none')
    expect(tool.armed).toBe(false)
    expect(eventsOf(s, 'toolPark')).toHaveLength(1)
    const px = tool.x
    const pz = tool.z

    // standing at the handle, or wandering closer than the re-arm distance, does not pick it up again
    run(s, 0, 0, 0.5)
    run(s, 0, 1, 0.2)
    run(s, 0, -1, 0.4)
    expect(s.player.mode).toBe('foot')
    expect(tool.armed).toBe(false)
    expect(tool.x).toBe(px)

    // more than SCOOP_REARM_DISTANCE away: armed
    run(s, 0, 1, 0.6)
    expect(Math.hypot(s.player.x - px, s.player.z - pz)).toBeGreaterThan(P.SCOOP_REARM_DISTANCE)
    expect(tool.armed).toBe(true)
    expect(s.player.mode).toBe('foot')

    // walking back: grabbed at the grab radius, and the scoop is in his hands at once
    s.events.length = 0
    let grabbedAt = -1
    run(s, 0, -1, 1, {
      each: () => {
        if (grabbedAt < 0 && s.player.mode === 'scoop') grabbedAt = Math.hypot(s.player.x - px, s.player.z - pz)
      },
    })
    expect(grabbedAt).toBeGreaterThan(P.SCOOP_GRAB_RADIUS - 0.15)
    expect(grabbedAt).toBeLessThanOrEqual(P.SCOOP_GRAB_RADIUS)
    expect(tool.holder).toBe('player')
    expect(s.player.tool).toBe(0)
    expect(eventsOf(s, 'toolGrab')).toEqual([{ type: 'toolGrab', tool: 0, kind: 'scoop' }])
    expect(tool.x).toBe(s.player.x)
    expect(tool.heading).toBe(s.player.heading)
  })

  test('work area: the scoop is left at x = 8.2 and the doctor walks on', () => {
    const s = withScoop(11.5, 1.5, WEST)
    s.events.length = 0
    run(s, -1, 0, 1.2)
    const tool = s.tools[0]!
    expect(s.player.mode).toBe('foot')
    expect(s.player.x).toBeLessThan(6)
    expect(tool.holder).toBe('none')
    expect(tool.x).toBeCloseTo(P.WORK_AREA_MIN_X, 9)
    expect(tool.z).toBeCloseTo(1.5, 6)
    expect(eventsOf(s, 'toolPark')).toHaveLength(1)
    // coming back from the west he takes it again once he is inside the work area
    run(s, 1, 0, 1.5)
    expect(s.player.mode).toBe('scoop')
    expect(eventsOf(s, 'toolPark')).toHaveLength(1)
    expect(s.player.x).toBeGreaterThan(P.WORK_AREA_MIN_X)
  })

  test('work area: with a docked bubble he is blocked at the boundary instead', () => {
    const s = withScoop(11.5, 1.5, WEST)
    const b = addBubble(s, 'M', 9, 1.5, 'docked', 0)
    run(s, -1, 0, 1.5, { river: true })
    expect(s.player.mode).toBe('scoop')
    expect(s.player.x).toBeCloseTo(P.WORK_AREA_MIN_X, 6)
    expect(s.tools[0]!.bubble).toBe(b.id)
    expect(b.state).toBe('docked')
    // not stuck: he can turn round and leave
    run(s, 1, 0, 1, { river: true })
    expect(s.player.x).toBeGreaterThan(P.WORK_AREA_MIN_X + 2)
  })

  test('a delivered bubble parks the hand scoop 0.3 m back, with the doctor still at the handle', () => {
    const s = withScoop(13, -3, WEST)
    addBubble(s, 'M', 10.7, -3, 'docked', 0)
    s.events.length = 0
    onBubbleDelivered(s, 0)
    const tool = s.tools[0]!
    expect(tool.bubble).toBe(-1)
    expect(tool.holder).toBe('none')
    expect(tool.armed).toBe(false)
    expect(tool.x).toBeCloseTo(13.3, 6)
    expect(s.player.mode).toBe('foot')
    expect(s.player.x).toBeCloseTo(13.3, 6)
    expect(eventsOf(s, 'toolPark')).toHaveLength(1)
    // he walks away and the scoop stays where it is
    run(s, 0, 1, 1)
    expect(tool.x).toBeCloseTo(13.3, 6)
    expect(tool.z).toBeCloseTo(-3, 6)
    expect(s.player.mode).toBe('foot')
  })

  test("unlock 'cart': the scoop he holds becomes a parked cart at the same spot", () => {
    const s = withScoop(14, -3, WEST)
    s.events.length = 0
    s.unlocks.cart = true
    run(s, 0, 0, DT)
    const tool = s.tools[0]!
    expect(tool.kind).toBe('cart')
    expect(tool.exists).toBe(true)
    expect(tool.holder).toBe('none')
    expect(tool.age).toBeLessThan(0.05)
    expect(tool.x).toBeCloseTo(14, 6)
    expect(tool.z).toBeCloseTo(-3, 6)
    expect(s.player.mode).toBe('foot')
    expect(eventsOf(s, 'toolSwap')).toEqual([{ type: 'toolSwap', tool: 0, kind: 'cart', x: tool.x, z: tool.z }])
    run(s, 0, 0, 1)
    expect(eventsOf(s, 'toolSwap')).toHaveLength(1) // once
    expect(s.player.mode).toBe('foot') // he let go, so the cart is not armed
    expect(tool.age).toBeGreaterThan(0.9)
  })

  test("unlock 'cart' while the scoop is parked: the cart is armed and its body is clear of the grinder", () => {
    const s = quiet()
    Object.assign(s.tools[0]!, { x: 11.6, z: -3, heading: WEST, holder: 'none', armed: true })
    Object.assign(s.player, { mode: 'foot', tool: -1, x: 10.4, z: -8.5 })
    s.unlocks.cart = true
    run(s, 0, 0, DT)
    const tool = s.tools[0]!
    expect(tool.kind).toBe('cart')
    expect(tool.armed).toBe(true)
    const body = cartBody(tool)
    expect(staticPenetration(s, body.x, body.z, P.CART_BODY_RADIUS)).toBe(0)
    expect(tool.x).toBeGreaterThanOrEqual(P.WORK_AREA_MIN_X)
  })

  test('cart: mount within 1.2 m of the seat, drive, deliver, hop off on the next input', () => {
    const s = onFoot(18.5, -13.5)
    const tool = s.tools[0]!
    Object.assign(tool, { kind: 'cart', exists: true, holder: 'none', armed: true, x: 18.5, z: -10, heading: 0, age: 5 })
    s.events.length = 0

    // walk south to the seat, from behind the cart
    let mountStart = -1
    let mounted = -1
    let t = 0
    run(s, 0, 1, 1.2, {
      each: () => {
        t += DT
        if (mountStart < 0 && s.player.mountT > 0) {
          mountStart = t
          expect(Math.hypot(s.player.x - tool.x, s.player.z - tool.z)).toBeLessThanOrEqual(P.CART_GRAB_RADIUS)
          expect(s.player.mode).toBe('foot')
        }
        if (mounted < 0 && s.player.mode === 'cart') mounted = t
      },
    })
    expect(mountStart).toBeGreaterThan(0)
    expect(mounted - mountStart).toBeCloseTo(P.CART_MOUNT_TIME, 1)
    expect(eventsOf(s, 'toolGrab')).toEqual([{ type: 'toolGrab', tool: 0, kind: 'cart' }])
    expect(eventsOf(s, 'cartMount')).toHaveLength(1)
    expect(tool.holder).toBe('player')
    // he was hopping, then he sits: his pose is the cart's
    expect(s.player.x).toBe(tool.x)
    expect(s.player.z).toBe(tool.z)
    expect(s.player.heading).toBe(tool.heading)

    // (still holding the stick south, he has been driving since he sat down) one more second
    const z0 = tool.z
    run(s, 0, 1, 1)
    expect(tool.z - z0).toBeGreaterThan(3)
    expect(speedOf(s)).toBeCloseTo(P.CART_SPEED, 5)

    // the grinder takes the bubble: the cart brakes, and the first movement input after it stopped makes him hop off
    addBubble(s, 'L', tool.x, tool.z + 5.2, 'docked', 0)
    onBubbleDelivered(s, 0)
    expect(tool.bubble).toBe(-1)
    expect(s.player.dismountPending).toBe(true)
    expect(s.player.mode).toBe('cart')
    s.events.length = 0
    let hopStart = -1
    let hopEnd = -1
    t = 0
    run(s, 1, 0, 1, {
      each: () => {
        t += DT
        if (hopStart < 0 && s.player.dismountT > 0) hopStart = t
        if (hopStart >= 0 && hopEnd < 0 && s.player.dismountT === 0) hopEnd = t
      },
    })
    expect(hopStart).toBeGreaterThan(0.15) // not before the cart has stopped
    expect(hopStart).toBeLessThan(0.45)
    expect(hopEnd - hopStart).toBeCloseTo(P.CART_DISMOUNT_TIME, 1)
    expect(eventsOf(s, 'cartDismount')).toHaveLength(1)
    expect(eventsOf(s, 'toolPark')).toHaveLength(1)
    expect(s.player.mode).toBe('foot')
    expect(s.player.dismountPending).toBe(false)
    expect(tool.holder).toBe('none')
    // the cart stays where it stopped; he is beside it, clear of the wagon body, walking east
    const stopZ = tool.z
    expect(stopZ - z0).toBeLessThan(5.6)
    expect(s.player.x).toBeGreaterThan(tool.x + 1)
    const body = cartBody(tool)
    expect(Math.hypot(s.player.x - body.x, s.player.z - body.z)).toBeGreaterThanOrEqual(P.CART_BODY_RADIUS + P.PLAYER_RADIUS - 1e-6)
    run(s, 1, 0, 0.5)
    expect(tool.z).toBe(stopZ)
    // re-arms once he is CART_REARM_DISTANCE away
    expect(tool.armed).toBe(true)
  })

  test('cart at the work-area boundary: he hops off and the cart stays; with a bubble he is blocked', () => {
    let s = onCart(11, 2.2, WEST)
    s.events.length = 0
    run(s, -1, 0, 2)
    let tool = s.tools[0]!
    expect(s.player.mode).toBe('foot')
    expect(tool.holder).toBe('none')
    expect(tool.x).toBeCloseTo(P.WORK_AREA_MIN_X, 6)
    expect(eventsOf(s, 'cartDismount')).toHaveLength(1)
    expect(s.player.x).toBeLessThan(P.WORK_AREA_MIN_X - 1) // walked on, round the wagon
    expect(bodyPenetration(s)).toBe(0)

    s = onCart(11, 2.2, WEST)
    tool = s.tools[0]!
    addBubble(s, 'L', 5.8, 2.2, 'docked', 0)
    run(s, -1, 0, 2, { river: true })
    expect(s.player.mode).toBe('cart')
    expect(s.player.x).toBeCloseTo(P.WORK_AREA_MIN_X, 6)
    expect(tool.bubble).not.toBe(-1)
    run(s, 1, 0, 3, { river: true }) // and can turn round and drive away again
    expect(s.player.x).toBeGreaterThan(P.WORK_AREA_MIN_X + 1)
  })

  test("the driver's cart is left alone, and the doctor can use the spare hand scoop", () => {
    const s = onFoot(12.4, 1.2)
    const cart = s.tools[0]!
    Object.assign(cart, { kind: 'cart', exists: true, holder: 'driver', armed: false, x: 18.5, z: -0.4, heading: NORTH })
    const spare = s.tools[1]!
    Object.assign(spare, { exists: true, armed: true })
    s.events.length = 0
    run(s, 0, -1, 0.6, { river: true })
    expect(s.player.mode).toBe('scoop')
    expect(s.player.tool).toBe(1)
    expect(spare.holder).toBe('player')
    expect(spare.age).toBeGreaterThan(0.5)
    // the cart keeps the pose its driver gave it and stays his
    expect(cart.holder).toBe('driver')
    expect([cart.x, cart.z, cart.heading]).toEqual([18.5, -0.4, NORTH])
    // the driver's blade catches bubbles too
    const b = addBubble(s, 'L', 18.5, -0.4 - P.CART_BLADE_OFFSET - 3, 'drift')
    run(s, 0, 0, 1.5, { river: true })
    expect(cart.bubble).toBe(b.id)
    const dock = eventsOf(s, 'bubbleDock')
    expect(dock).toHaveLength(1)
    expect(dock[0]!.byPlayer).toBe(false)
    expect(eventsOf(s, 'emoji')).toHaveLength(0) // helpers.ts shows the driver's emoji
    // taking the cart away from the player (what helpers.ts does) drops him to his feet
    const s2 = onCart(17, -12, 0)
    parkTool(s2, 0)
    s2.tools[0]!.holder = 'driver'
    expect(s2.player.mode).toBe('foot')
    run(s2, 0, 0, 0.5)
    expect(s2.player.mode).toBe('foot')
    expect(s2.tools[0]!.holder).toBe('driver')
    expect(s2.tools[0]!.armed).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------

describe('river: small balls', () => {
  test('initRiver: every ball placed, dense upstream and thinner toward the fall, strays at the seed', () => {
    const s = createState(5)
    const b = s.balls
    expect(b.n).toBe(P.BALL_COUNT)
    let strays = 0
    const third = [0, 0, 0]
    for (let i = 0; i < b.n; i++) {
      expect(Number.isFinite(b.x[i]! + b.z[i]! + b.vx[i]! + b.vz[i]!)).toBe(true)
      expect(b.y[i]).toBe(0)
      if (b.state[i] === BALL_STRAY) {
        strays++
        expect(Math.hypot(b.x[i]! - L.STRAY_SEED.x, b.z[i]! - L.STRAY_SEED.z)).toBeLessThanOrEqual(0.41)
        continue
      }
      expect(b.state[i]).toBe(BALL_FLOW)
      const r = riverSample(b.x[i]!, b.z[i]!)
      expect(Math.abs(r.d)).toBeLessThan(r.halfW + 0.05)
      expect(b.z[i]!).toBeLessThanOrEqual(L.CLIFF_Z + 0.2)
      // already flowing downstream
      expect(b.vx[i]! * r.tx + b.vz[i]! * r.tz).toBeGreaterThan(0.5)
      if (r.s >= 0) third[Math.min(2, Math.floor((r.s / RIVER_LENGTH) * 3))]!++
    }
    expect(strays).toBe(L.STRAY_SEED.n)
    // (the middle third is narrowed by the boulders that stand in the bed, so it is compared by itself)
    expect(third[0]!).toBeGreaterThan(third[2]! * 1.1)
    expect(third[1]!).toBeGreaterThan(500)
    expect(third[2]!).toBeGreaterThan(500)
    // the river is not empty of bubbles at the start either
    expect(s.bubbles.length).toBeGreaterThanOrEqual(2)
    expect(s.events).toHaveLength(0)
    // deterministic
    const s2 = createState(5)
    expect(Array.from(s2.balls.x.subarray(0, 200))).toEqual(Array.from(b.x.subarray(0, 200)))
  })

  test('60 s of flow: balls conserved and finite, river populated along its whole length, bubbles come and go', () => {
    const s = createState(2)
    const b = s.balls
    const sizes = new Set<string>()
    let spawned = 0
    let fell = 0
    let maxAlive = 0
    for (let i = 0; i < 60 * 60; i++) {
      stepPlayer(s, { mx: 0, mz: 0 }, DT)
      stepRiver(s, DT)
      maxAlive = Math.max(maxAlive, s.bubbles.length)
      for (const e of s.events) {
        if (e.type === 'bubbleSpawn') {
          spawned++
          sizes.add(e.size)
        } else if (e.type === 'bubbleFall') fell++
      }
      s.events.length = 0
    }
    expect(b.n).toBe(P.BALL_COUNT)
    expect(b.x.length).toBe(P.BALL_COUNT)
    const BIN = 3
    const bins = new Array<number>(Math.ceil(RIVER_LENGTH / BIN)).fill(0)
    const counts = [0, 0, 0, 0]
    for (let i = 0; i < b.n; i++) {
      expect(Number.isFinite(b.x[i]! + b.z[i]! + b.y[i]! + b.vx[i]! + b.vz[i]! + b.vy[i]! + b.t[i]!)).toBe(true)
      const st = b.state[i]!
      expect(st).toBeLessThanOrEqual(BALL_FALL)
      counts[st]!++
      if (st !== BALL_FLOW) continue
      const r = riverSample(b.x[i]!, b.z[i]!)
      // untouched balls stay in the bed
      expect(Math.abs(r.d)).toBeLessThan(r.halfW + 0.6)
      if (r.s >= 0 && r.s < RIVER_LENGTH) bins[Math.floor(r.s / BIN)]!++
    }
    expect(counts[0]! + counts[1]! + counts[2]! + counts[3]!).toBe(P.BALL_COUNT)
    expect(counts[BALL_FLOW]!).toBeGreaterThan(P.BALL_COUNT * 0.9)
    expect(counts[BALL_FALL]!).toBeGreaterThan(20) // the curtain at the cliff
    expect(counts[BALL_STRAY]!).toBeLessThanOrEqual(P.MAX_STRAYS)
    // at least 6 balls per m2 everywhere (the bed is 6.4-7.6 m wide), and denser at the top than at the bottom
    for (let k = 0; k < bins.length - 1; k++) expect(bins[k]!).toBeGreaterThan(6 * 6.4 * BIN)
    expect(bins[0]! + bins[1]!).toBeGreaterThan(bins[bins.length - 3]! + bins[bins.length - 2]!)

    expect(maxAlive).toBeLessThanOrEqual(P.BUBBLE_MAX_ALIVE)
    expect(spawned).toBeGreaterThan(25) // mean interval 1.65 s
    expect(spawned).toBeLessThan(60)
    expect(fell).toBeGreaterThan(20)
    expect(sizes.size).toBe(3)
    for (const bb of s.bubbles) {
      expect(bb.state).toBe('drift')
      const r = riverSample(bb.x, bb.z)
      expect(Math.abs(r.d) + bb.r).toBeLessThan(r.halfW + 0.3) // rigid spheres that stay on the river
    }
  }, 30000)

  test('balls flow downstream: 0.9 m/s class at the banks, several m/s mid-stream, faster toward the fall', () => {
    const s = quiet(3)
    for (let i = 0; i < 120; i++) stepRiver(s, DT)
    const b = s.balls
    const x0 = Float32Array.from(b.x)
    const z0 = Float32Array.from(b.z)
    const st0 = Uint8Array.from(b.state)
    for (let i = 0; i < 30; i++) stepRiver(s, DT)
    const sum = { bank: 0, mid: 0, midLow: 0 }
    const cnt = { bank: 0, mid: 0, midLow: 0 }
    for (let i = 0; i < b.n; i++) {
      if (st0[i] !== BALL_FLOW || b.state[i] !== BALL_FLOW) continue
      const r = riverSample(x0[i]!, z0[i]!)
      if (r.s < 2 || r.s > RIVER_LENGTH - 3) continue
      const v = ((b.x[i]! - x0[i]!) * r.tx + (b.z[i]! - z0[i]!) * r.tz) / 0.5
      const u = Math.abs(r.d) / r.halfW
      const key = u > 0.9 ? 'bank' : u < 0.25 ? (r.p > 0.7 ? 'midLow' : r.p < 0.3 ? 'mid' : null) : null
      if (!key) continue
      sum[key] += v
      cnt[key]++
    }
    const bank = sum.bank / cnt.bank
    const mid = sum.mid / cnt.mid
    const midLow = sum.midLow / cnt.midLow
    expect(bank).toBeGreaterThan(0.6)
    expect(bank).toBeLessThan(2.0)
    expect(mid).toBeGreaterThan(2.4)
    expect(mid).toBeLessThan(4.2)
    expect(midLow).toBeGreaterThan(mid * 1.15)
  })

  test('a blade sweeping across the river piles balls on its face and leaves a lane that refills', () => {
    const s = withScoop(13.5, -3, EAST)
    for (let i = 0; i < 60; i++) stepRiver(s, DT) // let the start positions relax
    const b = s.balls
    const inBox = (x0: number, x1: number, z0: number, z1: number) => {
      let n = 0
      for (let i = 0; i < b.n; i++) if (b.y[i] === 0 && b.state[i] !== BALL_FALL && b.x[i]! >= x0 && b.x[i]! <= x1 && b.z[i]! >= z0 && b.z[i]! <= z1) n++
      return n
    }
    // a box in the downstream half of the strip the blade is about to sweep (the refill comes from upstream)
    const lane: [number, number, number, number] = [16.5, 18.0, -2.6, -1.6]
    const before = inBox(...lane)
    expect(before).toBeGreaterThan(9)

    let t = 0
    let clearedAt = -1
    let refilledAt = -1
    let least = before
    let pile = -1
    let behindBlade = -1
    const watch = () => {
      const p = s.player
      t += DT
      const n = inBox(...lane)
      least = Math.min(least, n)
      if (clearedAt < 0 && n <= before * 0.15) clearedAt = t
      else if (clearedAt >= 0 && refilledAt < 0 && n >= before * 0.7) refilledAt = t
      if (pile < 0 && p.x >= 18.5) {
        // the wedge on the concave face: between the blade and the line through its tips
        pile = inBox(p.x + P.SCOOP_OFFSET, p.x + P.SCOOP_OFFSET + P.SCOOP_SAGITTA + 0.3, p.z - 1.0, p.z + 1.0)
        // nothing slips through the blade: the strip right behind it is empty
        behindBlade = inBox(p.x + 0.65, p.x + P.SCOOP_OFFSET - 0.25, p.z - 0.6, p.z + 0.6)
      }
    }
    run(s, 1, 0, 1.0, { river: true, each: watch })
    run(s, 0, 0, 1.2, { river: true, each: watch }) // he stands on the far side
    expect(least).toBe(0) // a bare lane behind the blade
    expect(pile).toBeGreaterThan(12)
    expect(behindBlade).toBe(0)
    // ... which refills from upstream (SPEC: within 0.5-1 s)
    expect(clearedAt).toBeGreaterThan(0)
    expect(refilledAt - clearedAt).toBeGreaterThan(0.2)
    expect(refilledAt - clearedAt).toBeLessThanOrEqual(1.0)
  })

  test('a fast-turning blade never leaves a ball inside or behind itself', () => {
    const s = withScoop(18.5, -8, NORTH)
    for (let i = 0; i < 30; i++) stepRiver(s, DT)
    const b = s.balls
    const tool = s.tools[0]!
    const arc = BLADE_ARCS.scoop
    const cap = P.BALL_DIAMETER / 2 + P.BLADE_THICKNESS / 2
    let prev = { x: tool.x, z: tool.z, h: tool.heading }
    const side = new Int8Array(b.n) // +1 = concave side, -1 = convex side, 0 = not over the blade
    const classify = (pose: { x: number; z: number; h: number }, out: Int8Array | null) => {
      const c = Math.cos(pose.h)
      const sn = Math.sin(pose.h)
      let crossed = 0
      for (let i = 0; i < b.n; i++) {
        if (b.state[i] === BALL_FALL || b.y[i]! > 0) {
          if (out) out[i] = 0
          continue
        }
        const dx = b.x[i]! - pose.x
        const dz = b.z[i]! - pose.z
        const lx = dx * c - dz * sn
        const lz = dx * sn + dz * c - arc.cz
        const rho = Math.hypot(lx, lz)
        const over = -lz >= rho * arc.cosHalf && Math.abs(rho - arc.R) < 1.0
        const now = over ? (rho < arc.R ? 1 : -1) : 0
        if (out) out[i] = now
        else {
          // nobody sits inside the blade
          if (over && Math.abs(rho - arc.R) < cap - 0.04) throw new Error(`ball ${i} inside the blade (${Math.abs(rho - arc.R)})`)
          if (now !== 0 && side[i] !== 0 && now !== side[i]) crossed++
        }
      }
      return crossed
    }
    const rng = makeRng(3)
    let mx = 0
    let mz = -1
    let crossedTotal = 0
    for (let i = 0; i < 60 * 6; i++) {
      if (i % 12 === 0) {
        const a = rand(rng) * Math.PI * 2
        mx = Math.cos(a)
        mz = Math.sin(a)
      }
      // where every ball is relative to the blade BEFORE the step
      classify(prev, side)
      stepPlayer(s, { mx, mz }, DT)
      if (s.player.x < 16.5 || s.player.x > 20.5 || s.player.z < -12 || s.player.z > -3) {
        // keep him in mid-stream
        mx = 18.5 - s.player.x
        mz = -8 - s.player.z
      }
      stepRiver(s, DT)
      prev = { x: tool.x, z: tool.z, h: tool.heading }
      crossedTotal += classify(prev, null)
    }
    expect(crossedTotal).toBe(0)
  })

  test('balls bulldozed onto the bank become strays; strays are capped and the permanent ones never expire', () => {
    const s = withScoop(11, -12, NORTH) // the doctor keeps out of it
    const b = s.balls
    // 200 balls dumped on the dirt west of the river, more than a metre from the bed
    let k = 0
    for (let i = 100; k < 200; i++) {
      if (b.state[i] !== BALL_FLOW) continue
      b.x[i] = 11 + (k % 10) * 0.26
      b.z[i] = -6.8 + Math.floor(k / 10) * 0.26
      b.vx[i] = b.vz[i] = 0
      b.state[i] = BALL_LOOSE
      b.t[i] = 0
      k++
    }
    let maxStrays = 0
    for (let i = 0; i < 90; i++) {
      stepRiver(s, DT)
      maxStrays = Math.max(maxStrays, countState(s, BALL_STRAY))
    }
    expect(maxStrays).toBe(P.MAX_STRAYS)
    expect(countState(s, BALL_STRAY)).toBe(P.MAX_STRAYS)
    expect(countState(s, BALL_LOOSE)).toBe(0)
    // the surplus went back to the source
    expect(countState(s, BALL_FLOW) + countState(s, BALL_FALL)).toBe(P.BALL_COUNT - P.MAX_STRAYS)
    // strays are static
    const stray = Array.from({ length: b.n }, (_, i) => i).filter(i => b.state[i] === BALL_STRAY && i >= L.STRAY_SEED.n)
    const sx = stray.map(i => b.x[i]!)
    for (let i = 0; i < 60; i++) stepRiver(s, DT)
    expect(stray.map(i => b.x[i]!)).toEqual(sx)
    // after STRAY_LIFETIME only the permanent seed strays are left
    for (let i = 0; i < 60 * (P.STRAY_LIFETIME - 1); i++) stepRiver(s, DT)
    expect(countState(s, BALL_STRAY)).toBe(L.STRAY_SEED.n)
    for (let i = 0; i < L.STRAY_SEED.n; i++) expect(b.state[i]).toBe(BALL_STRAY)
  }, 30000)

  test('the doctor and the scoop push strays about, and a real sweep onto the bank leaves some', () => {
    const s = withScoop(18, -3, WEST)
    for (let i = 0; i < 30; i++) stepRiver(s, DT)
    let maxStrays = 0
    // out of the river to the west bank and on toward the grinder
    run(s, -1, 0, 0.75, { river: true })
    run(s, 0, 0, 1.2, { river: true, each: () => (maxStrays = Math.max(maxStrays, countState(s, BALL_STRAY))) })
    expect(maxStrays).toBeGreaterThan(L.STRAY_SEED.n + 3)
    expect(maxStrays).toBeLessThanOrEqual(P.MAX_STRAYS)
    // walking through them moves them: no ball stays inside the doctor
    const b = s.balls
    run(s, -1, 0, 0.3, {
      river: true,
      each: () => {
        for (let i = 0; i < b.n; i++) {
          if (b.state[i] === BALL_FALL || b.y[i]! > 0) continue
          expect(Math.hypot(b.x[i]! - s.player.x, b.z[i]! - s.player.z)).toBeGreaterThan(0.45 + P.BALL_DIAMETER / 2 - 0.02)
        }
      },
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------------

describe('river: bubbles', () => {
  test('bubbles drift down the centreline at BUBBLE_SPEED, roll, and fall off the cliff', () => {
    const s = quiet()
    Object.assign(s.player, { x: 11, z: -8 }) // out of the way
    const b = addBubble(s, 'S', 22, -24)
    const start = riverSample(b.x, b.z).s
    for (let i = 0; i < 120; i++) stepRiver(s, DT)
    const r = riverSample(b.x, b.z)
    expect((r.s - start) / 2).toBeCloseTo(P.BUBBLE_SPEED, 0)
    expect(Math.abs(r.d)).toBeLessThan(1.2)
    expect(Math.hypot(b.vx, b.vz)).toBeGreaterThan(P.BUBBLE_SPEED - 0.01)
    expect(b.roll).toBeCloseTo((P.BUBBLE_SPEED * 2) / b.r, 1)
    for (let i = 0; i < 60 * 6 && s.bubbles.length > 0; i++) stepRiver(s, DT)
    expect(s.bubbles).toHaveLength(0)
    expect(b.state).toBe('gone')
    const fall = eventsOf(s, 'bubbleFall')
    expect(fall).toHaveLength(1)
    expect(fall[0]!.id).toBe(b.id)
    expect(fall[0]!.z).toBeGreaterThanOrEqual(L.CLIFF_Z)
  })

  test('bubbles keep apart from each other and from boulders, and push the balls out of their way', () => {
    const s = quiet()
    Object.assign(s.player, { x: 11, z: -8 })
    const a = addBubble(s, 'L', 21.2, -19)
    const c = addBubble(s, 'L', 21.4, -18)
    let minGap = Infinity
    let minRock = Infinity
    for (let i = 0; i < 60 * 3; i++) {
      stepRiver(s, DT)
      if (i > 30) minGap = Math.min(minGap, Math.hypot(a.x - c.x, a.z - c.z) - a.r - c.r)
      for (const [x, z, r] of L.BOULDERS) for (const bb of s.bubbles) minRock = Math.min(minRock, Math.hypot(bb.x - x, bb.z - z) - r - bb.r)
      if (i % 20 === 0) {
        // no grounded ball under a bubble's footprint
        for (const bb of s.bubbles) {
          let under = 0
          for (let k = 0; k < s.balls.n; k++) if (s.balls.state[k] !== BALL_FALL && Math.hypot(s.balls.x[k]! - bb.x, s.balls.z[k]! - bb.z) < bb.r * 0.7) under++
          expect(under).toBe(0)
        }
      }
    }
    expect(minGap).toBeGreaterThan(-0.02)
    expect(minRock).toBeGreaterThan(-0.02)
  })

  test('the hand scoop captures an M bubble head-on: snap, burst, events', () => {
    const s = withScoop(18.5, -4, NORTH)
    const tool = s.tools[0]!
    const b = addBubble(s, 'M', 18.5, -4 - P.SCOOP_OFFSET - 1.3 - 2.5)
    let dockedAt = -1
    let seatedAt = -1
    let airborne = 0
    let apex = 0
    let t = 0
    run(s, 0, 0, 1.5, {
      river: true,
      each: () => {
        t += DT
        if (dockedAt < 0 && b.state === 'docking') {
          dockedAt = t
          for (let i = 0; i < s.balls.n; i++) if (s.balls.y[i]! > 0) airborne++
        }
        if (seatedAt < 0 && b.state === 'docked') seatedAt = t
        for (let i = 0; i < s.balls.n; i++) if (s.balls.state[i] !== BALL_FALL) apex = Math.max(apex, s.balls.y[i]!)
      },
    })
    expect(dockedAt).toBeGreaterThan(0.2)
    expect(seatedAt - dockedAt).toBeCloseTo(P.DOCK_SNAP_TIME, 1)
    expect(tool.bubble).toBe(b.id)
    expect(b.tool).toBe(0)
    expect(s.stats.bubblesCaught).toBe(1)
    const dock = eventsOf(s, 'bubbleDock')
    expect(dock).toHaveLength(1)
    expect(dock[0]).toMatchObject({ id: b.id, tool: 0, r: 1.3, byPlayer: true })
    expect(eventsOf(s, 'bubbleReject')).toHaveLength(0)
    expect(s.player.pushedT).toBe(0)
    expect(s.player.emoji).toBe('none') // the happy emoji belongs to the cart
    // SPEC 2.3: 15-25 balls burst 0.8-1.3 m up, and they are back down within a third of a second
    expect(airborne).toBeGreaterThanOrEqual(15)
    expect(airborne).toBeLessThanOrEqual(25)
    expect(apex).toBeGreaterThan(0.75)
    expect(apex).toBeLessThan(1.35)
    for (let i = 0; i < s.balls.n; i++) if (s.balls.state[i] !== BALL_FALL) expect(s.balls.y[i]).toBe(0)
    // seated at blade centre + forward * DOCK_SEAT * r
    const seat = dockSeat(tool, b.r)
    expect(Math.hypot(b.x - seat.x, b.z - seat.z)).toBeLessThan(1e-9)
    expect(seat.z).toBeCloseTo(-4 - P.SCOOP_OFFSET - P.DOCK_SEAT * 1.3, 6)
    // a second bubble cannot dock while the first one is there
    const b2 = addBubble(s, 'S', 18.5, -12)
    run(s, 0, 0, 2.5, { river: true })
    expect(tool.bubble).toBe(b.id)
    expect(b2.state).not.toBe('docking')
    expect(b2.state).not.toBe('docked')
    expect(s.stats.bubblesCaught).toBe(1)
  })

  test('a docked bubble stays seated through turns and keeps ploughing', () => {
    const s = withScoop(18.5, -4, NORTH)
    const tool = s.tools[0]!
    const b = addBubble(s, 'M', 18.5, -7.3, 'docked', 0)
    b.tool = 0
    const rng = makeRng(5)
    let mx = 0
    let mz = 0
    let worst = 0
    let turned = 0
    let lastH = s.player.heading
    for (let i = 0; i < 60 * 5; i++) {
      if (i % 15 === 0) {
        const a = rand(rng) * Math.PI * 2
        mx = Math.cos(a)
        mz = Math.sin(a)
      }
      if (s.player.x < 16 || s.player.x > 21 || s.player.z < -14 || s.player.z > 0) {
        mx = 18.5 - s.player.x
        mz = -6 - s.player.z
      }
      stepPlayer(s, { mx, mz }, DT)
      stepRiver(s, DT)
      turned += Math.abs(angleDelta(lastH, s.player.heading))
      lastH = s.player.heading
      const seat = dockSeat(tool, b.r)
      worst = Math.max(worst, Math.hypot(b.x - seat.x, b.z - seat.z))
      expect(b.state).toBe('docked')
      // no grounded ball under the bubble's footprint
      if (i % 10 === 0) for (let k = 0; k < s.balls.n; k++) if (s.balls.state[k] !== BALL_FALL && s.balls.y[k] === 0) expect(Math.hypot(s.balls.x[k]! - b.x, s.balls.z[k]! - b.z)).toBeGreaterThan(b.r * 0.7)
    }
    expect(turned).toBeGreaterThan(Math.PI * 4)
    expect(worst).toBeLessThan(1e-9)
    expect(tool.bubble).toBe(b.id)
    expect(b.roll).toBeGreaterThan(1)
  })

  test('the hand scoop rejects an L bubble: no capture, the doctor is PUSHED, scared emoji after 0.5 s', () => {
    const s = withScoop(18.5, -4, NORTH)
    const tool = s.tools[0]!
    const b = addBubble(s, 'L', 18.5, -4 - P.SCOOP_OFFSET - 1.8 - 2.5)
    let rejectAt = -1
    let emojiAt = -1
    let emojiEnd = -1
    let t = 0
    const z0 = s.player.z
    let zAfterPush = 0
    run(s, 0, 0, 2.2, {
      river: true,
      each: () => {
        t += DT
        if (rejectAt < 0 && eventsOf(s, 'bubbleReject').length > 0) {
          rejectAt = t
          expect(s.player.pushedT).toBeGreaterThan(P.PUSHED_DURATION - 0.05)
          expect(Math.hypot(s.player.pushVx, s.player.pushVz)).toBeCloseTo(P.PUSH_SPEED, 6)
          expect(s.player.pushVz).toBeGreaterThan(3.5) // along the bubble's travel, downstream
        }
        if (emojiAt < 0 && eventsOf(s, 'emoji').length > 0) {
          emojiAt = t
          expect(s.player.emoji).toBe('scared')
          expect(s.player.emojiT).toBeGreaterThanOrEqual(0)
        }
        if (emojiAt >= 0 && emojiEnd < 0 && s.player.emoji === 'none') emojiEnd = t
        if (rejectAt >= 0 && zAfterPush === 0 && t >= rejectAt + P.PUSHED_DURATION) zAfterPush = s.player.z
      },
    })
    expect(rejectAt).toBeGreaterThan(0.2)
    expect(eventsOf(s, 'bubbleReject')).toHaveLength(1) // one shove, however long they touch
    expect(eventsOf(s, 'bubbleReject')[0]!.id).toBe(b.id)
    expect(eventsOf(s, 'bubbleDock')).toHaveLength(0)
    expect(tool.bubble).toBe(-1)
    expect(s.stats.bubblesCaught).toBe(0)
    expect(b.state === 'drift' || b.state === 'gone').toBe(true)
    // carried along with the bubble (SPEC: 1-3.5 m), still holding the scoop
    expect(zAfterPush - z0).toBeGreaterThan(1)
    expect(zAfterPush - z0).toBeLessThan(4.5)
    expect(s.player.mode).toBe('scoop')
    expect(eventsOf(s, 'emoji')).toEqual([{ type: 'emoji', kind: 'scared', who: 'player' }])
    expect(emojiAt - rejectAt).toBeCloseTo(SCARED_DELAY, 1)
    expect(emojiEnd - emojiAt).toBeCloseTo(0.9, 1)
    expect(bodyPenetration(s)).toBe(0)
  })

  test('input still steers while PUSHED, and the bubble goes on down the river', () => {
    const s = withScoop(18.5, -6, NORTH)
    const b = addBubble(s, 'L', 18.5, -6 - P.SCOOP_OFFSET - 1.8 - 1.5)
    run(s, 0, 0, 0.4, { river: true })
    expect(s.player.pushedT).toBeGreaterThan(0)
    run(s, -1, 0, 1.2, { river: true }) // walk off to the west
    expect(s.player.x).toBeLessThan(15.5)
    expect(s.player.pushedT).toBe(0)
    expect(b.z).toBeGreaterThan(-4)
    expect(Math.abs(riverSample(b.x, b.z).d)).toBeLessThan(1.5)
    expect(eventsOf(s, 'bubbleReject')).toHaveLength(1)
  })

  test('the cart captures an L bubble: happy emoji 0.3 s later, bubble rides in front', () => {
    const s = onCart(18.5, 0, NORTH)
    const tool = s.tools[0]!
    const b = addBubble(s, 'L', 19.2, -P.CART_BLADE_OFFSET - 1.8 - 2.5)
    let dockAt = -1
    let emojiAt = -1
    let emojiEnd = -1
    let t = 0
    run(s, 0, 0, 2, {
      river: true,
      each: () => {
        t += DT
        if (dockAt < 0 && eventsOf(s, 'bubbleDock').length > 0) dockAt = t
        if (emojiAt < 0 && eventsOf(s, 'emoji').length > 0) emojiAt = t
        if (emojiAt >= 0 && emojiEnd < 0 && s.player.emoji === 'none') emojiEnd = t
      },
    })
    expect(dockAt).toBeGreaterThan(0)
    expect(b.state).toBe('docked')
    expect(tool.bubble).toBe(b.id)
    expect(s.stats.bubblesCaught).toBe(1)
    expect(eventsOf(s, 'bubbleReject')).toHaveLength(0)
    expect(eventsOf(s, 'emoji')).toEqual([{ type: 'emoji', kind: 'happy', who: 'player' }])
    expect(emojiAt - dockAt).toBeCloseTo(HAPPY_DELAY, 1)
    expect(emojiEnd - emojiAt).toBeCloseTo(0.7, 1)
    expect(s.player.pushedT).toBe(0)
    // drive a curve toward the grinder: it stays in the socket
    let worst = 0
    run(s, -1, 0.3, 3, {
      river: true,
      each: () => {
        const seat = dockSeat(tool, b.r)
        worst = Math.max(worst, Math.hypot(b.x - seat.x, b.z - seat.z))
      },
    })
    expect(worst).toBeLessThan(1e-9)
    expect(s.player.x).toBeLessThan(17)
  })

  test('capture needs the concave face and a centred hit', () => {
    // from behind: the bubble shoves the doctor aside instead of docking
    let s = withScoop(18.5, -4, 0) // facing downstream, back to the bubble
    let b = addBubble(s, 'M', 18.5, -9)
    run(s, 0, 0, 1.2, { river: true })
    expect(s.tools[0]!.bubble).toBe(-1)
    expect(eventsOf(s, 'bubbleDock')).toHaveLength(0)
    expect(eventsOf(s, 'bubbleReject')).toHaveLength(0) // it would fit: no scare
    expect(Math.hypot(s.player.x - b.x, s.player.z - b.z)).toBeGreaterThanOrEqual(b.r + P.PLAYER_RADIUS - 0.02)
    // far off the blade's axis: the tip is hit, no capture
    s = withScoop(16.3, -4, NORTH)
    b = addBubble(s, 'M', 18.6, -9)
    run(s, 0, 0, 1.2, { river: true })
    expect(s.tools[0]!.bubble).toBe(-1)
    expect(eventsOf(s, 'bubbleDock')).toHaveLength(0)
    // a parked tool catches nothing
    s = withScoop(18.5, -4, NORTH)
    parkTool(s, 0)
    Object.assign(s.player, { x: 12, z: -4 })
    b = addBubble(s, 'M', 18.5, -9)
    run(s, 0, 0, 2, { river: true })
    expect(s.tools[0]!.bubble).toBe(-1)
    expect(b.z).toBeGreaterThan(-1.5)
  })

  test("a bubble on the grinder is left to grinder.ts; a tool that lost its bubble can catch again", () => {
    const s = withScoop(13, -3, WEST)
    const g = addBubble(s, 'M', 9.6, -2.8, 'grinder')
    g.t = 0.3
    run(s, 0, 0, 1, { river: true })
    expect([g.x, g.z, g.state, g.tool]).toEqual([9.6, -2.8, 'grinder', -1])
    // tool.bubble pointing at a bubble that is no longer seated is cleaned up
    s.tools[0]!.bubble = g.id
    run(s, 0, 0, 0.1, { river: true })
    expect(s.tools[0]!.bubble).toBe(-1)
    // a docked bubble whose tool let go without the grinder goes back to drifting
    const d = addBubble(s, 'S', 11, -3, 'docked', 0)
    s.tools[0]!.bubble = -1
    run(s, 0, 0, 0.1, { river: true })
    expect(d.state).toBe('drift')
    expect(d.tool).toBe(-1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------

describe('performance', () => {
  test('stepRiver with 3200 balls averages well under 4 ms', () => {
    const s = createState(9)
    expect(s.balls.n).toBe(3200)
    // the doctor ploughs up and down the river the whole time
    const stepOnce = (i: number) => {
      const t = i * DT
      let mx = 18.5 + 2.5 * Math.sin(t * 0.9) - s.player.x
      let mz = -6 + 7 * Math.sin(t * 0.37) - s.player.z
      const m = Math.hypot(mx, mz)
      if (m > 1) {
        mx /= m
        mz /= m
      }
      stepPlayer(s, { mx, mz }, DT)
    }
    for (let i = 0; i < 300; i++) {
      stepOnce(i)
      stepRiver(s, DT)
    }
    let total = 0
    const N = 900
    for (let i = 0; i < N; i++) {
      stepOnce(300 + i)
      const t0 = performance.now()
      stepRiver(s, DT)
      total += performance.now() - t0
      s.events.length = 0
    }
    const avg = total / N
    console.log(`stepRiver: ${avg.toFixed(3)} ms average over ${N} steps (3200 balls, doctor ploughing)`)
    // shared CI runners are several times slower and noisy: there this only catches blow-ups
    expect(avg).toBeLessThan(process.env.CI ? 20 : 4)
  }, 30000)
})
