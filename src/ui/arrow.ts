// Guide arrow (SPEC 2.11, 8.4): one chunky extruded lime-green 3D arrow pointing down at the next thing to do.
//
//   const arrow = makeArrow()
//   scene.add(arrow.root)
//   arrow.root.position.set(guide.x, guide.y, guide.z)   // where the TIP hovers (centre of the bob)
//   arrow.update(time)                                    // every frame: bob and spin
//   arrow.setScale(s)                                     // 0 hidden .. 1 shown, for pop in / out
import * as THREE from 'three'
import { P, PAL } from '../config'
import { unlit, type GalleryItem } from '../view/materials'

/** Arrow size in metres (SPEC 8.4). */
export const ARROW = { width: 0.75, height: 0.9, thickness: 0.3 } as const
/** Bob amplitude (m), bob period (s) and spin rate (rad/s) applied by update(). */
export const ARROW_BOB = 0.4
export const ARROW_BOB_PERIOD = 0.9
export const ARROW_SPIN = (120 * Math.PI) / 180

/** Linear brightness of the unlit arrow relative to its PAL colours (see arrowGeometry). */
const ARROW_LEVEL = 0.94

let geo: THREE.BufferGeometry | null = null

/** Extruded arrow with its tip at the origin pointing down (-y), centred in z, vertex-coloured by facing. */
function arrowGeometry(): THREE.BufferGeometry {
  if (geo) return geo
  const bevel = 0.045
  const hw = ARROW.width / 2 - bevel
  const top = ARROW.height - bevel
  const shaft = 0.135 // half width of the shaft's flat face: with the bevel the shaft is 0.48 x the head, as in the ad
  const neck = 0.42
  // outline, counter-clockwise, starting at the tip
  const pts: [number, number][] = [
    [0, bevel * 1.2],
    [hw, neck],
    [shaft, neck],
    [shaft, top],
    [-shaft, top],
    [-shaft, neck],
    [-hw, neck],
  ]
  // round every corner a little
  const shape = new THREE.Shape()
  const r = 0.05
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const p = pts[i]!
    const a = pts[(i + n - 1) % n]!
    const b = pts[(i + 1) % n]!
    const la = Math.hypot(a[0] - p[0], a[1] - p[1])
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1])
    const ax = p[0] + ((a[0] - p[0]) / la) * r
    const ay = p[1] + ((a[1] - p[1]) / la) * r
    const bx = p[0] + ((b[0] - p[0]) / lb) * r
    const by = p[1] + ((b[1] - p[1]) / lb) * r
    if (i === 0) shape.moveTo(ax, ay)
    else shape.lineTo(ax, ay)
    shape.quadraticCurveTo(p[0], p[1], bx, by)
  }
  shape.closePath()
  const depth = ARROW.thickness - bevel * 2
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 3 })
  g.translate(0, 0, -depth / 2)
  // the corner rounding eats a few centimetres: normalise to exactly ARROW.width x ARROW.height with the tip at y = 0
  g.computeBoundingBox()
  const bb = g.boundingBox!
  g.translate(0, -bb.min.y, 0)
  g.scale(ARROW.width / (bb.max.x - bb.min.x), ARROW.height / (bb.max.y - bb.min.y), 1)
  g.computeVertexNormals()
  // colour by facing: flat lime faces, lighter top bevel, darker sides and underside (the "toon" look of the ad)
  // (scaled to stay just under the stage's bloom knee: a little halo, never a blown-out blob)
  const face = new THREE.Color(PAL.arrow).multiplyScalar(ARROW_LEVEL)
  const light = new THREE.Color(PAL.arrowBevel).multiplyScalar(ARROW_LEVEL)
  const dark = new THREE.Color(PAL.arrow).multiplyScalar(0.42 * ARROW_LEVEL)
  const nrm = g.getAttribute('normal')
  const colors = new Float32Array(nrm.count * 3)
  const c = new THREE.Color()
  for (let i = 0; i < nrm.count; i++) {
    const ny = nrm.getY(i)
    const nz = Math.abs(nrm.getZ(i))
    // the ad's arrow is nearly one flat lime: tops only a little lighter, sides and underside a little deeper
    if (nz > 0.92) c.copy(face)
    else if (ny > 0) c.copy(face).lerp(light, Math.min(0.6, ny * 0.6 + 0.1))
    else c.copy(face).lerp(dark, Math.min(1, 0.1 - ny * 0.4 + (1 - nz) * 0.12))
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return (geo = g)
}

export interface GuideArrow {
  /**
   * Origin = the point where the arrow's TIP hovers at the middle of its bob. Put it P.ARROW_HOVER (2.6-3.0 m)
   * above the target; the simulation's guide.x / guide.y / guide.z can be copied straight in.
   */
  root: THREE.Group
  /** Per-frame animation, t = seconds: bobs +-0.4 m with a 0.9 s period and spins 120 deg/s about the vertical. */
  update(t: number): void
  /** Pop scale: 0 hides the arrow, 1 = full size (in over 2-4 frames, out over 3-5 frames, SPEC 2.11). */
  setScale(s: number): void
}

/** The chunky green down-arrow: 0.75 m wide, 0.9 m tall, 0.3 m thick, unlit (it must glow in the night scene). */
export function makeArrow(): GuideArrow {
  const root = new THREE.Group()
  const body = new THREE.Mesh(arrowGeometry(), unlit(0xffffff, { vertexColors: true, fog: false }))
  body.userData.ui = true
  root.add(body)
  return {
    root,
    update(t) {
      body.position.y = Math.sin((t * Math.PI * 2) / ARROW_BOB_PERIOD) * ARROW_BOB
      body.rotation.y = (t * ARROW_SPIN) % (Math.PI * 2)
    },
    setScale(s) {
      root.visible = s > 0.002
      body.scale.setScalar(s)
    },
  }
}

export const GALLERY: GalleryItem[] = [
  {
    name: 'arrow',
    size: 1.2,
    make: () => {
      const g = new THREE.Group()
      const a = makeArrow()
      a.root.position.y = P.ARROW_HOVER * 0.4
      g.add(a.root)
      g.userData.a = a
      return g
    },
    animate: (o, t) => (o.userData.a as GuideArrow).update(t),
  },
  {
    name: 'arrow-pop',
    size: 1.2,
    make: () => {
      const g = new THREE.Group()
      const a = makeArrow()
      a.root.position.y = P.ARROW_HOVER * 0.4
      g.add(a.root)
      g.userData.a = a
      return g
    },
    animate: (o, t) => {
      const a = o.userData.a as GuideArrow
      const k = t % 2
      a.update(t)
      a.setScale(k < 0.1 ? k / 0.1 : k > 1.7 ? Math.max(0, 1 - (k - 1.7) / 0.13) : 1)
    },
  },
]
