// Icon bubbles (SPEC 8.3): camera-facing white circles with a small tail at the bottom.
//
//   const b = makeBubble('cure')          // 'potion' | 'cure' | 'nurse' | 'sick' | 'scared' | 'happy'
//   scene.add(b.root)                     // or parent it to the thing it belongs to
//   b.root.position.set(x, y, z)          // the point the TAIL TIP points at (not the circle centre)
//   b.setScale(s)                         // 0 hidden .. 1 full (.. 1.1 overshoot) for pop in / out
//   b.setProgress(p); b.setCheck()        // 'cure' only: green clockwise pie, then the check mark
//   b.update(t)                           // every frame while visible: wobbles the red "!" tick
//
// A bubble is a billboard drawn by its own small shader: it always faces the screen, keeps its size in metres
// regardless of the scale / rotation of its parents, and is depth-tested as if it were BUBBLE_DEPTH_BIAS metres
// closer to the camera, so the thing it floats over (cauldron rim, bed head, syringe, neighbours in the queue) never
// cuts into it while walls or props well in front of it still hide it. Bubbles do not write depth and sort among
// themselves back to front. One bubble = 1 draw call (2 with the red tick); all bubbles of a kind share textures.
import * as THREE from 'three'
import { PAL, hex } from '../config'
import { lam, mesh, type GalleryItem } from '../view/materials'
import { UI_GLSL, UI_MATERIAL, iconCanvas, uiGlslOut, uiTexture, type IconName } from './icons'

export type BubbleKind = 'potion' | 'cure' | 'nurse' | 'sick' | 'scared' | 'happy'

/**
 * Circle diameter in metres per kind, measured in the ad from the bubble's width on screen, the doctor's 1.6 m ring
 * in the same shot and the bubble's height above the floor (8.6 s, 17.6 s, 45.8 s, 2.2 s, 39.2 s, 12.6 s). SPEC 8.3
 * rounds these up to 1.2 m (stations) and 0.9 m (characters); the sick emoji, shown over a whole queue at once, is
 * really the smallest. The 'cure' bubble over a BED is smaller than the cauldron's in the ad: pass 0.9 there.
 */
export const BUBBLE_DIAMETER: Record<BubbleKind, number> = { potion: 1.1, cure: 1.05, nurse: 0.9, sick: 0.75, scared: 1.0, happy: 1.0 }
/** Height of the circle centre above the tail tip (= root origin), as a fraction of the diameter. */
export const BUBBLE_CENTER_ABOVE_TIP = 0.635
/** Metres a bubble is pulled toward the camera for the depth test (see the header comment). */
export const BUBBLE_DEPTH_BIAS = 2.5

/** Linear cap of the bubble shader: a little brighter than ground decals (bubbles are the brightest white on screen). */
const BUBBLE_WHITE = 0.9

// Geometry of a bubble in units of the circle radius, origin at the tail tip, y up.
const CY = BUBBLE_CENTER_ABOVE_TIP * 2 // circle centre
const X0 = -1.3
const X1 = 1.3
const Y0 = -0.26
const Y1 = CY + 1.3
const PX = 128 // canvas pixels per radius

const VERT = /* glsl */ `
uniform float uSize, uScale, uRot, uBias;
uniform vec2 uPivot;
varying vec2 vUv;
varying vec2 vQ;
void main() {
  vUv = uv;
  vec2 q = position.xy;
  vQ = q - vec2(0.0, ${CY.toFixed(4)});
  vec2 d = q - uPivot;
  float c = cos(uRot), s = sin(uRot);
  q = uPivot + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += q * (uSize * uScale);
  gl_Position = projectionMatrix * mv;
  // depth as if uBias metres closer, never in front of the near plane (a bubble right at the camera stays visible)
  vec4 near = projectionMatrix * vec4(mv.xy, min(mv.z + uBias, -0.01), 1.0);
  gl_Position.z = max(near.z / near.w, -0.999) * gl_Position.w;
}
`
const FRAG = /* glsl */ `
uniform sampler2D map;
uniform sampler2D map2;
uniform float uProgress, uOpacity;
varying vec2 vUv;
varying vec2 vQ;
${UI_GLSL}
void main() {
  vec4 col = uiTexel(map, vUv);
#ifdef PIE
  if (uProgress > 0.0) {
    // clockwise pie from 12 o'clock: map2 replaces map inside the swept wedge
    float th = min(uProgress, 1.0) * 6.28318530718;
    float px = max(fwidth(vQ.x), 1e-5);
    float h1 = clamp(vQ.x / px + 0.5, 0.0, 1.0);
    float h2 = clamp(dot(vQ, vec2(-cos(th), sin(th))) / px + 0.5, 0.0, 1.0);
    float m = uProgress >= 1.0 ? 1.0 : (uProgress < 0.5 ? min(h1, h2) : max(h1, h2));
    col = mix(col, uiTexel(map2, vUv), m);
  }
#endif
  gl_FragColor = vec4(col.rgb, col.a * uOpacity);
  ${uiGlslOut(BUBBLE_WHITE)}
}
`

// --- textures -------------------------------------------------------------------------------------------------

type Ctx = CanvasRenderingContext2D

/** Circle of radius r around the origin with a tail whose tip is at (0, r * CY) (canvas y is down). */
function bubblePath(c: Ctx, r: number): void {
  const half = 0.27 * r
  const tip = CY * r
  const a = Math.asin(half / r)
  c.beginPath()
  c.arc(0, 0, r, Math.PI / 2 + a, Math.PI / 2 - a + Math.PI * 2)
  c.lineTo(0.05 * r, tip - 0.04 * r)
  c.quadraticCurveTo(0, tip + 0.012 * r, -0.05 * r, tip - 0.04 * r)
  c.closePath()
}

interface Skin {
  /** Outline colour and thickness (radius units); glow = soft halo of the outline colour. */
  edge: string
  edgeW: number
  glow?: string
  /** Fill of the bubble body (the ring around the disc). */
  body: [string, string]
  /** Optional inner disc: radius and colour. */
  disc?: [number, string]
  icon: IconName
  iconSize: number
  iconDy?: number
}

const CREAM: [string, string] = ['#fff6ea', hex(PAL.cream)]
const WHITE: [string, string] = ['#ffffff', '#f3f1ee']
const SKINS = {
  potion: { edge: hex(PAL.alertRed), edgeW: 0.055, glow: hex(PAL.alertRed2), body: CREAM, disc: [0.81, hex(PAL.terracotta)], icon: 'flask', iconSize: 1.5, iconDy: 0.03 },
  nurse: { edge: hex(PAL.alertRed), edgeW: 0.095, glow: hex(PAL.alertRed2), body: CREAM, icon: 'nurseBust', iconSize: 1.58, iconDy: 0.05 },
  sick: { edge: '#22232a', edgeW: 0.05, body: WHITE, icon: 'sick', iconSize: 1.56 },
  scared: { edge: 'rgba(96,98,112,0.75)', edgeW: 0.035, body: WHITE, icon: 'scared', iconSize: 1.6 },
  happy: { edge: 'rgba(96,98,112,0.75)', edgeW: 0.035, body: WHITE, icon: 'happy', iconSize: 1.6 },
  curePlus: { edge: 'rgba(34,36,44,0.85)', edgeW: 0.035, body: WHITE, disc: [0.85, hex(PAL.terracotta)], icon: 'plus', iconSize: 1.52 },
  cureGreen: { edge: 'rgba(34,36,44,0.85)', edgeW: 0.035, body: WHITE, disc: [0.85, hex(PAL.uiGreen)], icon: 'plus', iconSize: 1.52 },
  cureCheck: { edge: 'rgba(34,36,44,0.85)', edgeW: 0.035, body: WHITE, disc: [0.85, hex(PAL.uiGreen)], icon: 'check', iconSize: 1.56, iconDy: 0.02 },
} satisfies Record<string, Skin>
type SkinName = keyof typeof SKINS

function drawBubble(skin: Skin): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = Math.round((X1 - X0) * PX)
  cv.height = Math.round((Y1 - Y0) * PX)
  const c = cv.getContext('2d')!
  // origin at the circle centre, y down
  c.translate(-X0 * PX, (Y1 - CY) * PX)
  const R = PX
  // outline (with optional glow)
  c.save()
  if (skin.glow) {
    c.shadowColor = skin.glow
    c.shadowBlur = 0.2 * R
    bubblePath(c, R * 0.99)
    c.fillStyle = skin.glow
    c.fill()
    c.fill()
  }
  c.restore()
  bubblePath(c, R)
  c.fillStyle = skin.edge
  c.fill()
  // body
  const inner = R * (1 - skin.edgeW)
  const g = c.createLinearGradient(0, -inner, 0, inner)
  g.addColorStop(0, skin.body[0])
  g.addColorStop(1, skin.body[1])
  bubblePath(c, inner)
  c.fillStyle = g
  c.fill()
  // disc
  if (skin.disc) {
    const r = skin.disc[0] * R
    c.beginPath()
    c.arc(0, 0, r, 0, Math.PI * 2)
    c.fillStyle = skin.disc[1]
    c.fill()
    // a soft darker lip so the disc reads as slightly sunken
    c.lineWidth = 0.03 * R
    c.strokeStyle = 'rgba(40,20,10,0.16)'
    c.beginPath()
    c.arc(0, 0, r - 0.015 * R, 0, Math.PI * 2)
    c.stroke()
  }
  // icon
  const s = skin.iconSize * R
  c.drawImage(iconCanvas(skin.icon, 256), -s / 2, -s / 2 + (skin.iconDy ?? 0) * R, s, s)
  return cv
}

const texCache = new Map<string, THREE.CanvasTexture>()
function skinTexture(name: SkinName): THREE.CanvasTexture {
  let t = texCache.get(name)
  if (!t) texCache.set(name, (t = uiTexture(drawBubble(SKINS[name]))))
  return t
}
function tickTexture(): THREE.CanvasTexture {
  let t = texCache.get('tick')
  if (!t) texCache.set('tick', (t = uiTexture(iconCanvas('tick', 128))))
  return t
}

// --- geometry -------------------------------------------------------------------------------------------------

let bodyGeo: THREE.BufferGeometry | null = null
let tickGeo: THREE.BufferGeometry | null = null

function quad(corners: number[]): THREE.BufferGeometry {
  // corners: bottom-left, bottom-right, top-right, top-left (x, y pairs)
  const g = new THREE.BufferGeometry()
  const pos = new Float32Array(12)
  for (let i = 0; i < 4; i++) {
    pos[i * 3] = corners[i * 2]!
    pos[i * 3 + 1] = corners[i * 2 + 1]!
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2))
  g.setIndex([0, 1, 2, 0, 2, 3])
  // generous bounds: the quad is expanded in the vertex shader
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 3)
  return g
}
function bodyGeometry(): THREE.BufferGeometry {
  return (bodyGeo ??= quad([X0, Y0, X1, Y0, X1, Y1, X0, Y1]))
}
/** Tick angle clockwise from 12 o'clock and distance of its centre from the circle centre (radius units). */
const TICK_ANGLE = 0.76
const TICK_DIST = 1.1
const TICK_SIZE = 0.72
function tickGeometry(): THREE.BufferGeometry {
  if (tickGeo) return tickGeo
  const cx = Math.sin(TICK_ANGLE) * TICK_DIST
  const cy = CY + Math.cos(TICK_ANGLE) * TICK_DIST
  const h = TICK_SIZE / 2
  const co = Math.cos(-TICK_ANGLE)
  const si = Math.sin(-TICK_ANGLE)
  const corners: number[] = []
  for (const [x, y] of [[-h, -h], [h, -h], [h, h], [-h, h]] as const) corners.push(cx + co * x - si * y, cy + si * x + co * y)
  return (tickGeo = quad(corners))
}

function material(map: THREE.Texture, map2: THREE.Texture | null, size: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    ...UI_MATERIAL,
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines: map2 ? { PIE: '' } : {},
    uniforms: {
      map: { value: map },
      map2: { value: map2 ?? map },
      uSize: { value: size },
      uScale: { value: 1 },
      uRot: { value: 0 },
      uPivot: { value: new THREE.Vector2(0, CY) },
      uBias: { value: BUBBLE_DEPTH_BIAS },
      uProgress: { value: 0 },
      uOpacity: { value: 1 },
    },
  })
}

// --- handle ---------------------------------------------------------------------------------------------------

export interface Bubble {
  /**
   * Origin = the tip of the tail, i.e. the point the bubble points at. The circle centre floats
   * BUBBLE_CENTER_ABOVE_TIP x diameter above it on screen. Only the world POSITION of root matters: the bubble
   * always faces the camera and ignores the rotation and scale of root and its parents.
   */
  root: THREE.Group
  kind: BubbleKind
  /** Circle diameter in metres. */
  diameter: number
  /**
   * Pop scale around the tail tip: 0 hides the bubble (nothing is drawn), 1 = full size; values up to about 1.1
   * are meant for the overshoot of the emoji pop-in (SPEC 8.3: in over 3-5 frames, out over 2-5 frames).
   */
  setScale(s: number): void
  /**
   * 'cure' only: fraction 0..1 of the disc that has turned green, sweeping clockwise from 12 o'clock
   * (0 = white plus on terracotta, 1 = white plus on green). A shader uniform: call it every frame if you like.
   * No effect on other kinds.
   */
  setProgress(p: number): void
  /**
   * 'cure' only: true (default) shows the white check on green that ends a treatment, false returns to the
   * plus / pie display (use setCheck(false) and setProgress(0) to reuse the bubble for the next patient).
   */
  setCheck(on?: boolean): void
  /**
   * Per-frame animation, t = seconds: wobbles the red tick of 'potion' and 'nurse'. A no-op for the other
   * kinds, so it is safe to call on every bubble.
   */
  update(t: number): void
}

/**
 * Create one bubble. `diameter` defaults to BUBBLE_DIAMETER[kind]. Starts at scale 1; call setScale(0) right away
 * if it should pop in later. Typical anchors (SPEC 8.3): potion / cure over the cauldron, 'cure' and 'nurse' over a
 * bed head, 'sick' / 'scared' / 'happy' about 0.5 m above a character's head.
 */
export function makeBubble(kind: BubbleKind, diameter: number = BUBBLE_DIAMETER[kind]): Bubble {
  const root = new THREE.Group()
  root.userData.ui = true
  const size = diameter / 2
  const isCure = kind === 'cure'
  const plusTex = isCure ? skinTexture('curePlus') : null
  const bodyMat = isCure ? material(plusTex!, skinTexture('cureGreen'), size) : material(skinTexture(kind as SkinName), null, size)
  const body = new THREE.Mesh(bodyGeometry(), bodyMat)
  body.renderOrder = 21
  root.add(body)
  const u = bodyMat.uniforms

  let tickU: THREE.ShaderMaterial['uniforms'] | null = null
  if (kind === 'potion' || kind === 'nurse') {
    const tickMat = material(tickTexture(), null, size)
    const tick = new THREE.Mesh(tickGeometry(), tickMat)
    tick.renderOrder = 22 // over the body: in the ad the bar crosses the bubble's rim
    root.add(tick)
    tickU = tickMat.uniforms
  }
  // a little phase offset per bubble so several alert bubbles do not wobble in unison
  const phase = Math.random() * 6.283
  let check = false

  return {
    root,
    kind,
    diameter,
    setScale(s) {
      root.visible = s > 0.002
      u.uScale!.value = s
      if (tickU) tickU.uScale!.value = s
    },
    setProgress(p) {
      if (!isCure || check) return
      u.uProgress!.value = p < 0 ? 0 : p > 1 ? 1 : p
    },
    setCheck(on = true) {
      if (!isCure || on === check) return
      check = on
      u.map!.value = on ? skinTexture('cureCheck') : plusTex
      if (on) u.uProgress!.value = 0
    },
    update(t) {
      if (!tickU) return
      const w = t * 11 + phase
      tickU.uRot!.value = Math.sin(w) * 0.1 + Math.sin(w * 2.7) * 0.035
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------------------------------------------

function item(name: string, kind: BubbleKind, setup?: (b: Bubble) => void, animate?: (b: Bubble, t: number) => void): GalleryItem {
  return {
    name,
    size: 0.9,
    make: () => {
      const g = new THREE.Group()
      const b = makeBubble(kind)
      b.root.position.y = 0.4
      setup?.(b)
      g.add(b.root)
      g.userData.b = b
      return g
    },
    animate: (o, t) => {
      const b = o.userData.b as Bubble
      b.update(t)
      animate?.(b, t)
    },
  }
}

const popIn = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : k < 0.7 ? 1.1 * (1 - (1 - k / 0.7) ** 2) : 1.1 - 0.1 * ((k - 0.7) / 0.3))

/** Shows the depth rule: the crate right in front of the bubble is covered by it, the wall 4 m in front hides it. */
function depthDemo(): GalleryItem {
  return {
    name: 'bubble-depth-rule',
    size: 2.6,
    make: () => {
      const g = new THREE.Group()
      // toward the game camera on the ground: (-0.64, +0.77)
      for (const [dist, kind] of [[-1.2, 'sick'], [1.2, 'cure']] as const) {
        const b = makeBubble(kind)
        b.root.position.set(dist, 0.4, 0)
        g.add(b.root)
        const near = dist < 0
        const h = near ? 2.6 : 6.5
        const box = mesh(new THREE.BoxGeometry(near ? 0.8 : 1.6, h, 0.3), lam(near ? PAL.cartWood : PAL.wall), g)
        const d = near ? 1.0 : 4.0
        box.position.set(dist - 0.64 * d, h / 2, 0.77 * d)
        box.rotation.y = -Math.atan2(0.64, 0.77)
      }
      return g
    },
  }
}

export const GALLERY: GalleryItem[] = [
  item('bubble-potion', 'potion'),
  item('bubble-nurse', 'nurse'),
  item('bubble-cure-0', 'cure'),
  item('bubble-cure-40', 'cure', b => b.setProgress(0.4)),
  item('bubble-cure-75', 'cure', b => b.setProgress(0.75)),
  item('bubble-cure-100', 'cure', b => b.setProgress(1)),
  item('bubble-cure-check', 'cure', b => b.setCheck()),
  item('bubble-cure-anim', 'cure', undefined, (b, t) => {
    // the bed timeline of SPEC 2.10: plus, pie 0.85-1.2 s, check at 1.4 s, shrink out at 1.6 s
    const k = t % 2.4
    b.setCheck(k >= 1.4)
    b.setProgress((k - 0.85) / 0.37)
    b.setScale(k < 0.15 ? popIn(k / 0.13) : k > 1.6 ? Math.max(0, 1 - (k - 1.6) / 0.17) : 1)
  }),
  item('bubble-sick', 'sick'),
  item('bubble-scared', 'scared'),
  item('bubble-happy', 'happy'),
  item('bubble-sick-pop', 'sick', undefined, (b, t) => {
    const k = t % 1.6
    b.setScale(k < 1.3 ? popIn(k / 0.15) : Math.max(0, 1 - (k - 1.3) / 0.12))
  }),
  depthDemo(),
]
