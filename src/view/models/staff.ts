// Staff: nurse with the giant green syringe, usher at the pen gate, porter (flask carrier) and the cart driver
// (SPEC 2.10, 2.12, 7.4; art.md 2.12, 2.13). The three women share one body rig with different clothes.
import * as THREE from 'three'
import { L, P, PAL } from '../../config'
import { angleDelta, clamp, clamp01, damp, lerp, smoothstep } from '../../core/math'
import { blobShadow, unlit, type GalleryItem } from '../materials'
import { ball, ballProfile, box, charMat, DEG, galleryItem, HemSpring, merge, mixHex, paint, relight, rev, shade, Skirt, solveArm, TAU, tone } from './doctor'
import { makeVillager, type VillagerModel } from './villager'

// ---------------------------------------------------------------------------------------------------
// Shared female body (1.7 m): bell skirt to the floor, small torso, short puffed sleeves, bare forearms
// ---------------------------------------------------------------------------------------------------
const WAIST = 0.82
const SH_X = 0.2
const SH_Y = 0.35
const L1 = 0.26
const L2 = 0.27
const STRIDE = 1.1

interface MaidLook {
  key: string
  hair: number
  blouse: number
  apron: number
  skirt: number
  band: number
  headwear: 'nurseCap' | 'frill' | 'kerchief'
  /** Radius of the puffed sleeve. */
  puff: number
  /** Lowest point of the bob (head space; chin = 0.01). */
  bob: number
  /** Hair volume (1 = close to the skull). */
  hairSize: number
  /** Half-width of the skirt apron in skirt segments (1 = 67 deg, 2 = 112 deg). */
  apronSegs: number
}

interface MaidGeo {
  torso: THREE.BufferGeometry
  head: THREE.BufferGeometry
  upper: THREE.BufferGeometry
  fore: THREE.BufferGeometry
}
const maidGeo = new Map<string, MaidGeo>()

function buildMaidGeo(k: MaidLook): MaidGeo {
  const skin = PAL.skin
  // --- torso (origin at the waist) ---
  const torso = merge([
    shade(
      rev([[0, -0.04], [0.15, -0.04], [0.17, 0], [0.17, 0.05], [0.185, 0.14], [0.205, 0.23], [0.2, 0.3], [0.16, 0.36], [0.08, 0.41], [0.065, 0.47], [0, 0.47]], 12, (i, j) => {
        if (i <= 2) return k.band
        if (i >= 8) return skin
        if (i === 7) return tone(k.blouse, 1.08)
        if ((j === 0 || j === 11) && i <= 5) return k.apron
        return k.blouse
      }, 1, 0.8),
      (_x, y) => 0.88 + 0.2 * clamp01(y / 0.4),
    ),
    // apron bow at the back and the two straps that run up to the shoulders (the white strip on her back, nurse1.jpg)
    box(0.17, 0.08, 0.05, k.apron).translate(0, 0.02, -0.15),
    box(0.04, 0.3, 0.02, k.apron).rotateZ(0.16).translate(-0.085, 0.2, -0.158),
    box(0.04, 0.3, 0.02, k.apron).rotateZ(-0.16).translate(0.085, 0.2, -0.158),
  ])
  // --- head (origin at the neck); the hair goes in its own list because it is relit less than skin and cloth ---
  const hairHi = tone(k.hair, 1.14)
  const hs = k.hairSize
  const head: THREE.BufferGeometry[] = []
  const face: THREE.BufferGeometry[] = [ball(0.16, 10, 7, skin, 1, 1.05, 1).translate(0, 0.17, 0)]
  if (k.headwear !== 'kerchief') {
    head.push(
      rev(ballProfile(0.178 * hs, 8), 8, (i, j) => (j === 0 ? tone(k.hair, 0.85) : i % 2 ? hairHi : k.hair), 1, 1, 22 * DEG, 215 * DEG)
        .rotateZ(90 * DEG)
        .scale(1.03, 1.05, 1.05)
        .translate(0, 0.17 + (hs - 1) * 0.1, -0.005 - (hs - 1) * 0.12),
    )
    // the bob hanging round the sides and the back
    head.push(rev([[0.19 * hs, k.bob], [0.21 * hs, k.bob + 0.07], [0.19 * hs, 0.2]], 8, (_i, j) => (j % 2 ? hairHi : k.hair), 1, 1.02, 62 * DEG, 298 * DEG).translate(0, 0, -0.005 - (hs - 1) * 0.1))
  } else {
    // headscarf over the hair, knot at the nape
    head.push(rev(ballProfile(0.182, 8), 8, (_i, j) => (j === 0 ? tone(k.apron, 0.8) : k.apron), 1, 1, 30 * DEG, 205 * DEG).rotateZ(90 * DEG).scale(1.03, 1.05, 1.05).translate(0, 0.17, -0.005))
    head.push(ball(0.06, 6, 4, tone(k.apron, 0.85)).translate(0, 0.1, -0.19))
    head.push(rev([[0.19, 0.07], [0.195, 0.2]], 6, k.hair, 1, 1, 100 * DEG, 260 * DEG))
  }
  if (k.headwear === 'nurseCap') {
    head.push(rev([[0.07, 0.335], [0.082, 0.35], [0.082, 0.35], [0.086, 0.4], [0.086, 0.4], [0.07, 0.414], [0, 0.417]], 8, i => (i === 0 ? PAL.nurseSkirt : k.apron)).translate(0, 0.012, 0.03))
    // small cross on the front of the cap
    head.push(box(0.018, 0.046, 0.02, PAL.alertRed).translate(0, 0.39, 0.114))
    head.push(box(0.046, 0.018, 0.02, PAL.alertRed).translate(0, 0.39, 0.114))
  } else if (k.headwear === 'frill') {
    // white frilled headband from ear to ear
    head.push(rev(ballProfile(0.2, 8).slice(1, 8), 2, k.apron, 1, 1, 70 * DEG, 104 * DEG).rotateZ(90 * DEG).scale(1, 1.08, 1).translate(0, 0.17, 0))
  }
  for (const sx of [-1, 1]) face.push(ball(0.021, 5, 3, PAL.hatBand).translate(sx * 0.058, 0.175, 0.146))
  face.push(box(0.04, 0.014, 0.02, mixHex(skin, PAL.nurseHair, 0.6)).translate(0, 0.1, 0.148))
  // --- arms ---
  const p = k.puff
  const upper = rev([[0, -L1 - 0.05], [0.036, -L1 - 0.036], [0.05, -L1], [0.056, -0.13], [0.056, -0.13], [p, -0.125], [p + 0.01, -0.03], [p * 0.82, 0.05], [0, 0.085]], 8, i => (i <= 2 ? skin : i === 4 ? tone(k.blouse, 0.85) : k.blouse))
  const fore = merge([
    rev([[0, -L2 + 0.02], [0.04, -L2 + 0.04], [0.05, 0], [0.03, 0.04], [0, 0.05]], 8, skin),
    ball(0.054, 6, 4, skin, 1, 1.15, 0.9).translate(0, -L2, 0),
  ])
  const RL = 0.7
  return { torso: relight(torso, RL), head: merge([relight(merge(face), RL), relight(merge(head), 0.3)]), upper: relight(upper, RL), fore: relight(fore, RL) }
}

const _v = new THREE.Vector3()
const _inv = new THREE.Matrix4()

interface Maid {
  root: THREE.Group
  /** Origin at the waist; leans and bobs. */
  body: THREE.Group
  head: THREE.Group
  /** 0..1 smoothed run amount and the step sine of the last base() call. */
  run: number
  sn: number
  /** Body motion shared by all three: run lean, bob, skirt swing. `lean` (rad) and `lunge` (m forward) are added on top. */
  base(t: number, dt: number, speed: number, odo: number, maxSpeed: number, lean: number, lunge: number): void
  /** Solve both arms toward targets given in body space (elbow hints px.. are for the LEFT arm, mirrored for the right). */
  arms(lx: number, ly: number, lz: number, rx: number, ry: number, rz: number, px: number, py: number, pz: number): void
  /** Convert a root-space point (in v) to body space, in place. Call after base(). */
  toBody(v: THREE.Vector3): THREE.Vector3
}

function makeMaid(k: MaidLook): Maid {
  let g = maidGeo.get(k.key)
  if (!g) maidGeo.set(k.key, (g = buildMaidGeo(k)))
  const mat = charMat()
  const root = new THREE.Group()
  const shadow = blobShadow(1.3, 1.1, 0.45)
  root.add(shadow)
  const skirt = new Skirt({
    height: WAIST,
    rTop: 0.165,
    rBottom: 0.4,
    bell: 0.62,
    segs: 16,
    levels: [0, 0.2, 0.4, 0.6, 0.78, 0.95, 1],
    folds: 8,
    foldDepth: 0.05,
    color: (i, j) => {
      const front = j <= k.apronSegs || j >= 16 - k.apronSegs
      if (front && i <= 2) return k.apron
      if (front && i === 3) return tone(k.apron, 0.86) // frilled lower edge
      if (i === 5) return tone(k.skirt, 1.35)
      return tone(k.skirt, (j % 2 ? 0.95 : 1.05) * (1.08 - i * 0.025))
    },
  })
  relight(skirt.mesh.geometry) // PAL colour on the vertical cloth, lighter where the bell faces the sky
  root.add(skirt.mesh)
  const body = new THREE.Group()
  body.rotation.order = 'YXZ'
  root.add(body)
  body.add(new THREE.Mesh(g.torso, mat))
  const head = new THREE.Group()
  head.position.set(0, 0.47, 0)
  head.rotation.order = 'YXZ'
  body.add(head)
  head.add(new THREE.Mesh(g.head, mat))
  const upL = new THREE.Mesh(g.upper, mat)
  const foL = new THREE.Mesh(g.fore, mat)
  const upR = new THREE.Mesh(g.upper, mat)
  const foR = new THREE.Mesh(g.fore, mat)
  body.add(upL, foL, upR, foR)
  const hem = new HemSpring()

  const m: Maid = {
    root,
    body,
    head,
    run: 0,
    sn: 0,
    base(t, dt, speed, odo, maxSpeed, lean, lunge) {
      const kk = dt > 0 ? damp(14, dt) : 1
      m.run += (clamp01(speed / maxSpeed) - m.run) * kk
      const run = m.run
      hem.step(root.position.x, root.position.z, root.rotation.y, dt, 0.22 * run)
      const phase = (odo / STRIDE) * TAU
      const sn = (m.sn = Math.sin(phase) * run)
      const bob = (0.5 - 0.5 * Math.cos(phase * 2)) * 0.03 * run
      const ln = 11 * DEG * run + lean
      const wz = Math.sin(ln) * WAIST * 0.4 + lunge
      const wy = WAIST + bob + Math.sin(t * 1.9) * 0.004
      body.position.set(sn * 0.012, wy, wz)
      body.rotation.set(ln, sn * 0.12, sn * 0.04)
      head.rotation.x = -ln * 0.6
      skirt.pose(body.position.x, wy, wz, hem.ox, 0, hem.oz + lunge * 0.35, hem.flare, hem.twist, 0)
      body.updateMatrix()
      const c = Math.cos(root.rotation.y)
      const s = Math.sin(root.rotation.y)
      shadow.position.x = 0.1 * c - 0.14 * s
      shadow.position.z = 0.1 * s + 0.14 * c + wz * 0.5
    },
    arms(lx, ly, lz, rx, ry, rz, px, py, pz) {
      solveArm(upL, foL, SH_X, SH_Y, 0, lx, ly, lz, L1, L2, px, py, pz)
      solveArm(upR, foR, -SH_X, SH_Y, 0, rx, ry, rz, L1, L2, -px, py, pz)
    },
    toBody(v) {
      return v.applyMatrix4(_inv.copy(body.matrix).invert())
    },
  }
  return m
}

// ---------------------------------------------------------------------------------------------------
// Nurse
// ---------------------------------------------------------------------------------------------------
const APRON = tone(PAL.shirt, 0.95)
// blouse: warm taupe (#6b5654 .. #835d5e in nurse1.jpg)
const NURSE: MaidLook = { key: 'nurse', hair: PAL.nurseHair, blouse: mixHex(PAL.nurseSkirt, PAL.skin, 0.36), apron: APRON, skirt: PAL.nurseSkirt, band: PAL.nurseSkirt, headwear: 'nurseCap', puff: 0.08, bob: 0.0, hairSize: 1.14, apronSegs: 1 }
/** Fill fraction of a freshly loaded syringe (the top of the barrel stays pale glass, nurse1.jpg). */
const SYRINGE_FULL = 0.86
const BARREL_Y = 0.37
const BARREL_LEN = 1.2

export interface NursePose {
  /** Animation clock in seconds (GameState.time). */
  t: number
  /** Frame delta: run blend and skirt swing. 0 or omitted = snap. */
  dt?: number
  /** Ground speed in m/s (P.NURSE_RUN_SPEED = full run, syringe carried tilted back). 0 = standing with the syringe upright beside her. */
  speed: number
  /** Metres travelled, for the step phase (no odometer: pass t * speed). */
  odo: number
  /**
   * Bed.treatT of her bed: seconds since the treatment began (SPEC 2.10 table). Negative, omitted or >= P.TREATMENT_TIME = idle.
   * The model plays the whole injection from it: raise, swing to horizontal at P.TREAT_JAB with a jab, the barrel
   * draining from 0.5 s to 1.2 s, back upright and green again at P.TREATMENT_TIME. She jabs straight ahead (+z):
   * turn her to face the patient.
   */
  treatT?: number
  /** Override the swing: 0 = syringe upright, 1 = horizontal. */
  swing?: number
  /** Override the liquid level, 0 = empty steel barrel .. 1 = full. */
  fill?: number
}

export interface NurseModel {
  /** Feet at the origin, facing +z; the binder writes position and rotation.y BEFORE calling update (the skirt swings from the root's motion). */
  root: THREE.Group
  /** Empty group at the needle tip (follows the swing): spawn the green splash here. */
  needleTip: THREE.Group
  update(p: NursePose): void
}

let syringeGeo: THREE.BufferGeometry | null = null
let liquidGeo: THREE.BufferGeometry | null = null

/** Radius of the green liquid column: the barrel is 0.25 m across (nurse1.jpg: as wide as two thirds of her head). */
const LIQUID_R = 0.124

/** Syringe frame: needle tip at the origin, plunger toward +y, 1.82 m long (barrel 1.2 x 0.25). */
function buildSyringe(): THREE.BufferGeometry {
  const steel = PAL.drillSteel
  const glass = mixHex(PAL.drillHi, PAL.flaskLight, 0.35)
  const top = BARREL_Y + BARREL_LEN
  return relight(merge([
    rev([[0, 0], [0.026, 0.3]], 5, tone(steel, 1.1)), // needle
    rev([[0.035, 0.29], [0.075, 0.31], [0.075, BARREL_Y], [0.075, BARREL_Y]], 8, steel), // hub
    rev([[0.13, BARREL_Y - 0.01], [0.137, BARREL_Y + 0.03], [0.13, BARREL_Y + 0.05]], 10, tone(steel, 1.15)), // lower barrel ring
    // pale empty barrel (the green liquid mesh sits just outside it and covers the filled part)
    rev([[0, BARREL_Y], [0.114, BARREL_Y], [0.114, BARREL_Y], [0.114, top], [0.114, top], [0, top]], 10, glass),
    paint(new THREE.CylinderGeometry(0.26, 0.26, 0.05, 12), PAL.discGap).translate(0, top + 0.01, 0), // finger flange
    rev([[0.08, top + 0.03], [0.08, top + 0.2], [0.08, top + 0.2], [0.125, top + 0.2], [0.125, top + 0.2], [0.125, top + 0.24], [0.125, top + 0.24], [0, top + 0.245]], 8, i => (i >= 2 ? steel : PAL.drillHi)), // plunger
  ]), 0.6)
}

/** Nurse with the giant green syringe (1.7 m; the syringe reaches from the floor to above her head when idle). */
export function makeNurse(): NurseModel {
  const m = makeMaid(NURSE)
  m.root.name = 'nurse'
  const syr = new THREE.Group()
  syr.rotation.order = 'YXZ'
  m.root.add(syr)
  syr.add(new THREE.Mesh((syringeGeo ??= buildSyringe()), charMat()))
  liquidGeo ??= new THREE.CylinderGeometry(LIQUID_R, LIQUID_R, 1, 10).translate(0, 0.5, 0)
  const liquid = new THREE.Mesh(liquidGeo, unlit(PAL.syringe))
  liquid.position.y = BARREL_Y + 0.01
  syr.add(liquid)
  const needleTip = new THREE.Group()
  syr.add(needleTip)

  const model: NurseModel = {
    root: m.root,
    needleTip,
    update(p) {
      const tt = p.treatT ?? -1
      const active = tt >= 0 && tt < P.TREATMENT_TIME
      const swing = clamp01(p.swing ?? (active ? smoothstep(P.TREAT_JAB - 0.1, P.TREAT_JAB, tt) * (1 - smoothstep(P.TREATMENT_TIME - 0.12, P.TREATMENT_TIME - 0.02, tt)) : 0))
      const raise = active ? smoothstep(0, 0.22, tt) * (1 - swing) : 0
      let thrust = 0
      if (active) {
        const q = tt - P.TREAT_JAB
        thrust = q < 0 ? 0 : q < 0.05 ? (q / 0.05) * 1.3 : q < 0.13 ? lerp(1.3, 1, (q - 0.05) / 0.08) : 1
      } else if (p.swing !== undefined) thrust = 1
      thrust *= swing
      const fill = clamp01(p.fill ?? (active ? SYRINGE_FULL * (1 - smoothstep(0.5, 1.2, tt)) : SYRINGE_FULL))

      m.base(p.t, p.dt ?? 0, p.speed, p.odo, P.NURSE_RUN_SPEED, 15 * DEG * swing, 0.12 * thrust)
      const run = m.run

      // syringe: upright at her right side -> horizontal at hip height, needle forward
      const bobY = Math.abs(m.sn) * 0.05
      // (idle: well out to her side, so the whole green bar shows beside the skirt from behind, nurse1.jpg)
      syr.position.set(lerp(-0.54 + 0.1 * run, -0.3, swing), lerp(0.07 + raise * 0.24 + bobY + run * 0.12, 1.0, swing), lerp(0.03 + run * 0.2, 1.36 + 0.2 * thrust, swing))
      syr.rotation.set(lerp(-0.42 * run - 0.05 * raise, -90 * DEG, swing), 0, lerp(-0.05 + m.sn * 0.05, 0, swing))
      syr.updateMatrix()
      liquid.visible = fill > 0.005
      liquid.scale.y = Math.max(0.005, (BARREL_LEN - 0.02) * fill)

      // right hand on the barrel (slides back to the flange for the jab), left hand joins for the jab
      _v.set(0.12, lerp(0.98, 1.44, swing), 0.03).applyMatrix4(syr.matrix)
      m.toBody(_v)
      const rx = _v.x
      const ry = _v.y
      const rz = _v.z
      _v.set(0.13, 1.0, 0).applyMatrix4(syr.matrix)
      m.toBody(_v)
      const lx = lerp(0.3, _v.x, swing)
      const ly = lerp(-0.12 + 0.05 * run, _v.y, swing)
      const lz = lerp(0.05 + m.sn * 0.18, _v.z, swing)
      m.arms(lx, ly, lz, rx, ry, rz, lerp(0.6, 0.9, swing), lerp(-0.3, -0.6, swing), lerp(-0.8, -0.1, swing))
      m.head.rotation.y = lerp(0, -0.25, swing)
    },
  }
  model.update({ t: 0, speed: 0, odo: 0 })
  return model
}

// ---------------------------------------------------------------------------------------------------
// Usher
// ---------------------------------------------------------------------------------------------------
const USHER: MaidLook = { key: 'usher', hair: PAL.usherHair, blouse: tone(PAL.usherBlouse, 0.86), apron: APRON, skirt: PAL.usherSkirt, band: tone(PAL.usherSkirt, 0.75), headwear: 'frill', puff: 0.1, bob: 0.07, hairSize: 1.06, apronSegs: 2 }

export interface UsherPose {
  /** Animation clock in seconds. */
  t: number
  /** Frame delta (blends). 0 or omitted = snap. */
  dt?: number
  /** Ground speed in m/s (P.USHER_RUN_SPEED = full run). */
  speed: number
  /** Metres travelled, for the step phase (no odometer: pass t * speed). */
  odo: number
  /** true / 1 = one arm stretched out horizontally, pointing (Usher.arrived). Default false. */
  point?: boolean | number
  /** World heading (core/math convention) to point along, e.g. headingOf(-usher.x, -usher.z) for the cauldron. Default: straight ahead. */
  pointDir?: number
}

export interface UsherModel {
  /** Feet at the origin, facing +z; the binder writes position and rotation.y BEFORE calling update (the skirt swings from the root's motion). */
  root: THREE.Group
  update(p: UsherPose): void
}

/** The maid-like attendant at the pen gate (1.7 m). */
export function makeUsher(): UsherModel {
  const m = makeMaid(USHER)
  m.root.name = 'usher'
  let pt = 0
  const model: UsherModel = {
    root: m.root,
    update(p) {
      const dt = p.dt ?? 0
      const want = typeof p.point === 'number' ? clamp01(p.point) : p.point ? 1 : 0
      pt += (want - pt) * (dt > 0 ? damp(14, dt) : 1)
      m.base(p.t, dt, p.speed, p.odo, P.USHER_RUN_SPEED, 0, 0)
      const run = m.run
      const rel = p.pointDir === undefined ? 0 : angleDelta(m.root.rotation.y, p.pointDir)
      const left = Math.sin(rel) >= 0
      const sw = m.sn * 0.2
      let lx = 0.3
      let ly = -0.12 + 0.05 * run
      let lz = 0.05 + sw
      let rx = -0.3
      let ry = ly
      let rz = 0.05 - sw
      // pointing arm: straight out from the shoulder, with a little beckoning wave
      const wave = Math.sin(p.t * 5) * 0.03
      const px = Math.sin(rel) * 0.5 + (left ? SH_X : -SH_X)
      const py = SH_Y + 0.03 + wave
      const pz = Math.cos(rel) * 0.5
      if (left) {
        lx = lerp(lx, px, pt)
        ly = lerp(ly, py, pt)
        lz = lerp(lz, pz, pt)
      } else {
        rx = lerp(rx, px, pt)
        ry = lerp(ry, py, pt)
        rz = lerp(rz, pz, pt)
      }
      m.arms(lx, ly, lz, rx, ry, rz, 0.6, -0.4, -0.7)
      m.head.rotation.y = clamp(rel, -1.1, 1.1) * 0.6 * pt
      m.body.rotation.y += clamp(rel, -0.8, 0.8) * 0.25 * pt
    },
  }
  model.update({ t: 0, speed: 0, odo: 0 })
  return model
}

// ---------------------------------------------------------------------------------------------------
// Porter [EXTENDED]
// ---------------------------------------------------------------------------------------------------
const PORTER: MaidLook = { key: 'porter', hair: PAL.hair, blouse: mixHex(PAL.lowland2, PAL.shirt, 0.45), apron: PAL.cream, skirt: mixHex(PAL.lowland, PAL.usherSkirt, 0.5), band: tone(PAL.lowland, 0.8), headwear: 'kerchief', puff: 0.09, bob: 0.07, hairSize: 1, apronSegs: 1 }

export interface PorterPose {
  /** Animation clock in seconds. */
  t: number
  /** Frame delta (blends). 0 or omitted = snap. */
  dt?: number
  /** Ground speed in m/s (P.PORTER_SPEED = full run). */
  speed: number
  /** Metres travelled, for the step phase (no odometer: pass t * speed). */
  odo: number
  /** Porter.flasks: carried flask units. Above 0 she grips the pack straps and leans into the load. Default 0. */
  load?: number
}

export interface PorterModel {
  /** Feet at the origin, facing +z; the binder writes position and rotation.y BEFORE calling update (the skirt swings from the root's motion). */
  root: THREE.Group
  /**
   * Carry anchor: the top of the wooden pack shelf on her back (about 0.42 m up, 0.4 m behind her centre).
   * Parent the short flask stack here (it then leans and bobs with her) or copy its world position.
   */
  carry: THREE.Group
  update(p: PorterPose): void
}

let packGeo: THREE.BufferGeometry | null = null
function buildPack(): THREE.BufferGeometry {
  const w = PAL.scoopWoodMid
  const parts: THREE.BufferGeometry[] = [box(0.46, 0.05, 0.34, PAL.scoopWood).translate(0, -0.43, -0.4), box(0.46, 0.09, 0.04, w).translate(0, -0.36, -0.56)]
  for (const sx of [-1, 1]) {
    parts.push(box(0.05, 0.8, 0.05, w).translate(sx * 0.17, -0.06, -0.21))
    parts.push(box(0.05, 0.05, 0.36, w).translate(sx * 0.2, -0.4, -0.38))
    // shoulder straps
    parts.push(box(0.05, 0.03, 0.3, PAL.belt).translate(sx * 0.13, 0.36, -0.06))
    parts.push(box(0.05, 0.3, 0.03, PAL.belt).rotateX(0.2).translate(sx * 0.13, 0.22, 0.14))
  }
  return merge(parts)
}

/** Attendant who carries flasks from the pile to the cauldron on a wooden pack frame (SPEC 2.12, pad E). */
export function makePorter(): PorterModel {
  const m = makeMaid(PORTER)
  m.root.name = 'porter'
  m.body.add(new THREE.Mesh((packGeo ??= buildPack()), charMat()))
  const carry = new THREE.Group()
  carry.position.set(0, -0.4, -0.4)
  m.body.add(carry)
  let ld = 0
  const model: PorterModel = {
    root: m.root,
    carry,
    update(p) {
      const dt = p.dt ?? 0
      ld += (((p.load ?? 0) > 0 ? 1 : 0) - ld) * (dt > 0 ? damp(12, dt) : 1)
      m.base(p.t, dt, p.speed, p.odo, P.PORTER_SPEED, 9 * DEG * ld, 0)
      const run = m.run
      const sw = m.sn * 0.2 * (1 - ld)
      // free: arms swing; loaded: both hands on the straps at the chest
      m.arms(
        lerp(0.3, 0.14, ld), lerp(-0.12 + 0.05 * run, 0.2, ld), lerp(0.05 + sw, 0.19, ld),
        lerp(-0.3, -0.14, ld), lerp(-0.12 + 0.05 * run, 0.2, ld), lerp(0.05 - sw, 0.19, ld),
        lerp(0.6, 1, ld), lerp(-0.4, -0.6, ld), lerp(-0.7, -0.2, ld),
      )
    },
  }
  model.update({ t: 0, speed: 0, odo: 0 })
  return model
}

// ---------------------------------------------------------------------------------------------------
// Cart driver [EXTENDED]
// ---------------------------------------------------------------------------------------------------
export interface DriverPose {
  /** Animation clock in seconds. */
  t: number
  /** Frame delta (blends between walking and sitting). 0 or omitted = snap. */
  dt?: number
  /** true = seated on the cart bench, hands on the two levers (Driver.state !== 'toCart'); false = on foot. */
  seated: boolean
  /** On foot: ground speed in m/s and metres travelled (no odometer: t * speed). Ignored while seated. */
  speed?: number
  odo?: number
}

export interface DriverModel {
  /** Origin on the ground at the seat position (or at his feet when walking), facing +z. */
  root: THREE.Group
  /** Empty group above the cap: anchor for the happy-emoji bubble. */
  headAnchor: THREE.Group
  /** Lever handles in root space: x = half spacing, y = height, z = distance ahead (same meaning and default as DoctorModel.cartGrip). */
  grip: THREE.Vector3
  /** Optional right-hand lever grip when the two levers stand differently (same meaning as DoctorModel.cartGripRight). null (default) = mirrored. */
  gripRight: THREE.Vector3 | null
  /** Bench height above the root origin (same meaning and default as DoctorModel.seatHeight). */
  seatHeight: number
  update(p: DriverPose): void
}

/** Healed villager with a flat cap who drives the cart (SPEC 2.12, pad I). */
export function makeDriver(): DriverModel {
  const v: VillagerModel = makeVillager({ cap: true })
  v.root.name = 'driver'
  v.grip.set(0.4, 1.52, 0.52)
  const model: DriverModel = {
    root: v.root,
    headAnchor: v.headAnchor,
    grip: v.grip,
    gripRight: null,
    seatHeight: 0.95,
    update(p) {
      v.seatHeight = model.seatHeight
      v.gripRight = model.gripRight
      const moving = (p.speed ?? 0) > 0.2
      v.update({ look: 'healed', pose: p.seated ? 'drive' : moving ? 'walk' : 'stand', phase: p.seated ? 0 : (p.odo ?? 0), t: p.t, dt: p.dt })
    },
  }
  model.update({ t: 0, seated: true })
  return model
}

// ---------------------------------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------------------------------
/** Gallery-only bench so the seated driver is not floating (the real cart is tools.ts). */
function driverOnBench() {
  const d = makeDriver()
  const g = new THREE.Group()
  const bench = new THREE.Mesh(paint(new THREE.BoxGeometry(1.1, d.seatHeight, 0.5), PAL.cartWood), charMat())
  bench.position.set(0, d.seatHeight / 2, -0.05)
  g.add(bench, d.root)
  return { root: g, inner: d }
}

/**
 * Gallery-only: one bed (a box as in villager.ts; the real one is furniture.ts) with a patient and his nurse at
 * L.NURSE_POST, looping the whole treatment of SPEC 2.10 (compare with seq_inject.jpg): 1 s of waiting, the
 * injection, the mint tint, healed at P.TREATMENT_TIME, sitting up cheering, hopping off.
 */
function wardScene() {
  const g = new THREE.Group()
  const bed = new THREE.Mesh(paint(new THREE.BoxGeometry(P.BED_W, 0.55, P.BED_D), PAL.blanket), charMat())
  bed.position.y = 0.275
  const patient = makeVillager()
  patient.root.rotation.y = Math.PI / 2
  const nurse = makeNurse()
  nurse.root.position.set(L.NURSE_POST.x, 0, L.NURSE_POST.z)
  nurse.root.rotation.y = Math.atan2(-L.NURSE_POST.x, -L.NURSE_POST.z) // facing the patient at the bed centre
  g.add(bed, patient.root, nurse.root)
  return { root: g, patient, nurse }
}

export const GALLERY: GalleryItem[] = [
  galleryItem('ward: nurse treats patient', 2.4, wardScene, (w, t, dt) => {
    const u = (t % 4.2) - 1 // Bed.treatT, from -1 to 3.2
    w.nurse.update({ t, dt, speed: 0, odo: 0, treatT: u })
    const healed = u >= P.TREATMENT_TIME
    const off = u >= P.TREAT_HOP_OFF
    const hop = clamp01((u - P.TREAT_HOP_OFF) / (P.TREAT_END - P.TREAT_HOP_OFF))
    w.patient.root.position.set(off ? L.BED_SIDE.x * hop : 0, off ? 0.55 * (1 - hop) + 0.5 * Math.sin(Math.PI * hop) : 0.55, off ? L.BED_SIDE.z * hop : 0)
    w.patient.update({
      look: healed ? 'healed' : 'bathed',
      pose: off ? (u >= P.TREAT_END ? 'stand' : 'hop') : u >= P.TREAT_SIT_UP ? 'sit' : 'lie',
      phase: hop,
      t,
      dt,
      tint: healed ? 0 : smoothstep(0.5, 0.58, u) * (1 - smoothstep(1.2, 1.32, u)),
    })
  }),
  galleryItem('nurse idle', 1.1, makeNurse, (h, t, dt) => h.update({ t, dt, speed: 0, odo: 0 })),
  // spin at 1 rad/s: &t=<heading in radians> (t = 3.14: back to the camera side, as she stands at a bed)
  galleryItem('nurse turntable', 1.1, makeNurse, (h, t, dt) => {
    h.root.rotation.y = t
    h.update({ t, dt, speed: 0, odo: 0 })
  }),
  galleryItem('usher turntable', 1.1, makeUsher, (h, t, dt) => {
    h.root.rotation.y = t
    h.update({ t, dt, speed: 0, odo: 0, point: true, pointDir: t + 0.5 })
  }),
  galleryItem('nurse run', 1.1, makeNurse, (h, t, dt) => h.update({ t, dt, speed: P.NURSE_RUN_SPEED, odo: t * P.NURSE_RUN_SPEED })),
  galleryItem('nurse run circle', 1.8, makeNurse, (h, t, dt) => {
    const w = P.NURSE_RUN_SPEED / 1.3
    h.root.position.set(Math.sin(t * w) * 1.3, 0, Math.cos(t * w) * 1.3 - 1.3)
    h.root.rotation.y = t * w + Math.PI / 2
    h.update({ t, dt, speed: P.NURSE_RUN_SPEED, odo: t * P.NURSE_RUN_SPEED })
  }),
  galleryItem('nurse inject cycle', 1.6, makeNurse, (h, t, dt) => h.update({ t, dt, speed: 0, odo: 0, treatT: (t % 2.6) - 0.6 })),
  galleryItem('nurse jab (treatT 0.5)', 1.6, makeNurse, (h, t, dt) => h.update({ t, dt, speed: 0, odo: 0, treatT: 0.5 })),
  galleryItem('nurse draining (treatT 1.0)', 1.6, makeNurse, (h, t, dt) => h.update({ t, dt, speed: 0, odo: 0, treatT: 1.0 })),
  galleryItem('usher stand', 1.1, makeUsher, (h, t, dt) => h.update({ t, dt, speed: 0, odo: 0 })),
  galleryItem('usher point', 1.1, makeUsher, (h, t, dt) => h.update({ t, dt, speed: 0, odo: 0, point: true, pointDir: Math.PI / 2 })),
  galleryItem('usher point sweep', 1.1, makeUsher, (h, t, dt) => h.update({ t, dt, speed: 0, odo: 0, point: t % 4 < 3, pointDir: Math.sin(t * 0.8) * 2 })),
  galleryItem('usher run', 1.1, makeUsher, (h, t, dt) => h.update({ t, dt, speed: P.USHER_RUN_SPEED, odo: t * P.USHER_RUN_SPEED })),
  galleryItem('porter idle', 1.1, makePorter, (h, t, dt) => h.update({ t, dt, speed: 0, odo: 0 })),
  galleryItem(
    'porter carrying',
    1.1,
    () => {
      const h = makePorter()
      // gallery-only stand-in for three stacked flasks on the carry anchor
      for (let i = 0; i < 3; i++) {
        const f = new THREE.Mesh(new THREE.SphereGeometry(P.FLASK_BULB / 2, 10, 8), unlit(PAL.flask))
        f.position.y = P.FLASK_BULB / 2 + i * P.FLASK_STACK_PITCH
        h.carry.add(f)
      }
      return h
    },
    (h, t, dt) => h.update({ t, dt, speed: P.PORTER_SPEED, odo: t * P.PORTER_SPEED, load: 3 }),
  ),
  galleryItem('driver seated', 1.2, driverOnBench, (w, t, dt) => w.inner.update({ t, dt, seated: true })),
  galleryItem('driver walk', 1.2, makeDriver, (h, t, dt) => h.update({ t, dt, seated: false, speed: 5, odo: t * 5 })),
]
