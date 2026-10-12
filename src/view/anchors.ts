// Attachment points shared between view modules, so that e.g. the flask stack (riverView) and the coin column
// (coinsView) sit exactly on the doctor that actorsView draws without those modules importing each other.
//
// main.ts fills in the state-derived defaults every frame before any view runs; actorsView (which runs before the
// river / drill / coins views) then overwrites them with the true world positions of its animated models (bob, hop,
// seat, lean). A consumer therefore just reads ctx.anchors in update() and works whether or not actorsView is loaded.
import * as THREE from 'three'
import type { GameState } from '../sim/types'

export interface Anchors {
  /** Foot of the stack(s) carried behind the doctor: centred behind his back (SPEC 2.1: 0.45 m behind, 0.3 m up). */
  playerBack: THREE.Vector3
  /** Heading the stacks should face (the doctor's visual heading). */
  playerHeading: number
  /** Forward lean of the doctor's body in radians (stacks may add their own sway on top). */
  playerLean: number
  /** Top of the doctor's hat (emoji / pickup streak targets). */
  playerHead: THREE.Vector3
  /** Foot of the flask stack the porter carries, and his heading. */
  porterCarry: THREE.Vector3
  porterHeading: number
}

export function createAnchors(): Anchors {
  return {
    playerBack: new THREE.Vector3(),
    playerHeading: 0,
    playerLean: 0,
    playerHead: new THREE.Vector3(),
    porterCarry: new THREE.Vector3(),
    porterHeading: 0,
  }
}

const SEAT = 0.95 // models/tools.ts CART_SEAT_HEIGHT

/** State-only fallback (no models needed). */
export function defaultAnchors(a: Anchors, s: GameState) {
  const p = s.player
  const lift = p.mode === 'cart' && p.mountT <= 0 ? SEAT : 0
  const sh = Math.sin(p.heading)
  const ch = Math.cos(p.heading)
  a.playerBack.set(p.x - sh * 0.45, 0.3 + lift, p.z - ch * 0.45)
  a.playerHead.set(p.x, 2.35 + lift, p.z)
  a.playerHeading = p.heading
  a.playerLean = 0
  const o = s.porter
  a.porterCarry.set(o.x - Math.sin(o.heading) * 0.4, 0.3, o.z - Math.cos(o.heading) * 0.4)
  a.porterHeading = o.heading
}

/**
 * Sideways offsets (metres toward the carrier's RIGHT) of the two stacks: when the doctor carries both flasks and
 * coins the flasks stand 0.3 m to his right and the coins 0.3 m to his left, otherwise the stack is centred (SPEC 2.1).
 */
export function stackSides(s: GameState): { flask: number; coin: number } {
  const both = s.player.flasks > 0 && s.player.carriedGold > 0
  SIDES.flask = both ? 0.3 : 0
  SIDES.coin = both ? -0.3 : 0
  return SIDES
}
const SIDES = { flask: 0, coin: 0 }

/** out = anchor + right(heading) * side. With forward = (sin h, cos h) the right-hand side is (-cos h, sin h). */
export function offsetRight(anchor: THREE.Vector3, heading: number, side: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(anchor.x - Math.cos(heading) * side, anchor.y, anchor.z + Math.sin(heading) * side)
}
