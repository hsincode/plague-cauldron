// The grinder (SPEC 2.4 / 7.4): a rounded tray sunk into the dirt with two shafts of toothed steel discs.
// Origin = centre of the tray on the ground; long axis along z (L.GRINDER is axis aligned, x = 2.3 m, z = 5.1 m).
// The west side (-x) is where the flasks pop out.
import * as THREE from 'three'
import { L, PAL } from '../../config'
import { blobShadow, gloss, lam, mesh, type GalleryItem } from '../materials'

/** Tray footprint in metres, from L.GRINDER. */
export const GRINDER_WIDTH = L.GRINDER[2] - L.GRINDER[0]
export const GRINDER_DEPTH = L.GRINDER[3] - L.GRINDER[1]
/** Discs per shaft and the number of shafts (SPEC 7.4: 2 rows x 20). */
export const GRINDER_DISCS_PER_ROW = 20
// SPEC 7.4 says rows at +-0.5 and diameter 0.85; the ad's two rows almost touch, so the discs are a little larger
// and the shafts a little closer.
const ROW_X = 0.47
const DISC_R = 0.455 // tooth tips
// SPEC thickness: half of the pitch, so the dark gap between two discs is as wide as a disc and a row reads as a
// stack of thin steel coins on edge (ad, 37.0 s), not as a ribbed roller
const DISC_T = 0.12
// The game's ground is one flat plane at y = 0, so nothing can really be sunk into it: the tray floor lies just above
// the ground and the raised rim makes the inside read as a pit. The disc axles are at ground level, so only the top
// half of every disc shows (SPEC 7.4).
const FLOOR_Y = 0.012
const AXLE_Y = 0
const RIM_Y = 0.2
const RIM_W = 0.21
/** Height of the top of the discs above the ground: a bubble resting on the grinder has its bottom here. */
export const GRINDER_DISC_TOP = AXLE_Y + DISC_R
/** Local x of the two shafts (west row at -GRINDER_ROW_X, east row at +GRINDER_ROW_X), for spark/chip effects. */
export const GRINDER_ROW_X = ROW_X
/** Height of the top of the tray rim above the ground (flasks hop out over it). */
export const GRINDER_RIM_TOP = RIM_Y

export interface GrinderModel {
  /** Place at the tray centre: ((L.GRINDER[0] + L.GRINDER[2]) / 2, 0, (L.GRINDER[1] + L.GRINDER[3]) / 2). */
  root: THREE.Group
  /**
   * Disc rotation in radians (sim `Grinder.spin`; 0.5 rev/s idle, 4 rev/s while grinding). The two shafts counter-rotate
   * so that the tops of the discs move toward the gap between the rows. Costs two float writes, no matrix rebuilds.
   */
  setSpin(angle: number): void
}

/** Closed ring of points [x, z, ...] of a rounded rectangle shrunk by `inset`. Same point count for every inset. */
function ring(hw: number, hd: number, rad: number, inset: number, seg: number): number[] {
  const w = hw - inset
  const d = hd - inset
  const r = Math.max(rad - inset, 0.02)
  const out: number[] = []
  const cx = [w - r, -(w - r), -(w - r), w - r]
  const cz = [d - r, d - r, -(d - r), -(d - r)]
  for (let c = 0; c < 4; c++)
    for (let s = 0; s <= seg; s++) {
      const a = ((c + s / seg) * Math.PI) / 2
      out.push(cx[c]! + Math.cos(a) * r, cz[c]! + Math.sin(a) * r)
    }
  return out
}

function buildTray(): THREE.BufferGeometry {
  const hw = GRINDER_WIDTH / 2
  const hd = GRINDER_DEPTH / 2
  const rim = new THREE.Color(PAL.trayRim)
  const inner = new THREE.Color(PAL.trayIn)
  const edge = rim.clone().lerp(new THREE.Color(0xffffff), 0.22)
  const side = rim.clone().lerp(inner, 0.6)
  const floor = new THREE.Color(PAL.discGap)
  // profile from the outside to the inside: [inset, y, colour of the band that starts here]
  const prof: [number, number, THREE.Color][] = [
    [-0.06, 0.0, side],
    [0.012, RIM_Y - 0.025, edge],
    [0.04, RIM_Y, rim],
    [0.135, RIM_Y, edge],
    [0.152, RIM_Y - 0.018, inner],
    [0.157, 0.115, rim.clone().lerp(inner, 0.35)],
    [RIM_W - 0.012, 0.115, inner],
    [RIM_W, FLOOR_Y, floor],
  ]
  const SEG = 5
  const rings = prof.map(p => ring(hw, hd, 0.3, p[0], SEG))
  const M = rings[0]!.length / 2
  const pos: number[] = []
  const col: number[] = []
  const tri = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, c: THREE.Color) => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz)
    col.push(c.r, c.g, c.b, c.r, c.g, c.b, c.r, c.g, c.b)
  }
  for (let k = 0; k < prof.length - 1; k++) {
    const A = rings[k]!
    const B = rings[k + 1]!
    const ya = prof[k]![1]
    const yb = prof[k + 1]![1]
    const c = prof[k]![2]
    for (let j = 0; j < M; j++) {
      const j2 = (j + 1) % M
      tri(A[j * 2]!, ya, A[j * 2 + 1]!, B[j * 2]!, yb, B[j * 2 + 1]!, A[j2 * 2]!, ya, A[j2 * 2 + 1]!, c)
      tri(A[j2 * 2]!, ya, A[j2 * 2 + 1]!, B[j * 2]!, yb, B[j * 2 + 1]!, B[j2 * 2]!, yb, B[j2 * 2 + 1]!, c)
    }
  }
  const R = rings[rings.length - 1]!
  for (let j = 0; j < M; j++) {
    const j2 = (j + 1) % M
    tri(0, FLOOR_Y, 0, R[j2 * 2]!, FLOOR_Y, R[j2 * 2 + 1]!, R[j * 2]!, FLOOR_Y, R[j * 2 + 1]!, floor)
  }
  // the two dark shafts the discs sit on (static: a turning plain cylinder looks the same)
  for (const sx of [-ROW_X, ROW_X]) {
    const shaft = new THREE.CylinderGeometry(0.2, 0.2, GRINDER_DEPTH - RIM_W * 2 - 0.04, 8, 1, true).rotateX(Math.PI / 2).translate(sx, AXLE_Y, 0).toNonIndexed()
    const sp = shaft.getAttribute('position')
    for (let v = 0; v < sp.count; v++) {
      pos.push(sp.getX(v), sp.getY(v), sp.getZ(v))
      col.push(floor.r, floor.g, floor.b)
    }
    shaft.dispose()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.computeVertexNormals()
  return g
}

/**
 * One toothed disc, axis along z, centred on the origin, tooth tips at DISC_R: a thin steel wheel whose bevelled
 * rim carries the highlight, with dark faces and small pale teeth. 240 triangles.
 */
function buildDisc(): THREE.BufferGeometry {
  const steel = new THREE.Color(PAL.disc)
  const hi = new THREE.Color(PAL.discHi)
  const face = steel.clone().lerp(new THREE.Color(PAL.discGap), 0.72)
  const pos: number[] = []
  const col: number[] = []
  const h = DISC_T / 2
  const RB = 0.418 // rim radius
  // profile [radius, z, colour of the band that starts here], revolved round z
  const prof: [number, number, THREE.Color][] = [
    [0.17, -h, face],
    [RB - 0.03, -h, hi],
    [RB, -h + 0.03, steel],
    [RB, h - 0.03, hi],
    [RB - 0.03, h, face],
    [0.17, h, face],
  ]
  const SEG = 16
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const n = new THREE.Vector3()
  const o = new THREE.Vector3()
  // push a triangle, winding it so that it faces away from the core of the disc
  const tri = (colr: THREE.Color) => {
    n.subVectors(b, a).cross(o.subVectors(c, a))
    o.copy(a).add(b).add(c).multiplyScalar(1 / 3)
    const rr = Math.hypot(o.x, o.y) || 1
    o.x -= (o.x / rr) * 0.3
    o.y -= (o.y / rr) * 0.3
    const order = n.dot(o) >= 0 ? [a, b, c] : [a, c, b]
    for (const v of order) {
      pos.push(v.x, v.y, v.z)
      col.push(colr.r, colr.g, colr.b)
    }
  }
  for (let k = 0; k < prof.length - 1; k++) {
    const [r0, z0, colr] = prof[k]!
    const [r1, z1] = prof[k + 1]!
    for (let j = 0; j < SEG; j++) {
      const a0 = (j / SEG) * Math.PI * 2
      const a1 = ((j + 1) / SEG) * Math.PI * 2
      a.set(r0 * Math.cos(a0), r0 * Math.sin(a0), z0)
      b.set(r0 * Math.cos(a1), r0 * Math.sin(a1), z0)
      c.set(r1 * Math.cos(a0), r1 * Math.sin(a0), z1)
      tri(colr)
      a.set(r0 * Math.cos(a1), r0 * Math.sin(a1), z0)
      b.set(r1 * Math.cos(a1), r1 * Math.sin(a1), z1)
      c.set(r1 * Math.cos(a0), r1 * Math.sin(a0), z1)
      tri(colr)
    }
  }
  // teeth: small four-sided points standing on the rim
  const TEETH = 12
  const tw = 0.04
  const tooth = hi.clone().lerp(new THREE.Color(0xffffff), 0.3)
  for (let i = 0; i < TEETH; i++) {
    const t = (i / TEETH) * Math.PI * 2
    const cx = Math.cos(t)
    const cy = Math.sin(t)
    const base = RB - 0.006
    const corners: [number, number, number][] = [
      [base * cx + tw * cy, base * cy - tw * cx, -tw],
      [base * cx - tw * cy, base * cy + tw * cx, -tw],
      [base * cx - tw * cy, base * cy + tw * cx, tw],
      [base * cx + tw * cy, base * cy - tw * cx, tw],
    ]
    for (let k = 0; k < 4; k++) {
      a.set(...corners[k]!)
      b.set(...corners[(k + 1) % 4]!)
      c.set(DISC_R * cx, DISC_R * cy, 0)
      // wind away from the tooth's own axis
      n.subVectors(b, a).cross(o.subVectors(c, a))
      o.copy(a).add(b).add(c).multiplyScalar(1 / 3).sub(new THREE.Vector3((base + 0.01) * cx, (base + 0.01) * cy, 0))
      const order = n.dot(o) >= 0 ? [a, b, c] : [a, c, b]
      for (const v of order) {
        pos.push(v.x, v.y, v.z)
        col.push(tooth.r, tooth.g, tooth.b)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.computeVertexNormals()
  return g
}

let trayGeo: THREE.BufferGeometry | null = null
let discGeo: THREE.BufferGeometry | null = null

/**
 * The grinder tray with 2 x 20 discs (two InstancedMeshes, one per shaft, each spun by a single rotation).
 * 4 draw calls (blob shadow, tray with the shafts, two disc rows), about 9k triangles.
 */
export function makeGrinder(): GrinderModel {
  trayGeo ??= buildTray()
  discGeo ??= buildDisc()
  const root = new THREE.Group()
  root.name = 'grinder'

  // soft contact shadow, heavier on the lower-left of the screen (-x, +z)
  const sh = blobShadow(GRINDER_WIDTH + 1.7, GRINDER_DEPTH + 1.7, 0.6)
  sh.position.set(-0.25, 0.01, 0.14)
  root.add(sh)

  mesh(trayGeo, lam(0xffffff, { vertexColors: true }), root)

  const discMat = gloss(0xffffff, { vertexColors: true, flat: true, shininess: 35, specular: 0x3a3d48 })
  const pitch = (GRINDER_DEPTH - RIM_W * 2 - 0.02) / GRINDER_DISCS_PER_ROW
  const m4 = new THREE.Matrix4()
  const rows: THREE.InstancedMesh[] = []
  for (let r = 0; r < 2; r++) {
    const row = new THREE.InstancedMesh(discGeo, discMat, GRINDER_DISCS_PER_ROW)
    row.position.set(r === 0 ? -ROW_X : ROW_X, AXLE_Y, 0)
    for (let i = 0; i < GRINDER_DISCS_PER_ROW; i++) {
      // every disc is phased a little further round its shaft so the teeth form a slow helix
      m4.makeRotationZ(i * 0.19 + r * 0.31)
      m4.setPosition(0, 0, (i - (GRINDER_DISCS_PER_ROW - 1) / 2) * pitch)
      row.setMatrixAt(i, m4)
    }
    row.instanceMatrix.needsUpdate = true
    row.computeBoundingSphere()
    root.add(row)
    rows.push(row)
  }
  return {
    root,
    setSpin(angle) {
      // top of the west row moves toward +x, top of the east row toward -x
      rows[0]!.rotation.z = -angle
      rows[1]!.rotation.z = angle
    },
  }
}

export const GALLERY: GalleryItem[] = [
  {
    name: 'grinder-idle',
    size: 3.0,
    make: () => {
      const g = makeGrinder()
      g.root.userData.model = g
      return g.root
    },
    animate: (o, t) => (o.userData.model as GrinderModel).setSpin(t * Math.PI),
  },
  {
    name: 'grinder-fast',
    size: 3.0,
    make: () => {
      const g = makeGrinder()
      g.root.userData.model = g
      return g.root
    },
    animate: (o, t) => (o.userData.model as GrinderModel).setSpin(t * Math.PI * 8),
  },
]
