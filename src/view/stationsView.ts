// Stations view: everything that stands still and tells the player what to do next. It binds the cauldron (potion
// level, pour / bath / cure effects, the fire and potion lights), the capacity label and the two bubbles over the
// pot, the beds of both wards with their unlock glow and bedside bubbles, the side table, the price pads, the guide
// arrow, and the bursts other packages rely on (unlock pillar / object glow, healed burst, win celebration).
//
// Everything persistent is a function of GameState and is re-derived in every update(); events only start one-shot
// effects. Nothing in update() allocates: particles go through one scratch FxOpts, instances through typed arrays.
import * as THREE from 'three'
import { BEDS, L, P, PAL, SCREEN_RIGHT, SCREEN_UP, UNLOCKS, type UnlockId } from '../config'
import { clamp01, easeInOutQuad, easeOutBack, easeOutCubic, lerp } from '../core/math'
import type { GameEvent } from '../sim/events'
import type { Bed, GameState, Nurse } from '../sim/types'
import { makeArrow } from '../ui/arrow'
import { makeBubble } from '../ui/bubbles'
import { makeBedOutline, makeCapacityLabel, makePricePad, type BedOutlineDecal } from '../ui/decals'
import type { FxOpts, FxTex } from './fx'
import { lam } from './materials'
import { makeCauldron } from './models/cauldron'
import { makeBed, makeSideTable } from './models/furniture'
import { LIGHT, type Stage } from './stage'
import type { ViewCtx, ViewModule } from './types'

const TAU = Math.PI * 2

// --- timings (seconds) ---
/** Bubbles and the arrow scale in over 4 frames and out over 3 (SPEC 8.3, 2.11). */
const POP_IN = 0.13
const POP_OUT = 0.1
/** The potion request comes back this long after the pot is free again (ad: batch leaves 32.30, bubble 32.57). */
const POTION_DWELL = 0.25
/** Treatment timeline of SPEC 2.10 that P does not name: the plus bubble, and how long the pie takes. */
const TREAT_PLUS = 0.15
const TREAT_PIE_TIME = 0.37
const TREAT_OUT_TIME = 0.17
/** A paid pad shrinks away in 2 frames (SPEC 2.9). */
const PAD_OUT = 0.07
const ARROW_FLY = 0.38
const BIG_GROW = 0.45
/** Unlock pillar: peak at 0.15 s, gone by 0.5 s (SPEC 9 row 18). */
const PILLAR_TIME = 0.5
/**
 * Object glow (SPEC 9 row 19; ad 51.07 empty yard, 51.2 full glow, 51.4 outlines only, 51.6 nothing), by the age of
 * the effect: nothing for one frame (`start`), the curtain is up `rise` later and stays full until `full` after the
 * start, fades over `fade`; the outline on the floor stays until `lineEnd` and fades over `lineFade`; the object itself
 * pops in at `pop` over `popTime`.
 */
const GLOW = { start: 0.04, rise: 0.07, full: 0.25, fade: 0.09, lineEnd: 0.45, lineFade: 0.08, pop: 0.1, popTime: 0.16 } as const
const GLOW_END = GLOW.lineEnd + GLOW.lineFade
/** Ward-2 beds light up in a quick ripple rather than all in the same frame. */
const BED_STAGGER = 0.012

// --- places ---
/**
 * Tail tips of the bubbles over the pot, from its centre. Potion: the tip stands on the far rim as seen by the camera
 * (ad 8.4-8.8 s, 32.6-33.0 s). Cure: higher, clear of the leaping bathers (ad 13.6-14.4 s).
 */
const POTION_BUBBLE = { x: 0, y: 3.1, z: 0 }
const CURE_BUBBLE = { x: 0.14, y: 4.2, z: 0.12 }
/** Tail tip of the bubbles over a bed, from the bed centre: just above the patient's head (ad 17.0 s, 19.0 s, 22.2 s). */
const BED_BUBBLE = { x: 0.72, y: 1.45 }
/**
 * Circle diameters measured against the cauldron rim, the bed and the doctor's ring in those frames: the two alert
 * bubbles are larger in the ad than the defaults of ui/bubbles.ts (90 px against a 206 px rim; 70 px on a 146 px bed).
 */
const POTION_BUBBLE_SIZE = 1.3
const NURSE_BUBBLE_SIZE = 1.1
const BED_CURE_SIZE = 1.0
const WARD2_CENTRE = { x: (L.WARD2[0] + L.WARD2[2]) / 2, z: (L.WARD2[1] + L.WARD2[3]) / 2 }
/** Footprints (metres) of the things that appear in an object glow drawn here. */
const CHEST_RECT = { w: 1.7, d: 1.4 }
const POT_RECT = 5.6
/**
 * Peak of the light a pillar casts around, and how far. At LIGHT.flashPeak itself beds and floor 3 m away burn out to
 * white; in the ad they only turn warmer (20.4 s: the planks beside the pillar go from #877b89 to #b88687).
 */
const PILLAR_LIGHT = LIGHT.flashPeak * 0.5
const PILLAR_LIGHT_RANGE = 6
/** Peak of the light an object glow casts around, and how far. */
const GLOW_LIGHT = LIGHT.flashPeak * 0.45
const GLOW_LIGHT_RANGE = 9
/** Golden light pillars of the win celebration (SPEC 3.4), around the cauldron. */
const WIN_PILLARS = [
  { x: -2.6, z: -2.4 },
  { x: 2.9, z: -1.6 },
  { x: -2.3, z: 2.7 },
  { x: 2.4, z: 2.3 },
] as const
/** The celebration's pillars start once the camera is nearly there; main.ts brings up the win card after 2.5 s. */
const WIN_PILLAR_START = 0.55
const WIN_CARD = 2.6
const FESTIVE = [PAL.gold, PAL.goldCore, PAL.bubbleHi, PAL.ring, PAL.pouchB, 0xffffff] as const
/** Colours of the bursts: the hot core of golden light, the fiery rim of the unlock pillar, and what they cast around. */
const HOT = 0xfff0c0
const EMBER = 0xff5a26
const FIRELIGHT = 0xff9a48

/** Pop-in curve 0 -> 1.1 -> 1 (SPEC 8.3). */
const popIn = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : k < 0.7 ? 1.1 * (1 - (1 - k / 0.7) ** 2) : 1.1 - 0.1 * ((k - 0.7) / 0.3))
/** Moves a 0..1 visibility toward shown (in `tin` seconds) or hidden (in `tout`). */
const fade = (k: number, on: boolean, dt: number, tin: number, tout: number) => (on ? Math.min(1, k + dt / tin) : Math.max(0, k - dt / tout))
/**
 * Pad pay fill for a paid fraction. In the ad the green lags the payment: it starts when the first coins land and
 * is complete well before the last one (19.87-19.97 of 19.73-20.23, 28.07-28.30 of 27.77-28.43, 50.47-50.90 of
 * 50.33-51.07).
 */
const padFill = (frac: number) => 1 - (1 - clamp01((frac - 0.18) / 0.55)) ** 2

// Cheap deterministic noise for effects only (it never feeds back into the simulation).
let seed = 0x2545f491
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
const rs = () => rnd() * 2 - 1
const pick = (list: readonly number[]) => list[Math.floor(rnd() * list.length) % list.length]!

/** Scratch particle: part() resets it and the caller fills in the rest, so emitting never allocates. */
const o: FxOpts = { x: 0, y: 0, z: 0, life: 1, size: 1, color: 0xffffff }
function part(tex: FxTex, x: number, y: number, z: number, life: number, size: number, color: number): FxOpts {
  o.tex = tex
  o.x = x
  o.y = y
  o.z = z
  o.life = life
  o.size = size
  o.color = color
  o.size1 = o.color1 = undefined
  o.vx = o.vy = o.vz = 0
  o.alpha = 1
  o.fadeIn = 0.08
  o.fadeOut = 0.6
  o.gravity = o.drag = o.rot = o.spin = o.delay = 0
  o.stretch = 1
  o.additive = o.flat = o.floor = false
  return o
}

// ---------------------------------------------------------------------------------------------------------------
// flash light: several bursts may ask for the one spare stage light; the brightest of them gets it

interface FlashLight {
  /** Light pulse at a point: 0 -> peak in 30 % of `dur`, then back to 0. */
  fire(x: number, y: number, z: number, peak: number, dur: number, color: number, range?: number): void
  update(dt: number): void
}

function createFlash(stage: Stage): FlashLight {
  const N = 4
  const F = 8
  const d = new Float32Array(N * F) // x, y, z, peak, dur, range, t, colour
  for (let i = 0; i < N; i++) d[i * F + 6] = 1e9
  return {
    fire(x, y, z, peak, dur, color, range = 7) {
      // take the slot that is furthest through its pulse
      let slot = 0
      for (let i = 1; i < N; i++) if (d[i * F + 6]! / d[i * F + 4]! > d[slot * F + 6]! / d[slot * F + 4]!) slot = i
      const k = slot * F
      d[k] = x
      d[k + 1] = y
      d[k + 2] = z
      d[k + 3] = peak
      d[k + 4] = dur
      d[k + 5] = range
      d[k + 6] = 0
      d[k + 7] = color
    },
    update(dt) {
      let best = 0
      let at = -1
      for (let i = 0; i < N; i++) {
        const k = i * F
        if (d[k + 6]! >= d[k + 4]!) continue
        d[k + 6]! += dt
        const u = d[k + 6]! / d[k + 4]!
        const v = u >= 1 ? 0 : d[k + 3]! * (u < 0.3 ? easeOutCubic(u / 0.3) : (1 - (u - 0.3) / 0.7) ** 2)
        if (v > best) {
          best = v
          at = k
        }
      }
      stage.flash.intensity = best
      if (at >= 0) {
        stage.flash.position.set(d[at]!, d[at + 1]!, d[at + 2]!)
        stage.flash.distance = d[at + 5]!
        stage.flash.color.setHex(d[at + 7]!)
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// object glow (SPEC 9 row 19): a translucent golden curtain rising from a rectangle on the floor. One InstancedMesh
// for every curtain on screen; the callers re-submit their curtains each frame with the age of the effect.

const CURTAIN_BAND = 0.5 // half width (m) of the soft glow on the floor along the foot of the curtain
const CURTAIN_VERT = /* glsl */ `
attribute vec3 aInfo; // part (0 wall, 1 floor band, 2 floor fill), v, wall axis (0 along x, 1 along z)
attribute vec2 aOut;  // floor band: which way this vertex leaves the line
attribute vec3 aFx;   // instance: curtain strength, line strength, seed
varying vec3 vInfo;
varying vec3 vFx;
varying float vU;
void main() {
  float sx = length(instanceMatrix[0].xyz);
  float sz = length(instanceMatrix[2].xyz);
  vec3 p = position;
  p.xz += aOut * ${CURTAIN_BAND.toFixed(2)} / vec2(sx, sz);
  vInfo = aInfo;
  vFx = aFx;
  vU = mix(p.x * sx, p.z * sz, aInfo.z);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
}`
/** How much of what is behind it a fragment of full golden light hides (see the end of the fragment shader). */
const CURTAIN_COVER = 0.75
const CURTAIN_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uGold, uCore;
varying vec3 vInfo;
varying vec3 vFx;
varying float vU;
float hash(float n) { return fract(sin(n * 127.1 + 3.7) * 43758.5453); }
void main() {
  // clamped: MSAA extrapolates varyings past the edge of a triangle, and pow() of a negative number is a black pixel
  float v = clamp(vInfo.y, 0.0, 1.0);
  vec3 col;
  float a;
  if (vInfo.x < 0.5) {
    // wall: a veil that thins out upward from a bright foot, with fine bright streaks running up it
    float cell = floor(vU * 16.0);
    float h = hash(cell + vFx.z * 17.0);
    float h2 = hash(cell * 1.7 + vFx.z * 5.0);
    float run = fract(v * (0.7 + h2) - uTime * (1.6 + 2.4 * h) + h * 7.0);
    float streak = step(0.6, h) * smoothstep(0.0, 0.3, run) * (1.0 - smoothstep(0.45, 1.0, run));
    float veil = pow(1.0 - v, 1.3);
    float foot = exp(-v * 7.0);
    a = vFx.x * (veil * 0.5 + foot * 0.5 + streak * (1.0 - v * v) * 0.4);
    col = mix(uGold, uCore, clamp(foot + veil * 0.15 + streak * 0.7, 0.0, 1.0));
  } else if (vInfo.x < 1.5) {
    // floor: the outline itself, a bright line 0.1 m wide that outlasts the curtain, in a soft halo
    float g = 1.0 - v;
    float line = 1.0 - smoothstep(0.07, 0.14, v);
    a = max(max(vFx.x, vFx.y) * line, max(vFx.x, vFx.y * 0.4) * g * g * 0.75);
    col = mix(uGold, uCore, max(line, g * g));
  } else {
    a = vFx.x * 0.4;
    col = uGold;
  }
  // premultiplied: the light partly covers what is behind it, so curtain behind curtain settles on a saturated
  // gold (colour / cover) instead of adding up to white
  gl_FragColor = vec4(col * a, a * ${CURTAIN_COVER.toFixed(2)});
  #include <colorspace_fragment>
}`

interface Glow {
  begin(): void
  /** Submit one curtain for this frame: footprint w x d metres centred on (x, z), turned by `rot`, `age` seconds old. */
  add(x: number, z: number, w: number, d: number, rot: number, height: number, age: number, seed: number): void
  commit(time: number): void
}

/** Curtain strength 0..1 and outline strength 0..1 at an age of the GLOW timeline. */
const glowCurtain = (a: number) => {
  const t = a - GLOW.start
  if (t <= 0) return 0
  if (t < GLOW.rise) return t / GLOW.rise
  if (t < GLOW.full) return 1
  return Math.max(0, 1 - (t - GLOW.full) / GLOW.fade)
}
const glowLine = (a: number) => (a < GLOW.start ? 0 : a < GLOW.lineEnd ? 1 : Math.max(0, 1 - (a - GLOW.lineEnd) / GLOW.lineFade))
/** Scale of the object that appears inside the glow: 0 until it pops, a small overshoot, then 1. */
const glowPop = (a: number) => {
  const u = (a - GLOW.pop) / GLOW.popTime
  return u <= 0 ? 0 : u >= 1 ? 1 : easeOutBack(u)
}

function createGlow(parent: THREE.Object3D, capacity: number): Glow {
  const pos: number[] = []
  const info: number[] = []
  const out: number[] = []
  const idx: number[] = []
  const vert = (x: number, y: number, z: number, kind: number, v: number, axis: number, ox = 0, oz = 0) => {
    pos.push(x, y, z)
    info.push(kind, v, axis)
    out.push(ox, oz)
    return pos.length / 3 - 1
  }
  const quad = (a: number, b: number, c: number, d: number) => idx.push(a, b, c, a, c, d)
  const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i]!
    const [bx, bz] = corners[(i + 1) % 4]!
    const axis = i % 2 // sides 0 and 2 run along x
    quad(vert(ax, 0, az, 0, 0, axis), vert(bx, 0, bz, 0, 0, axis), vert(bx, 1, bz, 0, 1, axis), vert(ax, 1, az, 0, 1, axis))
    for (const side of [1, -1]) {
      quad(vert(ax, 0, az, 1, 0, axis), vert(bx, 0, bz, 1, 0, axis), vert(bx, 0, bz, 1, 1, axis, Math.sign(bx) * side, Math.sign(bz) * side), vert(ax, 0, az, 1, 1, axis, Math.sign(ax) * side, Math.sign(az) * side))
    }
  }
  quad(vert(-0.5, 0, -0.5, 2, 0, 0), vert(0.5, 0, -0.5, 2, 0, 0), vert(0.5, 0, 0.5, 2, 0, 0), vert(-0.5, 0, 0.5, 2, 0, 0))
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 3))
  geo.setAttribute('aOut', new THREE.Float32BufferAttribute(out, 2))
  geo.setIndex(idx)
  const aFx = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
  aFx.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('aFx', aFx)
  // linear; the screen shows them divided by CURTAIN_COVER where curtains pile up (ad 51.2 s: #ffc832 body, #fff37b lines)
  const uniforms = { uTime: { value: 0 }, uGold: { value: new THREE.Color().setRGB(0.95, 0.47, 0.035) }, uCore: { value: new THREE.Color().setRGB(1.2, 0.85, 0.16) } }
  const mat = new THREE.ShaderMaterial({
    vertexShader: CURTAIN_VERT,
    fragmentShader: CURTAIN_FRAG,
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, capacity)
  mesh.frustumCulled = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.renderOrder = 9
  mesh.visible = false
  parent.add(mesh)
  const m = mesh.instanceMatrix.array as Float32Array
  const f = aFx.array as Float32Array
  let n = 0
  return {
    begin() {
      n = 0
    },
    add(x, z, w, d, rot, height, age, sd) {
      const k = glowCurtain(age)
      const line = glowLine(age)
      if (n >= capacity || (k <= 0 && line <= 0)) return
      const c = Math.cos(rot)
      const s = Math.sin(rot)
      const h = height * (0.45 + 0.55 * easeOutCubic((age - GLOW.start) / (GLOW.rise * 2)))
      const j = n * 16
      m[j] = c * w
      m[j + 1] = 0
      m[j + 2] = -s * w
      m[j + 3] = 0
      m[j + 4] = 0
      m[j + 5] = h
      m[j + 6] = 0
      m[j + 7] = 0
      m[j + 8] = s * d
      m[j + 9] = 0
      m[j + 10] = c * d
      m[j + 11] = 0
      m[j + 12] = x
      m[j + 13] = 0.05
      m[j + 14] = z
      m[j + 15] = 1
      f[n * 3] = k
      f[n * 3 + 1] = line
      f[n * 3 + 2] = sd
      n++
    },
    commit(time) {
      mesh.visible = n > 0
      if (n === 0) return
      mesh.count = n
      mesh.instanceMatrix.needsUpdate = true
      aFx.needsUpdate = true
      uniforms.uTime.value = time
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// unlock pillar (SPEC 9 row 18): a column of fiery golden light, drawn on one upright quad that turns to the camera

const PILLAR_W = 4.6
const PILLAR_H = 5.6
const PILLAR_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`
const PILLAR_FRAG = /* glsl */ `
uniform float uT, uSeed;
uniform vec3 uCore, uGold, uFringe;
varying vec2 vUv;
float hash(float n) { return fract(sin(n * 127.1 + 1.3) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i.x + i.y * 57.0), b = hash(i.x + 1.0 + i.y * 57.0), c = hash(i.x + (i.y + 1.0) * 57.0), d = hash(i.x + 1.0 + (i.y + 1.0) * 57.0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  float x = (vUv.x - 0.5) * 2.0;
  float y = vUv.y;
  float grow = 1.0 - pow(1.0 - clamp(uT / 0.12, 0.0, 1.0), 2.0);
  float life = clamp((uT - 0.18) / ${(PILLAR_TIME - 0.18).toFixed(2)}, 0.0, 1.0);
  float fade = pow(1.0 - life, 1.3);
  // a fat column at the peak that thins to a few streaks as it dies; its edge licks like a flame
  float width = mix(0.16, 0.5, fade) * (1.0 - 0.14 * y) * (0.86 + 0.28 * noise(vec2(y * 4.0 - uT * 9.0, uSeed + sign(x) * 3.0)));
  float top = max(grow, 0.01) * (0.8 + 0.2 * noise(vec2(x * 5.0 + uSeed * 3.0, uT * 10.0)));
  // the tip tapers like a flame instead of ending in a flat edge
  float ax = abs(x) / width * (1.0 + 1.1 * pow(clamp(y / top, 0.0, 1.0), 4.0));
  float column = 1.0 - smoothstep(0.86, 1.0, ax);
  float halo = exp(-max(ax - 0.85, 0.0) * 2.6);
  float shape = 1.0 - smoothstep(top * 0.5, top, y);
  float cell = floor((x + 1.0) * 30.0);
  float st = hash(cell + uSeed * 31.0);
  float streak = 0.6 + 0.8 * st * (0.5 + 0.5 * sin(y * (9.0 + 11.0 * st) - uT * (20.0 + 16.0 * st)));
  // red-orange rim, golden body, pale core: the colours stay saturated because the blue is held back
  vec3 col = mix(uGold, uFringe, smoothstep(0.5, 1.0, ax));
  col = mix(uCore, col, 1.0 - (1.0 - smoothstep(0.05, 0.45, ax)) * (0.25 + 0.4 * fade));
  float a = fade * shape * (column * streak + (1.0 - column) * halo * 0.4) * (1.0 - smoothstep(0.8, 1.0, abs(x)));
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`

interface Pillars {
  /** Start a pillar; `size` scales the column (1 = the 2.5 m x 6 m pillar of a character unlock). */
  fire(x: number, z: number, size: number): void
  /** True if a pillar was started within `window` seconds at about this place. */
  recent(x: number, z: number, window: number): boolean
  update(dt: number): void
}

function createPillars(parent: THREE.Object3D, camera: THREE.Camera): Pillars {
  const N = 4
  const geo = new THREE.PlaneGeometry(1, 1)
  geo.translate(0, 0.5, 0)
  const t = new Float32Array(N).fill(1e9)
  const meshes: THREE.Mesh[] = []
  const us: { uT: THREE.IUniform<number>; uSeed: THREE.IUniform<number> }[] = []
  // linear and above 1 where they should bloom
  const core = new THREE.Color().setRGB(1.2, 0.92, 0.26)
  const gold = new THREE.Color().setRGB(1.2, 0.56, 0.06)
  const fringe = new THREE.Color().setRGB(1.15, 0.22, 0.03)
  for (let i = 0; i < N; i++) {
    const uniforms = { uT: { value: 0 }, uSeed: { value: i * 1.7 }, uCore: { value: core }, uGold: { value: gold }, uFringe: { value: fringe } }
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: PILLAR_VERT, fragmentShader: PILLAR_FRAG, uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }))
    mesh.visible = false
    mesh.renderOrder = 12
    parent.add(mesh)
    meshes.push(mesh)
    us.push(uniforms)
  }
  return {
    fire(x, z, size) {
      let slot = 0
      for (let i = 1; i < N; i++) if (t[i]! > t[slot]!) slot = i
      t[slot] = 0
      const mesh = meshes[slot]!
      mesh.position.set(x, 0.02, z)
      mesh.scale.set(PILLAR_W * size, PILLAR_H * size, 1)
      us[slot]!.uSeed.value = rnd() * 40
    },
    recent(x, z, window) {
      for (let i = 0; i < N; i++) {
        const mesh = meshes[i]!
        if (t[i]! < window && Math.abs(mesh.position.x - x) < 0.6 && Math.abs(mesh.position.z - z) < 0.6) return true
      }
      return false
    },
    update(dt) {
      for (let i = 0; i < N; i++) {
        const mesh = meshes[i]!
        if (t[i]! >= PILLAR_TIME) {
          mesh.visible = false
          continue
        }
        us[i]!.uT.value = t[i]!
        mesh.visible = true
        mesh.rotation.y = Math.atan2(camera.position.x - mesh.position.x, camera.position.z - mesh.position.z)
        t[i]! += dt
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// bursts: the shared unlock effects, the healed burst, the pad sparkle

interface Bursts {
  /** Character unlock: sparks, light pillar, rising glyphs, flash (SPEC 9 row 18). */
  pillar(x: number, z: number, size?: number, peak?: number): void
  /** Object unlock: glowing rectangle with a golden curtain around a footprint (SPEC 9 row 19). */
  object(x: number, z: number, w: number, d: number, rot: number, height: number): void
  /** Streaks and sparkles rising from the outline of a glowing rectangle. */
  rectSparks(x: number, z: number, w: number, d: number, rot: number, n: number): void
  /** A few golden glints rising where somebody steps out of an object glow. */
  twinkle(x: number, z: number): void
  healed(x: number, z: number): void
  padPop(x: number, z: number): void
  padSparks(x: number, z: number): void
  update(dt: number): void
}

function createBursts(ctx: ViewCtx, parent: THREE.Object3D, flash: FlashLight, glow: Glow): Bursts {
  const fx = ctx.fx
  const pillars = createPillars(parent, ctx.camera)
  // object glows in progress: x, z, w, d, rot, height, age, seed
  const SLOTS = 4
  const obj = new Float32Array(SLOTS * 8)
  const lines: (BedOutlineDecal | null)[] = new Array(SLOTS).fill(null)
  const decals = new Map<string, BedOutlineDecal>()
  for (let i = 0; i < SLOTS; i++) obj[i * 8 + 6] = 1e9

  const glyphs = (x: number, y: number, z: number, n: number, spread: number, size: number) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rnd() * 1.5
      const q = part('arrowUp', x + Math.cos(a) * spread, y + (i / n) * 1.6 + rnd() * 0.3, z + Math.sin(a) * spread, 0.4 + rnd() * 0.12, size * (0.8 + rnd() * 0.4), 0xfff1c8)
      q.vy = 5.2
      q.drag = 3.4
      q.delay = 0.03 + rnd() * 0.17
      q.fadeIn = 0.15
      q.fadeOut = 0.72
      q.color1 = PAL.gold
      fx.spawn(q)
    }
  }
  const streaks = (x: number, y: number, z: number, n: number, spread: number, height: number, late: number) => {
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU
      const r = Math.sqrt(rnd()) * spread
      const q = part('streak', x + Math.cos(a) * r, y + rnd() * 1.2, z + Math.sin(a) * r, 0.26 + rnd() * 0.26, 0.16 + rnd() * 0.2, rnd() < 0.25 ? HOT : PAL.gold)
      q.stretch = height * (4 + rnd() * 9)
      q.vy = 4 + rnd() * 7
      q.delay = rnd() * late
      q.additive = true
      q.alpha = 0.85
      q.fadeIn = 0.2
      q.fadeOut = 0.4
      fx.spawn(q)
    }
  }
  const sparkles = (x: number, y: number, z: number, n: number, spread: number, rise: number, late: number) => {
    for (let i = 0; i < n; i++) {
      const q = part('spark', x + rs() * spread, y + rnd() * rise, z + rs() * spread, 0.3 + rnd() * 0.35, 0.22 + rnd() * 0.3, HOT)
      q.size1 = 0.02
      q.color1 = PAL.gold
      q.vy = 0.6 + rnd() * 1.6
      q.delay = rnd() * late
      q.spin = rs() * 5
      q.additive = true
      q.fadeOut = 0.5
      fx.spawn(q)
    }
  }

  const self: Bursts = {
    pillar(x, z, size = 1, peak = PILLAR_LIGHT) {
      if (pillars.recent(x, z, 0.3)) return
      pillars.fire(x, z, size)
      flash.fire(x, 1.8, z, peak, PILLAR_TIME, FIRELIGHT, PILLAR_LIGHT_RANGE)
      // one or two frames of pink and red sparks skidding off the pad
      for (let i = 0; i < 12; i++) {
        const a = rnd() * TAU
        const v = 5 + rnd() * 7
        const q = part('spark', x + Math.cos(a) * 0.4, 0.25 + rnd() * 0.5, z + Math.sin(a) * 0.4, 0.1 + rnd() * 0.1, 0.4 + rnd() * 0.3, i % 2 ? PAL.woundGlow : PAL.fire)
        q.vx = Math.cos(a) * v
        q.vz = Math.sin(a) * v
        q.vy = 1 + rnd() * 4
        q.size1 = 0.05
        q.additive = true
        fx.spawn(q)
      }
      // fiery bloom on the ground and in the air around the column, then the after-glow the characters stand in
      let q = part('dot', x, 0.06, z, PILLAR_TIME, 4 * size, EMBER)
      q.size1 = 7 * size
      q.flat = true
      q.additive = true
      q.alpha = 0.5
      q.fadeIn = 0.25
      q.fadeOut = 0.3
      fx.spawn(q)
      q = part('dot', x, 1.7 * size, z, 0.34, 4 * size, EMBER)
      q.size1 = 6 * size
      q.additive = true
      q.alpha = 0.26
      q.fadeIn = 0.3
      q.fadeOut = 0.35
      fx.spawn(q)
      q = part('puff', x, 1.3 * size, z, 0.4, 2.2 * size, PAL.fireBright)
      q.size1 = 3 * size
      q.delay = 0.22
      q.vy = 1.2
      q.additive = true
      q.alpha = 0.2
      q.fadeIn = 0.3
      q.fadeOut = 0.4
      fx.spawn(q)
      streaks(x, 0.3, z, 16, 1.1 * size, size, 0.34)
      sparkles(x, 0.4, z, 12, 1.3 * size, 3.5 * size, 0.4)
      glyphs(x, 2.2 * size, z, 4, 0.8 * size, 0.55)
    },
    object(x, z, w, d, rot, height) {
      let slot = 0
      for (let i = 1; i < SLOTS; i++) if (obj[i * 8 + 6]! > obj[slot * 8 + 6]!) slot = i
      const k = slot * 8
      obj[k] = x
      obj[k + 1] = z
      obj[k + 2] = w
      obj[k + 3] = d
      obj[k + 4] = rot
      obj[k + 5] = height
      obj[k + 6] = 0
      obj[k + 7] = rnd() * 9
      const key = `${w}x${d}`
      let line = decals.get(key)
      if (!line) {
        line = makeBedOutline(w, d)
        line.setOpacity(0)
        parent.add(line.root)
        decals.set(key, line)
      }
      lines[slot]?.setOpacity(0)
      lines[slot] = line
      line.root.position.set(x, 0, z)
      line.root.rotation.y = rot
      flash.fire(x, 1.6, z, GLOW_LIGHT, GLOW_END, PAL.gold, Math.max(GLOW_LIGHT_RANGE, w + d))
      self.rectSparks(x, z, w, d, rot, Math.round((w + d) * 3.2))
      glyphs(x, 1.6, z, 3, Math.min(w, d) * 0.3, 0.5)
    },
    rectSparks(x, z, w, d, rot, n) {
      const c = Math.cos(rot)
      const s = Math.sin(rot)
      for (let i = 0; i < n; i++) {
        // two in three ride up the curtain from a point on the outline (the side picked by its share of the
        // perimeter); the others are specks floating up inside the rectangle
        const streak = i % 3 !== 0
        const u = rnd() * (w + d)
        const lx = !streak ? rs() * 0.45 * w : u < w ? u - w / 2 : (rnd() < 0.5 ? -0.5 : 0.5) * w
        const lz = !streak ? rs() * 0.45 * d : u < w ? (rnd() < 0.5 ? -0.5 : 0.5) * d : u - w - d / 2
        const q = part(streak ? 'streak' : 'dot', x + lx * c + lz * s, 0.2 + rnd() * 0.9, z - lx * s + lz * c, 0.18 + rnd() * 0.12, streak ? 0.14 + rnd() * 0.16 : 0.06 + rnd() * 0.07, rnd() < 0.3 ? HOT : PAL.gold)
        q.stretch = streak ? 3 + rnd() * 6 : 1
        q.vy = streak ? 3.5 + rnd() * 5 : 1 + rnd() * 2.5
        q.delay = GLOW.start + rnd() * 0.14
        q.additive = true
        q.alpha = 0.9
        q.fadeIn = 0.2
        q.fadeOut = 0.4
        fx.spawn(q)
      }
    },
    twinkle(x, z) {
      streaks(x, 0.2, z, 3, 0.35, 0.5, GLOW.full)
      sparkles(x, 0.5, z, 5, 0.45, 1.6, GLOW.full)
    },
    healed(x, z) {
      flash.fire(x, 1.5, z, LIGHT.flashPeak * 0.35, 0.4, FIRELIGHT, 5)
      // a ball of orange-gold light around the patient
      let q = part('dot', x, 1.1, z, 0.36, 2.2, PAL.fireBright)
      q.size1 = 3.6
      q.color1 = EMBER
      q.additive = true
      q.alpha = 0.55
      q.fadeIn = 0.15
      q.fadeOut = 0.3
      fx.spawn(q)
      // thin gold rings one above the other, a cage round him that opens to 3 m and pales
      for (let i = 0; i < 3; i++) {
        q = part('ring', x, 0.35 + i * 0.7, z, 0.4, 1.9 - i * 0.2, i === 1 ? PAL.goldCore : PAL.gold)
        q.size1 = 3.2 - i * 0.3
        q.flat = true
        q.additive = true
        q.delay = i * 0.04
        q.color1 = 0xffffff
        q.alpha = 0.95
        q.fadeIn = 0.1
        q.fadeOut = 0.5
        fx.spawn(q)
      }
      streaks(x, 0.5, z, 12, 1.0, 0.55, 0.2)
      sparkles(x, 0.4, z, 12, 1.1, 1.6, 0.22)
      glyphs(x, 1.7, z, 3, 0.8, 0.4)
    },
    padPop(x, z) {
      let q = part('ring', x, 0.07, z, 0.22, 0.5, 0xffffff)
      q.size1 = 2.8
      q.flat = true
      q.alpha = 0.7
      q.fadeOut = 0.3
      fx.spawn(q)
      q = part('spark', x, 0.5, z, 0.2, 1.4, 0xffffff)
      q.size1 = 0.3
      q.additive = true
      q.spin = 6
      q.fadeOut = 0.3
      fx.spawn(q)
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + rnd() * 0.5
        q = part(i % 2 ? 'spark' : 'puff', x + Math.cos(a) * 0.5, 0.12 + (i % 2) * 0.3, z + Math.sin(a) * 0.5, 0.26 + rnd() * 0.2, i % 2 ? 0.3 : 0.4, i % 2 ? 0xffffff : PAL.dirtLit)
        q.vx = Math.cos(a) * (2 + rnd() * 2)
        q.vz = Math.sin(a) * (2 + rnd() * 2)
        q.vy = i % 2 ? 1.6 : 0.5
        q.drag = 5
        q.size1 = i % 2 ? 0.04 : 0.9
        q.alpha = i % 2 ? 1 : 0.4
        q.additive = i % 2 === 1
        fx.spawn(q)
      }
    },
    padSparks(x, z) {
      for (let i = 0; i < 10; i++) {
        const a = rnd() * TAU
        const v = 2 + rnd() * 4
        const q = part('spark', x + Math.cos(a) * 0.3, 0.15, z + Math.sin(a) * 0.3, 0.12 + rnd() * 0.1, 0.3 + rnd() * 0.25, i % 2 ? PAL.woundGlow : PAL.alertRed2)
        q.vx = Math.cos(a) * v
        q.vz = Math.sin(a) * v
        q.vy = 2 + rnd() * 3
        q.gravity = 12
        q.size1 = 0.04
        q.additive = true
        fx.spawn(q)
      }
    },
    update(dt) {
      for (let i = 0; i < SLOTS; i++) {
        const k = i * 8
        const age = obj[k + 6]!
        if (age >= GLOW_END) {
          const line = lines[i]
          if (line) {
            line.setOpacity(0)
            lines[i] = null
          }
          continue
        }
        glow.add(obj[k]!, obj[k + 1]!, obj[k + 2]!, obj[k + 3]!, obj[k + 4]!, obj[k + 5]!, age, obj[k + 7]!)
        lines[i]?.setOpacity(glowLine(age))
        obj[k + 6] = age + dt
      }
      pillars.update(dt)
    },
  }
  return self
}

// ---------------------------------------------------------------------------------------------------------------
// cauldron: model, lights, label, bubbles, pour / bath / cure effects

/** Bright green chunks that burst off the bathers and float on the potion (SPEC 9 row 13). */
const CHUNKS = 64
const CHUNK_GRAVITY = 14
/**
 * The sickness comes off in one burst early in the cure and is off the surface again before the batch leaps out
 * (ad: landing 13.57, thick in the air 13.8, afloat 14.0-14.2, a clean pot at 14.4): each bather sheds this many
 * chunks during this part of P.BATH_CURE.
 */
const SHED = { from: 0.26, to: 0.66, each: 14 } as const
/** Radius at which the actors view stands the bathers against the wall of the pot (small pot / big pot). */
const BATHER_RADIUS = [1.0, 1.36] as const
/** How far a landing flask whitens the surface: in the ad it stays cyan round the white plume (10.0-10.6 s). */
const POUR_FLASH = 0.26
/** Foam is the ad's mint white (#ecfdf3 at 10.0-10.4 s), just under the stage's bloom knee: a cloud, not a lamp. */
const FOAM_WHITE = 0xeafcf2
/** Direction (angle from +x toward +z) of the side of the pot that is farthest from the camera. */
const FAR_SIDE = Math.atan2(-P.CAMERA_OFFSET[2], -P.CAMERA_OFFSET[0])
const inPourRange = (x: number, z: number) => (x - L.CAULDRON.x) ** 2 + (z - L.CAULDRON.z) ** 2 <= P.DEPOSIT_RADIUS * P.DEPOSIT_RADIUS

function createPot(ctx: ViewCtx, parent: THREE.Object3D) {
  const { fx, stage } = ctx
  const model = makeCauldron()
  model.root.position.set(L.CAULDRON.x, 0, L.CAULDRON.z)
  const label = makeCapacityLabel()
  const potion = makeBubble('potion', POTION_BUBBLE_SIZE)
  const cure = makeBubble('cure')
  potion.setScale(0)
  cure.setScale(0)
  parent.add(model.root, label.root, potion.root, cure.root)
  stage.fireLight.position.set(L.CAULDRON.x, 0.2, L.CAULDRON.z)
  stage.fireLight.intensity = LIGHT.fire // the stage adds the flicker

  const chunks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.34, 0.6), lam(PAL.syringe, { emissive: PAL.uiGreen, emissiveIntensity: 0.45 }), CHUNKS)
  chunks.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  chunks.frustumCulled = false
  chunks.count = 0
  parent.add(chunks)
  stage.noOutline(chunks)
  // per chunk: x, y, z, vx, vy, vz, age, life, size, spin phase, spin rate, floating
  const C = 12
  const cd = new Float32Array(CHUNKS * C)
  let chunkN = 0
  const dummy = new THREE.Object3D()

  let big = false
  let growT = -1
  let potionK = 0
  let potionWait = 0
  let steam = 0
  let shed = 0

  /** Height of the potion surface (the bare floor of an empty pot) and its radius, in world metres. */
  const surfY = () => model.liquidY * model.root.scale.y
  const surfR = () => model.liquidRadius * model.root.scale.x

  /** One chunk bursting off a bather at (x, z): up and to all sides, a little more toward the middle of the pot. */
  const chunk = (x: number, y: number, z: number) => {
    if (chunkN >= CHUNKS) return
    const k = chunkN++ * C
    const a = rnd() * TAU
    const v = 0.3 + rnd() * 1.5
    const inward = 0.9 / Math.max(0.1, Math.hypot(L.CAULDRON.x - x, L.CAULDRON.z - z))
    cd[k] = x + rs() * 0.4
    cd[k + 1] = y
    cd[k + 2] = z + rs() * 0.4
    cd[k + 3] = Math.cos(a) * v + (L.CAULDRON.x - x) * inward
    cd[k + 4] = 3 + rnd() * 2.4
    cd[k + 5] = Math.sin(a) * v + (L.CAULDRON.z - z) * inward
    cd[k + 6] = 0
    cd[k + 7] = 0.4 + rnd() * 0.12
    cd[k + 8] = 0.13 + rnd() * 0.11
    cd[k + 9] = rnd() * TAU
    cd[k + 10] = 6 + rnd() * 10
    cd[k + 11] = 0
  }

  const stepChunks = (dt: number) => {
    if (chunkN === 0) {
      chunks.count = 0
      return
    }
    const top = surfY() + 0.03
    const reach = surfR() - 0.08
    for (let i = 0; i < chunkN; ) {
      const k = i * C
      cd[k + 6]! += dt
      if (cd[k + 6]! >= cd[k + 7]!) {
        chunkN--
        cd.copyWithin(k, chunkN * C, chunkN * C + C)
        continue
      }
      if (cd[k + 11] === 0) {
        cd[k + 4]! -= CHUNK_GRAVITY * dt
        cd[k]! += cd[k + 3]! * dt
        cd[k + 1]! += cd[k + 4]! * dt
        cd[k + 2]! += cd[k + 5]! * dt
        cd[k + 9]! += cd[k + 10]! * dt
        const inPot = Math.hypot(cd[k]! - L.CAULDRON.x, cd[k + 2]! - L.CAULDRON.z) < reach
        if (cd[k + 4]! < 0 && cd[k + 1]! <= (inPot ? top : 0.05)) {
          cd[k + 1] = inPot ? top : 0.05
          cd[k + 11] = inPot ? 1 : 2
        }
      } else if (cd[k + 11] === 1) {
        // afloat: drifts on with the last of its speed and rocks a little
        const slow = Math.max(0, 1 - 5 * dt)
        cd[k + 3]! *= slow
        cd[k + 5]! *= slow
        cd[k]! += cd[k + 3]! * dt
        cd[k + 2]! += cd[k + 5]! * dt
        cd[k + 1] = top
        cd[k + 9]! += dt * 1.5
      }
      const u = cd[k + 6]! / cd[k + 7]!
      const s = cd[k + 8]! * Math.min(1, cd[k + 6]! / 0.04) * (u > 0.62 ? 1 - (u - 0.62) / 0.38 : 1)
      const ph = cd[k + 9]!
      dummy.position.set(cd[k]!, cd[k + 1]!, cd[k + 2]!)
      if (cd[k + 11] === 0) dummy.rotation.set(ph, ph * 0.7 + i, ph * 1.3)
      else dummy.rotation.set(Math.sin(ph) * 0.15, i * 2.4, Math.cos(ph * 0.8) * 0.15)
      dummy.scale.setScalar(s)
      dummy.updateMatrix()
      chunks.setMatrixAt(i, dummy.matrix)
      i++
    }
    chunks.count = chunkN
    chunks.instanceMatrix.needsUpdate = true
  }

  /** A small cyan-white sparkle of the cure (SPEC 9 row 13). */
  const glint = (x: number, y: number, z: number, delay: number) => {
    const q = part('spark', x, y, z, 0.24 + rnd() * 0.2, 0.26, rnd() < 0.5 ? 0xffffff : PAL.bubbleHi)
    q.size1 = 0.03
    q.vy = 1 + rnd() * 1.5
    q.delay = delay
    q.spin = rs() * 5
    q.additive = true
    fx.spawn(q)
  }

  /** A puff of steam drifting up from the surface. */
  const wisp = (x: number, z: number, alpha: number) => {
    const q = part('puff', x, surfY() + 0.25, z, 1.1 + rnd() * 0.7, 0.55, PAL.foam)
    q.size1 = 1.5
    q.vx = 0.15 + rs() * 0.2
    q.vz = -0.1 + rs() * 0.2
    q.vy = 0.7 + rnd() * 0.5
    q.alpha = alpha
    q.fadeIn = 0.25
    q.fadeOut = 0.4
    q.rot = rnd() * TAU
    q.spin = rs() * 0.6
    fx.spawn(q)
  }

  /** One short fleck of potion thrown off a splash (out = unit vector on the ground, speed in m/s). */
  const fleck = (x: number, y: number, z: number, outX: number, outZ: number, length: number, speed: number, delay: number) => {
    const w = 0.16 + rnd() * 0.1
    const q = part('streak', x, y + length * 0.3, z, 0.16 + rnd() * 0.12, w, rnd() < 0.5 ? 0xffffff : PAL.bubbleHi)
    q.stretch = length / w
    q.rot = -0.9 * (outX * SCREEN_RIGHT.x + outZ * SCREEN_RIGHT.z) + rs() * 0.15
    q.vx = outX * speed
    q.vz = outZ * speed
    q.vy = 2.5 + rnd() * 3
    q.gravity = 9
    q.delay = delay
    q.color1 = PAL.potion
    q.alpha = 0.95
    q.fadeIn = 0.1
    q.fadeOut = 0.5
    fx.spawn(q)
  }

  /**
   * Foam thrown up where something drops into the pot: a torn white mound (spiky sprites turned at random give the
   * ragged outline, soft lumps fill its middle), flecks, droplets. `k` scales it (1 = a flask).
   */
  const plume = (x: number, z: number, k: number) => {
    const y = surfY()
    const r = Math.max(0.5, surfR())
    for (let i = 0; i < 5; i++) {
      const torn = i < 3
      const q = part(torn ? 'splash' : 'puff', x + rs() * 0.36 * k, y + (0.25 + rnd() * 0.35) * k, z + rs() * 0.36 * k, 0.2 + rnd() * 0.04, (torn ? 0.75 + rnd() * 0.35 : 1.0) * k, FOAM_WHITE)
      q.size1 = (torn ? 1.45 + rnd() * 0.55 : 1.5) * k
      q.color1 = PAL.foam
      q.vx = rs() * 0.6
      q.vz = rs() * 0.6
      q.vy = (1.2 + rnd() * 2) * k
      q.drag = 3
      q.alpha = torn ? 0.92 : 0.8
      q.fadeIn = 0.12
      q.fadeOut = 0.55
      q.rot = rnd() * TAU
      q.spin = rs() * 1.2
      fx.spawn(q)
    }
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + rnd() * 0.8
      const d = (0.3 + rnd() * 0.45) * k
      fleck(x + Math.cos(a) * d, y + 0.15, z + Math.sin(a) * d, Math.cos(a), Math.sin(a), (0.25 + rnd() * 0.35) * k, 1.5 + rnd() * 2.5, rnd() * 0.06)
    }
    for (let i = 0; i < 6; i++) {
      const a = rnd() * TAU
      const v = 0.8 + rnd() * 2.4
      const q = part('dot', x + Math.cos(a) * 0.2, y + 0.25, z + Math.sin(a) * 0.2, 0.42 + rnd() * 0.25, 0.06 + rnd() * 0.06, 0xffffff)
      q.color1 = PAL.potion
      q.vx = Math.cos(a) * v
      q.vz = Math.sin(a) * v
      q.vy = (3.6 + rnd() * 3.6) * Math.sqrt(k)
      q.gravity = 16
      q.fadeOut = 0.75
      fx.spawn(q)
    }
    // the surface keeps spitting short flecks for half a second, most of them along its far edge, with a wisp and a glint
    for (let i = 0; i < 6; i++) {
      const a = i < 4 ? FAR_SIDE + rs() * 2.2 : rnd() * TAU
      const d = i < 4 ? r * 0.9 : Math.sqrt(rnd()) * r * 0.7
      fleck(L.CAULDRON.x + Math.cos(a) * d, y, L.CAULDRON.z + Math.sin(a) * d, Math.cos(a), Math.sin(a), 0.22 + rnd() * 0.3, 0.4, 0.1 + rnd() * 0.45)
    }
    const a = rnd() * TAU
    const q = part('spark', L.CAULDRON.x + Math.cos(a) * r * rnd(), y + 0.3 + rnd() * 0.9, L.CAULDRON.z + Math.sin(a) * r * rnd(), 0.35 + rnd() * 0.3, 0.2, 0xffffff)
    q.size1 = 0.03
    q.color1 = PAL.bubbleHi
    q.delay = 0.15 + rnd() * 0.4
    q.vy = 0.8
    q.spin = rs() * 4
    q.additive = true
    fx.spawn(q)
    wisp(x + rs() * 0.5, z + rs() * 0.5, 0.22)
  }

  /** Where the i-th bather of the batch stands in the pot. */
  const seat = { x: 0, z: 0 }
  const bather = (i: number) => {
    const def = L.BATH_SEATS[i % L.BATH_SEATS.length]!
    const k = BATHER_RADIUS[big ? 1 : 0] / Math.hypot(def.x, def.z)
    seat.x = L.CAULDRON.x + def.x * k
    seat.z = L.CAULDRON.z + def.z * k
    return seat
  }

  /** SPEC 2.6: shown while the pot is short, nobody is pouring and (the doctor carries nothing or the pot is empty). */
  const wantsPotion = (s: GameState) => {
    const c = s.cauldron
    if (s.won || c.bath !== 'empty' || c.potion >= c.slots || c.incoming.length > 0) return false
    const p = s.player
    if (p.flasks > 0 && (c.potion > 0 || inPourRange(p.x, p.z))) return false
    if (s.porter.present && s.porter.flasks > 0 && inPourRange(s.porter.x, s.porter.z)) return false
    if (s.crowd.remaining > 0) return true
    for (let i = 0; i < s.villagers.length; i++) {
      const st = s.villagers[i]!.state
      if (st === 'toQueue' || st === 'queued') return true
    }
    return false
  }

  return {
    update(s: GameState, dt: number, time: number, first: boolean) {
      const c = s.cauldron
      // --- model ---
      if (s.unlocks.bigCauldron !== big) {
        big = s.unlocks.bigCauldron
        model.setBig(big)
      }
      if (growT >= 0 && big) {
        // the model is already at its new size: inside the unlock glow, play the step up from the old size,
        // swelling past the new one and settling (the height leads the girth a little)
        growT += dt
        const u = clamp01((growT - GLOW.pop) / BIG_GROW)
        const from = P.CAULDRON_RIM_HEIGHT / model.rimY
        const g = lerp(from, 1, easeOutBack(u))
        model.root.scale.set(g, lerp(from, 1, easeOutBack(Math.min(1, u * 1.35))) * (1 + 0.1 * Math.sin(Math.PI * u)), g)
        if (u >= 1) growT = -1
      } else model.root.scale.setScalar(1)
      model.setPotion(c.potion, c.capacity, first)
      const hot = clamp01(1 - c.sinceFill / 0.25)
      model.flash(hot * POUR_FLASH)
      model.update(dt, time)
      const y = surfY()
      stage.potionLight.position.set(L.CAULDRON.x, y + 0.3, L.CAULDRON.z)
      stage.potionLight.intensity = LIGHT.potionFull * model.fill * (1 + 0.7 * hot)

      // --- label (SPEC 2.6: full from the landing until the batch leaps out, never a partial count on the way in) ---
      const inPot = c.bath === 'curing' || c.bath === 'check' || (c.bath === 'hopOut' && c.t < 0.07)
      label.set(inPot ? c.bathers.length : 0, c.slots)

      // --- bubbles ---
      const lift = model.rimY * model.root.scale.y - P.CAULDRON_RIM_HEIGHT
      const want = wantsPotion(s)
      potionWait = want ? potionWait + dt : 0
      const show = want && (first || potionK > 0 || potionWait >= POTION_DWELL)
      potionK = first ? (show ? 1 : 0) : fade(potionK, show, dt, POP_IN, POP_OUT)
      potion.root.position.set(L.CAULDRON.x + POTION_BUBBLE.x, POTION_BUBBLE.y + lift, L.CAULDRON.z + POTION_BUBBLE.z)
      potion.setScale(show ? popIn(potionK) : potionK * potionK)
      potion.update(time)

      // the cure bubble is a pure function of the bath state: in as the batch leaps, pie while curing, check, out
      let cureScale = 0
      if (c.bath === 'hopIn') cureScale = popIn(c.t / 0.15)
      else if (c.bath === 'curing') cureScale = 1
      else if (c.bath === 'check') cureScale = clamp01((P.BATH_CHECK - c.t) / POP_OUT)
      cure.root.position.set(L.CAULDRON.x + CURE_BUBBLE.x, CURE_BUBBLE.y + lift, L.CAULDRON.z + CURE_BUBBLE.z)
      cure.setCheck(c.bath === 'check')
      cure.setProgress(c.bath === 'curing' ? c.t / P.BATH_CURE : 0)
      cure.setScale(cureScale)

      // --- ambient effects ---
      if (model.fill > 0.01) {
        // faint steam off the surface, thicker for a moment after a pour
        steam += dt * (1.2 + 2.2 * model.fill + (c.sinceFill < 1 ? 5 : 0))
        while (steam >= 1) {
          steam -= 1
          const a = rnd() * TAU
          const r = Math.sqrt(rnd()) * surfR() * 0.8
          wisp(L.CAULDRON.x + Math.cos(a) * r, L.CAULDRON.z + Math.sin(a) * r, c.sinceFill < 1 ? 0.2 : 0.11)
        }
      }
      const cureK = c.bath === 'curing' ? c.t / P.BATH_CURE : 0
      if (cureK > SHED.from && cureK < SHED.to) {
        shed += (dt * SHED.each * c.bathers.length) / ((SHED.to - SHED.from) * P.BATH_CURE)
        while (shed >= 1) {
          shed -= 1
          const at = bather(Math.floor(rnd() * c.bathers.length))
          chunk(at.x, y + 0.1 + rnd() * 0.7, at.z)
          if (rnd() < 0.4) glint(at.x + rs() * 0.5, y + 0.5 + rnd() * 1.1, at.z + rs() * 0.5, rnd() * 0.1)
        }
      }
      stepChunks(dt)
    },
    /** The big cauldron was just bought: the pot grows inside its unlock glow instead of jumping to the new size. */
    grow() {
      growT = 0
    },
    /** A flask landed in the pot. */
    pour() {
      const x = L.CAULDRON.x + rs() * 0.35
      const z = L.CAULDRON.z + rs() * 0.35
      plume(x, z, 1)
      const q = part('dot', x, surfY() + 0.7, z, 0.2, 1.4, PAL.potion)
      q.size1 = 2.2
      q.additive = true
      q.alpha = 0.12
      q.fadeOut = 0.3
      fx.spawn(q)
    },
    /** The batch landed in the potion: foam around every bather and a ripple running out from him. */
    splash(count: number) {
      const y = surfY()
      for (let i = 0; i < count; i++) {
        const at = bather(i)
        plume(at.x, at.z, 0.8)
        const q = part('ring', at.x, y + 0.03, at.z, 0.32, 0.6, 0xffffff)
        q.size1 = 1.7
        q.flat = true
        q.alpha = 0.75
        q.fadeOut = 0.3
        fx.spawn(q)
      }
    },
    /** The pie is complete: a few last glints over the clean bathers (the chunks came off during the cure). */
    cured(count: number) {
      const y = surfY()
      for (let i = 0; i < count; i++) {
        const at = bather(i)
        for (let j = 0; j < 4; j++) glint(at.x + rs() * 0.5, y + 0.6 + rnd() * 1.0, at.z + rs() * 0.5, rnd() * 0.12)
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// ward: beds, side table, the glow of newly built beds, bedside bubbles

function createWard(parent: THREE.Object3D, glow: Glow, bursts: Bursts) {
  const beds = BEDS.map(def => {
    const bed = makeBed()
    bed.root.position.set(def.x, 0, def.z)
    bed.root.visible = false
    const line = makeBedOutline()
    line.root.position.set(def.x, 0, def.z)
    line.setOpacity(0)
    const need = makeBubble('nurse', NURSE_BUBBLE_SIZE)
    const cure = makeBubble('cure', BED_CURE_SIZE)
    for (const b of [need, cure]) {
      b.root.position.set(def.x + BED_BUBBLE.x, BED_BUBBLE.y, def.z)
      b.setScale(0)
    }
    parent.add(bed.root, line.root, need.root, cure.root)
    return { bed, line, need, cure }
  })
  const table = makeSideTable()
  table.root.position.set(L.SIDE_TABLE.x, 0, L.SIDE_TABLE.z)
  parent.add(table.root)
  const needK = new Float32Array(BEDS.length)
  const lit = new Uint8Array(BEDS.length)
  const firstNew = BEDS.findIndex(def => def.ward === 2)
  const delay = BEDS.map((def, i) => (def.ward === 2 ? (i - firstNew) * BED_STAGGER : 0))
  const lineW = P.BED_W * 1.3
  const lineD = P.BED_D * 1.3

  const nurseOf = (s: GameState, bed: number): Nurse | null => {
    for (let i = 0; i < s.nurses.length; i++) if (s.nurses[i]!.bed === bed) return s.nurses[i]!
    return null
  }
  /**
   * SPEC 2.10: the bubble pops NEEDS_NURSE_DELAY after a patient lay down in a bed without a nurse and stays until
   * his treatment shows the plus. A nurse who was already there when he lay down shows no bubble while she waits.
   */
  const needsNurse = (s: GameState, b: Bed) => {
    if (b.state !== 'occupied' || b.lieT < P.NEEDS_NURSE_DELAY || b.treatT >= TREAT_PLUS) return false
    const n = nurseOf(s, b.id)
    return !n || n.age < b.lieT - P.NEEDS_NURSE_DELAY
  }
  const cureScale = (b: Bed) => {
    const t = b.treatT
    if (b.state !== 'occupied' || t < TREAT_PLUS) return 0
    if (t < P.TREAT_BUBBLE_OUT) return popIn((t - TREAT_PLUS) / POP_IN)
    return clamp01(1 - (t - P.TREAT_BUBBLE_OUT) / TREAT_OUT_TIME)
  }

  return {
    update(s: GameState, dt: number, time: number, first: boolean) {
      for (let i = 0; i < beds.length; i++) {
        const b = s.beds[i]!
        const def = BEDS[i]!
        const v = beds[i]!
        // --- the bed itself: pops in inside its glow when the ward is built ---
        const age = b.exists ? b.age - delay[i]! : -1
        const pop = !b.exists ? 0 : glowPop(age)
        v.bed.root.visible = pop > 0
        if (pop > 0) v.bed.root.scale.set(pop, pop * (1 + 0.35 * (1 - Math.min(1, pop))), pop)
        if (b.exists && age < GLOW_END) {
          glow.add(def.x, def.z, lineW, lineD, 0, 2.7, age, i * 1.37)
          v.line.setOpacity(glowLine(age))
          if (!lit[i] && age >= GLOW.start && age < GLOW.full) {
            lit[i] = 1
            bursts.rectSparks(def.x, def.z, lineW, lineD, 0, 20)
          }
        } else {
          v.line.setOpacity(0)
          lit[i] = 0
        }

        // --- bubbles over the bed head ---
        const need = needsNurse(s, b)
        needK[i] = first ? (need ? 1 : 0) : fade(needK[i]!, need, dt, POP_IN, 0.07)
        v.need.setScale(need ? popIn(needK[i]!) : needK[i]! * needK[i]!)
        if (needK[i]! > 0) v.need.update(time)
        v.cure.setCheck(b.treatT >= P.TREATMENT_TIME)
        v.cure.setProgress((b.treatT - P.TREAT_PIE_START) / TREAT_PIE_TIME)
        v.cure.setScale(cureScale(b))
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// price pads

function createPads(parent: THREE.Object3D) {
  const pads = UNLOCKS.map(def => {
    const pad = makePricePad(def)
    pad.setPop(0)
    parent.add(pad.root)
    return pad
  })
  // how much of each pad is on the floor: follows the state, and runs down by itself once the pad is gone
  const shown = new Float32Array(pads.length)
  return {
    update(s: GameState, dt: number) {
      for (let i = 0; i < pads.length; i++) {
        const p = s.pads[i]!
        const pad = pads[i]!
        if (p.state === 'hidden') shown[i] = 0
        else if (p.state === 'popIn') shown[i] = clamp01(p.t / P.PAD_POP_TIME)
        else if (p.state === 'gone') shown[i] = Math.max(0, shown[i]! - dt / PAD_OUT)
        else shown[i] = 1
        pad.setPop(shown[i]!)
        if (shown[i]! > 0) pad.setFill(p.state === 'done' || p.state === 'gone' ? 1 : padFill(p.paid / p.price))
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// guide arrow

function createGuide(parent: THREE.Object3D) {
  const arrow = makeArrow()
  arrow.setScale(0)
  parent.add(arrow.root)
  const from = new THREE.Vector3()
  const to = new THREE.Vector3()
  const pos = arrow.root.position
  let k = 0
  let fly = 1
  return {
    update(s: GameState, dt: number, time: number, first: boolean) {
      const g = s.guide
      const want = g.kind !== 'none'
      if (want && (first || k <= 0)) {
        // nothing on screen: appear right over the target
        to.set(g.x, g.y, g.z)
        pos.copy(to)
        fly = 1
      } else if (want && (g.x !== to.x || g.y !== to.y || g.z !== to.z)) {
        from.copy(pos)
        to.set(g.x, g.y, g.z)
        fly = 0
      }
      k = first ? (want ? 1 : 0) : fade(k, want, dt, POP_IN, POP_OUT + 0.03)
      if (fly < 1) {
        // fly over in an arc that is higher the farther the new target is
        fly = Math.min(1, fly + dt / ARROW_FLY)
        const u = easeInOutQuad(fly)
        pos.lerpVectors(from, to, u)
        pos.y += Math.sin(Math.PI * u) * Math.min(2.2, 0.6 + from.distanceTo(to) * 0.18)
      }
      arrow.update(time)
      arrow.setScale(want ? popIn(k) : k * k)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// win celebration (SPEC 3.4): light pillars over the courtyard, fireworks, confetti. Started by the event only.

function createParty(ctx: ViewCtx, bursts: Bursts) {
  const { fx, camera } = ctx
  const dir = new THREE.Vector3()
  const look = new THREE.Vector3()
  let t = -1
  let shell = 0
  let confetti = 0

  const firework = (x: number, y: number, z: number, loud: number) => {
    const color = pick(FESTIVE)
    let q = part('dot', x, y, z, 0.22, 1.4, 0xffffff)
    q.size1 = 4.2
    q.additive = true
    q.alpha = 0.7 * loud
    q.fadeOut = 0.2
    fx.spawn(q)
    for (let i = 0; i < 36; i++) {
      // even directions on a sphere, jittered
      const cy = 1 - (2 * (i + 0.5)) / 36
      const sy = Math.sqrt(1 - cy * cy)
      const a = i * 2.39996 + rnd()
      const v = 6 + rnd() * 3
      q = part(i % 3 ? 'spark' : 'star', x, y, z, 0.8 + rnd() * 0.5, 0.55, i % 5 === 0 ? 0xffffff : color)
      q.size1 = 0.05
      q.vx = Math.cos(a) * sy * v
      q.vy = cy * v + 1.5
      q.vz = Math.sin(a) * sy * v
      q.drag = 2.6
      q.gravity = 4.5
      q.spin = rs() * 6
      q.additive = true
      q.alpha = loud
      q.fadeOut = 0.55
      fx.spawn(q)
    }
  }

  return {
    start() {
      t = 0
      shell = 0.15
      confetti = 0
    },
    update(dt: number) {
      if (t < 0) return
      const t0 = t
      t += dt
      // the pillars wait for the camera, which is on its way to the courtyard
      for (let i = 0; i < WIN_PILLARS.length; i++) {
        const at = WIN_PILLAR_START + i * 0.25
        if (t0 <= at && t > at) bursts.pillar(L.CAULDRON.x + WIN_PILLARS[i]!.x, L.CAULDRON.z + WIN_PILLARS[i]!.z, 1.25)
      }
      // everything else happens where the camera looks: fireworks above the upper half of the picture, confetti all over
      camera.getWorldDirection(dir)
      look.copy(camera.position).addScaledVector(dir, -camera.position.y / dir.y)
      // loud while the screen is free, quieter once the win card is up
      const loud = t < WIN_CARD ? 1 : 0.6
      shell -= dt
      if (shell <= 0 && t < 10) {
        shell = t < WIN_CARD ? 0.16 + rnd() * 0.2 : 0.5 + rnd() * 0.6
        const up = 1 + rnd() * 7
        const side = rs() * 5.5
        firework(look.x + SCREEN_UP.x * up + SCREEN_RIGHT.x * side, 3.5 + rnd() * 4, look.z + SCREEN_UP.z * up + SCREEN_RIGHT.z * side, loud)
      }
      confetti += dt * (t < WIN_CARD ? 80 : t < 10 ? 30 : 0)
      while (confetti >= 1) {
        confetti -= 1
        const q = part(rnd() < 0.5 ? 'star' : 'dot', look.x + rs() * 11, 9 + rnd() * 4, look.z + rs() * 11, 2.8 + rnd() * 1.2, 0.22 + rnd() * 0.18, pick(FESTIVE))
        q.vx = rs() * 1.2
        q.vz = rs() * 1.2
        q.vy = -2.2 - rnd() * 2.2
        q.gravity = 0.8
        q.spin = rs() * 7
        q.rot = rnd() * TAU
        q.alpha = 0.95
        q.fadeIn = 0.05
        q.fadeOut = 0.85
        q.floor = true
        fx.spawn(q)
      }
      if (t > 14) t = -1
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------

export function createStationsView(ctx: ViewCtx): ViewModule {
  const root = new THREE.Group()
  root.name = 'stations'
  ctx.scene.add(root)
  const flash = createFlash(ctx.stage)
  const glow = createGlow(root, BEDS.length + 4)
  const bursts = createBursts(ctx, root, flash, glow)
  const pot = createPot(ctx, root)
  const ward = createWard(root, glow, bursts)
  const pads = createPads(root)
  const guide = createGuide(root)
  const party = createParty(ctx, bursts)
  let first = true

  const unlocked = (id: UnlockId, x: number, z: number, s: GameState) => {
    switch (id) {
      case 'nurses':
      case 'usher':
      case 'porter':
      case 'driver':
        bursts.pillar(x, z) // they step out of the light at their pad
        break
      case 'ward2':
        flash.fire(WARD2_CENTRE.x, 3, WARD2_CENTRE.z, LIGHT.flashPeak * 0.18, GLOW_END + 0.1, PAL.gold, 13) // the beds glow by their age
        break
      case 'bursar':
        bursts.object(L.BURSAR_CHEST.x, L.BURSAR_CHEST.z, CHEST_RECT.w, CHEST_RECT.d, 0, 1.8)
        break
      case 'bigCauldron':
        bursts.object(L.CAULDRON.x, L.CAULDRON.z, POT_RECT, POT_RECT, 0, 3.6)
        pot.grow()
        break
      case 'drill2':
        // drillView frames the drill itself; the light around it comes from here, as for every unlock
        flash.fire(s.drill.x, 1.6, s.drill.z, GLOW_LIGHT, GLOW_END, PAL.gold, GLOW_LIGHT_RANGE)
        break
      case 'cart':
        break // lit where the cart appears: see 'toolSwap'
    }
  }

  return {
    update(s, frameDt, time) {
      // the very first frame of a page can report a negative frame time
      const dt = Math.max(0, frameDt)
      glow.begin()
      pot.update(s, dt, time, first)
      ward.update(s, dt, time, first)
      pads.update(s, dt)
      guide.update(s, dt, time, first)
      bursts.update(dt)
      party.update(dt)
      glow.commit(time)
      flash.update(dt)
      first = false
    },
    onEvent(e: GameEvent, s) {
      switch (e.type) {
        case 'flaskLand':
          pot.pour()
          break
        case 'bathSplash':
          pot.splash(e.count)
          break
        case 'bathCured':
          pot.cured(e.count)
          break
        case 'healed':
          bursts.healed(e.x, e.z)
          break
        case 'padPop':
          bursts.padPop(e.x, e.z)
          break
        case 'padPaid':
          bursts.padSparks(e.x, e.z)
          break
        case 'unlock':
          unlocked(e.id, e.x, e.z, s)
          break
        case 'toolSwap':
          // riverView draws the glow of a new tool from its age; the light it casts around is the shared flash
          flash.fire(e.x, 1.6, e.z, GLOW_LIGHT, GLOW_END, PAL.gold, GLOW_LIGHT_RANGE)
          break
        case 'nursesSpawn':
          // ward 1: they step out of the pillar at their pad (one pillar, however the two events arrive);
          // ward 2: each appears at her post beside a glowing bed
          if (e.ward === 1) bursts.pillar(e.x, e.z)
          else for (const def of BEDS) if (def.ward === 2) bursts.twinkle(def.x + L.NURSE_POST.x, def.z + L.NURSE_POST.z)
          break
        case 'win':
          party.start()
          break
      }
    },
  }
}
