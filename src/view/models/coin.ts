// Coins (SPEC 2.8, 7.4, 9 rows 15-17, 24): one InstancedMesh serves the pallet stacks, the column on the doctor's
// back, coins flying in arcs and the big heap of the drill event.
//
// Look: thick orange disc, lighter rim, darker embossed ring + swirl on both faces, a light rim line on the side so
// that a stack reads as separate discs. Coins are UNLIT (toon-flat and bright at night, like the ad); the top/side
// contrast is painted into the texture. "Glowing yellow coin in flight" is a per-instance tint (CoinMesh.glow).
//
// Binding recipe (every frame, no allocations):
//   let n = 0
//   for each pallet coin   -> coins.put(n++, x, stackY(layer, palletTopY), z)
//   for each column disc   -> coins.put(n++, x, stackY(k, baseY), z)
//   for each flying coin   -> coins.putTumbling(n, x, y, z, rx, ry, rz); coins.glow(n++, 1)
//   coins.commit(n)
// Post-process: solid coins are ordinary outlined geometry (the ad draws a dark outline around coins and stacks);
// the 'ghost' variant is transparent, so the stage draws it un-outlined.
import * as THREE from 'three'
import { P, PAL, hex } from '../../config'
import { unlit, type GalleryItem } from '../materials'

/** Coin radius (m). */
export const COIN_R = P.COIN_DIAMETER / 2
/** Coin thickness (m) = vertical pitch of a stack. */
export const COIN_H = P.COIN_THICKNESS

/** Centre height of the coin number `layer` (0 = bottom) of a stack standing on `baseY`. */
export const stackY = (layer: number, baseY = 0) => baseY + (layer + 0.5) * COIN_H

// Linear-space multipliers that turn the orange coin into the bright golden-yellow coin of the fountain.
const GLOW_R = 1.5
const GLOW_G = 2.45
const GLOW_B = 1.1

export interface CoinMesh {
  /** Add this to the scene once. Leave its transform at identity: instance coordinates are then world coordinates. */
  mesh: THREE.InstancedMesh
  /** Maximum number of coins (the `count` passed to createCoinMesh). */
  readonly capacity: number
  /**
   * Coin `i` lying flat (axis +y), CENTRE at (x, y, z). `yaw` (radians) turns the face glyph, `scale` is uniform
   * (use it for pop-in/pop-out tweens). Resets nothing else: call glow() separately when the tint changes.
   */
  put(i: number, x: number, y: number, z: number, yaw?: number, scale?: number): void
  /** Coin `i` with a free orientation (Euler XYZ, radians), CENTRE at (x, y, z): flying, tumbling and heap coins. */
  putTumbling(i: number, x: number, y: number, z: number, rx: number, ry: number, rz: number, scale?: number): void
  /** Tint of coin `i`: 0 = normal orange (resting coin), 1 = glowing golden yellow (coin in flight). Values between blend. */
  glow(i: number, k: number): void
  /** Call once after the put()/glow() calls of a frame: draws the first `count` coins and uploads only their part of the buffers. */
  commit(count: number): void
}

export interface CoinModel {
  /** A single coin lying flat, origin at its CENTRE (so it can be spun freely). */
  root: THREE.Group
  /** 0 = normal orange, 1 = glowing golden yellow. */
  setGlow(k: number): void
}

let atlas: THREE.CanvasTexture | null = null
let coinGeo: THREE.BufferGeometry | null = null

const mix = (a: number, b: number, t: number) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()

/** 256x128 atlas: left half = face (rim, groove ring, swirl), right half = side (v = 0 bottom .. 1 top). */
function coinAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas
  const S = 128
  const c = document.createElement('canvas')
  c.width = S * 2
  c.height = S
  const g = c.getContext('2d')!
  const R = S / 2
  const disc = (r: number, fill: string) => {
    g.beginPath()
    g.arc(R, R, r * R, 0, Math.PI * 2)
    g.fillStyle = fill
    g.fill()
  }
  const light = mix(PAL.coinRim, PAL.goldCore, 0.4) // rim highlight, ad: #feba75
  // --- face (ad 16.2 s: face #dd9350 .. #feba75 with a bold #a25513 groove ring and glyph) ---
  g.fillStyle = light
  g.fillRect(0, 0, S, S)
  disc(0.86, mix(PAL.coin, PAL.coinEmboss, 0.85)) // groove
  disc(0.71, mix(PAL.coin, PAL.coinRim, 0.75)) // raised centre
  // swirl glyph: a 1.3-turn spiral, dark groove with a light lip on its lower-right side
  const swirl = (ox: number, oy: number, style: string, w: number) => {
    g.beginPath()
    for (let i = 0; i <= 40; i++) {
      const u = i / 40
      const a = -0.6 + u * Math.PI * 2.5
      const r = (0.08 + 0.37 * u) * R
      const x = R + ox + Math.cos(a) * r
      const y = R + oy + Math.sin(a) * r
      if (i === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.strokeStyle = style
    g.lineWidth = w
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.stroke()
  }
  swirl(2, 2.5, light, 0.19 * R)
  swirl(0, 0, hex(PAL.coinEmboss), 0.19 * R)
  // --- side: light rim on top, body, dark seam at the bottom ---
  g.fillStyle = mix(PAL.coin, PAL.coinEmboss, 0.08)
  g.fillRect(S, 0, S, S)
  g.fillStyle = light
  g.fillRect(S, 0, S, S * 0.3)
  g.fillStyle = mix(PAL.coin, PAL.coinEmboss, 0.85)
  g.fillRect(S, S * 0.84, S, S * 0.16)
  atlas = new THREE.CanvasTexture(c)
  atlas.colorSpace = THREE.SRGBColorSpace
  atlas.anisotropy = 4
  return atlas
}

function coinGeometry(): THREE.BufferGeometry {
  if (coinGeo) return coinGeo
  const geo = new THREE.CylinderGeometry(COIN_R, COIN_R, COIN_H, 16, 1) // 64 triangles: a coin is about 35 px wide in game
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(nrm.getY(i)) > 0.5) uv.setXY(i, 0.01 + uv.getX(i) * 0.48, 0.02 + uv.getY(i) * 0.96) // caps -> left half
    else uv.setXY(i, 0.75, 0.03 + uv.getY(i) * 0.94) // side -> one column of the right half
  }
  coinGeo = geo
  return geo
}

const _m = new THREE.Matrix4()
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _s = new THREE.Vector3()

/**
 * InstancedMesh of up to `count` coins (about 800 are needed for the drill heap plus pallet, column and fountains).
 * `variant` 'ghost' is the same coin at 50 % opacity (for coins fading in on the pallet / fading out at pickup,
 * SPEC 9 rows 15-16): create a second, small CoinMesh with it if you want that effect.
 */
export function createCoinMesh(count: number, variant: 'solid' | 'ghost' = 'solid'): CoinMesh {
  const mat =
    variant === 'ghost'
      ? unlit(0xffffff, { map: coinAtlas(), transparent: true, opacity: 0.5, depthWrite: false })
      : unlit(0xffffff, { map: coinAtlas(), transparent: false })
  const mesh = new THREE.InstancedMesh(coinGeometry(), mat, count)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false // instances move every frame; a stale bounding sphere would cull them wrongly
  const white = new THREE.Color(1, 1, 1)
  for (let i = 0; i < count; i++) mesh.setColorAt(i, white)
  mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  mesh.count = 0
  const im = mesh.instanceMatrix
  const ic = mesh.instanceColor!
  const mArr = im.array as Float32Array
  const cArr = ic.array as Float32Array
  const mRange = { start: 0, count: 0 }
  const cRange = { start: 0, count: 0 }
  return {
    mesh,
    capacity: count,
    put(i, x, y, z, yaw = 0, scale = 1) {
      const o = i * 16
      const c = Math.cos(yaw) * scale
      const s = Math.sin(yaw) * scale
      mArr[o] = c
      mArr[o + 1] = 0
      mArr[o + 2] = -s
      mArr[o + 3] = 0
      mArr[o + 4] = 0
      mArr[o + 5] = scale
      mArr[o + 6] = 0
      mArr[o + 7] = 0
      mArr[o + 8] = s
      mArr[o + 9] = 0
      mArr[o + 10] = c
      mArr[o + 11] = 0
      mArr[o + 12] = x
      mArr[o + 13] = y
      mArr[o + 14] = z
      mArr[o + 15] = 1
    },
    putTumbling(i, x, y, z, rx, ry, rz, scale = 1) {
      _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.setScalar(scale))
      _m.toArray(mArr, i * 16)
    },
    glow(i, k) {
      const o = i * 3
      cArr[o] = 1 + (GLOW_R - 1) * k
      cArr[o + 1] = 1 + (GLOW_G - 1) * k
      cArr[o + 2] = 1 + (GLOW_B - 1) * k
    },
    commit(n) {
      const c = n < count ? n : count
      mesh.count = c
      if (c === 0) return
      // upload only the coins in use (the range objects are reused: no per-frame garbage)
      mRange.count = c * 16
      cRange.count = c * 3
      im.updateRanges.length = 0
      im.updateRanges.push(mRange)
      im.needsUpdate = true
      ic.updateRanges.length = 0
      ic.updateRanges.push(cRange)
      ic.needsUpdate = true
    },
  }
}

/** One free-standing coin (not instanced), e.g. for a one-off prop. Use createCoinMesh for anything numerous. */
export function makeCoin(): CoinModel {
  const mat = unlit(0xffffff, { map: coinAtlas(), transparent: false }).clone()
  const root = new THREE.Group()
  root.add(new THREE.Mesh(coinGeometry(), mat))
  return {
    root,
    setGlow(k) {
      mat.color.setRGB(1 + (GLOW_R - 1) * k, 1 + (GLOW_G - 1) * k, 1 + (GLOW_B - 1) * k)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// gallery

const rnd = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453
  return x - Math.floor(x)
}

function gSingle(glow: number): THREE.Object3D {
  const g = new THREE.Group()
  const c = makeCoin()
  c.setGlow(glow)
  c.root.position.y = 0.6
  g.add(c.root)
  g.userData.coin = c
  return g
}

function gColumn(): THREE.Object3D {
  const coins = createCoinMesh(50)
  for (let i = 0; i < 50; i++) coins.put(i, 0, stackY(i), 0, rnd(i, 1) * 6.28)
  coins.commit(50)
  return coins.mesh
}

function gHeap(): THREE.Object3D {
  const N = 800
  const coins = createCoinMesh(N)
  for (let i = 0; i < N; i++) {
    const a = rnd(i, 1) * Math.PI * 2
    const r = Math.sqrt(rnd(i, 2)) * 3.6
    const h = Math.max(0, 1 - r / 3.6) * 0.9 * rnd(i, 3)
    coins.putTumbling(i, Math.cos(a) * r, 0.06 + h, Math.sin(a) * r * 0.85, (rnd(i, 4) - 0.5) * 1.1, rnd(i, 5) * 6.28, (rnd(i, 6) - 0.5) * 1.1)
  }
  coins.commit(N)
  return coins.mesh
}

/** Fountain look: a rope of glowing coins arcing from the left to a stack on the right. */
function gArc(): THREE.Object3D {
  const coins = createCoinMesh(40)
  coins.mesh.userData.coins = coins
  return coins.mesh
}
function animArc(obj: THREE.Object3D, t: number) {
  const coins = obj.userData.coins as CoinMesh
  let n = 0
  for (let k = 0; k < 8; k++) {
    coins.put(n, 1.2, stackY(k), 0, k)
    coins.glow(n++, 0)
  }
  for (let k = 0; k < 14; k++) {
    const u = (t * 1.4 + k / 14) % 1
    const x = -1.4 + 2.6 * u
    const y = 0.4 + 2.8 * 4 * u * (1 - u) + (1 - u) * 0.3
    coins.putTumbling(n, x, y, Math.sin(u * 9 + k) * 0.08, u * 7 + k, k * 1.3, u * 5)
    coins.glow(n++, Math.min(1, (1 - u) * 4))
  }
  coins.commit(n)
}

export const GALLERY: GalleryItem[] = [
  { name: 'coin single', size: 0.5, make: () => gSingle(0), animate: (o, t) => o.children[0]!.rotation.set(Math.sin(t) * 0.9 + 0.5, t * 1.5, 0) },
  { name: 'coin glow (in flight)', size: 0.5, make: () => gSingle(1), animate: (o, t) => o.children[0]!.rotation.set(Math.sin(t) * 0.9 + 0.5, t * 1.5, 0) },
  { name: 'coin column 50', size: 2.3, make: gColumn },
  { name: 'coin arc (fountain)', size: 1.8, make: gArc, animate: animArc },
  { name: 'coin heap 800', size: 4, make: gHeap },
]
