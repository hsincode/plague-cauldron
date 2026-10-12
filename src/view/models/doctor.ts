// The plague doctor (player) plus the small "character kit" shared by villager.ts, staff.ts and rat.ts:
// vertex-coloured primitive builders (one shared material for every character), a deformable skirt,
// two-bone arm IK and a few canvas textures. Everything is procedural (SPEC 7.4, art.md 2.1).
import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { P, PAL } from '../../config'
import { angleDelta, clamp, clamp01, damp, lerp } from '../../core/math'
import { blobShadow, lam, unlit, type GalleryItem } from '../materials'

// =====================================================================================================
// Character kit
// =====================================================================================================

export const DEG = Math.PI / 180
export const TAU = Math.PI * 2

const _c = new THREE.Color()

/** Multiply the brightness of an sRGB hex colour. */
export function tone(hex: number, k: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k))
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k))
  const b = Math.min(255, Math.round((hex & 255) * k))
  return (r << 16) | (g << 8) | b
}

/** Mix two sRGB hex colours. */
export function mixHex(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(lerp((a >> s) & 255, (b >> s) & 255, t))
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** The one material every character part uses: matte Lambert, colours baked into vertex colours. */
export const charMat = () => lam(0xffffff, { vertexColors: true, flat: false })
/** Same, double-sided (skirts, hair shells, thin cloth). */
export const charMat2 = () => lam(0xffffff, { vertexColors: true, flat: false, side: THREE.DoubleSide })

export type QuadColor = number | ((ring: number, seg: number) => number)
export type Profile = readonly (readonly [number, number])[]

function finish(pos: number[], nor: number[], col: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  return g
}

/**
 * Surface of revolution about +y from a profile of [radius, y] points (any order; it is sorted bottom-up).
 * Angle 0 is the front (+z) and grows toward the figure's left (+x). Each quad gets one flat colour from
 * `col(ring, seg)` (ring 0 = lowest), normals are smooth; repeat a profile point to get a hard crease.
 * `sx`/`sz` squash the cross-section; `a0..a1` revolve only part of the way round.
 */
export function rev(profile: Profile, segs: number, col: QuadColor, sx = 1, sz = 1, a0 = 0, a1 = TAU): THREE.BufferGeometry {
  const pts = profile[0]![1] <= profile[profile.length - 1]![1] ? profile : [...profile].reverse()
  const n = pts.length
  const nr: number[] = []
  const ny: number[] = []
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]!
    const b = pts[Math.min(n - 1, i + 1)]!
    const tr = b[0] - a[0]
    const ty = b[1] - a[1]
    const l = Math.hypot(tr, ty) || 1
    nr.push(ty / l)
    ny.push(-tr / l)
  }
  const pos: number[] = []
  const nor: number[] = []
  const colr: number[] = []
  const vert = (i: number, ang: number) => {
    const s = Math.sin(ang)
    const c = Math.cos(ang)
    const r = pts[i]![0]
    pos.push(r * s * sx, pts[i]![1], r * c * sz)
    const x = (nr[i]! * s) / sx
    const y = ny[i]!
    const z = (nr[i]! * c) / sz
    const l = Math.hypot(x, y, z) || 1
    nor.push(x / l, y / l, z / l)
  }
  for (let i = 0; i < n - 1; i++) {
    const r0 = pts[i]![0]
    const r1 = pts[i + 1]![0]
    if (r0 === r1 && pts[i]![1] === pts[i + 1]![1]) continue // crease
    for (let j = 0; j < segs; j++) {
      const t0 = a0 + ((a1 - a0) * j) / segs
      const t1 = a0 + ((a1 - a0) * (j + 1)) / segs
      let k = 0
      if (r0 > 1e-6) {
        vert(i, t0)
        vert(i, t1)
        vert(i + 1, t1)
        k += 3
      }
      if (r1 > 1e-6) {
        vert(i, t0)
        vert(i + 1, t1)
        vert(i + 1, t0)
        k += 3
      }
      _c.setHex(typeof col === 'number' ? col : col(i, j))
      for (; k > 0; k--) colr.push(_c.r, _c.g, _c.b)
    }
  }
  return finish(pos, nor, colr)
}

/** Profile of a sphere of radius r centred on the origin (rings bottom-up). */
export function ballProfile(r: number, rings: number, sy = 1): [number, number][] {
  const p: [number, number][] = []
  for (let i = 0; i <= rings; i++) {
    const a = (Math.PI * i) / rings
    p.push([i === 0 || i === rings ? 0 : r * Math.sin(a), -r * Math.cos(a) * sy])
  }
  return p
}

/** Ellipsoid centred on the origin. */
export const ball = (r: number, segs: number, rings: number, col: QuadColor, sx = 1, sy = 1, sz = 1) => rev(ballProfile(r, rings, sy), segs, col, sx, sz)

/** Profile of a limb hanging from the origin down to y = -len: radius r0 at the top, r1 at the bottom, round ends. */
export function limbProfile(r0: number, r1: number, len: number, cap = 2): [number, number][] {
  const p: [number, number][] = []
  for (let i = 0; i <= cap; i++) {
    const a = (Math.PI / 2) * (i / cap)
    p.push([i === 0 ? 0 : r1 * Math.sin(a), -len - r1 * Math.cos(a)])
  }
  for (let i = cap; i >= 0; i--) {
    const a = (Math.PI / 2) * (i / cap)
    p.push([i === 0 ? 0 : r0 * Math.sin(a), r0 * Math.cos(a)])
  }
  return p
}

/** Rounded limb from the origin down to y = -len. `cap` = rings per rounded end (1 = a blunt cone, for distant LODs). */
export const limb = (r0: number, r1: number, len: number, segs: number, col: QuadColor, cap = 2) => rev(limbProfile(r0, r1, len, cap), segs, col)

/** Give any three.js geometry a flat vertex colour (drops uv and the index so it can be merged with the others). */
export function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo
  if (g !== geo) geo.dispose()
  g.deleteAttribute('uv')
  const n = g.attributes.position!.count
  _c.setHex(hex)
  const a = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    a[i * 3] = _c.r
    a[i * 3 + 1] = _c.g
    a[i * 3 + 2] = _c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3))
  return g
}

export const box = (w: number, h: number, d: number, hex: number) => paint(new THREE.BoxGeometry(w, h, d), hex)

/** Multiply the baked colours by k(x, y, z): cheap painted shading (folds, grime, contact darkening). */
export function shade(geo: THREE.BufferGeometry, k: (x: number, y: number, z: number) => number): THREE.BufferGeometry {
  const p = geo.attributes.position!
  const c = geo.attributes.color!
  for (let i = 0; i < p.count; i++) {
    const m = k(p.getX(i), p.getY(i), p.getZ(i))
    c.setXYZ(i, c.getX(i) * m, c.getY(i) * m, c.getZ(i) * m)
  }
  return geo
}

/**
 * Irradiance of the ambient rig on a vertical face, linear RGB. The rig really gives (0.55, 0.585, 0.67) (stage.ts:
 * mean of the hemisphere colours, no key light); the blue cast is only half cancelled so that the faces that look up,
 * which get neutral light, do not turn reddish.
 */
const E_VERT: readonly [number, number, number] = [0.565, 0.59, 0.645]

/**
 * Brighten the baked colours so that a VERTICAL face shows its painted (PAL) colour under the ambient rig, which gives
 * vertical faces only about 0.6 E with a blue cast; faces that look up then come out at the "lit" variant of the colour.
 * `amount` 0..1 = how much of the deficit to cancel. The gain of each vertex is limited so that its brightest channel
 * stays below `ceil` (linear), so whites are lifted only a little and do not bloom. Results above 1 are fine: vertex
 * colours are linear floats.
 */
export function relight(geo: THREE.BufferGeometry, amount = 1, ceil = 1.05): THREE.BufferGeometry {
  const c = geo.attributes.color!
  const gr = 1 + (1 / E_VERT[0] - 1) * amount
  const gg = 1 + (1 / E_VERT[1] - 1) * amount
  const gb = 1 + (1 / E_VERT[2] - 1) * amount
  for (let i = 0; i < c.count; i++) {
    const r = c.getX(i) * gr
    const g = c.getY(i) * gg
    const b = c.getZ(i) * gb
    const m = Math.max(r, g, b)
    const k = m > ceil ? Math.max(ceil, Math.max(c.getX(i), c.getY(i), c.getZ(i))) / m : 1
    c.setXYZ(i, r * k, g * k, b * k)
  }
  return geo
}

/** Move every vertex with f (writes into the given vector); normals are left as they are, so keep the deformation gentle. */
export function warp(geo: THREE.BufferGeometry, f: (v: THREE.Vector3) => void): THREE.BufferGeometry {
  const p = geo.attributes.position!
  const v = new THREE.Vector3()
  for (let i = 0; i < p.count; i++) {
    f(v.fromBufferAttribute(p, i))
    p.setXYZ(i, v.x, v.y, v.z)
  }
  return geo
}

/** Merge painted geometries into one (inputs are disposed). */
export function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(geos, false)
  if (!g) throw new Error('merge: incompatible geometries')
  for (const x of geos) x.dispose()
  return g
}

/**
 * Bake every charMat mesh under `root` (in root space, current pose) into one indexed geometry: used for instanced
 * crowds, where welding the shared vertices cuts the vertex-shader work to about a third.
 */
export function bakeFigure(root: THREE.Object3D, skip?: (m: THREE.Mesh) => boolean): THREE.BufferGeometry {
  root.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const m4 = new THREE.Matrix4()
  const geos: THREE.BufferGeometry[] = []
  root.traverse(o => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.visible || !(m.material as THREE.Material).vertexColors || (m.material as THREE.Material).transparent) return
    if (skip?.(m)) return
    const g = m.geometry.clone()
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name)
    geos.push(g.applyMatrix4(m4.multiplyMatrices(inv, m.matrixWorld)))
  })
  const flat = merge(geos)
  const welded = mergeVertices(flat, 1e-4)
  flat.dispose()
  return welded
}

const _d = new THREE.Vector3()
const _p = new THREE.Vector3()
const _e = new THREE.Vector3()
const _u = new THREE.Vector3()
const DOWN = new THREE.Vector3(0, -1, 0)

/**
 * Two-bone IK. `upper` and `fore` are siblings whose geometry hangs from their origin along -y (lengths l1, l2).
 * Shoulder (sx, sy, sz), hand target (tx, ty, tz) and the elbow hint direction (px, py, pz) are in their parent's space.
 * Allocation-free.
 */
export function solveArm(
  upper: THREE.Object3D, fore: THREE.Object3D,
  sx: number, sy: number, sz: number, tx: number, ty: number, tz: number,
  l1: number, l2: number, px: number, py: number, pz: number,
) {
  _d.set(tx - sx, ty - sy, tz - sz)
  let dist = _d.length()
  if (dist < 1e-5) {
    _d.set(0, -1, 0)
    dist = 1e-5
  } else _d.multiplyScalar(1 / dist)
  dist = clamp(dist, Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999)
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a))
  _p.set(px, py, pz).addScaledVector(_d, -(px * _d.x + py * _d.y + pz * _d.z))
  if (_p.lengthSq() < 1e-8) _p.set(_d.y, -_d.x, 0.01)
  _p.normalize()
  _e.copy(_d).multiplyScalar(a).addScaledVector(_p, h)
  upper.position.set(sx, sy, sz)
  upper.quaternion.setFromUnitVectors(DOWN, _u.copy(_e).normalize())
  fore.position.set(sx + _e.x, sy + _e.y, sz + _e.z)
  fore.quaternion.setFromUnitVectors(DOWN, _u.copy(_d).multiplyScalar(dist).sub(_e).normalize())
}

export interface SkirtOpts {
  height: number
  rTop: number
  rBottom: number
  segs?: number
  rings?: number
  /** Optional ring positions from the waist (0) to the hem (1); overrides `rings` (use it for a thin hem band). */
  levels?: readonly number[]
  /** Exponent of the flare: 1 = straight cone, smaller = bell that widens right below the waist. Default 0.85. */
  bell?: number
  /** Number of soft folds round the hem and their depth as a fraction of the radius. */
  folds?: number
  foldDepth?: number
  /** Colour of a quad: ring 0 = waist .. rings-1 = hem; seg 0 is centred on the front, seg segs/2 on the back. */
  color: (ring: number, seg: number) => number
}

/**
 * Bell skirt whose vertices are rewritten every frame (CPU, about 100 grid points): a tube between a waist ring
 * and a hem ring that can trail behind, flare out, twist and fold over a seat. Lives in the character's ROOT space.
 */
export class Skirt {
  readonly mesh: THREE.Mesh
  private readonly segs: number
  private readonly rings: number
  private readonly w: Float32Array // ring position, 0 = waist .. 1 = hem
  private readonly rest: Float32Array // rest radius per grid vertex
  private readonly grid: Float32Array
  private readonly gnor: Float32Array
  private readonly map: Uint16Array // grid vertex per output vertex
  private readonly posAttr: THREE.BufferAttribute
  private readonly norAttr: THREE.BufferAttribute

  constructor(o: SkirtOpts) {
    const segs = (this.segs = o.segs ?? 16)
    const rings = (this.rings = o.levels ? o.levels.length - 1 : (o.rings ?? 6))
    const folds = o.folds ?? 7
    const depth = o.foldDepth ?? 0.06
    this.w = new Float32Array(rings + 1)
    this.rest = new Float32Array((rings + 1) * segs)
    for (let i = 0; i <= rings; i++) {
      const w = (this.w[i] = o.levels ? o.levels[i]! : i / rings)
      const r = o.rTop + (o.rBottom - o.rTop) * Math.pow(w, o.bell ?? 0.85)
      for (let j = 0; j < segs; j++) this.rest[i * segs + j] = r * (1 + depth * w * Math.cos(folds * ((j - 0.5) / segs) * TAU + 0.6))
    }
    this.grid = new Float32Array((rings + 1) * segs * 3)
    this.gnor = new Float32Array((rings + 1) * segs * 3)
    const quads = rings * segs
    this.map = new Uint16Array(quads * 6)
    const col = new Float32Array(quads * 18)
    let q = 0
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segs; j++) {
        const a = i * segs + j
        const b = i * segs + ((j + 1) % segs)
        const c = (i + 1) * segs + ((j + 1) % segs)
        const d = (i + 1) * segs + j
        // ring i is above ring i+1: outward winding is (d, c, b), (d, b, a)
        this.map.set([d, c, b, d, b, a], q * 6)
        _c.setHex(o.color(i, j))
        for (let k = 0; k < 6; k++) col.set([_c.r, _c.g, _c.b], q * 18 + k * 3)
        q++
      }
    }
    const g = new THREE.BufferGeometry()
    this.posAttr = new THREE.BufferAttribute(new Float32Array(quads * 18), 3).setUsage(THREE.DynamicDrawUsage)
    this.norAttr = new THREE.BufferAttribute(new Float32Array(quads * 18), 3).setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('position', this.posAttr)
    g.setAttribute('normal', this.norAttr)
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, o.height / 2, 0), o.height * 2.2)
    this.mesh = new THREE.Mesh(g, charMat2())
    this.pose(0, o.height, 0, 0, 0, 0, 0, 0, 0)
  }

  /**
   * @param wx,wy,wz centre of the waist ring
   * @param hx,hy,hz centre of the hem ring
   * @param flare    0 = rest shape, 1 = hem twice as wide (and slightly lifted)
   * @param twist    radians the hem is rotated behind the waist (swirl on fast turns)
   * @param sit      0..1: the tube first runs horizontally (thighs) and then drops (seated pose)
   */
  pose(wx: number, wy: number, wz: number, hx: number, hy: number, hz: number, flare: number, twist: number, sit: number) {
    const { segs, rings, grid, gnor, rest } = this
    const eh = lerp(1, 0.55, sit)
    const ev = lerp(1, 1.9, sit)
    for (let i = 0; i <= rings; i++) {
      const w = this.w[i]!
      const wh = Math.pow(w, eh)
      const wv = Math.pow(w, ev)
      const cx = wx + (hx - wx) * wh
      const cz = wz + (hz - wz) * wh
      const cy = wy + (hy - wy) * wv + flare * 0.1 * w * w
      const s = 1 + flare * w * w
      const tw = twist * w * w
      for (let j = 0; j < segs; j++) {
        const a = ((j - 0.5) / segs) * TAU + tw
        const r = rest[i * segs + j]! * s
        const o = (i * segs + j) * 3
        grid[o] = cx + r * Math.sin(a)
        grid[o + 1] = cy
        grid[o + 2] = cz + r * Math.cos(a)
      }
    }
    for (let i = 0; i <= rings; i++) {
      const iu = Math.max(0, i - 1)
      const id = Math.min(rings, i + 1)
      for (let j = 0; j < segs; j++) {
        const l = (i * segs + ((j + segs - 1) % segs)) * 3
        const r = (i * segs + ((j + 1) % segs)) * 3
        const u = (iu * segs + j) * 3
        const d = (id * segs + j) * 3
        const ax = grid[d]! - grid[u]!
        const ay = grid[d + 1]! - grid[u + 1]!
        const az = grid[d + 2]! - grid[u + 2]!
        const bx = grid[r]! - grid[l]!
        const by = grid[r + 1]! - grid[l + 1]!
        const bz = grid[r + 2]! - grid[l + 2]!
        let nx = ay * bz - az * by
        let ny = az * bx - ax * bz
        let nz = ax * by - ay * bx
        const len = Math.hypot(nx, ny, nz) || 1
        nx /= len
        ny /= len
        nz /= len
        const o = (i * segs + j) * 3
        gnor[o] = nx
        gnor[o + 1] = ny
        gnor[o + 2] = nz
      }
    }
    const pa = this.posAttr.array as Float32Array
    const na = this.norAttr.array as Float32Array
    const map = this.map
    for (let v = 0; v < map.length; v++) {
      const o = map[v]! * 3
      const t = v * 3
      pa[t] = grid[o]!
      pa[t + 1] = grid[o + 1]!
      pa[t + 2] = grid[o + 2]!
      na[t] = gnor[o]!
      na[t + 1] = gnor[o + 1]!
      na[t + 2] = gnor[o + 2]!
    }
    this.posAttr.needsUpdate = true
    this.norAttr.needsUpdate = true
  }
}

/**
 * Secondary motion for a skirt hem: a damped spring in the parent space of `root` that trails behind the
 * figure, plus flare/twist from the yaw rate. Feed it root.position / rotation.y every frame.
 */
export class HemSpring {
  /** Hem offset in the figure's local frame (x = left, z = forward). */
  ox = 0
  oz = 0
  flare = 0
  twist = 0
  /** Yaw rate (rad/s) and ground speed (m/s) measured from the last two calls. */
  yawRate = 0
  speed = 0
  private hx = 0
  private hz = 0
  private vx = 0
  private vz = 0
  private px = 0
  private pz = 0
  private ph = 0
  private init = false

  /** @param dt 0 = snap to rest. @param baseFlare flare the pose asks for. */
  step(x: number, z: number, heading: number, dt: number, baseFlare: number, maxLag = 0.34) {
    if (!(dt > 0) || !this.init) {
      this.hx = x
      this.hz = z
      this.vx = this.vz = 0
      this.ox = this.oz = 0
      this.flare = baseFlare
      this.twist = 0
      this.yawRate = 0
      this.speed = 0
      this.init = true
    } else {
      const bvx = (x - this.px) / dt
      const bvz = (z - this.pz) / dt
      this.speed = Math.hypot(bvx, bvz)
      this.yawRate = angleDelta(this.ph, heading) / dt
      const n = Math.min(8, Math.ceil(dt / 0.012))
      const h = dt / n
      for (let i = 0; i < n; i++) {
        this.vx += ((x - this.hx) * 170 - this.vx * 4 - (this.vx - bvx) * 12) * h
        this.vz += ((z - this.hz) * 170 - this.vz * 4 - (this.vz - bvz) * 12) * h
        this.hx += this.vx * h
        this.hz += this.vz * h
      }
      let wx = this.hx - x
      let wz = this.hz - z
      const l = Math.hypot(wx, wz)
      if (l > maxLag) {
        wx *= maxLag / l
        wz *= maxLag / l
        this.hx = x + wx
        this.hz = z + wz
      }
      const c = Math.cos(heading)
      const s = Math.sin(heading)
      this.ox = wx * c - wz * s
      this.oz = wx * s + wz * c
      const ft = baseFlare + Math.min(0.8, Math.abs(this.yawRate) * 0.045)
      this.flare += (ft - this.flare) * damp(ft > this.flare ? 30 : 5, dt)
      this.twist += (clamp(-this.yawRate * 0.035, -0.7, 0.7) - this.twist) * damp(12, dt)
    }
    this.px = x
    this.pz = z
    this.ph = heading
  }
}

function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  draw(c.getContext('2d')!, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

let _glowTex: THREE.Texture | null = null
/** White radial falloff (alpha): tint it with the material colour for glows. */
export function glowTexture(): THREE.Texture {
  return (_glowTex ??= canvasTex(64, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.35, 'rgba(255,255,255,0.75)')
    grad.addColorStop(0.7, 'rgba(255,255,255,0.22)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, s, s)
  }))
}

let _puffTex: THREE.Texture | null = null
/** Blotchy soft cloud (white, alpha) for miasma / dust puffs. */
export function puffTexture(): THREE.Texture {
  return (_puffTex ??= canvasTex(128, (g, s) => {
    const blobs: [number, number, number, number][] = [[0.5, 0.5, 0.46, 0.7], [0.36, 0.42, 0.26, 0.55], [0.64, 0.44, 0.27, 0.55], [0.44, 0.63, 0.25, 0.55], [0.6, 0.6, 0.24, 0.5]]
    for (const [x, y, r, a] of blobs) {
      const grad = g.createRadialGradient(x * s, y * s, 0, x * s, y * s, r * s)
      grad.addColorStop(0, `rgba(255,255,255,${a})`)
      grad.addColorStop(0.5, `rgba(255,255,255,${a * 0.6})`)
      grad.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = grad
      g.fillRect(0, 0, s, s)
    }
  }))
}

/** Orientation of a billboard that faces the fixed in-game camera (use when no camera is handed in). */
export const GAME_CAM_QUAT = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().lookAt(new THREE.Vector3(...P.CAMERA_OFFSET), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)),
)

/** Heading (core/math convention) that makes a model face the fixed in-game camera: used by the gallery. */
export const CAM_HEADING = Math.atan2(P.CAMERA_OFFSET[0], P.CAMERA_OFFSET[2])

/** Build a gallery item from a model factory; `animate` gets (handle, t, dt) with dt = 0 on a frozen clock. */
export function galleryItem<H extends { root: THREE.Object3D }>(name: string, size: number, make: () => H, animate: (h: H, t: number, dt: number, wrap: THREE.Group) => void): GalleryItem {
  return {
    name,
    size,
    make: () => {
      const wrap = new THREE.Group()
      const h = make()
      wrap.add(h.root)
      wrap.userData.h = h
      wrap.userData.t = null
      animate(h, 0, 0, wrap)
      return wrap
    },
    animate: (obj, t) => {
      const last = obj.userData.t as number | null
      const dt = last === null ? 0 : clamp(t - last, 0, 0.1)
      obj.userData.t = t
      animate(obj.userData.h as H, t, dt, obj as THREE.Group)
    },
  }
}

// =====================================================================================================
// Plague doctor
// =====================================================================================================

const WAIST = 0.95
const D_L1 = 0.3
const D_L2 = 0.28
const D_SHOULDER_X = 0.25
const D_SHOULDER_Y = 0.405
/** Neck (head pivot) above the waist, and the hat brim above the neck: brim at 1.70 m, crown top at 1.88 m. */
const D_NECK = 0.53
const D_BRIM = 0.22
const D_STRIDE = 1.3
const D_HOP_APEX = 0.45

export interface DoctorPose {
  /** Animation clock in seconds (GameState.time): idle breathing, feather wobble. */
  t: number
  /** Frame delta in seconds: pose changes are blended over about 0.1 s with it. 0 or omitted = snap to the pose. */
  dt?: number
  /** Player.mode: 'foot' = free hands, 'scoop' = leaning 30 deg with both hands on the scoop crossbar, 'cart' = seated on the bench with the hands on the two levers. */
  mode: 'foot' | 'scoop' | 'cart'
  /** Ground speed in m/s (hypot(vx, vz)); P.PLAYER_SPEED = full run (lean 12 deg, flared skirt, swinging arms). */
  speed: number
  /** Player.odo, metres walked: drives the bob / arm-swing phase so the steps match the distance covered. */
  odo: number
  /**
   * Cart hop progress 0..1, else 0/omitted. Mounting: 1 - mountT / P.CART_MOUNT_TIME, dismounting:
   * 1 - dismountT / P.CART_DISMOUNT_TIME. The model adds the arc (apex 0.45 m), tucks the skirt and throws the arms out.
   */
  hop?: number
  /** Apex of that arc in metres. Default 0.45; the leap onto the cart from behind its backrest needs more (ad 37.0-37.3 s). */
  hopApex?: number
  /** 0..1 while shoved back by an oversize bubble (Player.pushedT > 0): leans back with the hands up. */
  shoved?: number
}

export interface DoctorModel {
  /** Feet on the ground at the origin, facing +z. The binder writes root.position (x, 0, z) and root.rotation.y = heading. */
  root: THREE.Group
  /** Empty group 0.45 m behind his centre and 0.3 m up (SPEC 2.1): parent the flask stack / coin column here or copy its world position. Does not lean. */
  backAnchor: THREE.Group
  /** Empty group about 0.5 m above the feather tip (follows the seat / hop height): anchor for the emoji bubble. */
  headAnchor: THREE.Group
  /**
   * Where the hands go in 'scoop' mode, in root space: x = half the distance between the hands, y = height, z = distance
   * ahead. The default equals tools.ts SCOOP_GRIP (halfWidth, y, z); set it once if the scoop model differs.
   */
  scoopGrip: THREE.Vector3
  /**
   * Where the hands go in 'cart' mode (lever handles), root space, same meaning as scoopGrip. The default equals
   * tools.ts CART_LEVER_GRIP; to follow the moving levers copy CartModel's lever-grip position into it every frame
   * (the two hands are mirrored, so use the mean height / reach of the two levers).
   */
  cartGrip: THREE.Vector3
  /**
   * Optional: where the RIGHT hand goes in 'cart' mode when the two levers stand differently (same meaning as cartGrip,
   * x = its distance to the right of the centre line); cartGrip is then the left hand only. null (default) = mirrored.
   */
  cartGripRight: THREE.Vector3 | null
  /** Height of the cart bench top above the root origin (the origin stays on the ground at the seat position). Default = tools.ts CART_SEAT_HEIGHT. */
  seatHeight: number
  /** Forward lean of the body in radians as of the last update() (run 12 deg, push 30 deg, backward while shoved): for whatever he carries on his back. */
  lean: number
  /** Call every frame (cheap, allocation-free). Reads root.position / root.rotation.y to swing the skirt, so move the root BEFORE calling. */
  update(p: DoctorPose): void
}

interface DoctorGeo {
  torso: THREE.BufferGeometry
  head: THREE.BufferGeometry
  feather: THREE.BufferGeometry
  upper: THREE.BufferGeometry
  fore: THREE.BufferGeometry
}
let docGeo: DoctorGeo | null = null

function buildDoctorGeo(): DoctorGeo {
  // Colours are the PAL (on-screen) values; relight() cancels the dim bluish ambient on the vertical cloth so that it
  // lands on them, and the faces that look up (shoulders, sleeve tops) come out at the lighter "lit leather" tone.
  const coat = tone(mixHex(PAL.coat, PAL.skirt, 0.15), 0.9)
  const slate = mixHex(PAL.coat, PAL.skirt, 0.65) // the double-breasted front is as blue as the robe (doc_hi.jpg)
  const SZ = 0.82
  // --- torso (origin at the waist) ---
  const torso: THREE.BufferGeometry[] = []
  torso.push(
    shade(
      rev([[0, -0.05], [0.2, -0.05], [0.212, 0], [0.222, 0.1], [0.246, 0.24], [0.256, 0.34], [0.236, 0.42], [0.17, 0.485], [0.115, 0.52], [0, 0.54]], 12, (_i, j) => (j === 0 || j === 11 ? slate : coat), 1, SZ),
      (_x, y) => 0.88 + 0.2 * clamp01(y / 0.45),
    ),
  )
  // belt + buckle
  torso.push(rev([[0.218, -0.045], [0.232, -0.03], [0.232, 0.03], [0.22, 0.045]], 12, PAL.belt, 1, SZ))
  torso.push(box(0.075, 0.065, 0.03, tone(PAL.cuff, 0.8)).translate(0, 0, 0.232 * SZ))
  // high collar
  torso.push(rev([[0.15, 0.47], [0.165, 0.53], [0.15, 0.57], [0.11, 0.56]], 10, PAL.hood, 1, 0.9))
  // two columns of pale studs, spreading toward the shoulders
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const y = 0.075 + k * 0.125
      const r = 0.218 + 0.04 * (y / 0.34)
      const x = sx * (0.07 + 0.012 * k)
      torso.push(ball(0.022, 5, 3, tone(PAL.beak, 0.7)).translate(x, y, Math.sqrt(r * r - x * x) * SZ + 0.004))
    }
  }
  // pouches hanging from the belt at the front of the hips: maroon book pouch on his right, magenta one on his left
  // (not relit like the cloth: they are the one saturated accent and must not glow)
  const pouches: THREE.BufferGeometry[] = []
  const pouch = (w: number, h: number, hex: number, x: number, y: number, ry: number) => {
    const z = Math.sqrt(0.235 * 0.235 - x * x) * SZ + 0.012
    pouches.push(box(w, h, 0.075, hex).rotateY(ry).translate(x, y, z))
    pouches.push(box(w + 0.012, h * 0.34, 0.085, tone(hex, 0.9)).rotateY(ry).translate(x, y + h * 0.36, z))
    pouches.push(box(0.026, 0.04, 0.085, PAL.belt).rotateY(ry).translate(x, y + h * 0.5 + 0.012, z - 0.012))
  }
  pouch(0.14, 0.17, PAL.pouchA, -0.165, -0.1, -0.75)
  pouch(0.11, 0.14, PAL.pouchB, 0.17, -0.085, 0.78)

  // --- head + hat (origin at the neck) ---
  const head: THREE.BufferGeometry[] = []
  // dark hood; the front of it is the pale leather mask the beak grows out of
  const mask = tone(PAL.beak, 0.84)
  head.push(ball(0.155, 10, 7, (i, j) => (i >= 1 && i <= 5 && (j <= 1 || j >= 8) ? mask : PAL.hood), 1, 1.05, 1).translate(0, 0.11, 0))
  // beak: fat bone-white cone, forward and 30 deg down, hooked at the tip
  head.push(
    shade(warp(rev([[0.094, 0], [0.088, 0.07], [0.062, 0.17], [0.028, 0.26], [0, 0.3]], 8, PAL.beak, 1, 0.92), v => void (v.z += 0.5 * v.y * v.y)), (_x, y) => 0.84 + 0.24 * clamp01(y / 0.28))
      .rotateX(120 * DEG)
      .translate(0, 0.1, 0.085),
  )
  // goggles
  const lens = mixHex(PAL.lowland2, PAL.syringe, 0.45)
  for (const sx of [-1, 1]) {
    head.push(paint(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 8), PAL.hatBand).rotateX(90 * DEG).rotateY(sx * 0.5).translate(sx * 0.075, 0.165, 0.124))
    head.push(paint(new THREE.CylinderGeometry(0.034, 0.034, 0.036, 8), lens).rotateX(90 * DEG).rotateY(sx * 0.5).translate(sx * 0.075, 0.165, 0.127))
  }
  // hat: wide thin brim that droops a little, low crown, black band. The parts that face up are already lit at
  // full strength, so they are painted at their on-screen colour; the sides and the underside are relit below.
  const b = D_BRIM
  const hatTop: THREE.BufferGeometry[] = [
    // brim edge, white rim, greyer inner brim (doc_hi.jpg: #d0cecf inside a white rim)
    rev([[0.318, b - 0.014], [0.308, b + 0.002], [0.286, b + 0.008], [0.286, b + 0.008], [0.15, b + 0.036]], 16, i => (i >= 3 ? tone(PAL.hat, 0.83) : tone(PAL.hat, 0.97))),
    // crown top, slightly domed
    rev([[0.145, b + 0.158], [0.11, b + 0.176], [0, b + 0.18]], 16, tone(PAL.hat, 0.93)),
  ]
  const hatSide = relight(
    merge([
      rev([[0, b + 0.01], [0.17, b + 0.008], [0.3, b - 0.022], [0.318, b - 0.014]], 16, tone(PAL.hat, 0.7)),
      rev([[0.15, b + 0.036], [0.148, b + 0.1], [0.148, b + 0.1], [0.145, b + 0.158]], 16, i => (i === 0 ? PAL.hatBand : PAL.hat)),
    ]),
  )
  // feather: thin white quill at the back of the crown, curving toward his left (separate mesh so it can wobble); origin at its base
  const feather = relight(warp(rev([[0.011, 0], [0.021, 0.1], [0.02, 0.28], [0.011, 0.4], [0, 0.45]], 5, PAL.ratEar, 1, 0.5), v => void (v.x += 0.3 * v.y * v.y)), 1, 1.7)

  // --- arms: bulky leather sleeves, banded cuffs, big dark gloves ---
  const upper = relight(shade(limb(0.112, 0.098, D_L1, 8, coat), (_x, y) => 1.08 - 0.18 * clamp01(-y / D_L1)))
  const fore = relight(
    merge([
      limb(0.096, 0.088, 0.19, 8, coat),
      rev([[0.094, -0.252], [0.106, -0.24], [0.106, -0.215], [0.106, -0.215], [0.106, -0.198], [0.106, -0.198], [0.106, -0.172], [0.094, -0.16]], 8, i => (i === 3 ? PAL.belt : tone(PAL.cuff, 0.78))),
      ball(0.086, 8, 5, PAL.glove, 0.95, 1.2, 0.85).translate(0, -D_L2 - 0.02, 0),
    ]),
  )
  return { torso: merge([relight(merge(torso)), relight(merge(pouches), 0.25)]), head: merge([relight(merge(head)), ...hatTop, hatSide]), feather, upper, fore }
}

function dustMaterial() {
  return unlit(mixHex(PAL.dirtLit, PAL.cream, 0.6), { transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }).clone()
}

const _v = new THREE.Vector3()
const _m = new THREE.Matrix4()

// Robe colour: PAL.skirt lifted toward its lit value (doc_hi.jpg reads #364256 over most of the robe); relit below.
const SKIRT = tone(PAL.skirt, 1.1)

/** The plague doctor, 1.9 m to the top of the hat crown (2.15 m with the feather). */
export function makeDoctor(): DoctorModel {
  const geo = (docGeo ??= buildDoctorGeo())
  const mat = charMat()
  const root = new THREE.Group()
  root.name = 'doctor'

  const shadow = blobShadow(1.35, 1.1, 0.5)
  root.add(shadow)

  const skirt = new Skirt({
    height: WAIST,
    rTop: 0.2,
    rBottom: 0.365,
    bell: 0.5,
    segs: 16,
    levels: [0, 0.15, 0.32, 0.52, 0.72, 0.9, 0.95, 1],
    folds: 5,
    foldDepth: 0.045,
    // slate robe with faint vertical fold shading, a thin lighter hem line and a dark bottom edge
    color: (i, j) => (i === 5 ? tone(SKIRT, 1.18) : i === 6 ? tone(SKIRT, 0.82) : tone(SKIRT, (j % 2 ? 0.97 : 1.03) * (1.05 - i * 0.02))),
  })
  relight(skirt.mesh.geometry)
  root.add(skirt.mesh)

  const body = new THREE.Group() // origin at the waist
  body.rotation.order = 'YXZ'
  root.add(body)
  body.add(new THREE.Mesh(geo.torso, mat))
  const head = new THREE.Group()
  head.position.set(0, D_NECK, 0)
  body.add(head)
  head.add(new THREE.Mesh(geo.head, mat))
  const feather = new THREE.Mesh(geo.feather, mat)
  feather.position.set(0.06, D_BRIM + 0.07, -0.135)
  head.add(feather)

  const upL = new THREE.Mesh(geo.upper, mat)
  const foL = new THREE.Mesh(geo.fore, mat)
  const upR = new THREE.Mesh(geo.upper, mat)
  const foR = new THREE.Mesh(geo.fore, mat)
  body.add(upL, foL, upR, foR)

  const backAnchor = new THREE.Group()
  backAnchor.position.set(0, 0.3, -0.45)
  const headAnchor = new THREE.Group()
  root.add(backAnchor, headAnchor)

  // run dust (SPEC 9 row 25): a pale arc left on the ground on a start or a sharp turn
  const dustMat = dustMaterial()
  const dust = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.62, 14, 1, 20 * DEG, 140 * DEG).rotateX(-90 * DEG), dustMat)
  dust.visible = false
  dust.renderOrder = 2
  root.add(dust)
  let dustAge = 1
  let dustX = 0
  let dustZ = 0
  let dustH = 0
  let dustCool = 0
  let turnAcc = 0
  let prevSpeed = 0

  const hem = new HemSpring()
  const s = { run: 0, push: 0, seat: 0, shove: 0 }

  const model: DoctorModel = {
    root,
    backAnchor,
    headAnchor,
    scoopGrip: new THREE.Vector3(0.2, 0.95, 0.4),
    cartGrip: new THREE.Vector3(0.4, 1.52, 0.52),
    cartGripRight: null,
    seatHeight: 0.95,
    lean: 0,
    update(p) {
      const dt = p.dt ?? 0
      const k = dt > 0 ? damp(16, dt) : 1
      const cart = p.mode === 'cart'
      s.run += ((cart ? 0 : clamp01(p.speed / P.PLAYER_SPEED)) - s.run) * k
      s.push += ((p.mode === 'scoop' ? 1 : 0) - s.push) * k
      s.seat += ((cart ? 1 : 0) - s.seat) * k
      s.shove += (clamp01(p.shoved ?? 0) - s.shove) * k
      const run = s.run
      const foot = 1 - s.seat
      const hopArc = Math.sin(Math.PI * clamp01(p.hop ?? 0))

      const heading = root.rotation.y
      // running opens the bell to about 1.4 x; fast turns add up to 0.8 more (SPEC 7.4: 1.5-2 x its width)
      hem.step(root.position.x, root.position.z, heading, dt, (0.4 * run + 0.45 * hopArc) * foot)

      // --- body ---
      const phase = (p.odo / D_STRIDE) * TAU
      const sn = Math.sin(phase)
      const bob = (0.5 - 0.5 * Math.cos(phase * 2)) * 0.035 * run
      const breathe = Math.sin(p.t * 1.9)
      let lean = lerp(12 * DEG * run, 30 * DEG, s.push)
      lean = lerp(lean, 4 * DEG, s.seat) - 22 * DEG * s.shove + 8 * DEG * hopArc
      model.lean = lean
      const lift = (p.hopApex ?? D_HOP_APEX) * hopArc
      const waistY = lerp(WAIST, model.seatHeight + 0.2, s.seat) + bob + lift + breathe * 0.004
      const waistZ = Math.sin(lean) * WAIST * 0.42 * foot
      body.position.set(sn * 0.012 * run, waistY, waistZ)
      body.rotation.set(lean, sn * 0.1 * run * (1 - s.push), sn * 0.035 * run)
      head.rotation.x = -lean * 0.5 + breathe * 0.012 + s.shove * 0.25
      feather.rotation.set(-0.3 - hem.flare * 0.3 + Math.sin(p.t * 11) * 0.05 * run, 0, -0.3 + sn * 0.08 * run)

      // --- skirt ---
      const hy = lerp(0, model.seatHeight - 0.5, s.seat) + lift + 0.14 * hopArc
      skirt.pose(
        body.position.x, waistY, waistZ,
        hem.ox * foot, hy, hem.oz * foot - 0.06 * s.push * foot + 0.4 * s.seat,
        hem.flare, hem.twist * foot, s.seat,
      )

      // --- arms (targets in body space) ---
      const swing = sn * 0.2 * run * (1 - s.push)
      let lx = 0.365
      let ly = -0.135 + 0.06 * run + breathe * 0.006
      let lz = 0.05 + swing
      let rx = -0.365
      let ry = ly
      let rz = 0.05 - swing
      let pxL = 0.45
      let pyL = -0.3
      let pzL = -0.85
      // hop: arms out for balance; shoved: hands thrown up in front
      const a = hopArc * foot
      lx = lerp(lx, 0.54, a)
      ly = lerp(ly, 0.24, a)
      rx = lerp(rx, -0.54, a)
      ry = lerp(ry, 0.24, a)
      lx = lerp(lx, 0.26, s.shove)
      ly = lerp(ly, 0.5, s.shove)
      lz = lerp(lz, 0.32, s.shove)
      rx = lerp(rx, -0.26, s.shove)
      ry = lerp(ry, 0.5, s.shove)
      rz = lerp(rz, 0.32, s.shove)
      const gw = Math.max(s.push, s.seat)
      if (gw > 0.001) {
        const g = s.seat > s.push ? model.cartGrip : model.scoopGrip
        const gr = (s.seat > s.push && model.cartGripRight) || g
        body.updateMatrix()
        _m.copy(body.matrix).invert()
        _v.set(g.x, g.y, g.z).applyMatrix4(_m)
        lx = lerp(lx, _v.x, gw)
        ly = lerp(ly, _v.y, gw)
        lz = lerp(lz, _v.z, gw)
        _v.set(-gr.x, gr.y, gr.z).applyMatrix4(_m)
        rx = lerp(rx, _v.x, gw)
        ry = lerp(ry, _v.y, gw)
        rz = lerp(rz, _v.z, gw)
        pxL = lerp(pxL, 0.9, gw)
        pyL = lerp(pyL, -0.55, gw)
        pzL = lerp(pzL, -0.1, gw)
      }
      solveArm(upL, foL, D_SHOULDER_X, D_SHOULDER_Y, 0, lx, ly, lz, D_L1, D_L2, pxL, pyL, pzL)
      solveArm(upR, foR, -D_SHOULDER_X, D_SHOULDER_Y, 0, rx, ry, rz, D_L1, D_L2, -pxL, pyL, pzL)

      // --- anchors, shadow ---
      headAnchor.position.set(0, waistY + 1.2 + 0.5, waistZ)
      const c = Math.cos(heading)
      const sh = Math.sin(heading)
      // world offset (0.12, 0.17) (lower right on screen, SPEC 7.3) expressed in the local frame
      shadow.position.x = 0.12 * c - 0.17 * sh
      shadow.position.z = 0.12 * sh + 0.17 * c + waistZ * 0.5
      const ss = 1 - 0.3 * hopArc
      shadow.scale.set(ss, ss, 1)

      // --- run dust ---
      if (dt > 0) {
        dustCool -= dt
        turnAcc = turnAcc * Math.exp(-dt / 0.12) + Math.abs(hem.yawRate) * dt
        const started = p.speed > 3 && prevSpeed <= 3
        if (!cart && dustCool <= 0 && (started || (turnAcc > 1.1 && p.speed > 3))) {
          dustAge = 0
          dustCool = 0.35
          turnAcc = 0
          dustX = root.position.x
          dustZ = root.position.z
          dustH = heading
        }
        dustAge += dt
      }
      prevSpeed = p.speed
      if (dustAge < 0.22) {
        const u = dustAge / 0.22
        const wx = dustX - root.position.x
        const wz = dustZ - root.position.z
        dust.visible = true
        dust.position.set(wx * c - wz * sh, 0.03, wx * sh + wz * c)
        dust.rotation.y = dustH - heading
        dust.scale.setScalar(0.9 + 0.8 * u)
        dustMat.opacity = 0.55 * (1 - u) * (1 - u)
      } else dust.visible = false
    },
  }
  model.update({ t: 0, mode: 'foot', speed: 0, odo: 0 })
  return model
}

// =====================================================================================================
// Gallery
// =====================================================================================================

/** Run the model round a small circle so the skirt, lean and dust can be judged in motion. */
function circle(h: DoctorModel, t: number, dt: number, mode: DoctorPose['mode'], speed: number, r: number) {
  const w = speed / r
  h.root.position.set(Math.sin(t * w) * r, 0, Math.cos(t * w) * r - r)
  h.root.rotation.y = t * w + Math.PI / 2
  h.update({ t, dt, mode, speed, odo: t * speed })
}

export const GALLERY: GalleryItem[] = [
  galleryItem('doctor idle', 1.1, makeDoctor, (h, t, dt) => h.update({ t, dt, mode: 'foot', speed: 0, odo: 0 })),
  // facing the camera and with his back to it, as in doc_hi.jpg / doc1.jpg
  galleryItem('doctor front (to camera)', 1.1, makeDoctor, (h, t, dt) => {
    h.root.rotation.y = CAM_HEADING
    h.update({ t, dt, mode: 'foot', speed: 0, odo: 0 })
  }),
  galleryItem('doctor back (from camera)', 1.1, makeDoctor, (h, t, dt) => {
    h.root.rotation.y = CAM_HEADING + Math.PI
    h.update({ t, dt, mode: 'foot', speed: 0, odo: 0 })
  }),
  // spins at 1 rad/s: &t=<heading in radians> shows him from any side
  galleryItem('doctor turntable', 1.1, makeDoctor, (h, t, dt) => {
    h.root.rotation.y = t
    h.update({ t, dt, mode: 'foot', speed: 0, odo: 0 })
  }),
  galleryItem('doctor run (in place)', 1.1, makeDoctor, (h, t, dt) => h.update({ t, dt, mode: 'foot', speed: P.PLAYER_SPEED, odo: t * P.PLAYER_SPEED })),
  galleryItem('doctor run circle', 1.8, makeDoctor, (h, t, dt) => circle(h, t, dt, 'foot', P.PLAYER_SPEED, 1.1)),
  galleryItem('doctor stop-go', 1.8, makeDoctor, (h, t, dt) => {
    // dashes along x with instant turns: shows the swirl and the dust arc
    const u = (t * 0.9) % 2
    const dir = u < 1 ? 1 : -1
    const f = u < 1 ? u : 2 - u
    const moving = f > 0.08 && f < 0.92
    h.root.position.set((f - 0.5) * 2.4, 0, 0)
    h.root.rotation.y = (dir * Math.PI) / 2
    h.update({ t, dt, mode: 'foot', speed: moving ? 2.4 * 0.9 * 3 : 0, odo: f * 2.4 })
  }),
  galleryItem('doctor push', 1.1, makeDoctor, (h, t, dt) => h.update({ t, dt, mode: 'scoop', speed: P.PLAYER_SPEED, odo: t * P.PLAYER_SPEED })),
  galleryItem('doctor push circle', 1.8, makeDoctor, (h, t, dt) => circle(h, t, dt, 'scoop', P.PLAYER_SPEED, 1.4)),
  galleryItem('doctor seated', 1.1, makeDoctor, (h, t, dt) => h.update({ t, dt, mode: 'cart', speed: 0, odo: 0 })),
  galleryItem('doctor hop on-off', 1.1, makeDoctor, (h, t, dt) => {
    // 0.3 s mount, 1 s seated, 0.15 s dismount, 1 s on foot
    const u = t % 2.45
    const mount = u < 0.3
    const seated = u < 1.3
    const off = u >= 1.3 && u < 1.45
    h.update({ t, dt, mode: mount || seated ? 'cart' : 'foot', speed: 0, odo: 0, hop: mount ? u / 0.3 : off ? (u - 1.3) / 0.15 : 0 })
  }),
  galleryItem('doctor shoved', 1.1, makeDoctor, (h, t, dt) => h.update({ t, dt, mode: 'foot', speed: 0, odo: 0, shoved: 1 })),
]
