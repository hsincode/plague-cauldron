// Tool geometry shared by the simulation (blade collider) and the view (blade model must match).
// Local tool frame: origin = holder position (doctor's feet when holding the scoop, driver seat on the cart),
// +z local = forward (the direction the tool points), +x local = holder's left-hand side as seen from above
// with the heading convention of core/math.ts (world = rotX/rotZ(local, heading)).
import { P, type ToolKind } from '../config'

export interface BladeSpec {
  chord: number
  sagitta: number
  height: number
  /** Blade centre (deepest point of the concave face) ahead of the holder. */
  offset: number
  maxBubble: number
  grabRadius: number
  rearm: number
  /** Polyline of the blade in the local frame, from the left tip to the right tip, as [x0, z0, x1, z1, ...]. */
  poly: Float32Array
}

/**
 * The blade is a circular arc whose concave side faces forward (+z): the centre of the arc is the rearmost
 * point at z = offset, and the two tips are at x = +-chord/2, z = offset + sagitta.
 */
function makeBlade(chord: number, sagitta: number, height: number, offset: number, maxBubble: number, grabRadius: number, rearm: number, segments = 8): BladeSpec {
  const h = chord / 2
  const R = (h * h + sagitta * sagitta) / (2 * sagitta) // arc radius
  const half = Math.asin(h / R) // half opening angle
  const poly = new Float32Array((segments + 1) * 2)
  for (let i = 0; i <= segments; i++) {
    const a = -half + (2 * half * i) / segments
    poly[i * 2] = R * Math.sin(a)
    poly[i * 2 + 1] = offset + R - R * Math.cos(a)
  }
  return { chord, sagitta, height, offset, maxBubble, grabRadius, rearm, poly }
}

export const BLADES: Record<ToolKind, BladeSpec> = {
  scoop: makeBlade(P.SCOOP_CHORD, P.SCOOP_SAGITTA, P.SCOOP_HEIGHT, P.SCOOP_OFFSET, P.SCOOP_MAX_BUBBLE, P.SCOOP_GRAB_RADIUS, P.SCOOP_REARM_DISTANCE),
  cart: makeBlade(P.CART_CHORD, P.CART_SAGITTA, P.CART_HEIGHT, P.CART_BLADE_OFFSET, P.CART_MAX_BUBBLE, P.CART_GRAB_RADIUS, P.CART_REARM_DISTANCE),
}
