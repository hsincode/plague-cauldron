// Tools (SPEC 2.2): the hand scoop and the cart. Blade geometry helpers, grab / park / re-arm, the 'cart' unlock.
// Movement while a tool is held lives in player.ts; what the blade does to balls and bubbles lives in river.ts.
import { P, type ToolKind } from '../config'
import { dist2 } from '../core/math'
import { BLADES } from '../world/tools'
import { emit } from './events'
import { resolveStatic, staticPenetration } from './player'
import type { Bubble, GameState, Tool } from './types'

/**
 * The blade as the circular arc that BLADES[kind].poly samples (see world/tools.ts makeBlade), in the tool's local
 * frame. Collision code works on the arc itself: "which side of the blade" is then just a radius comparison.
 */
export interface BladeArc {
  /** Arc radius. */
  R: number
  /** Local z of the centre of curvature (on the tool axis, ahead of the blade). */
  cz: number
  /** cos of the half opening angle. */
  cosHalf: number
  /** Tips at (+-tipX, tipZ). */
  tipX: number
  tipZ: number
}

function makeArc(kind: ToolKind): BladeArc {
  const b = BLADES[kind]
  const h = b.chord / 2
  const R = (h * h + b.sagitta * b.sagitta) / (2 * b.sagitta)
  return { R, cz: b.offset + R, cosHalf: (R - b.sagitta) / R, tipX: h, tipZ: b.offset + b.sagitta }
}

export const BLADE_ARCS: Record<ToolKind, BladeArc> = { scoop: makeArc('scoop'), cart: makeArc('cart') }

/** Blade polyline of `kind` at an arbitrary pose, as [x0, z0, ...]. */
export function bladeAt(kind: ToolKind, x: number, z: number, heading: number, out: Float32Array): Float32Array {
  const poly = BLADES[kind].poly
  const c = Math.cos(heading)
  const s = Math.sin(heading)
  for (let i = 0; i < poly.length; i += 2) {
    const lx = poly[i]!
    const lz = poly[i + 1]!
    out[i] = x + lx * c + lz * s
    out[i + 1] = z - lx * s + lz * c
  }
  return out
}

/** World-space polyline of the tool's blade as [x0, z0, ...] (same point count as BLADES[kind].poly). */
export function bladeWorld(tool: Tool, out: Float32Array = new Float32Array(18)): Float32Array {
  return bladeAt(tool.kind, tool.x, tool.z, tool.heading, out)
}

/** World position of the blade centre (deepest point of the concave face). */
export function bladeCenter(tool: Tool, out: { x: number; z: number } = { x: 0, z: 0 }) {
  const o = BLADES[tool.kind].offset
  out.x = tool.x + Math.sin(tool.heading) * o
  out.z = tool.z + Math.cos(tool.heading) * o
  return out
}

/** Where the centre of a docked bubble of radius r sits (SPEC 2.3: blade centre + forward * DOCK_SEAT * r). */
export function dockSeat(tool: Tool, r: number, out: { x: number; z: number } = { x: 0, z: 0 }) {
  const o = BLADES[tool.kind].offset + P.DOCK_SEAT * r
  out.x = tool.x + Math.sin(tool.heading) * o
  out.z = tool.z + Math.cos(tool.heading) * o
  return out
}

/** Centre of a cart's wagon body circle. */
export function cartBody(tool: { x: number; z: number; heading: number }, out: { x: number; z: number } = { x: 0, z: 0 }) {
  out.x = tool.x + Math.sin(tool.heading) * P.CART_BODY_OFFSET
  out.z = tool.z + Math.cos(tool.heading) * P.CART_BODY_OFFSET
  return out
}

export function findBubble(s: GameState, id: number): Bubble | undefined {
  if (id < 0) return undefined
  for (let i = 0; i < s.bubbles.length; i++) if (s.bubbles[i]!.id === id) return s.bubbles[i]
  return undefined
}

/** The tool's socket jumped (grab, swap): let its bubble slide to the new seat instead of teleporting. */
function reseat(s: GameState, tool: Tool) {
  const b = findBubble(s, tool.bubble)
  if (b && (b.state === 'docked' || b.state === 'docking')) {
    b.state = 'docking'
    b.t = 0
  }
}

// --- parking -----------------------------------------------------------------------------------------------------

/** How far from the seat the doctor lands when he hops off: clear of the wagon body (1.3 + 0.4 from its centre). */
const HOP_SIDE = 1.15
const HOP_BACK = 1.1
const HOP_CLEAR = 0.02

/** Start the hop off the cart: to the side the player steers toward if it is free, else the other side, else behind. */
function hopOff(s: GameState, tool: Tool, prefX: number, prefZ: number) {
  const p = s.player
  const c = Math.cos(tool.heading)
  const sn = Math.sin(tool.heading)
  // local +x (the holder's left) is (c, -sn) in the world
  const side = prefX * c - prefZ * sn >= 0 ? 1 : -1
  let tx = tool.x + c * side * HOP_SIDE
  let tz = tool.z - sn * side * HOP_SIDE
  if (staticPenetration(s, tx, tz, P.PLAYER_RADIUS) > HOP_CLEAR) {
    const ox = tool.x - c * side * HOP_SIDE
    const oz = tool.z + sn * side * HOP_SIDE
    const bx = tool.x - sn * HOP_BACK
    const bz = tool.z - c * HOP_BACK
    if (staticPenetration(s, ox, oz, P.PLAYER_RADIUS) <= HOP_CLEAR) {
      tx = ox
      tz = oz
    } else if (staticPenetration(s, bx, bz, P.PLAYER_RADIUS) <= HOP_CLEAR) {
      tx = bx
      tz = bz
    }
    // all three blocked: keep the first choice, the static colliders sort it out during the hop
  }
  p.x = tool.x
  p.z = tool.z
  p.vx = (tx - tool.x) / P.CART_DISMOUNT_TIME
  p.vz = (tz - tool.z) / P.CART_DISMOUNT_TIME
  p.dismountT = P.CART_DISMOUNT_TIME
  emit(s, { type: 'cartDismount' })
}

/** parkTool with a preferred hop-off direction (world space; (0, 0) = no preference). */
export function releaseTool(s: GameState, toolIdx: number, prefX: number, prefZ: number): void {
  const tool = s.tools[toolIdx]
  if (!tool) return
  const p = s.player
  const byPlayer = p.tool === toolIdx
  const wasHeld = tool.holder !== 'none' || byPlayer
  tool.holder = 'none'
  tool.armed = false
  if (byPlayer) {
    if (p.mode === 'cart') hopOff(s, tool, prefX, prefZ)
    p.mode = 'foot'
    p.tool = -1
    p.mountT = 0
    p.dismountPending = false
  }
  if (wasHeld) emit(s, { type: 'toolPark', tool: toolIdx, kind: tool.kind, x: tool.x, z: tool.z })
}

/** Let go of a tool wherever it is: holder -> 'none', armed -> false. If the player held it, the player returns to 'foot' (hopping off a cart). */
export function parkTool(s: GameState, toolIdx: number): void {
  releaseTool(s, toolIdx, 0, 0)
}

const SCOOP_BACK_OFF = 0.3
const _pos = { x: 0, z: 0 }

/**
 * Called by the grinder at the moment it takes the docked bubble off a tool. Clears tool.bubble and applies
 * SPEC 2.2: the hand scoop backs off 0.3 m and is parked; a cart driven by the player is parked on the first
 * movement input afterwards; a cart driven by the driver NPC stays held (helpers.ts decides what to do next).
 */
export function onBubbleDelivered(s: GameState, toolIdx: number): void {
  const tool = s.tools[toolIdx]
  if (!tool) return
  const b = findBubble(s, tool.bubble)
  if (b && b.tool === toolIdx) b.tool = -1
  tool.bubble = -1
  const p = s.player
  const byPlayer = tool.holder === 'player' && p.tool === toolIdx
  if (tool.kind === 'scoop') {
    const bx = -Math.sin(tool.heading) * SCOOP_BACK_OFF
    const bz = -Math.cos(tool.heading) * SCOOP_BACK_OFF
    if (byPlayer && p.mode === 'scoop') {
      // the doctor stays at the handle, so he steps back with it (never into a wall)
      _pos.x = p.x + bx
      _pos.z = p.z + bz
      resolveStatic(s, _pos, P.PLAYER_RADIUS)
      if (staticPenetration(s, _pos.x, _pos.z, P.PLAYER_RADIUS) <= HOP_CLEAR) {
        p.x = _pos.x
        p.z = _pos.z
      }
      tool.x = p.x
      tool.z = p.z
    } else {
      tool.x += bx
      tool.z += bz
    }
    parkTool(s, toolIdx)
  } else if (byPlayer) {
    p.dismountPending = true
  }
}

// --- per-step housekeeping (called by stepPlayer) ------------------------------------------------------------------

/** Unlock 'cart' (SPEC 2.2): tools[0] turns from the hand scoop into the cart, at the scoop's pose. */
function swapToCart(s: GameState, idx: number) {
  const tool = s.tools[idx]!
  if (tool.holder === 'player' || s.player.tool === idx) parkTool(s, idx) // he lets go first
  tool.kind = 'cart'
  tool.exists = true
  tool.age = 0
  // The wagon body should not materialise inside the grinder or a boulder: slide the whole cart out of them.
  cartBody(tool, _pos)
  const bx = _pos.x
  const bz = _pos.z
  resolveStatic(s, _pos, P.CART_BODY_RADIUS)
  tool.x += _pos.x - bx
  tool.z += _pos.z - bz
  if (tool.x < P.WORK_AREA_MIN_X) tool.x = P.WORK_AREA_MIN_X
  reseat(s, tool)
  emit(s, { type: 'toolSwap', tool: idx, kind: 'cart', x: tool.x, z: tool.z })
}

/** Ages, the 'cart' unlock and re-arming by distance. */
export function stepTools(s: GameState, dt: number): void {
  const p = s.player
  const primary = s.tools[0]
  if (primary && s.unlocks.cart && primary.kind === 'scoop') swapToCart(s, 0)
  for (let i = 0; i < s.tools.length; i++) {
    const t = s.tools[i]!
    if (!t.exists) continue
    t.age += dt
    if (t.holder === 'none' && !t.armed) {
      const far = BLADES[t.kind].rearm
      if (dist2(p.x, p.z, t.x, t.z) > far * far) t.armed = true
    }
  }
}

/** On foot: take the nearest parked, armed tool within its grab radius. */
export function tryGrab(s: GameState): void {
  const p = s.player
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < s.tools.length; i++) {
    const t = s.tools[i]!
    if (!t.exists || t.holder !== 'none' || !t.armed) continue
    // a scoop grabbed outside the work area would be dropped again at once
    if (t.kind === 'scoop' && p.x < P.WORK_AREA_MIN_X) continue
    const g = BLADES[t.kind].grabRadius
    const d = dist2(p.x, p.z, t.x, t.z)
    if (d <= g * g && d < bestD) {
      best = i
      bestD = d
    }
  }
  if (best < 0) return
  const t = s.tools[best]!
  t.holder = 'player'
  t.armed = false
  p.tool = best
  p.dismountPending = false
  emit(s, { type: 'toolGrab', tool: best, kind: t.kind })
  if (t.kind === 'scoop') {
    // The scoop jumps into his hands: his own motion stays continuous, which is what the player feels.
    p.mode = 'scoop'
    t.x = p.x
    t.z = p.z
    t.heading = p.heading
    reseat(s, t)
  } else {
    p.mountT = P.CART_MOUNT_TIME
    p.vx = 0
    p.vz = 0
    emit(s, { type: 'cartMount' })
  }
}

/** While a tool is held its pose is the player's pose. */
export function syncHeldTool(s: GameState): void {
  const p = s.player
  if (p.mode === 'foot') return
  const t = s.tools[p.tool]
  if (!t) return
  t.x = p.x
  t.z = p.z
  t.heading = p.heading
}
