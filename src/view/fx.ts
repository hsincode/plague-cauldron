// Shared particle system: camera-facing (or ground-flat) textured quads drawn with two InstancedMeshes
// (normal and additive blending). Everything short-lived and sprite-like goes through here: dust, sparks,
// splashes, glows, rings, plumes, specks. Mesh-based effects (shards, coins, flasks) are owned by their views.
import * as THREE from 'three'

export type FxTex = 'dot' | 'puff' | 'spark' | 'ring' | 'star' | 'streak' | 'arrowUp' | 'splash'
const TEX: FxTex[] = ['dot', 'puff', 'spark', 'ring', 'star', 'streak', 'arrowUp', 'splash']
const COLS = 4
const ROWS = 2

export interface FxOpts {
  x: number
  y: number
  z: number
  vx?: number
  vy?: number
  vz?: number
  /** Seconds to live. */
  life: number
  /** World size (metres) at birth and at death (defaults to size). */
  size: number
  size1?: number
  /** Colour at birth and at death (hex, sRGB). */
  color: number
  color1?: number
  /** Peak opacity; fades in over fadeIn (fraction of life, default 0.08) and out from fadeOut (default 0.6). */
  alpha?: number
  fadeIn?: number
  fadeOut?: number
  /** Downward acceleration (m/s^2) and velocity damping (1/s). */
  gravity?: number
  drag?: number
  tex?: FxTex
  additive?: boolean
  /** Rotation (radians) and spin (rad/s) of the quad. */
  rot?: number
  spin?: number
  /** Lie flat on the ground plane instead of facing the camera (rings, shock waves). */
  flat?: boolean
  /** Stretch factor along the quad's local y (streaks, plumes). */
  stretch?: number
  /** Seconds before the particle appears. */
  delay?: number
  /** Stop at ground level and stay there until it dies. */
  floor?: boolean
}

interface Layer {
  mesh: THREE.Mesh
  geo: THREE.InstancedBufferGeometry
  n: number
  // per-particle simulation data
  px: Float32Array; py: Float32Array; pz: Float32Array
  vx: Float32Array; vy: Float32Array; vz: Float32Array
  age: Float32Array; life: Float32Array
  s0: Float32Array; s1: Float32Array
  c0: Float32Array; c1: Float32Array
  a: Float32Array; fi: Float32Array; fo: Float32Array
  g: Float32Array; drag: Float32Array
  rot: Float32Array; spin: Float32Array
  tex: Uint8Array; flat: Uint8Array; floor: Uint8Array
  stretch: Float32Array
  // GPU attributes
  aPos: THREE.InstancedBufferAttribute // xyz + size
  aCol: THREE.InstancedBufferAttribute // rgb + alpha
  aMisc: THREE.InstancedBufferAttribute // rot, tex, flat, stretch
}

function makeAtlas(): THREE.Texture {
  const cell = 128
  const c = document.createElement('canvas')
  c.width = cell * COLS
  c.height = cell * ROWS
  const g = c.getContext('2d')!
  const at = (i: number, draw: (g: CanvasRenderingContext2D, s: number) => void) => {
    g.save()
    g.translate((i % COLS) * cell, Math.floor(i / COLS) * cell)
    g.beginPath()
    g.rect(0, 0, cell, cell)
    g.clip()
    draw(g, cell)
    g.restore()
  }
  const radial = (g: CanvasRenderingContext2D, s: number, stops: [number, number][]) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
    for (const [o, al] of stops) gr.addColorStop(o, `rgba(255,255,255,${al})`)
    g.fillStyle = gr
    g.fillRect(0, 0, s, s)
  }
  at(0, (g, s) => radial(g, s, [[0, 1], [0.45, 0.9], [0.7, 0.25], [1, 0]])) // dot: solid core, soft edge
  at(1, (g, s) => { // puff: lumpy soft cloud
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2
      const r = s * 0.2
      const x = s / 2 + Math.cos(a) * r * (i ? 1 : 0)
      const y = s / 2 + Math.sin(a) * r * (i ? 1 : 0)
      const gr = g.createRadialGradient(x, y, 0, x, y, s * 0.28)
      gr.addColorStop(0, 'rgba(255,255,255,0.55)')
      gr.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = gr
      g.fillRect(0, 0, s, s)
    }
  })
  at(2, (g, s) => { // spark: four-point glint
    radial(g, s, [[0, 1], [0.15, 0.7], [0.4, 0.12], [1, 0]])
    g.fillStyle = 'rgba(255,255,255,0.95)'
    g.beginPath()
    const m = s / 2
    g.moveTo(m, s * 0.04); g.quadraticCurveTo(m + s * 0.04, m - s * 0.04, s * 0.96, m)
    g.quadraticCurveTo(m + s * 0.04, m + s * 0.04, m, s * 0.96); g.quadraticCurveTo(m - s * 0.04, m + s * 0.04, s * 0.04, m)
    g.quadraticCurveTo(m - s * 0.04, m - s * 0.04, m, s * 0.04)
    g.fill()
  })
  at(3, (g, s) => { // ring
    g.strokeStyle = 'rgba(255,255,255,1)'
    g.lineWidth = s * 0.05
    g.shadowColor = 'white'
    g.shadowBlur = s * 0.06
    g.beginPath(); g.arc(s / 2, s / 2, s * 0.42, 0, Math.PI * 2); g.stroke()
  })
  at(4, (g, s) => { // star: five-point
    g.fillStyle = 'white'
    g.shadowColor = 'white'
    g.shadowBlur = s * 0.08
    g.beginPath()
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? s * 0.18 : s * 0.42
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2
      g.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r)
    }
    g.closePath(); g.fill()
  })
  at(5, (g, s) => { // streak: vertical soft line
    const gr = g.createLinearGradient(0, 0, s, 0)
    gr.addColorStop(0.3, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,1)'); gr.addColorStop(0.7, 'rgba(255,255,255,0)')
    g.fillStyle = gr
    g.fillRect(0, 0, s, s)
    const gv = g.createLinearGradient(0, 0, 0, s)
    gv.addColorStop(0, 'rgba(0,0,0,1)'); gv.addColorStop(0.25, 'rgba(0,0,0,0)'); gv.addColorStop(0.75, 'rgba(0,0,0,0)'); gv.addColorStop(1, 'rgba(0,0,0,1)')
    g.globalCompositeOperation = 'destination-out'
    g.fillStyle = gv
    g.fillRect(0, 0, s, s)
  })
  at(6, (g, s) => { // arrowUp: outlined up-arrow glyph
    g.lineJoin = 'round'
    g.beginPath()
    g.moveTo(s * 0.5, s * 0.1); g.lineTo(s * 0.85, s * 0.48); g.lineTo(s * 0.64, s * 0.48); g.lineTo(s * 0.64, s * 0.9)
    g.lineTo(s * 0.36, s * 0.9); g.lineTo(s * 0.36, s * 0.48); g.lineTo(s * 0.15, s * 0.48); g.closePath()
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fill()
    g.strokeStyle = 'white'; g.lineWidth = s * 0.06; g.stroke()
  })
  at(7, (g, s) => { // splash: spiky burst
    g.fillStyle = 'white'
    g.beginPath()
    const n = 9
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 ? s * 0.2 : s * (0.34 + ((i * 37) % 11) / 80)
      const a = (i / (n * 2)) * Math.PI * 2
      g.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r)
    }
    g.closePath(); g.fill()
  })
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  t.generateMipmaps = true
  return t
}

const VERT = /* glsl */ `
attribute vec4 aPos;   // xyz, size
attribute vec4 aCol;   // rgb (linear), alpha
attribute vec4 aMisc;  // rot, tex index, flat, stretch
varying vec2 vUv;
varying vec4 vCol;
#include <fog_pars_vertex>
void main() {
  float c = cos(aMisc.x), s = sin(aMisc.x);
  vec2 q = position.xy * vec2(1.0, aMisc.w);
  q = vec2(q.x * c - q.y * s, q.x * s + q.y * c) * aPos.w;
  vec4 mvPosition;
  if (aMisc.z > 0.5) {
    mvPosition = viewMatrix * vec4(aPos.x + q.x, aPos.y, aPos.z - q.y, 1.0);
  } else {
    mvPosition = viewMatrix * vec4(aPos.xyz, 1.0);
    mvPosition.xy += q;
  }
  gl_Position = projectionMatrix * mvPosition;
  float ti = aMisc.y;
  vec2 cell = vec2(mod(ti, ${COLS}.0), floor(ti / ${COLS}.0));
  vUv = vec2((cell.x + uv.x) / ${COLS}.0, 1.0 - (cell.y + 1.0 - uv.y) / ${ROWS}.0);
  vCol = aCol;
  #include <fog_vertex>
}`
const FRAG = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vCol;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(vCol.rgb, vCol.a * t.a);
  if (gl_FragColor.a < 0.004) discard;
  #include <colorspace_fragment>
  #include <fog_fragment>
}`

export interface Fx {
  root: THREE.Group
  spawn(o: FxOpts): void
  update(dt: number): void
  /** Drop every particle at once. */
  clear(): void
  /** Live particle count (debug). */
  count(): number
}

export function createFx(max = 3000): Fx {
  const atlas = makeAtlas()
  const quad = new THREE.PlaneGeometry(1, 1)
  const col = new THREE.Color()
  const col1 = new THREE.Color()

  const makeLayer = (additive: boolean): Layer => {
    const geo = new THREE.InstancedBufferGeometry()
    geo.index = quad.index
    geo.setAttribute('position', quad.getAttribute('position'))
    geo.setAttribute('uv', quad.getAttribute('uv'))
    const aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4)
    const aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4)
    const aMisc = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4)
    for (const a of [aPos, aCol, aMisc]) a.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aPos', aPos)
    geo.setAttribute('aCol', aCol)
    geo.setAttribute('aMisc', aMisc)
    geo.instanceCount = 0
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null } }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: !additive,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    })
    mat.uniforms.map!.value = atlas
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = additive ? 11 : 10
    const f = () => new Float32Array(max)
    return {
      mesh, geo, n: 0,
      px: f(), py: f(), pz: f(), vx: f(), vy: f(), vz: f(), age: f(), life: f(), s0: f(), s1: f(),
      c0: new Float32Array(max * 3), c1: new Float32Array(max * 3), a: f(), fi: f(), fo: f(), g: f(), drag: f(),
      rot: f(), spin: f(), tex: new Uint8Array(max), flat: new Uint8Array(max), floor: new Uint8Array(max), stretch: f(),
      aPos, aCol, aMisc,
    }
  }
  const layers = [makeLayer(false), makeLayer(true)]
  const root = new THREE.Group()
  root.add(layers[0]!.mesh, layers[1]!.mesh)

  const spawn = (o: FxOpts) => {
    const L = layers[o.additive ? 1 : 0]!
    if (L.n >= max) return
    const i = L.n++
    L.px[i] = o.x; L.py[i] = o.y; L.pz[i] = o.z
    L.vx[i] = o.vx ?? 0; L.vy[i] = o.vy ?? 0; L.vz[i] = o.vz ?? 0
    L.age[i] = -(o.delay ?? 0); L.life[i] = o.life
    L.s0[i] = o.size; L.s1[i] = o.size1 ?? o.size
    col.setHex(o.color)
    col1.setHex(o.color1 ?? o.color)
    L.c0[i * 3] = col.r; L.c0[i * 3 + 1] = col.g; L.c0[i * 3 + 2] = col.b
    L.c1[i * 3] = col1.r; L.c1[i * 3 + 1] = col1.g; L.c1[i * 3 + 2] = col1.b
    L.a[i] = o.alpha ?? 1; L.fi[i] = o.fadeIn ?? 0.08; L.fo[i] = o.fadeOut ?? 0.6
    L.g[i] = o.gravity ?? 0; L.drag[i] = o.drag ?? 0
    L.rot[i] = o.rot ?? 0; L.spin[i] = o.spin ?? 0
    L.tex[i] = Math.max(0, TEX.indexOf(o.tex ?? 'dot'))
    L.flat[i] = o.flat ? 1 : 0; L.floor[i] = o.floor ? 1 : 0
    L.stretch[i] = o.stretch ?? 1
  }

  const update = (dt: number) => {
    for (const L of layers) {
      const pos = L.aPos.array as Float32Array
      const colA = L.aCol.array as Float32Array
      const misc = L.aMisc.array as Float32Array
      let i = 0
      while (i < L.n) {
        L.age[i]! += dt
        if (L.age[i]! >= L.life[i]!) {
          // swap-remove
          const j = --L.n
          if (i !== j) {
            L.px[i] = L.px[j]!; L.py[i] = L.py[j]!; L.pz[i] = L.pz[j]!
            L.vx[i] = L.vx[j]!; L.vy[i] = L.vy[j]!; L.vz[i] = L.vz[j]!
            L.age[i] = L.age[j]!; L.life[i] = L.life[j]!; L.s0[i] = L.s0[j]!; L.s1[i] = L.s1[j]!
            for (let k = 0; k < 3; k++) { L.c0[i * 3 + k] = L.c0[j * 3 + k]!; L.c1[i * 3 + k] = L.c1[j * 3 + k]! }
            L.a[i] = L.a[j]!; L.fi[i] = L.fi[j]!; L.fo[i] = L.fo[j]!; L.g[i] = L.g[j]!; L.drag[i] = L.drag[j]!
            L.rot[i] = L.rot[j]!; L.spin[i] = L.spin[j]!; L.tex[i] = L.tex[j]!; L.flat[i] = L.flat[j]!; L.floor[i] = L.floor[j]!
            L.stretch[i] = L.stretch[j]!
          }
          continue
        }
        const age = L.age[i]!
        if (age >= 0) {
          const d = Math.max(0, 1 - L.drag[i]! * dt)
          L.vx[i]! *= d; L.vz[i]! *= d
          L.vy[i] = L.vy[i]! * d - L.g[i]! * dt
          L.px[i]! += L.vx[i]! * dt; L.py[i]! += L.vy[i]! * dt; L.pz[i]! += L.vz[i]! * dt
          if (L.floor[i] && L.py[i]! < 0.03) { L.py[i] = 0.03; L.vx[i] = 0; L.vy[i] = 0; L.vz[i] = 0 }
          L.rot[i]! += L.spin[i]! * dt
        }
        const u = age < 0 ? 0 : age / L.life[i]!
        const fi = L.fi[i]!
        const fo = L.fo[i]!
        const fade = age < 0 ? 0 : (fi > 0 && u < fi ? u / fi : 1) * (u > fo ? Math.max(0, 1 - (u - fo) / (1 - fo)) : 1)
        const o = i * 4
        pos[o] = L.px[i]!; pos[o + 1] = L.py[i]!; pos[o + 2] = L.pz[i]!
        pos[o + 3] = L.s0[i]! + (L.s1[i]! - L.s0[i]!) * u
        colA[o] = L.c0[i * 3]! + (L.c1[i * 3]! - L.c0[i * 3]!) * u
        colA[o + 1] = L.c0[i * 3 + 1]! + (L.c1[i * 3 + 1]! - L.c0[i * 3 + 1]!) * u
        colA[o + 2] = L.c0[i * 3 + 2]! + (L.c1[i * 3 + 2]! - L.c0[i * 3 + 2]!) * u
        colA[o + 3] = L.a[i]! * fade
        misc[o] = L.rot[i]!; misc[o + 1] = L.tex[i]!; misc[o + 2] = L.flat[i]!; misc[o + 3] = L.stretch[i]!
        i++
      }
      L.geo.instanceCount = L.n
      L.aPos.needsUpdate = true
      L.aCol.needsUpdate = true
      L.aMisc.needsUpdate = true
      L.mesh.visible = L.n > 0
    }
  }

  return {
    root,
    spawn,
    update,
    clear() {
      for (const L of layers) L.n = 0
    },
    count: () => layers[0]!.n + layers[1]!.n,
  }
}
