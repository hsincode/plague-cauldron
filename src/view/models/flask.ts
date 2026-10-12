// Blue potion flasks (SPEC 2.5 / 7.4): a round-bellied flask - spherical bulb, short concave shoulder, straight neck,
// brown cork; total length P.FLASK_TOTAL. One InstancedMesh draws every flask of one owner: the pile on the ground,
// flasks in flight, the stack on a back. createFlaskShadowMesh() draws the contact shadows of a pile in one more draw
// call.
//
// The glass is an unlit "emissive" matcap shader (saturated blue PAL.flask with darker swirls PAL.flaskSwirl, lighter
// licks and a bright cyan rim), opaque on purpose: in a stack the neck and cork of a flask are hidden inside the bulb
// above it. Not outlined and not lit by the lantern (SPEC 7.3: flasks are emissive).
//
// INSTANCE FRAME (differs from the usual "origin on the ground"): the origin of a flask instance is the CENTRE OF THE
// BULB and +y points along the neck toward the cork. Bulb bottom = -FLASK_RADIUS, cork top = +FLASK_TOP.
// This makes all three uses simple: upright (stack), lying (pile) and tumbling (flight) are just "centre + axis".
//
// HOW TO POSE THE STACK ON A CARRIER (SPEC 2.5): the stack anchor is 0.45 m behind the carrier's centre and 0.3 m above
// the ground. Flask j (0 = bottom) has its bulb centre at anchorY + FLASK_RADIUS + j * P.FLASK_STACK_PITCH. The pitch
// (0.76) is little more than a bulb (0.65), so each neck is tucked into the bulb above, the bulbs touch like fat beads
// from the game camera and only the top flask shows its neck and cork; the stack is (n - 1) * 0.76 + P.FLASK_TOTAL
// tall. At rest call setFlaskStack(). For the lagging chain (bends back 35-40 deg while running, stretches up to 30 %)
// simulate the bulb centres as chain nodes, write them into a Float32Array [x0, y0, z0, x1, ...] and call
// setFlaskChain(): the flasks stay nearly upright (FLASK_CHAIN_TILT) while their bulbs follow the nodes, so a running
// stack is a staircase of whole flasks, necks showing beside the bulb above. Finish every frame with commitFlasks().
import * as THREE from 'three'
import { P, PAL } from '../../config'
import { blobShadow, type GalleryItem } from '../materials'

/**
 * Bulb radius; a flask standing upright on y0 has its instance origin at y0 + FLASK_RADIUS. The ad's bulbs are 1.1 times
 * the on-screen spacing of a stack at rest (9.4 s: 40 px wide, 36 px apart), which is P.FLASK_BULB at the game camera.
 */
export const FLASK_RADIUS = P.FLASK_BULB / 2
/** Distance from the bulb centre (instance origin) to the top of the cork. */
export const FLASK_TOP = P.FLASK_TOTAL - FLASK_RADIUS
/**
 * How far a flask of a bent stack leans toward the flask above it (0 = bolt upright, 1 = along the chain): in the ad
 * the flasks of a running stack stay upright and only the lower ones tip about 10 deg (8.4-8.8 s).
 */
export const FLASK_CHAIN_TILT = 0.25
/**
 * Share of the full lean taken by the link `fromTop` links below the top one. The top of a stack trails furthest and
 * the lean dies out below it: a 5-stack is one sheared line (8.6 s) while a 9-stack stands upright on the back and
 * curves away above (43.4-43.8 s: the links are offset 24, 17, 19, 11, 6, 2, 1 px from the top down).
 */
export const flaskChainLean = (fromTop: number) => Math.exp(-((fromTop / 3.2) ** 2))
const CORK_RADIUS = 0.105
/** Downward tilt of the neck of a flask lying on flat ground (it rests on the bulb and the edge of the cork). */
const LIE_TILT = Math.asin((FLASK_RADIUS - CORK_RADIUS) / (FLASK_TOP - 0.02))

const VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  attribute float aPart;
  #ifdef USE_INSTANCING
    attribute float aPale;
  #endif
  varying vec3 vN;
  varying vec3 vP;
  varying vec3 vView;
  varying float vPart;
  varying float vPale;
  varying float vSeed;
  void main() {
    vec3 p = position;
    vec3 n = normal;
    vP = position;
    vPart = aPart;
    #ifdef USE_INSTANCING
      mat3 im = mat3(instanceMatrix);
      n /= vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
      n = im * n;
      p = (instanceMatrix * vec4(p, 1.0)).xyz;
      vPale = aPale;
      vSeed = fract(float(gl_InstanceID) * 0.6180339887);
    #else
      vPale = 0.0;
      vSeed = 0.3;
    #endif
    vN = normalMatrix * n;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    vView = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`
const FRAG = /* glsl */ `
  uniform vec3 uMid;
  uniform vec3 uLight;
  uniform vec3 uSwirl;
  uniform vec3 uCork;
  uniform float opacity;
  #include <common>
  #include <fog_pars_fragment>
  varying vec3 vN;
  varying vec3 vP;
  varying vec3 vView;
  varying float vPart;
  varying float vPale;
  varying float vSeed;
  void main() {
    vec3 n = normalize(vN);
    vec3 v = normalize(vView);
    float nz = max(dot(n, v), 0.0);
    float d = dot(n, vec3(-0.45, 0.70, 0.55));
    vec3 c;
    if (vPart > 0.5) {
      // cork: matte brown, darker band round the middle
      c = uCork * (vPart > 1.5 ? 0.5 : 1.0) * (0.72 + 0.5 * smoothstep(-0.3, 0.8, d));
    } else {
      // The liquid (object space, so it turns with the flask): a broad swirl of darker blue plus smaller flame-like
      // licks that run up into the neck, as in the ad (saturated blue, busy, not milky). All angular terms use whole
      // multiples of the angle, so there is no seam.
      float a = atan(vP.z, vP.x);
      float y = vP.y * 9.0;
      float ph = 6.2832 * vSeed;
      float w1 = sin(2.0 * a + y * 1.1 + ph + 1.9 * sin(2.0 * a - y * 1.4 + 2.0 + 4.0 * vSeed));
      float w2 = sin(5.0 * a - y * 2.4 + 2.2 * sin(3.0 * a + y * 1.9 + ph) + 1.3 * ph);
      float w3 = sin(9.0 * a + y * 4.3 + 2.0 * w1 + ph);
      // the angular pattern would pinch into a star on the axis (bottom of a lying flask): fade it out there
      float w = (0.55 * w1 + 0.33 * w2 + 0.12 * w3) * smoothstep(0.02, 0.13, length(vP.xz));
      c = mix(uMid, uSwirl, smoothstep(0.05, 0.50, w));
      c = mix(c, uSwirl * vec3(0.72, 0.84, 1.0), smoothstep(0.55, 0.85, w) * 0.6);
      c = mix(c, uLight, smoothstep(0.22, 0.66, -w) * 0.8);
      c = mix(c, vec3(0.80, 0.97, 1.0), smoothstep(0.70, 0.94, -w) * 0.4);
      // paler flasks keep their bright rim (SPEC 7.4: some flasks of a stack look frosted)
      c = mix(c, vec3(0.90, 0.92, 0.98), vPale * (0.6 + 0.25 * smoothstep(-0.4, 0.5, -w)));
      // bright cyan rim: the glowing outline that makes every flask read on its own, even in a pile
      float fres = 1.0 - nz;
      c = mix(c, uLight, smoothstep(0.38, 0.66, fres) * 0.75);
      c = mix(c, vec3(0.62, 1.0, 1.0), smoothstep(0.60, 0.80, fres));
      c = mix(c, vec3(0.90, 1.0, 1.0), smoothstep(0.80, 0.97, fres) * 0.8);
      // small glint at the upper-left
      c = mix(c, vec3(0.93, 1.0, 1.0), smoothstep(0.95, 0.99, d) * 0.6);
    }
    gl_FragColor = vec4(c, opacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`

let baseGeo: THREE.BufferGeometry | null = null
let material: THREE.ShaderMaterial | null = null

/**
 * Round-bellied flask of the ad (8.6 s, 7.4 s): a sphere that keeps its roundness up to 48 deg above the equator, a
 * short concave shoulder and a straight, fairly stout neck with a lip and a fat cork. About 550 triangles.
 */
function buildFlask(): THREE.BufferGeometry {
  const R = FLASK_RADIUS
  const pts: THREE.Vector2[] = []
  const part: number[] = []
  const add = (r: number, y: number, p = 0) => {
    pts.push(new THREE.Vector2(r, y))
    part.push(p)
  }
  const N = 8
  for (let i = 0; i <= N; i++) {
    const a = -Math.PI / 2 + (i / N) * ((90 + 48) * Math.PI) / 180
    add(Math.max(0.0001, Math.cos(a) * R), Math.sin(a) * R)
  }
  // shoulder
  add(0.172, 0.288)
  add(0.138, 0.335)
  add(0.115, 0.39)
  add(0.1, 0.46)
  // neck
  const T = FLASK_TOP
  add(0.09, 0.56)
  add(0.084, T - 0.19)
  // lip
  add(CORK_RADIUS + 0.004, T - 0.18)
  add(CORK_RADIUS + 0.004, T - 0.155)
  // cork
  add(CORK_RADIUS - 0.008, T - 0.153, 1)
  add(CORK_RADIUS - 0.004, T - 0.105, 1)
  add(CORK_RADIUS - 0.002, T - 0.103, 2)
  add(CORK_RADIUS - 0.001, T - 0.063, 2)
  add(CORK_RADIUS, T - 0.061, 1)
  add(CORK_RADIUS, T, 1)
  add(0.0001, T, 1)
  const SEG = 12
  const g = new THREE.LatheGeometry(pts, SEG)
  const a = new Float32Array((SEG + 1) * pts.length)
  for (let i = 0; i <= SEG; i++) for (let j = 0; j < pts.length; j++) a[i * pts.length + j] = part[j]!
  g.setAttribute('aPart', new THREE.BufferAttribute(a, 1))
  g.deleteAttribute('uv')
  return g
}

function flaskMaterial(): THREE.ShaderMaterial {
  return (material ??= new THREE.ShaderMaterial({
    name: 'flask',
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uMid: { value: new THREE.Color(PAL.flask) },
      uLight: { value: new THREE.Color(PAL.flaskLight) },
      uSwirl: { value: new THREE.Color(PAL.flaskSwirl) },
      uCork: { value: new THREE.Color(PAL.cork) },
      opacity: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: true,
  }))
}

/**
 * InstancedMesh for up to `count` flasks (see the file header for the instance frame). `mesh.count` starts at 0.
 * Write instances with the setFlask*() helpers below (allocation free, direct writes into instanceMatrix.array), then
 * call commitFlasks(mesh, n) once per frame. Per-instance paleness (SPEC 7.4: 2-3 flasks of a tall stack render
 * paler) is the instanced attribute `aPale`, set with setFlaskPale().
 */
export function createFlaskMesh(count: number): THREE.InstancedMesh {
  baseGeo ??= buildFlask()
  // own geometry (shares the vertex buffers) because the aPale attribute is per mesh
  const g = new THREE.BufferGeometry()
  g.setIndex(baseGeo.getIndex())
  g.setAttribute('position', baseGeo.getAttribute('position'))
  g.setAttribute('normal', baseGeo.getAttribute('normal'))
  g.setAttribute('aPart', baseGeo.getAttribute('aPart'))
  const pale = new THREE.InstancedBufferAttribute(new Float32Array(count), 1)
  pale.setUsage(THREE.DynamicDrawUsage)
  g.setAttribute('aPale', pale)
  const m = new THREE.InstancedMesh(g, flaskMaterial(), count)
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  m.frustumCulled = false
  m.count = 0
  m.name = 'flasks'
  // stage.ts convention: not outlined (the flasks glow; their own bright rim is the outline)
  m.userData.outline = false
  return m
}

/**
 * Generic pose: bulb centre at (cx, cy, cz), neck pointing along the UNIT vector (ax, ay, az).
 * @param scale   uniform size (1 = real size; use it for pop-in)
 * @param stretch extra scale along the neck axis only (> 1 turns the flask into the blue streak of the pickup, SPEC 9 row 7)
 */
export function setFlask(mesh: THREE.InstancedMesh, i: number, cx: number, cy: number, cz: number, ax: number, ay: number, az: number, scale = 1, stretch = 1): void {
  const e = mesh.instanceMatrix.array as Float32Array
  const o = i * 16
  const sy = scale * stretch
  if (ay < -0.9999) {
    // pointing straight down: half turn about x
    e[o] = scale
    e[o + 1] = 0
    e[o + 2] = 0
    e[o + 4] = 0
    e[o + 5] = -sy
    e[o + 6] = 0
    e[o + 8] = 0
    e[o + 9] = 0
    e[o + 10] = -scale
  } else {
    // shortest rotation taking +y onto the axis (continuous, so a tumbling flask never pops)
    const k = 1 / (1 + ay)
    e[o] = (1 - ax * ax * k) * scale
    e[o + 1] = -ax * scale
    e[o + 2] = -ax * az * k * scale
    e[o + 4] = ax * sy
    e[o + 5] = ay * sy
    e[o + 6] = az * sy
    e[o + 8] = -ax * az * k * scale
    e[o + 9] = -az * scale
    e[o + 10] = (1 - az * az * k) * scale
  }
  e[o + 3] = e[o + 7] = e[o + 11] = 0
  e[o + 12] = cx
  e[o + 13] = cy
  e[o + 14] = cz
  e[o + 15] = 1
}

/** Upright flask whose bulb BOTTOM is at (x, yBottom, z). */
export function setFlaskUpright(mesh: THREE.InstancedMesh, i: number, x: number, yBottom: number, z: number, scale = 1): void {
  setFlask(mesh, i, x, yBottom + FLASK_RADIUS * scale, z, 0, 1, 0, scale)
}

/**
 * Flask lying on its side on the ground at (x, z), neck pointing along heading `yaw` (sim `GroundFlask.rot`),
 * resting on the bulb and the cork.
 */
export function setFlaskLying(mesh: THREE.InstancedMesh, i: number, x: number, z: number, yaw: number, groundY = 0, scale = 1): void {
  const c = Math.cos(LIE_TILT)
  setFlask(mesh, i, x, groundY + FLASK_RADIUS * scale, z, Math.sin(yaw) * c, -Math.sin(LIE_TILT), Math.cos(yaw) * c, scale)
}

/**
 * Ejected flask hopping from the tray edge to its place in the pile (SPEC 2.4: 0.15-0.2 s, arc 0.5-1.0 m high,
 * tumbling, landing on its side). At k = 1 the pose is exactly setFlaskLying(x = toX, z = toZ, yaw).
 * Typical call for a sim GroundFlask f: k = f.age / P.FLASK_EJECT_FLIGHT (use setFlaskLying once k >= 1),
 * apex = 0.5 + 0.5 * ((f.id * 0.618) % 1).
 * @param k     flight progress 0..1
 * @param apex  height of the arc in metres
 * @param fromY height it leaves the tray at (default 0.3, just above the tray rim)
 */
export function setFlaskFlight(mesh: THREE.InstancedMesh, i: number, fromX: number, fromZ: number, toX: number, toZ: number, k: number, yaw: number, apex = 0.75, fromY = 0.3): void {
  k = k < 0 ? 0 : k > 1 ? 1 : k
  const th = Math.PI / 2 + LIE_TILT - (1 - k) * Math.PI * 2.5 // 1.25 tumbles, ending in the lying pose
  const s = Math.sin(th)
  const y = fromY + (FLASK_RADIUS - fromY) * k + apex * 4 * k * (1 - k)
  const pop = 0.55 + 0.45 * Math.min(1, k * 4)
  setFlask(mesh, i, fromX + (toX - fromX) * k, y, fromZ + (toZ - fromZ) * k, Math.sin(yaw) * s, Math.cos(th), Math.cos(yaw) * s, pop)
}

/**
 * Straight upright stack of n flasks starting at instance `first`: the bottom of the lowest bulb is at (x, y, z)
 * (y = 0.3 for the stack on a carrier's back, SPEC 2.1). Height = (n - 1) * pitch + P.FLASK_TOTAL.
 */
export function setFlaskStack(mesh: THREE.InstancedMesh, first: number, n: number, x: number, y: number, z: number, pitch: number = P.FLASK_STACK_PITCH): void {
  for (let j = 0; j < n; j++) setFlask(mesh, first + j, x, y + FLASK_RADIUS + j * pitch, z, 0, 1, 0)
}

/**
 * Bent / stretched stack: `nodes` holds the n bulb centres as [x0, y0, z0, x1, y1, z1, ...] (bottom first). Every
 * flask leans FLASK_CHAIN_TILT of the way from upright toward the node above it; the top one leans like the last link.
 */
export function setFlaskChain(mesh: THREE.InstancedMesh, first: number, n: number, nodes: ArrayLike<number>): void {
  let ax = 0
  let ay = 1
  let az = 0
  for (let j = 0; j < n; j++) {
    const o = j * 3
    if (j < n - 1) {
      const dx = (nodes[o + 3]! - nodes[o]!) * FLASK_CHAIN_TILT
      const dy = nodes[o + 4]! - nodes[o + 1]!
      const dz = (nodes[o + 5]! - nodes[o + 2]!) * FLASK_CHAIN_TILT
      const l = Math.hypot(dx, dy, dz)
      if (l > 1e-6) {
        ax = dx / l
        ay = dy / l
        az = dz / l
      }
    }
    setFlask(mesh, first + j, nodes[o]!, nodes[o + 1]!, nodes[o + 2]!, ax, ay, az)
  }
}

/** Paleness of one instance: 0 = normal saturated blue, 1 = washed-out pale blue-white. Call commitFlasks() afterwards. */
export function setFlaskPale(mesh: THREE.InstancedMesh, i: number, pale: number): void {
  const a = mesh.geometry.getAttribute('aPale') as THREE.InstancedBufferAttribute
  if (a.array[i] !== pale) {
    ;(a.array as Float32Array)[i] = pale
    a.needsUpdate = true
  }
}

/** Call once per frame after the setFlask*() writes: sets the number of flasks drawn and uploads the matrices. */
export function commitFlasks(mesh: THREE.InstancedMesh, count: number): void {
  mesh.count = count
  mesh.instanceMatrix.needsUpdate = true
}

/**
 * Soft contact shadows for flasks lying on the ground, all in ONE draw call (a pile is 10-18 flasks; do not give each
 * its own blobShadow()). Add it to the same parent as the flask mesh, write one shadow per lying flask with
 * setFlaskShadow() and finish with commitFlasks(shadowMesh, n). `mesh.count` starts at 0.
 */
export function createFlaskShadowMesh(count: number): THREE.InstancedMesh {
  const proto = blobShadow(1, 1, 0.34)
  const m = new THREE.InstancedMesh(proto.geometry.rotateX(-Math.PI / 2), proto.material, count)
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  m.frustumCulled = false
  m.count = 0
  m.renderOrder = 1
  m.name = 'flaskShadows'
  return m
}

/**
 * Shadow of the flask posed by setFlaskLying(mesh, i, x, z, yaw, groundY): an oval under the bulb and the neck.
 * @param scale 1 = lying flask; pass the flight progress k (0..1) to let it grow while the flask comes down
 */
export function setFlaskShadow(shadows: THREE.InstancedMesh, i: number, x: number, z: number, yaw: number, groundY = 0, scale = 1): void {
  const e = shadows.instanceMatrix.array as Float32Array
  const o = i * 16
  const s = Math.sin(yaw)
  const c = Math.cos(yaw)
  const w = 1.1 * scale // across the neck
  const l = 1.5 * scale // along the neck
  e[o] = c * w
  e[o + 1] = 0
  e[o + 2] = -s * w
  e[o + 3] = 0
  e[o + 4] = 0
  e[o + 5] = 1
  e[o + 6] = 0
  e[o + 7] = 0
  e[o + 8] = s * l
  e[o + 9] = 0
  e[o + 10] = c * l
  e[o + 11] = 0
  e[o + 12] = x + s * 0.26 + 0.05
  e[o + 13] = groundY + 0.012
  e[o + 14] = z + c * 0.26 + 0.04
  e[o + 15] = 1
}

export interface FlaskModel {
  /** A single upright flask standing on y = 0 at the origin (bulb bottom on the ground, cork top at P.FLASK_TOTAL). */
  root: THREE.Group
  /** 0 = saturated blue .. 1 = pale. */
  setPale(pale: number): void
}

/** One standalone flask (icons, props, tests). For many flasks use createFlaskMesh(). */
export function makeFlask(): FlaskModel {
  const m = createFlaskMesh(1)
  setFlaskUpright(m, 0, 0, 0, 0)
  commitFlasks(m, 1)
  const root = new THREE.Group()
  root.name = 'flask'
  root.add(m)
  const sh = blobShadow(1.1, 1.1, 0.45)
  root.add(sh)
  return {
    root,
    setPale(p) {
      setFlaskPale(m, 0, p)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// gallery
// ---------------------------------------------------------------------------------------------------------------------

const rnd = (i: number, k: number) => {
  const s = Math.sin(i * 127.1 + k * 311.7 + 0.7) * 43758.5453
  return s - Math.floor(s)
}

function stackItem(name: string, n: number, sway: boolean): GalleryItem {
  const nodes = new Float32Array(n * 3)
  return {
    name,
    size: Math.max(1.2, n * 0.42),
    make: () => {
      const m = createFlaskMesh(n)
      setFlaskStack(m, 0, n, 0, 0.3, 0)
      // as seen at 43-44 s: the lower flasks of a tall stack are paler
      if (n > 6) for (let j = 0; j < 4; j++) setFlaskPale(m, j, 0.7 - j * 0.16)
      commitFlasks(m, n)
      const g = new THREE.Group()
      g.add(m, blobShadow(1.0, 1.0, 0.45))
      g.userData.mesh = m
      return g
    },
    animate: sway
      ? (o, t) => {
          const m = o.userData.mesh as THREE.InstancedMesh
          // lagging chain: bends back up to 38 deg and stretches up to 30 % at full speed, then whips upright
          const run = Math.max(0, Math.sin(t * 1.6))
          const bend = (38 * Math.PI) / 180 * run
          let x = 0
          let y = 0.3 + FLASK_RADIUS
          for (let j = 0; j < n; j++) {
            nodes[j * 3] = x
            nodes[j * 3 + 1] = y
            nodes[j * 3 + 2] = 0
            const k = flaskChainLean(Math.max(0, n - 2 - j))
            const pitch = P.FLASK_STACK_PITCH * (1 + 0.3 * run * k)
            x -= Math.sin(bend * k) * pitch
            y += Math.cos(bend * k) * pitch
          }
          setFlaskChain(m, 0, n, nodes)
          commitFlasks(m, n)
        }
      : undefined,
  }
}

function pileItem(name: string, n: number, live: boolean): GalleryItem {
  const place = (i: number) => {
    // loose heap in the landing area (2.2 x 3.4 m), SPEC 2.5
    const a = i * 2.399963
    const r = 0.25 + 0.42 * Math.sqrt(i + 0.5)
    return { x: Math.cos(a) * r * 0.62, z: Math.sin(a) * r, yaw: rnd(i, 3) * Math.PI * 2 }
  }
  return {
    name,
    size: 2.2,
    make: () => {
      const m = createFlaskMesh(n)
      for (let i = 0; i < n; i++) {
        const p = place(i)
        setFlaskLying(m, i, p.x, p.z, p.yaw)
      }
      commitFlasks(m, n)
      const sh = createFlaskShadowMesh(n)
      for (let i = 0; i < n; i++) {
        const p = place(i)
        setFlaskShadow(sh, i, p.x, p.z, p.yaw)
      }
      commitFlasks(sh, n)
      const g = new THREE.Group()
      g.add(m, sh)
      g.userData = { mesh: m, shadows: sh }
      return g
    },
    animate: live
      ? (o, t) => {
          const m = o.userData.mesh as THREE.InstancedMesh
          const sh = o.userData.shadows as THREE.InstancedMesh
          const T = n * P.FLASK_EJECT_INTERVAL + 1.2
          const tt = t % T
          let c = 0
          for (let i = 0; i < n; i++) {
            const age = tt - i * P.FLASK_EJECT_INTERVAL
            if (age < 0) continue
            const p = place(i)
            if (age < P.FLASK_EJECT_FLIGHT) setFlaskFlight(m, c, 1.3, (rnd(i, 5) - 0.5) * 2.5, p.x, p.z, age / P.FLASK_EJECT_FLIGHT, p.yaw, 0.5 + 0.5 * rnd(i, 6))
            else setFlaskLying(m, c, p.x, p.z, p.yaw)
            setFlaskShadow(sh, c, p.x, p.z, p.yaw, 0, Math.min(1, age / P.FLASK_EJECT_FLIGHT))
            c++
          }
          commitFlasks(m, c)
          commitFlasks(sh, c)
        }
      : undefined,
  }
}

export const GALLERY: GalleryItem[] = [
  { name: 'flask', size: 0.7, make: () => makeFlask().root },
  stackItem('flask-stack-5', 5, false),
  stackItem('flask-stack-9', 9, false),
  stackItem('flask-stack-sway', 5, true),
  pileItem('flask-pile-10', 10, false),
  pileItem('flask-pile-18', 18, false),
  pileItem('flask-eject', 10, true),
]
