// Grinder (SPEC 2.4): takes a docked bubble off a tool, grinds it on a fixed timeline and ejects ground flasks.
import { L, P } from '../config'
import { TAU, clamp, dist2 } from '../core/math'
import { rand } from '../core/rng'
import { emit } from './events'
import { onBubbleDelivered } from './tools'
import type { Bubble, GameState } from './types'

/** s.groundFlasks never grows beyond this; the oldest flask on the ground is dropped first (instancing limit for the view). */
export const GROUND_FLASK_MAX = 200

const [X0, Z0, X1, Z1] = L.GRINDER
const TRAY_INSET = 0.5
const SPIN_IDLE = 0.5 * TAU
const SPIN_GRIND = 4 * TAU
// Landing spots: keep the flask centres a little inside the area and apart from each other.
const LAND_INSET = 0.15
const LAND_SPACING = 0.5
const LAND_TRIES = 64

export function stepGrinder(s: GameState, dt: number) {
  const g = s.grinder
  if (g.state === 'grinding') grind(s, dt)
  if (g.state === 'idle') accept(s)
  g.spin = (g.spin + (g.state === 'grinding' ? SPIN_GRIND : SPIN_IDLE) * dt) % TAU
}

/**
 * Rest coordinate on one axis of the tray. SPEC 2.3 shrinks the tray by 0.5 m, which would leave every bubble
 * hanging over the edge it came from. So the inset is the bubble's radius where that fits (the whole bubble lies
 * on the tray), and the bubble is centred on an axis it is wider than.
 */
function restOnTray(v: number, lo: number, hi: number, r: number): number {
  const inset = Math.max(TRAY_INSET, r)
  return inset * 2 >= hi - lo ? (lo + hi) / 2 : clamp(v, lo + inset, hi - inset)
}

function toolHolding(s: GameState, b: Bubble): number {
  if (b.tool >= 0) return b.tool
  for (let i = 0; i < s.tools.length; i++) if (s.tools[i]!.bubble === b.id) return i
  return -1
}

function accept(s: GameState) {
  const g = s.grinder
  const m = P.GRINDER_ACCEPT_MARGIN
  for (let i = 0; i < s.bubbles.length; i++) {
    const b = s.bubbles[i]!
    if (b.state !== 'docked') continue
    if (b.x < X0 - m || b.x > X1 + m || b.z < Z0 - m || b.z > Z1 + m) continue
    const tool = toolHolding(s, b)
    b.state = 'grinder'
    b.t = 0
    b.tool = -1
    b.vx = 0
    b.vz = 0
    if (tool >= 0) onBubbleDelivered(s, tool)
    g.state = 'grinding'
    g.t = -P.GRIND_SLIDE_TIME // negative while the bubble slides; the SPEC timeline starts at 0
    g.bubble = b.id
    g.size = b.size
    g.br = b.r
    g.bx = restOnTray(b.x, X0, X1, b.r)
    g.bz = restOnTray(b.z, Z0, Z1, b.r)
    g.toEject = 0
    g.ejectT = 0
    return
  }
}

function findBubble(s: GameState, id: number): Bubble | undefined {
  for (let i = 0; i < s.bubbles.length; i++) if (s.bubbles[i]!.id === id) return s.bubbles[i]
  return undefined
}

function removeBubble(s: GameState, id: number) {
  for (let i = 0; i < s.bubbles.length; i++) {
    const b = s.bubbles[i]!
    if (b.id !== id) continue
    b.state = 'gone'
    s.bubbles.splice(i, 1)
    return
  }
}

function grind(s: GameState, dt: number) {
  const g = s.grinder
  const prev = g.t
  g.t += dt
  if (prev < 0) {
    const b = findBubble(s, g.bubble)
    if (g.t < 0) {
      // Covering the fraction dt / timeLeft of the distance left is a constant-speed slide that needs no start point.
      if (b) {
        const k = dt / -prev
        b.x += (g.bx - b.x) * k
        b.z += (g.bz - b.z) * k
      }
      return
    }
    if (b) {
      b.x = g.bx
      b.z = g.bz
    }
    g.toEject = P.FLASK_YIELD[g.size] * P.GROUND_MESHES_PER_UNIT
    g.ejectT = P.FLASK_EJECT_START - g.t
    emit(s, { type: 'grindStart', x: g.bx, z: g.bz, r: g.br, size: g.size })
  } else {
    g.ejectT -= dt
  }
  if (prev < P.GRIND_CRACK && g.t >= P.GRIND_CRACK) emit(s, { type: 'grindCrack', x: g.bx, z: g.bz, r: g.br })
  if (prev < P.GRIND_SHELL && g.t >= P.GRIND_SHELL) emit(s, { type: 'grindShell', x: g.bx, z: g.bz, r: g.br })
  if (prev < P.GRIND_SHARDS && g.t >= P.GRIND_SHARDS) shatter(s)

  while (g.toEject > 0 && g.ejectT <= 0) {
    ejectFlask(s, -g.ejectT)
    g.toEject--
    if (g.toEject % P.GROUND_MESHES_PER_UNIT === 0) s.stats.flasksMade++
    g.ejectT += P.FLASK_EJECT_INTERVAL
  }
  // The tray is not free before the last flask is out, whatever the timing constants are.
  if (g.t >= P.GRIND_FREE && g.toEject === 0) {
    if (g.bubble >= 0) shatter(s)
    g.state = 'idle'
    g.t = 0
    g.ejectT = 0
    emit(s, { type: 'grindEnd' })
  }
}

function shatter(s: GameState) {
  const g = s.grinder
  removeBubble(s, g.bubble)
  g.bubble = -1
  emit(s, { type: 'grindShatter', x: g.bx, z: g.bz, r: g.br })
}

/** `late` = how long ago within this step the flask was due, so the cadence does not depend on dt. */
function ejectFlask(s: GameState, late: number) {
  const a = L.FLASK_AREA
  const fl = s.groundFlasks
  const w = a.w - LAND_INSET * 2
  const d = a.d - LAND_INSET * 2
  // Best-candidate sampling: the first spot that is clear of the pile, else the clearest one tried (a full area never stalls).
  let x: number = a.x
  let z: number = a.z
  let best = -1
  for (let k = 0; k < LAND_TRIES; k++) {
    const cx = a.x + (rand(s.rng) - 0.5) * w
    const cz = a.z + (rand(s.rng) - 0.5) * d
    let near = Infinity
    for (let i = 0; i < fl.length; i++) {
      const dd = dist2(cx, cz, fl[i]!.x, fl[i]!.z)
      if (dd < near) near = dd
    }
    if (near > best) {
      best = near
      x = cx
      z = cz
    }
    if (near >= LAND_SPACING * LAND_SPACING) break
  }
  // Out of the west long side, roughly level with the landing spot so that the hop stays short (0.8-2.2 m).
  const fromZ = clamp(z + (rand(s.rng) - 0.5) * 0.8, Z0 + 0.2, Z1 - 0.2)
  const id = s.nextId++
  fl.push({ id, x, z, fromX: X0, fromZ, age: late, rot: rand(s.rng) * TAU })
  if (fl.length > GROUND_FLASK_MAX) fl.shift()
  emit(s, { type: 'flaskEject', id, fromX: X0, fromZ, toX: x, toZ: z })
}
