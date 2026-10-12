// World-space UI decals (SPEC 8.2): everything here lies flat on the ground at y = DECAL_Y, is unlit and does not
// write depth, so characters standing on a decal cover it and decals never z-fight with the floor (see DECAL_LIFT).
//
//   makeRing()               the doctor's dashed lime ring
//   makeCapacityLabel()      "0 / 2" label at the cauldron (grey dashed <-> solid green when full)
//   makePricePad(def)        unlock pad: four corner brackets, icon, coin + price, green pay fill
//   makeDashedCircle(r)      orange dashed circle at the drill with twinkling sparkles
//   makeBedOutline()         thin yellow rectangle around a newly unlocked bed
//
// Every factory returns a handle whose `root` has its origin ON THE GROUND (y = 0) at the decal centre: set
// root.position.x / .z (and leave y = 0), then drive it with the handle's setters. All setters are cheap: they
// write a uniform or a scale, never allocate, and canvases are redrawn only when their text changes.
//
// Sizes and layouts were measured on ground-rectified frames of the ad (the doctor's ring = 1.6 m as the ruler);
// where they differ from the first estimates in SPEC 8.2 the comment at the constant says so.
import * as THREE from 'three'
import { BEDS, L, P, PAL, UNLOCKS, hex, type UnlockDef, type UnlockId } from '../config'
import { lam, type GalleryItem } from '../view/materials'
import { makeArrow, type GuideArrow } from './arrow'
import { makeBubble, type Bubble } from './bubbles'
import { UI_FONT_CAP, UI_GLSL, UI_GLSL_OUT, UI_MATERIAL, UI_WHITE, drawUiText, iconCanvas, measureUiText, onUiFont, roundRect, uiGlslOut, uiTexture, type PadIconName } from './icons'

/** Height of every decal above the ground plane. */
export const DECAL_Y = 0.02
/**
 * Decals are depth-tested as if they lay this many metres higher (0.078 m in all), so floor trim that pokes through
 * the ground plane (the 7 cm curbs on the thresholds, which pad D straddles) cannot cut a strip out of them, while
 * anything taller (a coin lying on a pad is 9 cm, feet, wheels) still covers them.
 */
export const DECAL_LIFT = 0.058

const TAU = Math.PI * 2
const VERT = /* glsl */ `
varying vec2 vP;
varying vec2 vUv;
void main() {
  vUv = uv;
  vP = position.xy;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wp;
  gl_Position = projectionMatrix * mv;
  // view depth that DECAL_LIFT m of height amounts to along this vertex's view ray
  float lift = ${DECAL_LIFT.toFixed(3)} * -mv.z / max(cameraPosition.y - wp.y, 0.5);
  vec4 nearer = projectionMatrix * vec4(mv.xy, min(mv.z + lift, -0.01), 1.0);
  gl_Position.z = max(nearer.z / nearer.w, -0.999) * gl_Position.w;
}
`
const SD_RECT = /* glsl */ `
float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float cover(float d) { return clamp(0.5 - d / max(fwidth(d), 1e-5), 0.0, 1.0); }
`

/** Glowing lines (ring, drill circle, bed outline) keep their full PAL colour and may pick up a little bloom. */
const LINE_OUT = uiGlslOut(0.95)

function shader(fragment: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string> = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    ...UI_MATERIAL,
    vertexShader: VERT,
    fragmentShader: fragment,
    uniforms,
    defines,
    // no polygonOffset: DECAL_LIFT in the vertex shader does that job with a known height
  })
}

/** A plane lying on the ground: local +x = world +x, local +y = world -z (before the parent's rotation). */
function flat(w: number, h: number, mat: THREE.Material, order: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
  m.rotation.x = -Math.PI / 2
  m.position.y = DECAL_Y
  m.renderOrder = order
  m.userData.ui = true
  return m
}

const col = (c: number) => new THREE.Color(c)
const rgba = (c: number, a: number) => `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`

// ---------------------------------------------------------------------------------------------------------------
// Dashed circles (doctor ring, drill circle): drawn analytically, so they stay crisp at any zoom.
// ---------------------------------------------------------------------------------------------------------------

const DASH_FRAG = /* glsl */ `
uniform float uRadius, uDashes, uDuty, uWidth, uRound, uEdge, uGlow, uGlowSize, uOpacity, uTime;
uniform vec3 uColor, uEdgeColor;
varying vec2 vP;
${SD_RECT}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float r = length(vP);
  float period = 6.28318530718 / uDashes;
  float a = abs(mod(atan(vP.y, vP.x), period) - 0.5 * period);
  // distance to one dash: a rounded box in (arc length, radius) space
  float rad = 0.5 * uWidth * uRound;
  vec2 q = vec2(a * uRadius - 0.5 * period * uRadius * uDuty, abs(r - uRadius) - 0.5 * uWidth) + rad;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
  float core = cover(d);
  // uEdge metres of the dash's rim take the edge colour; the soft glow outside has it too
  float inner = cover(d + uEdge);
  float glow = uGlow * exp(-max(d, 0.0) / uGlowSize);
  vec3 rgb = mix(uEdgeColor, uColor, inner);
  float alpha = max(core, glow);
#ifdef SPARKLE
  // small four-point stars twinkling inside the circle, denser towards the rim (as at 24.2-26.6 s in the ad)
  vec2 g = vP / 0.36;
  vec2 id = floor(g);
  float h = hash(id);
  float h2 = hash(id + 31.7);
  vec2 f = (fract(g) - 0.5 - (vec2(h2, hash(id + 7.3)) - 0.5) * 0.7) * 0.36;
  float tw = max(0.0, sin(uTime * (2.2 + 3.0 * h2) + h * 6.2831853));
  float size = (0.05 + 0.06 * h2) * tw;
  float star = clamp(1.0 - (abs(f.x) * abs(f.y) * 9.0 + dot(f, f)) / max(size * size, 1e-6), 0.0, 1.0);
  float rn = r / uRadius;
  float sp = step(0.3, h) * star * tw * smoothstep(1.0 - 0.06, 1.0 - 0.2, rn) * smoothstep(0.1, 0.75, rn + 0.35 * h2);
  rgb = mix(rgb, vec3(1.0), sp);
  alpha = max(alpha, sp * 0.95);
#endif
  gl_FragColor = vec4(rgb, alpha * uOpacity);
  ${LINE_OUT}
}
`

interface DashOpts {
  radius: number
  dashes: number
  duty: number
  width: number
  /** 1 = fully rounded dash ends, 0 = square. */
  round: number
  color: number
  /** Colour of the dash rim (`edge` metres wide) and of the glow around it. */
  edgeColor: number
  edge: number
  glow: number
  glowSize: number
  sparkle?: boolean
}
function dashedCircle(o: DashOpts, order: number): { mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform> } {
  const uniforms = {
    uRadius: { value: o.radius },
    uDashes: { value: o.dashes },
    uDuty: { value: o.duty },
    uWidth: { value: o.width },
    uRound: { value: o.round },
    uEdge: { value: o.edge },
    uGlow: { value: o.glow },
    uGlowSize: { value: o.glowSize },
    uOpacity: { value: 1 },
    uTime: { value: 0 },
    uColor: { value: col(o.color) },
    uEdgeColor: { value: col(o.edgeColor) },
  }
  const size = (o.radius + o.width + o.glowSize * 4) * 2
  return { mesh: flat(size, size, shader(DASH_FRAG, uniforms, o.sparkle ? { SPARKLE: '' } : {}), order), uniforms }
}

export interface RingDecal {
  /** Origin = ring centre on the ground. Parent it to the doctor or copy his x / z every frame; never rotate it. */
  root: THREE.Group
  /** Hide while the doctor is mounted on the cart (SPEC 0.2), show again on foot. */
  setVisible(on: boolean): void
  /** 0..1 fade (default 1). */
  setOpacity(a: number): void
}

/** The doctor's dashed lime ring: diameter P.RING_DIAMETER, 18 rounded dashes, stroke 0.09 m, soft glow. Static. */
export function makeRing(): RingDecal {
  const root = new THREE.Group()
  const { mesh, uniforms } = dashedCircle(
    { radius: P.RING_DIAMETER / 2, dashes: 18, duty: 0.68, width: 0.09, round: 0.7, color: PAL.ring, edgeColor: PAL.ring, edge: 0, glow: 0.2, glowSize: 0.04 },
    6,
  )
  root.add(mesh)
  return {
    root,
    setVisible(on) {
      root.visible = on
    },
    setOpacity(a) {
      uniforms.uOpacity!.value = a
    },
  }
}

export interface DashedCircleDecal {
  /** Origin = circle centre on the ground (the drill's is L.DASHED_CIRCLE). */
  root: THREE.Group
  /** Advance the sparkle twinkle; t = seconds (any monotonic clock). Call every frame while visible. */
  update(t: number): void
  setVisible(on: boolean): void
  /** 0..1 fade (default 1). */
  setOpacity(a: number): void
}

/**
 * Dashed circle at the drill: 18 long square-ended dashes 0.15 m wide, golden yellow with a thin orange rim, and small white
 * sparkles inside. Radius defaults to the drill's 2.8 m. (The ad shows about 10 dashes on the visible half, each
 * about 0.7 m long: fewer, longer and bolder than SPEC 8.2's "about 24".)
 */
export function makeDashedCircle(radius: number = P.DASHED_CIRCLE_RADIUS): DashedCircleDecal {
  const root = new THREE.Group()
  const { mesh, uniforms } = dashedCircle(
    { radius, dashes: 18, duty: 0.74, width: 0.15, round: 0.2, color: PAL.gold, edgeColor: PAL.drillCircleEdge, edge: 0.018, glow: 0.16, glowSize: 0.04, sparkle: true },
    3,
  )
  root.add(mesh)
  return {
    root,
    update(t) {
      uniforms.uTime!.value = t
    },
    setVisible(on) {
      root.visible = on
    },
    setOpacity(a) {
      uniforms.uOpacity!.value = a
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Bed outline
// ---------------------------------------------------------------------------------------------------------------

const OUTLINE_FRAG = /* glsl */ `
uniform vec2 uHalf;
uniform float uCorner, uWidth, uGlow, uGlowSize, uOpacity;
uniform vec3 uColor, uGlowColor;
varying vec2 vP;
${SD_RECT}
void main() {
  float d = abs(sdRoundRect(vP, uHalf, uCorner)) - 0.5 * uWidth;
  float core = cover(d);
  float glow = uGlow * exp(-max(d, 0.0) / uGlowSize);
  gl_FragColor = vec4(mix(uGlowColor, uColor, core), max(core, glow) * uOpacity);
  ${LINE_OUT}
}
`

export interface BedOutlineDecal {
  /** Origin = bed centre on the ground; the long side runs along x like the beds (put it at BEDS[i].x / .z). */
  root: THREE.Group
  /** 0 = invisible (also stops drawing) .. 1 = full. The unlock effect fades it out within 0.1 s (SPEC 8.2). */
  setOpacity(a: number): void
}

/**
 * Thin pale-yellow rectangle with a faint golden halo: what is left on the floor when the unlock curtain is gone
 * (SPEC 8.2, 9 row 19; 51.5 s in the ad). The default size is 1.3 x the bed footprint; pass another width (along x) /
 * depth (along z) to frame any other unlocked object, e.g. the cart.
 */
export function makeBedOutline(width: number = P.BED_W * 1.3, depth: number = P.BED_D * 1.3): BedOutlineDecal {
  const root = new THREE.Group()
  const hw = width / 2
  const hd = depth / 2
  const uniforms = {
    uHalf: { value: new THREE.Vector2(hw, hd) },
    uCorner: { value: 0.05 },
    uWidth: { value: 0.045 },
    uGlow: { value: 0.3 },
    uGlowSize: { value: 0.06 },
    uOpacity: { value: 1 },
    uColor: { value: col(PAL.goldCore) },
    uGlowColor: { value: col(PAL.gold) },
  }
  root.add(flat(hw * 2 + 0.7, hd * 2 + 0.7, shader(OUTLINE_FRAG, uniforms), 3))
  return {
    root,
    setOpacity(a) {
      uniforms.uOpacity.value = a
      root.visible = a > 0.004
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Canvas-textured decals (label, pad)
// ---------------------------------------------------------------------------------------------------------------

const TEX_FRAG = /* glsl */ `
uniform sampler2D map;
uniform float uOpacity;
uniform vec3 uTint;
varying vec2 vUv;
${UI_GLSL}
void main() {
  gl_FragColor = uiTexel(map, vUv);
  gl_FragColor.rgb *= uTint;
  gl_FragColor.a *= uOpacity;
  ${UI_GLSL_OUT}
}
`
const NO_TINT = new THREE.Color(1, 1, 1)
/** The ad's pad art is a warm white: this linear multiplier takes the UI's white (UI_WHITE) most of the way to PAL.padArcCore. */
const PAD_TINT = new THREE.Color(PAL.padArcCore).multiplyScalar(1 / UI_WHITE).lerp(NO_TINT, 0.35)
/** The ad's floor digits are a touch narrower than Lilita One's: canvas-drawn decal numbers are squeezed by this. */
const DIGIT_SQUEEZE = 0.95

function canvas(w: number, h: number, ppm: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.round(w * ppm)
  c.height = Math.round(h * ppm)
  return c
}

// --- capacity label ---------------------------------------------------------------------------------------------

/**
 * Size of the capacity label in metres: length along x, depth along z. Measured in the ad (8.6 s, 13.9 s) it is
 * 1.8 x 0.8 m, a rounded rectangle rather than a pill; SPEC 8.2 / L.CAPACITY_LABEL's first estimate was 2.1 x 0.9.
 */
export const LABEL_SIZE = { w: 1.8, d: 0.8 } as const

const LABEL_PPM = 240
const LABEL_MARGIN = 0.1

function drawLabel(cv: HTMLCanvasElement, n: number, slots: number): void {
  const c = cv.getContext('2d')!
  const M = LABEL_PPM
  const full = slots > 0 && n >= slots
  c.clearRect(0, 0, cv.width, cv.height)
  c.save()
  c.translate(cv.width / 2, cv.height / 2)
  const W = LABEL_SIZE.w * M
  const H = LABEL_SIZE.d * M
  const r = 0.2 * M
  // body
  roundRect(c, -W / 2, -H / 2, W, H, r)
  c.fillStyle = full ? hex(PAL.uiGreen) : 'rgba(26,28,40,0.2)'
  c.fill()
  // dashed outline: a whole number of dashes around the perimeter, one dash centred on every straight side
  const perimeter = 2 * (W - 2 * r) + 2 * (H - 2 * r) + TAU * r
  const period = perimeter / 16
  c.lineWidth = 0.04 * M
  c.lineCap = 'butt'
  c.setLineDash([period * 0.64, period * 0.36])
  c.lineDashOffset = period * 0.32 - (W / 2 - r)
  c.strokeStyle = rgba(PAL.labelDash, full ? 0.9 : 0.72)
  c.stroke()
  c.setLineDash([])
  // person icon
  const icon = 0.52 * M
  c.globalAlpha = 0.95
  c.drawImage(iconCanvas('person', 128), -0.455 * M - icon / 2, -icon / 2, icon, icon)
  c.globalAlpha = 1
  // "0 / 2": wide-spaced digits on a fixed pitch, sized by cap height (0.26 m; the slash stands a little taller)
  const text = `${n}/${slots}`
  const room = 0.98 * M
  let pitch = 0.315 * M
  let px = (0.26 * M) / UI_FONT_CAP
  const need = (text.length - 1) * pitch + px * 0.6
  const k = Math.min(1, room / need)
  px *= k
  pitch *= k
  const baseline = px * UI_FONT_CAP * 0.5
  let x = 0.3 * M - ((text.length - 1) * pitch) / 2
  const style = { fill: '#f1eeeb', stroke: '#1b1b21', outline: 0.026 * M, align: 'center' as const }
  for (const ch of text) {
    c.save()
    c.translate(x, baseline)
    c.scale(DIGIT_SQUEEZE, 1)
    drawUiText(c, ch, 0, 0, px, style)
    c.restore()
    x += pitch
  }
  c.restore()
}

export interface CapacityLabel {
  /** Origin = label centre on the ground, already at L.CAPACITY_LABEL (x, z); the text baseline runs along +x. */
  root: THREE.Group
  /**
   * Show "n / slots". n >= slots switches to the solid green "full" style, otherwise the grey dashed style
   * (the flip is instant, SPEC 9 row 14). The canvas is redrawn only when n or slots actually change.
   */
  set(n: number, slots: number): void
  setVisible(on: boolean): void
}

/** Capacity label at the cauldron: dashed rounded rectangle LABEL_SIZE with a person icon and "0 / 2" (SPEC 8.2). */
export function makeCapacityLabel(): CapacityLabel {
  const { x, z } = L.CAPACITY_LABEL
  const root = new THREE.Group()
  root.position.set(x, 0, z)
  const pw = LABEL_SIZE.w + LABEL_MARGIN * 2
  const pd = LABEL_SIZE.d + LABEL_MARGIN * 2
  const cv = canvas(pw, pd, LABEL_PPM)
  const tex = uiTexture(cv)
  root.add(flat(pw, pd, shader(TEX_FRAG, { map: { value: tex }, uOpacity: { value: 1 }, uTint: { value: NO_TINT } }), 3))
  let curN = 0
  let curSlots: number = P.BATH_SLOTS
  const redraw = () => {
    drawLabel(cv, curN, curSlots)
    tex.needsUpdate = true
  }
  redraw()
  onUiFont(redraw)
  return {
    root,
    set(n, slots) {
      if (n === curN && slots === curSlots) return
      curN = n
      curSlots = slots
      redraw()
    },
    setVisible(on) {
      root.visible = on
    },
  }
}

// --- price pad ----------------------------------------------------------------------------------------------------
//
// Seen from above and turned so the price reads left to right ("text space": u = text direction, v = text up), every
// pad of the ad is the same drawing:
//
//      .--            --.        four corner brackets of a rounded square (they sit at the top / bottom / left /
//      |     [icon]     |        right of the pad ON SCREEN only because the camera looks along the diagonal)
//                                the unlock's icon in the upper half
//      |    (c) 5 0     |        coin + price centred in the lower half
//      '--            --'
//
// and the pay fill is the rounded square itself, rising from the price's edge to the top like a progress bar.

/**
 * Geometry of a pad at scale 1, in metres (measured on pads B and D of the ad, 27.5 s and 50.2 s).
 * `side` is the outer side of the bracket square (P.PAD_DIAMETER: SPEC 8.2 read the four brackets as arcs of a circle).
 */
export const PAD = {
  side: P.PAD_DIAMETER,
  /** Bracket stroke, bend radius (centre line) and straight run after the bend. */
  stroke: 0.11,
  bend: 0.27,
  arm: 0.08,
  /** Half side and corner radius of the green pay fill (it stops just inside the brackets). */
  fillHalf: 0.79,
  fillCorner: 0.17,
} as const

/**
 * Pads are not all the same size in the ad: the nurses' pad squeezed between the ward-1 beds is 1.46 m across,
 * the cart's is a big 2.5 m footprint with a huge icon and price. `scale` sizes the whole pad, `content` (default 1)
 * additionally sizes icon + price inside the brackets. Unlisted pads use 1.
 */
export const PAD_SCALE: Partial<Record<UnlockId, { scale: number; content?: number }>> = { nurses: { scale: 0.78, content: 1.05 }, cart: { scale: 1.3, content: 1.15 } }

/** Box size (m, pad scale 1) the icon is drawn in; wide icons get a bigger box so their height matches the others. */
const PAD_ICON_BOX: Record<PadIconName, number> = { nurse: 0.8, usher: 0.8, cart: 1.2, ward: 1.0, porter: 0.84, chest: 0.8, cauldron: 0.9, drill: 0.92, driver: 0.98 }

const PAD_PPM = 200
const PAD_PLANE = PAD.side + 0.1

function drawPad(cv: HTMLCanvasElement, def: UnlockDef, content: number): void {
  const c = cv.getContext('2d')!
  const M = PAD_PPM
  c.clearRect(0, 0, cv.width, cv.height)
  c.save()
  c.translate(cv.width / 2, cv.height / 2)
  // corner brackets
  const h = ((PAD.side - PAD.stroke) / 2) * M
  const r = PAD.bend * M
  const arm = PAD.arm * M
  c.lineWidth = PAD.stroke * M
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.strokeStyle = 'rgba(255,255,255,0.93)' // becomes PAL.padArcCore through PAD_TINT
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      c.beginPath()
      c.moveTo(sx * (h - r - arm), sy * h)
      c.lineTo(sx * (h - r), sy * h)
      c.arcTo(sx * h, sy * h, sx * h, sy * (h - r), r)
      c.lineTo(sx * h, sy * (h - r - arm))
      c.stroke()
    }
  }
  // icon in the upper half
  c.scale(content, content)
  const icon = PAD_ICON_BOX[def.icon] * M
  c.drawImage(iconCanvas(def.icon, 256), -icon / 2, -0.45 * M - icon / 2, icon, icon)
  // coin + price, centred in the lower half. "50" stands 0.47 m tall and 0.76 m long; as in the ad "100" is shrunk
  // to about the same length, and four digits get a little more room.
  const text = String(def.price)
  const coin = 0.4 * M
  const rowY = 0.29 * M
  const room = (text.length <= 3 ? 0.8 : 0.98) * M
  let px = (0.47 / UI_FONT_CAP) * M
  let tw = measureUiText(c, text, px, 0, false) * DIGIT_SQUEEZE
  if (tw > room) {
    px *= room / tw
    tw = room
  }
  const left = -(coin + tw) / 2
  c.drawImage(iconCanvas('coin', 128), left, rowY - coin / 2, coin, coin)
  // lying on the floor the ad's coin is a darker, redder copper than the HUD's
  c.beginPath()
  c.arc(left + coin / 2, rowY, coin * 0.475, 0, TAU)
  c.fillStyle = 'rgba(96,18,14,0.3)'
  c.fill()
  c.save()
  c.translate(left + coin - 0.01 * M, rowY + px * UI_FONT_CAP * 0.5)
  c.scale(DIGIT_SQUEEZE, 1)
  drawUiText(c, text, 0, 0, px, { fill: '#f6f1ee', stroke: '#131317', outline: 0.036 * M, tabular: false })
  c.restore()
  c.restore()
}

const FILL_FRAG = /* glsl */ `
uniform float uHalf, uCorner, uFill, uOpacity;
uniform vec3 uColor;
varying vec2 vP;
${SD_RECT}
void main() {
  float inside = cover(sdRoundRect(vP, vec2(uHalf), uCorner));
  // progress front rising from the price's edge (-y) to the top (+y)
  float front = uHalf * (2.0 * uFill - 1.0) - vP.y;
  float wipe = uFill >= 1.0 ? 1.0 : clamp(0.5 + front / max(fwidth(front), 1e-5), 0.0, 1.0);
  gl_FragColor = vec4(uColor, inside * wipe * uOpacity);
  ${UI_GLSL_OUT}
}
`

/** Pop-in curve: 0 -> 1.1 -> 1 (SPEC 2.9). */
function popCurve(k: number): number {
  if (k <= 0) return 0
  if (k >= 1) return 1
  if (k < 0.7) {
    const e = 1 - (1 - k / 0.7) ** 2
    return 1.1 * e
  }
  return 1.1 - 0.1 * ((k - 0.7) / 0.3)
}

export interface PricePad {
  /** Origin = pad centre on the ground, already placed at (def.x, 0, def.z). */
  root: THREE.Group
  def: UnlockDef
  /** Size factor of this pad (PAD_SCALE[def.id].scale or 1): its bracket square is PAD.side x scale metres across. */
  scale: number
  /**
   * Pop-in progress 0..1 (0 = hidden, 1 = shown): feed elapsed / P.PAD_POP_TIME; the 0 -> 1.1 -> 1 overshoot is
   * applied inside. Feed it backwards (1 -> 0) for the 2-frame shrink-out when the pad is done.
   */
  setPop(k: number): void
  /**
   * Green pay fill: f = paid / price in 0..1 (0 hides it, 1 = the whole rounded square). As in the ad it rises
   * like a progress bar from the edge the price stands on to the opposite edge, whatever side the doctor is on,
   * so the two direction arguments of the original brief are accepted and ignored.
   */
  setFill(f: number, dirX?: number, dirZ?: number): void
  /** Show / hide the whole pad without touching pop or fill. */
  setVisible(on: boolean): void
}

/**
 * Unlock price pad (SPEC 2.9, 8.2): four pale corner brackets, the unlock's white icon, the copper coin and the price
 * in the UI font. The price reads along def.textAlong (+z for the "50" pads, +x for the others) and never counts
 * down. Starts fully shown with no fill; call setPop(0) to start hidden. 1 draw call (2 while paying).
 */
export function makePricePad(def: UnlockDef, scale: number = PAD_SCALE[def.id]?.scale ?? 1): PricePad {
  const content = PAD_SCALE[def.id]?.content ?? 1
  const root = new THREE.Group()
  root.position.set(def.x, 0, def.z)
  // "text space": local +x = text direction, local -z = text up
  const turn = new THREE.Group()
  turn.rotation.y = def.textAlong === 'z' ? -Math.PI / 2 : 0
  turn.scale.set(scale, 1, scale)
  root.add(turn)

  const fillU = {
    uHalf: { value: PAD.fillHalf },
    uCorner: { value: PAD.fillCorner },
    uFill: { value: 0 },
    uOpacity: { value: 1 },
    uColor: { value: col(PAL.padFill) },
  }
  const fill = flat(PAD.fillHalf * 2 + 0.1, PAD.fillHalf * 2 + 0.1, shader(FILL_FRAG, fillU), 3)
  fill.visible = false
  turn.add(fill)

  const cv = canvas(PAD_PLANE, PAD_PLANE, PAD_PPM)
  const tex = uiTexture(cv)
  const art = flat(PAD_PLANE, PAD_PLANE, shader(TEX_FRAG, { map: { value: tex }, uOpacity: { value: 1 }, uTint: { value: PAD_TINT } }), 4)
  art.position.y = DECAL_Y + 0.002
  turn.add(art)
  const redraw = () => {
    drawPad(cv, def, content)
    tex.needsUpdate = true
  }
  redraw()
  onUiFont(redraw)

  return {
    root,
    def,
    scale,
    setPop(k) {
      const s = popCurve(k) * scale
      turn.visible = s > 0.001
      turn.scale.set(s, 1, s)
    },
    setFill(f) {
      const on = f > 0
      fill.visible = on
      if (on) fillU.uFill.value = f < 1 ? f : 1
    },
    setVisible(on) {
      root.visible = on
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------------------------------------------

/** Gallery helper: a pad at the origin instead of its map position. */
function padAtOrigin(def: UnlockDef, fill: number): THREE.Object3D {
  const pad = makePricePad(def)
  pad.root.position.set(0, 0, 0)
  pad.setFill(fill)
  pad.root.userData.pad = pad
  return pad.root
}

const label = (n: number, slots: number) => () => {
  const l = makeCapacityLabel()
  l.root.position.set(0, 0, 0)
  l.set(n, slots)
  return l.root
}

/**
 * "In context" scenes: the UI at its real map positions on floor-coloured patches, with a 1.9 m stand-in for the
 * doctor, to hold next to an ad frame. At 608 x 1080 with &view=game&zoom=0.6 the scale is the real game camera's.
 * `at` is the map point shown at the screen centre.
 */
const CTX_SIZE = 3
interface CtxAnim {
  update(t: number): void
}
function context(name: string, at: { x: number; z: number }, build: (g: THREE.Group, anim: CtxAnim[]) => void): GalleryItem {
  return {
    name,
    size: CTX_SIZE,
    make: () => {
      const outer = new THREE.Group()
      const g = new THREE.Group()
      // the gallery camera looks at a point CTX_SIZE above the item origin: shift so that `at` is under that ray
      g.position.set(0.76 * CTX_SIZE - at.x, 0, -0.918 * CTX_SIZE - at.z)
      outer.add(g)
      const floor = (rect: readonly [number, number, number, number], color: number, y: number) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(rect[2] - rect[0], rect[3] - rect[1]), lam(color))
        m.rotation.x = -Math.PI / 2
        m.position.set((rect[0] + rect[2]) / 2, y, (rect[1] + rect[3]) / 2)
        g.add(m)
      }
      floor(L.COURTYARD, PAL.tile, 0.004)
      floor(L.WARD1, PAL.plank, 0.005)
      floor(L.WARD2, PAL.plank, 0.005)
      const anim: CtxAnim[] = []
      build(g, anim)
      outer.userData.anim = anim
      return outer
    },
    animate: (o, t) => {
      for (const a of o.userData.anim as CtxAnim[]) a.update(t)
    },
  }
}
function ctxDoctor(g: THREE.Group, x: number, z: number): void {
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.38, P.DOCTOR_HEIGHT, 10), lam(PAL.coat, { flat: false }))
  body.position.set(x, P.DOCTOR_HEIGHT / 2, z)
  g.add(body)
  const ring = makeRing()
  ring.root.position.set(x, 0, z)
  g.add(ring.root)
}
function ctxBubble(g: THREE.Group, anim: CtxAnim[], kind: Parameters<typeof makeBubble>[0], x: number, y: number, z: number, setup?: (b: Bubble) => void): void {
  const b = makeBubble(kind)
  b.root.position.set(x, y, z)
  setup?.(b)
  g.add(b.root)
  anim.push(b)
}
function ctxArrow(g: THREE.Group, anim: CtxAnim[], x: number, z: number): void {
  const a: GuideArrow = makeArrow()
  a.root.position.set(x, P.ARROW_HOVER, z)
  g.add(a.root)
  anim.push(a)
}
function ctxPad(g: THREE.Group, id: UnlockId, fill: number): void {
  const pad = makePricePad(UNLOCKS.find(u => u.id === id)!)
  pad.setFill(fill)
  g.add(pad.root)
}

export const GALLERY: GalleryItem[] = [
  { name: 'ring', size: 1.0, make: () => makeRing().root },
  { name: 'label-0of2', size: 1.2, make: label(0, 2) },
  { name: 'label-2of2-full', size: 1.2, make: label(2, 2) },
  { name: 'label-3of4', size: 1.2, make: label(3, 4) },
  {
    name: 'label-flip',
    size: 1.2,
    make: () => {
      const l = makeCapacityLabel()
      l.root.position.set(0, 0, 0)
      l.root.userData.label = l
      return l.root
    },
    animate: (o, t) => (o.userData.label as CapacityLabel).set(t % 2 < 1 ? 0 : 2, 2),
  },
  ...UNLOCKS.flatMap(def => [
    { name: `pad-${def.id}-idle`, size: 1.2, make: () => padAtOrigin(def, 0) },
    { name: `pad-${def.id}-fill50`, size: 1.2, make: () => padAtOrigin(def, 0.5) },
    { name: `pad-${def.id}-fill100`, size: 1.2, make: () => padAtOrigin(def, 1) },
  ]),
  {
    name: 'pad-anim',
    size: 1.2,
    make: () => padAtOrigin(UNLOCKS[0]!, 0),
    animate: (o, t) => {
      const pad = o.userData.pad as PricePad
      const k = t % 3
      pad.setPop(k / P.PAD_POP_TIME)
      pad.setFill(Math.min(1, Math.max(0, (k - 1) / 0.6)))
      if (k > 2.8) pad.setPop((3 - k) / 0.07)
    },
  },
  {
    name: 'dashed-circle',
    size: 3.0,
    make: () => {
      const d = makeDashedCircle()
      d.root.userData.h = d
      return d.root
    },
    animate: (o, t) => (o.userData.h as DashedCircleDecal).update(t),
  },
  { name: 'bed-outline', size: 2.0, make: () => makeBedOutline().root },
  {
    name: 'bed-outline-fade',
    size: 2.0,
    make: () => {
      const b = makeBedOutline()
      b.root.userData.h = b
      return b.root
    },
    animate: (o, t) => (o.userData.h as BedOutlineDecal).setOpacity(Math.max(0, 1 - (t % 1.2) / 0.6)),
  },
  // --- in context (see context() above) ---
  context('ctx-ward', { x: 1.6, z: 4.4 }, (g, anim) => {
    // 17.6 s of the ad: pad A between the ward-1 beds, the label, the arrow over the pallet, a bed that needs a nurse
    ctxPad(g, 'nurses', 0)
    g.add(makeCapacityLabel().root)
    ctxDoctor(g, 1.2, 2.6)
    ctxArrow(g, anim, L.PALLET.x, L.PALLET.z)
    ctxBubble(g, anim, 'nurse', BEDS[0]!.x + 0.9, 2.35, BEDS[0]!.z)
    ctxBubble(g, anim, 'cure', BEDS[1]!.x + 0.9, 2.35, BEDS[1]!.z, b => b.setProgress(0.75))
  }),
  context('ctx-cauldron', { x: -1.6, z: 0.4 }, (g, anim) => {
    // 8.6 s / 28.5 s / 30.2 s: potion request over the cauldron, pad B paid, the queue feeling sick, a full bath label
    ctxPad(g, 'usher', 1)
    const l = makeCapacityLabel()
    l.set(2, 2)
    g.add(l.root)
    ctxDoctor(g, -1.6, -1.4)
    ctxBubble(g, anim, 'potion', -0.2, 3.1, -0.4)
    for (let i = 0; i < 4; i++) ctxBubble(g, anim, 'sick', L.QUEUE_SLOT0.x + L.QUEUE_STEP.x * i, 2.5, L.QUEUE_SLOT0.z + L.QUEUE_STEP.z * i)
    ctxBubble(g, anim, 'scared', 1.6, 2.4, 2.0)
    ctxBubble(g, anim, 'happy', 2.9, 2.4, 0.6)
  }),
  context('ctx-yard', { x: 0.6, z: -6.6 }, (g, anim) => {
    // 50.2 s / 51.5 s: pad D half paid on the yard's threshold, outlines round two new beds. The 7 cm curb of the
    // threshold must not cut the pad (DECAL_LIFT); the 9 cm coin lying on it must cover it.
    ctxPad(g, 'ward2', 0.5)
    const curb = new THREE.Mesh(new THREE.BoxGeometry(5.3, 0.07, 0.2), lam(PAL.tileWarm))
    curb.position.set(-0.05, 0.035, L.WARD2[3] - 0.09)
    g.add(curb)
    const coin = new THREE.Mesh(new THREE.CylinderGeometry(P.COIN_DIAMETER / 2, P.COIN_DIAMETER / 2, P.COIN_THICKNESS, 16), lam(PAL.coin, { flat: false }))
    coin.position.set(-0.9, P.COIN_THICKNESS / 2, -5.1)
    g.add(coin)
    ctxDoctor(g, 1.6, -4.2)
    ctxArrow(g, anim, -0.9, -5.4)
    for (const i of [6, 9]) {
      const o = makeBedOutline()
      o.root.position.set(BEDS[i]!.x, 0, BEDS[i]!.z)
      g.add(o.root)
    }
  }),
  context('ctx-cart', { x: 10.4, z: -6.0 }, (g, anim) => {
    // 35.0 s: the big cart pad on the dirt north of the grinder
    ctxPad(g, 'cart', 0)
    ctxPad(g, 'driver', 0)
    ctxDoctor(g, 8.6, -4.6)
    ctxArrow(g, anim, 10.4, -6.9)
  }),
  context('ctx-drill', L.DASHED_CIRCLE, (g, anim) => {
    // 24.2-26.6 s: the dashed circle on the dirt outside ward-1's south door
    const d = makeDashedCircle()
    d.root.position.set(L.DASHED_CIRCLE.x, 0, L.DASHED_CIRCLE.z)
    g.add(d.root)
    anim.push(d)
  }),
]
