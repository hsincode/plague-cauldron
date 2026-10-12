// Procedural canvas textures for the environment (no external assets). Every factory is cached: calling it twice
// returns the same THREE.Texture. Colour textures are sRGB; "detail" textures are grey multipliers near white that
// are combined with vertex colours / material colours.
import * as THREE from 'three'
import { L, P, PAL } from '../config'
import { makeRng, rand, randRange, type Rng } from '../core/rng'

const cache = new Map<string, THREE.Texture>()

function make(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, repeat = true, srgb = true): THREE.CanvasTexture {
  const hit = cache.get(key) as THREE.CanvasTexture | undefined
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  draw(g, w, h)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  t.anisotropy = 8
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.name = key
  cache.set(key, t)
  return t
}

// ---------- small helpers ----------

const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255]
const css = (c: [number, number, number], a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`
const mix3 = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const mul3 = (a: [number, number, number], k: number): [number, number, number] => [Math.min(255, a[0] * k), Math.min(255, a[1] * k), Math.min(255, a[2] * k)]

/** Tileable value noise: lattice of `period` cells over the unit square, smooth interpolation. Returns -1..1. */
export function makeNoise(period: number, seed: number): (u: number, v: number) => number {
  const r = makeRng(seed)
  const g = new Float32Array(period * period)
  for (let i = 0; i < g.length; i++) g[i] = rand(r) * 2 - 1
  return (u, v) => {
    const x = (((u % 1) + 1) % 1) * period
    const y = (((v % 1) + 1) % 1) * period
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const x1 = (x0 + 1) % period
    const y1 = (y0 + 1) % period
    const a = g[y0 * period + x0]!
    const b = g[y0 * period + x1]!
    const c = g[y1 * period + x0]!
    const d = g[y1 * period + x1]!
    return a + (b - a) * sx + (c - a + (a - b + d - c) * sx) * sy
  }
}

/** Multiply the canvas by a tileable noise field (amount = +- fraction) plus fine grain. */
function grainPass(g: CanvasRenderingContext2D, w: number, h: number, seed: number, amount: number, fine: number, periods: [number, number] = [5, 17]) {
  const img = g.getImageData(0, 0, w, h)
  const d = img.data
  const n1 = makeNoise(periods[0], seed)
  const n2 = makeNoise(periods[1], seed + 7)
  const r = makeRng(seed + 99)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const k = 1 + amount * (0.65 * n1(x / w, y / h) + 0.35 * n2(x / w, y / h)) + fine * (rand(r) - 0.5)
      d[i] = Math.min(255, d[i]! * k)
      d[i + 1] = Math.min(255, d[i + 1]! * k)
      d[i + 2] = Math.min(255, d[i + 2]! * k)
    }
  }
  g.putImageData(img, 0, 0)
}

// ---------- ground ----------

/** World size (metres) covered by one repeat of groundDetail(). */
export const GROUND_DETAIL_SIZE = 14

/**
 * Tileable grey mottling used as the `map` of the terrain, the river bed and the pen sand (colour comes from vertex
 * colours). Mean about 0.9 (linear), soft blotches plus sparse grit; map uv = world (x, z) / GROUND_DETAIL_SIZE.
 */
export function groundDetail(): THREE.CanvasTexture {
  return make('groundDetail', 512, 512, (g, w, h) => {
    const img = g.createImageData(w, h)
    const d = img.data
    const n1 = makeNoise(3, 11)
    const n2 = makeNoise(7, 12)
    const n3 = makeNoise(19, 13)
    const n4 = makeNoise(61, 14)
    const r = makeRng(5)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / w
        const v = y / h
        let m = 0.9 + 0.045 * n1(u, v) + 0.04 * n2(u, v) + 0.03 * n3(u, v) + 0.02 * n4(u, v) + 0.012 * (rand(r) - 0.5)
        m = Math.max(0.6, Math.min(1, m))
        const b = Math.round(255 * Math.pow(m, 1 / 2.2))
        const i = (y * w + x) * 4
        d[i] = d[i + 1] = d[i + 2] = b
        d[i + 3] = 255
      }
    }
    g.putImageData(img, 0, 0)
    // sparse grit: tiny dark specks with a pale upper-left edge (pebbles), wrapped at the borders
    for (let i = 0; i < 150; i++) {
      const x = rand(r) * w
      const y = rand(r) * h
      const s = randRange(r, 0.5, 1.3)
      for (const ox of [-w, 0, w]) {
        for (const oy of [-h, 0, h]) {
          if (x + ox < -4 || x + ox > w + 4 || y + oy < -4 || y + oy > h + 4) continue
          g.fillStyle = 'rgba(40,40,46,0.13)'
          g.beginPath()
          g.ellipse(x + ox, y + oy, s * 1.2, s, rand(r) * 3, 0, 7)
          g.fill()
          g.fillStyle = 'rgba(255,255,255,0.1)'
          g.beginPath()
          g.ellipse(x + ox - s * 0.4, y + oy - s * 0.4, s * 0.6, s * 0.45, 0, 0, 7)
          g.fill()
        }
      }
    }
  })
}

/**
 * Tile edge in metres and grid rotation as measured in the ad (f_0052, f_0058, f_0256): the slabs are laid diagonally,
 * 45 deg to the walls, so their joints run almost exactly along the screen axes, and they are 0.72-0.75 m wide.
 * (P.TILE_SIZE = 0.85 is the SPEC's estimate for an axis-aligned grid; it is kept as the upper bound of the size.)
 */
export const COURTYARD_TILE = { size: Math.min(P.TILE_SIZE, 0.74), angle: Math.PI / 4 }

/**
 * Courtyard stone tiles, one unique texture for the whole L.COURTYARD rectangle (canvas top = north, left = west).
 * Diagonal grid with thin dark grout, slight per-tile value variation, a few warm and a few shaded slabs.
 */
export function courtyardTiles(): THREE.CanvasTexture {
  const [x0, z0, x1, z1] = L.COURTYARD
  const wm = x1 - x0
  const dm = z1 - z0
  const W = 1024
  const H = Math.round((W * dm) / wm)
  return make(
    'courtyardTiles',
    W,
    H,
    (g, w, h) => {
      const ppm = w / wm
      const r = makeRng(77)
      const base = rgb(PAL.tile)
      const warm = rgb(PAL.tileWarm)
      const shade = rgb(PAL.tileShade)
      // joints: thin and only a step darker than the slabs (ad 11.4-13.6 s: about 1 px of #5d5c66 between #7e7e87
      // slabs at 608 px); pure PAL.grout is kept for chips and cracks
      const grout = rgb(PAL.grout)
      g.fillStyle = css(mix3(grout, base, 0.38))
      g.fillRect(0, 0, w, h)
      const ts = COURTYARD_TILE.size * ppm
      const gap = 0.03 * ppm
      const big = makeNoise(4, 31)
      g.save()
      g.translate(w / 2, h / 2)
      g.rotate(COURTYARD_TILE.angle)
      const n = Math.ceil((Math.hypot(w, h) / ts) * 0.5) + 1
      for (let j = -n; j < n; j++) {
        for (let i = -n; i < n; i++) {
          const px = i * ts
          const py = j * ts
          const t = rand(r)
          let c = base
          if (t < 0.07) c = mix3(base, warm, randRange(r, 0.3, 0.6))
          else if (t < 0.2) c = mix3(base, shade, randRange(r, 0.4, 0.9))
          c = mul3(c, 0.865 + 0.07 * rand(r) + 0.04 * big(0.5 + px / w, 0.5 + py / h))
          // slightly irregular quad with rounded corners (hand-drawn joints)
          const j1 = () => (rand(r) - 0.5) * 0.03 * ppm
          const xa = px + gap / 2 + j1()
          const ya = py + gap / 2 + j1()
          const xb = px + ts - gap / 2 + j1()
          const yb = py + ts - gap / 2 + j1()
          const rad = 0.03 * ppm
          g.fillStyle = css(c)
          g.beginPath()
          g.roundRect(xa, ya, xb - xa, yb - ya, rad)
          g.fill()
          // worn bevel: pale edges towards the upper-left of the screen, dark towards the lower-right
          g.lineWidth = 1.4
          g.strokeStyle = css(mul3(c, 1.09), 0.45)
          g.beginPath()
          g.moveTo(xa + 1, ya + rad)
          g.lineTo(xa + 1, yb - rad)
          g.stroke()
          g.strokeStyle = css(mul3(c, 0.86), 0.5)
          g.beginPath()
          g.moveTo(xb - 1, ya + rad)
          g.lineTo(xb - 1, yb - rad)
          g.stroke()
          // occasional crack or chipped corner
          if (rand(r) < 0.14) {
            g.strokeStyle = css(mul3(c, 0.72), 0.65)
            g.lineWidth = 1.1
            g.beginPath()
            let cx = xa + rand(r) * (xb - xa)
            let cy = ya
            g.moveTo(cx, cy)
            for (let k = 0; k < 4; k++) {
              cx += (rand(r) - 0.5) * ts * 0.35
              cy += ((yb - ya) / 4) * randRange(r, 0.5, 1.1)
              g.lineTo(Math.max(xa, Math.min(xb, cx)), Math.min(yb, cy))
            }
            g.stroke()
          }
          if (rand(r) < 0.08) {
            g.fillStyle = css(grout, 0.9)
            g.beginPath()
            g.arc(rand(r) < 0.5 ? xa : xb, rand(r) < 0.5 ? ya : yb, randRange(r, 0.04, 0.085) * ppm, 0, 7)
            g.fill()
          }
        }
      }
      g.restore()
      grainPass(g, w, h, 41, 0.06, 0.045, [3, 23])
    },
    false,
  )
}

/** World size (metres) covered by one repeat of plankFloor() in u (along the planks) and v (across them). */
export const PLANK_TILE = { u: 6, v: 4 }

/** Tileable plank floor, planks run along u (world x). 12 planks per repeat (0.33 m), staggered butt joints, dark seams. */
export function plankFloor(): THREE.CanvasTexture {
  return make('plankFloor', 768, 512, (g, w, h) => {
    const r = makeRng(303)
    const base = mul3(rgb(PAL.plank), 0.94)
    const lit = rgb(PAL.plankLit)
    const seam = rgb(PAL.plankSeam)
    const rows = 12
    const ph = h / rows
    for (let j = 0; j < rows; j++) {
      // 1-2 boards per repeat with a random joint position
      const joints = [rand(r) * w]
      if (rand(r) < 0.6) joints.push((joints[0]! + w * randRange(r, 0.35, 0.65)) % w)
      joints.sort((a, b) => a - b)
      for (let k = 0; k < joints.length; k++) {
        const xa = joints[k]!
        const xb = k + 1 < joints.length ? joints[k + 1]! : joints[0]! + w
        const t = rand(r)
        const c = mul3(mix3(base, lit, t < 0.1 ? randRange(r, 0.2, 0.4) : randRange(r, 0, 0.14)), randRange(r, 0.94, 1.03))
        for (const ox of [0, -w]) {
          g.fillStyle = css(c)
          g.fillRect(xa + ox, j * ph, xb - xa, ph)
          // grain streaks
          for (let s = 0; s < 7; s++) {
            const yy = j * ph + 3 + rand(r) * (ph - 6)
            g.strokeStyle = css(mul3(c, rand(r) < 0.6 ? 0.88 : 1.07), 0.4)
            g.lineWidth = randRange(r, 0.8, 1.8)
            g.beginPath()
            const sx = xa + ox + rand(r) * (xb - xa) * 0.6
            const len = randRange(r, 0.15, 0.6) * (xb - xa)
            g.moveTo(sx, yy)
            g.bezierCurveTo(sx + len * 0.3, yy + randRange(r, -2, 2), sx + len * 0.7, yy + randRange(r, -2, 2), sx + len, yy + randRange(r, -1, 1))
            g.stroke()
          }
          // butt joint and nails
          g.fillStyle = css(seam, 0.7)
          g.fillRect(xa + ox - 1, j * ph, 2, ph)
          g.fillStyle = css(mul3(seam, 0.8), 0.85)
          for (const nx of [xa + 7, xb - 7]) {
            g.beginPath()
            g.arc(nx + ox, j * ph + ph * 0.28, 1.5, 0, 7)
            g.arc(nx + ox, j * ph + ph * 0.72, 1.5, 0, 7)
            g.fill()
          }
        }
      }
      // seam between rows: dark line with a thin pale edge below it
      g.fillStyle = css(seam, 0.85)
      g.fillRect(0, j * ph - 1.1, w, 2.2)
      g.fillStyle = css(mul3(lit, 1.0), 0.22)
      g.fillRect(0, j * ph + 1.1, w, 1.1)
    }
    g.fillStyle = css(seam, 0.85)
    g.fillRect(0, h - 1.1, w, 1.1)
    grainPass(g, w, h, 55, 0.06, 0.05, [4, 13])
  })
}

/** Tileable wall surface: grey multiplier with vertical weathering streaks (map of the architecture mesh). uv = metres / 2. */
export function wallGrain(): THREE.CanvasTexture {
  return make('wallGrain', 256, 256, (g, w, h) => {
    g.fillStyle = '#fafafa'
    g.fillRect(0, 0, w, h)
    const r = makeRng(909)
    for (let i = 0; i < 60; i++) {
      const x = rand(r) * w
      const y0 = rand(r) * h
      const len = randRange(r, 0.1, 0.4) * h
      const a = randRange(r, 0.012, 0.035)
      g.strokeStyle = rand(r) < 0.7 ? `rgba(30,30,40,${a})` : `rgba(255,255,255,${a * 1.6})`
      g.lineWidth = randRange(r, 1, 3.5)
      for (const oy of [0, -h]) {
        g.beginPath()
        g.moveTo(x, y0 + oy)
        g.lineTo(x + randRange(r, -2, 2), y0 + oy + len)
        g.stroke()
      }
    }
    grainPass(g, w, h, 66, 0.07, 0.02, [3, 7])
  })
}

// ---------- decals ----------

/** Soft white radial falloff (alpha) for additive ground glows (fire light pool). Not repeating. */
export function radialGlow(): THREE.CanvasTexture {
  return make(
    'radialGlow',
    128,
    128,
    (g, w) => {
      const grad = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2)
      grad.addColorStop(0, 'rgba(255,255,255,1)')
      grad.addColorStop(0.35, 'rgba(255,255,255,0.62)')
      grad.addColorStop(0.7, 'rgba(255,255,255,0.17)')
      grad.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = grad
      g.fillRect(0, 0, w, w)
    },
    false,
  )
}

function strand(g: CanvasRenderingContext2D, r: Rng, x0: number, y0: number, x1: number, y1: number, sag: number) {
  g.beginPath()
  g.moveTo(x0, y0)
  g.quadraticCurveTo((x0 + x1) / 2 + randRange(r, -4, 4), (y0 + y1) / 2 + sag, x1, y1)
  g.stroke()
}

/** Pale cobweb strands on a transparent background (hangs from the top edge of the quad). Not repeating. */
export function cobweb(): THREE.CanvasTexture {
  return make(
    'cobweb',
    128,
    256,
    (g, w, h) => {
      const r = makeRng(4242)
      g.strokeStyle = 'rgba(214,214,222,0.75)'
      g.lineCap = 'round'
      // threads hanging from the top
      for (let i = 0; i < 13; i++) {
        const x = randRange(r, 4, w - 4)
        g.lineWidth = randRange(r, 0.6, 1.3)
        g.globalAlpha = randRange(r, 0.3, 0.85)
        strand(g, r, x, 0, x + randRange(r, -18, 18), randRange(r, 0.3, 1) * h, 0)
      }
      // sagging cross threads
      for (let i = 0; i < 7; i++) {
        const y = randRange(r, 0.05, 0.7) * h
        g.lineWidth = randRange(r, 0.6, 1.1)
        g.globalAlpha = randRange(r, 0.25, 0.6)
        strand(g, r, randRange(r, 0, w * 0.4), y, randRange(r, w * 0.6, w), y + randRange(r, -20, 20), randRange(r, 8, 30))
      }
      g.globalAlpha = 1
    },
    false,
  )
}

/** Dry reed / grass tuft: pale thin blades fanning up from the bottom centre, transparent background. Not repeating. */
export function reeds(): THREE.CanvasTexture {
  return make(
    'reeds',
    128,
    256,
    (g, w, h) => {
      const r = makeRng(1717)
      g.lineCap = 'round'
      for (let i = 0; i < 34; i++) {
        const a = randRange(r, -0.42, 0.42)
        const len = randRange(r, 0.45, 0.98) * h
        const x0 = w / 2 + randRange(r, -10, 10)
        const x1 = x0 + Math.sin(a) * len
        const y1 = h - Math.cos(a) * len
        const v = randRange(r, 150, 215)
        g.strokeStyle = `rgba(${v},${v - 8},${v - 22},${randRange(r, 0.55, 0.95)})`
        g.lineWidth = randRange(r, 0.9, 2)
        g.beginPath()
        g.moveTo(x0, h)
        g.quadraticCurveTo(x0 + Math.sin(a) * len * 0.3, h - len * 0.6, x1 + randRange(r, -8, 8), y1)
        g.stroke()
      }
    },
    false,
  )
}
