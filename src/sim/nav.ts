// Path planning for the autopilot (sim/bot.ts): the doctor on foot is a circle among the static colliders of
// world/colliders.ts. A visibility graph is built once per set of active colliders (yard props / ward-2 beds change
// with the 'ward2' unlock); a query adds the start, the goal and a ring of nodes around every moving obstacle.
import { L, P, type UnlockId } from '../config'
import { STATIC_COLLIDERS, type Collider } from '../world/colliders'

/** Clearance kept from every collider by the edges of the graph (the doctor's radius plus a little air). */
const CLEAR = P.PLAYER_RADIUS + 0.12
/** Nodes stand this far outside a collider's surface. */
const NODE_OUT = CLEAR + 0.2
/** The first and the last leg may graze: he often starts in contact with something and slides along it. */
const END_CLEAR = P.PLAYER_RADIUS - 0.12
/** Thin colliders (the pen pickets) bound an area he has no reason to walk round: no nodes for them. */
const MIN_NODE_SEG_R = 0.16
/** Longer edges are never the best way anywhere on this map. */
const MAX_EDGE = 26

/** A moving or temporary obstacle: the doctor's centre keeps `r` away from (x, z). */
export interface NavObstacle {
  x: number
  z: number
  r: number
}

interface Graph {
  cols: Collider[]
  n: number
  x: number[]
  z: number[]
  /** n * n visibility matrix. */
  los: Uint8Array
}

function pointSeg2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax
  const abz = bz - az
  const d = abx * abx + abz * abz
  let t = d > 1e-12 ? ((px - ax) * abx + (pz - az) * abz) / d : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = px - (ax + abx * t)
  const dz = pz - (az + abz * t)
  return dx * dx + dz * dz
}

const cross = (ax: number, az: number, bx: number, bz: number) => ax * bz - az * bx

function segSeg2(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  const d1 = cross(bx - ax, bz - az, cx - ax, cz - az)
  const d2 = cross(bx - ax, bz - az, dx - ax, dz - az)
  const d3 = cross(dx - cx, dz - cz, ax - cx, az - cz)
  const d4 = cross(dx - cx, dz - cz, bx - cx, bz - cz)
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0
  return Math.min(pointSeg2(ax, az, cx, cz, dx, dz), pointSeg2(bx, bz, cx, cz, dx, dz), pointSeg2(cx, cz, ax, az, bx, bz), pointSeg2(dx, dz, ax, az, bx, bz))
}

/** Segment a-b against an axis-aligned box (slab test). */
function segBox(ax: number, az: number, bx: number, bz: number, x0: number, z0: number, x1: number, z1: number): boolean {
  const dx = bx - ax
  const dz = bz - az
  let t0 = 0
  let t1 = 1
  if (Math.abs(dx) < 1e-9) {
    if (ax <= x0 || ax >= x1) return false
  } else {
    const ta = (x0 - ax) / dx
    const tb = (x1 - ax) / dx
    t0 = Math.max(t0, Math.min(ta, tb))
    t1 = Math.min(t1, Math.max(ta, tb))
  }
  if (Math.abs(dz) < 1e-9) {
    if (az <= z0 || az >= z1) return false
  } else {
    const ta = (z0 - az) / dz
    const tb = (z1 - az) / dz
    t0 = Math.max(t0, Math.min(ta, tb))
    t1 = Math.min(t1, Math.max(ta, tb))
  }
  return t0 < t1
}

/** True when the segment a-b comes closer than r to the collider. A box is grown squarely (conservative at its corners). */
function edgeHits(c: Collider, ax: number, az: number, bx: number, bz: number, r: number): boolean {
  if (c.t === 'circle') {
    const R = c.r + r
    return pointSeg2(c.x, c.z, ax, az, bx, bz) < R * R
  }
  if (c.t === 'box') return segBox(ax, az, bx, bz, c.x0 - r, c.z0 - r, c.x1 + r, c.z1 + r)
  const R = c.r + r
  return segSeg2(ax, az, bx, bz, c.ax, c.az, c.bx, c.bz) < R * R
}

function pointHits(c: Collider, x: number, z: number, r: number): boolean {
  if (c.t === 'circle') {
    const R = c.r + r
    return (x - c.x) * (x - c.x) + (z - c.z) * (z - c.z) < R * R
  }
  if (c.t === 'box') return x > c.x0 - r && x < c.x1 + r && z > c.z0 - r && z < c.z1 + r
  const R = c.r + r
  return pointSeg2(x, z, c.ax, c.az, c.bx, c.bz) < R * R
}

const inBounds = (x: number, z: number, r: number) => {
  const b = L.BOUNDS
  return x >= b.x0 + r && x <= b.x1 - r && z >= b.z0 + r && z <= b.z1 - r
}

function blocked(cols: readonly Collider[], ax: number, az: number, bx: number, bz: number, r: number): boolean {
  for (let i = 0; i < cols.length; i++) if (edgeHits(cols[i]!, ax, az, bx, bz, r)) return true
  return false
}

function buildGraph(cols: Collider[]): Graph {
  const x: number[] = []
  const z: number[] = []
  const add = (nx: number, nz: number) => {
    if (!inBounds(nx, nz, CLEAR)) return
    for (let i = 0; i < cols.length; i++) if (pointHits(cols[i]!, nx, nz, CLEAR + 1e-3)) return
    x.push(nx)
    z.push(nz)
  }
  for (const c of cols) {
    if (c.t === 'circle') {
      const k = c.r < 0.8 ? 6 : c.r < 1.6 ? 8 : 12
      const rad = (c.r + NODE_OUT) / Math.cos(Math.PI / k)
      for (let i = 0; i < k; i++) {
        const a = ((i + 0.5) / k) * Math.PI * 2
        add(c.x + Math.cos(a) * rad, c.z + Math.sin(a) * rad)
      }
    } else if (c.t === 'box') {
      add(c.x0 - NODE_OUT, c.z0 - NODE_OUT)
      add(c.x1 + NODE_OUT, c.z0 - NODE_OUT)
      add(c.x1 + NODE_OUT, c.z1 + NODE_OUT)
      add(c.x0 - NODE_OUT, c.z1 + NODE_OUT)
    } else if (c.r >= MIN_NODE_SEG_R) {
      const len = Math.hypot(c.bx - c.ax, c.bz - c.az) || 1
      const ux = (c.bx - c.ax) / len
      const uz = (c.bz - c.az) / len
      const o = c.r + NODE_OUT
      for (const end of [-1, 1]) {
        const ex = end < 0 ? c.ax : c.bx
        const ez = end < 0 ? c.az : c.bz
        for (const side of [-1, 1]) add(ex + ux * o * end - uz * o * side, ez + uz * o * end + ux * o * side)
      }
    }
  }
  const n = x.length
  const los = new Uint8Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.hypot(x[j]! - x[i]!, z[j]! - z[i]!) > MAX_EDGE) continue
      if (blocked(cols, x[i]!, z[i]!, x[j]!, z[j]!, CLEAR)) continue
      los[i * n + j] = 1
      los[j * n + i] = 1
    }
  }
  return { cols, n, x, z, los }
}

const graphs = new Map<string, Graph>()

function graphFor(unlocks: Record<UnlockId, boolean>): Graph {
  let key = ''
  for (let i = 0; i < STATIC_COLLIDERS.length; i++) {
    const c = STATIC_COLLIDERS[i]!
    if (c.when) key += c.when(unlocks) ? '1' : '0'
  }
  let g = graphs.get(key)
  if (!g) {
    g = buildGraph(STATIC_COLLIDERS.filter(c => !c.when || c.when(unlocks)))
    graphs.set(key, g)
  }
  return g
}

// Scratch of a query: nodes = [graph nodes..., ring nodes of the obstacles..., start, goal].
let qx = new Float64Array(0)
let qz = new Float64Array(0)
let qd = new Float64Array(0)
let qprev = new Int32Array(0)
let qdone = new Uint8Array(0)
const obsR: number[] = []
const RING = 8

function ensure(n: number) {
  if (qx.length >= n) return
  qx = new Float64Array(n)
  qz = new Float64Array(n)
  qd = new Float64Array(n)
  qprev = new Int32Array(n)
  qdone = new Uint8Array(n)
}

function hitsObstacle(obstacles: readonly NavObstacle[], ax: number, az: number, bx: number, bz: number): boolean {
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i]!
    const R = obsR[i]!
    if (R > 0 && pointSeg2(o.x, o.z, ax, az, bx, bz) < R * R) return true
  }
  return false
}

/** True when the doctor can walk the straight line a-b (static colliders at `r`, obstacles at their own radius). */
export function lineClear(unlocks: Record<UnlockId, boolean>, ax: number, az: number, bx: number, bz: number, obstacles: readonly NavObstacle[] = [], r = CLEAR): boolean {
  const g = graphFor(unlocks)
  if (blocked(g.cols, ax, az, bx, bz, r)) return false
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i]!
    if (pointSeg2(o.x, o.z, ax, az, bx, bz) < o.r * o.r) return false
  }
  return true
}

/** True when a circle of radius r at (x, z) is clear of every active static collider and inside the bounds. */
export function pointClear(unlocks: Record<UnlockId, boolean>, x: number, z: number, r: number = CLEAR): boolean {
  if (!inBounds(x, z, r)) return false
  const cols = graphFor(unlocks).cols
  for (let i = 0; i < cols.length; i++) if (pointHits(cols[i]!, x, z, r)) return false
  return true
}

/**
 * Shortest way from (sx, sz) to (gx, gz) for the doctor's body. Writes the way-points after the start, the goal
 * last, into `out` as [x0, z0, ...]. Returns false when no way was found (then `out` holds just the goal).
 */
export function findPath(unlocks: Record<UnlockId, boolean>, sx: number, sz: number, gx: number, gz: number, obstacles: readonly NavObstacle[], out: number[]): boolean {
  const g = graphFor(unlocks)
  out.length = 0
  // An obstacle that already contains the start or the goal only counts as far as they are from its centre.
  obsR.length = 0
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i]!
    const ds = Math.hypot(sx - o.x, sz - o.z) - 0.05
    const dg = Math.hypot(gx - o.x, gz - o.z) - 0.05
    obsR.push(Math.max(0, Math.min(o.r, ds, dg)))
  }
  if (!blocked(g.cols, sx, sz, gx, gz, END_CLEAR) && !hitsObstacle(obstacles, sx, sz, gx, gz)) {
    out.push(gx, gz)
    return true
  }

  const n0 = g.n
  let n = n0
  ensure(n0 + obstacles.length * RING + 2)
  for (let i = 0; i < n0; i++) {
    qx[i] = g.x[i]!
    qz[i] = g.z[i]!
  }
  for (let k = 0; k < obstacles.length; k++) {
    const o = obstacles[k]!
    const rad = (o.r + 0.2) / Math.cos(Math.PI / RING)
    for (let i = 0; i < RING; i++) {
      const a = ((i + 0.5) / RING) * Math.PI * 2
      const nx = o.x + Math.cos(a) * rad
      const nz = o.z + Math.sin(a) * rad
      if (!inBounds(nx, nz, CLEAR)) continue
      let ok = true
      for (let c = 0; c < g.cols.length && ok; c++) if (pointHits(g.cols[c]!, nx, nz, CLEAR)) ok = false
      for (let j = 0; j < obstacles.length && ok; j++) if (j !== k && Math.hypot(nx - obstacles[j]!.x, nz - obstacles[j]!.z) < obstacles[j]!.r) ok = false
      if (!ok) continue
      qx[n] = nx
      qz[n] = nz
      n++
    }
  }
  const S = n
  const G = n + 1
  qx[S] = sx
  qz[S] = sz
  qx[G] = gx
  qz[G] = gz
  n += 2
  for (let i = 0; i < n; i++) {
    qd[i] = Infinity
    qprev[i] = -1
    qdone[i] = 0
  }
  qd[S] = 0
  const dyn = obstacles.length > 0
  for (;;) {
    let u = -1
    let best = Infinity
    for (let i = 0; i < n; i++) {
      if (!qdone[i] && qd[i]! < best) {
        best = qd[i]!
        u = i
      }
    }
    if (u < 0 || u === G) break
    qdone[u] = 1
    const ux = qx[u]!
    const uz = qz[u]!
    for (let v = 0; v < n; v++) {
      if (qdone[v] || v === u) continue
      const vx = qx[v]!
      const vz = qz[v]!
      const w = Math.hypot(vx - ux, vz - uz)
      const nd = best + w
      if (nd >= qd[v]! || w > MAX_EDGE) continue
      // visibility: precomputed between graph nodes, tested on demand for everything else
      if (u < n0 && v < n0) {
        if (!g.los[u * n0 + v]) continue
      } else if (blocked(g.cols, ux, uz, vx, vz, u >= S || v >= S ? END_CLEAR : CLEAR)) continue
      if (dyn && hitsObstacle(obstacles, ux, uz, vx, vz)) continue
      qd[v] = nd
      qprev[v] = u
    }
  }
  if (qprev[G] < 0) {
    out.push(gx, gz)
    return false
  }
  let count = 0
  for (let v = G; v !== S; v = qprev[v]!) count++
  out.length = count * 2
  let w = count
  for (let v = G; v !== S; v = qprev[v]!) {
    w--
    out[w * 2] = qx[v]!
    out[w * 2 + 1] = qz[v]!
  }
  return true
}
