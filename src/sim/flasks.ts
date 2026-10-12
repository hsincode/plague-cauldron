// Flasks (SPEC 2.5, 2.6 deposit): the pile west of the grinder, the magnet pickup onto a carrier's back and the
// throw into the cauldron. pickupFlasks / depositFlasks are shared with the porter NPC (sim/helpers.ts).
import { L, P } from '../config'
import { dist2, fwdX, fwdZ, headingOf } from '../core/math'
import { emit } from './events'
import type { GameState } from './types'

const MESHES_PER_SECOND = P.FLASK_PICKUP_RATE * P.GROUND_MESHES_PER_UNIT
// Where the stack stands relative to its carrier (SPEC 2.1).
const STACK_BACK = 0.45
const STACK_BASE = 0.3
const STACK_SIDE = 0.3

/** Height of the bulb centre of the top flask of a stack of n: where a thrown flask starts ('flaskThrow'.fromY). */
export const stackTopY = (n: number) => STACK_BASE + Math.max(0, n - 1) * P.FLASK_STACK_PITCH + P.FLASK_BULB / 2

/** Flasks the pot can still take; flasks in flight already count. */
export const cauldronRoom = (s: GameState) => s.cauldron.capacity - s.cauldron.potion - s.cauldron.incoming.length

export function stepFlasks(s: GameState, dt: number) {
  const fl = s.groundFlasks
  for (let i = 0; i < fl.length; i++) fl[i]!.age += dt

  const c = s.cauldron
  c.sinceFill += dt
  // Land before throwing, so that a flask thrown in this step keeps its whole flight time.
  const inc = c.incoming
  let w = 0
  for (let i = 0; i < inc.length; i++) {
    const t = inc[i]! - dt
    if (t > 0) {
      inc[w++] = t
      continue
    }
    c.potion = Math.min(c.capacity, c.potion + 1)
    c.sinceFill = -t
    emit(s, { type: 'flaskLand', potion: c.potion })
  }
  inc.length = w

  pickupFlasks(s, s.player, P.FLASK_CARRY_MAX, 'player', dt)
  depositFlasks(s, s.player, 'player', dt)
}

/** Index of the nearest landed flask within the pickup radius, or -1. */
function nearestFlask(s: GameState, x: number, z: number): number {
  const fl = s.groundFlasks
  let best = -1
  let bestD = P.FLASK_PICKUP_RADIUS * P.FLASK_PICKUP_RADIUS
  for (let i = 0; i < fl.length; i++) {
    const f = fl[i]!
    if (f.age < P.FLASK_EJECT_FLIGHT) continue
    const d = dist2(x, z, f.x, f.z)
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * Magnet-collect ground flasks within FLASK_PICKUP_RADIUS of the carrier (nearest first) at FLASK_PICKUP_RATE
 * units/s, up to `max` carried units; two ground meshes make one unit. Returns true while anything is being collected.
 */
export function pickupFlasks(s: GameState, carrier: { x: number; z: number; flasks: number; pickupAcc: number }, max: number, by: 'player' | 'porter', dt: number): boolean {
  let near = carrier.flasks < max ? nearestFlask(s, carrier.x, carrier.z) : -1
  if (near < 0) {
    carrier.pickupAcc = 0 // no credit is saved up for the next pile
    return false
  }
  carrier.pickupAcc += MESHES_PER_SECOND * dt
  while (carrier.pickupAcc >= 1 && near >= 0) {
    const f = s.groundFlasks[near]!
    s.groundFlasks.splice(near, 1)
    carrier.pickupAcc -= 1
    // The half-unit parity is global: a mesh left over by one carrier completes a unit for the next.
    s.flaskHalf = (s.flaskHalf + 1) % P.GROUND_MESHES_PER_UNIT
    const unitAdded = s.flaskHalf === 0
    if (unitAdded) carrier.flasks++
    emit(s, { type: 'flaskPickup', fromX: f.x, fromZ: f.z, by, unitAdded })
    near = carrier.flasks < max ? nearestFlask(s, carrier.x, carrier.z) : -1
  }
  return true
}

/**
 * Throw flasks from the carrier into the cauldron when within DEPOSIT_RADIUS (DEPOSIT_DELAY, then one per
 * DEPOSIT_INTERVAL; flasks beyond capacity stay on the back). Returns true while a deposit is in progress
 * (the delay included). `heading` only places the 'flaskThrow' event behind the carrier's back.
 */
export function depositFlasks(s: GameState, carrier: { x: number; z: number; flasks: number; depositT: number; heading?: number }, by: 'player' | 'porter', dt: number): boolean {
  const c = s.cauldron
  let room = cauldronRoom(s)
  const inRange = dist2(carrier.x, carrier.z, L.CAULDRON.x, L.CAULDRON.z) <= P.DEPOSIT_RADIUS * P.DEPOSIT_RADIUS
  if (!inRange || carrier.flasks <= 0 || room <= 0) {
    carrier.depositT = P.DEPOSIT_DELAY // every new deposit starts with the delay
    return false
  }
  carrier.depositT -= dt
  while (carrier.depositT <= 0 && carrier.flasks > 0 && room > 0) {
    const h = carrier.heading ?? headingOf(L.CAULDRON.x - carrier.x, L.CAULDRON.z - carrier.z)
    // Beside a coin column the flask stack moves to the carrier's right (SPEC 2.1).
    const side = by === 'player' && s.player.carriedGold > 0 ? STACK_SIDE : 0
    emit(s, {
      type: 'flaskThrow',
      fromX: carrier.x - fwdX(h) * STACK_BACK - Math.cos(h) * side,
      fromZ: carrier.z - fwdZ(h) * STACK_BACK + Math.sin(h) * side,
      fromY: stackTopY(carrier.flasks),
      by,
    })
    carrier.flasks--
    room--
    // -depositT is how long ago within this step the flask was due.
    c.incoming.push(Math.max(1e-6, P.DEPOSIT_FLIGHT + carrier.depositT))
    carrier.depositT += P.DEPOSIT_INTERVAL
  }
  return true
}
