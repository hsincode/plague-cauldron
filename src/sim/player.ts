// The plague doctor (SPEC 2.1): movement on foot / with the hand scoop / on the cart, the PUSHED shove, the hops on
// and off the cart, the emoji timeline, and the static collisions shared with the cart driver NPC.
import { L, P } from '../config'
import { angleDelta, approach, clamp, headingOf, segT, TAU } from '../core/math'
import { STATIC_COLLIDERS } from '../world/colliders'
import { emit } from './events'
import { cartBody, releaseTool, stepTools, syncHeldTool, tryGrab } from './tools'
import type { GameState, Input } from './types'

/** Emoji timeline (SPEC 2.2 / 2.3): delay after the trigger, then visible time. */
export const SCARED_DELAY = 0.5
export const SCARED_TIME = 0.9
export const HAPPY_DELAY = 0.3
export const HAPPY_TIME = 0.7

const INPUT_DEADZONE = 0.05
/** The SPEC gives only the cart's acceleration; braking is twice as hard so that it stops within half a metre. */
const CART_BRAKE = 2 * P.CART_ACCEL
/** A cart that has delivered counts as stopped below this speed (then the next input makes him hop off). */
const CART_STOPPED = 0.3
/** Colliders are left with this much clearance so that a resolved circle never reads as touching. */
const SKIN = 1e-4
/** Penetration tolerated before a move is rejected. */
const PEN_TOLERANCE = 1e-3
const RESOLVE_PASSES = 16
/** See blockedSpeed(). */
const SLIDE_MIN = 0.35
/** At the work-area boundary the cart is only left behind when the input points at least this much west (fraction of its magnitude). */
const LEAVE_WEST = 0.2

export interface Mover {
  x: number
  z: number
  vx: number
  vz: number
  heading: number
}

const wrapAngle = (a: number) => (a > Math.PI ? a - TAU : a <= -Math.PI ? a + TAU : a)
const turnToward = (h: number, target: number, maxStep: number) => wrapAngle(h + clamp(angleDelta(h, target), -maxStep, maxStep))

// --- static collisions ---------------------------------------------------------------------------------------------

/**
 * One pass over the active static colliders for a circle of radius r at pos. Returns the deepest penetration
 * found; with `push` the circle is moved out of every collider it meets on the way.
 */
function scanColliders(s: GameState, pos: { x: number; z: number }, r: number, push: boolean): number {
  const u = s.unlocks
  let deepest = 0
  for (let i = 0; i < STATIC_COLLIDERS.length; i++) {
    const c = STATIC_COLLIDERS[i]!
    if (c.when && !c.when(u)) continue
    // q = closest point of the collider's core (circle centre, box, segment), R = distance to keep from it
    let qx: number
    let qz: number
    let R = r
    if (c.t === 'circle') {
      qx = c.x
      qz = c.z
      R += c.r
    } else if (c.t === 'box') {
      qx = clamp(pos.x, c.x0, c.x1)
      qz = clamp(pos.z, c.z0, c.z1)
      if (qx === pos.x && qz === pos.z) {
        // centre inside the box: leave through the nearest face
        const w = pos.x - c.x0
        const e = c.x1 - pos.x
        const n = pos.z - c.z0
        const so = c.z1 - pos.z
        const m = Math.min(w, e, n, so)
        if (m + r > deepest) deepest = m + r
        if (push) {
          if (m === w) pos.x = c.x0 - r - SKIN
          else if (m === e) pos.x = c.x1 + r + SKIN
          else if (m === n) pos.z = c.z0 - r - SKIN
          else pos.z = c.z1 + r + SKIN
        }
        continue
      }
    } else {
      const t = segT(pos.x, pos.z, c.ax, c.az, c.bx, c.bz)
      qx = c.ax + (c.bx - c.ax) * t
      qz = c.az + (c.bz - c.az) * t
      R += c.r
    }
    const dx = pos.x - qx
    const dz = pos.z - qz
    const d2 = dx * dx + dz * dz
    if (d2 >= R * R) continue
    const d = Math.sqrt(d2)
    if (R - d > deepest) deepest = R - d
    if (!push) continue
    if (d > 1e-9) {
      const k = (R + SKIN) / d
      pos.x = qx + dx * k
      pos.z = qz + dz * k
    } else {
      pos.x = qx + R + SKIN
    }
  }
  return deepest
}

/** How far a circle of radius r at pos sticks out of the walkable bounds; with `push` it is clamped back in. */
function scanBounds(pos: { x: number; z: number }, r: number, push: boolean): number {
  const b = L.BOUNDS
  const lx = Math.min(b.x0 + r, b.x1 - r)
  const hx = Math.max(b.x0 + r, b.x1 - r)
  const lz = Math.min(b.z0 + r, b.z1 - r)
  const hz = Math.max(b.z0 + r, b.z1 - r)
  const cx = clamp(pos.x, lx, hx)
  const cz = clamp(pos.z, lz, hz)
  const out = Math.max(Math.abs(pos.x - cx), Math.abs(pos.z - cz))
  if (push) {
    pos.x = cx
    pos.z = cz
  }
  return out
}

/** Push a circle of radius r out of every active static collider and the outer bounds; mutates and returns pos. */
export function resolveStatic(s: GameState, pos: { x: number; z: number }, r: number) {
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    const pen = scanColliders(s, pos, r, true)
    const out = scanBounds(pos, r, true)
    if (pen <= 0 && out <= 0) break
  }
  return pos
}

const _probe = { x: 0, z: 0 }

/** Deepest penetration of a circle into the active static colliders or beyond the bounds (0 = free). */
export function staticPenetration(s: GameState, x: number, z: number, r: number): number {
  _probe.x = x
  _probe.z = z
  return Math.max(scanColliders(s, _probe, r, false), scanBounds(_probe, r, false))
}

/**
 * Speed of a mover whose velocity is tied to its heading (scoop, cart) after an obstacle cut its step from `want`
 * to `got` metres. It cannot shed just the component into the obstacle the way a free walker does - re-projecting
 * that on the heading every step would bring it to a crawl - so it keeps its speed while it still makes half the
 * headway (a glancing contact: it slides along) and slows toward a stop as the contact gets head-on.
 * The limit is a speed (a fraction of `cruise` set by the contact angle alone), not a factor applied per step:
 * a factor would compound with the step count and make the slide depend on the frame rate.
 */
function blockedSpeed(speed: number, want: number, got: number, cruise: number): number {
  if (want <= 1e-9) return speed
  const made = got / want
  return made >= SLIDE_MIN ? speed : Math.min(speed, (cruise * made) / SLIDE_MIN)
}

/**
 * Resolve the doctor's body circle after a move that started at the valid position (x0, z0). A move that the
 * colliders cannot sort out (a wedge between two of them) is undone, so he is never left inside anything. With
 * `shed` the velocity loses its component into whatever stopped him. Returns true when a collider moved him.
 */
function collideBody(s: GameState, x0: number, z0: number, shed: boolean): boolean {
  const p = s.player
  const bx = p.x
  const bz = p.z
  resolveStatic(s, p, P.PLAYER_RADIUS)
  if (staticPenetration(s, p.x, p.z, P.PLAYER_RADIUS) > PEN_TOLERANCE && staticPenetration(s, x0, z0, P.PLAYER_RADIUS) <= PEN_TOLERANCE) {
    p.x = x0
    p.z = z0
    p.vx = 0
    p.vz = 0
    return true
  }
  const cx = p.x - bx
  const cz = p.z - bz
  const c = Math.hypot(cx, cz)
  if (c <= 1e-7) return false
  if (shed) {
    const vn = (p.vx * cx + p.vz * cz) / c
    if (vn < 0) {
      p.vx -= (vn * cx) / c
      p.vz -= (vn * cz) / c
    }
  }
  return true
}

const _body = { x: 0, z: 0 }

/**
 * The wagon body of every cart blocks the doctor on foot. Soft: the static colliders are resolved afterwards and
 * win. `shed` and the result are as for collideBody().
 */
function blockByCarts(s: GameState, shed: boolean): boolean {
  const p = s.player
  const R = P.CART_BODY_RADIUS + P.PLAYER_RADIUS
  let hit = false
  for (let i = 0; i < s.tools.length; i++) {
    const t = s.tools[i]!
    if (!t.exists || t.kind !== 'cart') continue
    cartBody(t, _body)
    let nx = p.x - _body.x
    let nz = p.z - _body.z
    const d2 = nx * nx + nz * nz
    if (d2 >= R * R) continue
    const d = Math.sqrt(d2)
    if (d > 1e-6) {
      nx /= d
      nz /= d
    } else {
      // dead centre: step out behind the cart
      nx = -Math.sin(t.heading)
      nz = -Math.cos(t.heading)
    }
    p.x = _body.x + nx * R
    p.z = _body.z + nz * R
    hit = true
    if (!shed) continue
    const vn = p.vx * nx + p.vz * nz
    if (vn < 0) {
      p.vx -= vn * nx
      p.vz -= vn * nz
    }
  }
  return hit
}

// --- cart kinematics -------------------------------------------------------------------------------------------------

/**
 * The cart mover proper. `minX` is the west edge of what the seat may drive to under its own power (the work-area
 * boundary for the doctor, -Infinity for the driver NPC): it cuts the step like a wall, before the wagon body is
 * resolved, so an obstacle may still squeeze the cart a little way across it - the obstacles always win, and the
 * cart is never held inside one. Returns true when the boundary cut the step.
 */
function moveCart(s: GameState, m: Mover, ix: number, iz: number, dt: number, minX: number): boolean {
  let mag = Math.hypot(ix, iz)
  if (!(mag >= INPUT_DEADZONE)) mag = 0 // also catches NaN
  else {
    m.heading = turnToward(m.heading, headingOf(ix, iz), P.CART_TURN_RATE * dt)
    if (mag > 1) mag = 1
  }
  const fx = Math.sin(m.heading)
  const fz = Math.cos(m.heading)
  let speed = Math.max(0, m.vx * fx + m.vz * fz)
  const target = P.CART_SPEED * mag
  speed = approach(speed, target, (target >= speed ? P.CART_ACCEL : CART_BRAKE) * dt)

  const x0 = m.x
  const z0 = m.z
  m.x += fx * speed * dt
  m.z += fz * speed * dt
  // a seat that an obstacle has already squeezed across the boundary is not pulled back, it just goes no further
  const limit = Math.min(x0, minX)
  const held = m.x < limit
  if (held) m.x = limit
  cartBody(m, _body)
  const bx = _body.x
  const bz = _body.z
  resolveStatic(s, _body, P.CART_BODY_RADIUS)
  const pushed = _body.x !== bx || _body.z !== bz
  if (pushed) {
    m.x += _body.x - bx
    m.z += _body.z - bz
  }
  if (held || pushed) speed = blockedSpeed(speed, speed * dt, Math.hypot(m.x - x0, m.z - z0), P.CART_SPEED)
  m.vx = fx * speed
  m.vz = fz * speed
  return held
}

/**
 * Cart kinematics for any driver (player or the driver NPC): heading turns toward (ix, iz) at CART_TURN_RATE,
 * velocity is always along the heading, accelerates at CART_ACCEL up to CART_SPEED * |input|, and the cart
 * body circle is resolved against the static colliders. (ix, iz) is a world-space direction, magnitude 0..1.
 */
export function stepCartMover(s: GameState, m: Mover, ix: number, iz: number, dt: number): void {
  moveCart(s, m, ix, iz, dt, -Infinity)
}

// --- the doctor ------------------------------------------------------------------------------------------------------

/** Start an emoji over the doctor; it becomes visible (and the 'emoji' event fires) after its delay. */
export function showEmoji(s: GameState, kind: 'scared' | 'happy') {
  s.player.emoji = kind
  s.player.emojiT = -(kind === 'scared' ? SCARED_DELAY : HAPPY_DELAY)
}

function stepEmoji(s: GameState, dt: number) {
  const p = s.player
  if (p.emoji === 'none') return
  const before = p.emojiT
  p.emojiT += dt
  if (before < 0 && p.emojiT >= 0) emit(s, { type: 'emoji', kind: p.emoji, who: 'player' })
  if (p.emojiT >= (p.emoji === 'scared' ? SCARED_TIME : HAPPY_TIME)) {
    p.emoji = 'none'
    p.emojiT = 0
  }
}

/** Another system may have taken or removed the tool he thinks he holds: fall back to walking. */
function checkHold(s: GameState) {
  const p = s.player
  if (p.mode === 'foot' && p.mountT <= 0) {
    p.tool = -1
    return
  }
  const t = s.tools[p.tool]
  const kind = p.mode === 'scoop' ? 'scoop' : 'cart'
  if (t && t.exists && t.holder === 'player' && t.kind === kind) return
  p.mode = 'foot'
  p.tool = -1
  p.mountT = 0
  p.dismountPending = false
}

/**
 * Displace the doctor (a bubble shoving him). No effect while he rides or hops; the static colliders win, and a
 * held tool follows.
 */
export function shovePlayer(s: GameState, dx: number, dz: number): void {
  const p = s.player
  if (p.mode === 'cart' || p.mountT > 0 || p.dismountT > 0) return
  const x0 = p.x
  const z0 = p.z
  p.x += dx
  p.z += dz
  if (p.mode === 'scoop' && p.x < P.WORK_AREA_MIN_X) p.x = P.WORK_AREA_MIN_X
  collideBody(s, x0, z0, p.mode === 'foot')
  syncHeldTool(s)
}

function steerFoot(s: GameState, ix: number, iz: number, mag: number, dt: number) {
  const p = s.player
  const dvx = ix * P.PLAYER_SPEED - p.vx
  const dvz = iz * P.PLAYER_SPEED - p.vz
  const dv = Math.hypot(dvx, dvz)
  if (dv > 1e-9) {
    // a change that takes speed away from the current motion is braking
    const braking = dvx * p.vx + dvz * p.vz < 0
    const k = Math.min(1, ((braking ? P.PLAYER_DECEL : P.PLAYER_ACCEL) * dt) / dv)
    p.vx += dvx * k
    p.vz += dvz * k
  }
  if (mag > 0) p.heading = turnToward(p.heading, headingOf(ix, iz), P.FOOT_TURN_RATE * dt)
}

function steerScoop(s: GameState, ix: number, iz: number, mag: number, dt: number) {
  const p = s.player
  if (mag > 0) p.heading = turnToward(p.heading, headingOf(ix, iz), P.SCOOP_TURN_RATE * dt)
  const fx = Math.sin(p.heading)
  const fz = Math.cos(p.heading)
  // SPEC 2.1: velocity = heading * speed * max(0.25, cos(angle between heading and input))
  const target = mag > 0 ? P.PLAYER_SPEED * mag * Math.max(0.25, (ix * fx + iz * fz) / mag) : 0
  let speed = Math.max(0, p.vx * fx + p.vz * fz)
  speed = approach(speed, target, (target >= speed ? P.PLAYER_ACCEL : P.PLAYER_DECEL) * dt)
  p.vx = fx * speed
  p.vz = fz * speed
}

/** Modes 'foot' and 'scoop'. */
function stepWalking(s: GameState, ix: number, iz: number, mag: number, dt: number) {
  const p = s.player
  if (p.mode === 'scoop') steerScoop(s, ix, iz, mag, dt)
  else steerFoot(s, ix, iz, mag, dt)

  const x0 = p.x
  const z0 = p.z
  p.x += p.vx * dt
  p.z += p.vz * dt
  if (p.pushedT > 0) {
    // the shove fades out over the PUSHED time
    const k = Math.min(1, p.pushedT / P.PUSHED_DURATION)
    p.x += p.pushVx * k * dt
    p.z += p.pushVz * k * dt
  }
  const tool = p.mode === 'scoop' ? s.tools[p.tool] : undefined
  let hit = blockByCarts(s, !tool)
  // SPEC 2.3: with a docked bubble the work-area boundary simply blocks him (like a wall: see blockedSpeed)
  if (tool && tool.bubble !== -1 && p.x < P.WORK_AREA_MIN_X) {
    p.x = P.WORK_AREA_MIN_X
    hit = true
  }
  if (collideBody(s, x0, z0, !tool)) hit = true
  if (hit && tool) {
    const speed = Math.hypot(p.vx, p.vz)
    if (speed > 1e-9) {
      const k = blockedSpeed(speed, speed * dt, Math.hypot(p.x - x0, p.z - z0), P.PLAYER_SPEED) / speed
      p.vx *= k
      p.vz *= k
    }
  }

  if (!tool) {
    tryGrab(s)
  } else if (p.x < P.WORK_AREA_MIN_X && tool.bubble === -1) {
    // SPEC 2.2: the tool is left at the boundary and the doctor walks on
    tool.x = P.WORK_AREA_MIN_X
    tool.z = p.z
    tool.heading = p.heading
    releaseTool(s, p.tool, ix, iz)
  } else {
    syncHeldTool(s)
  }
  p.odo += Math.hypot(p.x - x0, p.z - z0)
}

/** Mode 'cart'. */
function stepRiding(s: GameState, ix: number, iz: number, mag: number, dt: number) {
  const p = s.player
  const tool = s.tools[p.tool]!
  if (p.dismountPending && tool.bubble !== -1) p.dismountPending = false // caught another one: keep driving
  let held: boolean
  if (p.dismountPending) {
    held = moveCart(s, p, 0, 0, dt, P.WORK_AREA_MIN_X)
    if (mag > 0 && Math.hypot(p.vx, p.vz) <= CART_STOPPED) {
      syncHeldTool(s)
      releaseTool(s, p.tool, ix, iz)
      return
    }
  } else {
    held = moveCart(s, p, ix, iz, dt, P.WORK_AREA_MIN_X)
  }
  // SPEC 2.2: the cart is left at the boundary - but only when he steers west into it. A cart parked there points
  // west, and any input makes it roll along its heading: without this test he would be thrown off again on the
  // first step after every re-mount and the cart could never be driven away. For any other input the boundary
  // just blocks (as it does with a docked bubble, SPEC 2.3), and the cart turns until it points back in.
  if (held && tool.bubble === -1 && ix < -LEAVE_WEST * mag) {
    syncHeldTool(s)
    releaseTool(s, p.tool, ix, iz)
    return
  }
  syncHeldTool(s)
}

/** Hopping onto the bench: he reaches the seat exactly when mountT runs out, whatever dt is. */
function stepMounting(s: GameState, dt: number) {
  const p = s.player
  const tool = s.tools[p.tool]!
  const k = Math.min(1, dt / p.mountT)
  p.x += (tool.x - p.x) * k
  p.z += (tool.z - p.z) * k
  p.heading = wrapAngle(p.heading + angleDelta(p.heading, tool.heading) * k)
  p.vx = 0
  p.vz = 0
  p.mountT -= dt
  if (p.mountT <= 1e-9) {
    p.mountT = 0
    p.mode = 'cart'
    p.x = tool.x
    p.z = tool.z
    p.heading = tool.heading
  }
}

/** Hopping off: the velocity set by the hop carries him to the landing spot; the cart body does not block meanwhile. */
function stepDismounting(s: GameState, dt: number) {
  const p = s.player
  const x0 = p.x
  const z0 = p.z
  const h = Math.min(dt, p.dismountT)
  p.x += p.vx * h
  p.z += p.vz * h
  p.dismountT -= dt
  collideBody(s, x0, z0, false)
  if (p.dismountT <= 1e-9) {
    p.dismountT = 0
    p.vx = 0
    p.vz = 0
  }
}

export function stepPlayer(s: GameState, input: Input, dt: number) {
  const p = s.player
  let ix = input.mx
  let iz = input.mz
  let mag = Math.hypot(ix, iz)
  if (!(mag >= INPUT_DEADZONE)) {
    ix = 0
    iz = 0
    mag = 0
  } else if (mag > 1) {
    ix /= mag
    iz /= mag
    mag = 1
  }

  stepTools(s, dt)
  stepEmoji(s, dt)
  checkHold(s)

  const x0 = p.x
  const z0 = p.z
  if (p.mountT > 0) stepMounting(s, dt)
  else if (p.dismountT > 0) stepDismounting(s, dt)
  else if (p.mode === 'cart') stepRiding(s, ix, iz, mag, dt)
  else stepWalking(s, ix, iz, mag, dt)

  if (p.pushedT > 0) p.pushedT = Math.max(0, p.pushedT - dt)
  const speed = dt > 0 ? Math.hypot(p.x - x0, p.z - z0) / dt : 0
  p.stillT = speed < P.PAD_PAY_MAX_SPEED ? p.stillT + dt : 0
}
