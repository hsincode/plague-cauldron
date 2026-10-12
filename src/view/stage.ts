// Renderer, camera rig, lights and the render pipeline (owned by the stage/environment package).
//
// COLOUR MANAGEMENT (decided deliberately, do not "fix" it):
//   - three.js colour management is ON. PAL hex values are sRGB; all lighting and blending happens in linear light.
//   - There is NO tone-mapping operator. PAL colours were sampled from finished frames of the ad, so the display
//     transform must be the identity for them: an unlit material shows exactly its PAL colour, and a lit top-facing
//     surface under the ambient rig shows its PAL colour too (the rig sums to 1.0 irradiance on +y, see RIG below).
//   - quality 'high' renders into a linear half-float target; the composite pass applies the vignette, a soft
//     highlight shoulder that is the identity below 0.8 (so only lantern/fire/flash highlights are compressed instead
//     of clipping), the sRGB transfer function and a 1/255 dither. quality 'low' renders straight to the canvas
//     (renderer.outputColorSpace = sRGB, NoToneMapping): same colours, hard clip, no outline/vignette/bloom.
//   - the canvas is multisampled only when the stage is created at 'low': at 'high' it receives one full-screen
//     triangle and the anti-aliasing happens in the post chain, so a stage that drops to 'low' later draws without it.
//
// LIGHT RIG (night scene, SPEC 7.3; numbers are irradiance factors E, where E = 1 reproduces the albedo):
//   - hemisphere: +y 0.70/0.72/0.76, -y 0.40/0.45/0.58  -> vertical faces about 0.57 and bluish (cool night shade)
//   - key (directional, from the north = screen upper-left, elevation 54 deg): adds 0.30 on +y, so flat ground and
//     the tops of things come out at their PAL colour; sphere highlights sit at the upper-left as in the ad
//   - lantern: warm point light that follows the doctor. It is a bounded pool (decay 0, range 3.2 m) fitted to the ad
//     (dirt at 0.2 s and 7.0 s: #b49983 at 0.7 m, #95867a at 1.5 m, #84796f at 2.4 m, back to #716e63 by 4 m).
//     It sits low INSIDE the doctor (y = 0.8): low, because the ad's pool is tight (half strength at 1.5 m) and a
//     higher light spreads it; inside, so that it lights the ground and whatever is around him but never over-exposes
//     the doctor himself. The courtyard tiles answer it only half as much as dirt does (11.4 s: #9c9291 at 1 m on
//     #7e7e87 tiles), and so do the painted walls, rocks and trees (they barely brighten when he walks up to them);
//     env.ts gets that by splitting their albedo into a lit and an emissive half (TILE_LIT / PAINT_LIT there).
//   - fire: orange point light under the cauldron bowl, range 5 m (flicker is applied by the stage, see
//     Stage.fireLight). It lights the logs, the bowl and whoever stands at the rim; the ad shows no orange on the
//     tiles beyond the ember bed, so there is no ground glow outside the cauldron model's own ember decal.
//   - potion: cyan point light above the liquid, intensity proportional to the potion level
//   - flash: spare point light for unlock/heal bursts (kept in the shaders all the time so that turning it on
//     never triggers a shader recompile)
//   No shadow maps; contact shadows are blob decals (materials.blobShadow, env.ts).
//   Fog: PAL.fog, 26.2..65.4 m (x zoom): fitted at 24..60 m for a camera 24.6 m away, then scaled with the camera
//   distance (P.CAMERA_OFFSET is now 26.8 m). SPEC 7.3 says 30..65; the ad is already darker at 32 m, see FOG_NEAR.
//
// POST (view/post.ts): depth-edge outline, FXAA, bloom, vignette. Objects opt out of the outline by being on FX_LAYER:
//   - automatically: every object whose material is `transparent` (glows, particles, decals, billboards) is routed
//     to the FX layer each frame, so it is drawn over the outlines of what is behind it and is never outlined itself;
//   - explicitly: stage.noOutline(obj) (use it for the InstancedMesh of small river balls);
//   - obj.userData.outline = true forces a transparent object to stay in the outlined pass.
//   Lights are visible to both passes automatically. Side effect to know about: a THREE.Raycaster only tests layer 0
//   by default, so it does not see FX-layer objects (call raycaster.layers.enable(FX_LAYER) if you ever need them).
import * as THREE from 'three'
import { P, PAL } from '../config'
import { createPost, FX_LAYER, type PostSettings } from './post'

export { FX_LAYER } from './post'

export type Quality = 'high' | 'low'

/** Reference intensities for the gameplay lights (the binding layer scales these, e.g. potion = potionFull * level). */
export const LIGHT = {
  /** Lantern at full strength (it is always on while the doctor exists). */
  lantern: 5.0,
  /** Height the stage keeps the lantern at (inside the doctor's body). */
  lanternY: 0.8,
  /** Fire under the cauldron (the stage adds the flicker). */
  fire: 4.6,
  /** Potion light when the cauldron is full; scale by potion / capacity. */
  potionFull: 1.5,
  /** Suggested peak for stage.flash during an unlock burst. */
  flashPeak: 9,
} as const

// Ambient rig in irradiance factors (linear RGB).
const RIG = {
  sky: [0.7, 0.72, 0.76],
  ground: [0.4, 0.45, 0.58],
  key: [0.369, 0.356, 0.344],
  /** Unit vector from a surface towards the key light: SPEC position target + (-3, 20, -14). */
  keyDir: new THREE.Vector3(-3, 20, -14).normalize(),
} as const

/**
 * Irradiance factor of the ambient rig (hemisphere + key, no point lights) for a surface with unit normal n.
 * env.ts uses it to bake "painted" colours: albedo = wanted colour / ambientE(normal).
 */
export function ambientE(nx: number, ny: number, nz: number, out: THREE.Color): THREE.Color {
  const w = 0.5 * ny + 0.5
  const k = Math.max(0, nx * RIG.keyDir.x + ny * RIG.keyDir.y + nz * RIG.keyDir.z)
  return out.setRGB(
    RIG.ground[0] + (RIG.sky[0] - RIG.ground[0]) * w + RIG.key[0] * k,
    RIG.ground[1] + (RIG.sky[1] - RIG.ground[1]) * w + RIG.key[1] * k,
    RIG.ground[2] + (RIG.sky[2] - RIG.ground[2]) * w + RIG.key[2] * k,
    THREE.LinearSRGBColorSpace,
  )
}

export interface Stage {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /**
   * Warm lantern pool that follows the doctor. Set position.x / position.z every frame; intensity defaults to
   * LIGHT.lantern (set 0 to switch it off). The stage forces position.y = LIGHT.lanternY on every render unless
   * manualCamera is true, so the SPEC's "y = 2.2" may be passed without harm.
   */
  lantern: THREE.PointLight
  /**
   * Orange fire light under the cauldron (default position (0, 0.2, 0), intensity LIGHT.fire). The binding layer may
   * move it or change .intensity; the +-20 % flicker at 8-12 Hz is applied by the stage to the light's colour.
   */
  fireLight: THREE.PointLight
  /** Cyan light above the potion (default position (0, 1.9, 0), intensity 0). Set intensity = LIGHT.potionFull * potion / capacity. */
  potionLight: THREE.PointLight
  /**
   * Spare warm-gold point light for unlock / heal bursts: set position, optional color, distance (default 7 m) and
   * animate intensity 0 -> LIGHT.flashPeak -> 0. Keep it at 0 when idle. Using this light never recompiles shaders.
   */
  flash: THREE.PointLight
  /**
   * When true, render() leaves the camera, the fog range and the lantern height alone (the gallery positions them
   * itself) and dims the lantern to 40 % so that it works as a soft studio fill from any distance.
   */
  manualCamera: boolean
  /** Current render quality. */
  readonly quality: Quality
  /** Live post-processing parameters (outline width/opacity, bloom, vignette); see PostSettings. */
  readonly post: PostSettings
  /**
   * When true (default), every frame at quality 'high' objects with a transparent material are moved to FX_LAYER and
   * lights are made visible to both passes (one cheap scene traversal). Set false to manage layers yourself.
   */
  autoRoute: boolean
  /** Camera look-at target on the ground (already smoothed by the caller). */
  setTarget(x: number, z: number): void
  /** Zoom factor: 1 = SPEC framing, > 1 = pulled back (fog and outline distances follow). */
  setZoom(zoom: number): void
  /** Additive camera offset in world metres for shake. */
  setShake(x: number, y: number, z: number): void
  /**
   * 'high' = outline + bloom + vignette (default when supported); 'low' = plain forward render to the canvas, no post.
   * Safe to call at any time.
   */
  setQuality(q: Quality): void
  /**
   * Compiles the shader program of every material in the scene, hidden objects included, so that nothing compiles in
   * the frame where it first shows. Call once after the models are built; resolves when the programs are linked (the
   * driver does that in parallel where it can, so do not render before it resolves).
   */
  compile(): Promise<void>
  /**
   * Excludes obj and all its descendants from the outline pass (they are drawn after it, un-outlined). Call once
   * after creating e.g. the small-ball InstancedMesh or any dense field of small opaque things.
   */
  noOutline(obj: THREE.Object3D): void
  /** width/height in CSS pixels; the drawing buffer and every post target are width*pixelRatio x height*pixelRatio. */
  resize(width: number, height: number, pixelRatio: number): void
  render(dt: number): void
}

// Distance darkness. SPEC 7.3 says 30..65 m; measured against the ad (f_0052, f_0256: the ground is already 20 %
// darker at 32 m and about 60 % darker along the top edge, 44 m away) it starts a little earlier.
const FOG_NEAR = 26.2
const FOG_FAR = 65.4
/** Reach of the lantern pool (m); see the LIGHT RIG notes at the top. */
const LANTERN_RANGE = 3.2

const FX_MASK = 1 << FX_LAYER
const lin = (rgb: readonly number[]) => new THREE.Color().setRGB(rgb[0]!, rgb[1]!, rgb[2]!, THREE.LinearSRGBColorSpace)

/** How long compile() waits for the driver before it gives up and lets the programs link on first use (ms). */
const COMPILE_TIMEOUT = 4000

export function createStage(canvas: HTMLCanvasElement, startQuality: Quality = 'high'): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: startQuality === 'low', powerPreference: 'high-performance' })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(PAL.fog)
  const fog = new THREE.Fog(PAL.fog, FOG_NEAR, FOG_FAR)
  scene.fog = fog

  const camera = new THREE.PerspectiveCamera(P.CAMERA_FOV, 9 / 16, 1, 200)
  const target = new THREE.Vector3()
  const shake = new THREE.Vector3()
  let zoom = 1
  let time = 0

  // --- ambient rig (intensity PI makes the colour values irradiance factors for Lambert materials) ---
  const hemi = new THREE.HemisphereLight(lin(RIG.sky), lin(RIG.ground), Math.PI)
  const key = new THREE.DirectionalLight(lin(RIG.key), Math.PI)
  scene.add(hemi, key, key.target)

  // --- gameplay lights ---
  const lanternBase = lin([1, 0.59, 0.37])
  const lantern = new THREE.PointLight(lanternBase.clone(), LIGHT.lantern, LANTERN_RANGE, 0)
  lantern.position.set(0, LIGHT.lanternY, 0)
  const fireBase = lin([1, 0.3, 0.07])
  const fireLight = new THREE.PointLight(fireBase.clone(), LIGHT.fire, 5, 1)
  fireLight.position.set(0, 0.2, 0)
  const potionLight = new THREE.PointLight(0x9ff5ff, 0, 5.5, 0)
  potionLight.position.set(0, 1.9, 0)
  const flash = new THREE.PointLight(PAL.gold, 0, 7, 0)
  flash.position.set(0, 1.5, 0)
  scene.add(lantern, fireLight, potionLight, flash)
  for (const l of [hemi, key, lantern, fireLight, potionLight, flash]) l.layers.enable(FX_LAYER)

  // --- post ---
  const post = createPost(renderer)
  scene.add(post.outlineMesh)
  let quality: Quality = post.supported ? startQuality : 'low'
  post.outlineMesh.visible = quality === 'high'
  const size = new THREE.Vector2()

  const applyCamera = () => {
    const [ox, oy, oz] = P.CAMERA_OFFSET
    camera.position.set(target.x + ox * zoom + shake.x, oy * zoom + shake.y, target.z + oz * zoom + shake.z)
    camera.lookAt(target.x + shake.x, shake.y, target.z + shake.z)
    fog.near = FOG_NEAR * zoom
    fog.far = FOG_FAR * zoom
    lantern.position.y = LIGHT.lanternY
  }
  const applyKey = () => {
    // directional: only the direction matters, but keep it near the view for anyone who adds a helper
    key.target.position.set(target.x, 0, target.z)
    key.position.copy(key.target.position).addScaledVector(RIG.keyDir, 25)
  }
  applyCamera()
  applyKey()

  const route = (o: THREE.Object3D) => {
    if ((o as THREE.Light).isLight) {
      o.layers.enable(FX_LAYER)
      return
    }
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
    if (m === undefined || o.userData.postInternal === true) return
    const mask = o.layers.mask
    if (mask !== 1 && mask !== FX_MASK) return // somebody uses layers for something else: leave it alone
    const flag = o.userData.outline
    const fx = flag === false || (flag !== true && (Array.isArray(m) ? m[0]?.transparent === true : m.transparent === true))
    const want = fx ? FX_MASK : 1
    if (mask !== want) o.layers.mask = want
  }

  const stage: Stage = {
    renderer,
    scene,
    camera,
    manualCamera: false,
    lantern,
    fireLight,
    potionLight,
    flash,
    post: post.settings,
    autoRoute: true,
    get quality() {
      return quality
    },
    setTarget(x, z) {
      target.set(x, 0, z)
    },
    setZoom(z) {
      zoom = z
    },
    setShake(x, y, z) {
      shake.set(x, y, z)
    },
    setQuality(q) {
      quality = q === 'high' && post.supported ? 'high' : 'low'
      post.outlineMesh.visible = quality === 'high'
      if (quality === 'high') {
        renderer.getDrawingBufferSize(size)
        post.setSize(size.x, size.y)
      } else post.setSize(1, 1) // give the full-size targets back
    },
    compile() {
      const linked = quality === 'high' ? post.compile(renderer, scene, camera) : renderer.compileAsync(scene, camera)
      return new Promise<void>(resolve => {
        const done = () => resolve()
        linked.then(done, done)
        setTimeout(done, COMPILE_TIMEOUT)
      })
    },
    noOutline(obj) {
      obj.traverse(o => {
        o.userData.outline = false
        if ((o as THREE.Mesh).material !== undefined) o.layers.set(FX_LAYER)
      })
    },
    resize(width, height, pixelRatio) {
      renderer.setPixelRatio(pixelRatio)
      renderer.setSize(width, height, false)
      const aspect = width / height
      camera.aspect = aspect
      // Narrower than 9:16: keep the horizontal coverage of the reference framing.
      const ref = 9 / 16
      if (aspect < ref) {
        const hHalf = Math.atan(Math.tan((P.CAMERA_FOV * Math.PI) / 360) * ref)
        camera.fov = (Math.atan(Math.tan(hHalf) / aspect) * 360) / Math.PI
      } else camera.fov = P.CAMERA_FOV
      camera.updateProjectionMatrix()
      if (quality === 'high') {
        renderer.getDrawingBufferSize(size)
        post.setSize(size.x, size.y)
      }
    },
    render(dt) {
      time += dt
      if (!stage.manualCamera) applyCamera()
      applyKey()
      // fire flicker: +-20 % at 8-12 Hz, on the colour so that .intensity stays the binding layer's knob
      const f = 1 + 0.2 * (0.5 * Math.sin(time * 52.1) + 0.3 * Math.sin(time * 73.5 + 1.3) + 0.2 * Math.sin(time * 32.0 + 2.1))
      fireLight.color.copy(fireBase).multiplyScalar(f)
      // gallery / manual views move the lantern far away and widen its range: use it as a mild studio fill there
      // (0.32 x LIGHT.lantern = the 1.6 the gallery fill has always had)
      lantern.color.copy(lanternBase).multiplyScalar(stage.manualCamera ? 0.32 : 1)
      if (quality === 'high') {
        if (stage.autoRoute) scene.traverse(route)
        renderer.getDrawingBufferSize(size)
        post.setSize(size.x, size.y)
        post.render(renderer, scene, camera, fog.far / FOG_FAR)
      } else {
        const mask = camera.layers.mask
        camera.layers.mask = mask | FX_MASK
        renderer.setRenderTarget(null)
        renderer.render(scene, camera)
        camera.layers.mask = mask
      }
    },
  }
  // look-dev handle for the browser console / screenshot scripts (not used by the game)
  ;(globalThis as { __stage?: Stage }).__stage = stage
  return stage
}
