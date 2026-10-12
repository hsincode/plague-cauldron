// The two tools of SPEC 2.2 / 7.4: the wooden hand scoop and the four-wheel cart with the big blade.
//
// Both models live in the tool frame of world/tools.ts: origin = holder position on the ground (the doctor's feet for
// the scoop, the driver's seat for the cart), +z = forward, and root.rotation.y = heading. The curved plank blades are
// built directly on BLADES[kind].poly (the polyline the physics collides the balls with) and centred on it, so the
// wall the player sees is where the balls are pushed.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { PAL } from '../../config'
import { lerp } from '../../core/math'
import { BLADES, type BladeSpec } from '../../world/tools'
import { blobShadow, gloss, lam, mesh, unlit, type GalleryItem } from '../materials'

// ---------------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const css = (c: THREE.Color, a = 1) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`
/** sRGB-space colour helpers for canvas painting (no colour management involved). */
const srgb = (hexv: number) => new THREE.Color().setHex(hexv, THREE.SRGBColorSpace).convertLinearToSRGB()
const mixc = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, t)

function finishTexture(c: HTMLCanvasElement, repeat: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}

/**
 * Painted plank texture of a blade. Lower 75 % (v 0..0.75) = the face with horizontal grain, u along the blade;
 * upper band (v 0.8..1) = pale end grain used by the top edge and the two ends.
 */
function bladeTexture(seed: number, light: THREE.Color, mid: THREE.Color, grain: THREE.Color, end: THREE.Color): THREE.CanvasTexture {
  const W = 1024
  const H = 256
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const r = rng(seed)
  const top = H * 0.25
  const fh = H - top
  // The face is mostly the MID wood tone: away from the lantern the ad's planks are a medium brown (#80512f on
  // screen at 15.6 s / 33.8 s) and only the lantern turns them the bright tan of PAL.scoopWood (0.4 s).
  const grad = g.createLinearGradient(0, top, 0, H)
  grad.addColorStop(0, css(mixc(mid, light, 0.8)))
  grad.addColorStop(0.3, css(mixc(mid, light, 0.5)))
  grad.addColorStop(1, css(mixc(mid, grain, 0.2)))
  g.fillStyle = grad
  g.fillRect(0, top, W, fh)
  const wavy = (y0: number, x0: number, x1: number, amp: number, f1: number, f2: number, p1: number, p2: number) => {
    g.beginPath()
    for (let x = x0; x <= x1; x += 8) {
      const y = y0 + amp * Math.sin(x * f1 + p1) + amp * 0.5 * Math.sin(x * f2 + p2)
      if (x === x0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.stroke()
  }
  g.lineCap = 'round'
  // broad soft bands (alternating warm light / mid brown)
  for (let i = 0; i < 9; i++) {
    g.strokeStyle = i % 2 ? css(mixc(light, end, 0.35), 0.3) : css(mixc(mid, grain, 0.35), 0.4)
    g.lineWidth = 6 + r() * 16
    wavy(top + ((i + r()) / 9) * fh, -8, W + 8, 3 + r() * 6, 0.004 + r() * 0.004, 0.011 + r() * 0.01, r() * 6, r() * 6)
  }
  // dark grain lines, some of them short: few and bold, so that they survive at game zoom (about 1 px each)
  for (let i = 0; i < 8; i++) {
    const y0 = top + ((i + 0.25 + r() * 0.5) / 8) * fh
    const full = r() < 0.6
    const x0 = full ? -8 : r() * W * 0.6
    const x1 = full ? W + 8 : x0 + W * (0.25 + r() * 0.4)
    const amp = 2 + r() * 6
    const f1 = 0.005 + r() * 0.006
    const f2 = 0.014 + r() * 0.012
    const p1 = r() * 6
    const p2 = r() * 6
    g.strokeStyle = css(grain, 0.75 + r() * 0.25)
    g.lineWidth = 4 + r() * 4
    wavy(y0, x0, x1, amp, f1, f2, p1, p2)
    if (r() < 0.6) {
      // painted highlight hugging the line
      g.strokeStyle = css(mixc(light, end, 0.5), 0.6)
      g.lineWidth = 3
      wavy(y0 + 6.5, x0, x1, amp, f1, f2, p1, p2)
    }
  }
  // two knots
  for (let i = 0; i < 2; i++) {
    const kx = W * (0.18 + 0.64 * r())
    const ky = top + fh * (0.3 + 0.45 * r())
    for (let k = 3; k >= 1; k--) {
      g.strokeStyle = css(grain, 0.55)
      g.lineWidth = 1.6
      g.beginPath()
      g.ellipse(kx, ky, k * 9, k * 3.2, 0, 0, Math.PI * 2)
      g.stroke()
    }
  }
  // darker foot where the plank meets the ground
  const foot = g.createLinearGradient(0, H - 26, 0, H)
  foot.addColorStop(0, css(grain, 0))
  foot.addColorStop(1, css(grain, 0.45))
  g.fillStyle = foot
  g.fillRect(0, H - 26, W, 26)
  // end grain band
  g.fillStyle = css(mixc(end, light, 0.3))
  g.fillRect(0, 0, W, top)
  g.strokeStyle = css(mixc(mid, grain, 0.3), 0.55)
  g.lineWidth = 2.5
  for (let i = 0; i < 4; i++) wavy(8 + i * 13 + r() * 5, -8, W + 8, 1.5, 0.02, 0.05, r() * 6, r() * 6)
  return finishTexture(c, false)
}

/** Neutral (near white) tiling plank grain, multiplied by vertex colours on the cart body. u = along the grain. */
function plankTexture(): THREE.CanvasTexture {
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  const r = rng(77)
  g.fillStyle = '#f4f0ec'
  g.fillRect(0, 0, S, S)
  const PLANKS = 4
  for (let p = 0; p < PLANKS; p++) {
    const y0 = (p * S) / PLANKS
    g.fillStyle = `rgba(${p % 2 ? '255,236,214' : '120,84,60'},${0.1 + r() * 0.1})`
    g.fillRect(0, y0, S, S / PLANKS)
    for (let i = 0; i < 5; i++) {
      const y = y0 + 6 + r() * (S / PLANKS - 12)
      const a = 1 + r() * 2
      const ph = Math.floor(r() * 4)
      g.strokeStyle = `rgba(60,34,20,${0.22 + r() * 0.3})`
      g.lineWidth = 1 + r() * 1.5
      g.beginPath()
      for (let x = 0; x <= S; x += 8) {
        const yy = y + a * Math.sin((x / S) * Math.PI * 2 * (1 + (i % 2)) + ph)
        if (x === 0) g.moveTo(x, yy)
        else g.lineTo(x, yy)
      }
      g.stroke()
    }
    g.fillStyle = 'rgba(30,18,14,0.75)'
    g.fillRect(0, y0, S, 3)
  }
  return finishTexture(c, true)
}

let texScoop: THREE.CanvasTexture | null = null
let texCartBlade: THREE.CanvasTexture | null = null
let texPlank: THREE.CanvasTexture | null = null

const paint = (g: THREE.BufferGeometry, color: THREE.Color) => {
  const n = g.getAttribute('position').count
  const a = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    a[i * 3] = color.r
    a[i * 3 + 1] = color.g
    a[i * 3 + 2] = color.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3))
  return g
}

/** Box whose UVs follow its real size: grain (u) along the longer side of every face. */
function plankBox(w: number, h: number, d: number, seed: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  const uv = g.getAttribute('uv') as THREE.BufferAttribute
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]
  for (let f = 0; f < 6; f++) {
    const [du, dv] = dims[f]!
    const ou = ((seed * 0.37 + f * 0.21) % 1 + 1) % 1
    const ov = ((seed * 0.61 + f * 0.43) % 1 + 1) % 1
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k
      const u = uv.getX(i)
      const v = uv.getY(i)
      if (du >= dv) uv.setXY(i, ou + (u * du) / 1.5, ov + (v * dv) / 0.8)
      else uv.setXY(i, ou + (v * dv) / 1.5, ov + (u * du) / 0.8)
    }
  }
  return g
}

const _e = new THREE.Euler()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const Z = new THREE.Vector3(0, 0, 1)

/** Collects primitives (already transformed and vertex-coloured) and merges them into one geometry = one draw call. */
class Parts {
  private list: THREE.BufferGeometry[] = []
  private n = 0
  add(g: THREE.BufferGeometry, color: number | THREE.Color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): this {
    if (rx || ry || rz) g.applyMatrix4(_m.makeRotationFromEuler(_e.set(rx, ry, rz)))
    g.translate(x, y, z)
    paint(g, typeof color === 'number' ? new THREE.Color(color) : color)
    this.list.push(g)
    return this
  }
  box(w: number, h: number, d: number, color: number | THREE.Color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): this {
    return this.add(plankBox(w, h, d, ++this.n), color, x, y, z, rx, ry, rz)
  }
  /** Square beam from a to b (grain along it). */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, h: number, color: number | THREE.Color): this {
    _a.set(ax, ay, az)
    _b.set(bx, by, bz)
    const len = _a.distanceTo(_b)
    const g = plankBox(w, h, len, ++this.n)
    _q.setFromUnitVectors(Z, _b.clone().sub(_a).normalize())
    g.applyMatrix4(_m.makeRotationFromQuaternion(_q))
    return this.add(g, color, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2)
  }
  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.list.map(p => (p.index ? p.toNonIndexed() : p)))!
    for (const p of this.list) p.dispose()
    this.list = []
    return g
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// blade
// ---------------------------------------------------------------------------------------------------------------------

interface BladeShape {
  /** Extra height at the tips, added as rise * |u|^pow (u = -1..1 along the blade). */
  rise: number
  pow: number
  /** Amplitude of the hand-cut waviness of the top edge. */
  wave: number
}

/**
 * The planks are drawn 0.28 m thick, more than twice the collider (P.BLADE_THICKNESS): the ad's blades are chunky
 * slabs whose end face is 16-19 px against the 84 px ring (0.2 s, 6.0 s). The centre line is exactly the collider
 * polyline, so a ball resting against a face sinks a third of itself into the wood.
 */
const BLADE_VISUAL_THICKNESS = 0.28

/**
 * Curved plank wall standing on y = 0 along spec.poly, BLADE_VISUAL_THICKNESS thick and centred on the polyline
 * (every polyline vertex is a column of the mesh; segments are only subdivided linearly, so the footprint is exact).
 * Height = spec.height at the centre.
 */
function buildBlade(spec: BladeSpec, shape: BladeShape): THREE.BufferGeometry {
  const SUB = 3
  const poly = spec.poly
  const np = poly.length / 2
  const px: number[] = []
  const pz: number[] = []
  for (let i = 0; i < np - 1; i++)
    for (let s = 0; s < SUB; s++) {
      px.push(poly[i * 2]! + ((poly[i * 2 + 2]! - poly[i * 2]!) * s) / SUB)
      pz.push(poly[i * 2 + 1]! + ((poly[i * 2 + 3]! - poly[i * 2 + 1]!) * s) / SUB)
    }
  px.push(poly[np * 2 - 2]!)
  pz.push(poly[np * 2 - 1]!)
  const n = px.length
  const len: number[] = [0]
  for (let i = 1; i < n; i++) len.push(len[i - 1]! + Math.hypot(px[i]! - px[i - 1]!, pz[i]! - pz[i - 1]!))
  const total = len[n - 1]!
  const half = BLADE_VISUAL_THICKNESS / 2
  const hMax = spec.height + shape.rise + shape.wave
  const pos: number[] = []
  const nor: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) => {
    pos.push(x, y, z)
    nor.push(nx, ny, nz)
    uv.push(u, v)
    return pos.length / 3 - 1
  }
  const col: { ib: number; it: number; ob: number; ot: number; ti: number; to: number }[] = []
  const ends: { x: number; z: number; nx: number; nz: number; tx: number; tz: number; h: number }[] = []
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1)
    const b = Math.min(n - 1, i + 1)
    let tx = px[b]! - px[a]!
    let tz = pz[b]! - pz[a]!
    const tl = Math.hypot(tx, tz)
    tx /= tl
    tz /= tl
    // normal toward the concave side (+z at the middle of the blade, where the tangent is +x)
    const nx = -tz
    const nz = tx
    const s = len[i]! / total
    const u = s * 2 - 1
    const au = Math.abs(u)
    const h = spec.height + shape.rise * Math.pow(au, shape.pow) + shape.wave * (0.6 * Math.sin(u * 8.3 + 0.7) + 0.4 * Math.sin(u * 19.0 + 2.1)) * (1 - Math.pow(au, 6))
    const x = px[i]!
    const z = pz[i]!
    const vt = (h / hMax) * 0.74
    col.push({
      ib: vert(x + nx * half, 0, z + nz * half, nx, 0, nz, s, 0.004),
      it: vert(x + nx * half, h, z + nz * half, nx, 0, nz, s, vt),
      ob: vert(x - nx * half, 0, z - nz * half, -nx, 0, -nz, 1 - s, 0.004),
      ot: vert(x - nx * half, h, z - nz * half, -nx, 0, -nz, 1 - s, vt),
      ti: vert(x + nx * half, h, z + nz * half, 0, 1, 0, s, 0.985),
      to: vert(x - nx * half, h, z - nz * half, 0, 1, 0, s, 0.83),
    })
    if (i === 0 || i === n - 1) ends.push({ x, z, nx, nz, tx, tz, h })
  }
  for (let i = 0; i < n - 1; i++) {
    const a = col[i]!
    const b = col[i + 1]!
    idx.push(a.ib, b.ib, a.it, b.ib, b.it, a.it) // concave face
    idx.push(a.ob, a.ot, b.ob, b.ob, a.ot, b.ot) // convex face
    idx.push(a.ti, b.ti, a.to, b.ti, b.to, a.to) // top edge
  }
  ends.forEach((e, k) => {
    const sgn = k === 0 ? -1 : 1
    const ib = vert(e.x + e.nx * half, 0, e.z + e.nz * half, e.tx * sgn, 0, e.tz * sgn, 0.02, 0.83)
    const it = vert(e.x + e.nx * half, e.h, e.z + e.nz * half, e.tx * sgn, 0, e.tz * sgn, 0.3, 0.83)
    const ob = vert(e.x - e.nx * half, 0, e.z - e.nz * half, e.tx * sgn, 0, e.tz * sgn, 0.02, 0.985)
    const ot = vert(e.x - e.nx * half, e.h, e.z - e.nz * half, e.tx * sgn, 0, e.tz * sgn, 0.3, 0.985)
    if (k === 0) idx.push(ib, it, ob, ob, it, ot)
    else idx.push(ib, ob, it, ob, ot, it)
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

/** z of the convex (back) face of a blade at local x. */
function bladeBackZ(spec: BladeSpec, x: number): number {
  const h = spec.chord / 2
  const R = (h * h + spec.sagitta * spec.sagitta) / (2 * spec.sagitta)
  return spec.offset + R - Math.sqrt(R * R - x * x) - BLADE_VISUAL_THICKNESS / 2
}

// ---------------------------------------------------------------------------------------------------------------------
// hand scoop
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Where the doctor holds the hand scoop, in the scoop's local frame: the crossbar is centred at (0, y, z) and runs
 * along x; the hands go at x = +-halfWidth. The bar is at chest height and an arm's reach ahead of the doctor, who
 * stands on the origin leaning 30 deg forward: from the game camera the frame then shows above and beside him, as
 * in the ad (0.2 s), instead of hiding behind his skirt.
 */
export const SCOOP_GRIP = { y: 1.16, z: 0.6, halfWidth: 0.24 } as const

export interface ScoopModel {
  /** Tool frame (see the file header): position = sim `Tool.x/z`, rotation.y = `Tool.heading`. No moving parts. */
  root: THREE.Group
  /** Same object as SCOOP_GRIP. */
  grip: typeof SCOOP_GRIP
}

let scoopGeo: { blade: THREE.BufferGeometry; handle: THREE.BufferGeometry } | null = null

/**
 * The wooden hand scoop: curved plank blade on BLADES.scoop.poly (chord 2.6, sagitta 0.7, 0.9 high rising to 1.2 at
 * the prow-like tips, concave side forward) and a chunky A-frame handle of pale poles converging to the crossbar at
 * chest height (SCOOP_GRIP). It stands by itself when parked. 3 draw calls including the blob shadow.
 */
export function makeScoop(): ScoopModel {
  const spec = BLADES.scoop
  if (!scoopGeo) {
    // handle: clearly paler than the blade face (ad, 6.0 s), the crossbar the hands polish paler still
    const pole = new THREE.Color(PAL.scoopEnd).lerp(new THREE.Color(PAL.cream), 0.55)
    const bar = new THREE.Color(PAL.scoopEnd).lerp(new THREE.Color(PAL.cream), 0.7)
    const parts = new Parts()
    const { y: gy, z: gz, halfWidth: gw } = SCOOP_GRIP
    const FOOT_X = 0.66
    const FOOT_Y = 0.6
    for (const s of [-1, 1]) {
      const bx = s * FOOT_X
      const bz = bladeBackZ(spec, bx) + 0.03
      // extend the pole a little past the crossbar, as on the reference
      const dx = s * gw - bx
      const dy = gy - FOOT_Y
      const dz = gz - bz
      const ex = 0.16 / Math.hypot(dx, dy, dz)
      parts.beam(bx, FOOT_Y, bz, s * gw + dx * ex, gy + dy * ex, gz + dz * ex, 0.15, 0.15, pole)
    }
    parts.beam(-gw - 0.14, gy, gz, gw + 0.14, gy, gz, 0.13, 0.13, bar)
    // lower brace between the poles, a third of the way up from the blade
    const k = 0.34
    const bx2 = lerp(FOOT_X, gw, k)
    const bz2 = lerp(bladeBackZ(spec, FOOT_X) + 0.03, gz, k)
    const by2 = lerp(FOOT_Y, gy, k)
    parts.beam(-bx2, by2, bz2, bx2, by2, bz2, 0.12, 0.12, pole)
    scoopGeo = { blade: buildBlade(spec, { rise: 0.3, pow: 2.6, wave: 0.04 }), handle: parts.build() }
  }
  texScoop ??= bladeTexture(11, srgb(PAL.scoopWood), srgb(PAL.scoopWoodMid), srgb(PAL.scoopGrain), srgb(PAL.scoopEnd))
  texPlank ??= plankTexture()
  const root = new THREE.Group()
  root.name = 'scoop'
  mesh(scoopGeo.blade, lam(0xffffff, { flat: false, map: texScoop }), root)
  mesh(scoopGeo.handle, lam(0xffffff, { vertexColors: true, map: texPlank }), root)
  const sh = blobShadow(spec.chord + 1.0, 1.7, 0.5)
  sh.position.set(0.1, 0.014, spec.offset + spec.sagitta * 0.45 + 0.1)
  root.add(sh)
  return { root, grip: SCOOP_GRIP }
}

// ---------------------------------------------------------------------------------------------------------------------
// cart
// ---------------------------------------------------------------------------------------------------------------------

/** Height of the bench top above the ground. The seated doctor is placed at the cart origin with his seat at this y. */
export const CART_SEAT_HEIGHT = 0.95
/**
 * Rest position of the two lever grips in the cart's local frame (x = +-CART_LEVER_GRIP.x). The grips move by at most
 * 0.25 m with setSteer(); use CartModel.getGrip() for the exact animated position.
 */
export const CART_LEVER_GRIP = { x: 0.4, y: 1.52, z: 0.52 } as const

// Proportions. The ad's wagon is a compact dark machine on four big wheels (rear 1.25-1.3 m, front about 1.1 m, measured
// at 37.0 s against the 4.4 m blade) with the blade right in front of the front wheels. Our blade sits 3.7 m ahead of
// the seat (P.CART_BLADE_OFFSET, about 1.3 m more than in the ad), so the wheels are the ad's size rather than the
// SPEC's 1.0 / 0.8, the front axle is as far forward as the blade allows and the gap between the axles is filled by
// the cog block: that keeps the silhouette "big wheels + cogs + blade" instead of a long thin frame with a cantilever.
const REAR_R = 0.62
const FRONT_R = 0.53
const REAR_Z = 0.2
const FRONT_Z = 2.74
const REAR_X = 1.0
const FRONT_X = 0.97
/** Main cog axle (the levers pivot on it) and the second axle its cogs mesh with. */
const COG_Z = 2.085
const COG_Y = 1.02
const COG2_Z = 2.745
const COG2_Y = 1.0
/** Tooth counts (same tooth pitch everywhere, so the pairs really mesh): outer pair 13 : 10, middle pair 11 : 13. */
const COG_A_OUT = { r: 0.42, teeth: 13 }
const COG_A_MID = { r: 0.34, teeth: 11 }
const COG_B_OUT = { r: 0.32, teeth: 10 }
const COG_B_MID = { r: 0.4, teeth: 13 }
const COG_X = 0.2
/** y of the centre line of the chassis rails and their x. */
const DECK_Y = 0.66
const RAIL_X = 0.62
/** Backward lean of the backrest and the height of its board above the seat. */
const BACK_TILT = 0.1
const BACK_HEIGHT = 0.7
/** Largest yaw of the front axle (setSteer(+-1)); the wheels just clear the rails at this angle. */
const STEER_YAW = 0.22

export interface CartModel {
  /**
   * Tool frame (see the file header): origin = the driver's seat position ON THE GROUND, +z forward. The wagon body is
   * centred P.CART_BODY_OFFSET ahead, the blade follows BLADES.cart.poly (centre P.CART_BLADE_OFFSET ahead).
   * position = sim `Tool.x/z`, rotation.y = `Tool.heading`.
   */
  root: THREE.Group
  /** = CART_SEAT_HEIGHT: y of the bench top. Seat the doctor at local (0, seatHeight, 0), facing +z. */
  readonly seatHeight: number
  /**
   * Total signed distance driven along the heading, in metres (accumulate speed * dt; negative = reversing).
   * Rolls the four wheels without slipping and turns the cog wheels (geared to the rear axle).
   */
  setTravel(distance: number): void
  /**
   * Steering / lever pose, -1..1. Positive = the heading is increasing (turning toward local +x, the driver's left), e.g.
   * steer = clamp(headingRate / P.CART_TURN_RATE, -1, 1). The front axle yaws and the two levers move in opposite
   * directions (tank style). 0 = straight, levers level.
   */
  setSteer(steer: number): void
  /** Push both levers forward (0 = at rest .. 1 = full ahead); purely cosmetic, e.g. speed / P.CART_SPEED. */
  setThrottle(k: number): void
  /** Extra cog rotation in radians on top of the travel-driven one (e.g. a slow idle turn). */
  setCogSpin(angle: number): void
  /** Current position of a lever grip in the cart's LOCAL frame, for the driver's hands. side: +1 = local +x, -1 = local -x. */
  getGrip(side: 1 | -1, out: THREE.Vector3): THREE.Vector3
}

function faceColors(g: THREE.BufferGeometry, pick: (nx: number, ny: number, nz: number, x: number, y: number, z: number) => THREE.Color): THREE.BufferGeometry {
  const ni = g.index ? g.toNonIndexed() : g
  ni.computeVertexNormals()
  const p = ni.getAttribute('position')
  const n = ni.getAttribute('normal')
  const a = new Float32Array(p.count * 3)
  for (let i = 0; i < p.count; i++) {
    const c = pick(n.getX(i), n.getY(i), n.getZ(i), p.getX(i), p.getY(i), p.getZ(i))
    a[i * 3] = c.r
    a[i * 3 + 1] = c.g
    a[i * 3 + 2] = c.b
  }
  ni.setAttribute('color', new THREE.BufferAttribute(a, 3))
  ni.deleteAttribute('uv')
  return ni
}
const plain = (g: THREE.BufferGeometry, c: THREE.Color) => {
  const ni = paint(g.index ? g.toNonIndexed() : g, c)
  ni.deleteAttribute('uv')
  return ni
}

/**
 * Two spoked wagon wheels on one axle (axle along x through the origin, wheels at x = +-track): near-black navy iron
 * with a thick tyre whose tread carries the blue-violet highlight of the ad's wheels.
 */
function buildWheelPair(R: number, width: number, spokes: number, track: number): THREE.BufferGeometry {
  const iron = new THREE.Color(PAL.cartWheel)
  const side = iron.clone().multiplyScalar(0.85)
  const tread = iron.clone().lerp(new THREE.Color(0x8088c8), 0.1)
  const edge = iron.clone().lerp(new THREE.Color(0x8088c8), 0.32)
  const dark = iron.clone().multiplyScalar(0.6)
  const list: THREE.BufferGeometry[] = []
  const t = R * 0.2 // radial thickness of the tyre
  const c = width * 0.22 // chamfer
  const hw = width / 2
  for (const s of [-1, 1]) {
    const prof = [
      new THREE.Vector2(R - t, -hw),
      new THREE.Vector2(R - c, -hw),
      new THREE.Vector2(R, -hw + c),
      new THREE.Vector2(R, hw - c),
      new THREE.Vector2(R - c, hw),
      new THREE.Vector2(R - t, hw),
      new THREE.Vector2(R - t, -hw),
    ]
    const tyre = new THREE.LatheGeometry(prof, 22).rotateZ(Math.PI / 2)
    list.push(
      faceColors(tyre, (nx, ny, nz, _x, y, z) => {
        const rad = Math.hypot(y, z) || 1
        const out = (ny * y + nz * z) / rad
        return out > 0.9 ? tread : out > 0.3 ? edge : out < -0.5 ? dark : side
      }).translate(s * track, 0, 0),
    )
    for (let i = 0; i < spokes; i++) {
      const sp = new THREE.BoxGeometry(width * 0.5, R - t + 0.02, 0.085)
      sp.translate(0, (R - t + 0.02) / 2, 0)
      sp.rotateX((i / spokes) * Math.PI * 2)
      list.push(plain(sp, dark).translate(s * track, 0, 0))
    }
    const hub = new THREE.CylinderGeometry(R * 0.2, R * 0.24, width + 0.1, 10).rotateZ(-s * Math.PI / 2)
    list.push(faceColors(hub, nx => (nx * s > 0.5 ? edge : side)).translate(s * track, 0, 0))
  }
  list.push(plain(new THREE.CylinderGeometry(0.055, 0.055, track * 2, 8).rotateZ(Math.PI / 2), dark))
  const g = mergeGeometries(list)!
  for (const l of list) l.dispose()
  return g
}

/** Chunky square-toothed cog, axle along x, centred on (x, 0, 0); r = tooth-tip radius. */
function buildCog(spec: { r: number; teeth: number }, thick: number, x: number): THREE.BufferGeometry[] {
  const gear = new THREE.Color(PAL.cartGear)
  // top-lit teeth read as pale bone in the ad, the recessed faces as dark brown
  const lite = gear.clone().lerp(new THREE.Color(PAL.cream), 0.3).multiplyScalar(0.66)
  const rim = gear.clone().lerp(new THREE.Color(PAL.cartDark), 0.6).multiplyScalar(0.7)
  const dark = gear.clone().lerp(new THREE.Color(PAL.cartDark), 0.6).multiplyScalar(0.34)
  const R = spec.r
  const tooth = 0.085
  const rb = R - tooth
  const list: THREE.BufferGeometry[] = []
  const body = new THREE.CylinderGeometry(rb, rb, thick, Math.max(12, spec.teeth * 2)).rotateZ(Math.PI / 2)
  list.push(faceColors(body, nx => (Math.abs(nx) > 0.5 ? dark : rim)))
  // raised rim ring and hub on both faces
  for (const s of [-1, 1]) {
    const ring = new THREE.RingGeometry(rb - 0.07, rb, 16, 1).rotateY((s * Math.PI) / 2)
    list.push(plain(ring, rim).translate(s * (thick / 2 + 0.004), 0, 0))
  }
  const pitch = (rb * Math.PI * 2) / spec.teeth
  for (let i = 0; i < spec.teeth; i++) {
    const tb = new THREE.BoxGeometry(thick, tooth + 0.03, pitch * 0.5)
    tb.translate(0, rb + tooth / 2 - 0.015, 0)
    tb.rotateX((i / spec.teeth) * Math.PI * 2)
    list.push(plain(tb, lite))
  }
  const hub = new THREE.CylinderGeometry(R * 0.26, R * 0.26, thick + 0.06, 8).rotateZ(Math.PI / 2)
  list.push(plain(hub, rim))
  for (const l of list) l.translate(x, 0, 0)
  return list
}
const mergeAll = (list: THREE.BufferGeometry[]) => {
  const g = mergeGeometries(list)!
  for (const l of list) l.dispose()
  return g
}

interface CartGeo {
  blade: THREE.BufferGeometry
  wood: THREE.BufferGeometry
  iron: THREE.BufferGeometry
  glow: THREE.BufferGeometry
  rear: THREE.BufferGeometry
  front: THREE.BufferGeometry
  cogA: THREE.BufferGeometry
  cogBOut: THREE.BufferGeometry
  cogBMid: THREE.BufferGeometry
  lever: THREE.BufferGeometry
}
let cartGeo: CartGeo | null = null
const LEVER_LEN = Math.hypot(CART_LEVER_GRIP.y - COG_Y, CART_LEVER_GRIP.z - COG_Z)
const LEVER_REST = Math.atan2(CART_LEVER_GRIP.z - COG_Z, CART_LEVER_GRIP.y - COG_Y) // rotation.x that lays +y onto the grip

function buildCart(): CartGeo {
  const spec = BLADES.cart
  // Colour blocking of the ad: a near-black charcoal-brown wagon, a warm brown seat and trim, pale bone levers and
  // struts. Top faces get the full ambient light, so the dark tone is PAL.cartDark taken down a little.
  const dark = new THREE.Color(PAL.cartDark).lerp(new THREE.Color(PAL.cartWheel), 0.25).multiplyScalar(0.6)
  const panel = new THREE.Color(PAL.cartDark).lerp(new THREE.Color(PAL.cartWheel), 0.35).multiplyScalar(0.75)
  const wood = new THREE.Color(PAL.cartDark).lerp(new THREE.Color(PAL.cartWood), 0.3).multiplyScalar(0.62)
  const trim = new THREE.Color(PAL.cartDark).lerp(new THREE.Color(PAL.cartWood), 0.2).multiplyScalar(0.5)
  const pale = new THREE.Color(PAL.scoopEnd).lerp(new THREE.Color(PAL.cream), 0.5).multiplyScalar(0.85)
  const strut = new THREE.Color(PAL.scoopEnd).lerp(new THREE.Color(PAL.scoopWoodMid), 0.25)
  const iron = new THREE.Color(PAL.cartWheel).multiplyScalar(0.7)
  const FRONT = 3.22 // front cross beam of the wagon

  const w = new Parts()
  // chassis: two long rails, a dark belly between the axles, rear and front cross beams
  for (const s of [-1, 1]) w.box(0.16, 0.2, FRONT + 0.5, dark, s * RAIL_X, DECK_Y, (FRONT - 0.5) / 2)
  w.box(1.08, 0.1, 2.6, dark, 0, DECK_Y - 0.06, 1.9)
  w.box(1.4, 0.18, 0.16, dark, 0, DECK_Y, -0.42)
  w.box(1.5, 0.2, 0.2, trim, 0, DECK_Y - 0.02, FRONT)
  // the bench: a warm plank seat (top at CART_SEAT_HEIGHT) on two bearers, open underneath so that the rear wheels
  // show whole (ad, 37.0 s)
  for (const s of [-1, 1]) w.box(0.14, 0.13, 0.96, panel, s * RAIL_X, CART_SEAT_HEIGHT - 0.14, 0.05)
  w.box(1.56, 0.08, 1.02, wood, 0, CART_SEAT_HEIGHT - 0.04, 0.07)
  // backrest leaning back: a low dark board in a brown frame with capped posts; the seated driver's shoulders and hat
  // stand clear of it (ad, 38.0 s / 40.0 s)
  {
    const y0 = CART_SEAT_HEIGHT - 0.06
    const z0 = -0.45
    const cs = Math.cos(BACK_TILT)
    const sn = Math.sin(BACK_TILT)
    const at = (h: number, dz = 0): [number, number] => [y0 + cs * h + sn * dz, z0 - sn * h + cs * dz]
    const [py, pz] = at(BACK_HEIGHT / 2)
    w.box(1.38, BACK_HEIGHT, 0.07, panel, 0, py, pz, -BACK_TILT)
    for (const s of [-1, 1]) {
      const [qy, qz] = at(BACK_HEIGHT / 2 + 0.04)
      w.box(0.12, BACK_HEIGHT + 0.12, 0.13, trim, s * 0.74, qy, qz, -BACK_TILT)
      const [cy, cz] = at(BACK_HEIGHT + 0.13)
      w.box(0.17, 0.07, 0.18, wood, s * 0.74, cy, cz, -BACK_TILT)
    }
    const [ty, tz] = at(BACK_HEIGHT + 0.03)
    w.box(1.38, 0.11, 0.14, wood, 0, ty, tz, -BACK_TILT)
    // one lighter plank across the front of the board, where the driver leans
    const [my, mz] = at(0.32, 0.045)
    w.box(1.36, 0.24, 0.03, trim, 0, my, mz, -BACK_TILT)
  }
  // side boards of the bench with a cap rail
  for (const s of [-1, 1]) {
    w.box(0.07, 0.3, 0.9, panel, s * 0.765, CART_SEAT_HEIGHT + 0.13, 0.02)
    w.box(0.1, 0.05, 0.94, trim, s * 0.765, CART_SEAT_HEIGHT + 0.3, 0.02)
  }
  // footboard / deck between the bench and the cog block
  w.box(1.08, 0.06, 1.0, trim, 0, DECK_Y + 0.11, 1.06)
  // bearing blocks of the two cog axles
  for (const s of [-1, 1]) {
    w.box(0.14, 0.52, 0.26, dark, s * RAIL_X, DECK_Y + 0.32, COG_Z)
    w.box(0.14, 0.5, 0.24, dark, s * RAIL_X, DECK_Y + 0.31, COG2_Z)
  }
  // blade mount: three short stout arms from the front beam to the back of the blade, and two pale struts from the
  // cog frame to its upper part (the two pale rods of the ad), each ending in an upright cleat
  for (const s of [-1, 1]) {
    const bx = s * 1.05
    w.beam(s * 0.64, DECK_Y - 0.04, FRONT, bx, 0.48, bladeBackZ(spec, bx) + 0.03, 0.17, 0.17, trim)
    const tx = s * 0.52
    w.beam(s * 0.52, COG2_Y + 0.12, COG2_Z + 0.08, tx, 0.98, bladeBackZ(spec, tx) + 0.03, 0.09, 0.09, strut)
    w.box(0.14, 0.52, 0.1, strut, tx, 0.84, bladeBackZ(spec, tx) - 0.03)
  }
  w.beam(0, DECK_Y - 0.04, FRONT, 0, 0.44, bladeBackZ(spec, 0) + 0.03, 0.2, 0.17, trim)

  // static iron: the two cog axles, the bolster over the front axle, axle hangers and side tie rods
  const ir: THREE.BufferGeometry[] = []
  ir.push(plain(new THREE.CylinderGeometry(0.05, 0.05, 1.5, 8).rotateZ(Math.PI / 2).translate(0, COG_Y, COG_Z), iron))
  ir.push(plain(new THREE.CylinderGeometry(0.045, 0.045, 1.5, 8).rotateZ(Math.PI / 2).translate(0, COG2_Y, COG2_Z), iron))
  ir.push(plain(new THREE.BoxGeometry(1.36, 0.1, 0.22).translate(0, DECK_Y - 0.1, FRONT_Z), iron))
  for (const s of [-1, 1]) {
    ir.push(plain(new THREE.BoxGeometry(0.1, 0.2, 0.18).translate(s * RAIL_X, REAR_R + 0.0, REAR_Z), iron))
    ir.push(plain(new THREE.CylinderGeometry(0.028, 0.028, FRONT_Z - REAR_Z, 6).rotateX(Math.PI / 2).translate(s * 0.83, (REAR_R + FRONT_R) / 2 - 0.06, (FRONT_Z + REAR_Z) / 2), iron))
  }

  const lv: THREE.BufferGeometry[] = []
  lv.push(plain(new THREE.CylinderGeometry(0.04, 0.052, LEVER_LEN, 6).translate(0, LEVER_LEN / 2, 0), pale))
  lv.push(plain(new THREE.CylinderGeometry(0.06, 0.06, 0.3, 8).rotateZ(Math.PI / 2).translate(0, LEVER_LEN, 0), pale))
  lv.push(plain(new THREE.CylinderGeometry(0.09, 0.09, 0.1, 8).rotateZ(Math.PI / 2), new THREE.Color(PAL.cartGear)))

  // glowing teal strips: one on the outside of each side board (above the wheels) and one across the back of the backrest
  const by = CART_SEAT_HEIGHT - 0.06 + Math.cos(BACK_TILT) * BACK_HEIGHT * 0.55
  const bz = -0.45 - Math.sin(BACK_TILT) * BACK_HEIGHT * 0.55 - Math.cos(BACK_TILT) * 0.045
  const glow = mergeAll([
    new THREE.BoxGeometry(0.03, 0.09, 0.5).translate(-0.805, CART_SEAT_HEIGHT + 0.15, 0.04),
    new THREE.BoxGeometry(0.03, 0.09, 0.5).translate(0.805, CART_SEAT_HEIGHT + 0.15, 0.04),
    new THREE.BoxGeometry(0.95, 0.12, 0.03).rotateX(-BACK_TILT).translate(0, by, bz),
  ])

  return {
    blade: buildBlade(spec, { rise: 0.42, pow: 3.2, wave: 0.035 }),
    wood: w.build(),
    iron: mergeAll(ir),
    glow,
    rear: buildWheelPair(REAR_R, 0.2, 8, REAR_X),
    front: buildWheelPair(FRONT_R, 0.19, 8, FRONT_X),
    cogA: mergeAll([...buildCog(COG_A_OUT, 0.13, -COG_X), ...buildCog(COG_A_MID, 0.12, 0), ...buildCog(COG_A_OUT, 0.13, COG_X)]),
    cogBOut: mergeAll([...buildCog(COG_B_OUT, 0.13, -COG_X), ...buildCog(COG_B_OUT, 0.13, COG_X)]),
    cogBMid: mergeAll(buildCog(COG_B_MID, 0.12, 0)),
    lever: mergeAll(lv),
  }
}

/**
 * The cart (SPEC 2.2 / 7.4): a dark wagon with an open rear bench and a low backrest, four big spoked wheels (rear 1.24 m,
 * front 1.06 m), a block of six bronze cogs on two cross axles, two pale levers reaching back to the driver and the
 * big plank blade on BLADES.cart.poly whose tips curl up like a boat bow.
 * 13 draw calls (blade, wagon, iron, glow strips, 2 wheel pairs, 3 cog sets, 2 levers, 2 blob shadows), about 4.5k
 * triangles; all setters are a few float writes.
 */
export function makeCart(): CartModel {
  const spec = BLADES.cart
  cartGeo ??= buildCart()
  texPlank ??= plankTexture()
  texCartBlade ??= bladeTexture(
    29,
    mixc(srgb(PAL.scoopWood), srgb(PAL.scoopEnd), 0.2),
    mixc(srgb(PAL.scoopWoodMid), srgb(PAL.scoopWood), 0.1),
    srgb(PAL.scoopGrain),
    srgb(PAL.scoopEnd),
  )
  const G = cartGeo
  const root = new THREE.Group()
  root.name = 'cart'
  const woodMat = lam(0xffffff, { vertexColors: true, map: texPlank })
  const ironMat = gloss(0xffffff, { vertexColors: true, flat: true, shininess: 30, specular: 0x2c323c })
  mesh(G.blade, lam(0xffffff, { flat: false, map: texCartBlade }), root)
  mesh(G.wood, woodMat, root)
  mesh(G.iron, ironMat, root)
  mesh(G.glow, unlit(PAL.cartTeal), root)

  const rear = mesh(G.rear, ironMat, root, 0, REAR_R, REAR_Z)
  const frontAxle = new THREE.Group()
  frontAxle.position.set(0, FRONT_R, FRONT_Z)
  root.add(frontAxle)
  const front = mesh(G.front, ironMat, frontAxle)

  // three cogs on the main axle turn together; the ones they mesh with on the second axle counter-rotate
  const cogA = mesh(G.cogA, ironMat, root, 0, COG_Y, COG_Z)
  const cogBOut = mesh(G.cogBOut, ironMat, root, 0, COG2_Y, COG2_Z)
  const cogBMid = mesh(G.cogBMid, ironMat, root, 0, COG2_Y, COG2_Z)
  const RATIO_OUT = COG_A_OUT.teeth / COG_B_OUT.teeth
  const RATIO_MID = COG_A_MID.teeth / COG_B_MID.teeth
  // phase that puts a tooth of the driven cog into a gap of the driving one along the line between the two axles
  const MESH_ANGLE = Math.atan2(COG2_Z - COG_Z, COG2_Y - COG_Y)
  const PHASE_OUT = MESH_ANGLE * (1 + RATIO_OUT) + Math.PI / COG_B_OUT.teeth
  const PHASE_MID = MESH_ANGLE * (1 + RATIO_MID) + Math.PI / COG_B_MID.teeth

  const levers: THREE.Mesh[] = []
  for (const s of [1, -1]) {
    const l = mesh(G.lever, ironMat, root, s * CART_LEVER_GRIP.x, COG_Y, COG_Z)
    l.rotation.x = LEVER_REST
    levers.push(l)
  }

  const sh = blobShadow(3.4, 5.0, 0.62)
  sh.position.set(0.12, 0.014, 1.45)
  root.add(sh)
  const sh2 = blobShadow(spec.chord + 1.2, 2.4, 0.5)
  sh2.position.set(0.12, 0.013, spec.offset + spec.sagitta * 0.45 + 0.1)
  root.add(sh2)

  let travel = 0
  let cogSpin = 0
  let steer = 0
  let throttle = 0
  const applyCogs = () => {
    const a = travel / REAR_R + cogSpin
    cogA.rotation.x = a
    cogBOut.rotation.x = PHASE_OUT - a * RATIO_OUT
    cogBMid.rotation.x = PHASE_MID - a * RATIO_MID
  }
  const applyLevers = () => {
    levers[0]!.rotation.x = LEVER_REST + throttle * 0.14 - steer * 0.17
    levers[1]!.rotation.x = LEVER_REST + throttle * 0.14 + steer * 0.17
  }
  applyCogs()
  return {
    root,
    seatHeight: CART_SEAT_HEIGHT,
    setTravel(d) {
      travel = d
      rear.rotation.x = d / REAR_R
      front.rotation.x = d / FRONT_R
      applyCogs()
    },
    setSteer(s) {
      steer = s < -1 ? -1 : s > 1 ? 1 : s
      frontAxle.rotation.y = steer * STEER_YAW
      applyLevers()
    },
    setThrottle(k) {
      throttle = k < 0 ? 0 : k > 1 ? 1 : k
      applyLevers()
    },
    setCogSpin(a) {
      cogSpin = a
      applyCogs()
    },
    getGrip(side, out) {
      const a = levers[side > 0 ? 0 : 1]!.rotation.x
      return out.set(side * CART_LEVER_GRIP.x, COG_Y + Math.cos(a) * LEVER_LEN, COG_Z + Math.sin(a) * LEVER_LEN)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// gallery
// ---------------------------------------------------------------------------------------------------------------------

/** Debug overlay: the collider polyline of a blade drawn in red at the top and bottom of the wall. */
function polyLine(spec: BladeSpec): THREE.Object3D {
  const g = new THREE.Group()
  for (const y of [0.02, spec.height + 0.02]) {
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < spec.poly.length; i += 2) pts.push(new THREE.Vector3(spec.poly[i]!, y, spec.poly[i + 1]!))
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xff2030, depthTest: false }))
    l.renderOrder = 10
    g.add(l)
  }
  return g
}

const cartItem = (name: string, pose: (c: CartModel, t: number) => void, live: boolean, heading = 0): GalleryItem => ({
  name,
  size: 3.4,
  make: () => {
    const c = makeCart()
    const g = new THREE.Group()
    c.root.position.set(-2.2 * Math.sin(heading), 0, -2.2 * Math.cos(heading))
    c.root.rotation.y = heading
    g.add(c.root)
    g.userData.model = c
    pose(c, 0)
    return g
  },
  animate: live ? (o, t) => pose(o.userData.model as CartModel, t) : undefined,
})

export const GALLERY: GalleryItem[] = [
  {
    name: 'scoop',
    size: 1.7,
    make: () => {
      const g = new THREE.Group()
      const s = makeScoop()
      s.root.position.z = -0.9
      g.add(s.root)
      return g
    },
  },
  {
    // parked beside the grinder after a delivery, as at 7.0 s / 33.8 s (pushed toward -x)
    name: 'scoop-parked',
    size: 1.7,
    make: () => {
      const g = new THREE.Group()
      const s = makeScoop()
      s.root.rotation.y = -Math.PI / 2 - 0.25
      s.root.position.set(0.9, 0, 0.2)
      g.add(s.root)
      return g
    },
  },
  cartItem('cart-driving', (c, t) => {
    c.setTravel(t * 3)
    c.setSteer(Math.sin(t * 1.3))
    c.setThrottle(1)
  }, true),
  // same heading as the freshly unlocked cart at 36.8 s (f_0186)
  cartItem('cart-parked', () => {}, false, 1.15),
  {
    name: 'blade-colliders',
    size: 3.4,
    make: () => {
      const g = new THREE.Group()
      const c = makeCart()
      c.root.position.z = -2.2
      c.root.add(polyLine(BLADES.cart))
      const s = makeScoop()
      s.root.position.set(-3.1, 0, -1.2)
      s.root.add(polyLine(BLADES.scoop))
      g.add(c.root, s.root)
      return g
    },
  },
]
