// Small 2D math helpers. The simulation lives on the XZ ground plane: x = east, z = south.

export interface Vec2 {
  x: number
  z: number
}

export const TAU = Math.PI * 2

export const v2 = (x = 0, z = 0): Vec2 => ({ x, z })
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const invLerp = (a: number, b: number, v: number) => (a === b ? 0 : (v - a) / (b - a))
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01(invLerp(a, b, v))
  return t * t * (3 - 2 * t)
}
export const dist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(bx - ax, bz - az)
export const dist2 = (ax: number, az: number, bx: number, bz: number) => (bx - ax) * (bx - ax) + (bz - az) * (bz - az)
export const len = (x: number, z: number) => Math.hypot(x, z)

/** Exponential approach factor that is frame-rate independent: lerp(a, b, damp(rate, dt)). */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt)

/** Shortest signed difference between two angles (radians), result in (-PI, PI]. */
export const angleDelta = (from: number, to: number) => {
  let d = (to - from) % TAU
  if (d > Math.PI) d -= TAU
  if (d <= -Math.PI) d += TAU
  return d
}
export const lerpAngle = (a: number, b: number, t: number) => a + angleDelta(a, b) * t

/** Move `cur` toward `target` by at most `maxStep`. */
export const approach = (cur: number, target: number, maxStep: number) =>
  Math.abs(target - cur) <= maxStep ? target : cur + Math.sign(target - cur) * maxStep

/**
 * Heading convention used everywhere: heading h is the angle such that the forward
 * vector is (sin h, cos h) in (x, z). h = 0 faces +z (south, toward the camera),
 * h = PI/2 faces +x (east). This matches a three.js Object3D.rotation.y of h for a
 * model whose front faces +z.
 */
export const headingOf = (dx: number, dz: number) => Math.atan2(dx, dz)
export const fwdX = (h: number) => Math.sin(h)
export const fwdZ = (h: number) => Math.cos(h)

/** Rotate a local-space point (right = +x local, forward = +z local) by heading h into world space. */
export const rotX = (lx: number, lz: number, h: number) => lx * Math.cos(h) + lz * Math.sin(h)
export const rotZ = (lx: number, lz: number, h: number) => -lx * Math.sin(h) + lz * Math.cos(h)

/** Closest point parameter t in [0,1] of point p on segment ab. */
export const segT = (px: number, pz: number, ax: number, az: number, bx: number, bz: number) => {
  const abx = bx - ax
  const abz = bz - az
  const d = abx * abx + abz * abz
  if (d < 1e-12) return 0
  return clamp01(((px - ax) * abx + (pz - az) * abz) / d)
}

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3)
export const easeInCubic = (t: number) => Math.pow(clamp01(t), 3)
export const easeInOutQuad = (t: number) => {
  t = clamp01(t)
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}
export const easeOutBack = (t: number) => {
  t = clamp01(t)
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}
export const easeOutElastic = (t: number) => {
  t = clamp01(t)
  if (t === 0 || t === 1) return t
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1
}
