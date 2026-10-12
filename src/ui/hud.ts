// DOM HUD overlay (SPEC 8.1): dark top bar with three stat cells and the coin counter, the portrait tile with the
// level number, and the "power" pill. Laid out in the pixels of the 608 px wide reference frame and scaled as one
// block (CSS transform) with the width of `parent` (the 9:16 game frame), so it matches the ad at any viewport size.
// In a parent wider than 9:16 (wide mode) it keeps the size it would have in the 9:16 frame of the same height (but
// stays legible in a very short one) and sits centred, with the dark bar running on to both edges.
//
// Live bindings (SPEC 8.1 EXTENDED): cell 1 = discharged/total (person icon), cell 2 = flasks carried (flask icon),
// cell 3 = potion n/cap (cauldron icon), coin cell = wallet, level = 1 + unlocks bought, pill = total gold earned.
import './hud.css'
import { paintIcon, uiFontReady, type IconName } from './icons'

export { UI_FONT, UI_FONT_FAMILY, uiFontReady } from './icons'

/** Reference frame width in CSS pixels: all HUD coordinates below are in these pixels. */
export const HUD_REF_WIDTH = 608
/** In a wide parent the HUD is never drawn narrower than this (CSS px): a phone held sideways is only 360-430 px high. */
const MIN_WIDE_WIDTH = 360
/** Centre of the coin icon in reference pixels (SPEC 8.1). */
const COIN_ICON = { x: 511, y: 20 }

export interface HudData {
  /** Wallet shown in the coin cell (floored to an integer). */
  coins: number
  /** Villagers discharged so far / total villagers (cell 1). */
  discharged: number
  total: number
  /** Flasks carried by the doctor (cell 2). */
  flasks: number
  /** Potion units in the cauldron / its capacity (cell 3). */
  potion: number
  potionCap: number
  /** Level number on the portrait (1 + unlocks bought). */
  level: number
  /** Total gold earned so far (the "power" pill, shown with thousands separators). */
  totalGold: number
}
export interface Hud {
  /** Root element (absolutely positioned at the top of `parent`, pointer-events: none, z-index 4). */
  el: HTMLElement
  /** Update the numbers. Cheap to call every frame: the DOM is only touched for values that changed. */
  set(data: HudData): void
  /**
   * Screen position (CSS px, relative to the HUD's parent) of the centre of the coin icon, the target of coin
   * ribbons. The returned object is reused between calls: copy it if you keep it.
   */
  coinTarget(): { x: number; y: number }
  /** Re-measure. The HUD follows resizes by itself; call this after a device-pixel-ratio change, which is not one. */
  layout(): void
}

/** A number made of one <b> per character so digits can sit in fixed-width cells (see hud.css). */
function makeNumber(parent: HTMLElement, fit = 99): (text: string) => void {
  const el = document.createElement('span')
  el.className = 'pc-num'
  parent.appendChild(el)
  const cells: HTMLElement[] = []
  let shown = ''
  return text => {
    if (text === shown) return
    shown = text
    while (cells.length < text.length) cells.push(el.appendChild(document.createElement('b')))
    for (let i = 0; i < cells.length; i++) {
      const b = cells[i]!
      const ch = i < text.length ? text[i]! : ''
      b.hidden = ch === ''
      if (b.dataset.c !== ch) {
        b.dataset.c = ch
        b.textContent = ch
        b.className = ch >= '0' && ch <= '9' ? 'd' : ''
      }
    }
    // long values shrink instead of running into the next cell or off the frame
    el.style.setProperty('--k', text.length > fit ? (fit / text.length).toFixed(3) : '1')
  }
}

const group = (n: number) => String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+$)/g, ',')
const int = (n: number) => String(Math.max(0, Math.floor(n + 1e-6)))

/**
 * Mount the HUD inside `parent` (the game frame; any positioned element works, document.body too).
 * It follows the parent's width by itself (ResizeObserver).
 */
export function createHud(parent: HTMLElement): Hud {
  const el = document.createElement('div')
  el.className = 'pc-hud'
  el.setAttribute('aria-hidden', 'true')

  const icons: { cv: HTMLCanvasElement; name: IconName; size: number }[] = []
  const div = (cls: string, into: HTMLElement = el) => {
    const d = document.createElement('div')
    d.className = cls
    into.appendChild(d)
    return d
  }
  const icon = (into: HTMLElement, name: IconName, size: number) => {
    const cv = document.createElement('canvas')
    cv.width = cv.height = 1
    into.appendChild(cv)
    icons.push({ cv, name, size })
  }
  const cell = (cls: string, name: IconName, fit: number, size = 30) => {
    const c = div(`pc-cell ${cls}`, bar)
    icon(c, name, size)
    return makeNumber(c, fit)
  }

  const bar = div('pc-bar')
  const setDischarged = cell('pc-c1', 'hudPerson', 7)
  const setFlasks = cell('pc-c2', 'flask', 5)
  const setPotion = cell('pc-c3', 'hudPotion', 6)
  for (const x of [226, 343, 476]) div('pc-div', bar).style.left = `${x}px`
  const setCoins = cell('pc-coin', 'coin', 3.4, 27)

  icon(div('pc-portrait'), 'portrait', 80)
  const setLevel = makeNumber(div('pc-level'), 1.6)
  const pill = div('pc-pill')
  icon(pill, 'hudPower', 31)
  const setGold = makeNumber(pill, 9)

  parent.appendChild(el)

  let u = 0
  let left = 0
  const target = { x: 0, y: 0 }
  const layout = () => {
    const pw = parent.clientWidth || el.clientWidth || HUD_REF_WIDTH
    // rounded like the frame width in main.ts, so that the scale is exactly 1 in the 608 x 1080 reference frame
    const w = Math.min(pw, Math.max(MIN_WIDE_WIDTH, Math.round(((parent.clientHeight || Infinity) * 9) / 16)))
    const nu = w / HUD_REF_WIDTH
    const nl = Math.round((pw - w) / 2)
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    if (nu !== u || nl !== left) {
      u = nu
      left = nl
      el.style.transform = `translateX(${left}px) scale(${u})`
      target.x = left + COIN_ICON.x * u
      target.y = COIN_ICON.y * u
    }
    for (const it of icons) {
      const px = Math.max(8, Math.round(it.size * u * dpr))
      if (it.cv.width === px) continue
      it.cv.width = it.cv.height = px
      paintIcon(it.cv.getContext('2d')!, it.name, px / 2, px / 2, px)
    }
  }
  layout()
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(layout).observe(parent)
  window.addEventListener('resize', layout)
  void uiFontReady()

  // last values, so set() only touches the DOM on change
  let coins = -1
  let discharged = -1
  let total = -1
  let flasks = -1
  let potion = -1
  let potionCap = -1
  let level = -1
  let gold = -1

  return {
    el,
    set(d) {
      let v = Math.floor(d.coins + 1e-6)
      if (v !== coins) setCoins(int((coins = v)))
      if (d.discharged !== discharged || d.total !== total) setDischarged(`${int((discharged = d.discharged))}/${int((total = d.total))}`)
      if (d.flasks !== flasks) setFlasks(int((flasks = d.flasks)))
      v = Math.floor(d.potion + 1e-6)
      if (v !== potion || d.potionCap !== potionCap) setPotion(`${int((potion = v))}/${int((potionCap = d.potionCap))}`)
      if (d.level !== level) setLevel(int((level = d.level)))
      v = Math.floor(d.totalGold + 1e-6)
      if (v !== gold) setGold(group((gold = v)))
    },
    coinTarget() {
      return target
    },
    layout,
  }
}
