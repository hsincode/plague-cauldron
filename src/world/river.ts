// River geometry shared by the simulation (flow field, bed test) and the view (river-bed mesh).
import { L, P } from '../config'
import { clamp01, lerp } from '../core/math'

const pts = L.RIVER
const segLen: number[] = []
const cum: number[] = [0]
for (let i = 0; i < pts.length - 1; i++) {
  const l = Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.z - pts[i]!.z)
  segLen.push(l)
  cum.push(cum[i]! + l)
}
export const RIVER_LENGTH = cum[cum.length - 1]!

export interface RiverSample {
  /** Arc length along the centreline from the north source (0) to the fall (RIVER_LENGTH). */
  s: number
  /** Progress 0..1 downstream. */
  p: number
  /** Signed lateral offset from the centreline; positive = right-hand side when looking downstream (west bank). */
  d: number
  /** Unit tangent (downstream direction). */
  tx: number
  tz: number
  /** Half width of the bed at this point. */
  halfW: number
}

const out: RiverSample = { s: 0, p: 0, d: 0, tx: 0, tz: 1, halfW: 3.2 }

/** Nearest-point query on the centreline. Returns a shared scratch object (copy what you need). */
export function riverSample(x: number, z: number): RiverSample {
  let best = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    const abx = b.x - a.x
    const abz = b.z - a.z
    const l = segLen[i]!
    let t = ((x - a.x) * abx + (z - a.z) * abz) / (l * l)
    // Extend the first/last segment so points beyond the ends still get a sensible sample.
    if (i > 0 && t < 0) t = 0
    if (i < pts.length - 2 && t > 1) t = 1
    const cx = a.x + abx * t
    const cz = a.z + abz * t
    const dx = x - cx
    const dz = z - cz
    const d2 = dx * dx + dz * dz
    if (d2 < best) {
      best = d2
      const tx = abx / l
      const tz = abz / l
      out.tx = tx
      out.tz = tz
      out.s = cum[i]! + t * l
      // right-hand normal of (tx, tz) looking downstream with +y up is (-tz, tx)
      out.d = dx * -tz + dz * tx
    }
  }
  out.p = clamp01(out.s / RIVER_LENGTH)
  out.halfW = lerp(L.RIVER_HALF_WIDTH_N, L.RIVER_HALF_WIDTH_S, out.p)
  return out
}

/** Point on the centreline at arc length s, offset laterally by d (same sign convention as RiverSample.d). */
export function riverPoint(s: number, d: number, target: { x: number; z: number } = { x: 0, z: 0 }) {
  let i = 0
  while (i < segLen.length - 1 && s > cum[i + 1]!) i++
  const a = pts[i]!
  const b = pts[i + 1]!
  const l = segLen[i]!
  const t = (s - cum[i]!) / l
  const tx = (b.x - a.x) / l
  const tz = (b.z - a.z) / l
  target.x = a.x + (b.x - a.x) * t - tz * d
  target.z = a.z + (b.z - a.z) * t + tx * d
  return target
}

/** Flow speed (m/s) of the small balls at lateral offset d and progress p (SPEC 2.3). */
export function flowSpeed(d: number, halfW: number, p: number): number {
  const u = clamp01(Math.abs(d) / halfW)
  const profile = 1 - u * u // parabolic: fastest mid-stream
  return lerp(P.FLOW_SPEED_BANK, P.FLOW_SPEED_MID, profile) * (1 + P.FLOW_DOWNSTREAM_GAIN * p)
}

export const inRiverBed = (x: number, z: number, margin = 0) => {
  const r = riverSample(x, z)
  return Math.abs(r.d) <= r.halfW + margin && z <= L.CLIFF_Z
}
