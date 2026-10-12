// River props: the small cyan balls (one InstancedMesh), the big bubbles (smooth -> cracked -> faceted shell)
// and the crystal shards of the shatter (one InstancedMesh). SPEC 2.3, 2.4, 7.4, 9 rows 1-5.
//
// Shading note: balls, bubbles and shards are "gameplay objects" that must stay bright and saturated in the gloomy
// scene (SPEC 7.1), with a BAKED upper-left highlight (SPEC 7.4 "matcap"). They therefore use small unlit matcap-style
// ShaderMaterials (highlight fixed in view space, no scene lights, scene fog respected) instead of lam()/gloss().
// The output pixel is the PAL colour itself, which is what the art analyst sampled from the ad.
import * as THREE from 'three'
import { P, PAL } from '../../config'
import { BLADES } from '../../world/tools'
import { blobShadow, lam, mesh, type GalleryItem } from '../materials'
import { GRINDER_DISC_TOP, makeGrinder } from './grinder'
import { makeScoop } from './tools'

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
/** Deterministic 0..1 hash of (index, channel): per-instance variation without allocations or stored state. */
const hash = (i: number, k: number) => {
  const s = Math.sin(i * 127.1 + k * 311.7 + 1.3) * 43758.5453
  return s - Math.floor(s)
}

const FOG_UNIFORMS = () => THREE.UniformsUtils.clone(THREE.UniformsLib.fog)
const FRAG_TAIL = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
`

// ---------------------------------------------------------------------------------------------------------------------
// Small balls
// ---------------------------------------------------------------------------------------------------------------------

/** Radius of a small ball (P.BALL_DIAMETER / 2). A resting ball has its centre at y = BALL_RADIUS. */
export const BALL_RADIUS = P.BALL_DIAMETER / 2

/** The disc is this much wider than the ball, room for the antialiased edge. */
const BALL_FRINGE = 1.15

const BALL_VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  varying vec2 vP;
  varying vec3 vKey;
  varying vec3 vUp;
  varying vec3 vBack;
  varying float vDepth;
  varying float vTone;
  void main() {
    #ifdef USE_INSTANCING
      vec4 mvPosition = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
      vTone = fract(float(gl_InstanceID) * 0.6180339887);
    #else
      vec4 mvPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      vTone = 0.5;
    #endif
    // The disc faces the eye, not the view plane: off the centre of the screen a sphere shows the camera a slightly
    // different side. u, v, w are its axes in view space; a point of the disc at (x, y) stands for the sphere normal
    // x u + y v + sqrt(1 - x2 - y2) w, and the fragment shader only needs that normal's dot products.
    vec3 w = normalize(-mvPosition.xyz);
    vec3 u = normalize(cross(vec3(0.0, 1.0, 0.0), w));
    vec3 v = cross(w, u);
    // baked key light from the upper-left of the screen (view space), SPEC 7.3
    const vec3 key = vec3(-0.44, 0.54, 0.717);
    vec3 up = normalize(modelViewMatrix[1].xyz);
    vKey = vec3(dot(u, key), dot(v, key), dot(w, key));
    vUp = vec3(dot(u, up), dot(v, up), dot(w, up));
    vBack = vec3(u.z, v.z, w.z);
    vDepth = mvPosition.z;
    vP = position.xy * ${BALL_FRINGE.toFixed(3)};
    mvPosition.xyz += (u * vP.x + v * vP.y) * ${BALL_RADIUS.toFixed(4)};
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`
const BALL_FRAG = /* glsl */ `
  uniform vec3 uMid;
  uniform vec3 uHi;
  uniform vec3 uShade;
  uniform vec3 uDeep;
  uniform mat4 projectionMatrix;
  #include <common>
  #include <fog_pars_fragment>
  varying vec2 vP;
  varying vec3 vKey;
  varying vec3 vUp;
  varying vec3 vBack;
  varying float vDepth;
  varying float vTone;
  void main() {
    float r2 = dot(vP, vP);
    float rim = 1.0 - sqrt(r2);
    float cover = clamp(rim / fwidth(rim) + 0.5, 0.0, 1.0);
    if (cover <= 0.0) discard;
    vec3 n = vec3(vP, sqrt(max(1.0 - r2, 0.0)));
    // the body is the MID teal, only the upper-left cap is the light cyan and the white glint is a small dot well
    // off-centre (ad, 0.4 s)
    float d = dot(n, vKey);
    float nz = dot(n, vBack);
    vec3 c = mix(uShade, uMid, smoothstep(-0.10, 0.55, d));
    c = mix(c, uHi, smoothstep(0.74, 0.96, d) * 0.95);
    c *= 0.93 + 0.14 * vTone;
    // darker limb: neighbouring balls stay separate dots
    c = mix(c, uShade * 0.85, smoothstep(0.55, 1.0, 1.0 - max(nz, 0.0)) * 0.45);
    // the underside sinks into a deep teal: in a packed field this is what reads as the dark gaps between the dots
    c = mix(uDeep, c, smoothstep(-0.80, 0.10, dot(n, vUp)));
    // small near-white specular dot
    c = mix(c, vec3(0.62, 1.0, 1.0), smoothstep(0.968, 0.995, d) * 0.9);
    gl_FragColor = vec4(c, cover);
    // the depth of the sphere, so that balls meet each other, the blades and the bubbles as solid balls do
    float z = vDepth + ${BALL_RADIUS.toFixed(4)} * nz;
    gl_FragDepth = 0.5 - 0.5 * (projectionMatrix[2][2] * z + projectionMatrix[3][2]) / z;
    ${FRAG_TAIL}
  }
`
const BALL_TINT = new THREE.Color().setRGB(0.5, 0.95, 1.08)
const BALL_SHADE_TINT = new THREE.Color().setRGB(0.35, 1.08, 1.22)
let ballMat: THREE.ShaderMaterial | null = null
let ballGeo: THREE.BufferGeometry | null = null
function ballMaterial(): THREE.ShaderMaterial {
  return (ballMat ??= new THREE.ShaderMaterial({
    name: 'ball',
    uniforms: {
      ...FOG_UNIFORMS(),
      // PAL.ball / ballShade with the red taken out: a packed field of the ad averages #1992a3 with #076477 in the
      // gaps (0.4 s, 37.0 s), slightly bluer and more saturated than the palette's single-ball samples
      uMid: { value: new THREE.Color(PAL.ball).multiply(BALL_TINT) },
      uHi: { value: new THREE.Color(PAL.ballHi) },
      uShade: { value: new THREE.Color(PAL.ballShade).multiply(BALL_SHADE_TINT) },
      uDeep: { value: new THREE.Color(PAL.ballShade).multiply(BALL_SHADE_TINT).multiplyScalar(0.42) },
    },
    vertexShader: BALL_VERT,
    fragmentShader: BALL_FRAG,
    fog: true,
    alphaToCoverage: true,
  }))
}

/**
 * One InstancedMesh for all small balls (SPEC 7.4: diameter P.BALL_DIAMETER). A ball is a disc of 2 triangles that
 * faces the eye; the fragment shader shades it as a sphere (unlit matcap, no lights, no shadows), writes the sphere's
 * depth and smooths its edge by alpha to coverage - 3200 balls cost 6400 triangles and one draw call.
 *
 * Every instance matrix starts as IDENTITY and the binder must only ever rewrite its TRANSLATION (the shader reads
 * nothing else): use setBallPositions() once per frame, which is the fastest path (3 float writes per ball straight
 * into instanceMatrix.array, no Matrix4, no setMatrixAt). `mesh.count` is the number of balls drawn.
 * frustumCulled is off because the balls cover the whole river.
 */
export function createBallMesh(count: number): THREE.InstancedMesh {
  ballGeo ??= new THREE.PlaneGeometry(2, 2)
  const m = new THREE.InstancedMesh(ballGeo, ballMaterial(), count)
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  const a = m.instanceMatrix.array as Float32Array
  a.fill(0)
  for (let o = 0; o < a.length; o += 16) {
    a[o] = a[o + 5] = a[o + 10] = a[o + 15] = 1
    a[o + 13] = -100 // parked below the world until the first setBallPositions()
  }
  m.frustumCulled = false
  m.matrixAutoUpdate = false
  m.name = 'balls'
  // stage.ts convention: not outlined (the ad's balls have dark gaps but no ink line, even the strays on the dirt)
  m.userData.outline = false
  return m
}

/**
 * Per-frame ball update (allocation free). Pass the simulation arrays as they are:
 *   setBallPositions(mesh, state.balls.x, state.balls.z, state.balls.y, state.balls.n)
 * @param x    world x of every ball
 * @param z    world z of every ball
 * @param lift height of the ball ABOVE its resting height (sim `Balls.y`: 0 = resting on the ground); null = all resting
 * @param n    number of balls to draw (<= the count given to createBallMesh); sets mesh.count
 */
export function setBallPositions(mesh: THREE.InstancedMesh, x: ArrayLike<number>, z: ArrayLike<number>, lift: ArrayLike<number> | null, n: number): void {
  const a = mesh.instanceMatrix.array as Float32Array
  if (lift) for (let i = 0, o = 12; i < n; i++, o += 16) {
    a[o] = x[i]!
    a[o + 1] = BALL_RADIUS + lift[i]!
    a[o + 2] = z[i]!
  }
  else for (let i = 0, o = 12; i < n; i++, o += 16) {
    a[o] = x[i]!
    a[o + 1] = BALL_RADIUS
    a[o + 2] = z[i]!
  }
  mesh.count = n
  mesh.instanceMatrix.needsUpdate = true
}

/** Number of visual-only balls thrown by poseCaptureBurst(). */
export const CAPTURE_BURST_BALLS = 20
/** Duration of the capture burst in seconds (SPEC 9 row 2). */
export const CAPTURE_BURST_TIME = 0.27

/**
 * Capture burst (SPEC 2.3 / 9 row 2): on `bubbleDock` 15-25 small balls are thrown 0.8-1.3 m up and outward from the
 * rim of the bubble for 0.27 s. If the simulation does not throw real balls, draw the burst with a second, small ball
 * mesh (`createBallMesh(CAPTURE_BURST_BALLS)`) and call this every frame while `t` < CAPTURE_BURST_TIME.
 * Deterministic and allocation free. Sets mesh.count (0 once the burst is over).
 * @param x,z  bubble centre on the ground (event.x / event.z)
 * @param r    bubble radius (event.r)
 * @param t    seconds since the dock event
 */
export function poseCaptureBurst(mesh: THREE.InstancedMesh, x: number, z: number, r: number, t: number, n = CAPTURE_BURST_BALLS): void {
  const a = mesh.instanceMatrix.array as Float32Array
  const k = t / CAPTURE_BURST_TIME
  if (k < 0 || k >= 1) {
    mesh.count = 0
    return
  }
  n = Math.min(n, mesh.instanceMatrix.count)
  for (let i = 0, o = 12; i < n; i++, o += 16) {
    const ang = ((i + hash(i, 1) * 0.8) / n) * Math.PI * 2
    const out = r * (0.9 + 0.15 * hash(i, 2)) + (0.5 + 0.9 * hash(i, 3)) * k
    const apex = 0.8 + 0.5 * hash(i, 4)
    a[o] = x + Math.cos(ang) * out
    a[o + 1] = BALL_RADIUS + apex * 4 * k * (1 - k) * (0.6 + 0.4 * k) + (1 - k) * 0.1
    a[o + 2] = z + Math.sin(ang) * out
  }
  mesh.count = n
  mesh.instanceMatrix.needsUpdate = true
}

// ---------------------------------------------------------------------------------------------------------------------
// Crystal material (shell plates and shards): flat facets toned by the facet's view-space normal, and every plate or
// shard a little lighter or darker by itself
// ---------------------------------------------------------------------------------------------------------------------

const CRYSTAL_VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  #ifdef SHELL
    attribute float aPush;
    attribute float aCore;
    uniform float uRelief;
    varying float vCore;
  #endif
  varying vec3 vN;
  varying vec3 vView;
  varying float vTone;
  void main() {
    vec3 p = position;
    vec3 n = normal;
    vTone = 0.0;
    #ifdef SHELL
      p *= 1.0 + aPush * uRelief;
      vCore = aCore;
      vTone = fract(aPush * 7.31 + 0.5) - 0.5;
    #endif
    #ifdef USE_INSTANCING
      mat3 im = mat3(instanceMatrix);
      n /= vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
      n = im * n;
      p = (instanceMatrix * vec4(p, 1.0)).xyz;
      vTone = fract(float(gl_InstanceID) * 0.6180339887) - 0.5;
    #endif
    vN = normalMatrix * n;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    vView = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`
const CRYSTAL_FRAG = /* glsl */ `
  uniform vec3 uMid;
  uniform vec3 uLit;
  uniform vec3 uDark;
  uniform float opacity;
  #include <common>
  #include <fog_pars_fragment>
  #ifdef SHELL
    varying float vCore;
  #endif
  varying vec3 vN;
  varying vec3 vView;
  varying float vTone;
  void main() {
    vec3 n = normalize(vN);
    // flat tones picked by the facet: lit toward the upper-left, dark on faces turned down or to the right. Every plate
    // or shard also has its own tone (+-25 %), so a shell or a heap is a patchwork of light and dark crystal (ad, 5.8 s)
    float d = dot(n, vec3(-0.52, 0.72, 0.46)) + 0.6 * vTone;
    vec3 c = mix(uDark, uMid, smoothstep(0.0, 0.34, d));
    c = mix(c, mix(uMid, uLit, 0.55), smoothstep(0.50, 0.68, d));
    c = mix(c, uLit, smoothstep(0.80, 0.95, d));
    c *= 1.0 + 0.5 * vTone;
    // faces seen at a grazing angle glow with the glass behind them
    float graze = 1.0 - abs(dot(n, normalize(vView)));
    c = mix(c, uLit, graze * graze * 0.35);
    // the few facets that face the key light flash near-white
    c = mix(c, vec3(0.90, 1.0, 1.0), smoothstep(0.98, 1.06, d) * 0.8);
    #ifdef SHELL
      // plate borders: a thin dark seam (the crack)
      c = mix(c, uDark * 0.6, (1.0 - smoothstep(0.012, 0.04, vCore)) * 0.75);
    #endif
    gl_FragColor = vec4(c, opacity);
    ${FRAG_TAIL}
  }
`
function crystalMaterial(shell: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: shell ? 'bubbleShell' : 'shard',
    defines: shell ? { SHELL: '' } : {},
    uniforms: {
      ...FOG_UNIFORMS(),
      uMid: { value: new THREE.Color(PAL.shard) },
      uLit: { value: new THREE.Color(PAL.shardLit) },
      uDark: { value: new THREE.Color(PAL.shardDark) },
      opacity: { value: 1 },
      uRelief: { value: 0 },
    },
    vertexShader: CRYSTAL_VERT,
    fragmentShader: CRYSTAL_FRAG,
    fog: true,
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Big bubble
// ---------------------------------------------------------------------------------------------------------------------

const BUBBLE_VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  varying vec3 vN;
  varying vec3 vObjN;
  varying vec3 vView;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vN = normalMatrix * normal;
    vObjN = normal;
    vView = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`
const BUBBLE_FRAG = /* glsl */ `
  uniform vec3 uBody;
  uniform vec3 uHi;
  uniform vec3 uShade;
  uniform float opacity;
  uniform float uDim;
  #include <common>
  #include <fog_pars_fragment>
  varying vec3 vN;
  varying vec3 vObjN;
  varying vec3 vView;
  float blob(vec2 m, vec2 c, vec2 r, float a) {
    vec2 q = m - c;
    float s = sin(a), k = cos(a);
    q = vec2(k * q.x + s * q.y, -s * q.x + k * q.y) / r;
    return 1.0 - smoothstep(0.30, 1.0, length(q));
  }
  void main() {
    vec3 n = normalize(vN);
    vec3 v = normalize(vView);
    // matcap coordinates relative to the view ray, so the highlights sit at the same place anywhere on screen
    vec3 bx = normalize(cross(vec3(0.0, 1.0, 0.0), v));
    vec3 by = cross(v, bx);
    vec2 m = vec2(dot(bx, n), dot(by, n));
    float nz = max(dot(n, v), 0.0);
    // body: lit upper-left, darker lower-right
    float g = dot(m, vec2(-0.48, 0.88));
    vec3 c = mix(uShade, uBody * 1.04, smoothstep(-0.90, -0.10, g));
    // luminous zone round the highlights
    c = mix(c, uBody * 1.18 + vec3(0.04, 0.10, 0.10), blob(m, vec2(-0.12, 0.24), vec2(0.85, 0.75), 0.0) * 0.9);
    // faint surface mottling in object space: the only thing that shows the roll
    vec3 q = normalize(vObjN);
    c *= 1.0 + 0.055 * sin(q.x * 5.0 + 1.3 * sin(q.y * 4.0)) * sin(q.z * 4.3 + q.y * 2.1);
    // lighter band low on the right (the ground bouncing back)
    c = mix(c, uBody * 1.15 + vec3(0.02, 0.05, 0.05), blob(m, vec2(0.52, -0.30), vec2(0.40, 0.15), 0.55) * 0.3);
    // darker limb, then a very thin lighter rim on the lit side
    float edge = 1.0 - nz;
    c = mix(c, uShade, smoothstep(0.60, 1.0, edge) * 0.45);
    c = mix(c, mix(uBody, uHi, 0.5), pow(edge, 7.0) * 0.55 * smoothstep(-0.6, 0.6, g));
    // soft white highlights: one large oval, one smaller, and a faint streak hugging the upper-left rim
    float hl = max(blob(m, vec2(-0.27, 0.30), vec2(0.40, 0.34), 0.4), blob(m, vec2(0.16, 0.22), vec2(0.30, 0.27), -0.2));
    hl = max(hl, blob(m, vec2(-0.52, 0.60), vec2(0.25, 0.085), 0.78) * 0.55);
    c = mix(c, uHi, hl);
    c = mix(c, uShade * 0.75, uDim);
    gl_FragColor = vec4(c, opacity);
    ${FRAG_TAIL}
  }
`
const CRACK_VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  attribute float aT;
  varying float vT;
  void main() {
    vT = aT;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`
const CRACK_FRAG = /* glsl */ `
  uniform float uCrack;
  uniform float opacity;
  uniform vec3 uDark;
  #include <common>
  #include <fog_pars_fragment>
  varying float vT;
  void main() {
    if (vT > uCrack) discard;
    gl_FragColor = vec4(uDark, opacity);
    ${FRAG_TAIL}
  }
`

interface ShellGeo {
  plates: THREE.BufferGeometry
  cracks: THREE.BufferGeometry
}
let shellGeo: ShellGeo | null = null
let bubbleGeo: THREE.BufferGeometry | null = null

/**
 * Convex hull of a small point set by brute force (fine for a few dozen points, build time only): index triples
 * wound so that the face normal points outward. For points on a sphere this is their Delaunay triangulation.
 */
function hullFaces(pts: THREE.Vector3[]): number[] {
  const out: number[] = []
  const n = new THREE.Vector3()
  const e = new THREE.Vector3()
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      for (let k = j + 1; k < pts.length; k++) {
        n.subVectors(pts[j]!, pts[i]!).cross(e.subVectors(pts[k]!, pts[i]!))
        if (n.lengthSq() < 1e-12) continue
        let pos = 0
        let neg = 0
        for (let m = 0; m < pts.length && !(pos && neg); m++) {
          if (m === i || m === j || m === k) continue
          const d = n.dot(e.subVectors(pts[m]!, pts[i]!))
          if (d > 1e-9) pos++
          else if (d < -1e-9) neg++
        }
        if (pos && neg) continue
        if (pos) out.push(i, k, j)
        else out.push(i, j, k)
      }
  return out
}

/** Number of plates of the shell, the first BIG_PLATES of them about three times the size of the rest. */
const SHELL_PLATES = 44
const BIG_PLATES = 12
/** Crack lines: uCrack reached per unit of length along a line (the longest is about 2.5), half width, points per unit. */
const CRACK_RATE = 0.36
const CRACK_HALF_WIDTH = 0.011
const CRACK_STEP = 0.1

/**
 * The faceted shell: the Voronoi diagram of SHELL_PLATES points on the unit sphere, a dozen far apart and the rest
 * crowded into the gaps (irregular plates of clearly different sizes, as in the ad at 5.8 s - not a football), plus the
 * crack lines: a few long hairlines that run along plate borders, so the cracks are where the shell later splits.
 */
function buildShell(): ShellGeo {
  // seeds: random directions, each kept clear of the others by its own radius
  const V: THREE.Vector3[] = []
  const clear: number[] = []
  for (let c = 0; V.length < SHELL_PLATES && c < 4000; c++) {
    const u = hash(c, 61) * 2 - 1
    const a = hash(c, 62) * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const p = new THREE.Vector3(Math.cos(a) * s, u, Math.sin(a) * s)
    const r = V.length < BIG_PLATES ? 0.33 : 0.12
    if (!V.every((q, i) => q.distanceTo(p) > r + clear[i]!)) continue
    V.push(p)
    clear.push(r)
  }
  const nv = V.length
  const tris = hullFaces(V)
  const nt = tris.length / 3
  // Voronoi corners = outward normals of the Delaunay triangles
  const C: THREE.Vector3[] = []
  const around: number[][] = V.map(() => [])
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3]!
    const b = tris[t * 3 + 1]!
    const c = tris[t * 3 + 2]!
    e1.subVectors(V[b]!, V[a]!)
    e2.subVectors(V[c]!, V[a]!)
    C.push(new THREE.Vector3().crossVectors(e1, e2).normalize())
    around[a]!.push(t)
    around[b]!.push(t)
    around[c]!.push(t)
  }
  const P3: number[] = []
  const N3: number[] = []
  const push: number[] = []
  const core: number[] = []
  // the borders as a graph: every corner joins three of them
  const next: number[][] = C.map(() => [])
  const tx = new THREE.Vector3()
  const ty = new THREE.Vector3()
  for (let i = 0; i < nv; i++) {
    const v = V[i]!
    tx.set(0.31, 0.77, -0.55).cross(v).normalize()
    ty.crossVectors(v, tx)
    const ring = around[i]!.slice().sort((p, q) => Math.atan2(C[p]!.dot(ty), C[p]!.dot(tx)) - Math.atan2(C[q]!.dot(ty), C[q]!.dot(tx)))
    const centre = new THREE.Vector3()
    for (const t of ring) centre.add(C[t]!)
    centre.normalize()
    // Every plate is one nearly flat facet tilted by a per-plate bias, so that neighbouring plates catch the light
    // differently (mid / lit / dark crystal faces); a little of the fan's own normals keeps a faint ridge on it.
    const bias = new THREE.Vector3((hash(i, 21) - 0.5) * 0.8, (hash(i, 22) - 0.5) * 0.8, (hash(i, 23) - 0.5) * 0.8)
    const flat = centre.clone().add(bias).normalize()
    centre.multiplyScalar(1 + (hash(i, 25) - 0.4) * 0.08)
    const pu = hash(i, 24) * 2 - 1
    for (let k = 0; k < ring.length; k++) {
      const ia = ring[k]!
      const ib = ring[(k + 1) % ring.length]!
      const a = C[ia]!
      const b = C[ib]!
      const n = new THREE.Vector3().subVectors(a, centre).cross(new THREE.Vector3().subVectors(b, centre)).normalize()
      if (n.dot(v) < 0) n.negate()
      n.multiplyScalar(0.3).addScaledVector(flat, 0.7).normalize()
      P3.push(centre.x, centre.y, centre.z, a.x, a.y, a.z, b.x, b.y, b.z)
      N3.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z)
      push.push(pu, pu, pu)
      core.push(1, 0, 0)
      if (!next[ia]!.includes(ib)) {
        next[ia]!.push(ib)
        next[ib]!.push(ia)
      }
    }
  }

  // Crack lines (ad, 5.6-5.8 s: a handful of thin dark hairlines on the still glossy bubble): from the corner that
  // faces the camera one line runs out along each of its three borders, always taking the straighter way on, and
  // each throws a shorter side branch.
  const crackP: number[] = []
  const crackT: number[] = []
  const cracked = new Set<number>()
  const edge = (a: number, b: number) => (a < b ? a * C.length + b : b * C.length + a)
  const pts: THREE.Vector3[] = []
  const side = new THREE.Vector3()
  const line = (from: number, to: number, borders: number, t0: number, branch: boolean) => {
    const path = [from, to]
    cracked.add(edge(from, to))
    while (path.length <= borders) {
      const a = path[path.length - 2]!
      const b = path[path.length - 1]!
      e1.subVectors(C[b]!, C[a]!).normalize()
      let best = -1
      let bestDot = 0.1
      for (const c of next[b]!) {
        if (cracked.has(edge(b, c))) continue
        const d = e2.subVectors(C[c]!, C[b]!).normalize().dot(e1) + 0.3 * (hash(b * 31 + c, 34) - 0.5)
        if (d > bestDot) {
          bestDot = d
          best = c
        }
      }
      if (best < 0) break
      cracked.add(edge(b, best))
      path.push(best)
    }
    // the line as points on the sphere, then a ribbon that thins out toward its tip
    pts.length = 0
    for (let k = 0; k + 1 < path.length; k++) {
      const a = C[path[k]!]!
      const b = C[path[k + 1]!]!
      const seg = Math.max(1, Math.ceil(a.distanceTo(b) / CRACK_STEP))
      for (let q = k === 0 ? 0 : 1; q <= seg; q++) pts.push(a.clone().lerp(b, q / seg).normalize())
    }
    let len = 0
    for (let k = 1; k < pts.length; k++) len += pts[k]!.distanceTo(pts[k - 1]!)
    let run = 0
    let pl: THREE.Vector3 | null = null
    let pr: THREE.Vector3 | null = null
    let pt = t0
    for (let k = 0; k < pts.length; k++) {
      const m = pts[k]!
      if (k > 0) run += m.distanceTo(pts[k - 1]!)
      side.subVectors(pts[Math.min(k + 1, pts.length - 1)]!, pts[Math.max(k - 1, 0)]!).cross(m).normalize()
      const w = CRACK_HALF_WIDTH * (1 - 0.75 * (run / len) ** 2)
      const l = m.clone().addScaledVector(side, w).multiplyScalar(1.006)
      const r = m.clone().addScaledVector(side, -w).multiplyScalar(1.006)
      const t = Math.min(0.999, t0 + run * CRACK_RATE)
      if (pl && pr) {
        crackP.push(pl.x, pl.y, pl.z, pr.x, pr.y, pr.z, l.x, l.y, l.z, pr.x, pr.y, pr.z, r.x, r.y, r.z, l.x, l.y, l.z)
        crackT.push(pt, pt, t, pt, t, t)
      }
      pl = l
      pr = r
      pt = t
    }
    if (!branch || path.length < 4) return
    // the branch leaves by the third border of a corner two or three borders out
    const at = 2 + (hash(from * 31 + to, 35) < 0.5 ? 0 : 1)
    const b = path[Math.min(at, path.length - 2)]!
    let out = 0
    for (let k = 1; k <= Math.min(at, path.length - 2); k++) out += C[path[k]!]!.distanceTo(C[path[k - 1]!]!)
    for (const c of next[b]!) if (!cracked.has(edge(b, c))) line(b, c, 3, t0 + out * CRACK_RATE, false)
  }
  const origin = new THREE.Vector3(-0.35, 0.8, 0.5).normalize()
  let start = 0
  for (let t = 1; t < C.length; t++) if (C[t]!.dot(origin) > C[start]!.dot(origin)) start = t
  for (const c of next[start]!) if (!cracked.has(edge(start, c))) line(start, c, 6, 0, true)

  const plates = new THREE.BufferGeometry()
  plates.setAttribute('position', new THREE.Float32BufferAttribute(P3, 3))
  plates.setAttribute('normal', new THREE.Float32BufferAttribute(N3, 3))
  plates.setAttribute('aPush', new THREE.Float32BufferAttribute(push, 1))
  plates.setAttribute('aCore', new THREE.Float32BufferAttribute(core, 1))
  const cracks = new THREE.BufferGeometry()
  cracks.setAttribute('position', new THREE.Float32BufferAttribute(crackP, 3))
  cracks.setAttribute('aT', new THREE.Float32BufferAttribute(crackT, 1))
  return { plates, cracks }
}

export interface BubbleModel {
  /**
   * Put this at the bubble's ground position (x, 0, z); the sphere is lifted inside so that it rests on y = 0
   * (centre at y = radius). On the grinder add GRINDER_DISC_TOP (grinder.ts) to root.position.y so it sits on the discs.
   */
  root: THREE.Group
  /** Radius in metres (P.BUBBLE_DIAMETER[size] / 2, i.e. sim `Bubble.r`). Cheap; may be called every frame. */
  setRadius(r: number): void
  /**
   * Rolling. Pass the accumulated roll angle in radians (sim `Bubble.roll`) and the current travel direction in world
   * space (any length, e.g. vx, vz). The model applies the increment since the previous call about the horizontal axis
   * perpendicular to the direction, so a change of direction never snaps the surface. Only a faint mottling shows it.
   */
  setRoll(roll: number, dirX: number, dirZ: number): void
  /** Crack lines, 0 = none .. 1 = all drawn (a few dark hairlines growing out from the point that faces the camera; SPEC 2.4 +0.20 s). */
  setCrack(k: number): void
  /**
   * Faceted, lighter "shell" state (SPEC 2.4 +0.35 s). amount 0 = smooth glossy sphere, 1 = fully faceted plates
   * (values between pop the plates in/out progressively). bulge = extra uniform size (0.08 = +8 %). height = vertical
   * squash factor (1 = round, 0.7-0.9 = squashed; the bottom stays on the ground and the body widens slightly).
   */
  setShell(amount: number, bulge?: number, height?: number): void
  /** 0..1. Fade-in at the source (sim `Bubble.age`) and the 3-frame semi-transparent smear while docking. Also fades the shadow. */
  setOpacity(a: number): void
  /**
   * Convenience: the whole SPEC 2.4 timeline from `t` = seconds since the bubble came to rest on the tray
   * (sim `Grinder.t`): cracks spread from P.GRIND_CRACK, shell + 8 % bulge at P.GRIND_SHELL, then the squash.
   * At P.GRIND_SHARDS hide `root` and switch to the shard mesh (poseShards()).
   */
  setGrindTime(t: number): void
  /** Back to a fresh smooth, opaque, uncracked bubble (for pooling). */
  reset(): void
}

/** Height factor of the shell at the moment it shatters (t = P.GRIND_SHARDS on the setGrindTime() timeline). */
const SHATTER_HEIGHT = 0.9

/**
 * A big glossy bubble (SPEC 7.4): body PAL.bubble, darker lower-right, two soft white highlight blobs, thin lighter
 * rim, soft blob shadow. One draw call (plus one for the shadow) while smooth; opaque unless setOpacity(< 1).
 * Each bubble has its own small materials (uniforms differ) but they share geometry and compiled programs.
 */
export function makeBubble(radius = P.BUBBLE_DIAMETER.M / 2): BubbleModel {
  bubbleGeo ??= new THREE.SphereGeometry(1, 40, 24)
  shellGeo ??= buildShell()
  const root = new THREE.Group()
  root.name = 'bubble'
  const lift = new THREE.Group()
  const spin = new THREE.Group()
  root.add(lift)
  lift.add(spin)

  const bodyMat = new THREE.ShaderMaterial({
    name: 'bubble',
    uniforms: {
      ...FOG_UNIFORMS(),
      uBody: { value: new THREE.Color(PAL.bubble) },
      uHi: { value: new THREE.Color(PAL.bubbleHi) },
      uShade: { value: new THREE.Color(PAL.bubbleShade) },
      opacity: { value: 1 },
      uDim: { value: 0 },
    },
    vertexShader: BUBBLE_VERT,
    fragmentShader: BUBBLE_FRAG,
    fog: true,
  })
  const body = mesh(bubbleGeo, bodyMat, spin)

  const crackMat = new THREE.ShaderMaterial({
    name: 'bubbleCrack',
    uniforms: { ...FOG_UNIFORMS(), uCrack: { value: 0 }, opacity: { value: 1 }, uDark: { value: new THREE.Color(PAL.bubbleShade).multiplyScalar(0.8) } },
    vertexShader: CRACK_VERT,
    fragmentShader: CRACK_FRAG,
    fog: true,
    side: THREE.DoubleSide,
  })
  const cracks = mesh(shellGeo.cracks, crackMat, lift)
  cracks.visible = false

  const shellMat = crystalMaterial(true)
  const shell = mesh(shellGeo.plates, shellMat, lift)
  shell.visible = false

  const shadow = blobShadow(1, 1, 0.5)
  const shadowMat = shadow.material as THREE.MeshBasicMaterial
  root.add(shadow)

  let r = radius
  let bulge = 0
  let height = 1
  let lastRoll = 0
  let opacity = 1
  const axis = new THREE.Vector3()
  const dq = new THREE.Quaternion()

  const layout = () => {
    const s = r * (1 + bulge)
    const wide = 1 + (1 - height) * 0.35
    lift.scale.set(s * wide, s * height, s * wide)
    lift.position.y = s * height
    const sh = r * 2.5 * wide
    shadow.scale.set(sh, sh, 1)
    shadow.position.set(r * 0.12, 0.015, r * 0.1)
  }
  const model: BubbleModel = {
    root,
    setRadius(v) {
      if (v === r) return
      r = v
      layout()
    },
    setRoll(roll, dirX, dirZ) {
      const d = roll - lastRoll
      lastRoll = roll
      const l = Math.hypot(dirX, dirZ)
      if (d === 0 || l < 1e-6) return
      // rolling toward (dx, dz) turns about up x d = (dz, 0, -dx)
      axis.set(dirZ / l, 0, -dirX / l)
      dq.setFromAxisAngle(axis, d)
      spin.quaternion.premultiply(dq)
    },
    setCrack(k) {
      crackMat.uniforms.uCrack!.value = k
      cracks.visible = k > 0 && !shell.visible
    },
    setShell(amount, b = 0, h = 1) {
      const on = amount > 0
      if (on !== shell.visible) {
        shell.visible = on
        body.scale.setScalar(on ? 0.9 : 1)
        bodyMat.uniforms.uDim!.value = on ? 1 : 0
        shell.scale.setScalar(1.03)
        if (on) cracks.visible = false
        else cracks.visible = (crackMat.uniforms.uCrack!.value as number) > 0
      }
      shellMat.uniforms.uRelief!.value = 0.035 * clamp01(amount)
      if (b !== bulge || h !== height) {
        bulge = b
        height = h
        layout()
      }
    },
    setOpacity(a) {
      a = clamp01(a)
      if (a === opacity) return
      opacity = a
      const tr = a < 0.999
      for (const m of [bodyMat, crackMat, shellMat]) {
        m.uniforms.opacity!.value = a
        m.transparent = tr
        m.depthWrite = !tr
      }
      shadowMat.opacity = 0.5 * a
      // (root.visible is left to the caller)
      lift.visible = shadow.visible = a > 0.003
    },
    setGrindTime(t) {
      model.setCrack(clamp01((t - P.GRIND_CRACK) / (P.GRIND_SHELL - P.GRIND_CRACK)))
      const u = t - P.GRIND_SHELL
      if (u < 0) model.setShell(0)
      else {
        const b = 0.08 * (u < 0.04 ? u / 0.04 : Math.max(0, 1 - (u - 0.04) / 0.1))
        const span = P.GRIND_SHARDS - P.GRIND_SHELL - 0.04
        const h = 1 - (1 - SHATTER_HEIGHT) * clamp01((u - 0.04) / span)
        model.setShell(clamp01(u / 0.05), b, h)
      }
    },
    reset() {
      model.setCrack(0)
      model.setShell(0)
      model.setOpacity(1)
      spin.quaternion.identity()
      lastRoll = 0
    },
  }
  layout()
  return model
}

// ---------------------------------------------------------------------------------------------------------------------
// Shards
// ---------------------------------------------------------------------------------------------------------------------

let shardGeo: THREE.BufferGeometry | null = null
/**
 * One chunky angular crystal (largest extent about 1, a good half as thick): the convex hull of a few hand-placed
 * points, flat shaded. Non-uniform instance scales and rotations give the variety. 20 triangles.
 */
function buildShard(): THREE.BufferGeometry {
  const v = [
    [-0.4, 0.27, -0.12], [0.04, 0.34, -0.36], [0.42, 0.2, -0.06], [0.14, 0.3, 0.33], [-0.28, 0.21, 0.3], // top
    [-0.34, -0.25, -0.24], [0.28, -0.31, -0.27], [0.37, -0.2, 0.2], [-0.1, -0.3, 0.37], // bottom
    [-0.52, 0.0, 0.06], [0.5, -0.03, 0.1], [0.02, 0.02, -0.46], // waist tips
  ].map(q => new THREE.Vector3(q[0], q[1], q[2]))
  const f = hullFaces(v)
  const p: number[] = []
  const n: number[] = []
  const nn = new THREE.Vector3()
  const e = new THREE.Vector3()
  for (let i = 0; i < f.length; i += 3) {
    const a = v[f[i]!]!
    const b = v[f[i + 1]!]!
    const c = v[f[i + 2]!]!
    nn.subVectors(b, a).cross(e.subVectors(c, a)).normalize()
    for (const q of [a, b, c]) {
      p.push(q.x, q.y, q.z)
      n.push(nn.x, nn.y, nn.z)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3))
  return g
}

/**
 * One InstancedMesh of angular crystal shards (SPEC 7.4 / 9 row 4): flat facets in PAL.shard / shardLit / shardDark.
 * Instance matrices may carry any rotation and non-uniform scale (the unit shard is about 1 x 0.6 x 0.8 m).
 * Either drive it with poseShards() (complete shatter animation) or write your own matrices with setMatrixAt().
 * `mesh.count` starts at 0. Give it at least SHARDS_MAX instances for one bubble.
 */
export function createShardMesh(count: number): THREE.InstancedMesh {
  shardGeo ??= buildShard()
  const m = new THREE.InstancedMesh(shardGeo, crystalMaterial(false), count)
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  m.frustumCulled = false
  m.count = 0
  m.name = 'shards'
  // stage.ts convention: not outlined (bright crystal debris, light edges only)
  m.userData.outline = false
  return m
}

/** Largest number of shards poseShards() uses for one bubble (an L bubble). */
export const SHARDS_MAX = 35
/** Seconds the shatter lasts: every shard has shrunk to nothing by then (P.GRIND_FREE - P.GRIND_SHARDS). */
export const SHATTER_TIME = P.GRIND_FREE - P.GRIND_SHARDS
/** Number of shards for a bubble of radius r: 25 (S) .. 35 (L), SPEC 2.4. */
export const shardCount = (r: number) => Math.round(THREE.MathUtils.clamp(25 + (r - 1.0) * 12.5, 25, SHARDS_MAX))

const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _d = new THREE.Vector3()
const _ax = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const UP = new THREE.Vector3(0, 1, 0)

/**
 * Complete shatter animation (SPEC 2.4, +0.50 .. +1.30 s): the shell breaks into shardCount(r) plates that pop
 * outward, jitter, slump down into the rollers and shrink to nothing. Deterministic and allocation free; call it
 * every frame while the grinder is grinding:
 *   poseShards(mesh, grinder.bx, grinder.bz, grinder.br, grinder.t - P.GRIND_SHARDS)
 * @param x,z   centre of the bubble on the tray (world, or local to the mesh's parent)
 * @param r     bubble radius
 * @param t     seconds since the shatter started; < 0 or >= SHATTER_TIME draws nothing (mesh.count = 0)
 * @param baseY height the bubble was resting on (default: top of the grinder discs)
 * @param first index of the first instance to write (default 0); the function sets mesh.count = first + n
 */
export function poseShards(mesh: THREE.InstancedMesh, x: number, z: number, r: number, t: number, baseY = GRINDER_DISC_TOP, first = 0): void {
  if (t < 0 || t >= SHATTER_TIME) {
    mesh.count = first
    return
  }
  const n = Math.min(shardCount(r), mesh.instanceMatrix.count - first)
  const a = mesh.instanceMatrix.array as Float32Array
  const k = r / 1.3
  const cy = baseY + r * SHATTER_HEIGHT
  const pop = 1 - Math.pow(1 - Math.min(1, t / 0.1), 2)
  for (let i = 0; i < n; i++) {
    // start: a point of the squashed shell (Fibonacci sphere), slab lying tangent to it
    const u = 1 - (2 * (i + 0.5)) / n
    const ang = i * 2.399963 + hash(i, 1) * 0.5
    const rad = Math.sqrt(1 - u * u)
    _d.set(Math.cos(ang) * rad, u, Math.sin(ang) * rad)
    const size = (0.45 + 0.95 * Math.pow(hash(i, 2), 1.4)) * k
    _s.set(size, size * (0.45 + 0.5 * hash(i, 3)), size * (0.75 + 0.5 * hash(i, 4)))
    // life: each shard starts to shrink at its own time
    const t0 = 0.12 + 0.3 * hash(i, 5)
    const t1 = Math.min(SHATTER_TIME, t0 + 0.28 + 0.2 * hash(i, 6))
    const life = clamp01((t - t0) / (t1 - t0))
    const sc = 1 - life * life
    _s.multiplyScalar(sc)
    // position: pop outward, then fall and slide toward the gap between the two roller rows
    // every third chunk comes from the inside of the ball, so the cluster stays solid while it collapses
    const out = r * ((i % 3 === 2 ? 0.38 : 0.76) + 0.08 * pop * (0.5 + hash(i, 7)))
    const tf = Math.max(0, t - 0.06)
    const fall = 9 * tf * tf * (0.6 + 0.8 * hash(i, 8))
    const floor = baseY + size * 0.12
    let y = cy + _d.y * out * SHATTER_HEIGHT - fall
    const rest = y < floor
    if (rest) y = floor
    const pull = 1 - 0.45 * clamp01(t / SHATTER_TIME)
    const jx = rest || t < 0.15 ? Math.sin(t * 95 + i * 1.7) * 0.03 * k : 0
    const jz = rest || t < 0.15 ? Math.cos(t * 83 + i * 2.3) * 0.03 * k : 0
    _p.set(x + _d.x * out * pull + jx, y, z + _d.z * out * pull + jz)
    // orientation: tangent to the shell, then tumbling
    _q.setFromUnitVectors(UP, _d)
    _q2.setFromAxisAngle(UP, hash(i, 9) * 6.283)
    _q.multiply(_q2)
    _ax.set(hash(i, 10) - 0.5, hash(i, 11) - 0.5, hash(i, 12) - 0.5).normalize()
    _q2.setFromAxisAngle(_ax, (rest ? 0.6 : 1) * t * (2 + 7 * hash(i, 13)))
    _q.premultiply(_q2)
    _m.compose(_p, _q, _s)
    _m.toArray(a, (first + i) * 16)
  }
  mesh.count = first + n
  mesh.instanceMatrix.needsUpdate = true
}

// ---------------------------------------------------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------------------------------------------------

function bubbleItem(name: string, r: number, setup: (b: BubbleModel) => void, animate?: (b: BubbleModel, t: number) => void): GalleryItem {
  return {
    name,
    size: r + 0.3,
    make: () => {
      const b = makeBubble(r)
      setup(b)
      b.root.userData.model = b
      return b.root
    },
    animate: animate ? (o, t) => animate(o.userData.model as BubbleModel, t) : undefined,
  }
}

/** A static patch of packed balls with a hand scoop pushed into it and bubbles among them (f_0012 / f_0024). */
function makeField(): THREE.Object3D {
  const g = new THREE.Group()
  const W = 10
  const D = 9
  const bed = mesh(new THREE.PlaneGeometry(W + 0.6, D + 0.6), lam(PAL.riverBed), g, 0, 0.004, 0)
  bed.rotation.x = -Math.PI / 2
  const scoop = makeScoop()
  // pushed straight "up the screen" into the river, like the doctor at 0.4 s
  const heading = Math.atan2(0.64, -0.77)
  const sx = 0.2
  const sz = 3.3
  scoop.root.position.set(sx, 0, sz)
  scoop.root.rotation.y = heading
  g.add(scoop.root)
  // circles the balls must stay out of: [x, z, bubble radius]
  const bubbles: [number, number, number][] = [
    [-2.3, -0.9, 1.8],
    [2.9, -2.3, 1.3],
  ]
  for (const [x, z, r] of bubbles) {
    const b = makeBubble(r)
    b.root.position.set(x, 0, z)
    g.add(b.root)
  }
  // blade polyline in field coordinates
  const poly = BLADES.scoop.poly
  const bl: number[] = []
  for (let i = 0; i < poly.length; i += 2) bl.push(sx + poly[i]! * Math.cos(heading) + poly[i + 1]! * Math.sin(heading), sz - poly[i]! * Math.sin(heading) + poly[i + 1]! * Math.cos(heading))

  const xs: number[] = []
  const zs: number[] = []
  const pitch = P.BALL_DIAMETER * 1.17
  const row = pitch * 0.866
  let j = 0
  let cand = 0
  for (let z = -D / 2; z < D / 2; z += row, j++) {
    for (let x = -W / 2 + (j % 2) * pitch * 0.5; x < W / 2; x += pitch) {
      const i = cand++
      const px = x + (hash(i, 1) - 0.5) * 0.3
      const pz = z + (hash(i, 2) - 0.5) * 0.3
      // flow-aligned dark gaps and streaks (the flow runs along +z here)
      const streak = Math.sin(px * 1.9 + 0.5 * Math.sin(pz * 0.7) + pz * 0.12) + 0.7 * Math.sin(px * 0.6 - pz * 0.35 + 2.0)
      if (streak > 1.25 || hash(i, 3) < 0.05) continue
      // the river thins out toward the near (south-west) bank
      const bank = px * -0.75 + pz * 0.66
      if (bank > 3.6 && hash(i, 4) < (bank - 3.6) / 2.2) continue
      // bare lane ploughed behind the blade (scoop local frame)
      const lx = (px - sx) * Math.cos(heading) - (pz - sz) * Math.sin(heading)
      const lz = (px - sx) * Math.sin(heading) + (pz - sz) * Math.cos(heading)
      if (Math.abs(lx) < 1.5 && lz < 1.2 + 0.35 * lx * lx && lz > -6) continue
      xs.push(px)
      zs.push(pz)
    }
  }
  // wedge of balls bulldozed onto the concave face and round the tips
  for (let k = 0; k < 70; k++) {
    const u = hash(k, 7) * 2 - 1
    const lz = P.SCOOP_OFFSET + 0.33 * u * u * 1.3 + 0.2 + hash(k, 8) * 0.7
    const lx = u * 1.5
    xs.push(sx + lx * Math.cos(heading) + lz * Math.sin(heading))
    zs.push(sz - lx * Math.sin(heading) + lz * Math.cos(heading))
  }
  // relax: push overlapping balls apart, out of the bubbles and off the blade (what the simulation does every step)
  const n = xs.length
  const dmin = P.BALL_DIAMETER * 1.02
  for (let it = 0; it < 8; it++) {
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const dx = xs[b]! - xs[a]!
        if (dx > dmin || dx < -dmin) continue
        const dz = zs[b]! - zs[a]!
        const d2 = dx * dx + dz * dz
        if (d2 >= dmin * dmin || d2 < 1e-9) continue
        const d = Math.sqrt(d2)
        const p = (dmin - d) / d / 2
        xs[a] = xs[a]! - dx * p
        zs[a] = zs[a]! - dz * p
        xs[b] = xs[b]! + dx * p
        zs[b] = zs[b]! + dz * p
      }
      for (const [bx, bz, r] of bubbles) {
        // a ball on the ground touches a sphere resting on the ground at this horizontal distance
        const touch = Math.sqrt(4 * r * BALL_RADIUS) + 0.02
        const dx = xs[a]! - bx
        const dz = zs[a]! - bz
        const d = Math.hypot(dx, dz)
        if (d < touch && d > 1e-6) {
          xs[a] = bx + (dx / d) * touch
          zs[a] = bz + (dz / d) * touch
        }
      }
      for (let s = 0; s + 3 < bl.length; s += 2) {
        const ax = bl[s]!
        const az = bl[s + 1]!
        const ex = bl[s + 2]! - ax
        const ez = bl[s + 3]! - az
        const t = clamp01(((xs[a]! - ax) * ex + (zs[a]! - az) * ez) / (ex * ex + ez * ez))
        const dx = xs[a]! - (ax + ex * t)
        const dz = zs[a]! - (az + ez * t)
        const d = Math.hypot(dx, dz)
        const touch = BALL_RADIUS + P.BLADE_THICKNESS / 2
        if (d < touch && d > 1e-6) {
          xs[a] = xs[a]! + (dx / d) * (touch - d)
          zs[a] = zs[a]! + (dz / d) * (touch - d)
        }
      }
    }
  }
  const balls = createBallMesh(n)
  setBallPositions(balls, xs, zs, null, n)
  g.add(balls)
  return g
}

export const GALLERY: GalleryItem[] = [
  { name: 'balls-field', size: 4.3, make: makeField },
  {
    name: 'balls-close',
    size: 0.8,
    make: () => {
      const g = new THREE.Group()
      const bed = mesh(new THREE.PlaneGeometry(2.4, 2.4), lam(PAL.riverBed), g, 0, 0.004, 0)
      bed.rotation.x = -Math.PI / 2
      const xs: number[] = []
      const zs: number[] = []
      for (let i = 0; i < 49; i++) {
        if (hash(i, 5) < 0.18) continue
        xs.push(((i % 7) - 3 + ((Math.floor(i / 7) % 2) * 0.5 - 0.25)) * 0.275 + (hash(i, 1) - 0.5) * 0.04)
        zs.push((Math.floor(i / 7) - 3) * 0.24 + (hash(i, 2) - 0.5) * 0.04)
      }
      const m = createBallMesh(xs.length)
      setBallPositions(m, xs, zs, null, xs.length)
      g.add(m)
      return g
    },
  },
  {
    // the whole river's worth of balls (P.BALL_COUNT), rewritten every frame the way the binder does it
    name: 'balls-3200',
    size: 7.0,
    make: () => {
      const n = P.BALL_COUNT
      const g = new THREE.Group()
      const bed = mesh(new THREE.PlaneGeometry(15, 15), lam(PAL.riverBed), g, 0, 0.004, 0)
      bed.rotation.x = -Math.PI / 2
      const m = createBallMesh(n)
      g.add(m)
      g.userData = { m, x: new Float32Array(n), z: new Float32Array(n), y: new Float32Array(n) }
      return g
    },
    animate: (o, t) => {
      const { m, x, z, y } = o.userData as { m: THREE.InstancedMesh; x: Float32Array; z: Float32Array; y: Float32Array }
      const n = x.length
      const cols = 57
      const pitch = P.BALL_DIAMETER * 1.04
      for (let i = 0; i < n; i++) {
        const c = i % cols
        const r = Math.floor(i / cols)
        // rows sliding past each other like the flow, with a little hop now and then
        const flow = ((t * (0.5 + 0.9 * hash(r, 1)) + hash(r, 2) * 20) % 1) * pitch
        x[i] = (c - cols / 2 + (r % 2) * 0.5) * pitch + (hash(i, 3) - 0.5) * 0.03
        z[i] = (r - n / cols / 2) * pitch * 0.9 + flow
        y[i] = Math.max(0, Math.sin(t * 6 + i * 0.37) - 0.985) * 12
      }
      setBallPositions(m, x, z, y, n)
    },
  },
  bubbleItem('bubble-S', 1.0, () => {}),
  bubbleItem('bubble-M-roll', 1.3, () => {}, (b, t) => b.setRoll(t * 3.4, 0.3, 1)),
  bubbleItem('bubble-L', 1.8, () => {}),
  bubbleItem('bubble-fade-in', 1.3, b => b.setOpacity(0.45), (b, t) => b.setOpacity((t * 0.8) % 1.3)),
  bubbleItem('bubble-crack', 1.3, b => b.setCrack(0.6), (b, t) => b.setCrack(((t * 0.7) % 1.4) / 1.0)),
  bubbleItem('bubble-shell', 1.3, b => {
    b.setCrack(1)
    b.setShell(1, 0.08, 1)
  }),
  bubbleItem('bubble-shell-squash', 1.3, b => {
    b.setCrack(1)
    b.setShell(1, 0, 0.78)
  }),
  {
    name: 'shards',
    size: 1.8,
    make: () => {
      const m = createShardMesh(SHARDS_MAX)
      poseShards(m, 0, 0, 1.3, 0.16, 0)
      return m
    },
  },
  {
    name: 'grind-timeline',
    size: 3.0,
    make: () => {
      const g = new THREE.Group()
      const gr = makeGrinder()
      g.add(gr.root)
      const b = makeBubble(1.3)
      b.root.position.y = GRINDER_DISC_TOP
      g.add(b.root)
      const sh = createShardMesh(SHARDS_MAX)
      g.add(sh)
      g.userData = { gr, b, sh }
      return g
    },
    animate: (o, time) => {
      const { gr, b, sh } = o.userData as { gr: ReturnType<typeof makeGrinder>; b: BubbleModel; sh: THREE.InstancedMesh }
      const t = (time % 2.4) - 0.4
      b.root.visible = t < P.GRIND_SHARDS
      b.setGrindTime(Math.max(0, t))
      poseShards(sh, 0, 0, 1.3, t - P.GRIND_SHARDS)
      gr.setSpin(time * (t > P.GRIND_SHARDS && t < P.GRIND_FREE ? 25 : 3.14))
    },
  },
  {
    name: 'capture-burst',
    size: 1.8,
    make: () => {
      const g = new THREE.Group()
      const b = makeBubble(1.3)
      g.add(b.root)
      const m = createBallMesh(CAPTURE_BURST_BALLS)
      g.add(m)
      g.userData = { m }
      return g
    },
    animate: (o, t) => poseCaptureBurst((o.userData as { m: THREE.InstancedMesh }).m, 0, 0, 1.3, (t % 0.9) - 0.1),
  },
]
