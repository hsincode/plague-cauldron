// Ward and courtyard furniture (SPEC 7.4): bed, coin pallet, side table with basin, bursar chest.
// Every prop is merged into one vertex-coloured geometry (cached and shared between instances), so a bed costs one
// draw call plus its blob shadow. All props are static: put `root` where config.ts says and forget about it.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { L, P, PAL } from '../../config'
import { blobShadow, lam, type GalleryItem } from '../materials'
import { createCoinMesh, stackY } from './coin'

// ---------------------------------------------------------------------------------------------------------------
// geometry helpers (private)

const _c = new THREE.Color()
/** Linear blend of two palette colours. */
const tone = (a: number, b: number, t: number) => new THREE.Color(a).lerp(_c.set(b), t)
/** Palette colour scaled in brightness. */
const shade = (a: number, f: number) => new THREE.Color(a).multiplyScalar(f)

/** Bake one colour into a geometry (returned non-indexed, without uv) so parts can be merged into one mesh. */
function paint(g: THREE.BufferGeometry, color: number | THREE.Color): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g
  out.deleteAttribute('uv')
  const c = typeof color === 'number' ? new THREE.Color(color) : color
  const n = out.getAttribute('position').count
  const a = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r
    a[i * 3 + 1] = c.g
    a[i * 3 + 2] = c.b
  }
  out.setAttribute('color', new THREE.BufferAttribute(a, 3))
  return out
}

function box(w: number, h: number, d: number, color: number | THREE.Color, x: number, y: number, z: number, ry = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  if (ry) g.rotateY(ry)
  g.translate(x, y, z)
  return paint(g, color)
}

/** Box with chamfered edges, centred on the origin (w along x, h along y, d along z). */
function softBoxGeo(w: number, h: number, d: number, b: number, seg = 1): THREE.BufferGeometry {
  const hw = w / 2 - b
  const hd = d / 2 - b
  const s = new THREE.Shape()
  s.moveTo(-hw, -hd)
  s.lineTo(hw, -hd)
  s.lineTo(hw, hd)
  s.lineTo(-hw, hd)
  s.closePath()
  const g = new THREE.ExtrudeGeometry(s, { depth: h - 2 * b, bevelEnabled: true, bevelSize: b, bevelThickness: b, bevelSegments: seg, steps: 1 })
  g.rotateX(-Math.PI / 2)
  g.translate(0, -(h / 2 - b), 0)
  return g
}
function softBox(w: number, h: number, d: number, b: number, color: number | THREE.Color, x: number, y: number, z: number, ry = 0, seg = 1): THREE.BufferGeometry {
  const g = softBoxGeo(w, h, d, b, seg)
  if (ry) g.rotateY(ry)
  g.translate(x, y, z)
  return paint(g, color)
}

/** Flat polygon slab: `pts` are (x, z) pairs in counter-clockwise order seen from above, y from y0 to y1. */
function slab(pts: number[], y0: number, y1: number, color: number | THREE.Color): THREE.BufferGeometry {
  const s = new THREE.Shape()
  for (let i = 0; i < pts.length; i += 2) {
    if (i === 0) s.moveTo(pts[i]!, -pts[i + 1]!)
    else s.lineTo(pts[i]!, -pts[i + 1]!)
  }
  s.closePath()
  const g = new THREE.ExtrudeGeometry(s, { depth: y1 - y0, bevelEnabled: false })
  g.rotateX(-Math.PI / 2)
  g.translate(0, y0, 0)
  return paint(g, color)
}

const solid = () => lam(0xffffff, { vertexColors: true })

function finish(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!
  for (const p of parts) p.dispose()
  g.computeBoundingSphere()
  return g
}

// ---------------------------------------------------------------------------------------------------------------
// bed

export interface BedModel {
  /** Origin on the floor at the footprint centre (config BEDS[i]). Footprint P.BED_W along x, P.BED_D along z; the head (pillow, headboard) is at +x. */
  root: THREE.Group
  /** Height of the lying surface (top of the blanket, = BED_TOP_Y 0.52) above the floor: the patient's body rests on it. */
  readonly topY: number
  /** Local x of the pillow centre (the patient's head rests about 0.25 m short of it, at z = 0). */
  readonly pillowX: number
  /** Local x of the headboard top centre and its height (1.0): anchor for the "needs nurse" / cure bubbles (SPEC 8.3: 1.8 m above the bed head). */
  readonly headX: number
  readonly headY: number
}

/**
 * Height of the top of the blanket (lying surface). SPEC 7.4 says mattress top 0.55; the ad's foot posts (0.6) stand
 * clearly proud of the bedding (17.0 s), so the bedding is built a little lower.
 */
export const BED_TOP_Y = 0.52
const MATTRESS_TOP = 0.47
const FOOT_POST = 0.62
const HEAD_POST = 1.0

let bedGeo: THREE.BufferGeometry | null = null
function bedGeometry(): THREE.BufferGeometry {
  if (bedGeo) return bedGeo
  const W = P.BED_W
  const D = P.BED_D
  const post = 0.2 // SPEC 7.4 says 0.14; the ad's posts are chunkier (about 0.07 H, art.md 2.16)
  const px = W / 2 - post / 2
  const pz = D / 2 - post / 2
  // The ambient rig shows an albedo at full value on top faces and at about 0.57 on side faces, so the frame is
  // painted a little lighter than PAL.bedFrame (toward the lit tone of art.md 2.16): its sides then come out near it.
  const wood = tone(PAL.bedFrame, PAL.scoopEnd, 0.22)
  const woodLit = tone(PAL.bedFrame, PAL.scoopEnd, 0.34)
  const woodDark = shade(PAL.bedFrame, 0.72)
  const parts: THREE.BufferGeometry[] = []
  // posts: low at the foot (-x), tall at the head (+x)
  for (const sz of [-1, 1]) {
    parts.push(softBox(post, FOOT_POST, post, 0.025, woodLit, -px, FOOT_POST / 2, sz * pz))
    parts.push(softBox(post, HEAD_POST, post, 0.025, woodLit, px, HEAD_POST / 2, sz * pz))
    // side rails: a wide plank whose lower half shows under the blanket
    parts.push(box(W - 2 * post, 0.26, 0.08, wood, 0, 0.23, sz * pz))
  }
  // footboard
  parts.push(box(0.08, 0.36, D - 2 * post, wood, -px, 0.3, 0))
  // headboard: plank with a gently arched top
  {
    const hw = D / 2 - post
    const s = new THREE.Shape()
    s.moveTo(-hw, 0.12)
    s.lineTo(hw, 0.12)
    s.lineTo(hw, 0.76)
    s.quadraticCurveTo(hw * 0.55, 0.79, hw * 0.4, 0.88)
    s.quadraticCurveTo(0, 0.95, -hw * 0.4, 0.88)
    s.quadraticCurveTo(-hw * 0.55, 0.79, -hw, 0.76)
    s.closePath()
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.09, bevelEnabled: false, curveSegments: 5 })
    g.rotateY(Math.PI / 2)
    g.translate(px - 0.045, 0, 0)
    parts.push(paint(g, wood))
  }
  // slats (hide the floor under the mattress when seen from the side)
  parts.push(box(W - 2 * post, 0.05, D - 2 * post, woodDark, 0, 0.17, 0))
  // mattress + sheet
  const sheet = shade(tone(PAL.pillow, PAL.cream, 0.5).getHex(), 0.86)
  parts.push(softBox(W - 2 * post, 0.28, D - 0.3, 0.04, sheet, 0, MATTRESS_TOP - 0.14, 0))
  // blanket over 80 % of the length from the foot: a puffy slab that hangs over the side rails
  const bx0 = -W / 2 + post - 0.06
  const bx1 = bx0 + 0.8 * (W - 2 * post)
  const bz = D / 2 - 0.025
  const bh = 0.3
  parts.push(softBox(bx1 - bx0, bh, bz * 2, 0.085, PAL.blanket, (bx0 + bx1) / 2, BED_TOP_Y - bh / 2, 0, 0, 2))
  // head-end corner turned back on the near (+z) side: a slightly paler triangular flap and one diagonal crease
  const ax = bx1 + 0.02 // crease start on the head edge ...
  const az = -bz * 0.3
  const cx = bx1 - 0.66 // ... and its end on the near side edge
  const cz = bz - 0.01
  parts.push(slab([ax, az, cx, cz, ax, cz], BED_TOP_Y - 0.22, BED_TOP_Y + 0.022, tone(PAL.blanket, PAL.pillow, 0.1)))
  {
    const len = Math.hypot(ax - cx, cz - az)
    const g = new THREE.BoxGeometry(0.035, 0.012, len)
    g.rotateY(Math.atan2(cx - ax, cz - az))
    g.translate((ax + cx) / 2 - 0.028, BED_TOP_Y + 0.012, (az + cz) / 2 - 0.012)
    parts.push(paint(g, shade(PAL.blanket, 0.62)))
  }
  // pillow
  parts.push(softBox(0.5, 0.2, D - 0.52, 0.075, tone(PAL.pillow, PAL.cream, 0.12), W / 2 - post - 0.27, MATTRESS_TOP + 0.085, 0, 0.03, 2))
  bedGeo = finish(parts)
  return bedGeo
}

/** Hospital bed (SPEC 7.4). Static; the patient, nurse and bubbles are separate models. */
export function makeBed(): BedModel {
  const root = new THREE.Group()
  const sh = blobShadow(P.BED_W + 1.1, P.BED_D + 1.1, 0.5)
  sh.position.set(0.12, 0.015, 0.12)
  root.add(sh, new THREE.Mesh(bedGeometry(), solid()))
  return { root, topY: BED_TOP_Y, pillowX: P.BED_W / 2 - 0.47, headX: P.BED_W / 2 - 0.1, headY: HEAD_POST }
}

// ---------------------------------------------------------------------------------------------------------------
// pallet

/** Height of the plank surface of the pallet: the first coin of a stack rests on it. */
export const PALLET_TOP_Y = 0.12
/** Local (x, z) of the four coin stacks, in round-robin landing order (SPEC 2.8: 2x2 grid). */
export const PALLET_SLOTS: readonly { x: number; z: number }[] = [
  { x: -0.31, z: -0.29 },
  { x: 0.31, z: -0.29 },
  { x: -0.31, z: 0.29 },
  { x: 0.31, z: 0.29 },
]

/**
 * Pallet-local position of the CENTRE of the `index`-th coin landed on the pallet (0-based, round-robin over the
 * four stacks: slot = index % 4, layer = floor(index / 4)). Add the pallet position (L.PALLET) to get world space.
 */
export function palletCoinPos(index: number, out: THREE.Vector3): THREE.Vector3 {
  const s = PALLET_SLOTS[index & 3]!
  return out.set(s.x, stackY(index >> 2, PALLET_TOP_Y), s.z)
}

export interface PalletModel {
  /** Origin on the floor at the footprint centre (L.PALLET). L.PALLET.w along x, L.PALLET.d along z. */
  root: THREE.Group
  /** Height of the plank surface (= PALLET_TOP_Y). */
  readonly topY: number
}

let palletGeo: THREE.BufferGeometry | null = null
function palletGeometry(): THREE.BufferGeometry {
  if (palletGeo) return palletGeo
  const { w: W, d: D, h: H } = L.PALLET
  const fr = 0.085 // frame bar width
  const parts: THREE.BufferGeometry[] = []
  const frame = PAL.palletFrame
  const frameLit = tone(PAL.palletFrame, PAL.palletPlank, 0.35)
  // stepped skirt + frame
  parts.push(box(W, 0.06, D, shade(frame, 0.8), 0, 0.03, 0))
  const iw = W - 0.05
  const id = D - 0.05
  for (const s of [-1, 1]) {
    parts.push(box(iw, H - 0.06, fr, frameLit, 0, 0.06 + (H - 0.06) / 2, s * (id / 2 - fr / 2)))
    parts.push(box(fr, H - 0.06, id - 2 * fr, frameLit, s * (iw / 2 - fr / 2), 0.06 + (H - 0.06) / 2, 0))
  }
  // recessed planks running along x
  const n = 6
  const span = id - 2 * fr
  const pw = span / n
  for (let i = 0; i < n; i++) {
    const z = -span / 2 + pw * (i + 0.5)
    const c = shade(PAL.palletPlank, 0.9 + 0.14 * ((i * 7) % 3) * 0.5)
    parts.push(box(iw - 2 * fr, PALLET_TOP_Y - 0.06, pw - 0.014, c, 0, 0.06 + (PALLET_TOP_Y - 0.06) / 2, z))
  }
  parts.push(box(iw - 2 * fr, 0.02, span, shade(frame, 0.6), 0, 0.07, 0)) // dark gaps between planks
  // corner brackets with a bolt: barely lighter than the frame (ad 24.0 s: only small bolts catch the eye)
  const bracket = tone(PAL.palletFrame, PAL.disc, 0.3)
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const cx = sx * (iw / 2 - 0.1)
      const cz = sz * (id / 2 - 0.1)
      parts.push(box(0.2, 0.014, fr + 0.004, bracket, cx, H + 0.005, sz * (id / 2 - fr / 2)))
      parts.push(box(fr + 0.004, 0.014, 0.2, bracket, sx * (iw / 2 - fr / 2), H + 0.005, cz))
      parts.push(box(0.035, 0.018, 0.035, PAL.disc, sx * (iw / 2 - fr / 2), H + 0.016, sz * (id / 2 - fr / 2)))
    }
  palletGeo = finish(parts)
  return palletGeo
}

/** Coin pallet (SPEC 2.8, 7.4). Coins are drawn by the shared CoinMesh at palletCoinPos(). */
export function makePallet(): PalletModel {
  const root = new THREE.Group()
  const sh = blobShadow(L.PALLET.w + 0.9, L.PALLET.d + 0.9, 0.5)
  sh.position.set(0.08, 0.015, 0.08)
  root.add(sh, new THREE.Mesh(palletGeometry(), solid()))
  return { root, topY: PALLET_TOP_Y }
}

// ---------------------------------------------------------------------------------------------------------------
// side table

export interface SideTableModel {
  /** Origin on the floor at the footprint centre (L.SIDE_TABLE), footprint 0.8 x 0.8, table top at 0.55. The cloth hangs toward +x/+z. */
  root: THREE.Group
}

let tableGeo: THREE.BufferGeometry | null = null
function tableGeometry(): THREE.BufferGeometry {
  if (tableGeo) return tableGeo
  const S = L.SIDE_TABLE.s
  const T = 0.55
  const wood = PAL.tableWood
  const dark = shade(PAL.tableWood, 0.7)
  const parts: THREE.BufferGeometry[] = []
  parts.push(softBox(S, 0.07, S, 0.015, wood, 0, T - 0.035, 0))
  const lx = S / 2 - 0.09
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(box(0.1, T - 0.07, 0.1, dark, sx * lx, (T - 0.07) / 2, sz * lx))
    parts.push(box(0.04, 0.09, 2 * lx, wood, sx * lx, T - 0.115, 0))
    parts.push(box(2 * lx, 0.09, 0.04, wood, 0, T - 0.115, sx * lx))
  }
  // basin: shallow bowl with a thick rim. LatheGeometry faces outward when the profile runs bottom -> top.
  {
    const lathe = (pts: number[][], color: number | THREE.Color) => {
      const g = new THREE.LatheGeometry(pts.map(p => new THREE.Vector2(p[0], p[1])), 14)
      g.translate(-0.03, T, -0.02)
      return paint(g, color)
    }
    parts.push(lathe([[0, 0], [0.22, 0], [0.315, 0.1], [0.33, 0.17]], PAL.basin)) // outside
    parts.push(lathe([[0.33, 0.17], [0.322, 0.19], [0.295, 0.19], [0.285, 0.165]], tone(PAL.basin, PAL.cream, 0.4))) // rim
    parts.push(lathe([[0.285, 0.165], [0.265, 0.12], [0.19, 0.04], [0, 0.04]], shade(PAL.basin, 0.8))) // inside
  }
  // cloth draped over the rim toward +x/+z
  {
    const a = -Math.PI / 4 // direction (+x, +z)
    const g1 = new THREE.BoxGeometry(0.19, 0.03, 0.26)
    g1.rotateZ(-0.5)
    g1.translate(0.3, T + 0.185, 0)
    const g2 = new THREE.BoxGeometry(0.03, 0.16, 0.26)
    g2.rotateZ(0.2)
    g2.translate(0.375, T + 0.08, 0)
    for (const g of [g1, g2]) {
      g.rotateY(a)
      g.translate(-0.03, 0, -0.02)
    }
    parts.push(paint(g1, tone(PAL.basinCloth, PAL.shirt, 0.6)), paint(g2, tone(PAL.basinCloth, PAL.shirt, 0.2)))
  }
  tableGeo = finish(parts)
  return tableGeo
}

/** Bedside table with a pale basin and a blue-white cloth (SPEC 7.4 scenery). */
export function makeSideTable(): SideTableModel {
  const root = new THREE.Group()
  const sh = blobShadow(L.SIDE_TABLE.s + 0.7, L.SIDE_TABLE.s + 0.7, 0.45)
  sh.position.set(0.06, 0.015, 0.06)
  root.add(sh, new THREE.Mesh(tableGeometry(), solid()))
  return { root }
}

// ---------------------------------------------------------------------------------------------------------------
// bursar chest

export interface ChestModel {
  /** Origin on the floor at the footprint centre (L.BURSAR_CHEST). 0.85 wide (x), 0.55 deep (z), 0.68 tall closed; the lock faces +z. */
  root: THREE.Group
  /** Lid angle: 0 = closed, 1 = fully open (lid swung back 100 deg, gold visible). makeChest() starts at 0.35 (ajar, a glint of gold shows). */
  setOpen(k: number): void
}

let chestBodyGeo: THREE.BufferGeometry | null = null
let chestLidGeo: THREE.BufferGeometry | null = null
const CHEST_W = 0.85
const CHEST_D = 0.55
const CHEST_H = 0.4 // top of the body = lid hinge height

function chestGeometries(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  if (chestBodyGeo && chestLidGeo) return [chestBodyGeo, chestLidGeo]
  const wood = PAL.cartWood
  const dark = PAL.cartDark
  const metal = PAL.cartGear
  const body: THREE.BufferGeometry[] = []
  body.push(box(CHEST_W + 0.05, 0.07, CHEST_D + 0.05, dark, 0, 0.035, 0))
  body.push(box(CHEST_W, CHEST_H - 0.04, CHEST_D, wood, 0, 0.04 + (CHEST_H - 0.04) / 2, 0))
  for (const sx of [-1, 1]) {
    body.push(box(0.08, CHEST_H - 0.03, CHEST_D + 0.03, metal, sx * 0.25, 0.04 + (CHEST_H - 0.04) / 2, 0))
    for (const sz of [-1, 1]) body.push(box(0.07, CHEST_H - 0.03, 0.07, dark, sx * (CHEST_W / 2 - 0.02), 0.04 + (CHEST_H - 0.04) / 2, sz * (CHEST_D / 2 - 0.02)))
  }
  body.push(box(0.13, 0.15, 0.04, PAL.gold, 0, CHEST_H - 0.07, CHEST_D / 2 + 0.01)) // lock plate
  body.push(box(0.04, 0.05, 0.05, dark, 0, CHEST_H - 0.09, CHEST_D / 2 + 0.02))
  // gold inside (visible when the lid is open)
  body.push(softBox(CHEST_W - 0.1, 0.09, CHEST_D - 0.1, 0.03, PAL.coin, 0, CHEST_H + 0.005, 0))
  for (let i = 0; i < 9; i++) {
    const g = new THREE.CylinderGeometry(0.1, 0.1, 0.03, 10)
    g.rotateX((((i * 37) % 11) / 11 - 0.5) * 0.9)
    g.rotateZ((((i * 53) % 7) / 7 - 0.5) * 0.9)
    g.translate(-0.27 + (i % 3) * 0.27 + (((i * 5) % 4) - 1.5) * 0.02, CHEST_H + 0.06 + ((i * 3) % 4) * 0.012, -0.13 + Math.floor(i / 3) * 0.13)
    body.push(paint(g, i % 2 ? PAL.coinRim : tone(PAL.coin, PAL.coinRim, 0.5)))
  }
  chestBodyGeo = finish(body)

  // lid, modelled relative to its hinge (back top edge of the body): the dome spans z = 0 .. CHEST_D
  const lid: THREE.BufferGeometry[] = []
  const r = CHEST_D / 2
  const dome = (radius: number, len: number, color: number, x: number) => {
    const g = new THREE.CylinderGeometry(radius, radius, len, 10, 1, false, 0, Math.PI)
    g.rotateZ(Math.PI / 2)
    g.translate(x, 0, r)
    return paint(g, color)
  }
  lid.push(dome(r, CHEST_W, wood, 0))
  for (const sx of [-1, 1]) {
    lid.push(dome(r + 0.015, 0.08, metal, sx * 0.25))
    lid.push(dome(r + 0.012, 0.05, dark, sx * (CHEST_W / 2 - 0.02)))
  }
  lid.push(box(CHEST_W - 0.02, 0.012, CHEST_D - 0.02, shade(dark, 0.7), 0, 0.012, r)) // inside of the lid
  lid.push(box(0.13, 0.05, 0.035, PAL.gold, 0, 0.03, CHEST_D + 0.008)) // hasp
  chestLidGeo = finish(lid)
  return [chestBodyGeo, chestLidGeo]
}

/** Small coin chest of the bursar helper (SPEC 2.12), standing beside the pallet. */
export function makeChest(): ChestModel {
  const root = new THREE.Group()
  const [bodyGeo, lidGeo] = chestGeometries()
  const sh = blobShadow(CHEST_W + 0.7, CHEST_D + 0.7, 0.45)
  sh.position.set(0.05, 0.015, 0.05)
  const lid = new THREE.Mesh(lidGeo, solid())
  lid.position.set(0, CHEST_H, -CHEST_D / 2)
  root.add(sh, new THREE.Mesh(bodyGeo, solid()), lid)
  const model: ChestModel = {
    root,
    setOpen(k) {
      lid.rotation.x = -1.75 * (k < 0 ? 0 : k > 1 ? 1 : k)
    },
  }
  model.setOpen(0.35)
  return model
}

// ---------------------------------------------------------------------------------------------------------------
// gallery

function gPallet(nCoins: number): THREE.Object3D {
  const g = new THREE.Group()
  g.add(makePallet().root)
  if (nCoins > 0) {
    const coins = createCoinMesh(nCoins)
    const v = new THREE.Vector3()
    for (let i = 0; i < nCoins; i++) {
      palletCoinPos(i, v)
      coins.put(i, v.x, v.y, v.z, i * 2.4)
    }
    coins.commit(nCoins)
    g.add(coins.mesh)
  }
  return g
}

function gChest(): THREE.Object3D {
  const c = makeChest()
  c.root.userData.model = c
  return c.root
}

export const GALLERY: GalleryItem[] = [
  { name: 'bed', size: 1.7, make: () => makeBed().root },
  { name: 'pallet empty', size: 1.1, make: () => gPallet(0) },
  { name: 'pallet 4 coins', size: 1.1, make: () => gPallet(4) },
  { name: 'pallet 25 coins', size: 1.1, make: () => gPallet(25) },
  { name: 'pallet 50 coins', size: 1.1, make: () => gPallet(50) },
  { name: 'side table', size: 0.7, make: () => makeSideTable().root },
  { name: 'chest', size: 0.7, make: gChest },
  { name: 'chest opening', size: 0.7, make: gChest, animate: (o, t) => (o.userData.model as ChestModel).setOpen(0.5 - 0.5 * Math.cos(t * 2)) },
]

