// Villagers: the individual stocky villager (sick / bathed / healed looks, every pose the simulation needs)
// and the packed sick crowd as instanced meshes with its green miasma (SPEC 2.7, 2.10, 7.4; art.md 2.10, 2.11).
import * as THREE from 'three'
import { P, PAL } from '../../config'
import { clamp01, damp, lerp } from '../../core/math'
import type { VillagerState } from '../../sim/types'
import type { CrowdSlot } from '../../world/crowd'
import { CROWD_SLOTS } from '../../world/crowd'
import { blobShadow, lam, type GalleryItem } from '../materials'
import { ball, bakeFigure, box, charMat, DEG, galleryItem, GAME_CAM_QUAT, glowTexture, limb, merge, mixHex, puffTexture, relight, rev, ballProfile, shade, solveArm, TAU, tone } from './doctor'

// ---------------------------------------------------------------------------------------------------
// Proportions (metres). Upright 1.95 m, hunched about 1.7 m, shoulders 0.95 m wide.
// ---------------------------------------------------------------------------------------------------
const HIP = 0.62
const THIGH = 0.28
const SHIN = 0.34
const LEG_X = 0.17
const SHOULDER_X = 0.39
const SHOULDER_Y = 0.56
const L1 = 0.34
const L2 = 0.33
const NECK_Y = 0.78
const HEAD_R = 0.2

export type VillagerLook = 'sick' | 'bathed' | 'healed'

/**
 * - stand: sick = hunched 35 deg with both hands on the head; bathed = hunched clutching the stomach; healed = upright.
 * - walk:  the same three attitudes walking (sick shuffle, bathed hobble, healed run with pumping arms); needs `phase`.
 * - hop:   tucked jump (into / out of the pot, off the bed); `phase` = progress 0..1. The binder moves the root along the arc.
 * - bathe: standing chest-deep; sick = still clutching the head, bathed/healed = leaning back with the arms spread on the rim.
 *          Sink the root so the liquid surface is VILLAGER_CHEST_Y above the model origin.
 * - lie:   curled on his side on a bed. Origin = mattress-top point at the bed centre, root +z must point at the bed HEAD
 *          (rotation.y = PI/2 for every bed of this game); he then faces the camera side (local -x).
 * - sit:   sitting up on the bed, one fist punching the air (same origin/orientation rule as lie).
 * - push:  leaning into the drill handle with both hands on the crossbar at `grip`; legs driven by `phase`.
 * - drive: seated on the cart bench (`seatHeight`), hands on the two levers at `grip`.
 */
export type VillagerPoseName = 'stand' | 'walk' | 'hop' | 'bathe' | 'lie' | 'sit' | 'push' | 'drive'

/** Height of the liquid surface above the model origin in the 'bathe' pose. */
export const VILLAGER_CHEST_Y = 1.12

export interface VillagerPose {
  /** Villager.look. Changing it swaps skin and clothes instantly (the cure at 85 % of the bath). */
  look: VillagerLook
  pose: VillagerPoseName
  /**
   * walk / push: metres travelled so far (any growing distance; without an odometer pass t * speed).
   * hop: progress 0..1. Ignored by the other poses.
   */
  phase: number
  /** Animation clock in seconds (GameState.time). */
  t: number
  /** Frame delta: pose changes blend over about 0.1 s. 0 or omitted = snap. */
  dt?: number
  /** Villager.alpha, 1 = solid .. 0 = gone (fade-out at the map exits). Default 1. */
  alpha?: number
  /** 0..1 injection tint: at 1 the whole figure is flat bright mint green (SPEC 2.10: treatT 0.5..1.2). Default 0. Ignored while alpha < 1. */
  tint?: number
  /** Villager.seed 0..1: desynchronises idle motion between villagers. */
  seed?: number
  /** Height of the root above the ground in metres (root.position.y during a hop): the blob shadow stays on the ground and shrinks. Default 0. */
  height?: number
  /** 0..1 size of the red wound glow of the bathed look: 0 in the pot, growing in as he leaves it (ad 14.4 -> 14.6 s). Default 1. */
  glow?: number
}

export interface VillagerModel {
  /** Feet (or the mattress point, see 'lie') at the origin, facing +z. The binder writes position (x, y, z) and rotation.y. */
  root: THREE.Group
  /** Empty group above the head (follows the pose): anchor for the sick-emoji bubble. */
  headAnchor: THREE.Group
  /** Hand position for 'push' and 'drive' in root space: x = half the hand spacing, y = height, z = distance ahead. */
  grip: THREE.Vector3
  /** Optional: the RIGHT hand's target when the hands are not mirrored (x = its distance to the right); grip is then the left hand only. null (default) = mirrored. */
  gripRight: THREE.Vector3 | null
  /** Bench height above the origin for 'drive'. */
  seatHeight: number
  /** Call every frame for a visible villager: cheap, allocation-free. */
  update(p: VillagerPose): void
}

/** The pose that goes with a simulation state (look comes from Villager.look). */
export function villagerPoseOf(state: VillagerState): VillagerPoseName {
  switch (state) {
    case 'toQueue':
    case 'toBed':
    case 'toExit':
    case 'toDrill':
      return 'walk'
    case 'hopIn':
    case 'hopOut':
    case 'hopOff':
      return 'hop'
    case 'bathing':
      return 'bathe'
    case 'lieDown':
    case 'inBed':
      return 'lie'
    case 'cheer':
      return 'sit'
    case 'atDrill':
    case 'pushing':
      return 'push'
    default:
      return 'stand'
  }
}

// ---------------------------------------------------------------------------------------------------
// Geometry (one set per look, shared by every villager)
// ---------------------------------------------------------------------------------------------------
interface VGeo {
  torso: THREE.BufferGeometry
  head: THREE.BufferGeometry
  upper: THREE.BufferGeometry
  fore: THREE.BufferGeometry
  thigh: THREE.BufferGeometry
  shin: THREE.BufferGeometry
}
const geoCache = new Map<string, VGeo>()

/** `lo` = reduced geometry for the instanced crowd (fewer segments, no face). */
function buildGeo(look: VillagerLook, lo: boolean): VGeo {
  const seg = lo ? 5 : 8
  const cap = lo ? 1 : 2
  const sick = look === 'sick'
  const skin = sick ? PAL.sickSkin : PAL.skin
  // bathed: grey-blue vest (vil2.jpg); healed: the same vest reads clearly blue once the red glow is gone (cured1.jpg, f_0122)
  const vest = sick ? PAL.sickShirt : look === 'bathed' ? tone(mixHex(PAL.vest, PAL.sickShirt, 0.4), 0.9) : mixHex(PAL.vest, PAL.sickShirt, 0.8)
  const sleeve = sick ? PAL.sickSleeve : PAL.shirt
  // (the legs are vertical and in shade: f_0079 / f_0122 show them a dark grey-blue, only the lit thighs of a sitting patient reach PAL.trousers)
  const trousers = sick ? tone(PAL.sickShirt, 0.62) : mixHex(PAL.trousers, tone(PAL.sickShirt, 0.62), 0.3)
  const collar = sick ? mixHex(PAL.sickSleeve, PAL.cream, 0.5) : PAL.shirt // pale band under the hair (crowd1.jpg)
  const shoe = tone(PAL.log, 0.62)
  const SZ = 0.88

  // --- torso (origin at the hips) ---
  const torso: THREE.BufferGeometry[] = []
  torso.push(
    shade(
      rev(
        [[0, -0.12], [0.2, -0.11], [0.33, -0.02], [0.385, 0.14], [0.42, 0.32], [0.415, 0.48], [0.36, 0.6], [0.23, 0.69], [0.14, 0.74], [0.12, 0.8], [0, 0.8]],
        lo ? 8 : 12,
        (i, j) => {
          if (i <= 1) return trousers
          if (i >= 8) return sick ? collar : skin // neck (sick: wrapped up to the hair, so no skin shows from behind)
          if (i === 7) return collar
          // bathed / healed: open vest showing the white shirt down the front
          if (!sick && (j === 0 || j === 11) && i >= 3) return PAL.shirt
          return i >= 4 ? mixHex(vest, sick ? PAL.sickShirtLight : PAL.shirt, sick ? 0.3 : 0.1) : vest
        },
        1,
        SZ,
      ),
      (_x, y) => 0.84 + 0.24 * clamp01(y / 0.6),
    ),
  )
  // waistband
  if (!lo) torso.push(rev([[0.345, -0.035], [0.355, -0.02], [0.362, 0.03], [0.357, 0.045]], 12, tone(trousers, 0.72), 1, SZ))
  if (sick) {
    // pale patches sewn on the back (art.md 2.10)
    const patch = (x: number, y: number, w: number, h: number) => {
      const r = 0.42
      torso.push(box(w, h, 0.02, mixHex(PAL.sickShirtLight, PAL.sickSleeve, 0.45)).translate(x, y, -Math.sqrt(r * r - x * x) * SZ - 0.004))
    }
    patch(-0.1, 0.4, 0.13, 0.11)
    patch(0.14, 0.24, 0.1, 0.09)
  }

  // --- head (origin at the neck) ---
  const head: THREE.BufferGeometry[] = []
  head.push(ball(HEAD_R, lo ? 7 : 10, lo ? 4 : 7, skin, 1, 1.06, 1).translate(0, 0.2, 0))
  // hair cap: stripes run front to back (painted comb strokes); the shell is revolved about the ear axis
  const hairHi = tone(PAL.hair, 1.22)
  const hair = rev(ballProfile(HEAD_R * 1.07, lo ? 6 : 9).slice(1, lo ? 6 : 9), lo ? 6 : 8, (i, j) => (j === 0 ? tone(PAL.hair, 0.8) : i % 2 ? hairHi : PAL.hair), 1, 1, 28 * DEG, 232 * DEG)
    .rotateZ(90 * DEG)
    .scale(1, 1.06, 1.03)
    .translate(0, 0.2, 0)
  // ears, brow, eyes, nose, mouth
  if (!lo) {
    for (const sx of [-1, 1]) {
      head.push(ball(0.05, 5, 3, tone(skin, 0.9)).translate(sx * 0.2, 0.19, 0.0))
      head.push(ball(0.026, 5, 3, PAL.hatBand).translate(sx * 0.075, 0.215, 0.178))
      head.push(box(0.085, 0.025, 0.03, tone(PAL.hair, 0.8)).rotateZ(sx * (sick ? 0.3 : -0.12)).translate(sx * 0.078, 0.262, 0.175))
    }
    head.push(ball(0.04, 5, 3, tone(skin, 0.9), 1, 1, 1).translate(0, 0.17, 0.2))
    head.push(box(sick ? 0.07 : 0.09, sick ? 0.045 : 0.02, 0.02, sick ? tone(PAL.hair, 0.5) : tone(skin, 0.62)).translate(0, 0.1, 0.183))
  }

  // --- limbs ---
  // sick: the tunic's short sleeve covers the shoulder, so from behind the crowd reads as blue backs (crowd1.jpg)
  const shoulder = sick ? mixHex(vest, PAL.sickShirtLight, 0.3) : sleeve
  const upper = shade(
    lo
      ? rev([[0, -L1 - 0.122], [0.122, -L1], [0.142, -L1 * 0.45], [0.158, 0], [0, 0.158]], seg, i => (i >= 2 ? shoulder : sleeve))
      : rev([[0, -L1 - 0.122], [0.086, -L1 - 0.086], [0.122, -L1], [0.142, -L1 * 0.45], [0.158, 0], [0.112, 0.112], [0, 0.158]], seg, i => (i >= 3 ? shoulder : sleeve)),
    (_x, y) => 1.05 - 0.2 * clamp01(-y / L1),
  )
  const fore = merge([
    limb(0.118, 0.098, L2 - 0.07, seg, (i: number) => (!sick && i <= 2 ? skin : sleeve), cap),
    ball(0.1, lo ? 5 : 7, lo ? 3 : 4, skin, 1, 1.1, 1).translate(0, -L2, 0),
  ])
  const thigh = limb(0.152, 0.126, THIGH, seg, trousers, cap)
  const shin = merge([
    limb(0.122, 0.105, SHIN - 0.12, seg, tone(trousers, 0.92), cap),
    ball(0.125, lo ? 5 : 7, lo ? 3 : 4, shoe, 1, 0.72, 1.55).translate(0, -SHIN + 0.085, 0.06),
  ])
  // Cloth and skin are relit (see doctor.ts relight): the sides then show the PAL colour and the backs / shoulders that
  // face the sky come out at the lighter variant, as in the ad (#5876b1 -> #7697d0 on the blue tunics).
  const RL = 0.8
  return {
    torso: relight(merge(torso), RL),
    head: merge([relight(merge(head), RL), relight(hair, 0.25)]),
    upper: relight(upper, RL),
    fore: relight(fore, RL),
    thigh: relight(thigh, sick ? RL : 0.35),
    shin: relight(shin, sick ? RL : 0.35),
  }
}

let capGeo: THREE.BufferGeometry | null = null
/** Flat cap (cart driver). Origin at the neck like the head geometry. */
function buildCap(): THREE.BufferGeometry {
  const c = PAL.cartWheel
  return merge([
    rev([[0.215, 0.3], [0.235, 0.33], [0.22, 0.4], [0.12, 0.44], [0, 0.445]], 10, i => (i === 0 ? tone(c, 0.7) : c)).translate(0, 0, -0.01),
    box(0.26, 0.03, 0.16, tone(c, 0.8)).rotateX(0.2).translate(0, 0.3, 0.24),
  ])
}

let glowMat: THREE.SpriteMaterial | null = null
let puffMat: THREE.SpriteMaterial | null = null
const MIASMA = mixHex(PAL.miasma, PAL.uiGreen, 0.4)
/** Flat mint the injected patient is flooded with. */
const TINT = mixHex(PAL.syringe, PAL.foam, 0.3)
let _speckTex: THREE.Texture | null = null
/** Small ragged blot with a fairly hard edge (white, alpha): the green specks that float over the crowd (crowd1.jpg). */
function speckTexture(): THREE.Texture {
  if (_speckTex) return _speckTex
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.fillStyle = 'rgba(255,255,255,0.5)'
  g.shadowColor = 'rgba(255,255,255,0.9)'
  g.shadowBlur = 5
  for (const [x, y, r] of [[32, 32, 15], [23, 27, 10], [41, 30, 9], [30, 42, 10], [40, 41, 8], [26, 37, 8]] as const) {
    g.beginPath()
    g.arc(x, y, r, 0, TAU)
    g.fill()
  }
  _speckTex = new THREE.CanvasTexture(c)
  _speckTex.colorSpace = THREE.SRGBColorSpace
  return _speckTex
}
// Fade-out: a depth-only twin of the body is drawn first (render order 4, after the ground decals and shadows), then
// the faded body (render order 5), so only its front-most surface is blended. Both are `transparent`, which makes the
// stage draw them in its un-outlined pass after everything opaque.
const ORDER_PRE = 4
const ORDER_FADE = 5
let _depthOnly: THREE.Material | null = null
const depthOnlyMat = () => (_depthOnly ??= new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true }))

// pose-target slots
const hipY = 0
const offX = 1
const offZ = 2
const bend = 3
const hdX = 4
const hdY = 5
const thL = 6
const knL = 7
const thR = 8
const knR = 9
const LX = 10
const LY = 11
const LZ = 12
const RX = 13
const RY = 14
const RZ = 15
const PLX = 16
const PLY = 17
const PLZ = 18
const PRX = 19
const PRY = 20
const PRZ = 21
const GRIP = 22
const WALK = 23
const PITCH = 24
const NSLOT = 25

const Q_ID = new THREE.Quaternion()
const Q_LIE = new THREE.Quaternion().setFromEuler(new THREE.Euler(90 * DEG, 0, -90 * DEG, 'ZXY'))
const Q_SIT = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI + 0.75, 0))
const _qx = new THREE.Quaternion()
const _ax = new THREE.Vector3(1, 0, 0)
const _v = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _col = new THREE.Color()

interface Rig extends VillagerModel {
  body: THREE.Group
  chest: THREE.Group
  head: THREE.Group
  /** Hand target of the sick attitude in chest space (x, y, z): the crowd bake tucks the hands under the face. */
  sickHands: THREE.Vector3
}

function makeRig(opts: { cap?: boolean; lo?: boolean } = {}): Rig {
  const shared = charMat()
  // own materials, created on first use: opaque and flooded with mint green (injection tint, keeps the outline) and
  // transparent for the fade-out (the stage draws transparent things un-outlined)
  let tintMat: THREE.MeshLambertMaterial | null = null
  let fadeMat: THREE.MeshLambertMaterial | null = null
  let current: THREE.Material = shared
  const meshes: THREE.Mesh[] = []
  // depth-only twins of the body meshes, created on the first fade (see ORDER_PRE): no arms showing through the chest
  let pre: THREE.Mesh[] | null = null
  const add = (parent: THREE.Object3D) => {
    const m = new THREE.Mesh(undefined, shared)
    parent.add(m)
    meshes.push(m)
    return m
  }

  const root = new THREE.Group()
  root.name = 'villager'
  const shadow = blobShadow(1.5, 1.25, 0.45)
  const shadowMat = shadow.material as THREE.MeshBasicMaterial
  root.add(shadow)

  const body = new THREE.Group()
  root.add(body)
  const legL = new THREE.Group()
  const legR = new THREE.Group()
  legL.position.set(LEG_X, 0, 0)
  legR.position.set(-LEG_X, 0, 0)
  const kneeL = new THREE.Group()
  const kneeR = new THREE.Group()
  kneeL.position.y = kneeR.position.y = -THIGH
  legL.add(kneeL)
  legR.add(kneeR)
  body.add(legL, legR)
  const mThL = add(legL)
  const mThR = add(legR)
  const mShL = add(kneeL)
  const mShR = add(kneeR)

  const chest = new THREE.Group()
  body.add(chest)
  const mTorso = add(chest)
  const head = new THREE.Group()
  head.position.set(0, NECK_Y, 0.02)
  chest.add(head)
  const mHead = add(head)
  if (opts.cap) {
    const cap = add(head)
    cap.geometry = capGeo ??= buildCap()
  }
  const upL = add(chest)
  const foL = add(chest)
  const upR = add(chest)
  const foR = add(chest)

  // red wound glow on the lower back (bathed look), SPEC 9 row 22
  glowMat ??= new THREE.SpriteMaterial({ map: glowTexture(), color: PAL.woundGlow, depthWrite: false, transparent: true, opacity: 0.9 })
  const glow = new THREE.Sprite(glowMat)
  glow.position.set(0, 0.22, -0.4)
  glow.visible = false
  chest.add(glow)

  // miasma puffs drifting round a sick villager, SPEC 9 row 11
  puffMat ??= new THREE.SpriteMaterial({ map: puffTexture(), color: MIASMA, depthWrite: false, transparent: true, opacity: 0.8 })
  const puffs: THREE.Sprite[] = []
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Sprite(puffMat)
    s.visible = false
    root.add(s)
    puffs.push(s)
  }

  const headAnchor = new THREE.Group()
  root.add(headAnchor)

  const T = new Float32Array(NSLOT)
  const C = new Float32Array(NSLOT)
  const qT = new THREE.Quaternion()
  const qBase = new THREE.Quaternion() // smoothed whole-body orientation (upright / lying / sitting)
  let look: VillagerLook | null = null
  let first = true

  const setLook = (l: VillagerLook) => {
    look = l
    const key = l + (opts.lo ? ':lo' : '')
    let g = geoCache.get(key)
    if (!g) geoCache.set(key, (g = buildGeo(l, !!opts.lo)))
    mTorso.geometry = g.torso
    mHead.geometry = g.head
    upL.geometry = upR.geometry = g.upper
    foL.geometry = foR.geometry = g.fore
    mThL.geometry = mThR.geometry = g.thigh
    mShL.geometry = mShR.geometry = g.shin
  }

  const model: Rig = {
    root,
    body,
    chest,
    head,
    headAnchor,
    sickHands: new THREE.Vector3(0.15, 0.94, 0.23),
    grip: new THREE.Vector3(0.3, 1.0, 0.62),
    gripRight: null,
    seatHeight: 0.95,
    update(p) {
      if (p.look !== look) setLook(p.look)
      const alpha = p.alpha ?? 1
      root.visible = alpha > 0.02
      if (!root.visible) return
      const tint = clamp01(p.tint ?? 0)
      let want: THREE.Material = shared
      const fading = alpha < 0.999
      if (fading) {
        if (!fadeMat) {
          fadeMat = shared.clone()
          fadeMat.transparent = true
        }
        fadeMat.opacity = alpha
        want = fadeMat
        if (!pre) {
          pre = meshes.map(m => {
            const d = new THREE.Mesh(m.geometry, depthOnlyMat())
            d.renderOrder = ORDER_PRE
            m.add(d)
            return d
          })
        }
      } else if (tint > 0.001) {
        // the whole patient turns flat bright mint with only a hint of shading left (seq_inject.jpg 22.1-22.7 s)
        tintMat ??= shared.clone()
        tintMat.color.setScalar(1 - 0.72 * tint)
        tintMat.emissive.setHex(TINT).multiplyScalar(tint * 0.8)
        want = tintMat
      }
      if (pre) for (let i = 0; i < pre.length; i++) {
        pre[i]!.visible = fading
        pre[i]!.geometry = meshes[i]!.geometry
      }
      if (want !== current) {
        current = want
        for (const m of meshes) {
          m.material = want
          m.renderOrder = fading ? ORDER_FADE : 0
        }
      }
      shadowMat.opacity = 0.45 * alpha

      const seed = p.seed ?? 0
      const sick = p.look === 'sick'
      const healed = p.look === 'healed'
      const t = p.t + seed * 37

      // ---------------- targets ----------------
      // attitude that goes with the look
      T[hipY] = HIP
      T[offX] = T[offZ] = 0
      T[hdY] = 0
      T[GRIP] = 0
      T[WALK] = 0
      T[PITCH] = 0
      T[thL] = T[thR] = 0
      T[knL] = T[knR] = 0
      qT.copy(Q_ID)
      if (sick) {
        T[bend] = 35 * DEG
        T[hdX] = 16 * DEG
        T[thL] = T[thR] = 10 * DEG
        T[knL] = T[knR] = 18 * DEG
        T[hipY] = HIP - 0.015
        // hands on the temples, elbows forward: from behind only the hair, the collar and the blue back show (crowd1.jpg)
        hands(T, model.sickHands.x, model.sickHands.y, model.sickHands.z, 0.35, -0.6, 1)
      } else if (!healed) {
        T[bend] = 26 * DEG
        T[hdX] = 12 * DEG
        T[thL] = T[thR] = 6 * DEG
        T[knL] = T[knR] = 12 * DEG
        hands(T, 0.1, 0.2, 0.36, 1, -0.5, -0.25)
        T[RX] = -0.04
        T[RY] = 0.3
      } else {
        T[bend] = 2 * DEG
        T[hdX] = 0
        hands(T, 0.52, -0.02, 0.06, 0.4, -0.3, -1)
      }
      const u = clamp01(p.phase)
      switch (p.pose) {
        case 'walk':
          T[WALK] = 1
          if (healed) T[bend] = 11 * DEG
          break
        case 'hop': {
          const tuck = Math.sin(Math.PI * u)
          T[thL] = T[thR] = lerp(15, 80, tuck) * DEG
          T[knL] = T[knR] = lerp(25, 105, tuck) * DEG
          T[bend] += 14 * DEG * tuck
          if (healed) hands(T, 0.5, 0.75, 0.15, 1, -0.3, -0.3)
          break
        }
        case 'bathe':
          if (sick) T[bend] = 16 * DEG
          else {
            T[bend] = -7 * DEG
            T[hdX] = -10 * DEG
            hands(T, 0.68, 0.52, -0.06, 0.1, -1, -0.5)
          }
          T[thL] = T[thR] = T[knL] = T[knR] = 0
          break
        case 'lie':
          qT.copy(Q_LIE)
          T[hipY] = 0.36
          T[offZ] = -0.05
          T[offX] = 0.05
          T[bend] = 30 * DEG
          T[hdX] = 16 * DEG
          T[thL] = 62 * DEG
          T[thR] = 74 * DEG
          T[knL] = 80 * DEG
          T[knR] = 95 * DEG
          // left arm (underneath) folded under the head, right hand on the stomach
          T[LX] = 0.2
          T[LY] = 0.92
          T[LZ] = 0.3
          T[PLX] = 0.2
          T[PLY] = -0.2
          T[PLZ] = 1
          T[RX] = -0.16
          T[RY] = 0.22
          T[RZ] = 0.4
          T[PRX] = -1
          T[PRY] = 0.2
          T[PRZ] = 0.2
          break
        case 'sit':
          qT.copy(Q_SIT)
          T[hipY] = 0.17
          T[offZ] = 0.05
          T[bend] = -4 * DEG
          T[hdX] = -14 * DEG
          T[thL] = 84 * DEG
          T[thR] = 66 * DEG
          T[knL] = 14 * DEG
          T[knR] = 60 * DEG
          // right fist up, left hand propped on the mattress
          T[RX] = -0.42
          T[RY] = 1.2
          T[RZ] = 0.06
          T[PRX] = -1
          T[PRY] = 0
          T[PRZ] = 0.3
          T[LX] = 0.5
          T[LY] = -0.06
          T[LZ] = -0.12
          T[PLX] = 1
          T[PLY] = 0
          T[PLZ] = -1
          break
        case 'push':
          T[WALK] = 0.8
          T[PITCH] = 14 * DEG
          T[bend] = 16 * DEG
          T[hdX] = -12 * DEG
          T[GRIP] = 1
          T[PLX] = 1
          T[PLY] = -0.6
          T[PLZ] = -0.2
          T[PRX] = -1
          T[PRY] = -0.6
          T[PRZ] = -0.2
          break
        case 'drive':
          T[hipY] = model.seatHeight + 0.15
          T[bend] = 5 * DEG
          T[hdX] = 0
          T[thL] = T[thR] = 78 * DEG
          T[knL] = T[knR] = 72 * DEG
          T[GRIP] = 1
          T[PLX] = 1
          T[PLY] = -0.7
          T[PLZ] = -0.2
          T[PRX] = -1
          T[PRY] = -0.7
          T[PRZ] = -0.2
          break
      }

      // ---------------- smoothing ----------------
      const dt = p.dt ?? 0
      if (first || !(dt > 0)) {
        C.set(T)
        qBase.copy(qT)
        first = false
      } else {
        const k = damp(15, dt)
        for (let i = 0; i < NSLOT; i++) C[i] += (T[i]! - C[i]!) * k
        qBase.slerp(qT, k)
      }

      // ---------------- apply ----------------
      const stride = sick ? 1.15 : healed ? 2.0 : 1.3
      const ph = (p.phase / stride + seed) * TAU // seed: villagers walking side by side do not step in unison
      const w = C[WALK]!
      const sn = Math.sin(ph) * w
      const cs = Math.cos(ph)
      const amp = sick ? 0.42 : healed ? 0.85 : 0.5
      const knee = sick ? 0.5 : healed ? 1.15 : 0.6
      const breathe = Math.sin(t * 1.8)
      const shiver = sick ? Math.sin(t * 2.4) : 0
      const bob = (Math.abs(cs) - 0.6) * (healed ? 0.05 : 0.03) * w

      body.position.set(C[offX]!, C[hipY]! + bob, C[offZ]!)
      body.quaternion.copy(qBase)
      if (C[PITCH]! > 1e-4) body.quaternion.multiply(_qx.setFromAxisAngle(_ax, C[PITCH]!)) // whole-body lean (push)
      legL.rotation.x = -(C[thL]! + amp * sn)
      legR.rotation.x = -(C[thR]! - amp * sn)
      kneeL.rotation.x = C[knL]! + knee * Math.max(0, cs) * w
      kneeR.rotation.x = C[knR]! + knee * Math.max(0, -cs) * w
      chest.rotation.set(C[bend]! + breathe * 0.012 + Math.abs(sn) * 0.03, -sn * (healed ? 0.16 : 0.1), sn * (sick ? 0.07 : 0.04) + shiver * 0.02)
      head.rotation.set(C[hdX]! + shiver * 0.03, C[hdY]! + (sick ? Math.sin(t * 1.3) * 0.12 : 0), sick ? Math.sin(t * 1.9) * 0.05 : 0)

      // arms
      let lx = C[LX]!
      let ly = C[LY]!
      let lz = C[LZ]!
      let rx = C[RX]!
      let ry = C[RY]!
      let rz = C[RZ]!
      if (healed && w > 0.01 && C[GRIP]! < 0.5) {
        // running: pump the arms against the legs, elbows bent
        const a = w * (1 - C[GRIP]!)
        lx = lerp(lx, 0.44, a)
        rx = lerp(rx, -0.44, a)
        ly = lerp(ly, 0.2 + sn * -0.08, a)
        ry = lerp(ry, 0.2 + sn * 0.08, a)
        lz = lerp(lz, 0.22 - sn * 0.3, a)
        rz = lerp(rz, 0.22 + sn * 0.3, a)
      }
      if (p.pose === 'sit') ry += Math.sin(t * 11) * 0.05 // fist pump
      const gw = C[GRIP]!
      if (gw > 0.001) {
        const g = model.grip
        const gr = model.gripRight ?? g
        body.updateMatrix()
        chest.updateMatrix()
        _m.multiplyMatrices(body.matrix, chest.matrix).invert()
        _v.set(g.x, g.y, g.z).applyMatrix4(_m)
        lx = lerp(lx, _v.x, gw)
        ly = lerp(ly, _v.y, gw)
        lz = lerp(lz, _v.z, gw)
        _v.set(-gr.x, gr.y, gr.z).applyMatrix4(_m)
        rx = lerp(rx, _v.x, gw)
        ry = lerp(ry, _v.y, gw)
        rz = lerp(rz, _v.z, gw)
      }
      solveArm(upL, foL, SHOULDER_X, SHOULDER_Y, 0, lx, ly, lz, L1, L2, C[PLX]!, C[PLY]!, C[PLZ]!)
      solveArm(upR, foR, -SHOULDER_X, SHOULDER_Y, 0, rx, ry, rz, L1, L2, C[PRX]!, C[PRY]!, C[PRZ]!)

      // ---------------- extras ----------------
      const lying = p.pose === 'lie' || p.pose === 'sit'
      headAnchor.position.set(0, lying ? 1.5 : p.pose === 'drive' ? model.seatHeight + 1.75 : sick ? 2.15 : 2.35, lying ? 0.4 : sick ? 0.5 : 0.1)
      shadow.visible = !lying && p.pose !== 'bathe'
      const height = p.height ?? 0
      shadow.position.y = 0.015 - height
      shadow.scale.setScalar(1 - 0.4 * clamp01(height / 2.5))
      const bathed = p.look === 'bathed'
      const glowK = p.glow ?? 1
      glow.visible = bathed && alpha > 0.5 && glowK > 0.01
      if (bathed) glow.scale.setScalar((0.52 + 0.2 * Math.sin(t * TAU * 1.0)) * glowK)
      const puffOn = sick && alpha > 0.5
      for (let i = 0; i < 3; i++) {
        const s = puffs[i]!
        s.visible = puffOn
        if (!puffOn) continue
        // a low cloud trailing behind him (vil1.jpg, sick1.jpg): each puff swells, drifts back and up, and fades
        const pu = (t * 0.55 + i / 3) % 1
        const a = i * 2.1 + seed * 6
        const sc = (0.85 + 0.25 * i) * Math.sin(Math.PI * Math.sqrt(pu)) + 0.05
        s.position.set(Math.sin(a) * 0.32 + Math.sin(t * 1.3 + a) * 0.08, 0.4 + 0.75 * pu, -0.5 - 0.65 * pu - 0.1 * i)
        s.scale.set(sc * 1.25, sc, 1)
      }
    },
  }
  model.update({ look: 'sick', pose: 'stand', phase: 0, t: 0 })
  return model
}

/** Fill both hand targets symmetrically: target (±x, y, z), elbow hint (±px, py, pz), in chest space. */
function hands(T: Float32Array, x: number, y: number, z: number, px: number, py: number, pz: number) {
  T[LX] = x
  T[LY] = y
  T[LZ] = z
  T[RX] = -x
  T[RY] = y
  T[RZ] = z
  T[PLX] = px
  T[PLY] = py
  T[PLZ] = pz
  T[PRX] = -px
  T[PRY] = py
  T[PRZ] = pz
}

/** A single villager. `cap: true` adds the flat cap of the cart driver (see staff.ts makeDriver). */
export function makeVillager(opts: { cap?: boolean } = {}): VillagerModel {
  return makeRig(opts)
}

// ---------------------------------------------------------------------------------------------------
// Crowd
// ---------------------------------------------------------------------------------------------------
export interface CrowdModel {
  /** Slots are world coordinates, so leave this at the origin. 4 draw calls in total. */
  root: THREE.Group
  /** Show only the last n slots (= Crowd.remaining: the far ones leave first, SPEC 2.7). */
  setRemaining(n: number): void
  /**
   * Presence 0..1 of the figure on one slot (index into `slots`; default 1). 0 hides it: the binder draws the villager
   * who steps out through the gate from there. On the way back to 1 the next one presses forward into the gap from
   * behind, growing to full size. Applied by the next update().
   */
  setPresence(slot: number, k: number): void
  /** Idle bob / sway and miasma drift; call every frame. Pass the camera so the puffs face it (default: the fixed game camera direction). */
  update(t: number, camera?: THREE.Camera): void
}

const PUFFS = 260

/**
 * The packed sick crowd: two baked pose variants as InstancedMeshes, a soft green ground glow and drifting
 * miasma puffs (f_0061, f_0146, crowd1.jpg). Everyone faces the cauldron at the origin.
 */
export function createCrowd(slots: readonly CrowdSlot[]): CrowdModel {
  const n = slots.length
  const root = new THREE.Group()
  root.name = 'crowd'

  // --- bake two hunched poses ---
  // (hands held low in front of the face: from behind and above only the hair, the collar and the blue back show, crowd1.jpg)
  const rig = makeRig({ lo: true })
  rig.sickHands.set(0.11, 0.85, 0.3)
  rig.update({ look: 'sick', pose: 'stand', phase: 0, t: 0.4 })
  const geoA = bakeFigure(rig.root)
  rig.update({ look: 'sick', pose: 'stand', phase: 0, t: 2.1, seed: 0.37 })
  rig.chest.rotation.x += 0.14
  rig.chest.rotation.z = 0.07
  rig.head.rotation.y = 0.5
  rig.head.rotation.x += 0.1
  const geoB = bakeFigure(rig.root)

  // instance k of a variant = its k-th slot counted from the END of the slot list, so `count` trims the far ones
  const mat = charMat()
  const variants = [geoA, geoB].map((geo, v) => {
    const ids: number[] = []
    for (let i = n - 1; i >= 0; i--) if ((slots[i]!.seed * 7.31) % 1 < 0.6 === (v === 0)) ids.push(i)
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, ids.length))
    mesh.frustumCulled = false
    mesh.count = ids.length
    // countAt[r] = instances of this variant among the last r slots
    const countAt = new Uint16Array(n + 1)
    let c = 0
    let k = 0
    for (let r = 1; r <= n; r++) {
      while (k < ids.length && ids[k]! >= n - r) {
        k++
        c++
      }
      countAt[r] = c
    }
    for (let j = 0; j < ids.length; j++) {
      const s = slots[ids[j]!]!
      const b = 0.9 + 0.14 * ((s.seed * 13.7) % 1)
      mesh.setColorAt(j, _col.setRGB(b, b, b * (0.96 + 0.08 * ((s.seed * 29.3) % 1))))
    }
    root.add(mesh)
    return { mesh, ids, countAt }
  })

  // --- green glow on the ground between them ---
  const glowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
  const glow = new THREE.InstancedMesh(glowGeo, new THREE.MeshBasicMaterial({ color: mixHex(PAL.miasma, PAL.uiGreen, 0.35), map: glowTexture(), transparent: true, opacity: 0.95, depthWrite: false }), Math.max(1, n))
  glow.frustumCulled = false
  glow.renderOrder = 1
  const m4 = new THREE.Matrix4()
  for (let j = 0; j < n; j++) {
    const s = slots[n - 1 - j]!
    const sc = 2.1 + 0.5 * s.seed
    m4.makeScale(sc, 1, sc).setPosition(s.x, 0.04 + 0.0002 * (j % 16), s.z)
    glow.setMatrixAt(j, m4)
  }
  root.add(glow)

  // --- drifting puffs ---
  const puffs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: PAL.miasma, map: speckTexture(), transparent: true, opacity: 0.9, depthWrite: false }), PUFFS)
  puffs.frustumCulled = false
  puffs.renderOrder = 3
  root.add(puffs)

  let remaining = n
  const presence = new Float32Array(n).fill(1)
  const e = new Float32Array(16)
  const q = new THREE.Quaternion()
  const pos = new THREE.Vector3()
  const scl = new THREE.Vector3()
  const hash = (a: number, b: number) => {
    const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
    return x - Math.floor(x)
  }

  const model: CrowdModel = {
    root,
    setRemaining(r) {
      remaining = Math.max(0, Math.min(n, Math.round(r)))
      for (const v of variants) v.mesh.count = v.countAt[remaining]!
      glow.count = remaining
    },
    setPresence(slot, k) {
      if (slot >= 0 && slot < n) presence[slot] = clamp01(k)
    },
    update(t, camera) {
      for (const v of variants) {
        const cnt = v.mesh.count
        const arr = v.mesh.instanceMatrix.array as Float32Array
        for (let j = 0; j < cnt; j++) {
          const s = slots[v.ids[j]!]!
          const sd = s.seed * 50
          // face the cauldron (origin) with a little personal offset and a slow sway
          const h = Math.atan2(-s.x, -s.z) + (s.seed - 0.5) * 0.5 + 0.07 * Math.sin(t * 0.8 + sd)
          const pitch = 0.05 * Math.sin(t * 1.3 + sd * 1.7)
          const roll = 0.045 * Math.sin(t * 1.05 + sd * 2.3)
          const pr = presence[v.ids[j]!]!
          const sc = (0.87 + 0.09 * ((s.seed * 3.7) % 1)) * pr // a little smaller than a walker: the green ground must show between them
          const back = 0.6 * (1 - pr)
          const ch = Math.cos(h)
          const sh = Math.sin(h)
          const cp = Math.cos(pitch)
          const sp = Math.sin(pitch)
          const cr = Math.cos(roll)
          const sr = Math.sin(roll)
          // R = Ry(h) * Rx(pitch) * Rz(roll), column-major
          e[0] = (ch * cr + sh * sp * sr) * sc
          e[1] = cp * sr * sc
          e[2] = (-sh * cr + ch * sp * sr) * sc
          e[3] = 0
          e[4] = (-ch * sr + sh * sp * cr) * sc
          e[5] = cp * cr * sc
          e[6] = (sh * sr + ch * sp * cr) * sc
          e[7] = 0
          e[8] = sh * cp * sc
          e[9] = -sp * sc
          e[10] = ch * cp * sc
          e[11] = 0
          e[12] = s.x - sh * back
          e[13] = 0.025 * Math.sin(t * 2.1 + sd * 3.1) - 0.02
          e[14] = s.z - ch * back
          e[15] = 1
          arr.set(e, j * 16)
        }
        v.mesh.instanceMatrix.needsUpdate = true
      }
      // puffs: each one keeps re-spawning over a random remaining villager and rises
      const active = remaining === 0 ? 0 : Math.min(PUFFS, Math.ceil(remaining * 1.4) + 4)
      puffs.count = active
      if (camera) q.copy(camera.quaternion)
      else q.copy(GAME_CAM_QUAT)
      for (let i = 0; i < active; i++) {
        const period = 2.6 + 2.2 * hash(i, 1)
        const c = t / period + hash(i, 2)
        const cyc = Math.floor(c)
        const u = c - cyc
        const s = slots[n - 1 - Math.floor(hash(i, cyc + 3) * remaining)]!
        const size = (0.22 + 0.34 * hash(i, cyc + 5)) * Math.pow(Math.sin(Math.PI * u), 0.5)
        pos.set(s.x + (hash(i, cyc + 7) - 0.5) * 1.0 + Math.sin(t * 0.7 + i) * 0.12, 1.0 + 1.1 * u + 0.6 * hash(i, cyc + 9), s.z + (hash(i, cyc + 11) - 0.5) * 1.0)
        scl.set(size * (0.8 + 0.5 * hash(i, cyc + 13)), size, 1)
        m4.compose(pos, q, scl)
        puffs.setMatrixAt(i, m4)
      }
      puffs.instanceMatrix.needsUpdate = true
    },
  }
  for (const v of variants) if (v.mesh.instanceColor) v.mesh.instanceColor.needsUpdate = true
  model.update(0)
  return model
}

// ---------------------------------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------------------------------
const pose = (name: string, look: VillagerLook, poseName: VillagerPoseName, phase: (t: number) => number, extra?: (t: number) => Partial<VillagerPose>) =>
  galleryItem(name, 1.2, makeVillager, (h, t, dt) => h.update({ look, pose: poseName, phase: phase(t), t, dt, seed: 0.3, ...extra?.(t) }))

/** Villager on a gallery-only stand-in for a bed so the lying / sitting poses can be judged (the real bed is furniture.ts). */
function onBed(name: string, look: VillagerLook, poseName: VillagerPoseName, extra?: (t: number) => Partial<VillagerPose>): GalleryItem {
  return galleryItem(
    name,
    1.6,
    () => {
      const h = makeVillager()
      const g = new THREE.Group()
      // oriented as every bed of the game: head toward +x, so the villager root gets rotation.y = PI/2
      const bed = new THREE.Mesh(new THREE.BoxGeometry(P.BED_W, 0.55, P.BED_D), lam(PAL.blanket))
      bed.position.y = 0.275
      const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 1.2), lam(PAL.pillow))
      pillow.position.set(1.05, 0.6, 0)
      h.root.position.y = 0.55
      h.root.rotation.y = Math.PI / 2
      g.add(bed, pillow, h.root)
      return { root: g, inner: h }
    },
    (w, t, dt) => w.inner.update({ look, pose: poseName, phase: 0, t, dt, seed: 0.3, ...extra?.(t) }),
  )
}

export const GALLERY: GalleryItem[] = [
  pose('villager sick stand', 'sick', 'stand', () => 0),
  pose('villager sick walk', 'sick', 'walk', t => t * P.SICK_WALK_SPEED),
  pose('villager sick hop', 'sick', 'hop', t => (t * 1.5) % 1),
  pose('villager sick bathe', 'sick', 'bathe', () => 0),
  pose('villager bathed bathe', 'bathed', 'bathe', () => 0),
  pose('villager bathed stand', 'bathed', 'stand', () => 0),
  pose('villager bathed walk', 'bathed', 'walk', t => t * P.BATHED_WALK_SPEED),
  onBed('villager bathed lie', 'bathed', 'lie'),
  onBed('villager injected (tint)', 'bathed', 'lie', t => ({ tint: 0.5 + 0.5 * Math.sin(t * 4) })),
  onBed('villager healed sit cheer', 'healed', 'sit'),
  pose('villager healed stand', 'healed', 'stand', () => 0),
  pose('villager healed run', 'healed', 'walk', t => t * P.HEALED_RUN_SPEED),
  pose('villager healed push', 'healed', 'push', t => t * 5.5),
  pose('villager healed hop', 'healed', 'hop', t => (t * 1.5) % 1),
  pose('villager fade out', 'healed', 'walk', t => t * P.HEALED_RUN_SPEED, t => ({ alpha: 0.5 + 0.5 * Math.cos(t * 2) })),
  // spin at 1 rad/s: &t=<heading in radians> shows them from any side (t = 1.57: walking east as in vil1.jpg)
  galleryItem('villager turntable sick', 1.2, makeVillager, (h, t, dt) => {
    h.root.rotation.y = t
    h.update({ look: 'sick', pose: 'walk', phase: 0.3, t, dt, seed: 0.3 })
  }),
  galleryItem('villager turntable bathed', 1.2, makeVillager, (h, t, dt) => {
    h.root.rotation.y = t
    h.update({ look: 'bathed', pose: 'walk', phase: 0.3, t, dt, seed: 0.3 })
  }),
  galleryItem('villager turntable healed', 1.2, makeVillager, (h, t, dt) => {
    h.root.rotation.y = t
    h.update({ look: 'healed', pose: 'walk', phase: 0.5, t, dt, seed: 0.3 })
  }),
  galleryItem('villager life cycle', 1.2, makeVillager, (h, t, dt) => {
      // sick walk -> hop -> bathe (cure) -> hop -> bathed walk -> healed run, to check the blends
      const u = t % 9
      if (u < 2) h.update({ look: 'sick', pose: 'walk', phase: t * 5.5, t, dt })
      else if (u < 2.4) h.update({ look: 'sick', pose: 'hop', phase: (u - 2) / 0.4, t, dt })
      else if (u < 3.6) h.update({ look: u < 3.2 ? 'sick' : 'bathed', pose: 'bathe', phase: 0, t, dt })
      else if (u < 4) h.update({ look: 'bathed', pose: 'hop', phase: (u - 3.6) / 0.4, t, dt })
      else if (u < 6) h.update({ look: 'bathed', pose: 'walk', phase: t * 4.5, t, dt })
      else if (u < 7) h.update({ look: 'healed', pose: 'stand', phase: 0, t, dt })
      else h.update({ look: 'healed', pose: 'walk', phase: t * 8, t, dt })
  }),
  crowdGalleryItem(CROWD_SLOTS, 'crowd with miasma', () => CROWD_SLOTS.length),
  crowdGalleryItem(CROWD_SLOTS, 'crowd draining', t => CROWD_SLOTS.length * (0.5 + 0.5 * Math.cos(t * 0.5))),
]

/** The whole crowd, re-centred for the gallery (in the game its root stays at the origin). */
function crowdGalleryItem(slots: readonly CrowdSlot[], name: string, remaining: (t: number) => number): GalleryItem {
  let cx = 0
  let cz = 0
  for (const s of slots) {
    cx += s.x / slots.length
    cz += s.z / slots.length
  }
  let size = 1
  for (const s of slots) size = Math.max(size, Math.hypot(s.x - cx, s.z - cz) + 1)
  return galleryItem(
    name,
    size,
    () => {
      const c = createCrowd(slots)
      const g = new THREE.Group()
      c.root.position.set(-cx, 0, -cz)
      g.add(c.root)
      return { root: g, inner: c }
    },
    (w, t) => {
      w.inner.setRemaining(remaining(t))
      w.inner.update(t)
    },
  )
}
