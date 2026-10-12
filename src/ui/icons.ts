// Canvas-drawn UI icons (SPEC 8) plus the shared UI font and text helpers.
//
// Everything here is an ORIGINAL drawing made of canvas paths in the bold, flat style of the ad's icons:
//   - pad icons: white silhouettes with punched holes (one per UNLOCKS[].icon)
//   - the copper coin, the bubble contents (flask, plus, check, nurse bust, three emoji)
//   - the HUD icons (person, flask, cauldron, power emblem, plague-doctor portrait)
//
// Use:
//   iconTexture('coin')              cached THREE.CanvasTexture (sRGB, straight alpha, mipmapped) for your own materials
//   iconCanvas('cart', 256)          cached canvas, e.g. to compose into another canvas with drawImage
//   paintIcon(ctx, 'coin', x, y, s)  vector-paint at any size (exact pixels, used by the DOM HUD)
//   UI_FONT / uiFontReady()          the heavy display font shared by the HUD and every canvas-drawn number
//   drawUiText(...)                  outlined text with fixed-width digits (numbers never jiggle)
import * as THREE from 'three'
import './hud.css' // registers the @font-face of the UI font (needed for canvas text even without the DOM HUD)
import { PAL, UNLOCKS, hex, type UnlockDef } from '../config'
import type { GalleryItem } from '../view/materials'

// ---------------------------------------------------------------------------------------------------------------
// Font
// ---------------------------------------------------------------------------------------------------------------

/** Family name of the vendored display font (src/ui/fonts/LilitaOne-Regular.woff2, SIL OFL 1.1). */
export const UI_FONT_FAMILY = 'Lilita One'
/** CSS font-family stack of the UI: Lilita One with heavy rounded fallbacks. Always combine with weight 900. */
export const UI_FONT = `"${UI_FONT_FAMILY}", "Arial Rounded MT Bold", "Hiragino Maru Gothic ProN", "Nunito", "Arial Black", "Helvetica Neue", Arial, sans-serif`
/** Cap height of Lilita One as a fraction of the font size (measured; used to size text by its visible height). */
export const UI_FONT_CAP = 0.71
/** Width of one digit cell as a fraction of the font size (the widest digit of Lilita One is 0.64 em). */
export const UI_DIGIT_CELL = 0.64

/** Canvas font shorthand for the UI font at `px` pixels. */
export const uiFont = (px: number) => `900 ${px}px ${UI_FONT}`

let fontPromise: Promise<boolean> | null = null
let fontSettled = false
const fontListeners: (() => void)[] = []

/**
 * Resolves once the UI font is usable for canvas text (true) or has definitely failed to load (false, the fallback
 * stack is used). Never rejects, safe to call many times. Canvas-drawn decals created earlier redraw themselves when
 * this settles, so awaiting it is optional; await it before the first frame only to avoid a one-off text swap.
 */
export function uiFontReady(): Promise<boolean> {
  if (fontPromise) return fontPromise
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts) return (fontPromise = Promise.resolve(false))
  const spec = `900 32px "${UI_FONT_FAMILY}"`
  const attempt = async (): Promise<boolean> => {
    // The stylesheet with the @font-face may be attached a moment after this module runs: retry for a while.
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fonts.load(spec, '0123456789/,')).length > 0) return true
      } catch {
        return false // the file could not be fetched or decoded
      }
      await new Promise(r => setTimeout(r, 75))
    }
    return false
  }
  fontPromise = Promise.race([attempt(), new Promise<boolean>(r => setTimeout(() => r(false), 6000))]).then(ok => {
    fontSettled = true
    digitCellCache.clear()
    if (ok) for (const f of fontListeners.splice(0)) f()
    else fontListeners.length = 0
    return ok
  })
  return fontPromise
}

/** Internal: run `redraw` once when the UI font becomes available after the caller already drew with a fallback. */
export function onUiFont(redraw: () => void): void {
  if (fontSettled) return
  fontListeners.push(redraw)
  void uiFontReady()
}

// ---------------------------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------------------------

type Ctx = CanvasRenderingContext2D
const TAU = Math.PI * 2
const isDigit = (ch: string) => ch >= '0' && ch <= '9'
const digitCellCache = new Map<string, number>()

function digitCell(c: Ctx, px: number): number {
  const k = c.font
  let w = digitCellCache.get(k)
  if (w === undefined) {
    w = 0
    for (let d = 0; d < 10; d++) w = Math.max(w, c.measureText(String(d)).width)
    if (!(w > 0)) w = px * UI_DIGIT_CELL
    digitCellCache.set(k, w)
  }
  return w
}

export interface UiTextStyle {
  /** Fill colour (default white). */
  fill?: string
  /** Outline colour (default near-black) and width in pixels on each side of the glyph edge (default px * 0.09). */
  stroke?: string
  outline?: number
  /** Extra space between characters, in em (default 0). */
  spacing?: number
  /** 'left' (default), 'center' or 'right' relative to x. */
  align?: 'left' | 'center' | 'right'
  /** Dark drop shadow offset in pixels (default 0 = none). */
  shadow?: number
  /**
   * true (default): every digit takes the same cell, so a changing number never jiggles. false: natural advances,
   * which looks tighter and is right for numbers that never change (pad prices).
   */
  tabular?: boolean
}

/** Width in pixels that drawUiText() will cover for `text` at `px`. Digits take a fixed cell unless tabular = false. */
export function measureUiText(c: Ctx, text: string, px: number, spacing = 0, tabular = true): number {
  c.font = uiFont(px)
  const cell = digitCell(c, px)
  let w = 0
  for (const ch of text) w += (tabular && isDigit(ch) ? cell : c.measureText(ch).width) + spacing * px
  return w - spacing * px
}

/**
 * Draw heavy outlined UI text whose digits all take the same width (tabular, see UiTextStyle.tabular), baseline at y.
 * Returns the width drawn. All outlines are painted before all fills, so neighbours never eat into each other.
 */
export function drawUiText(c: Ctx, text: string, x: number, y: number, px: number, style: UiTextStyle = {}): number {
  const spacing = style.spacing ?? 0
  const tabular = style.tabular ?? true
  const w = measureUiText(c, text, px, spacing, tabular)
  const cell = digitCell(c, px)
  const outline = style.outline ?? px * 0.09
  let x0 = x
  if (style.align === 'center') x0 = x - w / 2
  else if (style.align === 'right') x0 = x - w
  c.save()
  c.font = uiFont(px)
  c.textAlign = 'center'
  c.textBaseline = 'alphabetic'
  c.lineJoin = 'round'
  c.miterLimit = 2
  for (let pass = 0; pass < 3; pass++) {
    if (pass === 0 && !style.shadow) continue
    if (pass < 2 && outline <= 0) continue
    let cx = x0
    for (const ch of text) {
      const adv = tabular && isDigit(ch) ? cell : c.measureText(ch).width
      const gx = cx + adv / 2
      if (pass === 0) {
        c.strokeStyle = 'rgba(0,0,0,0.45)'
        c.lineWidth = outline * 2
        c.strokeText(ch, gx, y + (style.shadow ?? 0))
      } else if (pass === 1) {
        c.strokeStyle = style.stroke ?? '#15151a'
        c.lineWidth = outline * 2
        c.strokeText(ch, gx, y)
      } else {
        c.fillStyle = style.fill ?? '#ffffff'
        c.fillText(ch, gx, y)
      }
      cx += adv + spacing * px
    }
  }
  c.restore()
  return w
}

// ---------------------------------------------------------------------------------------------------------------
// Icon painters. Every painter draws inside the box [-1, 1] x [-1, 1] (y down) around the origin.
// ---------------------------------------------------------------------------------------------------------------

export type PadIconName = UnlockDef['icon']
export type IconName =
  | PadIconName
  | 'coin' // copper coin with a swirl emboss (pads, HUD coin cell)
  | 'person' // pale bust for the capacity label
  | 'flask' // blue round flask with an orange cork (bubble content, HUD)
  | 'plus' // white plus (cure bubble)
  | 'check' // white check mark (cure bubble)
  | 'nurseBust' // maroon-haired nurse bust with cap and a small plus (needs-nurse bubble)
  | 'sick' // green nauseated emoji
  | 'scared' // blue/yellow scared emoji
  | 'happy' // orange grinning emoji
  | 'tick' // red slanted "!" tick of alert bubbles (points up)
  | 'hudPerson' // gold bust (HUD cell 1: discharged / total)
  | 'hudPotion' // small cauldron with cyan potion (HUD cell 3)
  | 'hudPower' // gold shield with crossed blades (HUD power pill)
  | 'portrait' // plague-doctor bust on a blue background (HUD portrait tile, fills the whole box)

const WHITE = '#ffffff'
const INK = '#1b1a20'
/** Drawing-only shades that are not gameplay colours (those come from PAL). */
const C = {
  copperEdge: '#231512', copperShine: '#ffeedd', copperHi: '#eea183', copperLo: '#ac4e36', copperPit: '#8a351b', copperPitLo: '#a85c3c', copperGlyph: '#f4bb8c',
  flaskBlue: '#1479ee', flaskBlueHi: '#58b4ff', flaskBlueLo: '#0b4fc0', glass: '#d9f0ff', cork: '#f0862e', corkDark: '#c4541f',
  nurseHair: '#8b4a2f', nurseInk: '#4b2318',
  sick: '#84dd49', sickHi: '#b3f26a', sickLo: '#5cbb31', sickInk: '#1f5a1c', tongue: '#e65463', mouth: '#3b1b1e',
  scaredTop: '#8fc8ec', scaredBot: '#f8d37d', hand: '#fbd581', handInk: '#cf9440', faceInk: '#5b3d22',
  happyHi: '#ffe07a', happy: '#f7b750', blush: '#f08a6a',
  goldHi: '#fbe38a', gold: '#e8b947', goldLo: '#b9822a', goldInk: '#553a12',
  tickHi: '#ff5468', tick: '#e62c47',
} as const

function circle(c: Ctx, x: number, y: number, r: number): void {
  c.beginPath()
  c.arc(x, y, r, 0, TAU)
}
function ellipse(c: Ctx, x: number, y: number, rx: number, ry: number, rot = 0): void {
  c.beginPath()
  c.ellipse(x, y, rx, ry, rot, 0, TAU)
}
/** Rounded rectangle path (begins a new path). */
export function roundRect(c: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.min(r, w / 2, h / 2)
  c.beginPath()
  c.moveTo(x + r, y)
  c.arcTo(x + w, y, x + w, y + h, r)
  c.arcTo(x + w, y + h, x, y + h, r)
  c.arcTo(x, y + h, x, y, r)
  c.arcTo(x, y, x + w, y, r)
  c.closePath()
}
function poly(c: Ctx, pts: number[]): void {
  c.beginPath()
  c.moveTo(pts[0]!, pts[1]!)
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i]!, pts[i + 1]!)
  c.closePath()
}
/** Cog wheel outline with square teeth. */
function gear(c: Ctx, x: number, y: number, r: number, teeth: number, depth = 0.24, phase = 0): void {
  const n = teeth * 4
  c.beginPath()
  for (let i = 0; i < n; i++) {
    const a = phase + ((i - 0.5) / n) * TAU
    const rr = i % 4 < 2 ? r : r * (1 - depth)
    const px = x + Math.cos(a) * rr
    const py = y + Math.sin(a) * rr
    if (i === 0) c.moveTo(px, py)
    else c.lineTo(px, py)
  }
  c.closePath()
}
/** Plus sign with rounded arms centred at (x, y); a = half length, t = half thickness. */
function plus(c: Ctx, x: number, y: number, a: number, t: number, r = t * 0.35): void {
  c.beginPath()
  const p = [
    [-t, -a], [t, -a], [t, -t], [a, -t], [a, t], [t, t], [t, a], [-t, a], [-t, t], [-a, t], [-a, -t], [-t, -t],
  ] as const
  // rounded outer corners via arcTo
  const n = p.length
  c.moveTo(x + (p[n - 1]![0] + p[0]![0]) / 2, y + (p[n - 1]![1] + p[0]![1]) / 2)
  for (let i = 0; i < n; i++) {
    const a0 = p[i]!
    const a1 = p[(i + 1) % n]!
    c.arcTo(x + a0[0], y + a0[1], x + (a0[0] + a1[0]) / 2, y + (a0[1] + a1[1]) / 2, r)
  }
  c.closePath()
}
/** Chunky up-arrow (upgrade marker) centred at (x, y) with total height h. */
function upArrow(c: Ctx, x: number, y: number, h: number): void {
  const w = h * 0.5
  const s = h * 0.17
  c.beginPath()
  c.moveTo(x, y - h / 2)
  c.lineTo(x + w, y - h * 0.02)
  c.lineTo(x + s, y - h * 0.02)
  c.lineTo(x + s, y + h / 2)
  c.lineTo(x - s, y + h / 2)
  c.lineTo(x - s, y - h * 0.02)
  c.lineTo(x - w, y - h * 0.02)
  c.closePath()
}
const hole = (c: Ctx, on: boolean) => (c.globalCompositeOperation = on ? 'destination-out' : 'source-over')
function softJoin(c: Ctx, w: number, color: string): void {
  c.lineJoin = 'round'
  c.lineCap = 'round'
  c.lineWidth = w
  c.strokeStyle = color
}

// --- pad icons (white silhouettes; holes are punched so the floor shows through) -------------------------------

function padNurse(c: Ctx): void {
  // The ad's nurse / usher pad icon (17.6 s, 27.2 s): a bell of hair with flicked tips, a big face punched out of it
  // and drawn as a thin ring that hangs a little below the hair, and a dark dome cap carrying a small plus.
  c.fillStyle = WHITE
  const face = (grow: number) => {
    c.beginPath()
    c.moveTo(-0.47 - grow, -0.02)
    c.bezierCurveTo(-0.24, -0.2 - grow, 0.24, -0.2 - grow, 0.47 + grow, -0.02)
    c.bezierCurveTo(0.54 + grow, 0.5, 0.3, 0.92 + grow, 0, 0.92 + grow)
    c.bezierCurveTo(-0.3, 0.92 + grow, -0.54 - grow, 0.5, -0.47 - grow, -0.02)
    c.closePath()
  }
  // hair: narrow under the cap, widening to two flicked feet
  c.beginPath()
  c.moveTo(0, -0.6)
  c.bezierCurveTo(0.5, -0.6, 0.7, -0.3, 0.72, 0.1)
  c.bezierCurveTo(0.74, 0.42, 0.8, 0.62, 0.99, 0.74)
  c.bezierCurveTo(0.88, 0.96, 0.68, 0.98, 0.58, 0.82)
  c.bezierCurveTo(0.5, 0.96, 0.38, 0.94, 0.34, 0.76)
  c.lineTo(-0.34, 0.76)
  c.bezierCurveTo(-0.38, 0.94, -0.5, 0.96, -0.58, 0.82)
  c.bezierCurveTo(-0.68, 0.98, -0.88, 0.96, -0.99, 0.74)
  c.bezierCurveTo(-0.8, 0.62, -0.74, 0.42, -0.72, 0.1)
  c.bezierCurveTo(-0.7, -0.3, -0.5, -0.6, 0, -0.6)
  c.closePath()
  c.fill()
  // face: white ring, dark inside
  face(0.05)
  c.fill()
  hole(c, true)
  face(0)
  c.fill()
  hole(c, false)
  // cap: white-edged dome, dark inside, white plus
  const dome = (inset: number) => {
    c.beginPath()
    c.moveTo(-0.56 + inset, -0.46 - inset * 0.7)
    c.bezierCurveTo(-0.58 + inset, -0.84 + inset * 0.3, -0.3, -1.0 + inset, 0, -1.0 + inset)
    c.bezierCurveTo(0.3, -1.0 + inset, 0.58 - inset, -0.84 + inset * 0.3, 0.56 - inset, -0.46 - inset * 0.7)
    c.bezierCurveTo(0.3, -0.36 - inset, -0.3, -0.36 - inset, -0.56 + inset, -0.46 - inset * 0.7)
    c.closePath()
  }
  dome(0)
  c.fill()
  hole(c, true)
  dome(0.07)
  c.fill()
  hole(c, false)
  plus(c, 0, -0.69, 0.15, 0.05, 0.01)
  c.fill()
}

function padCart(c: Ctx): void {
  // The ad's cart pad icon (35.0 s): a little bulldozer seen from the side, facing right, about 1.6 times as long
  // as it is tall. Cab frame with a slanted window at the back, a low hood with an exhaust stub, two cog wheels
  // (the rear one bigger) and a fin-shaped blade at the front.
  c.fillStyle = WHITE
  softJoin(c, 0.045, WHITE)
  // cab frame
  poly(c, [-0.78, -0.62, -0.16, -0.62, -0.05, -0.16, -0.78, -0.16])
  c.fill()
  c.stroke()
  // hood and chassis
  poly(c, [-0.82, -0.2, 0.5, -0.2, 0.56, -0.1, 0.56, 0.28, -0.82, 0.28])
  c.fill()
  c.stroke()
  // exhaust stub
  roundRect(c, 0.1, -0.4, 0.09, 0.24, 0.02)
  c.fill()
  // blade: a fin whose point digs in ahead of the front wheel
  c.beginPath()
  c.moveTo(0.54, -0.04)
  c.bezierCurveTo(0.76, -0.02, 0.96, 0.24, 1.0, 0.64)
  c.bezierCurveTo(0.88, 0.46, 0.74, 0.34, 0.54, 0.3)
  c.closePath()
  c.fill()
  c.stroke()
  hole(c, true)
  // window
  poly(c, [-0.66, -0.5, -0.27, -0.5, -0.2, -0.2, -0.66, -0.2])
  c.fill()
  // wheel wells, so the cogs read as separate shapes
  circle(c, -0.64, 0.31, 0.385)
  c.fill()
  circle(c, 0.22, 0.37, 0.325)
  c.fill()
  hole(c, false)
  // cog wheels: rings with fine teeth
  gear(c, -0.64, 0.31, 0.335, 12, 0.14)
  c.fill()
  gear(c, 0.22, 0.37, 0.275, 11, 0.15, 0.3)
  c.fill()
  hole(c, true)
  circle(c, -0.64, 0.31, 0.15)
  c.fill()
  circle(c, 0.22, 0.37, 0.125)
  c.fill()
  hole(c, false)
}

function padWard(c: Ctx): void {
  // The ad's ward pad icon (50.2 s): a house with a second roof line floating above it, a rounded cross punched out
  // of the wall, and a small up-arrow standing at its right. About 1.3 times as wide as it is tall.
  c.fillStyle = WHITE
  // outer roof chevron
  c.lineCap = 'butt'
  c.lineJoin = 'miter'
  c.miterLimit = 4
  c.lineWidth = 0.13
  c.strokeStyle = WHITE
  c.beginPath()
  c.moveTo(-1.0, -0.07)
  c.lineTo(-0.3, -0.72)
  c.lineTo(0.5, 0.0)
  c.stroke()
  // house body
  poly(c, [-0.3, -0.45, 0.32, 0.12, 0.32, 0.74, -0.88, 0.74, -0.88, 0.12])
  softJoin(c, 0.05, WHITE)
  c.fill()
  c.stroke()
  // rounded cross
  hole(c, true)
  softJoin(c, 0.24, WHITE)
  c.beginPath()
  c.moveTo(-0.29, 0.06)
  c.lineTo(-0.29, 0.5)
  c.moveTo(-0.51, 0.28)
  c.lineTo(-0.07, 0.28)
  c.stroke()
  hole(c, false)
  // upgrade arrow at the lower right
  upArrow(c, 0.74, 0.36, 0.8)
  c.fill()
}

function padPorter(c: Ctx): void {
  c.fillStyle = WHITE
  // head and body of the carrier
  circle(c, -0.38, -0.56, 0.3)
  c.fill()
  c.beginPath()
  c.moveTo(-0.92, 0.96)
  c.bezierCurveTo(-0.96, 0.3, -0.74, -0.14, -0.38, -0.14)
  c.bezierCurveTo(-0.02, -0.14, 0.14, 0.3, 0.12, 0.96)
  c.closePath()
  c.fill()
  // the flask he carries: clear a gap, then draw it
  hole(c, true)
  circle(c, 0.42, 0.3, 0.56)
  c.fill()
  roundRect(c, 0.16, -0.5, 0.52, 0.5, 0.06)
  c.fill()
  hole(c, false)
  circle(c, 0.42, 0.34, 0.46)
  c.fill()
  roundRect(c, 0.28, -0.3, 0.28, 0.34, 0.04)
  c.fill()
  roundRect(c, 0.2, -0.44, 0.44, 0.17, 0.06)
  c.fill()
  hole(c, true)
  c.beginPath()
  c.arc(0.42, 0.34, 0.31, 0.08, Math.PI - 0.08)
  c.closePath()
  c.fill()
  hole(c, false)
  // arm reaching to the flask
  softJoin(c, 0.16, WHITE)
  c.beginPath()
  c.moveTo(-0.36, 0.2)
  c.lineTo(0.04, 0.42)
  c.stroke()
}

function padChest(c: Ctx): void {
  c.fillStyle = WHITE
  // coin popping out
  circle(c, 0.3, -0.56, 0.36)
  c.fill()
  hole(c, true)
  circle(c, 0.3, -0.56, 0.2)
  softJoin(c, 0.08, WHITE)
  c.stroke()
  // gap between coin and lid
  c.beginPath()
  c.moveTo(-0.92, 0.06)
  c.bezierCurveTo(-0.92, -0.52, 0.92, -0.52, 0.92, 0.06)
  c.lineTo(0.92, 0.3)
  c.lineTo(-0.92, 0.3)
  c.closePath()
  c.fill()
  hole(c, false)
  // lid
  c.beginPath()
  c.moveTo(-0.82, 0.12)
  c.bezierCurveTo(-0.82, -0.4, 0.82, -0.4, 0.82, 0.12)
  c.closePath()
  c.fill()
  // body
  roundRect(c, -0.82, 0.22, 1.64, 0.72, 0.1)
  c.fill()
  // lock
  hole(c, true)
  roundRect(c, -0.14, 0.14, 0.28, 0.36, 0.08)
  c.fill()
  hole(c, false)
  roundRect(c, -0.06, 0.24, 0.12, 0.16, 0.04)
  c.fill()
}

function padCauldron(c: Ctx): void {
  c.fillStyle = WHITE
  // bowl
  c.beginPath()
  c.moveTo(-0.9, -0.02)
  c.bezierCurveTo(-0.9, 0.62, -0.56, 0.82, -0.2, 0.82)
  c.bezierCurveTo(0.16, 0.82, 0.5, 0.62, 0.5, -0.02)
  c.closePath()
  c.fill()
  // rim
  roundRect(c, -1.0, -0.2, 1.6, 0.2, 0.1)
  c.fill()
  hole(c, true)
  roundRect(c, -0.78, 0.0, 1.16, 0.07, 0.03)
  c.fill()
  hole(c, false)
  // feet
  poly(c, [-0.66, 0.66, -0.5, 0.74, -0.66, 0.98, -0.8, 0.98])
  c.fill()
  poly(c, [0.26, 0.66, 0.1, 0.74, 0.26, 0.98, 0.4, 0.98])
  c.fill()
  // bubbles
  circle(c, -0.5, -0.5, 0.17)
  c.fill()
  circle(c, -0.12, -0.72, 0.12)
  c.fill()
  circle(c, -0.1, -0.38, 0.09)
  c.fill()
  upArrow(c, 0.62, -0.5, 0.8)
  c.fill()
}

function padDrill(c: Ctx): void {
  c.fillStyle = WHITE
  // cone
  poly(c, [-0.34, -0.5, 0.98, 0.14, -0.34, 0.74])
  softJoin(c, 0.06, WHITE)
  c.fill()
  c.stroke()
  // housing
  roundRect(c, -0.98, -0.3, 0.6, 0.86, 0.1)
  c.fill()
  // spiral grooves
  hole(c, true)
  softJoin(c, 0.085, WHITE)
  for (const x of [-0.08, 0.24, 0.54]) {
    const half = (0.98 - x) * 0.47
    c.beginPath()
    c.moveTo(x + 0.08, 0.14 - half)
    c.lineTo(x - 0.08, 0.14 + half)
    c.stroke()
  }
  // wheel well
  circle(c, -0.62, 0.62, 0.42)
  c.fill()
  hole(c, false)
  circle(c, -0.62, 0.62, 0.34)
  c.fill()
  hole(c, true)
  circle(c, -0.62, 0.62, 0.13)
  c.fill()
  hole(c, false)
  upArrow(c, 0.56, -0.56, 0.84)
  c.fill()
}

function padDriver(c: Ctx): void {
  c.fillStyle = WHITE
  // driver: head with a flat cap, torso
  circle(c, -0.3, -0.56, 0.25)
  c.fill()
  c.beginPath()
  c.moveTo(-0.6, -0.62)
  c.bezierCurveTo(-0.6, -0.98, -0.02, -0.98, 0.0, -0.66)
  c.lineTo(0.22, -0.62)
  c.lineTo(0.22, -0.54)
  c.lineTo(-0.6, -0.54)
  c.closePath()
  hole(c, true)
  softJoin(c, 0.07, WHITE)
  c.stroke()
  hole(c, false)
  c.fill()
  c.beginPath()
  c.moveTo(-0.7, 0.2)
  c.bezierCurveTo(-0.7, -0.14, -0.56, -0.26, -0.3, -0.26)
  c.bezierCurveTo(-0.04, -0.26, 0.08, -0.14, 0.1, 0.2)
  c.closePath()
  c.fill()
  // lever
  softJoin(c, 0.11, WHITE)
  c.beginPath()
  c.moveTo(-0.16, -0.02)
  c.lineTo(0.4, -0.2)
  c.lineTo(0.46, 0.2)
  c.stroke()
  // chassis
  roundRect(c, -0.92, 0.14, 1.62, 0.26, 0.07)
  c.fill()
  // blade
  c.beginPath()
  c.moveTo(1.0, -0.22)
  c.quadraticCurveTo(0.72, 0.3, 1.0, 0.82)
  c.lineTo(0.8, 0.82)
  c.quadraticCurveTo(0.56, 0.3, 0.84, -0.22)
  c.closePath()
  c.fill()
  // wheels
  hole(c, true)
  circle(c, -0.5, 0.6, 0.4)
  c.fill()
  circle(c, 0.3, 0.6, 0.4)
  c.fill()
  hole(c, false)
  gear(c, -0.5, 0.6, 0.34, 7)
  c.fill()
  gear(c, 0.3, 0.6, 0.34, 7, 0.24, 0.3)
  c.fill()
  hole(c, true)
  circle(c, -0.5, 0.6, 0.12)
  c.fill()
  circle(c, 0.3, 0.6, 0.12)
  c.fill()
  hole(c, false)
}

function person(c: Ctx, color: string): void {
  c.fillStyle = color
  circle(c, 0, -0.46, 0.36)
  c.fill()
  c.beginPath()
  c.moveTo(-0.78, 0.92)
  c.bezierCurveTo(-0.78, 0.34, -0.5, 0.06, 0, 0.06)
  c.bezierCurveTo(0.5, 0.06, 0.78, 0.34, 0.78, 0.92)
  c.closePath()
  c.fill()
}

// --- coloured icons ---------------------------------------------------------------------------------------------

function coin(c: Ctx): void {
  // The ad's coin (HUD and pads): thin dark edge, a broad pale copper rim lit from above, a dark sunken centre and
  // a raised comma-shaped glyph in it.
  circle(c, 0, 0, 0.97)
  c.fillStyle = C.copperEdge
  c.fill()
  const rim = c.createLinearGradient(0, -0.9, 0, 0.9)
  rim.addColorStop(0, C.copperShine)
  rim.addColorStop(0.3, C.copperHi)
  rim.addColorStop(0.72, hex(PAL.copper))
  rim.addColorStop(1, C.copperLo)
  circle(c, 0, 0, 0.88)
  c.fillStyle = rim
  c.fill()
  // sunken centre, darkest under the upper lip
  const pit = c.createLinearGradient(0, -0.6, 0, 0.6)
  pit.addColorStop(0, C.copperPit)
  pit.addColorStop(1, C.copperPitLo)
  circle(c, 0, 0.02, 0.6)
  c.fillStyle = pit
  c.fill()
  c.lineWidth = 0.05
  c.strokeStyle = 'rgba(255,226,205,0.5)'
  c.beginPath()
  c.arc(0, 0.02, 0.6, 0.5, 2.64)
  c.stroke()
  // glyph: a fat comma (round head, tail sweeping to the lower left) with a pin-hole
  const comma = () => {
    c.beginPath()
    c.arc(0.06, -0.04, 0.3, -2.5, 1.05)
    c.bezierCurveTo(-0.06, 0.34, -0.3, 0.34, -0.44, 0.22)
    c.bezierCurveTo(-0.3, 0.12, -0.24, 0.0, -0.18, -0.22)
    c.closePath()
  }
  c.save()
  c.translate(0.02, 0.06)
  comma()
  c.fillStyle = C.copperEdge
  c.globalAlpha = 0.45
  c.fill()
  c.restore()
  comma()
  c.fillStyle = C.copperGlyph
  c.fill()
  circle(c, 0.1, -0.03, 0.065)
  c.fillStyle = C.copperPit
  c.fill()
}

function flask(c: Ctx): void {
  c.save()
  c.rotate(0.42)
  c.translate(0, 0.06)
  const R = 0.6
  const cy = 0.26
  // cork / flared lip
  c.beginPath()
  c.moveTo(-0.3, -0.9)
  c.lineTo(0.3, -0.9)
  c.lineTo(0.19, -0.56)
  c.lineTo(-0.19, -0.56)
  c.closePath()
  softJoin(c, 0.07, C.corkDark)
  c.fillStyle = C.cork
  c.stroke()
  c.fill()
  ellipse(c, 0, -0.88, 0.27, 0.08)
  c.fillStyle = C.corkDark
  c.fill()
  // glass: neck and bulb
  c.fillStyle = C.glass
  softJoin(c, 0.09, '#f4fbff')
  c.beginPath()
  c.moveTo(-0.17, -0.6)
  c.lineTo(0.17, -0.6)
  c.lineTo(0.17, -0.28)
  c.arc(0, cy, R, -Math.PI / 2 + 0.29, Math.PI * 1.5 - 0.29)
  c.closePath()
  c.stroke()
  c.fill()
  // liquid
  c.save()
  circle(c, 0, cy, R - 0.035)
  c.clip()
  c.rotate(-0.42)
  const g = c.createLinearGradient(0, -0.3, 0, 1.0)
  g.addColorStop(0, C.flaskBlueHi)
  g.addColorStop(0.3, C.flaskBlue)
  g.addColorStop(1, C.flaskBlueLo)
  c.fillStyle = g
  c.fillRect(-1.2, -0.1, 2.4, 2)
  c.fillStyle = 'rgba(170,225,255,0.85)'
  ellipse(c, 0.1, -0.09, 0.75, 0.07)
  c.fill()
  c.restore()
  // highlights
  softJoin(c, 0.09, 'rgba(255,255,255,0.85)')
  c.beginPath()
  c.arc(0, cy, R - 0.17, Math.PI * 1.02, Math.PI * 1.3)
  c.stroke()
  circle(c, 0.24, cy + 0.26, 0.07)
  c.fillStyle = 'rgba(255,255,255,0.5)'
  c.fill()
  c.restore()
}

function plusIcon(c: Ctx): void {
  c.save()
  c.translate(0, 0.035)
  plus(c, 0, 0, 0.74, 0.25, 0.05)
  c.fillStyle = 'rgba(60,20,10,0.25)'
  c.fill()
  c.restore()
  plus(c, 0, 0, 0.74, 0.25, 0.05)
  c.fillStyle = '#f1efe9'
  c.fill()
}

function checkIcon(c: Ctx): void {
  const path = () => {
    c.beginPath()
    c.moveTo(-0.62, 0.02)
    c.lineTo(-0.2, 0.44)
    c.lineTo(0.66, -0.42)
  }
  c.lineJoin = 'miter'
  c.lineCap = 'butt'
  c.lineWidth = 0.36
  c.save()
  c.translate(0, 0.05)
  c.strokeStyle = 'rgba(10,80,20,0.3)'
  path()
  c.stroke()
  c.restore()
  c.strokeStyle = '#f1efe9'
  path()
  c.stroke()
}

function nurseBust(c: Ctx): void {
  const cream = hex(PAL.cream)
  // hair
  c.beginPath()
  c.moveTo(-0.08, -0.56)
  c.bezierCurveTo(0.42, -0.58, 0.58, -0.2, 0.54, 0.16)
  c.bezierCurveTo(0.52, 0.42, 0.62, 0.56, 0.8, 0.62)
  c.bezierCurveTo(0.56, 0.84, 0.3, 0.82, 0.2, 0.7)
  c.lineTo(-0.36, 0.7)
  c.bezierCurveTo(-0.46, 0.82, -0.72, 0.84, -0.96, 0.62)
  c.bezierCurveTo(-0.78, 0.56, -0.68, 0.42, -0.7, 0.16)
  c.bezierCurveTo(-0.74, -0.2, -0.58, -0.58, -0.08, -0.56)
  c.closePath()
  c.fillStyle = C.nurseHair
  softJoin(c, 0.07, C.nurseInk)
  c.fill()
  c.stroke()
  // face and neck
  c.beginPath()
  c.moveTo(-0.46, 0.0)
  c.bezierCurveTo(-0.3, -0.16, 0.1, -0.2, 0.3, 0.0)
  c.bezierCurveTo(0.34, 0.34, 0.16, 0.56, -0.08, 0.56)
  c.bezierCurveTo(-0.32, 0.56, -0.5, 0.34, -0.46, 0.0)
  c.closePath()
  c.fillStyle = cream
  c.fill()
  roundRect(c, -0.22, 0.5, 0.28, 0.3, 0.06)
  c.fill()
  // cap with cross
  c.beginPath()
  c.moveTo(-0.56, -0.44)
  c.bezierCurveTo(-0.56, -0.8, -0.32, -0.96, -0.08, -0.96)
  c.bezierCurveTo(0.16, -0.96, 0.4, -0.8, 0.4, -0.44)
  c.bezierCurveTo(0.18, -0.56, -0.34, -0.56, -0.56, -0.44)
  c.closePath()
  c.fillStyle = '#fffaf2'
  softJoin(c, 0.075, C.nurseInk)
  c.fill()
  c.stroke()
  plus(c, -0.08, -0.72, 0.14, 0.05, 0.01)
  c.fillStyle = C.nurseInk
  c.fill()
  // small plus at the lower right
  plus(c, 0.62, 0.56, 0.3, 0.1, 0.03)
  softJoin(c, 0.13, C.nurseInk)
  c.stroke()
  c.fillStyle = '#fffaf2'
  c.fill()
}

function emojiHands(c: Ctx, y: number): void {
  for (const s of [-1, 1]) {
    c.save()
    c.translate(s * 0.66, y)
    c.rotate(s * -0.16)
    roundRect(c, -0.2, -0.36, 0.4, 0.86, 0.18)
    c.fillStyle = C.hand
    softJoin(c, 0.035, C.handInk)
    c.stroke()
    c.fill()
    c.restore()
  }
}

function sick(c: Ctx): void {
  const g = c.createRadialGradient(-0.25, -0.35, 0.1, 0, 0, 0.95)
  g.addColorStop(0, C.sickHi)
  g.addColorStop(0.55, C.sick)
  g.addColorStop(1, C.sickLo)
  circle(c, 0, 0, 0.92)
  c.fillStyle = g
  c.fill()
  softJoin(c, 0.045, 'rgba(40,110,30,0.7)')
  c.stroke()
  // brows
  softJoin(c, 0.07, C.sickInk)
  c.beginPath()
  c.moveTo(-0.62, -0.52)
  c.lineTo(-0.3, -0.62)
  c.moveTo(0.56, -0.52)
  c.lineTo(0.26, -0.62)
  c.stroke()
  // X eyes
  softJoin(c, 0.11, C.sickInk)
  for (const x of [-0.38, 0.34]) {
    c.beginPath()
    c.moveTo(x - 0.15, -0.36)
    c.lineTo(x + 0.15, -0.08)
    c.moveTo(x + 0.15, -0.36)
    c.lineTo(x - 0.15, -0.08)
    c.stroke()
  }
  // sweat drop
  c.beginPath()
  c.moveTo(0.7, -0.52)
  c.bezierCurveTo(0.82, -0.36, 0.84, -0.22, 0.7, -0.2)
  c.bezierCurveTo(0.56, -0.22, 0.58, -0.36, 0.7, -0.52)
  c.fillStyle = '#bfeaff'
  c.fill()
  // wide open mouth
  c.beginPath()
  c.moveTo(-0.52, 0.3)
  c.bezierCurveTo(-0.4, 0.06, 0.4, 0.06, 0.52, 0.3)
  c.bezierCurveTo(0.6, 0.56, 0.36, 0.7, 0, 0.7)
  c.bezierCurveTo(-0.36, 0.7, -0.6, 0.56, -0.52, 0.3)
  c.closePath()
  c.fillStyle = C.mouth
  c.fill()
  // tongue lolling out to the left
  c.beginPath()
  c.moveTo(-0.4, 0.4)
  c.bezierCurveTo(-0.16, 0.26, 0.1, 0.34, 0.16, 0.5)
  c.bezierCurveTo(0.14, 0.76, -0.1, 0.88, -0.28, 0.84)
  c.bezierCurveTo(-0.46, 0.78, -0.52, 0.56, -0.4, 0.4)
  c.closePath()
  c.fillStyle = C.tongue
  c.fill()
  softJoin(c, 0.03, 'rgba(150,30,50,0.6)')
  c.beginPath()
  c.moveTo(-0.14, 0.48)
  c.lineTo(-0.2, 0.7)
  c.stroke()
}

function scared(c: Ctx): void {
  const g = c.createLinearGradient(0, -0.9, 0, 0.9)
  g.addColorStop(0, C.scaredTop)
  g.addColorStop(0.32, '#a9d3e6')
  g.addColorStop(0.62, '#f3dc98')
  g.addColorStop(1, C.scaredBot)
  circle(c, 0, 0, 0.9)
  c.fillStyle = g
  c.fill()
  softJoin(c, 0.045, 'rgba(120,110,90,0.55)')
  c.stroke()
  // worried brows
  softJoin(c, 0.075, C.faceInk)
  c.beginPath()
  c.moveTo(-0.52, -0.5)
  c.quadraticCurveTo(-0.3, -0.66, -0.16, -0.62)
  c.moveTo(0.52, -0.5)
  c.quadraticCurveTo(0.3, -0.66, 0.16, -0.62)
  c.stroke()
  // small startled eyes
  for (const x of [-0.3, 0.3]) {
    ellipse(c, x, -0.24, 0.13, 0.15)
    c.fillStyle = WHITE
    c.fill()
    softJoin(c, 0.03, C.faceInk)
    c.stroke()
    circle(c, x + 0.02, -0.22, 0.06)
    c.fillStyle = INK
    c.fill()
  }
  // screaming mouth
  c.beginPath()
  c.moveTo(-0.26, 0.16)
  c.bezierCurveTo(-0.14, 0.04, 0.14, 0.04, 0.26, 0.16)
  c.bezierCurveTo(0.36, 0.44, 0.34, 0.76, 0, 0.78)
  c.bezierCurveTo(-0.34, 0.76, -0.36, 0.44, -0.26, 0.16)
  c.closePath()
  c.fillStyle = '#4a2420'
  c.fill()
  c.save()
  c.clip()
  ellipse(c, 0, 0.8, 0.26, 0.2)
  c.fillStyle = '#d9566a'
  c.fill()
  c.fillStyle = WHITE
  c.fillRect(-0.3, 0.02, 0.6, 0.15)
  c.restore()
  emojiHands(c, 0.36)
}

function happy(c: Ctx): void {
  const g = c.createLinearGradient(0, -0.9, 0, 0.9)
  g.addColorStop(0, C.happyHi)
  g.addColorStop(0.45, '#fbc864')
  g.addColorStop(1, '#f2a052')
  circle(c, 0, 0, 0.9)
  c.fillStyle = g
  c.fill()
  softJoin(c, 0.045, 'rgba(160,100,30,0.55)')
  c.stroke()
  // blush
  c.fillStyle = 'rgba(240,120,90,0.45)'
  ellipse(c, -0.56, 0.06, 0.2, 0.13)
  c.fill()
  ellipse(c, 0.56, 0.06, 0.2, 0.13)
  c.fill()
  // closed smiling eyes
  softJoin(c, 0.1, C.faceInk)
  for (const x of [-0.32, 0.32]) {
    c.beginPath()
    c.arc(x, -0.2, 0.17, Math.PI * 1.08, Math.PI * 1.92)
    c.stroke()
  }
  // grin
  c.beginPath()
  c.moveTo(-0.5, 0.1)
  c.lineTo(0.5, 0.1)
  c.bezierCurveTo(0.48, 0.52, 0.26, 0.7, 0, 0.7)
  c.bezierCurveTo(-0.26, 0.7, -0.48, 0.52, -0.5, 0.1)
  c.closePath()
  c.fillStyle = '#7a2a22'
  c.fill()
  c.save()
  c.clip()
  c.fillStyle = WHITE
  c.fillRect(-0.6, 0.08, 1.2, 0.16)
  ellipse(c, 0, 0.72, 0.3, 0.2)
  c.fillStyle = '#ee7480'
  c.fill()
  c.restore()
  emojiHands(c, 0.4)
}

/**
 * Slanted red tick of the alert bubbles: a tapered bar, drawn pointing up (the wide end is at the top). In the ad it
 * is the stroke of a "!" whose narrow end runs into the bubble; no dot is visible.
 */
function tick(c: Ctx): void {
  c.beginPath()
  c.moveTo(-0.3, -0.88)
  c.lineTo(0.3, -0.88)
  c.lineTo(0.15, 0.86)
  c.lineTo(-0.15, 0.86)
  c.closePath()
  softJoin(c, 0.14, hex(PAL.alertRed))
  c.stroke()
  const g = c.createLinearGradient(0, -0.9, 0, 0.86)
  g.addColorStop(0, C.tickHi)
  g.addColorStop(1, C.tick)
  c.fillStyle = g
  c.fill()
}

function hudPerson(c: Ctx): void {
  const g = c.createLinearGradient(0, -0.9, 0, 0.9)
  g.addColorStop(0, C.goldHi)
  g.addColorStop(0.6, C.gold)
  g.addColorStop(1, C.goldLo)
  softJoin(c, 0.2, C.goldInk)
  circle(c, 0, -0.44, 0.34)
  c.stroke()
  c.beginPath()
  c.moveTo(-0.74, 0.86)
  c.bezierCurveTo(-0.74, 0.34, -0.48, 0.1, 0, 0.1)
  c.bezierCurveTo(0.48, 0.1, 0.74, 0.34, 0.74, 0.86)
  c.closePath()
  c.stroke()
  c.fillStyle = g
  c.fill()
  circle(c, 0, -0.44, 0.34)
  c.fill()
  // highlight
  softJoin(c, 0.07, 'rgba(255,250,210,0.75)')
  c.beginPath()
  c.arc(0, -0.44, 0.22, Math.PI * 1.05, Math.PI * 1.5)
  c.stroke()
  c.beginPath()
  c.moveTo(-0.56, 0.6)
  c.bezierCurveTo(-0.54, 0.36, -0.36, 0.26, -0.14, 0.24)
  c.stroke()
}

function hudPotion(c: Ctx): void {
  // bubbles rising
  c.fillStyle = hex(PAL.potion)
  softJoin(c, 0.06, '#1c6a78')
  for (const [x, y, r] of [[-0.36, -0.62, 0.17], [0.22, -0.8, 0.12], [0.5, -0.5, 0.09]] as const) {
    circle(c, x, y, r)
    c.stroke()
    c.fill()
  }
  // bowl
  c.beginPath()
  c.moveTo(-0.86, -0.12)
  c.bezierCurveTo(-0.86, 0.6, -0.5, 0.88, 0, 0.88)
  c.bezierCurveTo(0.5, 0.88, 0.86, 0.6, 0.86, -0.12)
  c.closePath()
  softJoin(c, 0.14, '#17121a')
  c.stroke()
  const g = c.createLinearGradient(-0.8, 0, 0.8, 0)
  g.addColorStop(0, '#6a5868')
  g.addColorStop(0.45, hex(PAL.cauldronOut))
  g.addColorStop(1, '#241a24')
  c.fillStyle = g
  c.fill()
  // rim and potion surface
  ellipse(c, 0, -0.14, 0.94, 0.26)
  c.fillStyle = '#7b6d7c'
  c.stroke()
  c.fill()
  ellipse(c, 0, -0.13, 0.76, 0.17)
  c.fillStyle = hex(PAL.potion)
  c.fill()
  ellipse(c, -0.2, -0.16, 0.3, 0.06)
  c.fillStyle = WHITE
  c.fill()
}

function hudPower(c: Ctx): void {
  const shield = (s: number) => {
    c.beginPath()
    c.moveTo(0, -0.92 * s)
    c.bezierCurveTo(0.3 * s, -0.72 * s, 0.6 * s, -0.7 * s, 0.84 * s, -0.74 * s)
    c.bezierCurveTo(0.9 * s, 0.1 * s, 0.6 * s, 0.66 * s, 0, 0.96 * s)
    c.bezierCurveTo(-0.6 * s, 0.66 * s, -0.9 * s, 0.1 * s, -0.84 * s, -0.74 * s)
    c.bezierCurveTo(-0.6 * s, -0.7 * s, -0.3 * s, -0.72 * s, 0, -0.92 * s)
    c.closePath()
  }
  shield(1)
  softJoin(c, 0.12, C.goldInk)
  c.stroke()
  const g = c.createLinearGradient(0, -0.9, 0, 0.9)
  g.addColorStop(0, C.goldHi)
  g.addColorStop(0.55, C.gold)
  g.addColorStop(1, C.goldLo)
  c.fillStyle = g
  c.fill()
  shield(0.78)
  c.fillStyle = 'rgba(150,95,20,0.45)'
  c.fill()
  // crossed blades
  for (const s of [-1, 1]) {
    c.save()
    c.rotate(s * 0.72)
    softJoin(c, 0.05, C.goldInk)
    c.fillStyle = '#fff6cf'
    poly(c, [-0.07, 0.3, -0.07, -0.56, 0, -0.72, 0.07, -0.56, 0.07, 0.3])
    c.stroke()
    c.fill()
    roundRect(c, -0.22, 0.28, 0.44, 0.1, 0.04)
    c.fillStyle = C.goldHi
    c.stroke()
    c.fill()
    roundRect(c, -0.05, 0.36, 0.1, 0.22, 0.04)
    c.stroke()
    c.fill()
    c.restore()
  }
}

function portrait(c: Ctx): void {
  // background
  const bg = c.createRadialGradient(-0.35, -0.5, 0.1, 0, 0, 1.6)
  bg.addColorStop(0, '#7189d2')
  bg.addColorStop(0.5, hex(PAL.hudPortrait))
  bg.addColorStop(1, '#33437e')
  c.fillStyle = bg
  c.fillRect(-1, -1, 2, 2)
  c.save()
  c.translate(-0.1, 0.25)
  c.scale(1.1, 1.1)
  const ink = '#141217'
  // coat and shoulders
  c.beginPath()
  c.moveTo(-1.05, 1.05)
  c.lineTo(-0.98, 0.72)
  c.bezierCurveTo(-0.84, 0.4, -0.52, 0.3, -0.24, 0.24)
  c.lineTo(0.3, 0.26)
  c.bezierCurveTo(0.62, 0.34, 0.9, 0.56, 0.98, 1.05)
  c.closePath()
  softJoin(c, 0.06, ink)
  c.fillStyle = '#35323b'
  c.fill()
  c.stroke()
  // lapels and strap
  c.fillStyle = '#4a4752'
  poly(c, [-0.5, 0.34, -0.16, 0.3, -0.02, 1.02, -0.3, 1.02])
  c.fill()
  poly(c, [0.44, 0.36, 0.14, 0.3, 0.1, 1.02, 0.34, 1.02])
  c.fill()
  roundRect(c, 0.36, 0.7, 0.3, 0.2, 0.04)
  c.fillStyle = '#6f6a4a'
  c.fill()
  c.stroke()
  // hood
  ellipse(c, -0.04, -0.02, 0.44, 0.48)
  c.fillStyle = '#2e2b33'
  c.fill()
  c.stroke()
  // beak
  c.beginPath()
  c.moveTo(-0.02, -0.12)
  c.bezierCurveTo(0.36, -0.26, 0.76, 0.06, 0.94, 0.52)
  c.bezierCurveTo(0.62, 0.46, 0.3, 0.44, 0.0, 0.3)
  c.closePath()
  c.fillStyle = '#57534b'
  c.fill()
  c.stroke()
  softJoin(c, 0.05, '#7d786c')
  c.beginPath()
  c.moveTo(0.16, -0.08)
  c.bezierCurveTo(0.42, -0.1, 0.66, 0.1, 0.8, 0.36)
  c.stroke()
  softJoin(c, 0.035, ink)
  c.beginPath()
  c.moveTo(0.12, 0.2)
  c.bezierCurveTo(0.4, 0.26, 0.66, 0.36, 0.9, 0.5)
  c.stroke()
  // goggles
  for (const [x, y, r] of [[-0.14, -0.2, 0.2], [0.28, -0.2, 0.15]] as const) {
    circle(c, x, y, r)
    c.fillStyle = '#211d1b'
    c.fill()
    softJoin(c, 0.05, '#8b7a4c')
    c.stroke()
    const lg = c.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.05, x, y, r * 0.78)
    lg.addColorStop(0, '#d5ffe9')
    lg.addColorStop(0.45, '#3fe6a2')
    lg.addColorStop(1, '#128a5c')
    circle(c, x, y, r * 0.7)
    c.fillStyle = lg
    c.fill()
  }
  // hat: brim, crown, band
  c.save()
  c.rotate(-0.13)
  ellipse(c, -0.02, -0.5, 0.92, 0.2)
  c.fillStyle = '#231e1d'
  softJoin(c, 0.06, ink)
  c.fill()
  c.stroke()
  softJoin(c, 0.045, '#4a403c')
  c.beginPath()
  c.ellipse(-0.02, -0.52, 0.8, 0.13, 0, Math.PI * 1.05, Math.PI * 1.95)
  c.stroke()
  c.beginPath()
  c.moveTo(-0.44, -0.54)
  c.lineTo(-0.4, -0.98)
  c.bezierCurveTo(-0.2, -1.1, 0.24, -1.1, 0.4, -0.98)
  c.lineTo(0.44, -0.54)
  c.bezierCurveTo(0.2, -0.44, -0.2, -0.44, -0.44, -0.54)
  c.closePath()
  c.fillStyle = '#2f2927'
  softJoin(c, 0.06, ink)
  c.fill()
  c.stroke()
  c.beginPath()
  c.moveTo(-0.435, -0.66)
  c.bezierCurveTo(-0.2, -0.56, 0.2, -0.56, 0.435, -0.66)
  c.lineTo(0.44, -0.54)
  c.bezierCurveTo(0.2, -0.44, -0.2, -0.44, -0.44, -0.54)
  c.closePath()
  c.fillStyle = '#6b5a45'
  c.fill()
  roundRect(c, -0.02, -0.62, 0.16, 0.13, 0.03)
  c.fillStyle = '#d0aa50'
  c.fill()
  c.restore()
  c.restore()
}

const PAINTERS: Record<IconName, (c: Ctx) => void> = {
  nurse: padNurse,
  usher: padNurse, // the ad uses the same bust for the usher pad (SPEC 3.2)
  cart: padCart,
  ward: padWard,
  porter: padPorter,
  chest: padChest,
  cauldron: padCauldron,
  drill: padDrill,
  driver: padDriver,
  coin,
  person: c => person(c, '#dcd8d5'),
  flask,
  plus: plusIcon,
  check: checkIcon,
  nurseBust,
  sick,
  scared,
  happy,
  tick,
  hudPerson,
  hudPotion,
  hudPower,
  portrait,
}
const PAD_ICONS: readonly string[] = ['nurse', 'usher', 'cart', 'ward', 'porter', 'chest', 'cauldron', 'drill', 'driver']

/** All icon names (for galleries and tests). */
export const ICON_NAMES = Object.keys(PAINTERS) as IconName[]

let scratch: HTMLCanvasElement | null = null

/**
 * Vector-paint an icon centred at (x, y) inside a `size` x `size` pixel box of any 2D context.
 * Pad icons get the thin dark edge they have in the ad so they stay readable on pale floors.
 */
export function paintIcon(c: Ctx, name: IconName, x: number, y: number, size: number): void {
  const isPad = PAD_ICONS.includes(name)
  if (!isPad && name !== 'person') {
    c.save()
    c.translate(x, y)
    c.scale(size / 2, size / 2)
    PAINTERS[name](c)
    c.restore()
    return
  }
  // Silhouettes punch holes with destination-out, so they are painted on a private canvas first.
  const px = Math.max(2, Math.ceil(size))
  scratch ??= document.createElement('canvas')
  const pad = Math.ceil(px * 0.06) + 1
  scratch.width = scratch.height = px + pad * 2
  const s = scratch.getContext('2d')!
  s.save()
  s.translate(pad + px / 2, pad + px / 2)
  s.scale(px / 2, px / 2)
  PAINTERS[name](s)
  s.restore()
  c.save()
  if (isPad) {
    c.shadowColor = 'rgba(18,16,24,0.85)'
    c.shadowBlur = Math.max(1, size * 0.018)
    c.drawImage(scratch, x - px / 2 - pad, y - px / 2 - pad) // twice: a firmer edge
  }
  c.drawImage(scratch, x - px / 2 - pad, y - px / 2 - pad)
  c.restore()
}

const canvasCache = new Map<string, HTMLCanvasElement>()
const textureCache = new Map<string, THREE.CanvasTexture>()

/** Cached square canvas (px x px, transparent background) with the icon filling it. Do not draw on it. */
export function iconCanvas(name: IconName, px = 256): HTMLCanvasElement {
  const k = `${name}|${px}`
  let cv = canvasCache.get(k)
  if (!cv) {
    cv = document.createElement('canvas')
    cv.width = cv.height = px
    // pad icons keep a small margin for their dark edge
    paintIcon(cv.getContext('2d')!, name, px / 2, px / 2, PAD_ICONS.includes(name) ? px * 0.94 : px)
    canvasCache.set(k, cv)
  }
  return cv
}

/**
 * Cached icon texture: sRGB, straight alpha, mipmapped, 256 px by default (crisp at 2x for anything up to about
 * 2 m across at game zoom). Use with a transparent unlit material or a Sprite. Shared: never dispose or mutate it.
 */
export function iconTexture(name: IconName, px = 256): THREE.CanvasTexture {
  const k = `${name}|${px}`
  let t = textureCache.get(k)
  if (!t) {
    t = new THREE.CanvasTexture(iconCanvas(name, px))
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    t.generateMipmaps = true
    t.minFilter = THREE.LinearMipmapLinearFilter
    textureCache.set(k, t)
  }
  return t
}

/** Icon of an unlock pad (same as iconTexture(def.icon)). */
export const padIconTexture = (def: UnlockDef) => iconTexture(def.icon)

// ---------------------------------------------------------------------------------------------------------------
// Shared pieces for the textured quads of decals.ts and bubbles.ts (internal to src/ui).
// ---------------------------------------------------------------------------------------------------------------

/**
 * Internal: texture for the UI shaders below. Uploaded premultiplied and decoded in the shader, so soft edges
 * blend without the dark fringe that straight-alpha canvas textures get. Not for standard three.js materials.
 */
export function uiTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = THREE.NoColorSpace
  t.premultiplyAlpha = true
  t.anisotropy = 4
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  return t
}

/** Internal GLSL: `vec4 uiTexel(sampler2D, vec2)` returns straight-alpha linear colour from a uiTexture(). */
export const UI_GLSL = /* glsl */ `
vec3 uiToLinear(vec3 c) {
  return mix(pow(c * 0.9478672986 + 0.0521327014, vec3(2.4)), c * 0.0773993808, vec3(lessThanEqual(c, vec3(0.04045))));
}
vec4 uiTexel(sampler2D t, vec2 uv) {
  vec4 c = texture2D(t, uv);
  c.rgb = uiToLinear(clamp(c.rgb / max(c.a, 1e-4), 0.0, 1.0));
  return c;
}
`
/**
 * Brightest linear value a UI shader outputs (sRGB #eaeaea). The stage's bloom starts at 0.72 with a soft knee and its
 * composite compresses everything above 0.8, so pure white UI would only gain a halo, not brightness. Capping here
 * keeps icons, digits and bubbles crisp like the ad's; the glows the UI does have (ring, alert bubbles) are drawn by
 * the UI itself.
 */
export const UI_WHITE = 0.82
/** Internal GLSL tail: caps, converts straight-alpha linear gl_FragColor to the output space and premultiplies it. */
export const uiGlslOut = (cap: number = UI_WHITE) => /* glsl */ `
gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(${cap.toFixed(3)}));
#include <colorspace_fragment>
gl_FragColor.rgb *= gl_FragColor.a;
`
export const UI_GLSL_OUT = uiGlslOut()
/** Internal: material settings shared by every UI shader (premultiplied blending, no depth write, no tone mapping). */
export const UI_MATERIAL = {
  transparent: true,
  premultipliedAlpha: true,
  depthWrite: false,
  toneMapped: false,
  fog: false,
} as const

// ---------------------------------------------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------------------------------------------

/** A board lying on the ground (readable from the game camera) showing a set of icons on a dark slate. */
function iconBoard(names: IconName[], cols: number, bg: string): () => THREE.Object3D {
  return () => {
    const cell = 200
    const rows = Math.ceil(names.length / cols)
    const cv = document.createElement('canvas')
    cv.width = cols * cell
    cv.height = rows * cell
    const c = cv.getContext('2d')!
    c.fillStyle = bg
    c.fillRect(0, 0, cv.width, cv.height)
    names.forEach((n, i) => {
      const x = (i % cols) * cell + cell / 2
      const y = Math.floor(i / cols) * cell + cell / 2
      c.drawImage(iconCanvas(n, 256), x - 80, y - 80, 160, 160)
    })
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 8
    const m = new THREE.Mesh(new THREE.PlaneGeometry(cols * 1.2, rows * 1.2), new THREE.MeshBasicMaterial({ map: tex }))
    m.rotation.x = -Math.PI / 2
    m.position.y = 0.03
    const g = new THREE.Group()
    g.add(m)
    return g
  }
}

export const GALLERY: GalleryItem[] = [
  { name: 'icons-pad', size: 2.2, make: iconBoard(UNLOCKS.map(u => u.icon), 3, hex(PAL.plank)) },
  { name: 'icons-bubble', size: 2.6, make: iconBoard(['flask', 'plus', 'check', 'nurseBust', 'sick', 'scared', 'happy', 'tick'], 4, hex(PAL.terracotta)) },
  { name: 'icons-hud', size: 2.2, make: iconBoard(['coin', 'person', 'hudPerson', 'hudPotion', 'hudPower', 'portrait'], 3, hex(PAL.hud)) },
]
