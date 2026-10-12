// Everything static in the world: terrain, floors, river bed, walls, posts, fences, doors, rocks, trees, the lowland
// below the cliff, yard props. Built once from L.* (config.ts is authoritative for the layout); createEnv() returns a
// handle whose update() only rotates seven pivots and toggles two groups.
//
// Look: geometry is flat-shaded Lambert with "painted" vertex colours (see Mesher and paintedMat): the colour stored
// on a face is the colour wanted for that orientation divided by what the stage's ambient rig makes of it, so under
// the ambient rig a face shows exactly the painted colour, and the lantern / fire / potion lights add on top at half
// strength. Tones were fitted by sampling the ad's frames next to renders from the same camera (shots/stage-env).
//
// Draw calls (about 89 k triangles, 67 k of them the 0.5 m ground grid): terrain + plateau rim 1, river bed 1, pen
// sand 1, floors 2 (courtyard, ward 1; ward 2 replaces the yard props), architecture 1, nature (rocks, trees, cliff
// face, lowland plates) 1, contact shadows 1, pen gate 1, doors 4, gateway leaves 2, yard props 4 (hidden once ward 2
// is bought).
import * as THREE from 'three'
import { L, P, PAL } from '../config'
import { makeRng, rand, randRange, type Rng } from '../core/rng'
import type { GameState } from '../sim/types'
import { RIVER_LENGTH, riverPoint, riverSample } from '../world/river'
import { blobShadow, lam, unlit, type GalleryItem } from './materials'
import { ambientE } from './stage'
import { cobweb, courtyardTiles, GROUND_DETAIL_SIZE, groundDetail, makeNoise, PLANK_TILE, plankFloor, reeds, wallGrain } from './textures'

export interface Env {
  /** Root group, already added to the scene by createEnv(). */
  root: THREE.Group
  /**
   * Call every frame. Reads only:
   *  - s.gate.open: 0..1 -> the pen gate swings inward by 0..105 deg (SPEC's 90 plus 15, so that the open leaf is not
   *    exactly edge-on to the fixed camera);
   *  - s.unlocks.ward2: the yard props vanish and the plank floor appears at once, the gateway leaves fold back
   *    against the wall in 0.45 s (so that they clear the ward-2 beds);
   *  - s.doors.south / s.doors.north: 0..1 opening of ward-1's south gate and the yard's north double door
   *    (decided by sim/ward.ts); the leaves follow within 0.2 s.
   * `dt` drives those swings; `time` is accepted for symmetry with the other views and is not used. No allocations.
   */
  update(s: GameState, dt: number, time: number): void
  /**
   * Look-dev overrides (gallery / screenshots): any field that is set replaces the value derived from the state.
   * gate / southDoor / northDoor are 0..1 opening amounts.
   */
  debug: { gate?: number; southDoor?: number; northDoor?: number; ward2?: boolean }
}

// =====================================================================================================================
// colour helpers (all linear RGB triples)
// =====================================================================================================================

type V3 = [number, number, number]
const C = (hex: number): V3 => {
  const c = new THREE.Color(hex)
  return [c.r, c.g, c.b]
}
const mixC = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const mulC = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const sstep = (a: number, b: number, v: number) => {
  const t = sat((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

const COL = {
  wall: mulC(C(PAL.wall), 1.55),
  wallFrame: mulC(mixC(C(PAL.wall), C(PAL.wallShade), 0.5), 1.25),
  // top faces of rails and beams: the same pinkish wood as the post caps, a step darker (ad 13.6 s: #6e5d63 next
  // to #8a777d caps), so that the caps do not pop out of the wall
  wallTop: mulC(mixC(C(PAL.postCap), C(PAL.wall), 0.45), 0.68),
  rail: mulC(mixC(C(PAL.wallShade), C(PAL.postCap), 0.3), 1.1),
  post: mulC(mixC(C(PAL.wall), C(PAL.wallShade), 0.3), 1.35),
  postCap: mulC(mixC(C(PAL.postCap), C(PAL.wall), 0.25), 0.85),
  curb: mulC(mixC(C(PAL.tile), C(PAL.tileWarm), 0.45), 1.2),
  trim: C(PAL.plankLit),
  door: mulC(mixC(C(PAL.doorWood), C(PAL.crate), 0.3), 1.1),
  doorFrame: mulC(mixC(C(PAL.doorWood), C(PAL.crate), 0.7), 1.25),
  knob: C(PAL.knob),
  picket: C(PAL.picket),
  picketShade: C(PAL.picketShade),
  // the planks are dark on both faces in the ad (11.4 s, 29.2 s); only cut tops and edges show the pale wood
  picketOut: mulC(mixC(C(PAL.picketShade), C(PAL.picket), 0.12), 0.92),
  picketIn: mulC(C(PAL.picketShade), 0.8),
  picketTop: C(PAL.picketTop),
  iron: C(PAL.ironFence),
  crate: C(PAL.crate),
  crateDark: C(PAL.crateDark),
  treeLit: mulC(C(PAL.conifer), 1.95),
  treeMid: mulC(C(PAL.coniferMid), 0.95),
  treeShade: mulC(C(PAL.coniferShade), 0.5),
}
// rock palettes (lit top / mid / shade), SPEC 7.2: bank boulders, bank pebbles and the darker cliff blocks
// (measured on the pair at the river mouth, 0.2 s / 2.4 s: 15 % brightest #6f7b76, median #515653, darkest #2a3232)
const ROCK: RockPal = { lit: mulC(C(PAL.boulderLit), 0.88), mid: mulC(C(PAL.boulder), 0.68), shade: mulC(C(PAL.boulderShade), 0.6) }
const PEBBLE: RockPal = { lit: C(PAL.boulderLit), mid: C(PAL.boulder), shade: C(PAL.boulderShade) }
// (the giant blocks behind ward 2 at 51 s: #515757 tops, #414b4a flanks, #273137 in the shade)
const CLIFF: RockPal = { lit: mulC(mixC(C(PAL.cliff), C(PAL.boulder), 0.5), 1.55), mid: mulC(mixC(C(PAL.cliff), C(PAL.boulder), 0.25), 1.3), shade: mulC(C(PAL.farDark), 1.0) }

// "Painted" light: where the ad's hand-painted shading puts the light on architecture (top and south faces light,
// west faces mid, the rest in shade) and on rocks / trees (top and screen-left lit).
const LP = new THREE.Vector3(-0.03, 0.72, 0.69).normalize()
const LTREE = new THREE.Vector3(-0.62, 0.62, -0.3).normalize()
const LROCK = new THREE.Vector3(-0.42, 0.78, -0.46).normalize()
/** Painted light for wall faces that look west into a room in use (ad 24 s: ward-1's east wall is #605a5c inside). */
const LP_ROOM = new THREE.Vector3(-0.5, 0.7, 0.5).normalize()
const _e = new THREE.Color()

type Shader = (n: THREE.Vector3, p: THREE.Vector3, localN: THREE.Vector3, out: V3) => void

/** Architecture: base colour x painted tone, with a slight blue shift in the shade. */
const archShade =
  (base: V3, top: V3 = base, aoY0 = -1, aoY1 = -1, light: THREE.Vector3 = LP): Shader =>
  (n, p, ln, out) => {
    const b = ln.y > 0.9 ? top : base
    // south faces and tops in the light, west faces deep in the shade (ad 11.4 s: #6f6c70 south, #28363f west)
    let t = 0.26 + 0.74 * sat(1.25 * n.dot(light) + 0.1)
    if (aoY1 > aoY0) t *= 0.72 + 0.28 * sat((p.y - aoY0) / (aoY1 - aoY0))
    const s = 1 - t
    out[0] = b[0] * t * (1 - 0.24 * s)
    out[1] = b[1] * t
    out[2] = b[2] * t * (1 + 0.16 * s)
  }

// =====================================================================================================================
// mesh accumulator: merges primitives into one non-indexed, vertex-coloured geometry
// =====================================================================================================================

class Mesher {
  private pos: number[] = []
  private col: number[] = []
  private uv: number[] = []
  /** Extra yaw applied to normals for painting only (pivoted parts are painted in their closed/rest orientation). */
  paintYaw = 0
  private a = new THREE.Vector3()
  private b = new THREE.Vector3()
  private c = new THREE.Vector3()
  private n = new THREE.Vector3()
  private ln = new THREE.Vector3()
  private pn = new THREE.Vector3()
  private t1 = new THREE.Vector3()
  private t2 = new THREE.Vector3()
  private out: V3 = [0, 0, 0]
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private s = new THREE.Vector3()
  private v = new THREE.Vector3()
  private static Y = new THREE.Vector3(0, 1, 0)

  private vert(p: THREE.Vector3, shade: Shader) {
    shade(this.pn, p, this.ln, this.out)
    ambientE(this.pn.x, this.pn.y, this.pn.z, _e)
    this.pos.push(p.x, p.y, p.z)
    // shown colour = vertex colour x (PAINT_LIT x E + 1 - PAINT_LIT), see paintedMat()
    const k = 1 - PAINT_LIT
    this.col.push(this.out[0] / (PAINT_LIT * _e.r + k), this.out[1] / (PAINT_LIT * _e.g + k), this.out[2] / (PAINT_LIT * _e.b + k))
    const n = this.n
    if (Math.abs(n.y) > 0.7) this.uv.push(p.x * 0.5, p.z * 0.5)
    else if (Math.abs(n.x) > Math.abs(n.z)) this.uv.push(p.z * 0.5, p.y * 0.5)
    else this.uv.push(p.x * 0.5, p.y * 0.5)
  }

  /** Adds every triangle of `geo` transformed by `matrix`; colours come from `shade` (face normal, vertex position). */
  add(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, shade: Shader): this {
    const g = geo.index ? geo.toNonIndexed() : geo
    const p = g.getAttribute('position')
    const cy = Math.cos(this.paintYaw)
    const sy = Math.sin(this.paintYaw)
    for (let i = 0; i < p.count; i += 3) {
      this.a.fromBufferAttribute(p, i)
      this.b.fromBufferAttribute(p, i + 1)
      this.c.fromBufferAttribute(p, i + 2)
      this.ln.copy(this.t1.subVectors(this.b, this.a)).cross(this.t2.subVectors(this.c, this.a)).normalize()
      this.a.applyMatrix4(matrix)
      this.b.applyMatrix4(matrix)
      this.c.applyMatrix4(matrix)
      this.n.copy(this.t1.subVectors(this.b, this.a)).cross(this.t2.subVectors(this.c, this.a))
      if (this.n.lengthSq() < 1e-12) continue
      this.n.normalize()
      this.pn.set(this.n.x * cy + this.n.z * sy, this.n.y, -this.n.x * sy + this.n.z * cy)
      this.vert(this.a, shade)
      this.vert(this.b, shade)
      this.vert(this.c, shade)
    }
    if (g !== geo) g.dispose()
    return this
  }

  /** Box centred on (x, z) spanning y0..y0+sy, rotated by yaw about +y (local x -> (cos yaw, 0, -sin yaw)). */
  box(x: number, y0: number, z: number, sx: number, sy: number, sz: number, yaw: number, shade: Shader): this {
    this.m.compose(this.v.set(x, y0 + sy / 2, z), this.q.setFromAxisAngle(Mesher.Y, yaw), this.s.set(sx, sy, sz))
    return this.add(UNIT_BOX, this.m, shade)
  }

  /** Box with a full transform (position = box centre). */
  boxQ(pos: THREE.Vector3, quat: THREE.Quaternion, sx: number, sy: number, sz: number, shade: Shader): this {
    this.m.compose(pos, quat, this.s.set(sx, sy, sz))
    return this.add(UNIT_BOX, this.m, shade)
  }

  /**
   * Convex polygon in a vertical plane, extruded: points are (along, y) pairs, CCW seen from +depth; the plane's
   * "along" axis is local x of a frame at (x, z) rotated by yaw; thickness is centred on the plane.
   */
  slab(x: number, z: number, yaw: number, pts: readonly (readonly [number, number])[], thickness: number, shade: Shader): this {
    const sh = new THREE.Shape(pts.map(p => new THREE.Vector2(p[0], p[1])))
    const g = new THREE.ExtrudeGeometry(sh, { depth: thickness, bevelEnabled: false, steps: 1 })
    g.translate(0, 0, -thickness / 2)
    this.m.compose(this.v.set(x, 0, z), this.q.setFromAxisAngle(Mesher.Y, yaw), this.s.set(1, 1, 1))
    this.add(g, this.m, shade)
    g.dispose()
    return this
  }

  /** Triangle a-b-c, wound so that its normal has a positive dot product with the hint (hx, hy, hz). */
  triFacing(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, hx: number, hy: number, hz: number, shade: Shader): this {
    const n = this.n.copy(this.t1.subVectors(b, a)).cross(this.t2.subVectors(c, a))
    if (n.lengthSq() < 1e-12) return this
    n.normalize()
    const flip = n.x * hx + n.y * hy + n.z * hz < 0
    if (flip) n.negate()
    this.ln.copy(n)
    this.pn.copy(n)
    this.vert(a, shade)
    this.vert(flip ? c : b, shade)
    this.vert(flip ? b : c, shade)
    return this
  }

  /** Quad a-b-c-d (in order around its outline) as two triangles facing the hint. */
  quadFacing(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, hx: number, hy: number, hz: number, shade: Shader): this {
    return this.triFacing(a, b, c, hx, hy, hz, shade).triFacing(a, c, d, hx, hy, hz, shade)
  }

  get triangles() {
    return this.pos.length / 9
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.computeBoundingSphere()
    return g
  }
}

/** Share of the courtyard tile albedo that reacts to lights (the rest is emissive). */
const TILE_LIT = 0.5
/** The same for everything painted with a Mesher. */
const PAINT_LIT = 0.5

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1).toNonIndexed()
const _m4 = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _v = new THREE.Vector3()
const _s = new THREE.Vector3()
const Y_AXIS = new THREE.Vector3(0, 1, 0)

/** Lambert material of the shared shading model with a texture map (materials.lam has no map option). */
function lamMap(map: THREE.Texture, vertexColors: boolean): THREE.MeshLambertMaterial {
  const m = lam(0xffffff, { vertexColors }).clone()
  m.map = map
  return m
}

/**
 * Material of everything built with a Mesher (architecture, rocks, trees, props): flat-shaded Lambert with painted
 * vertex colours of which only the share PAINT_LIT answers the lights; the rest is emitted as it is (same vertex
 * colour, same map). The ad's walls and boulders are hand-painted and barely brighten when the doctor walks up to
 * them (2.4 s, 29.2 s), whereas a fully lit vertical face 1 m from the lantern would more than double.
 */
function paintedMat(map: THREE.Texture | null): THREE.MeshLambertMaterial {
  const m = lam(0xffffff, { vertexColors: true }).clone()
  m.map = map
  m.color.setScalar(PAINT_LIT)
  m.emissive.setScalar(1 - PAINT_LIT)
  m.emissiveMap = map
  m.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;')
  }
  m.customProgramCacheKey = () => 'env.painted'
  return m
}
let archMatShared: THREE.MeshLambertMaterial | null = null
let natureMatShared: THREE.MeshLambertMaterial | null = null
/** Shared material of the architecture meshes (walls, doors, fences, props). */
const archMaterial = () => (archMatShared ??= paintedMat(wallGrain()))
/** Shared material of the nature mesh (rocks, trees, lowland). */
const natureMaterial = () => (natureMatShared ??= paintedMat(null))

// =====================================================================================================================
// architecture pieces
// =====================================================================================================================

const WALL_H = P.WALL_HEIGHT
const WALL_T = P.WALL_THICKNESS
const POST = P.POST_SIZE * 0.84 // shaft; the cap is a little wider than P.POST_SIZE
const POST_H = P.POST_HEIGHT
/** Opening angle of the leaves of ward-1's south gate (ad 24.4-25.1 s: 105-115 deg, well past the right angle). */
const SOUTH_SWING = (110 * Math.PI) / 180

/** Yaw that turns local +x into the ground direction (dx, dz). */
const yawOf = (dx: number, dz: number) => Math.atan2(-dz, dx)

/** Square post with a wider pinkish cap; origin at the ground centre. */
function addPost(m: Mesher, x: number, z: number, h = POST_H) {
  m.box(x, 0, z, POST, h - 0.12, POST, 0, archShade(COL.post, COL.post, 0.15, 0.7))
  m.box(x, 0, z, POST + 0.12, 0.2, POST + 0.12, 0, archShade(mulC(COL.post, 0.92), COL.rail))
  m.box(x, h - 0.13, z, POST + 0.17, 0.13, POST + 0.17, 0, archShade(mixC(COL.post, COL.postCap, 0.3), COL.postCap))
}

/** Wall panel between two points (post centres are NOT included; pass the free span). Recessed lighter centre panel. */
function addWallPanel(m: Mesher, ax: number, az: number, bx: number, bz: number, light: THREE.Vector3 = LP) {
  const dx = bx - ax
  const dz = bz - az
  const len = Math.hypot(dx, dz)
  if (len < 0.05) return
  const yaw = yawOf(dx, dz)
  const cx = (ax + bx) / 2
  const cz = (az + bz) / 2
  m.box(cx, 0, cz, len, 0.24, WALL_T + 0.06, yaw, archShade(COL.wallFrame, COL.wallFrame, 0, 0.25))
  m.box(cx, 0.24, cz, len, WALL_H - 0.42, WALL_T - 0.1, yaw, archShade(COL.wall, COL.wall, 0.2, 0.9, light))
  m.box(cx, WALL_H - 0.18, cz, len, 0.18, WALL_T + 0.1, yaw, archShade(COL.rail, COL.wallTop))
}

/**
 * One plank of the pen palisade standing at (x, z), facing yaw. The fence in the ad (11.4 s, 29.2 s) is a closed
 * wall of dark planks of alternating height, thick enough for their pale cut tops to read as a zigzag band from
 * above: tall planks end in a point (`tip` = offset of the point from the centre line, in metres; h = height of the
 * point), short ones (`tip` = null) in a slightly tilted flat cut at height h.
 * (inX, inZ) is the unit direction towards the inside of the pen: the faces that look into the pen are the darkest
 * (they are in the fence's own shade), the crowd side is a shade lighter, whatever the scene light says.
 */
function addPicket(m: Mesher, x: number, z: number, yaw: number, h: number, w: number, tip: number | null, inX: number, inZ: number) {
  const t = 0.12
  const pts: [number, number][] =
    tip === null
      ? [
          [-w / 2, 0],
          [w / 2, 0],
          [w / 2, h + 0.02],
          [-w / 2, h - 0.02],
        ]
      : [
          [-w / 2, 0],
          [w / 2, 0],
          [w / 2, h - 0.11 - 0.03 * Math.sign(tip || 1)],
          [tip, h],
          [-w / 2, h - 0.11 + 0.03 * Math.sign(tip || 1)],
        ]
  m.slab(x, z, yaw, pts, t, (n, p, ln, out) => {
    if (ln.y > 0.25) {
      // the cut: pale fresh wood
      const k = ln.x < -0.1 ? 1 : 0.88
      out[0] = COL.picketTop[0] * k
      out[1] = COL.picketTop[1] * k
      out[2] = COL.picketTop[2] * k
      return
    }
    const f = n.x * inX + n.z * inZ
    const b = f > 0.35 ? COL.picketIn : f < -0.35 ? COL.picketOut : COL.picket
    // darker towards the ground (the face has vertices only at its foot and at the cut: a plain gradient)
    const k = p.y < 0.5 ? 0.62 : 1.05
    out[0] = b[0] * k
    out[1] = b[1] * k
    out[2] = b[2] * k
  })
}

/**
 * Door / gate leaf with a framed face on both sides. Local frame: hinge at the origin, leaf extends along +x.
 * `backYaw`: the +z face is painted as it stands with the leaf turned to this yaw (a leaf that shows the camera that
 * face only when it is open).
 */
function addLeaf(m: Mesher, w: number, h: number, opts: { arch?: number; brace?: 'v' | 'panels' | 'none'; knobAt?: number; base?: V3; frame?: V3; thick?: number; y0?: number; backYaw?: number }) {
  const base = opts.base ?? COL.door
  const frame = opts.frame ?? COL.doorFrame
  const back = opts.backYaw
  const paint = (sh: Shader): Shader =>
    back === undefined
      ? sh
      : (n, p, ln, out) => {
          if (ln.z > 0.5) n.set(Math.sin(back), 0, Math.cos(back))
          sh(n, p, ln, out)
        }
  const th = opts.thick ?? 0.1
  const y0 = opts.y0 ?? 0.06
  const arch = opts.arch ?? 0
  // leaf body; an arched top rises linearly towards the free end (the two leaves of a double door make the arch)
  const pts: [number, number][] = [
    [0, y0],
    [w, y0],
    [w, h + arch],
    [w * 0.5, h + arch * 0.72],
    [0, h],
  ]
  m.slab(0, 0, 0, pts, th, paint(archShade(base, frame, 0, 0.5)))
  const topAt = (x: number) => (x < w * 0.5 ? h + (arch * 0.72 * x) / (w * 0.5) : h + arch * 0.72 + (arch * 0.28 * (x - w * 0.5)) / (w * 0.5))
  const bw = 0.13
  for (const side of [-1, 1]) {
    const z = side * (th / 2 + 0.012)
    const sh = paint(archShade(frame, frame))
    // stiles and rails
    m.box(bw / 2, y0, z, bw, topAt(0) - y0, 0.03, 0, sh)
    m.box(w - bw / 2, y0, z, bw, topAt(w) - y0, 0.03, 0, sh)
    m.box(w / 2, y0, z, w - 2 * bw, bw, 0.03, 0, sh)
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(topAt(w) - topAt(0), w))
    m.boxQ(_v.set(w / 2, (topAt(0) + topAt(w)) / 2 - bw / 2, z), rot, w - 2 * bw + 0.04, bw, 0.03, sh)
    if (opts.brace === 'v') {
      // chevron: two diagonals from the bottom centre to the upper corners
      const hh = h - y0 - 2 * bw
      for (const dir of [-1, 1]) {
        const ex = w / 2 + dir * (w / 2 - bw)
        const len = Math.hypot(ex - w / 2, hh)
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(hh, ex - w / 2))
        m.boxQ(_v.set((w / 2 + ex) / 2, y0 + bw + hh / 2, z), q, len, 0.1, 0.03, sh)
      }
    } else if (opts.brace === 'panels') {
      m.box(w / 2, y0 + (h - y0) * 0.5 - bw / 2, z, w - 2 * bw, bw, 0.03, 0, sh)
    }
  }
  if (opts.knobAt !== undefined) {
    for (const side of [-1, 1]) {
      _m4.compose(_v.set(opts.knobAt, 0.98, side * (th / 2 + 0.07)), _q.identity(), _s.set(1, 1, 1))
      m.add(KNOB, _m4, (_n, _p, _ln, out) => {
        out[0] = COL.knob[0]
        out[1] = COL.knob[1]
        out[2] = COL.knob[2]
      })
    }
  }
}
const KNOB = new THREE.IcosahedronGeometry(0.085, 0)

/** Dark wooden crate with framed faces; origin at the ground centre. */
function addCrate(m: Mesher, x: number, y0: number, z: number, s: number, yaw: number) {
  const inner = archShade(mixC(COL.crateDark, COL.crate, 0.45), mulC(COL.crate, 0.95))
  const fr = archShade(mulC(COL.crate, 1.1), mulC(COL.crate, 1.3), y0, y0 + 0.3)
  m.box(x, y0 + 0.02, z, s - 0.1, s - 0.04, s - 0.1, yaw, inner)
  const b = 0.13
  const c = Math.cos(yaw)
  const sn = Math.sin(yaw)
  const at = (lx: number, lz: number): [number, number] => [x + lx * c + lz * sn, z - lx * sn + lz * c]
  const e = s / 2 - b / 2
  // 4 vertical corner posts, 4 + 4 horizontal edge boards
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const [px, pz] = at(sx * e, sz * e)
      m.box(px, y0, pz, b, s, b, yaw, fr)
    }
  }
  for (const yy of [y0, y0 + s - b]) {
    for (const sg of [-1, 1]) {
      let [px, pz] = at(0, sg * e)
      m.box(px, yy, pz, s - 2 * b, b, b, yaw, fr)
      ;[px, pz] = at(sg * e, 0)
      m.box(px, yy, pz, b, b, s - 2 * b, yaw, fr)
    }
  }
}

/** Low empty frame lying on the ground (derelict bed frame / tray): border boards, floor panel, short corner posts. */
function addFlatFrame(m: Mesher, x: number, z: number, w: number, d: number, yaw: number) {
  const fr = archShade(mulC(COL.crate, 1.1), mulC(COL.crate, 1.3), 0, 0.2)
  const fl = archShade(mixC(COL.crateDark, COL.crate, 0.5), mulC(COL.crate, 0.92))
  const c = Math.cos(yaw)
  const sn = Math.sin(yaw)
  const at = (lx: number, lz: number): [number, number] => [x + lx * c + lz * sn, z - lx * sn + lz * c]
  m.box(x, 0, z, w - 0.2, 0.07, d - 0.2, yaw, fl)
  const b = 0.14
  for (const sg of [-1, 1]) {
    let [px, pz] = at(0, sg * (d / 2 - b / 2))
    m.box(px, 0, pz, w, 0.26, b, yaw, fr)
    ;[px, pz] = at(sg * (w / 2 - b / 2), 0)
    m.box(px, 0, pz, b, 0.26, d - 2 * b, yaw, fr)
    for (const s2 of [-1, 1]) {
      ;[px, pz] = at(sg * (w / 2 - b / 2), s2 * (d / 2 - b / 2))
      m.box(px, 0, pz, b + 0.04, 0.4, b + 0.04, yaw, fr)
    }
  }
}

/**
 * Derelict cot (ad 11.4 s, 29 s: an empty bed frame in the yard): two side rails and two end boards on four posts,
 * the head posts taller, a low slat deck inside. w = length along local x (head at -x), d = width.
 */
function addBench(m: Mesher, x: number, z: number, w: number, d: number, yaw: number) {
  const fr = archShade(mulC(COL.crate, 1.1), mulC(COL.crate, 1.3), 0, 0.3)
  const dk = archShade(mixC(COL.crateDark, COL.crate, 0.4), mulC(COL.crate, 0.85))
  const c = Math.cos(yaw)
  const sn = Math.sin(yaw)
  const at = (lx: number, lz: number): [number, number] => [x + lx * c + lz * sn, z - lx * sn + lz * c]
  // slat deck, low inside the frame
  m.box(x, 0.16, z, w - 0.2, 0.07, d - 0.16, yaw, dk)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const [px, pz] = at(sx * (w / 2 - 0.07), sz * (d / 2 - 0.07))
      m.box(px, 0, pz, 0.14, sx < 0 ? 0.82 : 0.52, 0.14, yaw, fr)
    }
    // end boards (the head board is higher)
    const [px, pz] = at(sx * (w / 2 - 0.07), 0)
    m.box(px, 0.2, pz, 0.07, sx < 0 ? 0.5 : 0.22, d - 0.26, yaw, fr)
  }
  // side rails
  for (const sz of [-1, 1]) {
    const [px, pz] = at(0, sz * (d / 2 - 0.06))
    m.box(px, 0.18, pz, w - 0.26, 0.2, 0.07, yaw, fr)
  }
}

// =====================================================================================================================
// nature pieces
// =====================================================================================================================

type Poly = THREE.Vector3[]

/** Clips a convex polyhedron (faces = CCW polygons seen from outside) to the half-space n.p <= d and caps the cut. */
function cutConvex(faces: Poly[], n: THREE.Vector3, d: number): Poly[] {
  const out: Poly[] = []
  const cap: THREE.Vector3[] = []
  for (const f of faces) {
    const res: THREE.Vector3[] = []
    for (let i = 0; i < f.length; i++) {
      const a = f[i]
      const b = f[(i + 1) % f.length]
      const da = n.dot(a) - d
      const db = n.dot(b) - d
      if (da <= 0) res.push(a)
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const p = a.clone().lerp(b, da / (da - db))
        res.push(p)
        cap.push(p)
      }
    }
    if (res.length >= 3) out.push(res)
  }
  if (cap.length >= 3) {
    const c = new THREE.Vector3()
    for (const p of cap) c.add(p)
    c.multiplyScalar(1 / cap.length)
    const u = new THREE.Vector3(1, 0, 0)
    if (Math.abs(n.x) > 0.8) u.set(0, 0, 1)
    u.addScaledVector(n, -u.dot(n)).normalize()
    const v = new THREE.Vector3().crossVectors(n, u)
    const sorted = cap
      .map(p => ({ p, a: Math.atan2(p.clone().sub(c).dot(v), p.clone().sub(c).dot(u)) }))
      .sort((x, y) => x.a - y.a)
      .map(e => e.p)
    const uniq: THREE.Vector3[] = []
    for (const p of sorted) if (uniq.length === 0 || (uniq[uniq.length - 1].distanceToSquared(p) > 1e-8 && uniq[0].distanceToSquared(p) > 1e-8)) uniq.push(p)
    if (uniq.length >= 3) out.push(uniq)
  }
  return out
}

/** Where the centre of a rock's underlying ellipsoid sits (fraction of the height) for a given roundness. */
const rockCentre = (h: number, round: number) => h * (0.36 - 0.1 * (1 - sat(round)))

/**
 * Boulder: a convex block cut out of a box by planes tangent to a jittered ellipsoid whose widest ring is above the
 * ground and whose bottom is buried: a tilted top facet, four sloping shoulders and four or five steep sides, i.e. a
 * standing stone with bevelled edges and a rounded silhouette, as in the ad (0.4 s, 2.4 s, 40 s).
 * Radii rx / rz, height h. `round`: 1 = loaf-like boulder, 0.5 = steep-sided block.
 */
function rockGeometry(r: Rng, rx: number, h: number, rz: number, round = 1): THREE.BufferGeometry {
  const cy = rockCentre(h, round)
  const ry = h - cy
  const x1 = rx * 1.1
  const z1 = rz * 1.1
  const y0 = -0.25
  const y1 = h * 1.05
  const P3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
  let faces: Poly[] = [
    [P3(-x1, y1, -z1), P3(-x1, y1, z1), P3(x1, y1, z1), P3(x1, y1, -z1)], // top
    [P3(-x1, y0, z1), P3(x1, y0, z1), P3(x1, y1, z1), P3(-x1, y1, z1)], // +z
    [P3(x1, y0, -z1), P3(-x1, y0, -z1), P3(-x1, y1, -z1), P3(x1, y1, -z1)], // -z
    [P3(x1, y0, z1), P3(x1, y0, -z1), P3(x1, y1, -z1), P3(x1, y1, z1)], // +x
    [P3(-x1, y0, -z1), P3(-x1, y0, z1), P3(-x1, y1, z1), P3(-x1, y1, -z1)], // -x
  ]
  const n = new THREE.Vector3()
  /** Plane with normal (nx, ny, nz) at k times the ellipsoid's support distance (k = 1 touches it). */
  const cut = (nx: number, ny: number, nz: number, k: number) => {
    n.set(nx, ny, nz).normalize()
    const sup = Math.sqrt((rx * n.x) ** 2 + (ry * n.y) ** 2 + (rz * n.z) ** 2)
    faces = cutConvex(faces, n, sup * k + n.y * cy)
  }
  // top facet, tilted
  cut(randRange(r, -0.3, 0.3), 1, randRange(r, -0.3, 0.3), randRange(r, 0.88, 0.96))
  // sides: 4-5 steep facets
  const nb = 5 + (rand(r) < 0.4 ? 1 : 0)
  const a1 = rand(r) * 6.283
  for (let i = 0; i < nb; i++) {
    const a = a1 + (i / nb) * 6.283 + randRange(r, -0.28, 0.28)
    const el = 0.04 + randRange(r, 0.04, 0.3) * round
    cut(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el), randRange(r, 0.9, 1.0))
  }
  // shoulders: 4 sloping facets that take the upper edges off
  const ns = 4
  const a0 = a1 + randRange(r, 0.3, 1.2)
  for (let i = 0; i < ns; i++) {
    const a = a0 + (i / ns) * 6.283 + randRange(r, -0.4, 0.4)
    const el = randRange(r, 0.68, 1.0) * (0.55 + 0.45 * round)
    cut(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el), randRange(r, 0.86, 0.98))
  }
  const pos: number[] = []
  for (const f of faces) for (let i = 1; i < f.length - 1; i++) pos.push(f[0].x, f[0].y, f[0].z, f[i].x, f[i].y, f[i].z, f[i + 1].x, f[i + 1].y, f[i + 1].z)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  return g
}

/** Three-stop tone ramp shade -> mid -> lit for t in 0..1. */
function ramp3(shade: V3, mid: V3, lit: V3, t: number, out: V3) {
  const a = t < 0.5 ? shade : mid
  const b = t < 0.5 ? mid : lit
  const u = t < 0.5 ? t * 2 : t * 2 - 1
  out[0] = a[0] + (b[0] - a[0]) * u
  out[1] = a[1] + (b[1] - a[1]) * u
  out[2] = a[2] + (b[2] - a[2]) * u
}

/**
 * Painted rock shading. The tone follows a blend of the facet normal and the normal of the underlying ellipsoid at
 * each vertex, so a facet carries a soft gradient and the creases between facets are soft too (the ad's rocks are
 * hand-painted smooth lumps, not crystals); top and screen-left lit, darker towards the ground.
 */
const rockPaint =
  (pal: RockPal, cx: number, cy: number, cz: number, rh: number, ry: number, y: number, h: number): Shader =>
  (n, p, _ln, out) => {
    let sx = (p.x - cx) / (rh * rh)
    let sy = (p.y - cy) / (ry * ry)
    let sz = (p.z - cz) / (rh * rh)
    const sl = Math.hypot(sx, sy, sz) || 1
    sx = n.x * 0.36 + (sx / sl) * 0.64
    sy = n.y * 0.36 + (sy / sl) * 0.64
    sz = n.z * 0.36 + (sz / sl) * 0.64
    const bl = Math.hypot(sx, sy, sz) || 1
    let t = 0.5 + (0.5 * (sx * LROCK.x + sy * LROCK.y + sz * LROCK.z)) / bl
    // shade below 0.24, mid at 0.6, lit from 0.96: tops lit, screen-left flanks mid, the rest in shade
    t = sat((t - 0.24) / 0.72)
    // the foot sinks into its own contact shadow
    t *= 0.3 + 0.7 * sstep(-0.05, 0.55, (p.y - y) / h)
    ramp3(pal.shade, pal.mid, pal.lit, t, out)
  }

interface RockPal {
  lit: V3
  mid: V3
  shade: V3
}

function addRock(m: Mesher, r: Rng, x: number, y: number, z: number, rx: number, h: number, rz: number, pal: RockPal, round = 1) {
  const g = rockGeometry(r, rx, h, rz, round)
  _m4.compose(_v.set(x, y, z), _q.setFromAxisAngle(Y_AXIS, rand(r) * 6.28), _s.set(1, 1, 1))
  const cy = rockCentre(h, round)
  m.add(g, _m4, rockPaint(pal, x, y + cy, z, (rx + rz) / 2, h - cy, y, h))
  g.dispose()
}

/**
 * Conifer: 3 stacked flared skirts with ragged, drooping hems and no trunk (ad 11.4 s, 51 s: frosty blue-grey-green,
 * about 1.55 times as tall as wide, screen-left side lit, each tier dark where it disappears under the one above).
 * h = total height, w = base diameter.
 */
function addConifer(m: Mesher, r: Rng, x: number, y: number, z: number, h: number, w: number) {
  // two short wide skirts under a tall slender spike that flares at its hem (a witch's hat)
  const tiers = [
    { y0: 0.04, y1: 0.46, r: 0.5, flare: 0.9 },
    { y0: 0.28, y1: 0.7, r: 0.4, flare: 0.95 },
    { y0: 0.52, y1: 1.0, r: 0.27, flare: 1.6 },
  ]
  const sides = 14
  const us = [0.4, 0.76, 1]
  for (let ti = 0; ti < tiers.length; ti++) {
    const t = tiers[ti]
    const yawT = rand(r) * 6.283
    const apex = new THREE.Vector3(randRange(r, -0.02, 0.02) * w, t.y1 * h, randRange(r, -0.02, 0.02) * w)
    const rings: THREE.Vector3[][] = us.map(() => [])
    for (let i = 0; i < sides; i++) {
      const a = yawT + (i / sides) * 6.283 + randRange(r, -0.08, 0.08)
      const rr = t.r * w * randRange(r, 0.95, 1.05)
      const tooth = i % 2 === 0
      for (let k = 0; k < us.length; k++) {
        const u = us[k]
        let rad = rr * Math.pow(u, t.flare)
        let yy = (t.y1 - (t.y1 - t.y0) * u) * h
        if (k === us.length - 1) {
          // ragged hem: lobes that droop, notches that are cut back
          rad *= tooth ? 1.05 : 0.9
          yy += tooth ? -0.022 * h * randRange(r, 0.4, 1.5) : 0.012 * h
        }
        rings[k].push(new THREE.Vector3(Math.cos(a) * rad, yy, Math.sin(a) * rad))
      }
    }
    const pos: number[] = []
    const put = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides
      // counter-clockwise seen from outside: a cone built clockwise-in-angle needs (apex, j, i)
      put(apex, rings[0][j], rings[0][i])
      for (let k = 0; k < us.length - 1; k++) {
        put(rings[k][i], rings[k][j], rings[k + 1][j])
        put(rings[k][i], rings[k + 1][j], rings[k + 1][i])
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    _m4.makeTranslation(x, y, z)
    const yTop = y + t.y1 * h
    const span = (t.y1 - t.y0) * h
    const covered = ti < tiers.length - 1
    m.add(g, _m4, (n, p, _ln, out) => {
      const dx = p.x - x
      const dz = p.z - z
      const dl = Math.hypot(dx, dz) || 1
      // soft cone: half facet normal, half the smooth normal of a 37 deg cone
      const bx = n.x * 0.5 + (dx / dl) * 0.4
      const by = n.y * 0.5 + 0.3
      const bz = n.z * 0.5 + (dz / dl) * 0.4
      let tone = 0.5 + (0.5 * (bx * LTREE.x + by * LTREE.y + bz * LTREE.z)) / (Math.hypot(bx, by, bz) || 1)
      const u = (yTop - p.y) / span
      // frost: the hems and the spike catch the light
      tone = sat(tone * 1.35 - 0.1 + 0.22 * (u - 0.55))
      // shadow of the tier above, and of the whole tree towards the ground
      if (covered) tone *= 0.16 + 0.84 * sstep(0.42, 0.86, u)
      tone *= 0.8 + 0.2 * sat((p.y - y) / (0.4 * h))
      ramp3(COL.treeShade, COL.treeMid, COL.treeLit, tone, out)
    })
    g.dispose()
  }
}

/** Dark uneven plank fence (east river bank): centred on (x, z), runs `len` metres along z. */
function addIronFence(m: Mesher, r: Rng, x: number, z: number, len: number) {
  const sh = archShade(mulC(COL.iron, 1.5), mulC(COL.iron, 1.9), 0, 0.5)
  // wide rough planks of uneven height with gaps between them (ad 1.8-3.0 s: 9 planks on 5 m)
  const n = Math.round(len / 0.56)
  for (let i = 0; i <= n; i++) {
    const pz = z - len / 2 + (i / n) * len + randRange(r, -0.06, 0.06)
    const h = randRange(r, 1.15, 1.6)
    const w = randRange(r, 0.3, 0.42)
    const px = x + randRange(r, -0.05, 0.05)
    const tip = randRange(r, -0.3, 0.3) * w
    const pts: [number, number][] = [
      [-w / 2, 0],
      [w / 2, 0],
      [w / 2, h - randRange(r, 0.1, 0.2)],
      [tip, h],
      [-w / 2, h - randRange(r, 0.1, 0.2)],
    ]
    m.slab(px, pz, Math.PI / 2 + randRange(r, -0.14, 0.14), pts, 0.11, sh)
  }
  // two sagging rails
  const seg = 6
  for (const [yy, sagY] of [[0.42, 0.05], [0.95, 0.07]] as const) {
    for (let i = 0; i < seg; i++) {
      const u = (i + 0.5) / seg
      m.box(x + 0.09, yy - sagY * Math.sin(u * Math.PI * 3) ** 2, z - len / 2 + u * len, 0.06, 0.09, len / seg + 0.06, 0, sh)
    }
  }
}

// =====================================================================================================================
// terrain
// =====================================================================================================================

type P2 = [number, number]

/** Corner-cutting subdivision of a closed polygon (straight runs of collinear points stay exactly straight). */
function chaikin(pts: readonly (readonly [number, number])[], iterations: number): P2[] {
  let p: P2[] = pts.map(q => [q[0], q[1]])
  for (let k = 0; k < iterations; k++) {
    const o: P2[] = []
    for (let i = 0; i < p.length; i++) {
      const a = p[i]
      const b = p[(i + 1) % p.length]
      o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
    }
    p = o
  }
  return p
}

const CZ = L.CLIFF_Z
/**
 * Edge of the plateau = outline of the teal lowland (SPEC 4.3): the bay east of ward-1, the river fall, the south-east.
 * It stays south of z = CLIFF_Z wherever the player or stray balls can get (world/colliders.ts blocks z > CLIFF_Z east
 * of x = 6.5) and east of the rat field (L.RAT_FIELD; ad 24.6-26.5 s: the dirt ends 8-9 m east of the cauldron's
 * meridian all the way south). Along the fall the edge is exactly z = CLIFF_Z.
 */
const LOWLAND: readonly P2[] = chaikin(
  [
    [7.9, 11.5], [7.85, 13.0], [8.3, 14.6], [8.9, 17.6], [9.4, 22], [10.5, 30], [16, 90], [220, 90], [220, -14], [90, -9], [45, -3],
    [32, 1], [27.2, 3.3], [24.6, 4.0], [23.2, CZ], [22.8, CZ], [14.3, CZ], [13.9, CZ], [13.3, CZ + 0.5], [12.4, CZ + 0.2], [11.5, CZ + 0.75], [10.6, CZ + 0.3], [9.6, CZ + 0.9], [8.7, 5.9], [8.1, 7.3], [7.65, 8.6], [7.9, 10.2],
  ],
  2,
)
/** +1 when the lowland is on the left of the outline's direction of travel in the (x, z) plane, else -1. */
const LOWLAND_SIDE = (() => {
  let a = 0
  for (let i = 0, j = LOWLAND.length - 1; i < LOWLAND.length; j = i++) a += LOWLAND[j][0] * LOWLAND[i][1] - LOWLAND[i][0] * LOWLAND[j][1]
  return a > 0 ? 1 : -1
})()

/** > 0 inside the lowland (distance to the plateau edge in metres), < 0 on the plateau. */
function lowlandDepth(x: number, z: number): number {
  // nothing west of the bay or north of the fall is near the edge: skip the polygon walk for most of the map
  if (x < 2 || z < -22) return -Math.max(5.5, 7.6 - x, -9 - z)
  let inside = false
  let best = Infinity
  const n = LOWLAND.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = LOWLAND[j][0]
    const az = LOWLAND[j][1]
    const bx = LOWLAND[i][0]
    const bz = LOWLAND[i][1]
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside
    const ex = bx - ax
    const ez = bz - az
    const t = sat(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez))
    const dx = x - ax - ex * t
    const dz = z - az - ez * t
    const d2 = dx * dx + dz * dz
    if (d2 < best) best = d2
  }
  const d = Math.sqrt(best)
  return inside ? d : -d
}

const rectDist = (x: number, z: number, x0: number, z0: number, x1: number, z1: number) => {
  const dx = Math.max(x0 - x, 0, x - x1)
  const dz = Math.max(z0 - z, 0, z - z1)
  const outside = Math.hypot(dx, dz)
  return outside > 0 ? outside : -Math.min(x - x0, x1 - x, z - z0, z1 - z)
}

const G = {
  dirt: C(PAL.dirt),
  dirtLit: C(PAL.dirtLit),
  dirtFar: C(PAL.dirtFar),
  forest: mulC(mixC(C(PAL.dirtFar), C(PAL.cliff), 0.6), 1.05),
  // trodden earth of the derelict yard: browner and darker than the dirt outside (ad 11.4-13.6 s: #645550, #5b5758)
  yard: mulC(mixC(C(PAL.sand), C(PAL.plankSeam), 0.25), 0.72),
  sand: C(PAL.sand),
  green: C(PAL.miasma),
  greenDark: C(PAL.miasmaDark),
  low: C(PAL.lowland),
  low2: C(PAL.lowland2),
  deep: C(PAL.farDark),
  bed: C(PAL.riverBed),
  bed2: C(PAL.riverBed2),
}
const nA = makeNoise(16, 101)
const nB = makeNoise(32, 102)
const nC = makeNoise(8, 103)

/** Depth of the crevice floor under the lowland's rock plates (the plates' tops are at about -CLIFF_DROP). */
const LOW_FLOOR = -(L.CLIFF_DROP + 1.2)
/**
 * 1 in the gorge under the river fall, 0 in the rest of the lowland. The ad's ball curtain drops 5-7 m down a smooth
 * dark face and out of the picture (2.4-2.8 s): no rock plate stands under it.
 */
const gorgeAt = (x: number, z: number) => sstep(12.5, 14.5, x) * (1 - sstep(23.5, 25.5, x)) * (1 - sstep(10.5, 13.5, z))
/** The gorge's bottom lies where the simulation recycles a falling ball (sim/river.ts FALL_DEPTH). */
const GORGE_FLOOR = -(L.FALL_DROP + 0.5)
const floorAt = (x: number, z: number) => LOW_FLOOR + (GORGE_FLOOR - LOW_FLOOR) * gorgeAt(x, z)
/** The plateau surface is re-drawn by a rim strip from RIM_IN metres inside the edge to RIM_OUT beyond it (overhang). */
const RIM_IN = 0.95
const RIM_OUT = 0.22

/** Painted colour of the lowland's rock at (x, z), d metres from the plateau edge (linear RGB). */
function tealColor(x: number, z: number, d: number): V3 {
  const a = nA(x / 64, z / 64)
  const b = nB(x / 48, z / 48)
  const c = nC(x / 90, z / 90)
  let teal = mixC(G.low, G.low2, sat(0.5 + 0.6 * a + 0.3 * b))
  teal = mulC(teal, 1.75 - 0.5 * sstep(0.2, 5, d) + 0.22 * b)
  return mixC(teal, G.deep, 0.8 * sstep(11, 30, d + 3 * c))
}

/** Painted ground colour of the plateau at (x, z) (linear RGB): dirt, yard, forest floor, crowd green, moss at the edge. */
function groundColor(x: number, z: number, d: number, out: V3): V3 {
  const a = nA(x / 64, z / 64)
  const b = nB(x / 48, z / 48)
  const c = nC(x / 90, z / 90)
  // (ad: #716e64 +- 5 wherever the lantern does not reach; PAL.dirtLit only comes with the lantern)
  let col = mixC(G.dirt, G.dirtLit, sat(0.2 + 0.2 * a + 0.1 * b))
  // wilderness outside the village / work area, and far darkness
  const wild = sstep(0, 3, rectDist(x, z, -6.5, -16.9, 25, 14) + 1.0 * c)
  col = mixC(col, G.forest, wild * (0.86 + 0.1 * a))
  col = mixC(col, G.dirtFar, 0.55 * sstep(30, 54, Math.hypot(x - 6, z + 4)))
  // derelict yard: browner, trodden earth
  const [yx0, yz0, yx1, yz1] = L.WARD2
  const yard = 1 - sstep(-0.35, 0.25, rectDist(x, z, yx0, yz0, yx1, yz1))
  if (yard > 0) col = mixC(col, mulC(G.yard, 0.94 + 0.12 * a), yard)
  // trampled green under the crowd, west of the walls: mottled, darker than the miasma that floats above it
  const gx = 1 - sstep(-6.0, -5.3, x + 0.3 * b)
  if (gx > 0 && z > -13) {
    const g = gx * sstep(-11.6, -10.1, z + 0.7 * a) * sstep(-34, -25, x + 3 * c) * (1 - sstep(27, 36, z + 3 * c))
    if (g > 0) {
      const patch = nC(x / 9.5, z / 9.5) * 0.6 + nB(x / 13, z / 13) * 0.4
      col = mixC(col, mulC(mixC(G.greenDark, G.green, sat(0.5 + 0.55 * patch + 0.2 * a)), 0.9), g)
    }
  }
  // moss creeps onto the plateau towards the edge (ad 2.4 s: the dirt turns teal 1-2 m before the drop)
  if (d > -2.4) col = mixC(col, tealColor(x, z, Math.max(d, 0)), 0.92 * sstep(-2.1, 0.1, d + 0.5 * b))
  out[0] = col[0] * 1.09
  out[1] = col[1] * 1.09
  out[2] = col[2] * 1.09
  return out
}

function axis(lo: number, hi: number, step: number, outer: number[]): number[] {
  const a: number[] = []
  for (let i = outer.length - 1; i >= 0; i--) a.push(lo - outer[i])
  for (let v = lo; v <= hi + 1e-6; v += step) a.push(v)
  for (const o of outer) a.push(hi + o)
  return a
}

interface RimPoint {
  x: number
  z: number
  /** Unit normal of the edge pointing into the lowland. */
  nx: number
  nz: number
  /** False for the far part of the outline that never comes into view. */
  near: boolean
}

/** The plateau edge resampled at 0.8 m or less, with normals pointing into the lowland. */
const RIM: readonly RimPoint[] = (() => {
  const pts: RimPoint[] = []
  const n = LOWLAND.length
  const near = (p: readonly [number, number]) => p[0] < 62 && p[1] < 62 && p[1] > -12
  for (let i = 0; i < n; i++) {
    const a = LOWLAND[i]
    const b = LOWLAND[(i + 1) % n]
    const isNear = near(a) && near(b)
    const k = isNear ? Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.8)) : 1
    for (let j = 0; j < k; j++) pts.push({ x: a[0] + ((b[0] - a[0]) * j) / k, z: a[1] + ((b[1] - a[1]) * j) / k, nx: 0, nz: 0, near: isNear })
  }
  const m = pts.length
  for (let i = 0; i < m; i++) {
    const p = pts[(i + m - 1) % m]
    const q = pts[(i + 1) % m]
    const tx = q.x - p.x
    const tz = q.z - p.z
    const tl = Math.hypot(tx, tz) || 1
    pts[i].nx = (LOWLAND_SIDE * -tz) / tl
    pts[i].nz = (LOWLAND_SIDE * tx) / tl
  }
  return pts
})()

/**
 * Ground: one mesh. A flat 0.5 m grid at y = 0 on the plateau that steps down to the crevice floor (floorAt) inside
 * the lowland, plus a rim strip that follows the smooth plateau edge and covers the grid's jagged step (the cliff face
 * below the rim and the rock plates are part of the nature mesh, see addLowland).
 */
function buildTerrain(): THREE.Mesh {
  const outer = [3, 8, 16, 30, 55, 100, 180, 300]
  const xs = axis(-34, 46, 0.5, outer)
  const zs = axis(-46, 40, 0.5, outer)
  const nx = xs.length
  const nz = zs.length
  const pos: number[] = []
  const col: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const out: V3 = [0, 0, 0]
  const floor = mulC(G.deep, 0.5)
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = xs[i]
      const z = zs[j]
      const d = lowlandDepth(x, z)
      const low = d > 0
      pos.push(x, low ? floorAt(x, z) : 0, z)
      if (low) col.push(floor[0], floor[1], floor[2])
      else {
        groundColor(x, z, d, out)
        col.push(out[0], out[1], out[2])
      }
      uv.push(x / GROUND_DETAIL_SIZE, z / GROUND_DETAIL_SIZE)
    }
  }
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i
      const b = a + 1
      const c = a + nx
      const d = c + 1
      idx.push(a, c, b, b, c, d)
    }
  }
  // rim strip: three columns (RIM_IN inside, 0.3 inside, RIM_OUT beyond the edge), just above the grid
  const cols = [-RIM_IN, -0.3, RIM_OUT]
  const base = pos.length / 3
  const m = RIM.length
  for (let i = 0; i < m; i++) {
    const r = RIM[i]
    for (const off of cols) {
      const x = r.x + r.nx * off
      const z = r.z + r.nz * off
      pos.push(x, 0.006, z)
      groundColor(x, z, off, out)
      col.push(out[0], out[1], out[2])
      uv.push(x / GROUND_DETAIL_SIZE, z / GROUND_DETAIL_SIZE)
    }
  }
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m
    if (!RIM[i].near || !RIM[j].near) continue
    for (let k = 0; k < cols.length - 1; k++) {
      const a = base + i * cols.length + k
      const b = base + j * cols.length + k
      // wind each triangle so that it faces up, whatever the direction of travel
      const up = (p: number, q: number, s: number) => {
        const ux = pos[q * 3] - pos[p * 3]
        const uz = pos[q * 3 + 2] - pos[p * 3 + 2]
        const vx = pos[s * 3] - pos[p * 3]
        const vz = pos[s * 3 + 2] - pos[p * 3 + 2]
        if (uz * vx - ux * vz > 0) idx.push(p, q, s)
        else idx.push(p, s, q)
      }
      up(a, b, a + 1)
      up(b, b + 1, a + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  // every visible part is horizontal (the step is hidden behind the cliff face): plain up normals, no shading seams
  const nrm = new Float32Array(pos.length)
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  g.setIndex(idx)
  g.computeBoundingSphere()
  const mat = lam(0xffffff, { vertexColors: true, flat: false }).clone()
  mat.map = groundDetail()
  const mesh = new THREE.Mesh(g, mat)
  mesh.name = 'env.terrain'
  mesh.frustumCulled = false
  return mesh
}

/** Keeps the part of a convex polygon with nx * x + nz * z <= d. */
function clip2(poly: P2[], nx: number, nz: number, d: number): P2[] {
  const out: P2[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const da = nx * a[0] + nz * a[1] - d
    const db = nx * b[0] + nz * b[1] - d
    if (da <= 0) out.push(a)
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db)
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  return out
}

const area2 = (p: P2[]) => {
  let a = 0
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]
  return a / 2
}

/**
 * The lowland below the plateau (ad 0.2-2.6 s, 24.6 s): big rounded rock plates in mossy teal, 0.5-1.6 m below the
 * rim, separated by dark crevices, and the rock face under the rim. Everything goes into the nature mesh.
 * `blocks` = [x, z, radius] of big rocks standing in the lowland: no plate is made under them.
 */
function addLowland(m: Mesher, r: Rng, blocks: readonly (readonly [number, number, number])[] = []) {
  const A = new THREE.Vector3()
  const B = new THREE.Vector3()
  const Cv = new THREE.Vector3()
  const D = new THREE.Vector3()
  const E = new THREE.Vector3()

  // ---- rock face: from the rim's outer edge down to the floor, leaning out, in two bands (uneven, except in the gorge) ----
  const n = RIM.length
  const mid: THREE.Vector3[] = []
  const foot: THREE.Vector3[] = []
  for (let i = 0; i < n; i++) {
    const p = RIM[i]
    const rough = 1 - 0.85 * gorgeAt(p.x + p.nx, p.z + p.nz)
    const o1 = RIM_OUT + 0.29 + randRange(r, -0.13, 0.13) * rough
    const o2 = RIM_OUT + 0.67 + randRange(r, -0.11, 0.11) * rough
    const fx = p.x + p.nx * o2
    const fz = p.z + p.nz * o2
    mid.push(new THREE.Vector3(p.x + p.nx * o1, -0.78 - randRange(r, -0.28, 0.27) * rough, p.z + p.nz * o1))
    foot.push(new THREE.Vector3(fx, floorAt(fx, fz) - 0.05, fz))
  }
  const face: Shader = (nn, p, _ln, out) => {
    // mossy lip, bare dark rock below (in the gorge it stays a readable dark teal all the way down); west faces
    // catch a little more light than south faces
    const c = tealColor(p.x, p.z, 0.3)
    const k = (0.2 + 0.62 * sstep(-1.5, 0.05, p.y) + 0.12 * gorgeAt(p.x, p.z)) * (0.86 - 0.3 * nn.x + 0.08 * nn.y)
    out[0] = G.deep[0] * 0.35 + c[0] * k
    out[1] = G.deep[1] * 0.35 + c[1] * k
    out[2] = G.deep[2] * 0.35 + c[2] * k
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    if (!RIM[i].near || !RIM[j].near) continue
    const p = RIM[i]
    const q = RIM[j]
    A.set(p.x + p.nx * RIM_OUT, 0.006, p.z + p.nz * RIM_OUT)
    B.set(q.x + q.nx * RIM_OUT, 0.006, q.z + q.nz * RIM_OUT)
    const ox = p.nx + q.nx
    const oz = p.nz + q.nz
    m.quadFacing(A, B, mid[j], mid[i], ox, 0, oz, face)
    m.quadFacing(mid[i], mid[j], foot[j], foot[i], ox, 0, oz, face)
  }

  // ---- rock plates: Voronoi cells of a jittered hex grid, inset, rounded, each with its own height and tilt ----
  // (a jittered grid with a third of the seeds left out away from the rock face: slabs from 2.5 to 7 m across, no
  // honeycomb, and no wide black gap at the foot of the face)
  const pitch = 3.2
  const seeds: P2[] = []
  for (let j = 0; j * pitch * 0.87 < 44; j++) {
    for (let i = 0; i * pitch < 48; i++) {
      let x = 4 + (i + (j % 2) * 0.5) * pitch + randRange(r, -1.35, 1.35)
      let z = 0 + j * pitch * 0.87 + randRange(r, -1.35, 1.35)
      let d = lowlandDepth(x, z)
      if (d < -2.6 || (d > 3.2 && rand(r) < 0.34)) continue
      // seeds on or near the plateau slide into the lowland, so that the plates reach the foot of the rock face
      for (let k = 0; k < 4 && d < 1.3; k++) {
        const gx = lowlandDepth(x + 0.1, z) - lowlandDepth(x - 0.1, z)
        const gz = lowlandDepth(x, z + 0.1) - lowlandDepth(x, z - 0.1)
        const gl = Math.hypot(gx, gz) || 1
        x += (gx / gl) * (1.35 - d)
        z += (gz / gl) * (1.35 - d)
        d = lowlandDepth(x, z)
      }
      if (d < 1.2 || seeds.some(s => Math.hypot(s[0] - x, s[1] - z) < 1.9)) continue
      seeds.push([x, z])
    }
  }
  const FOOT = RIM_OUT + 0.72
  for (let si = 0; si < seeds.length; si++) {
    const [sx, sz] = seeds[si]
    let cell: P2[] = [
      [sx - 6, sz - 6],
      [sx + 6, sz - 6],
      [sx + 6, sz + 6],
      [sx - 6, sz + 6],
    ]
    for (let sj = 0; sj < seeds.length && cell.length >= 3; sj++) {
      if (sj === si) continue
      const dx = seeds[sj][0] - sx
      const dz = seeds[sj][1] - sz
      const dl = Math.hypot(dx, dz)
      if (dl > 12) continue
      cell = clip2(cell, dx / dl, dz / dl, (dx / dl) * (sx + dx / 2) + (dz / dl) * (sz + dz / 2))
    }
    // keep clear of the rock face: while a corner of the cell is closer to the plateau than FOOT, cut the cell along
    // the local tangent of the "FOOT metres from the edge" line near that corner (the cell stays convex)
    for (let it = 0; it < 12 && cell.length >= 3; it++) {
      let worst = -1
      let wd = FOOT - 0.02
      for (let k = 0; k < cell.length; k++) {
        const d = lowlandDepth(cell[k][0], cell[k][1])
        if (d < wd) {
          wd = d
          worst = k
        }
      }
      if (worst < 0) break
      const [vx, vz] = cell[worst]
      let gx = lowlandDepth(vx + 0.1, vz) - lowlandDepth(vx - 0.1, vz)
      let gz = lowlandDepth(vx, vz + 0.1) - lowlandDepth(vx, vz - 0.1)
      let gl = Math.hypot(gx, gz)
      if (gl < 1e-4) {
        gx = sx - vx
        gz = sz - vz
        gl = Math.hypot(gx, gz) || 1
      }
      gx /= gl
      gz /= gl
      // keep (p - v) . g >= FOOT - wd
      cell = clip2(cell, -gx, -gz, -(gx * vx + gz * vz + FOOT - wd))
    }
    if (cell.length < 3) continue
    // crevice: move every edge inwards
    const gap = randRange(r, 0.1, 0.26)
    const sign = area2(cell) > 0 ? 1 : -1
    let inner = cell
    for (let i = 0; i < cell.length && inner.length >= 3; i++) {
      const a = cell[i]
      const b = cell[(i + 1) % cell.length]
      const el = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (el < 1e-4) continue
      // outward normal of edge a -> b
      const ox = (sign * (b[1] - a[1])) / el
      const oz = (sign * -(b[0] - a[0])) / el
      inner = clip2(inner, ox, oz, ox * a[0] + oz * a[1] - gap)
    }
    if (inner.length < 3 || Math.abs(area2(inner)) < 3) continue
    const ring = chaikin(inner, 1)
    let cx = 0
    let cz = 0
    for (const v of ring) {
      cx += v[0] / ring.length
      cz += v[1] / ring.length
    }
    if (blocks.some(b => Math.hypot(b[0] - cx, b[1] - cz) < b[2] * 0.8)) continue
    const d = lowlandDepth(cx, cz)
    const gorge = gorgeAt(cx, cz)
    if (gorge > 0.5) continue
    // terraces: 0.75 m below the rim next to it, CLIFF_DROP and more further out, stepping down towards the gorge
    const top = -(0.7 + (L.CLIFF_DROP - 0.6) * sstep(1.2, 7.5, d)) - randRange(r, 0, 0.45) - (L.FALL_DROP - L.CLIFF_DROP) * gorge
    const tx = randRange(r, -0.05, 0.05)
    const tz = randRange(r, -0.05, 0.05)
    const yAt = (x: number, z: number) => top + tx * (x - cx) + tz * (z - cz)
    const base = mulC(tealColor(cx, cz, d), randRange(r, 1.12, 1.5))
    base[2] *= 1.07
    let rad = 0
    for (const v of ring) rad = Math.max(rad, Math.hypot(v[0] - cx, v[1] - cz))
    const plate: Shader = (nn, p, _ln, out) => {
      let k: number
      if (nn.y > 0.93) {
        // top: lighter in the middle, mottled
        const q = Math.hypot(p.x - cx, p.z - cz) / rad
        k = (1.1 - 0.22 * q * q) * (1 + 0.1 * nB(p.x / 9, p.z / 9))
      } else if (nn.y > 0.2) {
        // worn edge: the rims that face the light (screen upper-left) are pale, the others fall into shade
        k = 0.8 + 0.42 * sat(-(0.55 * nn.x + 0.85 * nn.z) / (Math.hypot(nn.x, nn.z) || 1))
      } else {
        // side: fades into the crevice
        k = 0.5 * (1 - sstep(0.1, 1.3, top - p.y)) * (0.9 - 0.25 * nn.x)
      }
      out[0] = G.deep[0] * 0.3 + base[0] * k
      out[1] = G.deep[1] * 0.3 + base[1] * k
      out[2] = G.deep[2] * 0.3 + base[2] * k
    }
    const bevel = 0.2
    const N = ring.length
    Cv.set(cx, yAt(cx, cz) + 0.04, cz)
    for (let i = 0; i < N; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % N]
      // inner (top) ring: 0.3 m towards the centre
      const ia = Math.max(0.55, 1 - 0.3 / (Math.hypot(a[0] - cx, a[1] - cz) || 1))
      const ib = Math.max(0.55, 1 - 0.3 / (Math.hypot(b[0] - cx, b[1] - cz) || 1))
      A.set(cx + (a[0] - cx) * ia, 0, cz + (a[1] - cz) * ia)
      B.set(cx + (b[0] - cx) * ib, 0, cz + (b[1] - cz) * ib)
      A.y = yAt(A.x, A.z)
      B.y = yAt(B.x, B.z)
      m.triFacing(Cv, A, B, 0, 1, 0, plate)
      D.set(a[0], yAt(a[0], a[1]) - bevel, a[1])
      E.set(b[0], yAt(b[0], b[1]) - bevel, b[1])
      m.quadFacing(A, D, E, B, 0, 1, 0, plate)
      const ox = (a[0] + b[0]) / 2 - cx
      const oz = (a[1] + b[1]) / 2 - cz
      A.set(a[0], floorAt(a[0], a[1]) - 0.05, a[1])
      B.set(b[0], floorAt(b[0], b[1]) - 0.05, b[1])
      m.quadFacing(D, A, B, E, ox, 0, oz, plate)
    }
  }
}

// bed colours: the PAL slate pulled towards the dirt (ad 38-40 s: the cleared bed is the same earth as the banks,
// a step darker and cooler: #5f6364 next to #72716c)
const BED = mixC(G.bed, mulC(G.dirt, 0.75), 0.42)
const BED2 = mixC(G.bed2, mulC(G.dirt, 0.85), 0.42)

/** River bed ribbon following world/river.ts: slate bed, darker banks, blended into the terrain colour at the edges. */
function buildRiverBed(): THREE.Mesh {
  const pos: number[] = []
  const col: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const pt = { x: 0, z: 0 }
  const out: V3 = [0, 0, 0]
  const s0 = -36
  const step = 0.6
  const n = Math.ceil((RIVER_LENGTH - s0) / step)
  const rows = 9
  for (let i = 0; i <= n; i++) {
    const s = Math.min(RIVER_LENGTH, s0 + i * step)
    const hw = L.RIVER_HALF_WIDTH_N + (L.RIVER_HALF_WIDTH_S - L.RIVER_HALF_WIDTH_N) * sat(s / RIVER_LENGTH)
    const wob = 0.18 * nB(s / 19, 0.3)
    const wob2 = 0.18 * nB(s / 19, 0.7)
    // lateral offsets (negative = east bank), and what is painted there
    const ds = [-(hw + 0.95 + wob), -(hw + 0.4 + wob), -(hw + 0.05), -(hw - 0.7), 0, hw - 0.7, hw + 0.05, hw + 0.4 + wob2, hw + 0.95 + wob2]
    // towards the fall the bed dissolves into the ground colour (the lip itself is terrain)
    const end = sstep(RIVER_LENGTH - 2.2, RIVER_LENGTH - 0.2, s)
    for (let k = 0; k < rows; k++) {
      riverPoint(s, ds[k], pt)
      const a = nA(pt.x / 31, pt.z / 31)
      const ground = groundColor(pt.x, pt.z, -5, out)
      let c: V3
      if (k === 0 || k === rows - 1) c = [ground[0], ground[1], ground[2]]
      else if (k === 1 || k === rows - 2) c = mulC(mixC(ground, BED, 0.45), 0.9)
      else if (k === 2 || k === rows - 3) c = mulC(BED, 0.82)
      else if (k === 4) c = mulC(mixC(BED, BED2, sat(0.65 + 0.5 * a)), 1.05)
      else c = mixC(BED, BED2, sat(0.3 + 0.5 * a))
      if (end > 0) c = mixC(c, ground, end)
      pos.push(pt.x, 0.012, pt.z)
      col.push(c[0], c[1], c[2])
      uv.push(pt.x / GROUND_DETAIL_SIZE, pt.z / GROUND_DETAIL_SIZE)
    }
    if (i > 0) {
      const a = (i - 1) * rows
      const b = i * rows
      for (let k = 0; k < rows - 1; k++) idx.push(a + k, a + k + 1, b + k, b + k, a + k + 1, b + k + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  const mesh = new THREE.Mesh(g, lamMap(groundDetail(), true))
  mesh.name = 'env.riverBed'
  mesh.frustumCulled = false
  return mesh
}

/** Flat textured rectangle on the ground (uv from uvOf). */
function floorRect(x0: number, z0: number, x1: number, z1: number, y: number, mat: THREE.Material, uvOf: (x: number, z: number) => [number, number]): THREE.Mesh {
  const g = new THREE.BufferGeometry()
  const p = [x0, y, z0, x0, y, z1, x1, y, z0, x1, y, z1]
  const uv: number[] = []
  for (let i = 0; i < 4; i++) uv.push(...uvOf(p[i * 3], p[i * 3 + 2]))
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex([0, 1, 2, 2, 1, 3])
  return new THREE.Mesh(g, mat)
}

/** Pen bay sand: half disc bulging west, darker towards the fence. */
function buildPenSand(): THREE.Mesh {
  const { x: cx, z: cz, r } = L.PEN
  const pos: number[] = [cx, 0.012, cz]
  const col: number[] = []
  const uv: number[] = [cx / GROUND_DETAIL_SIZE, cz / GROUND_DETAIL_SIZE]
  const sand = mulC(G.sand, 1.13)
  col.push(...sand)
  const idx: number[] = []
  const seg = 28
  const rings = [0.82 * r, r + 0.02]
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI / 2 + (i / seg) * Math.PI // from south (+z) through west to north
    for (let k = 0; k < rings.length; k++) {
      const x = cx + Math.cos(a) * rings[k]
      const z = cz + Math.sin(a) * rings[k]
      pos.push(x, 0.012, z)
      const c = k === 0 ? sand : mulC(sand, 0.62)
      col.push(c[0], c[1], c[2])
      uv.push(x / GROUND_DETAIL_SIZE, z / GROUND_DETAIL_SIZE)
    }
    if (i > 0) {
      const a0 = 1 + (i - 1) * 2
      const b0 = 1 + i * 2
      idx.push(0, b0, a0, a0, b0, a0 + 1, a0 + 1, b0, b0 + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  const mesh = new THREE.Mesh(g, lamMap(groundDetail(), true))
  mesh.name = 'env.penSand'
  return mesh
}

// =====================================================================================================================
// contact shadows: one merged decal mesh sharing the blob texture of materials.blobShadow()
// =====================================================================================================================

class ShadowMesher {
  private pos: number[] = []
  private uv: number[] = []
  private idx: number[] = []
  y = 0.018

  private quad(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number, u0: number, u1: number, y: number) {
    const i = this.pos.length / 3
    this.pos.push(ax, y, az, bx, y, bz, cx, y, cz, dx, y, dz)
    this.uv.push(u0, 0, u1, 0, u0, 1, u1, 1)
    this.idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3)
  }

  /** Round / elliptical blob centred on (x, z). */
  blob(x: number, z: number, w: number, d = w, yaw = 0, y = this.y) {
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    const ex = (c * w) / 2
    const ez = (-s * w) / 2
    const fx = (s * d) / 2
    const fz = (c * d) / 2
    this.quad(x - ex - fx, z - ez - fz, x + ex - fx, z + ez - fz, x - ex + fx, z - ez + fz, x + ex + fx, z + ez + fz, 0, 1, y)
  }

  /** Soft band of half width hw along a -> b with rounded ends. */
  strip(ax: number, az: number, bx: number, bz: number, hw: number, y = this.y) {
    const len = Math.hypot(bx - ax, bz - az)
    if (len < 1e-4) return this.blob(ax, az, hw * 2, hw * 2, 0, y)
    const tx = (bx - ax) / len
    const tz = (bz - az) / len
    const nx = -tz * hw
    const nz = tx * hw
    const cx = tx * hw
    const cz = tz * hw
    this.quad(ax - cx - nx, az - cz - nz, ax - nx, az - nz, ax - cx + nx, az - cz + nz, ax + nx, az + nz, 0, 0.5, y)
    this.quad(ax - nx, az - nz, bx - nx, bz - nz, ax + nx, az + nz, bx + nx, bz + nz, 0.5, 0.5, y)
    this.quad(bx - nx, bz - nz, bx + cx - nx, bz + cz - nz, bx + nx, bz + nz, bx + cx + nx, bz + cz + nz, 0.5, 1, y)
  }

  build(opacity: number, name: string): THREE.Mesh {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setIndex(this.idx)
    const tex = (blobShadow(1).material as THREE.MeshBasicMaterial).map
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    const mesh = new THREE.Mesh(g, mat)
    mesh.name = name
    mesh.renderOrder = -20
    mesh.frustumCulled = false
    return mesh
  }
}

// =====================================================================================================================
// layout helpers shared by createEnv() and the gallery
// =====================================================================================================================

/** Pen gate: hinge position, yaw of the closed leaf (local +x along the leaf) and signed swing for "open inward". */
function penGateFrame() {
  const { x: cx, z: cz, r } = L.PEN
  const half = L.PEN_GATE.w / 2 / r
  const a0 = (L.PEN_GATE.angleDeg * Math.PI) / 180
  // angle measured from west (-x) towards south (+z)
  const at = (a: number): [number, number] => [cx - Math.cos(a) * r, cz + Math.sin(a) * r]
  const hinge = at(a0 + half) // the south end (ad 12.0 s, 30.0 s)
  const free = at(a0 - half)
  const yaw = yawOf(free[0] - hinge[0], free[1] - hinge[1])
  // inward = towards the pen centre; pick the swing direction whose open leaf points there
  const open = yawOf(cx - (hinge[0] + free[0]) / 2, cz - (hinge[1] + free[1]) / 2)
  let swing = open - yaw
  while (swing > Math.PI) swing -= 2 * Math.PI
  while (swing < -Math.PI) swing += 2 * Math.PI
  // nominally 90 deg (SPEC 2.7); the leaf goes 15 deg further so that it does not end up exactly edge-on to the
  // fixed game camera (in the ad its face stays visible when open)
  return { hinge, free, yaw, swing: Math.sign(swing) * ((105 * Math.PI) / 180), a0, half }
}

function buildGateLeaf(arch: THREE.Material): THREE.Mesh {
  const f = penGateFrame()
  const m = new Mesher()
  m.paintYaw = f.yaw
  const w = Math.hypot(f.free[0] - f.hinge[0], f.free[1] - f.hinge[1])
  const r = makeRng(606)
  const n = 5
  // inside of the pen = towards the pen centre, expressed for the closed leaf
  const inX = L.PEN.x - (f.hinge[0] + f.free[0]) / 2
  const inZ = L.PEN.z - (f.hinge[1] + f.free[1]) / 2
  const il = Math.hypot(inX, inZ)
  for (let i = 0; i < n; i++) addPicket(m, ((i + 0.5) / n) * w, 0, 0, i % 2 ? randRange(r, 0.8, 0.88) : randRange(r, 1.0, 1.1), w / n - 0.012, i % 2 ? null : randRange(r, -0.08, 0.08), inX / il, inZ / il)
  // two rails on the pen side
  const rail = archShade(COL.picket, COL.picketTop)
  m.box(w / 2, 0.22, 0.085, w - 0.04, 0.09, 0.05, 0, rail)
  m.box(w / 2, 0.6, 0.085, w - 0.04, 0.09, 0.05, 0, rail)
  const mesh = new THREE.Mesh(m.build(), arch)
  mesh.name = 'env.penGate'
  return mesh
}

/** One leaf of ward-1's south gate (ad 23.8-25.3 s): dark boards with a chevron brace; the pair closes to a low arch. */
function buildSouthDoorLeaf(arch: THREE.Material, right: boolean): THREE.Mesh {
  const m = new Mesher()
  m.paintYaw = right ? Math.PI : 0
  // the east leaf turns its inner face to the camera when it is open
  addLeaf(m, L.WARD1_DOOR.w / 2 - 0.03, WALL_H - 0.14, { arch: 0.3, brace: 'v', knobAt: L.WARD1_DOOR.w / 2 - 0.28, thick: 0.12, backYaw: right ? Math.PI + SOUTH_SWING : undefined })
  const mesh = new THREE.Mesh(m.build(), arch)
  mesh.name = 'env.southDoor'
  return mesh
}

function buildNorthDoorLeaf(arch: THREE.Material, right: boolean): THREE.Mesh {
  const m = new Mesher()
  m.paintYaw = right ? Math.PI : 0
  addLeaf(m, L.NORTH_DOOR.w / 2 - 0.03, WALL_H - 0.3, { arch: 0.24, brace: 'panels', knobAt: L.NORTH_DOOR.w / 2 - 0.26, thick: 0.12 })
  const mesh = new THREE.Mesh(m.build(), arch)
  mesh.name = 'env.northDoor'
  return mesh
}

/** Openings read from L.WALLS: the yard gateway (gap in the yard's south wall) and ward-1's open north side. */
const gapIn = (z: number, tol: number) => {
  const segs = L.WALLS.filter(w => Math.abs(w[1] - z) < tol && Math.abs(w[3] - z) < tol && Math.abs(w[2] - w[0]) > 0.5).sort((a, b) => a[0] - b[0])
  return { x0: segs[0][2], x1: segs[segs.length - 1][0], z: (segs[0][3] + segs[segs.length - 1][1]) / 2 }
}
const GATEWAY = gapIn(L.WARD2[3], 0.05)
const OPEN1 = gapIn(L.WARD1[1], 0.3)

interface WallPlan {
  posts: [number, number][] // x, z
  panels: [number, number, number, number][]
}

/** Splits L.WALLS into posts (every corner / end and every 4-5 m) and the panels between them. */
function planWalls(): WallPlan {
  const plan: WallPlan = { posts: [], panels: [] }
  // posts shared by two segments (corners) are created once
  const addPostAt = (x: number, z: number): [number, number] => {
    for (const p of plan.posts) if (Math.hypot(p[0] - x, p[1] - z) < 0.45) return p
    plan.posts.push([x, z])
    return [x, z]
  }
  const half = POST / 2 - 0.03
  for (const [ax, az, bx, bz] of L.WALLS) {
    const len = Math.hypot(bx - ax, bz - az)
    const n = Math.max(1, Math.round(len / 5.2))
    let prev = addPostAt(ax, az)
    for (let i = 1; i <= n; i++) {
      const t = i / n
      const cur = addPostAt(ax + (bx - ax) * t, az + (bz - az) * t)
      const dx = cur[0] - prev[0]
      const dz = cur[1] - prev[1]
      const l = Math.hypot(dx, dz)
      if (l > 2 * half + 0.05) {
        const ux = (dx / l) * half
        const uz = (dz / l) * half
        plan.panels.push([prev[0] + ux, prev[1] + uz, cur[0] - ux, cur[1] - uz])
      }
      prev = cur
    }
  }
  return plan
}

/** Position (x, z) and outward-facing yaw of every fixed pen picket (the gate span is left out). */
function penPickets(): { x: number; z: number; yaw: number; h: number; tip: number | null; w: number }[] {
  const { x: cx, z: cz, r } = L.PEN
  const f = penGateFrame()
  const out: { x: number; z: number; yaw: number; h: number; tip: number | null; w: number }[] = []
  const pitch = 0.3
  const n = Math.round((Math.PI * r) / pitch)
  const rng = makeRng(808)
  for (let i = 0; i < n; i++) {
    // angle from north (-z) through west (-x) to south (+z); in "south of west" terms a = t - PI/2
    const t = ((i + 0.5) / n) * Math.PI
    const sw = t - Math.PI / 2
    const tall = i % 2 === 0
    const h = tall ? randRange(rng, 1.0, 1.13) : randRange(rng, 0.78, 0.9)
    const tip = tall ? randRange(rng, -0.09, 0.09) : null
    if (sw > f.a0 - f.half - 0.02 && sw < f.a0 + f.half + 0.02) continue
    const x = cx - Math.sin(t) * r
    const z = cz - Math.cos(t) * r
    // slab plane tangent to the arc
    out.push({ x, z, yaw: yawOf(Math.cos(t), -Math.sin(t)), h, tip, w: (Math.PI * r) / n + 0.012 })
  }
  return out
}

// =====================================================================================================================
// createEnv
// =====================================================================================================================

export function createEnv(scene: THREE.Scene): Env {
  const root = new THREE.Group()
  root.name = 'env'
  scene.add(root)
  const rng = makeRng(20261012)

  const archMat = archMaterial()
  const natureMat = natureMaterial()

  // ---------------- terrain and floors ----------------
  root.add(buildTerrain(), buildRiverBed(), buildPenSand())

  const [cx0, cz0, cx1, cz1] = L.COURTYARD
  // The stone answers the lantern only half as much as the dirt does (see the LIGHT RIG notes in stage.ts): half of
  // the albedo is lit, the other half is emissive, so under the ambient rig (E = 1 on +y) the sum is the texture colour.
  const tileMat = lamMap(courtyardTiles(), false)
  tileMat.color.setScalar(TILE_LIT)
  tileMat.emissive.setScalar(1 - TILE_LIT)
  tileMat.emissiveMap = tileMat.map
  const tiles = floorRect(cx0, cz0, cx1, cz1, 0.012, tileMat, (x, z) => [(x - cx0) / (cx1 - cx0), 1 - (z - cz0) / (cz1 - cz0)])
  tiles.name = 'env.courtyard'
  const plankMat = lamMap(plankFloor(), false)
  const plankUv = (x: number, z: number): [number, number] => [x / PLANK_TILE.u, -z / PLANK_TILE.v]
  const [w1x0, w1z0, w1x1, w1z1] = L.WARD1
  const ward1Floor = floorRect(w1x0, w1z0, w1x1, w1z1, 0.016, plankMat, plankUv)
  ward1Floor.name = 'env.ward1Floor'
  const [w2x0, w2z0, w2x1, w2z1] = L.WARD2
  const ward2Floor = floorRect(w2x0, w2z0, w2x1, w2z1, 0.016, plankMat, (x, z) => [x / PLANK_TILE.u + 0.37, -z / PLANK_TILE.v + 0.21])
  ward2Floor.name = 'env.ward2Floor'
  ward2Floor.visible = false
  root.add(tiles, ward1Floor, ward2Floor)

  // ---------------- architecture (one merged mesh) ----------------
  const arch = new Mesher()
  const shadows = new ShadowMesher()
  const plan = planWalls()
  for (const [x, z] of plan.posts) {
    addPost(arch, x, z)
    shadows.blob(x + 0.08, z + 0.08, 1.6)
  }
  for (const [ax, az, bx, bz] of plan.panels) {
    // ward-1's east wall shows its inner (west) face to the camera: lit, like the room
    const wardEast = Math.abs(ax - L.WARD1[2]) < 0.05 && Math.abs(bx - L.WARD1[2]) < 0.05
    addWallPanel(arch, ax, az, bx, bz, wardEast ? LP_ROOM : LP)
    shadows.strip(ax + 0.06, az + 0.06, bx + 0.06, bz + 0.06, 0.75)
  }

  // curbs and trims
  const curb = archShade(mulC(COL.curb, 0.8), COL.curb)
  // open east side of the courtyard (down to ward-1's north-east stub)
  arch.box(cx1 + 0.11, 0, (cz0 + OPEN1.z) / 2 - 0.2, 0.24, 0.07, OPEN1.z - cz0 - 0.5, 0, curb)
  // gateway threshold (north side)
  arch.box((GATEWAY.x0 + GATEWAY.x1) / 2, 0, cz0 - 0.09, GATEWAY.x1 - GATEWAY.x0 - POST, 0.07, 0.2, 0, curb)
  // pen bay mouth (west side): a darker kerb stone between the sand and the tiles
  arch.box(cx0 - 0.1, 0, L.PEN.z, 0.24, 0.09, 2 * L.PEN.r - 0.5, 0, archShade(mulC(COL.wallFrame, 0.9), mulC(COL.curb, 0.62)))
  // ward-1: pale trim board where the planks meet the stone (open north side between the two stubs)
  const trim = archShade(mulC(COL.trim, 0.75), mulC(COL.trim, 1.08))
  arch.box((OPEN1.x0 + OPEN1.x1) / 2, 0, w1z0 + 0.02, OPEN1.x1 - OPEN1.x0 - POST, 0.07, 0.2, 0, trim)

  // pen fence: fixed pickets + two inner rails per span
  const pk = penPickets()
  for (const p of pk) addPicket(arch, p.x, p.z, p.yaw, p.h, p.w, p.tip, (L.PEN.x - p.x) / L.PEN.r, (L.PEN.z - p.z) / L.PEN.r)
  {
    const { x: pcx, z: pcz, r } = L.PEN
    const f = penGateFrame()
    const rail = archShade(COL.picket, COL.picketTop)
    const seg = 26
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI
      const t1 = ((i + 1) / seg) * Math.PI
      const tm = (t0 + t1) / 2
      const sw = tm - Math.PI / 2
      const inGate = sw > f.a0 - f.half && sw < f.a0 + f.half
      const rr = r - 0.095
      const x0 = pcx - Math.sin(t0) * rr
      const z0 = pcz - Math.cos(t0) * rr
      const x1 = pcx - Math.sin(t1) * rr
      const z1 = pcz - Math.cos(t1) * rr
      if (!inGate) {
        const yaw = yawOf(x1 - x0, z1 - z0)
        const l = Math.hypot(x1 - x0, z1 - z0) + 0.02
        arch.box((x0 + x1) / 2, 0.22, (z0 + z1) / 2, l, 0.09, 0.05, yaw, rail)
        arch.box((x0 + x1) / 2, 0.6, (z0 + z1) / 2, l, 0.09, 0.05, yaw, rail)
      }
      shadows.strip(pcx - Math.sin(t0) * (r + 0.05), pcz - Math.cos(t0) * (r + 0.05), pcx - Math.sin(t1) * (r + 0.05), pcz - Math.cos(t1) * (r + 0.05), 0.42)
    }
  }

  // iron fence on the east bank
  addIronFence(arch, rng, L.IRON_FENCE.x, L.IRON_FENCE.z, L.IRON_FENCE.len)
  shadows.strip(L.IRON_FENCE.x + 0.1, L.IRON_FENCE.z - L.IRON_FENCE.len / 2, L.IRON_FENCE.x + 0.1, L.IRON_FENCE.z + L.IRON_FENCE.len / 2, 0.45)

  const archMesh = new THREE.Mesh(arch.build(), archMat)
  archMesh.name = 'env.architecture'
  root.add(archMesh)

  // ---------------- nature (one merged mesh) ----------------
  const nat = new Mesher()
  L.BOULDERS.forEach(([x, z, r], i) => {
    // sizes around the collider circle (the visual may be up to a quarter wider); big and small alternate so that a
    // row does not read as a string of equal beads. The first two are the pair at the river mouth (ad 0.2-2.6 s).
    const k = i < 2 ? 1 - 0.06 * i : i % 2 ? randRange(rng, 1.08, 1.26) : randRange(rng, 0.8, 0.94)
    const rx = r * k * randRange(rng, 0.88, 1.06)
    const rz = r * k * randRange(rng, 0.82, 1.0)
    // the rows stand a little out of line (the collider circles stay where L.BOULDERS puts them)
    const vx = x + (i < 2 ? 0 : randRange(rng, -0.25, 0.25))
    const vz = z + (i < 2 ? 0 : randRange(rng, -0.25, 0.25))
    addRock(nat, rng, vx, 0, vz, rx, r * k * randRange(rng, 1.6, 2.3), rz, ROCK, randRange(rng, 0.85, 1.1))
    shadows.blob(vx + 0.12 * r, vz + 0.12 * r, rx * 3.0, rz * 3.0)
  })
  // pebbles along both banks (decorative, too small to collide)
  for (let i = 0; i < 46; i++) {
    const s = randRange(rng, -8, RIVER_LENGTH - 1.5)
    const side = rand(rng) < 0.5 ? -1 : 1
    const hw = L.RIVER_HALF_WIDTH_N + (L.RIVER_HALF_WIDTH_S - L.RIVER_HALF_WIDTH_N) * sat(s / RIVER_LENGTH)
    const p = riverPoint(s, side * (hw + randRange(rng, 0.25, 1.0)))
    // keep the river entry by the grinder clear (the scoop and the cart come through here)
    if (side > 0 && p.z > -7.5 && p.z < 0.3) continue
    const r = randRange(rng, 0.09, 0.2)
    addRock(nat, rng, p.x, 0, p.z, r * 1.2, r * 1.1, r, PEBBLE)
  }
  for (const [x, z] of L.CONIFERS) {
    // (ad 11.4 s, 51 s: 1.5 to 2.8 m tall, about 1.5 times as tall as wide)
    const h = randRange(rng, 1.9, 2.9)
    const w = h / randRange(rng, 1.28, 1.48)
    addConifer(nat, rng, x, 0, z, h, w)
    shadows.blob(x + 0.15, z + 0.15, w * 1.45)
  }
  // cliff blocks: backdrop to the north and east, with a gap where the river comes through. Three ranks: giant
  // boulders (as behind ward 2 at 51 s), taller blocks behind them, and a wall that closes the view in the fog.
  const blocks: [number, number, number][] = []
  const cliff = (x: number, z: number, rx: number, h: number, rz: number, round = 0.9, y = 0) => {
    const rs = riverSample(x, z)
    if (Math.abs(rs.d) < rs.halfW + Math.max(rx, rz) * 0.85 + 0.6 && z < L.CLIFF_Z + 2) return
    addRock(nat, rng, x, y, z, rx, h, rz, CLIFF, round)
    blocks.push([x, z, Math.max(rx, rz)])
    if (y === 0) shadows.blob(x + 0.3, z + 0.3, rx * 2.6, rz * 2.6)
  }
  for (let x = -46; x <= 36; x += randRange(rng, 5.6, 7.6)) {
    const bend = 0.012 * (x - 2) * (x - 2)
    cliff(x, -28.4 - Math.min(bend, 9) * 0.25 + randRange(rng, -1.0, 1.0), randRange(rng, 3.4, 4.8), randRange(rng, 3.6, 5.6), randRange(rng, 3.0, 4.2))
    cliff(x + randRange(rng, -2, 2), -35 + randRange(rng, -1.5, 1.5), randRange(rng, 4.5, 6.2), randRange(rng, 7, 10), randRange(rng, 4, 5.5), 0.7)
    cliff(x + randRange(rng, -2, 2), -43 + randRange(rng, -1.5, 1.5), randRange(rng, 5, 7), randRange(rng, 11, 15), randRange(rng, 4.5, 6), 0.5)
  }
  for (let z = -30; z <= 3; z += randRange(rng, 5.4, 7.2)) {
    cliff(30.6 + randRange(rng, -1, 1.2), z, randRange(rng, 3.0, 4.0), randRange(rng, 3.6, 5.6), randRange(rng, 3.4, 4.8))
    cliff(37.5 + randRange(rng, -1.5, 1.5), z + randRange(rng, -2, 2), randRange(rng, 4.5, 6), randRange(rng, 7, 10), randRange(rng, 4.5, 6), 0.7)
    cliff(45 + randRange(rng, -1.5, 1.5), z + randRange(rng, -2, 2), randRange(rng, 5, 6.5), randRange(rng, 11, 15), randRange(rng, 5, 7), 0.5)
  }
  // big blocks seen behind ward-2 and at the river source in the ad, and the end of the east bank at the fall
  cliff(13.2, -25.6, 4.6, 5.2, 3.6)
  cliff(-3.5, -25.4, 3.6, 4.4, 2.8)
  cliff(27.8, 6.2, 3.6, 5.6, 3.4, 0.95, LOW_FLOOR + 0.2)
  cliff(33.5, 10, 4.8, 7.4, 4.2, 0.9, LOW_FLOOR + 0.2)
  // decorative forest outside the walkable bounds (never inside L.BOUNDS, so no collider is needed)
  const extraTrees: [number, number][] = [
    [-11, -13.5], [-14.5, -17], [-10.5, -21.5], [-17, -12.5], [-20, -19], [-24, -14], [-15, -24.5], [-6, -23.5], [5.5, -23.6], [14.5, -22.6],
    [-4.4, -22.3], [7.6, -22.2], [2.9, -23.3], [-12.5, -19.5],
    [17.5, -24.5], [-28, -22], [-31, -15], [26.8, -12.5], [27.2, -1.5], [26.5, -21], [-22, -26], [-33, -27],
  ]
  for (const [x, z] of extraTrees) {
    if (blocks.some(b => Math.hypot(b[0] - x, b[1] - z) < b[2] + 1.2)) continue
    const h = randRange(rng, 1.7, 3.0)
    const w = h / randRange(rng, 1.28, 1.48)
    addConifer(nat, rng, x, 0, z, h, w)
    shadows.blob(x + 0.15, z + 0.15, w * 1.45)
  }
  // the lowland: rock face under the plateau rim and the rock plates below it
  addLowland(nat, rng, blocks)
  const natMesh = new THREE.Mesh(nat.build(), natureMat)
  natMesh.name = 'env.nature'
  root.add(natMesh)

  // ---------------- contact shadows ----------------
  root.add(shadows.build(0.6, 'env.shadows'))

  // ---------------- pivots: pen gate, south gate, north double door ----------------
  const gf = penGateFrame()
  const gate = new THREE.Group()
  gate.name = 'env.penGatePivot'
  gate.position.set(gf.hinge[0], 0, gf.hinge[1])
  gate.rotation.y = gf.yaw
  gate.add(buildGateLeaf(archMat))
  root.add(gate)

  const southL = new THREE.Group()
  const southR = new THREE.Group()
  const northL = new THREE.Group()
  const northR = new THREE.Group()
  southL.name = 'env.southDoorPivotL'
  southR.name = 'env.southDoorPivotR'
  southL.position.set(L.WARD1_DOOR.x - L.WARD1_DOOR.w / 2, 0, L.WARD1_DOOR.z)
  southR.position.set(L.WARD1_DOOR.x + L.WARD1_DOOR.w / 2, 0, L.WARD1_DOOR.z)
  southR.rotation.y = Math.PI
  southL.add(buildSouthDoorLeaf(archMat, false))
  southR.add(buildSouthDoorLeaf(archMat, true))
  root.add(southL, southR)

  northL.name = 'env.northDoorPivotL'
  northR.name = 'env.northDoorPivotR'
  northL.position.set(L.NORTH_DOOR.x - L.NORTH_DOOR.w / 2, 0, L.NORTH_DOOR.z)
  northR.position.set(L.NORTH_DOOR.x + L.NORTH_DOOR.w / 2, 0, L.NORTH_DOOR.z)
  northR.rotation.y = Math.PI
  northL.add(buildNorthDoorLeaf(archMat, false))
  northR.add(buildNorthDoorLeaf(archMat, true))
  root.add(northL, northR)

  // yard gateway leaves: always open. While the yard is derelict they stand square to the wall (as in the ad);
  // once ward 2 is built they fold flat against the stubs so that they clear the beds.
  const leafLen = Math.min(2.3, (GATEWAY.x1 - GATEWAY.x0) / 2 - 0.35)
  const leafZ = GATEWAY.z - WALL_T / 2 - 0.1
  const gateway = (
    [
      { x: GATEWAY.x1 - POST / 2 + 0.02, open: Math.PI / 2 + 0.07, folded: 0.03 }, // east leaf
      { x: GATEWAY.x0 + POST / 2 - 0.02, open: Math.PI / 2 - 0.22, folded: Math.PI - 0.03 }, // west leaf
    ] as const
  ).map(d => {
    const lm = new Mesher()
    lm.paintYaw = d.open
    addLeaf(lm, leafLen, WALL_H - 0.1, { brace: 'none', base: mulC(COL.wall, 0.92), frame: COL.wallFrame, thick: 0.14, y0: 0.05 })
    const pivot = new THREE.Group()
    pivot.name = 'env.gatewayLeafPivot'
    pivot.position.set(d.x, 0, leafZ)
    pivot.rotation.y = d.open
    const mesh = new THREE.Mesh(lm.build(), archMat)
    mesh.name = 'env.gatewayLeaf'
    pivot.add(mesh)
    root.add(pivot)
    return { pivot, open: d.open, folded: d.folded, x: d.x }
  })

  // ---------------- yard props (gone once ward 2 is bought) ----------------
  const yard = new THREE.Group()
  yard.name = 'env.yardProps'
  {
    const pm = new Mesher()
    const ps = new ShadowMesher()
    const [c1, c2, fr, bn] = L.YARD_PROPS
    // tall stack in the corner + single crate
    addCrate(pm, c1[0], 0, c1[1], c1[2], 0.06)
    addCrate(pm, c1[0] + 0.03, c1[2], c1[1] - 0.02, c1[2] * 0.93, -0.12)
    addCrate(pm, c2[0], 0, c2[1], c2[2], -0.1)
    ps.blob(c1[0] + 0.15, c1[1] + 0.15, 2.5)
    ps.blob(c2[0] + 0.12, c2[1] + 0.12, 2.1)
    addFlatFrame(pm, fr[0], fr[1], fr[2], fr[3], 0)
    ps.blob(fr[0] + 0.1, fr[1] + 0.1, fr[2] * 1.5, fr[3] * 1.3)
    addBench(pm, bn[0], bn[1], bn[2], bn[3], 0)
    ps.blob(bn[0] + 0.1, bn[1] + 0.1, bn[2] * 1.4, bn[3] * 2.2)
    for (const g of gateway) ps.strip(g.x, leafZ, g.x + Math.cos(g.open) * leafLen, leafZ - Math.sin(g.open) * leafLen, 0.45)
    const mesh = new THREE.Mesh(pm.build(), archMat)
    mesh.name = 'env.yardProps.mesh'
    yard.add(mesh, ps.build(0.5, 'env.yardProps.shadows'))
    // cobwebs on the crates and dry reeds: two merged meshes of alpha-textured quads (transparent, so the stage draws
    // them after the outline pass)
    const quads = (name: string, mat: THREE.Material) => {
      const pos: number[] = []
      const uv: number[] = []
      const idx: number[] = []
      const e = new THREE.Euler()
      const add = (x: number, y: number, z: number, w: number, h: number, yaw: number, tilt = 0) => {
        _q.setFromEuler(e.set(tilt, yaw, 0, 'YXZ'))
        const k = pos.length / 3
        for (const [lx, ly] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]] as const) {
          _v.set(lx * w, ly * h, 0).applyQuaternion(_q)
          pos.push(x + _v.x, y + _v.y, z + _v.z)
          uv.push(lx + 0.5, ly + 0.5)
        }
        idx.push(k, k + 1, k + 2, k + 2, k + 1, k + 3)
      }
      const done = () => {
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
        g.setIndex(idx)
        const q = new THREE.Mesh(g, mat)
        q.name = name
        yard.add(q)
      }
      return { add, done }
    }
    const web = quads('env.yardProps.cobwebs', unlit(0xd8d8e2, { transparent: true, opacity: 0.3, map: cobweb(), side: THREE.DoubleSide, depthWrite: false }))
    web.add(c1[0] - 0.6, 1.5, c1[1] + 0.25, 0.9, 1.4, -Math.PI / 2 + 0.25, 0.1)
    web.add(c1[0] + 0.1, 1.6, c1[1] + 0.6, 0.8, 1.2, 0.15, -0.08)
    web.add(c2[0] - 0.58, 0.8, c2[1] + 0.15, 0.7, 0.9, -Math.PI / 2 - 0.2, 0.1)
    web.done()
    const reed = quads('env.yardProps.reeds', unlit(0xcfc9b8, { transparent: true, opacity: 0.85, map: reeds(), side: THREE.DoubleSide, depthWrite: false }))
    for (const [x, z, h, yaw] of [[1.5, -7.4, 1.35, 0.3], [2.1, -8.0, 1.0, 1.2], [-3.9, -8.6, 0.9, 2.0], [4.4, -11.2, 0.8, 0.7]] as const) {
      for (const a of [0, 1.1, 2.2]) reed.add(x, h / 2, z, h * 0.55, h, yaw + a)
    }
    reed.done()
  }
  root.add(yard)

  // ---------------- state ----------------
  let ward2Shown = false
  let fold = 0
  let southOpen = 0
  let northOpen = 0
  let southHold = 0
  let northHold = 0

  const env: Env = {
    root,
    debug: {},
    update(s, dt) {
      const dbg = env.debug
      // pen gate
      gate.rotation.y = gf.yaw + gf.swing * sat(dbg.gate ?? s.gate.open)
      // ward-2 switch
      const w2 = dbg.ward2 ?? s.unlocks.ward2
      if (w2 !== ward2Shown) {
        ward2Shown = w2
        yard.visible = !w2
        ward2Floor.visible = w2
      }
      if (fold !== (w2 ? 1 : 0)) {
        fold = w2 ? Math.min(1, fold + dt / 0.45) : Math.max(0, fold - dt / 0.45)
        const e = ease(fold)
        for (let i = 0; i < gateway.length; i++) gateway[i].pivot.rotation.y = gateway[i].open + (gateway[i].folded - gateway[i].open) * e
      }
      // doors: the simulation owns the opening amounts (s.doors, sim/ward.ts); the gallery's fake state has none
      const doors = (s as { doors?: { south: number; north: number } }).doors
      southHold = doors ? doors.south : 0
      northHold = doors ? doors.north : 0
      const sStep = dt / 0.2
      const sT = dbg.southDoor ?? southHold
      const nT = dbg.northDoor ?? northHold
      southOpen += Math.max(-sStep, Math.min(sStep, sT - southOpen))
      northOpen += Math.max(-sStep, Math.min(sStep, nT - northOpen))
      // south gate: both leaves swing outward (south)
      const sa = SOUTH_SWING * ease(southOpen)
      southL.rotation.y = -sa
      southR.rotation.y = Math.PI + sa
      // north double door: both leaves swing outward (north)
      const na = (Math.PI / 2) * 0.95 * ease(northOpen)
      northL.rotation.y = na
      northR.rotation.y = Math.PI - na
    },
  }
  // look-dev handle for screenshots: __env.debug.southDoor = 1 in the browser console / shot.ts eval
  ;(globalThis as { __env?: Env }).__env = env
  return env
}

const ease = (t: number) => t * t * (3 - 2 * t)

// =====================================================================================================================
// gallery
// =====================================================================================================================

function single(build: (m: Mesher, s: ShadowMesher) => void, mat?: THREE.Material): THREE.Group {
  const g = new THREE.Group()
  const m = new Mesher()
  const s = new ShadowMesher()
  build(m, s)
  g.add(new THREE.Mesh(m.build(), mat ?? archMaterial()), s.build(0.5, 'shadow'))
  return g
}

export const GALLERY: GalleryItem[] = [
  {
    name: 'env wall + posts',
    size: 3,
    make: () =>
      single((m, s) => {
        addPost(m, -2.5, 0)
        addPost(m, 2.5, 0)
        addPost(m, 2.5, 3)
        addWallPanel(m, -2.5 + POST / 2, 0, 2.5 - POST / 2, 0)
        addWallPanel(m, 2.5, POST / 2, 2.5, 3 - POST / 2)
        s.strip(-2.5, 0, 2.5, 0, 0.62)
        s.strip(2.5, 0, 2.5, 3, 0.62)
      }),
  },
  {
    name: 'env pen fence + gate (swinging)',
    size: 3.6,
    make: () => {
      const g = single(m => {
        for (const p of penPickets()) addPicket(m, p.x - L.PEN.x, p.z - L.PEN.z, p.yaw, p.h, p.w, p.tip, (L.PEN.x - p.x) / L.PEN.r, (L.PEN.z - p.z) / L.PEN.r)
      })
      const f = penGateFrame()
      const pivot = new THREE.Group()
      pivot.name = 'gate'
      pivot.position.set(f.hinge[0] - L.PEN.x, 0, f.hinge[1] - L.PEN.z)
      pivot.rotation.y = f.yaw
      pivot.add(buildGateLeaf(archMaterial()))
      g.add(pivot)
      return g
    },
    animate: (o, t) => {
      const f = penGateFrame()
      o.getObjectByName('gate')!.rotation.y = f.yaw + f.swing * ease(sat(Math.sin(t * 2) * 0.8 + 0.5))
    },
  },
  {
    name: 'env south gate (swinging)',
    size: 2.8,
    make: () => {
      const w = L.WARD1_DOOR.w
      const g = single(m => {
        addPost(m, -w / 2, 0)
        addPost(m, w / 2, 0)
      })
      const a = new THREE.Group()
      const b = new THREE.Group()
      a.name = 'L'
      b.name = 'R'
      a.position.x = -w / 2
      b.position.x = w / 2
      a.add(buildSouthDoorLeaf(archMaterial(), false))
      b.add(buildSouthDoorLeaf(archMaterial(), true))
      g.add(a, b)
      return g
    },
    animate: (o, t) => {
      const sa = SOUTH_SWING * ease(sat(Math.sin(t * 2) * 0.8 + 0.5))
      o.getObjectByName('L')!.rotation.y = -sa
      o.getObjectByName('R')!.rotation.y = Math.PI + sa
    },
  },
  {
    name: 'env north double door (swinging)',
    size: 2.4,
    make: () => {
      const w = L.NORTH_DOOR.w
      const g = single(m => {
        addPost(m, -w / 2 - POST / 2, 0)
        addPost(m, w / 2 + POST / 2, 0)
      })
      const a = new THREE.Group()
      const b = new THREE.Group()
      a.name = 'L'
      b.name = 'R'
      a.position.x = -w / 2
      b.position.x = w / 2
      a.add(buildNorthDoorLeaf(archMaterial(), false))
      b.add(buildNorthDoorLeaf(archMaterial(), true))
      g.add(a, b)
      return g
    },
    animate: (o, t) => {
      const na = (Math.PI / 2) * 0.95 * ease(sat(Math.sin(t * 2) * 0.8 + 0.5))
      o.getObjectByName('L')!.rotation.y = na
      o.getObjectByName('R')!.rotation.y = Math.PI - na
    },
  },
  {
    name: 'env boulders',
    size: 2.6,
    make: () =>
      single((m, s) => {
        const r = makeRng(5)
        addRock(m, r, -1.1, 0, 0, 1.15, 1.9, 1.05, ROCK)
        addRock(m, r, 1.2, 0, 0.5, 1.0, 1.6, 0.95, ROCK, 0.85)
        s.blob(-1.0, 0.1, 3)
        s.blob(1.3, 0.6, 2.7)
      }, natureMaterial()),
  },
  {
    name: 'env cliff block',
    size: 5,
    make: () => single(m => addRock(m, makeRng(9), 0, 0, 0, 4.4, 8, 3.8, CLIFF, 0.5), natureMaterial()),
  },
  {
    name: 'env conifers',
    size: 2.6,
    make: () =>
      single((m, s) => {
        const r = makeRng(3)
        addConifer(m, r, -1.2, 0, 0, 2.8, 1.85)
        addConifer(m, r, 1.1, 0, 0.6, 2.0, 1.4)
        s.blob(-1.1, 0.1, 2.9)
        s.blob(1.2, 0.7, 2.3)
      }, natureMaterial()),
  },
  {
    name: 'env iron fence',
    size: 3,
    make: () => single(m => addIronFence(m, makeRng(4), 0, 0, 5)),
  },
  {
    name: 'env yard props',
    size: 3.4,
    make: () =>
      single((m, s) => {
        addCrate(m, 2, 0, -2, 1.1, 0.06)
        addCrate(m, 2.03, 1.1, -2.02, 1.02, -0.12)
        addCrate(m, 1.9, 0, -0.8, 1.1, -0.1)
        addFlatFrame(m, -0.3, 0.3, 1.8, 3.7, 0)
        addBench(m, -2.2, -2.3, 2.6, 1.0, 0)
        s.blob(2.1, -1.4, 3)
      }),
  },
]

// Look-dev handle: until gallery.ts lists this module (add `env` to its MODULES map), the items can be put into any
// gallery page from the console / shot.ts eval through __envGallery.
;(globalThis as { __envGallery?: GalleryItem[] }).__envGallery = GALLERY
