// The cauldron (SPEC 2.6, 7.4, 9 rows 9, 12-13, 26): black iron bowl on a ring of seven charred logs over a red-orange
// fire of thin strands, glowing potion surface whose radius follows the SPEC 2.6 table (its height is where the inner
// wall has that radius). 7 draw calls, about 10 k triangles (half of them the instanced flame strands).
//
// Binding recipe:
//   const c = makeCauldron(); scene.add(c.root)            // root at L.CAULDRON, y = 0
//   every frame:  c.setPotion(s.cauldron.potion, s.cauldron.capacity)
//                 c.flash(clamp01(1 - s.cauldron.sinceFill / 0.25))
//                 c.update(dt, t)
//                 stage.potionLight.position.y = c.liquidY + 0.3; stage.potionLight.intensity = LIGHT.potionFull * c.fill
//   on the 'bigCauldron' unlock:  c.setBig(true)
//   bathers: stand them at L.BATH_SEATS (times 1.15 when big) with their chest at c.liquidY; the bowl floor is opaque.
//
// Post-process: the flame strands and sparks carry userData.outline = false (never outlined); the iron, the logs and
// the liquid are ordinary outlined geometry. The ember glow is a transparent decal at y = 0.018.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { P, PAL, hex } from '../../config'
import { gloss, lam, unlit, type GalleryItem } from '../materials'

export interface CauldronModel {
  /** Origin on the ground under the bowl centre (L.CAULDRON). Free for the binder: setBig scales an inner group, not root. */
  root: THREE.Group
  /**
   * Potion level. `units` of `capacity` (10, or 20 for the big pot) are mapped through the SPEC 2.6 depth table to the
   * height and radius of the liquid disc; 0 hides the liquid and shows the bare metal. The displayed level eases to
   * the new value in about 0.13 s inside update(); pass `snap` = true to jump (initial state, screenshots).
   */
  setPotion(units: number, capacity: number, snap?: boolean): void
  /** Over-brightening of the liquid surface toward white, 0..1 (1 right when a flask lands, fading to 0 in about 0.25 s). Stateless. */
  flash(k: number): void
  /** Upgraded pot (SPEC 2.12): everything is scaled by 1.15. rimY / rimRadius / liquidY / liquidRadius follow. */
  setBig(big: boolean): void
  /** Animate fire strands, sparks, ember glow and the liquid surface. `t` = absolute seconds, `dt` = frame time. No allocations. */
  update(dt: number, t: number): void
  /** Height of the top of the rim above the ground (1.7, or 1.955 when big). */
  readonly rimY: number
  /** Radius of the rim centre line (1.7, or 1.955 when big). */
  readonly rimRadius: number
  /** Current height of the liquid surface above the ground (0.38 = the bowl floor when empty .. 1.50 full; x 1.15 when big): bathers stand chest-deep in it, splashes start here. */
  readonly liquidY: number
  /** Current radius of the liquid surface (0 when empty .. 1.56 full; x 1.15 when big). */
  readonly liquidRadius: number
  /** Displayed fill fraction 0..1 (eased): drive the cyan potion light with it. */
  readonly fill: number
  /** Fire flicker multiplier around 1 (+-20 % at about 10 Hz), updated by update(). Optional: the stage already flickers its own fire light. */
  readonly fireLevel: number
}

const R = P.CAULDRON_RIM_DIAMETER / 2 // rim centre-line radius
const RIM_Y = P.CAULDRON_RIM_HEIGHT // top of the rim
const LIP = 0.045 // how far the rim collar stands out from the bowl
const RIM_IN = 0.05 // how far the flat top of the rim reaches inward from R
const EQ_Y = RIM_Y - 0.04 // equator of the bowl ellipse
// Outside: a full-sided pot (superellipse, exponent OUT_N) over the fire, as in the ad's silhouette.
// Inside: the squashed hemisphere of SPEC 7.4 (floor 0.38 above ground), which is what the SPEC 2.6 liquid table assumes.
const OUT_BOTTOM = 0.25 // fitted to the ad silhouette at 8.6 s (the bowl bottom shows 1.65 m below the rim centre on screen)
const OUT_N = 2.5
const IN_R = 0.92 * R + 0.012 // inner radius at the equator
const IN_BOTTOM = 0.38
const SURF_R = 0.92 * R // liquid surface radius at h = 1 (SPEC 2.6); the full pot then stands 0.2 m below the rim top, leaving a dark band of inner wall (ad 11.4 s)
const BIG_SCALE = 1.15

/** SPEC 2.6: liquid depth h for potion = 0..10 of 10; surface radius = SURF_R * sqrt(2h - h^2). */
const DEPTH = [0, 0.27, 0.39, 0.49, 0.57, 0.65, 0.73, 0.8, 0.87, 0.93, 1.0]

/** Height of the outer shell at radius r. */
const outerY = (r: number) => (r >= R ? EQ_Y : EQ_Y - (EQ_Y - OUT_BOTTOM) * Math.pow(1 - Math.pow(r / R, OUT_N), 1 / OUT_N))

// Fire palette (ad 8.6 / 11.4 s: mid #c66d48 .. #d77841, light #e18550 .. #ea8f52, pale tips #f8b486, dark #9e462b):
// a red-orange mass with lighter orange strands, NOT yellow straw.
const FIRE_RED = new THREE.Color(PAL.fire).lerp(new THREE.Color(PAL.fireDark), 0.45)
const FIRE_PALE = new THREE.Color(PAL.fire).lerp(new THREE.Color(PAL.cream), 0.42)
/** Brightest flame strands: PAL.fireBright pushed 25 % over (stays saturated and feeds the bloom). */
const FIRE_HI = new THREE.Color(PAL.fireBright).multiplyScalar(1.25)
const mixHex = (a: number, b: number, t: number) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()
const rnd = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7 + 0.37) * 43758.5453
  return x - Math.floor(x)
}

// ---------------------------------------------------------------------------------------------------------------
// textures (shared)

const RIM_SWATCH_X = 103 // canvas x of the rim-edge swatch in innerTexture() (away from the three seams)
let innerTex: THREE.CanvasTexture | null = null
/**
 * Painting of the empty bowl, unwrapped: canvas x = angle around the bowl (u = 0 is south, 0.25 east), canvas y = from
 * the bowl floor (top row) up the wall to the rim (bottom row). Dark wall, worn grey metal, bright patch on the floor
 * reaching further up the south side (the light comes from the north), three faint seams.
 */
function innerTexture(): THREE.CanvasTexture {
  if (innerTex) return innerTex
  const W = 512
  const H = 128
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  // ad 8.6 s: bright worn floor (#c7bfb6), mid-grey wall (#928d91 .. #6f6c70), dark only just under the rim (#3a383f)
  const stops: [number, string][] = [
    [0, hex(PAL.cauldronInBright)],
    [0.2, mixHex(PAL.cauldronInBright, PAL.cauldronIn, 0.12)],
    [0.38, mixHex(PAL.cauldronInBright, PAL.cauldronIn, 0.5)],
    [0.55, mixHex(PAL.cauldronInBright, PAL.cauldronIn, 0.85)],
    [0.72, hex(PAL.cauldronIn)],
    [1, mixHex(PAL.cauldronIn, 0x000000, 0.45)],
  ]
  const STRIP = 4
  for (let x = 0; x < W; x += STRIP) {
    const k = 1 + 0.12 * Math.cos(((x + STRIP / 2) / W) * Math.PI * 2) // south side: bright zone climbs a little higher
    const grad = g.createLinearGradient(0, 0, 0, H)
    for (const [t, col] of stops) grad.addColorStop(Math.min(1, t === 1 ? 1 : t * k), col)
    g.fillStyle = grad
    g.fillRect(x, 0, STRIP, H)
  }
  // mottling on the floor and the lower wall
  for (let i = 0; i < 46; i++) {
    const x = rnd(i, 7) * W
    const y = (0.14 + rnd(i, 8) * rnd(i, 8) * 0.6) * H // not at the very top rows: they all meet at the floor centre
    const r = 10 + rnd(i, 9) * 26
    for (const dx of [0, -W, W]) {
      const grad = g.createRadialGradient(x + dx, y, 0, x + dx, y, r)
      const a = 0.05 + rnd(i, 10) * 0.08
      grad.addColorStop(0, rnd(i, 11) > 0.5 ? `rgba(255,252,248,${a})` : `rgba(40,36,44,${a})`)
      grad.addColorStop(1, 'rgba(128,128,128,0)')
      g.fillStyle = grad
      g.fillRect(x + dx - r, y - r, r * 2, r * 2)
    }
  }
  // worn brush streaks running around the wall
  for (let i = 0; i < 90; i++) {
    const y = (0.12 + 0.8 * rnd(i, 1)) * H
    const x = rnd(i, 2) * W
    const len = 12 + rnd(i, 3) * 70
    g.fillStyle = rnd(i, 4) > 0.45 ? `rgba(255,250,245,${0.015 + rnd(i, 5) * 0.035})` : `rgba(10,8,14,${0.03 + rnd(i, 5) * 0.06})`
    g.fillRect(x, y, len, 1 + rnd(i, 6) * 4)
    if (x + len > W) g.fillRect(x - W, y, len, 1 + rnd(i, 6) * 4)
  }
  // seams: one toward the far wall as seen by the game camera (north-east), two more at +-120 deg
  const u0 = Math.atan2(0.64, -0.77) / (Math.PI * 2)
  for (let k = 0; k < 3; k++) {
    const x = (((u0 + k / 3) % 1) + 1) % 1 * W
    g.globalAlpha = k === 0 ? 1 : 0.65
    g.fillStyle = 'rgba(22,18,26,0.7)'
    g.beginPath()
    g.moveTo(x, 0)
    g.bezierCurveTo(x + 2.5, H * 0.3, x - 2, H * 0.65, x + 0.5, H)
    g.lineTo(x + 2.2, H)
    g.bezierCurveTo(x - 0.3, H * 0.65, x + 4.2, H * 0.3, x + 1.7, 0)
    g.fill()
    g.fillStyle = 'rgba(255,250,245,0.12)'
    g.fillRect(x + 2.6, 0, 1, H)
  }
  g.globalAlpha = 1
  // swatch for the thin light edge of the rim (its vertices all sample this texel; on the bowl it is a speck at the floor centre)
  g.fillStyle = mixHex(PAL.cauldronInBright, 0xffffff, 0.55)
  g.fillRect(RIM_SWATCH_X - 3, 0, 6, 2)
  innerTex = new THREE.CanvasTexture(c)
  innerTex.colorSpace = THREE.SRGBColorSpace
  innerTex.wrapS = THREE.RepeatWrapping
  innerTex.anisotropy = 4
  return innerTex
}

/** Side of the square ember decal on the ground. The painted fire reaches about 2.2 m from the centre (collider: 2.15 m). */
const EMBER_SIZE = 4.9
let emberTex: THREE.CanvasTexture | null = null
/** Top view of the fire bed: red-orange glow fading at a ragged edge, covered with a mat of thin strands. */
function emberTexture(): THREE.CanvasTexture {
  if (emberTex) return emberTex
  const S = 512
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  const css = (col: THREE.Color, a: number) => {
    const h = Number.parseInt(col.getHexString(), 16) // clamped to 8 bit, sRGB
    return `rgba(${(h >> 16) & 255},${(h >> 8) & 255},${h & 255},${a})`
  }
  const fire = new THREE.Color(PAL.fire)
  const dark = new THREE.Color(PAL.fireDark)
  const bright = new THREE.Color(PAL.fireBright)
  const H = S / 2
  // glow under and around the bowl
  const grad = g.createRadialGradient(H, H, 0, H, H, H)
  grad.addColorStop(0, css(fire, 1))
  grad.addColorStop(0.5, css(FIRE_RED, 1))
  grad.addColorStop(0.7, css(FIRE_RED, 0.96))
  grad.addColorStop(0.79, css(dark, 0.75))
  grad.addColorStop(0.87, css(dark, 0.16))
  grad.addColorStop(0.95, css(dark, 0))
  g.fillStyle = grad
  g.fillRect(0, 0, S, S)
  // strands: dark ones first, the light ones on top; a few long ones poke out to make the edge ragged
  g.lineCap = 'round'
  const cols = [dark, FIRE_RED, FIRE_RED, fire, FIRE_RED, fire, FIRE_PALE, fire, bright, FIRE_PALE]
  const N = 1900
  for (let i = 0; i < N; i++) {
    const a = rnd(i, 11) * Math.PI * 2
    const lobes = 0.86 + 0.14 * Math.sin(a * 7 + 1.3) * Math.sin(a * 3 + 0.4) // ragged outline
    const r = Math.sqrt(0.1 + rnd(i, 12) * 0.55) * lobes * H
    const dir = a + (rnd(i, 13) - 0.5) * 2.2
    const len = (0.045 + rnd(i, 14) * 0.075) * S * (1 - (r / H) * 0.3)
    const x = H + Math.cos(a) * r
    const y = H + Math.sin(a) * r
    g.beginPath()
    g.moveTo(x, y)
    g.quadraticCurveTo(x + Math.cos(dir + 0.5) * len * 0.5, y + Math.sin(dir + 0.5) * len * 0.5, x + Math.cos(dir) * len, y + Math.sin(dir) * len)
    const ci = Math.min(cols.length - 1, Math.floor((i / N) * 0.6 * cols.length + rnd(i, 15) * 0.4 * cols.length))
    g.strokeStyle = css(cols[ci]!, 0.6 + rnd(i, 16) * 0.4)
    g.lineWidth = 1.4 + rnd(i, 17) * 2.0
    g.stroke()
  }
  emberTex = new THREE.CanvasTexture(c)
  emberTex.colorSpace = THREE.SRGBColorSpace
  return emberTex
}

// ---------------------------------------------------------------------------------------------------------------
// geometry (shared)

let ironGeo: THREE.BufferGeometry | null = null
let innerGeo: THREE.BufferGeometry | null = null
let logGeo: THREE.BufferGeometry | null = null
let strandGeo: THREE.BufferGeometry | null = null

const SEG = 48

/** Outer shell + rim collar + two lugs + four rivet plates: everything made of dark iron, one mesh. */
function ironGeometry(): THREE.BufferGeometry {
  if (ironGeo) return ironGeo
  const parts: THREE.BufferGeometry[] = []
  const strip = (g: THREE.BufferGeometry) => {
    const o = g.index ? g.toNonIndexed() : g
    o.deleteAttribute('uv')
    return o
  }
  // LatheGeometry faces outward when the profile runs bottom -> top
  const pts: THREE.Vector2[] = []
  for (let k = 0; k <= 16; k++) {
    const a = (k / 16) * (Math.PI / 2)
    const e = 2 / OUT_N
    pts.push(new THREE.Vector2(Math.max(0.001, R * Math.pow(Math.sin(a), e)), EQ_Y - (EQ_Y - OUT_BOTTOM) * Math.pow(Math.cos(a), e)))
  }
  parts.push(strip(new THREE.LatheGeometry(pts, SEG)))
  // rim: a collar band with a narrow flat top (the thin light edge runs along its outer corner, see innerGeometry)
  const lip = [
    [R - 0.01, EQ_Y - 0.16], [R + LIP, EQ_Y - 0.13], [R + LIP, RIM_Y - 0.02], [R + LIP - 0.02, RIM_Y], [R - RIM_IN, RIM_Y], [R - RIM_IN - 0.015, RIM_Y - 0.05],
  ].map(p => new THREE.Vector2(p[0], p[1]))
  const rim = new THREE.LatheGeometry(lip, SEG).toNonIndexed()
  rim.deleteAttribute('uv')
  rim.computeVertexNormals() // faceted: the flat top catches the light
  parts.push(rim)
  // lugs: the +x one stands up on the rim (the loop seen at the upper right in the ad); the -x one, on the side that
  // faces the game camera, hangs down against the wall from its plate so that it does not cut into the rim line
  for (const s of [-1, 1]) {
    const lug = new THREE.TorusGeometry(0.14, 0.042, 6, 12)
    if (s > 0) {
      lug.rotateZ(-0.45) // lean outward
      lug.translate(R + 0.09, RIM_Y + 0.11, 0)
    } else lug.translate(-(R + LIP + 0.05), RIM_Y - 0.3, 0)
    parts.push(strip(lug))
    const foot = new THREE.BoxGeometry(0.16, 0.14, 0.2)
    foot.translate(s * (R + 0.03), RIM_Y - (s > 0 ? 0.06 : 0.12), 0)
    parts.push(strip(foot))
  }
  // rivet plates just below the rim on the diagonals
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2
    const plate = new THREE.BoxGeometry(0.2, 0.24, 0.05)
    plate.translate(0, EQ_Y - 0.36, R * 0.99)
    plate.rotateY(a)
    parts.push(strip(plate))
  }
  ironGeo = mergeGeometries(parts, false)!
  return ironGeo
}

/**
 * Inside surface (faces inward) + the thin light edge line of the rim, one unlit textured mesh.
 * Lathe UVs: u = angle, v = 0 at the rim .. 1 at the floor centre (see innerTexture); the edge samples the swatch texel.
 */
function innerGeometry(): THREE.BufferGeometry {
  if (innerGeo) return innerGeo
  const pts: THREE.Vector2[] = [new THREE.Vector2(R - RIM_IN - 0.015, RIM_Y - 0.05)]
  const N = 14
  for (let k = N; k >= 0; k--) {
    const a = (k / N) * (Math.PI / 2)
    pts.push(new THREE.Vector2(Math.max(0.001, IN_R * Math.sin(a)), EQ_Y - (EQ_Y - IN_BOTTOM) * Math.cos(a)))
  }
  const bowl = new THREE.LatheGeometry(pts, SEG)
  // light edge: a slim ring lying on the outer corner of the rim top (ad: a thin near-white line all round the rim)
  const edge = new THREE.TorusGeometry(R + LIP - 0.03, 0.016, 4, SEG)
  edge.rotateX(Math.PI / 2)
  edge.translate(0, RIM_Y - 0.002, 0)
  const uv = edge.getAttribute('uv') as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, RIM_SWATCH_X / 512, 1 - 1 / 128)
  innerGeo = mergeGeometries([bowl, edge], false)!
  bowl.dispose()
  edge.dispose()
  return innerGeo
}

const LOGS = 7
/** Azimuth (from +x toward +z) that points at the game camera: one log lies straight toward the viewer, as in the ad. */
const CAMERA_AZIMUTH = Math.atan2(P.CAMERA_OFFSET[2], P.CAMERA_OFFSET[0])
/**
 * Seven chunky charred lumps laid radially, inner ends in the fire, blunt outer tips at r = 2.0 - 2.15 (SPEC 7.4 /
 * art.md 2.9; the ad shows 6-7 of them about every 51 deg). Vertex-coloured: bark on top, dark outer ends, flanks and
 * inner ends glowing red from the flames between them.
 */
function logsGeometry(): THREE.BufferGeometry {
  if (logGeo) return logGeo
  const parts: THREE.BufferGeometry[] = []
  const bark = new THREE.Color(PAL.log)
  const dark = new THREE.Color(PAL.logDark)
  const hot = new THREE.Color(PAL.fireDark)
  const c = new THREE.Color()
  for (let i = 0; i < LOGS; i++) {
    const len = 0.8 + rnd(i, 21) * 0.16
    const thick = 0.84 + rnd(i, 22) * 0.2
    const g = new THREE.CylinderGeometry(1, 1, len, 6, 3)
    // rings along the axis (cylinder +y = outer end): fat middle, blunt tapered tip; lumpy (coincident vertices move together)
    const p = g.getAttribute('position')
    for (let v = 0; v < p.count; v++) {
      const x = p.getX(v)
      const y = p.getY(v)
      const z = p.getZ(v)
      const t = y / len + 0.5 // 0 = inner end, 1 = tip
      const rad = Math.hypot(x, z) < 0.5 ? 0 : (t < 0.2 ? 0.25 : t < 0.5 ? 0.31 : t < 0.8 ? 0.29 : 0.15) * thick
      const h = Math.round(x * 50) * 13 + Math.round(y * 50) * 7 + Math.round(z * 50) * 3 + i * 101
      const k = 1 + (rnd(h, 1) - 0.5) * 0.46
      p.setXYZ(v, x * rad * k, y + (rnd(h, 2) - 0.5) * 0.1 + (rad === 0 && t > 0.5 ? 0.08 : 0), z * rad * k)
    }
    g.rotateY(rnd(i, 23) * 6)
    g.rotateZ(-Math.PI / 2) // axis along x, tip toward +x
    g.scale(1, 0.84, 1.08) // a little flattened
    g.rotateZ(0.06 + rnd(i, 24) * 0.14) // tip lifted a little
    g.rotateY((rnd(i, 25) - 0.5) * 0.3)
    g.translate(2.0 - len / 2 + rnd(i, 26) * 0.08, 0.25 * thick, 0)
    g.rotateY(-(CAMERA_AZIMUTH + (i * Math.PI * 2) / LOGS + (rnd(i, 27) - 0.5) * 0.16))
    const o = g.toNonIndexed()
    g.dispose()
    o.deleteAttribute('uv')
    o.computeVertexNormals()
    const op = o.getAttribute('position')
    const on = o.getAttribute('normal')
    const col = new Float32Array(op.count * 3)
    for (let v = 0; v < op.count; v += 3) {
      // one colour per facet
      const cx = (op.getX(v) + op.getX(v + 1) + op.getX(v + 2)) / 3
      const cz = (op.getZ(v) + op.getZ(v + 1) + op.getZ(v + 2)) / 3
      const r = Math.hypot(cx, cz) || 1
      const up = on.getY(v)
      const radial = (on.getX(v) * cx + on.getZ(v) * cz) / r // +1 = facing away from the fire
      const flank = Math.sqrt(Math.max(0, 1 - up * up - radial * radial))
      c.copy(dark).lerp(bark, Math.max(0, up))
      c.multiplyScalar(0.7 + 0.4 * rnd(v + i * 977, 3)) // facet-to-facet variation
      const near = Math.min(1, Math.max(0, (2.1 - r) / 0.8)) // 1 at the bowl, 0 at the tip
      const heat = near * (0.5 * flank * (1 - Math.max(0, up)) + 0.8 * Math.max(0, -radial)) + Math.max(0, -up) * 0.4
      c.lerp(hot, Math.min(0.6, heat))
      for (let k = 0; k < 3; k++) {
        col[(v + k) * 3] = c.r
        col[(v + k) * 3 + 1] = c.g
        col[(v + k) * 3 + 2] = c.b
      }
    }
    o.setAttribute('color', new THREE.BufferAttribute(col, 3))
    parts.push(o)
  }
  logGeo = mergeGeometries(parts, false)!
  for (const p of parts) p.dispose()
  return logGeo
}

/**
 * One flame strand: a thin tapered 3-sided blade of unit length along +y, bending toward +z.
 * Instance scale is (thickness, length, length), so the bend grows with the length.
 */
function strandGeometry(): THREE.BufferGeometry {
  if (strandGeo) return strandGeo
  const N = 4
  const pos: number[] = []
  const idx: number[] = []
  for (let k = 0; k <= N; k++) {
    const t = k / N
    const w = Math.pow(1 - t, 0.75) + 0.04
    const cz = 0.38 * t * t
    for (let j = 0; j < 3; j++) {
      const a = (j / 3) * Math.PI * 2
      pos.push(Math.cos(a) * 0.5 * w, t, cz + Math.sin(a) * 0.045 * w)
    }
  }
  for (let k = 0; k < N; k++)
    for (let j = 0; j < 3; j++) {
      const a = k * 3 + j
      const b = k * 3 + ((j + 1) % 3)
      idx.push(a, b, a + 3, b, b + 3, a + 3)
    }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  strandGeo = g
  return g
}

// ---------------------------------------------------------------------------------------------------------------
// liquid surface shader (unlit, emissive look, drifting foam blotches, flash)

const LIQUID_VERT = /* glsl */ `
varying vec2 vUv;
#include <common>
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`
const LIQUID_FRAG = /* glsl */ `
uniform float uTime;
uniform float uFlash;
uniform float uRadius;
uniform vec3 uBase;
uniform vec3 uFoam;
uniform vec3 uEdge;
varying vec2 vUv;
#include <common>
#include <fog_pars_fragment>
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { return 0.6 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 7.1) + 0.1 * vnoise(p * 4.1 + 3.3); }
void main() {
  vec2 q = (vUv - 0.5) * 2.0;
  float d = length(q);
  vec2 p = q * uRadius;
  float n1 = fbm(p * 1.25 + vec2(uTime * 0.13, -uTime * 0.08));
  float n2 = fbm(p * 2.1 - vec2(uTime * 0.1, uTime * 0.15) + 4.0);
  float n = n1 * 0.62 + n2 * 0.48;
  float foam = smoothstep(0.54, 0.82, n);
  vec3 col = mix(uBase, uEdge, smoothstep(0.5, 0.2, n) * 0.22);
  col = mix(col, uFoam, foam * 0.6 + 0.25 * smoothstep(0.75, 0.0, d)); // soft pale blotches, a little paler toward the middle
  col *= 0.98 + 0.03 * sin(d * uRadius * 4.5 - uTime * 1.7);
  col = mix(col, uEdge, smoothstep(0.86, 1.0, d) * 0.6);
  col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0) * 0.88);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`

// ---------------------------------------------------------------------------------------------------------------

const GROUND_STRANDS = 110 // straw-like strands lying on the ember bed
const FLAME_STRANDS = 100 // more upright strands licking up between the logs toward the bowl
const STRANDS = GROUND_STRANDS + FLAME_STRANDS
const SPARKS = 14
const STRAND_COLORS = [new THREE.Color(PAL.fire), new THREE.Color(PAL.fire), FIRE_RED, FIRE_RED, FIRE_PALE, FIRE_HI, FIRE_PALE, new THREE.Color(PAL.fire)]

/** Black iron cauldron on its log fire (SPEC 7.4). See the header comment for the binding recipe. */
export function makeCauldron(): CauldronModel {
  const root = new THREE.Group()
  const body = new THREE.Group()
  root.add(body)

  // --- iron ---
  body.add(new THREE.Mesh(ironGeometry(), gloss(PAL.cauldronOut, { shininess: 12, specular: 0x2a222a })))
  body.add(new THREE.Mesh(innerGeometry(), unlit(0xffffff, { map: innerTexture(), transparent: false })))

  // --- fire ---
  const emberMat = unlit(0xffffff, { map: emberTexture(), transparent: true, depthWrite: false }).clone()
  const ember = new THREE.Mesh(new THREE.PlaneGeometry(EMBER_SIZE, EMBER_SIZE), emberMat)
  ember.rotation.x = -Math.PI / 2
  ember.position.y = 0.018
  ember.renderOrder = 2
  body.add(ember)
  body.add(new THREE.Mesh(logsGeometry(), lam(0xffffff, { vertexColors: true })))

  const strands = new THREE.InstancedMesh(strandGeometry(), unlit(0xffffff, { side: THREE.DoubleSide }), STRANDS)
  strands.frustumCulled = false
  strands.userData.outline = false // stage post-process: flames are never outlined (drawn in the FX pass)
  strands.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  // per-strand constants: x, z, yaw, tilt, length, thickness, phase, speed
  const sd = new Float32Array(STRANDS * 8)
  for (let i = 0; i < STRANDS; i++) {
    const ground = i < GROUND_STRANDS
    const a = rnd(i, 31) * Math.PI * 2
    const r = ground ? Math.sqrt(1.0 + rnd(i, 32) * (1.8 * 1.8 - 1.0)) : 1.0 + rnd(i, 32) * 0.95
    const yaw = Math.atan2(Math.cos(a), Math.sin(a)) + (rnd(i, 33) - 0.5) * (ground ? 2.2 : 1.3) + (ground ? 0 : Math.PI * (rnd(i, 30) > 0.6 ? 1 : 0)) // outward +- jitter; some flames lean in toward the bowl
    const tilt = ground ? 0.95 + rnd(i, 34) * 0.5 : 0.08 + rnd(i, 34) * 0.5
    let len = ground ? (0.36 + rnd(i, 35) * 0.4) * (1.25 - 0.3 * r) : (0.4 + rnd(i, 35) * 0.5) * (1.3 - 0.3 * r) // shorter toward the edge (the fire stays inside the 2.15 m collider + a little)
    // keep the tip outside the bowl shell
    for (let k = 0; k < 8; k++) {
      const reach = len * (Math.sin(tilt) + 0.38 * Math.cos(tilt))
      const tipR = Math.hypot(Math.cos(a) * r + Math.sin(yaw) * reach, Math.sin(a) * r + Math.cos(yaw) * reach)
      const tipY = len * (Math.cos(tilt) - 0.38 * Math.sin(tilt)) + 0.05
      if (tipR > R || tipY < outerY(tipR) - 0.04) break
      len *= 0.85
    }
    const o = i * 8
    sd[o] = Math.cos(a) * r
    sd[o + 1] = Math.sin(a) * r
    sd[o + 2] = yaw
    sd[o + 3] = tilt
    sd[o + 4] = len
    sd[o + 5] = ground ? 0.05 + rnd(i, 36) * 0.03 : 0.055 + rnd(i, 36) * 0.04
    sd[o + 6] = rnd(i, 37) * Math.PI * 2
    sd[o + 7] = 7 + rnd(i, 38) * 9
    strands.setColorAt(i, STRAND_COLORS[Math.floor(rnd(i, 39) * STRAND_COLORS.length)]!)
  }
  body.add(strands)
  const sArr = strands.instanceMatrix.array as Float32Array

  const sparks = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), unlit(PAL.goldCore), SPARKS)
  sparks.frustumCulled = false
  sparks.userData.outline = false
  sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  body.add(sparks)
  const pArr = sparks.instanceMatrix.array as Float32Array
  pArr.fill(0)

  // --- liquid ---
  const liquidMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uFlash: { value: 0 },
        uRadius: { value: 1 },
        uBase: { value: new THREE.Color(PAL.potion) },
        uFoam: { value: new THREE.Color(PAL.foam) },
        uEdge: { value: new THREE.Color(PAL.potion).lerp(new THREE.Color(PAL.bubble), 0.45) },
      },
    ]),
    vertexShader: LIQUID_VERT,
    fragmentShader: LIQUID_FRAG,
    fog: true,
  })
  const liquidGeo = new THREE.CircleGeometry(1, SEG)
  liquidGeo.rotateX(-Math.PI / 2)
  const liquid = new THREE.Mesh(liquidGeo, liquidMat)
  liquid.visible = false
  body.add(liquid)

  // --- state ---
  let target = 0 // 0..10 (index into DEPTH)
  let shown = 0
  let scale = 1
  let surfY = IN_BOTTOM
  let surfR = 0
  let fireLevel = 1

  const applyLevel = () => {
    const i = Math.min(9, Math.floor(shown))
    const h = DEPTH[i]! + (DEPTH[i + 1]! - DEPTH[i]!) * (shown - i)
    // SPEC 2.6: surface radius = 0.92 x rim radius x sqrt(2h - h^2); the height is where the inner wall has that radius
    surfR = shown <= 0.001 ? 0 : SURF_R * Math.sqrt(Math.max(0, 2 * h - h * h))
    const q = surfR / IN_R
    surfY = EQ_Y - (EQ_Y - IN_BOTTOM) * Math.sqrt(Math.max(0, 1 - q * q))
    liquid.visible = surfR > 0.02
    liquid.position.y = surfY
    liquid.scale.set(surfR * 1.006, 1, surfR * 1.006)
    liquidMat.uniforms.uRadius!.value = surfR
  }

  const model: CauldronModel = {
    root,
    setPotion(units, capacity, snap = false) {
      const f = capacity > 0 ? units / capacity : 0
      target = (f < 0 ? 0 : f > 1 ? 1 : f) * 10
      if (snap && shown !== target) {
        shown = target
        applyLevel()
      }
    },
    flash(k) {
      liquidMat.uniforms.uFlash!.value = k
    },
    setBig(big) {
      scale = big ? BIG_SCALE : 1
      body.scale.setScalar(scale)
    },
    update(dt, t) {
      if (shown !== target) {
        shown += (target - shown) * (1 - Math.exp(-dt / 0.045))
        if (Math.abs(target - shown) < 0.004) shown = target
        applyLevel()
      }
      liquidMat.uniforms.uTime!.value = t
      if (liquid.visible) liquid.position.y = surfY + Math.sin(t * 2.3) * 0.012

      fireLevel = 1 + 0.12 * Math.sin(t * 61) + 0.08 * Math.sin(t * 37 + 1.3)
      emberMat.opacity = 0.9 + 0.1 * Math.sin(t * 23 + 0.7) * Math.sin(t * 7.1)

      // strands: matrix = T * Ry(yaw) * Rx(tilt) * S(thick, len, len), written straight into the instance buffer
      for (let i = 0; i < STRANDS; i++) {
        const o = i * 8
        const ph = sd[o + 6]!
        const sp = sd[o + 7]!
        const fl = 0.5 + 0.5 * Math.sin(t * sp + ph)
        const len = sd[o + 4]! * (0.68 + 0.32 * fl * (0.6 + 0.4 * Math.sin(t * sp * 0.37 + ph * 3)))
        const tilt = sd[o + 3]! + 0.13 * Math.sin(t * sp * 0.61 + ph * 2)
        const yaw = sd[o + 2]! + 0.2 * Math.sin(t * sp * 0.43 + ph * 5)
        const th = sd[o + 5]!
        const ca = Math.cos(tilt)
        const sa = Math.sin(tilt)
        const cb = Math.cos(yaw)
        const sb = Math.sin(yaw)
        const m = i * 16
        sArr[m] = th * cb
        sArr[m + 1] = 0
        sArr[m + 2] = -th * sb
        sArr[m + 3] = 0
        sArr[m + 4] = len * sa * sb
        sArr[m + 5] = len * ca
        sArr[m + 6] = len * sa * cb
        sArr[m + 7] = 0
        sArr[m + 8] = len * ca * sb
        sArr[m + 9] = -len * sa
        sArr[m + 10] = len * ca * cb
        sArr[m + 11] = 0
        sArr[m + 12] = sd[o]!
        sArr[m + 13] = 0.02
        sArr[m + 14] = sd[o + 1]!
        sArr[m + 15] = 1
      }
      strands.instanceMatrix.needsUpdate = true

      // sparks: each one loops (rise, drift outward, shrink); a new spot every loop
      for (let i = 0; i < SPARKS; i++) {
        const period = 0.7 + rnd(i, 41) * 0.8
        const u = t / period + rnd(i, 42)
        const cyc = Math.floor(u)
        const f = u - cyc
        const a = rnd(i * 17 + cyc, 43) * Math.PI * 2
        const r = 1.15 + rnd(i * 17 + cyc, 44) * 0.9 + f * 0.35
        const s = (0.028 + rnd(i, 45) * 0.03) * (1 - f) * (f < 0.1 ? f * 10 : 1)
        const m = i * 16
        pArr[m] = s
        pArr[m + 5] = s * 1.8
        pArr[m + 10] = s
        pArr[m + 12] = Math.cos(a) * r + Math.sin(t * 9 + i) * 0.04
        pArr[m + 13] = 0.15 + f * (0.9 + rnd(i * 17 + cyc, 46) * 1.1)
        pArr[m + 14] = Math.sin(a) * r
        pArr[m + 15] = 1
      }
      sparks.instanceMatrix.needsUpdate = true
    },
    get rimY() {
      return RIM_Y * scale
    },
    get rimRadius() {
      return R * scale
    },
    get liquidY() {
      return surfY * scale
    },
    get liquidRadius() {
      return surfR * scale
    },
    get fill() {
      return shown / 10
    },
    get fireLevel() {
      return fireLevel
    },
  }
  model.update(0, 0) // place the flame strands and sparks so the model is complete before the first frame
  return model
}

// ---------------------------------------------------------------------------------------------------------------
// gallery

function gItem(units: number, capacity: number, big = false): THREE.Object3D {
  const c = makeCauldron()
  c.setBig(big)
  c.setPotion(units, capacity, true)
  c.root.userData.model = c
  return c.root
}
const anim = (o: THREE.Object3D, t: number) => (o.userData.model as CauldronModel).update(1 / 60, t)

/** Pour demo: 10 flasks land 0.08 s apart with a flash each, hold, drain by 2 per "bath", repeat. */
function animPour(o: THREE.Object3D, t: number) {
  const c = o.userData.model as CauldronModel
  const u = t % 6
  const landed = Math.min(10, Math.floor(u / 0.08))
  const units = u < 2 ? landed : Math.max(0, 10 - 2 * Math.floor((u - 2) / 0.8))
  c.setPotion(units, 10)
  c.flash(u < 0.9 ? Math.max(0, 1 - (u - landed * 0.08) / 0.25) : 0)
  c.update(1 / 60, t)
}

export const GALLERY: GalleryItem[] = [
  { name: 'cauldron empty', size: 2.5, make: () => gItem(0, 10), animate: anim },
  { name: 'cauldron 1 unit', size: 2.5, make: () => gItem(1, 10), animate: anim },
  { name: 'cauldron 5 units', size: 2.5, make: () => gItem(5, 10), animate: anim },
  { name: 'cauldron 10 units', size: 2.5, make: () => gItem(10, 10), animate: anim },
  { name: 'cauldron big 20 of 20', size: 2.9, make: () => gItem(20, 20, true), animate: anim },
  { name: 'cauldron pour and drain', size: 2.5, make: () => gItem(0, 10), animate: animPour },
]
