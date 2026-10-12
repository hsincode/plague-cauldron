// The drill cart (SPEC 2.10, 7.4, 9 rows 23-24): a two-wheeled carriage like a field gun. Octagonal steel housing on
// the axle, a big threaded cone drill pointing +z (nose dipped toward the ground), and a rear V-handle with a
// crossbar where the two healed villagers push.
//
// Local frame: origin = ground point under the axle (the housing centre is 0.2 m ahead of it), +z = cone direction
// (heading), +x = right. The cart spans z = -1.43 (handle ends) .. +2.67 (cone tip) and x = +-0.87 (wheels).
// All the anchor points a binder needs are in DRILL (below), already including the nose-down tilt:
//   crossbar  y 1.01, z -1.00, x -0.42 .. +0.42   (L.DRILL_HANDLE is this point for the parked cart)
//   crew feet (-0.30, -1.45) and (0.27, -1.40)     (just clear of the ward wall when parked at L.DRILL_PARK)
//   cone tip  y 0.43, z 2.67
// Look (ad 24.4-24.6 s): warm silver faceted housing and flared handle arms, light steel collar, dark hex nut,
// blue steel cone of five stacked bands separated by one dark helical groove, thin dark spoked wheels.
// Cost: 4 draw calls (blob shadow, body, both wheels, nut + cone) + 1 additive overlay while glowing; about 3 k triangles.
// Post-process: everything is ordinary outlined geometry; the heat glow is an additive overlay (never outlined).
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { PAL } from '../../config'
import { blobShadow, gloss, lam, unlit, type GalleryItem } from '../materials'

const WHEEL_R = 0.55
const AXLE_Y = WHEEL_R
const TRACK = 0.78 // |x| of the wheel centres
const TILT = (6 * Math.PI) / 180 // nose-down pitch of housing + cone + handle about the axle
const HOUSING_AF = 0.95 // across flats (SPEC 7.4: 0.9)
const HOUSING_LEN = 0.8
const HOUSING_Y = 0.16 // above the axle
const HOUSING_Z = 0.2 // the housing sits a little ahead of the axle, which keeps the handle clear of the ward wall when parked
// The cone is the hero of the model. SPEC 7.4 says length 1.4 / base 0.9, but in the ad frames (24.4-24.6 s) its base
// is as wide as a wheel (1.1-1.2 m) and the spinning part (nut + cone) is about 1.7 m long, so it is built to the frames.
const CONE_LEN = 1.5
const CONE_R = 0.535 // envelope radius at the base; the band lips stand 8 % proud of it (0.58)
const NUT_R = 0.64
const NUT_LEN = 0.2
const COLLAR_R = 0.41
const CONE_Z = HOUSING_Z + HOUSING_LEN / 2 + 0.06 + 0.32 // start of the spinning part (nut, then cone), after the fixed collar
const REAR_Z = HOUSING_Z - (HOUSING_LEN / 2 + 0.3) // where the two handle arms meet behind the housing
// Handle bars 1.2 m long (SPEC 7.4 says 1.9): with L.DRILL_PARK 2.0 m south of the ward wall and the cart turned
// 27 deg, anything reaching more than 1.5 m behind the origin would stick into the wall or its corner post; this also
// puts the crossbar 1.0 m behind the origin, which is where config L.DRILL_HANDLE lies. (The ad's bars measure
// about 1.3 m at 24.5 s, so this is also what the footage shows.)
const ARM_ROOT = { x: 0.12, y: HOUSING_Y + 0.02, z: REAR_Z }
const ARM_END = { x: 0.66, y: HOUSING_Y + 0.34, z: REAR_Z - 1.0 }
const BAR_T = 0.55 // crossbar position along the arms

/** Tilt a point given in the un-tilted assembly frame (y relative to the axle) into the drill's local frame. */
const tiltY = (y: number, z: number) => AXLE_Y + y * Math.cos(TILT) - z * Math.sin(TILT)
const tiltZ = (y: number, z: number) => y * Math.sin(TILT) + z * Math.cos(TILT)
const barY = ARM_ROOT.y + (ARM_END.y - ARM_ROOT.y) * BAR_T
const barZ = ARM_ROOT.z + (ARM_END.z - ARM_ROOT.z) * BAR_T

/**
 * Anchor points in the drill's local frame (metres; rotate by the drill heading and add its position for world space:
 * worldX = x + lx * cos(h) + lz * sin(h), worldZ = z - lx * sin(h) + lz * cos(h), see core/math rotX/rotZ).
 */
export const DRILL = {
  /** Push crossbar between the two handle arms: runs along x from -halfWidth to +halfWidth at (y, z). Hands go here. */
  crossbar: { y: tiltY(barY, barZ), z: tiltZ(barY, barZ), halfWidth: ARM_ROOT.x + (ARM_END.x - ARM_ROOT.x) * BAR_T },
  /** Where the two crew members stand (feet, local x/z), facing +z, leaning onto the crossbar. Index 0 arrives first. */
  crew: [
    { x: -0.3, z: tiltZ(barY, barZ) - 0.45 },
    { x: 0.27, z: tiltZ(barY, barZ) - 0.4 },
  ],
  /** Tip of the cone: sparks, the rat-kill point and the coin fountain start here. */
  tip: { y: tiltY(HOUSING_Y, CONE_Z + NUT_LEN + CONE_LEN), z: tiltZ(HOUSING_Y, CONE_Z + NUT_LEN + CONE_LEN) },
  /** Rear end of the handle arms (the cart spans z = rearZ .. tip.z, about 4.2 m) and their height there. */
  rearZ: tiltZ(ARM_END.y, ARM_END.z),
  rearY: tiltY(ARM_END.y, ARM_END.z),
  /** Half of the overall width (outer wheel faces). */
  halfWidth: TRACK + 0.09,
  /** Wheel radius: roll angle = distance travelled / wheelRadius (see DrillModel.setRoll). */
  wheelRadius: WHEEL_R,
} as const

export interface DrillModel {
  /** Origin on the ground under the housing (sim Drill.x/z), rotation.y = heading; the cone points along local +z. */
  root: THREE.Group
  /** Absolute rotation angle of the cone about its axis (radians): pass sim Drill.spin. The thread visibly screws. */
  setSpin(angle: number): void
  /** Heat of the cone, 0..1: 0 = cold steel, 1 = dull red at the base to orange and yellow-white at the tip (during the rat kill). Works with setGold. */
  setGlow(k: number): void
  /** Drill Mk II (SPEC 2.12): the cone and its nut are tinted gold. Cheap (one colour write); call any time. */
  setGold(gold: boolean): void
  /** Optional: wheel roll angle in radians (= distance pushed / DRILL.wheelRadius, positive when moving toward +z). */
  setRoll(angle: number): void
  /**
   * Optional: extra nose-down pitch in radians of everything that rides on the axle (housing, cone, handle), for rattle
   * and follow-through. Keep it within a few degrees: the wheels and the shadow stay put and DRILL's anchors do not move.
   */
  setRock(pitch: number): void
}

// ---------------------------------------------------------------------------------------------------------------
// geometry (shared)

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
const shade = (c: number, f: number) => new THREE.Color(c).multiplyScalar(f)
const blend = (a: number, b: number, t: number) => new THREE.Color(a).lerp(new THREE.Color(b), t)

let bodyGeo: THREE.BufferGeometry | null = null
let wheelsGeo: THREE.BufferGeometry | null = null
let bitGeo: THREE.BufferGeometry | null = null
let heatGeo: THREE.BufferGeometry | null = null

/**
 * Static steel: housing, rear stub, front collar, axle, two handle arms and the crossbar, vertex-coloured and
 * flat-shaded. Assembly frame (origin on the axle, not tilted).
 */
function bodyGeometry(): THREE.BufferGeometry {
  if (bodyGeo) return bodyGeo
  const parts: THREE.BufferGeometry[] = []
  const silver = new THREE.Color(PAL.drillHousing)
  const silverDark = shade(PAL.drillHousing, 0.62)
  const collar = blend(PAL.drillHousing, PAL.drillCone, 0.6)
  const collarDark = shade(PAL.drillCone, 0.5)
  const rc = HOUSING_AF / 2 / Math.cos(Math.PI / 8)
  const zAxis = (g: THREE.BufferGeometry, y: number, z: number, c: number | THREE.Color) => {
    g.rotateX(Math.PI / 2) // CylinderGeometry top (+y) -> +z
    g.translate(0, y, z)
    return paint(g, c)
  }
  // octagonal prism with a flat on top; short chamfers so that it still reads as a block with flat ends
  const oct = (r0: number, r1: number, len: number) => {
    const g = new THREE.CylinderGeometry(r0, r1, len, 8, 1)
    g.rotateY(Math.PI / 8)
    return g
  }
  const hz0 = HOUSING_Z - HOUSING_LEN / 2
  const hz1 = HOUSING_Z + HOUSING_LEN / 2
  parts.push(zAxis(oct(rc, rc, HOUSING_LEN), HOUSING_Y, HOUSING_Z, silver))
  parts.push(zAxis(oct(rc * 0.9, rc, 0.06), HOUSING_Y, hz1 + 0.03, silver))
  parts.push(zAxis(oct(rc, rc * 0.74, 0.1), HOUSING_Y, hz0 - 0.05, silver))
  // rear stub: the handle arms start inside it
  const sz0 = REAR_Z - 0.04
  const sz1 = hz0 - 0.1
  parts.push(zAxis(new THREE.CylinderGeometry(0.21, 0.19, sz1 - sz0, 10), HOUSING_Y + 0.02, (sz0 + sz1) / 2, silverDark))
  // front collar: a dark neck, then a light steel sleeve with two raised rings (fixed; the nut and the cone spin in front of it)
  const cz0 = hz1 + 0.06
  parts.push(zAxis(new THREE.CylinderGeometry(COLLAR_R - 0.05, COLLAR_R - 0.05, CONE_Z - cz0, 14), HOUSING_Y, (cz0 + CONE_Z) / 2, collarDark))
  parts.push(zAxis(new THREE.CylinderGeometry(COLLAR_R, COLLAR_R, 0.1, 14), HOUSING_Y, cz0 + 0.1, collar))
  parts.push(zAxis(new THREE.CylinderGeometry(COLLAR_R + 0.03, COLLAR_R + 0.03, 0.1, 14), HOUSING_Y, CONE_Z - 0.07, collar))
  // axle
  const axle = new THREE.CylinderGeometry(0.07, 0.07, TRACK * 2, 8)
  axle.rotateZ(Math.PI / 2)
  parts.push(paint(axle, PAL.drillWheel))
  // handle arms: faceted bars, slim at the housing, flaring to a wide flattened end (art.md 2.15, ad 17.0 / 23.6 s)
  const o = new THREE.Object3D()
  for (const s of [-1, 1]) {
    const a = new THREE.Vector3(s * ARM_ROOT.x, ARM_ROOT.y, ARM_ROOT.z)
    const b = new THREE.Vector3(s * ARM_END.x, ARM_END.y, ARM_END.z)
    const len = a.distanceTo(b)
    const g = new THREE.CylinderGeometry(0.125, 0.08, len + 0.12, 8, 3)
    g.rotateX(Math.PI / 2) // axis -> z, the wide end (cylinder top) toward +z = toward b after lookAt
    const p = g.getAttribute('position')
    for (let i = 0; i < p.count; i++) {
      const t = p.getZ(i) / (len + 0.12) + 0.5
      p.setX(i, p.getX(i) * (1.3 + 0.55 * t * t))
      p.setY(i, p.getY(i) * (1.0 - 0.22 * t))
    }
    o.position.copy(a).lerp(b, 0.5)
    o.lookAt(b)
    o.updateMatrix()
    g.applyMatrix4(o.matrix)
    parts.push(paint(g, silver))
  }
  // crossbar (darker rod between the arms)
  const hw = DRILL.crossbar.halfWidth
  const bar = new THREE.CylinderGeometry(0.06, 0.06, hw * 2 + 0.06, 8)
  bar.rotateZ(Math.PI / 2)
  bar.translate(0, barY, barZ)
  parts.push(paint(bar, silverDark))
  const g = mergeGeometries(parts, false)!
  for (const p of parts) p.dispose()
  g.computeVertexNormals() // non-indexed: face normals
  // painted facet contrast (the ad's housing has a bright top flat and clearly darker side flats)
  const nrm = g.getAttribute('normal')
  const col = g.getAttribute('color') as THREE.BufferAttribute
  for (let i = 0; i < col.count; i++) {
    const up = Math.max(0, nrm.getY(i))
    const f = 0.74 + 0.26 * up * up * up + 0.06 * Math.max(0, -nrm.getX(i) * 0.3 - nrm.getZ(i) * 0.95) // a little extra on faces that look north (toward the key light) when parked
    col.setXYZ(i, col.getX(i) * f, col.getY(i) * f, col.getZ(i) * f)
  }
  bodyGeo = g
  return g
}

/**
 * Both spoked wheels in one geometry (they share the axle, so one mesh rolls them): thin iron rims, six flared
 * spokes, hub and cap. Wheel planes are yz (axis = x) at x = +-TRACK, centred on the axle. Vertex-coloured.
 */
function wheelsGeometry(): THREE.BufferGeometry {
  if (wheelsGeo) return wheelsGeo
  const one: THREE.BufferGeometry[] = []
  const rimC = blend(PAL.drillWheel, PAL.cartWheel, 0.55)
  const spokeC = blend(PAL.drillWheel, PAL.cartWheel, 0.25)
  const hubC = blend(PAL.drillWheel, PAL.cuff, 0.3)
  // rim: lathe ring with a squarish section (profile runs bottom -> top = faces outward), then axis y -> x
  const prof = [
    [0.465, -0.06], [0.52, -0.08], [WHEEL_R, -0.065], [WHEEL_R, 0.065], [0.52, 0.08], [0.465, 0.06], [0.45, 0], [0.465, -0.06],
  ].map(p => new THREE.Vector2(p[0], p[1]))
  const ring = new THREE.LatheGeometry(prof, 22)
  ring.rotateZ(Math.PI / 2)
  one.push(paint(ring, rimC))
  for (let k = 0; k < 6; k++) {
    const g = new THREE.BoxGeometry(0.06, 0.4, 0.065)
    const p = g.getAttribute('position')
    for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) p.setZ(i, p.getZ(i) * 2.0) // flare toward the rim
    g.translate(0, 0.27, 0)
    g.rotateX((k / 6) * Math.PI * 2)
    one.push(paint(g, spokeC))
  }
  const hub = new THREE.CylinderGeometry(0.115, 0.115, 0.2, 10)
  hub.rotateZ(Math.PI / 2)
  one.push(paint(hub, hubC))
  const cap = new THREE.CylinderGeometry(0.055, 0.055, 0.27, 8)
  cap.rotateZ(Math.PI / 2)
  one.push(paint(cap, rimC))
  const wheel = mergeGeometries(one, false)!
  for (const p of one) p.dispose()
  const left = wheel.clone().translate(-TRACK, 0, 0)
  wheel.translate(TRACK, 0, 0)
  const g = mergeGeometries([left, wheel], false)!
  left.dispose()
  wheel.dispose()
  g.computeVertexNormals()
  wheelsGeo = g
  return g
}

const BANDS = 5 // stacked rings of the cone = turns of the helical groove
const BAND_F = [0, 0.11, 0.19, 0.55, 0.93] // rows across one band (fraction of the pitch); the first two are the flat groove bottom at its rear edge
const BAND_R = [0.9, 0.905, 1.0, 1.04, 1.08] // radius of those rows relative to the cone envelope: each band tapers less than the cone and ends in a lip
const GROOVE_ROWS = 2
const GROOVE_SHADE = 0.22 // PAL.drillCone -> the dark blue of the ad's groove lines
const CONE_NT = 28

/**
 * The spinning bit: hex nut (z = 0 .. NUT_LEN) + cone (base at z = NUT_LEN, tip at z = NUT_LEN + CONE_LEN), one
 * non-indexed geometry with smooth normals on the cone and flat ones on the nut.
 * The cone is 4-5 stacked frustums separated by ONE helical groove (ad 24.5 s): the grid rows follow the helix, so
 * the step is crisp and visibly screws when the bit spins. Colours: blue steel, lighter toward each lip and the
 * tip, dark groove. A second geometry (heatGeo) shares positions/normals and carries the heat gradient for the
 * additive glow overlay.
 */
function bitGeometry(): THREE.BufferGeometry {
  if (bitGeo) return bitGeo
  const K = BAND_F.length
  const ROWS = (BANDS + 1) * K
  const W = CONE_NT + 1
  const pos: number[] = []
  const col: number[] = []
  const heat: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= ROWS; i++) {
    const k = i % K
    const f = BAND_F[k]!
    for (let j = 0; j <= CONE_NT; j++) {
      const u = Math.floor(i / K) + f + j / CONE_NT // helix phase: one band per turn
      const s = Math.min(1, Math.max(0, (u - 1) / BANDS))
      const th = (j / CONE_NT) * Math.PI * 2
      const r = (CONE_R * Math.pow(1 - s, 0.86) + 0.012) * (s >= 1 ? 1 : BAND_R[k]!)
      pos.push(Math.cos(th) * r, Math.sin(th) * r, NUT_LEN + s * CONE_LEN)
      // grey shade only: the metal colour is the material colour (steel or gold, see setGold)
      const v = k < GROOVE_ROWS && s < 1 ? GROOVE_SHADE : 0.86 + 0.2 * f + 0.25 * s * s
      col.push(v, v, v)
      const h = Math.min(1, Math.max(0, (s - 0.04) / 0.7))
      const hh = h * h * (3 - 2 * h) * (k < GROOVE_ROWS ? 0.55 : 1)
      heat.push(1.0 * hh, (0.2 + 0.5 * s * s) * hh, (0.02 + 0.3 * s * s * s) * hh)
    }
  }
  for (let i = 0; i < ROWS; i++)
    for (let j = 0; j < CONE_NT; j++) {
      const a = i * W + j
      const b = a + 1
      const d = a + W
      idx.push(a, b, d, b, d + 1, d)
    }
  const cone = new THREE.BufferGeometry()
  cone.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  cone.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  cone.setAttribute('heat', new THREE.Float32BufferAttribute(heat, 3))
  cone.setIndex(idx)
  cone.computeVertexNormals()
  // the helix seam: vertex (i, NT) coincides with (i + K, 0); average their normals so the seam does not show
  const nrm = cone.getAttribute('normal') as THREE.BufferAttribute
  for (let i = 0; i + K <= ROWS; i++) {
    const a = i * W + CONE_NT
    const b = (i + K) * W
    const x = nrm.getX(a) + nrm.getX(b)
    const y = nrm.getY(a) + nrm.getY(b)
    const z = nrm.getZ(a) + nrm.getZ(b)
    const l = Math.hypot(x, y, z) || 1
    nrm.setXYZ(a, x / l, y / l, z / l)
    nrm.setXYZ(b, x / l, y / l, z / l)
  }
  const coneFlat = cone.toNonIndexed()
  cone.dispose()

  // hex nut with a chamfered front, flat-shaded, darker steel
  const nutParts: THREE.BufferGeometry[] = []
  const hex6 = (r0: number, r1: number, len: number, z: number, color: THREE.Color) => {
    const g = new THREE.CylinderGeometry(r0, r1, len, 6)
    g.rotateX(Math.PI / 2)
    g.translate(0, 0, z)
    const o = paint(g, color)
    o.computeVertexNormals()
    o.setAttribute('heat', new THREE.BufferAttribute(new Float32Array(o.getAttribute('position').count * 3), 3))
    return o
  }
  const nutC = new THREE.Color(0.6, 0.6, 0.6)
  nutParts.push(hex6(NUT_R, NUT_R, NUT_LEN * 0.7, NUT_LEN * 0.35, nutC))
  nutParts.push(hex6(NUT_R * 0.9, NUT_R, NUT_LEN * 0.3, NUT_LEN * 0.85, nutC))
  const g = mergeGeometries([...nutParts, coneFlat], false)!
  for (const p of nutParts) p.dispose()
  coneFlat.dispose()
  bitGeo = g
  const h = new THREE.BufferGeometry()
  h.setAttribute('position', g.getAttribute('position'))
  h.setAttribute('normal', g.getAttribute('normal'))
  h.setAttribute('color', g.getAttribute('heat'))
  heatGeo = h
  return g
}

// ---------------------------------------------------------------------------------------------------------------

/** Drill cart (SPEC 7.4). See DRILL for the crossbar / crew / tip anchors. 4 draw calls + 1 while glowing. */
export function makeDrill(): DrillModel {
  const root = new THREE.Group()
  const sh = blobShadow(2.7, 5.2, 0.45)
  sh.position.set(0.1, 0.015, 0.6)
  root.add(sh)

  // housing and handle: warm silver (ad 24.5 s: top facet #b6aaa1, side facets #888588), flat facets
  const assembly = new THREE.Group()
  assembly.position.y = AXLE_Y
  assembly.rotation.x = TILT
  root.add(assembly)
  assembly.add(new THREE.Mesh(bodyGeometry(), gloss(0xffffff, { flat: true, vertexColors: true, shininess: 24, specular: 0x4a4a4a })))

  const wheels = new THREE.Mesh(wheelsGeometry(), lam(0xffffff, { vertexColors: true }))
  wheels.position.y = AXLE_Y
  root.add(wheels)

  // spinning part: hex nut + threaded cone (+ additive heat overlay)
  const spin = new THREE.Group()
  spin.position.set(0, HOUSING_Y, CONE_Z)
  assembly.add(spin)
  // albedo 1.45 x PAL.drillCone: the side of the cone that faces the camera gets about 0.65 of the light and lands on it
  const steel = new THREE.Color(PAL.drillCone).multiplyScalar(1.45)
  const gold = new THREE.Color(PAL.gold).multiplyScalar(1.25)
  const bitMat = gloss(0xffffff, { vertexColors: true, shininess: 40, specular: 0x8a8f96 }).clone()
  bitMat.color.copy(steel)
  const bit = new THREE.Mesh(bitGeometry(), bitMat)
  const heatMat = unlit(0xffffff, { additive: true, vertexColors: true }).clone()
  heatMat.polygonOffset = true
  heatMat.polygonOffsetFactor = -1
  heatMat.polygonOffsetUnits = -1
  const heat = new THREE.Mesh(heatGeo!, heatMat)
  heat.visible = false
  spin.add(bit, heat)

  let metal = steel
  let glow = 0
  const applyMetal = () => bitMat.color.copy(metal).multiplyScalar(1 - 0.66 * glow) // hot metal: less reflected light, more emitted
  return {
    root,
    setSpin(angle) {
      spin.rotation.z = angle
    },
    setGlow(k) {
      const v = k < 0 ? 0 : k > 1 ? 1 : k
      if (v === glow) return
      glow = v
      heat.visible = v > 0.01
      heatMat.color.setScalar(v * 1.1)
      bitMat.emissive.setRGB(0.3 * v, 0.06 * v, 0.01 * v)
      applyMetal()
    },
    setGold(on) {
      metal = on ? gold : steel
      applyMetal()
    },
    setRoll(angle) {
      wheels.rotation.x = angle
    },
    setRock(pitch) {
      assembly.rotation.x = TILT + pitch
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// gallery

function gItem(gold = false): THREE.Object3D {
  const d = makeDrill()
  d.setGold(gold)
  d.root.rotation.y = Math.atan2(0.45, 0.9) // the parking heading (L.DRILL_PARK)
  d.root.userData.model = d
  return d.root
}
/** Markers at the documented anchors so they can be checked against the model. */
function gAnchors(): THREE.Object3D {
  const root = gItem()
  const mk = (x: number, y: number, z: number, c: number) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), unlit(c))
    m.position.set(x, y, z)
    root.add(m)
  }
  mk(-DRILL.crossbar.halfWidth, DRILL.crossbar.y, DRILL.crossbar.z, PAL.uiGreen)
  mk(DRILL.crossbar.halfWidth, DRILL.crossbar.y, DRILL.crossbar.z, PAL.uiGreen)
  mk(0, DRILL.tip.y, DRILL.tip.z, PAL.alertRed2)
  mk(0, DRILL.rearY, DRILL.rearZ, PAL.alertRed2)
  for (const c of DRILL.crew) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 1.7, 10), unlit(PAL.sickShirt, { transparent: true, opacity: 0.35 }))
    m.position.set(c.x, 0.85, c.z)
    root.add(m)
  }
  return root
}
function animSortie(o: THREE.Object3D, t: number) {
  const d = o.userData.model as DrillModel
  const u = t % 3
  d.setSpin(t * 14)
  d.setGlow(Math.min(1, Math.max(0, (u - 0.4) / 0.6)) * (u > 2.3 ? Math.max(0, 1 - (u - 2.3) / 0.5) : 1))
  d.setRoll(Math.sin(t * 1.3) * 2)
}

export const GALLERY: GalleryItem[] = [
  { name: 'drill idle', size: 2.4, make: () => gItem() },
  { name: 'drill spinning + glow', size: 2.4, make: () => gItem(), animate: animSortie },
  { name: 'drill Mk II gold', size: 2.4, make: () => gItem(true), animate: (o, t) => (o.userData.model as DrillModel).setSpin(t * 5) },
  { name: 'drill anchors (crossbar, crew, tip)', size: 2.4, make: gAnchors },
]
