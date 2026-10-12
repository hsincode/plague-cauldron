// Shared helpers for anything that walks along waypoints (villagers, nurses, usher, porter).
import { headingOf, lerpAngle } from '../core/math'

export interface PathWalker {
  x: number
  z: number
  heading: number
  /** Waypoints as [x0, z0, x1, z1, ...]. */
  path: number[]
  /** Index (in points) of the next waypoint. */
  pathI: number
}

export const setPath = (w: PathWalker, pts: number[]) => {
  w.path = pts
  w.pathI = 0
}

export const pathDone = (w: PathWalker) => w.pathI * 2 >= w.path.length

/**
 * Advance along the path at `speed`. Returns true once the last waypoint is reached (and keeps returning true).
 * Faces the direction of travel (smoothed).
 */
export function followPath(w: PathWalker, speed: number, dt: number): boolean {
  let budget = speed * dt
  while (budget > 0 && w.pathI * 2 < w.path.length) {
    const tx = w.path[w.pathI * 2]!
    const tz = w.path[w.pathI * 2 + 1]!
    const dx = tx - w.x
    const dz = tz - w.z
    const d = Math.hypot(dx, dz)
    if (d > 1e-4) w.heading = lerpAngle(w.heading, headingOf(dx, dz), Math.min(1, dt * 18))
    if (d <= budget) {
      w.x = tx
      w.z = tz
      budget -= d
      w.pathI++
    } else {
      w.x += (dx / d) * budget
      w.z += (dz / d) * budget
      budget = 0
    }
  }
  return w.pathI * 2 >= w.path.length
}

/** Height of a parabolic hop at progress u (0..1) with the given apex height above the straight line. */
export const hopY = (u: number, apex: number) => 4 * apex * u * (1 - u)
