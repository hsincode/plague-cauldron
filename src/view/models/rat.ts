// Rats: the instanced black swarm outside ward-1 (crimson flash when the drill kills them) and the single grey
// ambient rat with an optional glowing red eye (SPEC 2.10, 7.4, 9 rows 23 and 28; art.md 2.14).
import * as THREE from 'three'
import { P, PAL } from '../../config'
import { clamp01 } from '../../core/math'
import { blobShadow, type GalleryItem } from '../materials'
import { charMat, DEG, galleryItem, glowTexture, merge, mixHex, relight, rev, shade, tone } from './doctor'

/** Teardrop body + tail, nose toward +z, belly on y = 0. `sheen` = how much lighter the top of the back is painted. */
function bodyGeo(body: number, tail: number, sheen: number): THREE.BufferGeometry {
  // plump teardrop (rat1.jpg): fat rump, pointed snout; the back catches the light (#343237 -> #676561, art.md 2.14)
  const b = shade(
    rev([[0, -0.3], [0.115, -0.285], [0.17, -0.215], [0.185, -0.11], [0.168, 0.01], [0.125, 0.13], [0.072, 0.225], [0.03, 0.285], [0, 0.3]], 8, i => (i >= 6 ? tone(body, 1.2) : body))
      .rotateX(90 * DEG)
      .scale(1, 0.82, 1)
      .translate(0, 0.15, 0),
    (_x, y) => 1 + sheen * clamp01((y - 0.16) / 0.14),
  )
  // thin tail lying on the ground, two segments with a kink
  const t1 = rev([[0.02, 0], [0.013, 0.26]], 4, tail).rotateX(-84 * DEG).rotateY(0.25).translate(0, 0.045, -0.27)
  const t2 = rev([[0.013, 0], [0.004, 0.26]], 4, tail).rotateX(-100 * DEG).rotateY(-0.35).translate(-0.064, 0.07, -0.52)
  return merge([b, t1, t2])
}

/**
 * Two big pointed ear wedges: the feature that reads from above (rat1.jpg shows two white triangles per rat).
 * They are three-sided spikes rather than flat plates so that they keep their width from every side.
 */
function earGeo(hex: number, size = 1): THREE.BufferGeometry {
  const ear = (sx: number) =>
    rev([[0.085, 0], [0.06, 0.09], [0, 0.23]], 3, hex, 1, 0.7)
      .rotateY(sx * 0.5)
      .rotateX(-10 * DEG)
      .rotateZ(-sx * 24 * DEG)
      .scale(size, size, size)
      // a smaller wedge is lifted so that it still stands clear of the back
      .translate(sx * 0.1, 0.2 + (1 - size) * 0.07, 0.06)
  // the wedges are nearly vertical and would sit in the dim ambient: relit beyond 1 so that they stay white
  return relight(merge([ear(-1), ear(1)]), 1, 2)
}

export interface Rats {
  /** Holds the 2 draw calls of the swarm; leave it at the origin (instances are written in world coordinates). */
  root: THREE.Group
  /** Capacity given to createRats(). */
  readonly max: number
  /** Animation clock for the built-in idle jitter (SPEC 9 row 28): set it once per frame before the set() calls. */
  time: number
  /** Jitter strength, 0 = none, 1 = default twitching. */
  jitter: number
  /**
   * Write instance i (0 <= i < max). Cheap: a handful of multiplications, no allocation.
   * @param heading core/math heading (0 = facing +z)
   * @param scale   1 = 0.6 m long; 0 hides the instance
   * @param flash   0 = black rat, 1 = crimson silhouette (SPEC 9 row 23: hold 1 for 3-5 frames, then hide it)
   * @param y       height of the belly above the ground (a rat riding on the coin heap, a rat flung into the air)
   * @param pitch   somersault about the rat's left-right axis in radians, pivoting on the belly (positive = nose down)
   */
  set(i: number, x: number, z: number, heading: number, scale?: number, flash?: number, y?: number, pitch?: number): void
  /** Draw only instances [0, n). */
  setCount(n: number): void
  /** Upload what set() wrote; call once per frame after the last set(). */
  commit(): void
}

/**
 * The rat swarm as two InstancedMeshes (bodies, ears) sharing one instance-matrix buffer.
 * @param earSize size of the ear wedges relative to the single rat's (1): a dense swarm drawn larger than life reads
 *                as a field of white spikes with full-size ears, the ad's swarm shows two small ticks per rat
 */
export function createRats(count: number, earSize = 1): Rats {
  const max = Math.max(1, count)
  const root = new THREE.Group()
  root.name = 'rats'
  const mat = charMat()
  const bodies = new THREE.InstancedMesh(bodyGeo(0xffffff, 0xb8aeb0, 0.8), mat, max)
  const ears = new THREE.InstancedMesh(earGeo(0xffffff, earSize), mat, max)
  ears.instanceMatrix = bodies.instanceMatrix
  bodies.frustumCulled = ears.frustumCulled = false
  root.add(bodies, ears)

  const cBody = new THREE.Color(PAL.rat)
  const cEar = new THREE.Color(PAL.ratEar)
  const cFlash = new THREE.Color(PAL.alertRed).multiplyScalar(1.25)
  const cFlashEar = cFlash.clone().multiplyScalar(0.6) // the ear geometry is painted brighter than 1
  const tmp = new THREE.Color()
  for (let i = 0; i < max; i++) {
    bodies.setColorAt(i, cBody)
    ears.setColorAt(i, cEar)
  }
  const flashed = new Float32Array(max)
  const arr = bodies.instanceMatrix.array as Float32Array
  let dirtyColor = true

  const rats: Rats = {
    root,
    max,
    time: 0,
    jitter: 1,
    set(i, x, z, heading, scale = 1, flash = 0, y = 0, pitch = 0) {
      const o = i * 16
      // twitch: quick small turns and a tiny hop, different for every rat
      const j = rats.jitter
      const k = i * 1.713
      const tw = j === 0 ? 0 : (Math.sin(rats.time * 13 + k * 5) * Math.sin(rats.time * 3.1 + k)) * 0.22 * j
      const hop = j === 0 ? 0 : Math.max(0, Math.sin(rats.time * 17 + k * 9)) * 0.025 * j
      const h = heading + tw
      const c = Math.cos(h) * scale
      const s = Math.sin(h) * scale
      // yaw, then the somersault about the rat's own x axis
      const cp = pitch === 0 ? 1 : Math.cos(pitch)
      const sp = pitch === 0 ? 0 : Math.sin(pitch)
      arr[o] = c
      arr[o + 1] = 0
      arr[o + 2] = -s
      arr[o + 3] = 0
      arr[o + 4] = sp * s
      arr[o + 5] = cp * scale
      arr[o + 6] = sp * c
      arr[o + 7] = 0
      arr[o + 8] = cp * s
      arr[o + 9] = -sp * scale
      arr[o + 10] = cp * c
      arr[o + 11] = 0
      arr[o + 12] = x
      arr[o + 13] = hop * scale + y
      arr[o + 14] = z
      arr[o + 15] = 1
      if (flash !== flashed[i]) {
        flashed[i] = flash
        const f = clamp01(flash)
        bodies.setColorAt(i, tmp.copy(cBody).lerp(cFlash, f))
        ears.setColorAt(i, tmp.copy(cEar).lerp(cFlashEar, f))
        dirtyColor = true
      }
    },
    setCount(n) {
      bodies.count = ears.count = Math.max(0, Math.min(max, n | 0))
    },
    commit() {
      bodies.instanceMatrix.needsUpdate = true
      if (dirtyColor) {
        bodies.instanceColor!.needsUpdate = true
        ears.instanceColor!.needsUpdate = true
        dirtyColor = false
      }
    },
  }
  for (let i = 0; i < max; i++) rats.set(i, 0, 0, 0, 0)
  rats.commit()
  return rats
}

export interface RatPose {
  /** Animation clock in seconds. */
  t: number
  /** Ground speed in m/s (0 = idling: sniffs and twitches; above 1 = scurrying, the red eye leaves a short smear). Default 0. */
  speed?: number
}

export interface RatModel {
  /** Belly on the ground at the origin, nose toward +z. The binder writes position and rotation.y. */
  root: THREE.Group
  update(p: RatPose): void
}

let greyGeo: THREE.BufferGeometry | null = null
let eyeMat: THREE.SpriteMaterial | null = null

/** One grey ambient rat (derelict yard, forest). `redEye` adds the glowing red eye of the runner along the ward wall. */
export function makeRat(opts: { redEye?: boolean } = {}): RatModel {
  greyGeo ??= merge([bodyGeo(tone(PAL.ratGrey, 0.85), mixHex(PAL.ratGrey, PAL.log, 0.5), 0.25), earGeo(PAL.ratEar)])
  const root = new THREE.Group()
  root.name = 'rat'
  root.add(blobShadow(0.75, 0.75, 0.4))
  const body = new THREE.Mesh(greyGeo, charMat())
  root.add(body)
  let eye: THREE.Sprite | null = null
  let smear: THREE.Mesh | null = null
  let smearMat: THREE.MeshBasicMaterial | null = null
  if (opts.redEye) {
    eyeMat ??= new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(PAL.ratEye).multiplyScalar(2.2), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })
    eye = new THREE.Sprite(eyeMat)
    eye.position.set(0, 0.17, 0.22)
    body.add(eye)
    smearMat = new THREE.MeshBasicMaterial({ map: glowTexture(), color: PAL.ratEye, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 })
    smear = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 1).rotateX(-90 * DEG).translate(0, 0, -0.5), smearMat)
    smear.position.set(0, 0.13, 0.3)
    root.add(smear)
  }
  const model: RatModel = {
    root,
    update(p) {
      const run = clamp01((p.speed ?? 0) / 2)
      const t = p.t
      // idle: sniffing (nose up and down), small turns; running: fast body wiggle
      body.rotation.x = (1 - run) * (-0.12 + 0.1 * Math.sin(t * 6) * Math.max(0, Math.sin(t * 0.9)))
      body.rotation.y = (1 - run) * 0.25 * Math.sin(t * 1.7) * Math.sin(t * 0.6) + run * 0.16 * Math.sin(t * 26)
      body.position.y = run * 0.03 * Math.abs(Math.sin(t * 22))
      if (eye) eye.scale.setScalar(0.5 + 0.08 * Math.sin(t * 9))
      if (smear && smearMat) {
        smearMat.opacity = 0.7 * run
        smear.visible = run > 0.02
        smear.scale.z = 0.5 + 0.5 * run
      }
    },
  }
  model.update({ t: 0 })
  return model
}

// ---------------------------------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------------------------------
function carpet(): { root: THREE.Group; rats: Rats; pos: Float32Array } {
  const rats = createRats(P.RAT_COUNT)
  const pos = new Float32Array(P.RAT_COUNT * 3)
  let n = 0
  // staggered rows 0.5 m apart, all facing the gate (-z here), like f_0127
  for (let row = 0; n < P.RAT_COUNT; row++) {
    for (let col = 0; col < 15 && n < P.RAT_COUNT; col++) {
      const h = Math.sin(n * 91.7) * 43758.5
      const r = h - Math.floor(h)
      pos[n * 3] = (col - 7 + (row % 2) * 0.5) * 0.52 + (r - 0.5) * 0.2
      pos[n * 3 + 1] = (row - 5) * 0.56 + (((r * 7) % 1) - 0.5) * 0.2
      pos[n * 3 + 2] = Math.PI + (((r * 13) % 1) - 0.5) * 0.7
      n++
    }
  }
  rats.setCount(n)
  return { root: rats.root, rats, pos }
}

export const GALLERY: GalleryItem[] = [
  galleryItem('rat grey idle', 0.6, makeRat, (h, t) => h.update({ t })),
  galleryItem('rat red eye running', 1.2, () => makeRat({ redEye: true }), (h, t) => {
    h.root.position.set(Math.sin(t * 2.5) * 0.9, 0, Math.cos(t * 2.5) * 0.9)
    h.root.rotation.y = t * 2.5 + Math.PI / 2
    h.update({ t, speed: 2.3 })
  }),
  galleryItem('rat carpet 150', 4.5, carpet, (h, t) => {
    h.rats.time = t
    // a kill front sweeps across every 4 s: crimson for 0.13 s, then gone, back after the sweep
    const front = ((t % 4) / 2.2) * 9 - 4.5
    for (let i = 0; i < P.RAT_COUNT; i++) {
      const x = h.pos[i * 3]!
      const d = front - x
      const dead = d > 0.35 && d < 3
      h.rats.set(i, x, h.pos[i * 3 + 1]!, h.pos[i * 3 + 2]!, dead ? 0 : 1, d > 0 && d <= 0.35 ? 1 : 0)
    }
    h.rats.commit()
  }),
]
