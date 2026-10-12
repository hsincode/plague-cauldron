// Post-processing chain used by stage.render() at quality 'high'.
//
//   pass 1  scene, layer 0 (everything that may be outlined)          -> main target (linear HDR, MSAA x4, depth)
//   pass 2  scene, layer FX_LAYER, drawn on top of pass 1             -> same target, no clear
//           - opaque FX-layer objects first (they never get an outline)
//           - then the OUTLINE: a full-screen triangle that lives in the scene on FX_LAYER with the lowest
//             renderOrder of the transparent list. It reads the depth resolved from pass 1 and draws a thin
//             near-black line on depth discontinuities. It writes the depth of the object that owns the line,
//             so FX in front of that object cover the line and FX behind it never cut it.
//           - then every transparent FX-layer object (glows, particles, billboards, ground decals)
//   pass 3  restrained bloom (bright pass at 1/4 resolution, three dual-filter levels)
//   pass 4  composite to the canvas: edge anti-aliasing of the scene colour (the outline is made from one depth sample
//           per pixel, so it comes out of pass 2 with stair-steps; a small FXAA smooths it and whatever the 4x MSAA
//           missed), bloom, vignette (SPEC 7.3), soft highlight shoulder, sRGB encode, dither
//
// The outline is distance and size aware:
//   - its width is settings.outlineWidth metres in the world (SPEC 7.1: 0.02-0.03 m), converted to pixels per pixel
//     from the view depth, so it is about 2 px at 608x1080 (as in the ad) and 4.5 px at 1440x2560, and it thins and
//     fades with distance;
//   - the strength follows the HEIGHT of the depth step (ray-depth step x how steeply the ray descends):
//     nothing under 6 cm, full from 20 cm. The inside of a dense field of 0.24 m balls has steps of about 5 cm,
//     so it stays clean; walls, rocks, props and characters have steps of 0.3 m and more.
//   - anything on FX_LAYER is drawn after the edge detection and is never outlined (see Stage.noOutline).
import * as THREE from 'three'

/** Objects on this layer are rendered in pass 2: never outlined, drawn over the outlines of what is behind them. */
export const FX_LAYER = 1

export interface PostSettings {
  /** Outline line width in world metres. */
  outlineWidth: number
  /** Outline opacity 0..1 (0 disables the outline pass). */
  outlineOpacity: number
  /** Height of a depth step (metres) where the line starts / reaches full strength. */
  outlineStep: [number, number]
  /** View distance (metres) where the line starts to fade / is gone (multiplied by the camera zoom by the stage). */
  outlineFade: [number, number]
  /** Edge anti-aliasing (FXAA) of the scene colour in the composite pass. Default true. */
  fxaa: boolean
  /** Bloom strength (0 disables the bloom passes). */
  bloom: number
  /** Linear luminance where bloom starts, and the width of the soft knee above it. */
  bloomThreshold: [number, number]
  /** Vignette: fraction of light removed at the corners (linear light). */
  vignette: number
  /** Vignette start / end radius, in units of the half screen (1 = edge centre, 1.41 = corner). */
  vignetteRange: [number, number]
  /**
   * Vignette shape: x and y scale of the radius and the height of its centre above the screen centre (half-screen
   * units). The ad's vignette is flatter than a circle and sits a little high: the bottom is darker than the sides.
   */
  vignetteShape: [number, number, number]
}

export interface Post {
  readonly settings: PostSettings
  /** True when the device can run the chain (needs float or 8-bit multisampled render targets: any WebGL2). */
  readonly supported: boolean
  /** The outline triangle; the stage adds it to the scene and hides it at quality 'low'. */
  readonly outlineMesh: THREE.Mesh
  /** Resize every target to the drawing-buffer size in physical pixels. Cheap when nothing changed. */
  setSize(width: number, height: number): void
  /** Render scene + post to the canvas. `zoom` scales the outline fade distances (1 = SPEC framing). */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, zoom: number): void
  /**
   * Compile the programs render() will use for `scene` (every object, visible or not) and for the chain's own passes.
   * Resolves when they are linked.
   */
  compile(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): Promise<unknown>
  dispose(): void
}

const VERT = /* glsl */ `
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`

const OUTLINE_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tDepth;
uniform vec2 uTexel;
uniform vec2 uNearFar;
uniform vec2 uTanHalf;
uniform vec3 uUpView;
uniform float uPxPerM;
uniform float uWidth;
uniform vec2 uStep;
uniform vec2 uFade;
uniform vec4 uColor;
in vec2 vUv;
out vec4 fragColor;

float viewZ(vec2 uv) {
  float d = texture(tDepth, uv).r;
  return uNearFar.x * uNearFar.y / (uNearFar.y - d * (uNearFar.y - uNearFar.x));
}

void main() {
  float z0 = viewZ(vUv);
  // half line width in pixels at this depth
  float ideal = 0.5 * uWidth * uPxPerM / z0;
  float rad = clamp(ideal, 1.0, 6.0);
  vec2 o = uTexel * rad;
  // metres of height per metre of view depth along this pixel's ray
  float hf = max(abs(dot(vec3((vUv * 2.0 - 1.0) * uTanHalf, -1.0), uUpView)), 0.35);
  float zmin = z0;
  float acc = 0.0;
  const vec2 D[4] = vec2[4](vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.7071, 0.7071), vec2(-0.7071, 0.7071));
  for (int i = 0; i < 4; i++) {
    float a = viewZ(vUv + D[i] * o);
    float b = viewZ(vUv - D[i] * o);
    // second difference: zero on any plane, equal to the step height across a depth discontinuity
    acc += smoothstep(uStep.x, uStep.y, abs(a + b - 2.0 * z0) * hf);
    zmin = min(zmin, min(a, b));
  }
  float alpha = clamp(acc * 0.5, 0.0, 1.0);
  alpha *= clamp(ideal * 1.15, 0.35, 1.0);
  alpha *= 1.0 - smoothstep(uFade.x, uFade.y, zmin);
  alpha *= uColor.a;
  if (alpha < 0.004) discard;
  // the line belongs to the nearer surface: FX in front of it cover it, FX behind it are rejected
  float zl = max(zmin - 0.06, uNearFar.x);
  gl_FragDepth = (uNearFar.y - uNearFar.x * uNearFar.y / zl) / (uNearFar.y - uNearFar.x);
  fragColor = vec4(uColor.rgb, alpha);
}`

const BRIGHT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tMap;
uniform vec2 uTexel;
uniform vec2 uThreshold;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 c = texture(tMap, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(tMap, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture(tMap, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(tMap, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c = clamp(c * 0.25, 0.0, 6.0);
  float l = max(c.r, max(c.g, c.b));
  fragColor = vec4(c * smoothstep(uThreshold.x, uThreshold.x + uThreshold.y, l), 1.0);
}`

const DOWN_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tMap;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 c = texture(tMap, vUv).rgb * 4.0;
  c += texture(tMap, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(tMap, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture(tMap, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(tMap, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  fragColor = vec4(c / 8.0, 1.0);
}`

const UP_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tMap;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 c = texture(tMap, vUv + uTexel * vec2(-2.0, 0.0)).rgb + texture(tMap, vUv + uTexel * vec2(2.0, 0.0)).rgb;
  c += texture(tMap, vUv + uTexel * vec2(0.0, -2.0)).rgb + texture(tMap, vUv + uTexel * vec2(0.0, 2.0)).rgb;
  c += 2.0 * (texture(tMap, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(tMap, vUv + uTexel * vec2(1.0, -1.0)).rgb);
  c += 2.0 * (texture(tMap, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(tMap, vUv + uTexel * vec2(1.0, 1.0)).rgb);
  fragColor = vec4(c / 12.0, 1.0);
}`

const FINAL_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform float uBloom;
uniform vec3 uVignette;
uniform vec3 uVigShape;
uniform vec2 uTexel;
uniform float uFxaa;
in vec2 vUv;
out vec4 fragColor;
vec3 fetch(vec2 uv) {
  return max(texture(tColor, uv).rgb, 0.0);
}
// perceptual luma of a linear colour (cheap gamma 2)
float luma(vec3 c) {
  return dot(sqrt(min(c, vec3(1.0))), vec3(0.299, 0.587, 0.114));
}
// FXAA (the compact console variant): blur along the local edge direction, only where there is contrast
vec3 antialiased(vec2 uv) {
  vec3 m = fetch(uv);
  if (uFxaa < 0.5) return m;
  float lNW = luma(fetch(uv + uTexel * vec2(-1.0, -1.0)));
  float lNE = luma(fetch(uv + uTexel * vec2(1.0, -1.0)));
  float lSW = luma(fetch(uv + uTexel * vec2(-1.0, 1.0)));
  float lSE = luma(fetch(uv + uTexel * vec2(1.0, 1.0)));
  float lM = luma(m);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.035, lMax * 0.12)) return m;
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), vec2(-4.0), vec2(4.0)) * uTexel;
  vec3 a = 0.5 * (fetch(uv + dir * (1.0 / 3.0 - 0.5)) + fetch(uv + dir * (2.0 / 3.0 - 0.5)));
  vec3 b = a * 0.5 + 0.25 * (fetch(uv - dir * 0.5) + fetch(uv + dir * 0.5));
  float lB = luma(b);
  return (lB < lMin || lB > lMax) ? a : b;
}
// identity below 0.8, smooth roll-off towards 1.0 above: palette colours pass unchanged, highlights do not clip hard
vec3 shoulder(vec3 x) {
  vec3 t = max(x - 0.8, 0.0);
  return min(x, vec3(0.8)) + 0.2 * (1.0 - exp(-t / 0.2));
}
vec3 oetf(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
void main() {
  vec3 c = antialiased(vUv);
  c += texture(tBloom, vUv).rgb * uBloom;
  vec2 q = vUv * 2.0 - 1.0;
  float r = length(vec2(q.x * uVigShape.x, (q.y - uVigShape.z) * uVigShape.y));
  c *= 1.0 - uVignette.x * smoothstep(uVignette.y, uVignette.z, r);
  c = oetf(shoulder(c));
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(c, 1.0);
}`

const raw = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>, o: THREE.ShaderMaterialParameters = {}) =>
  new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, fog: false, toneMapped: false, ...o })

export function createPost(renderer: THREE.WebGLRenderer): Post {
  const settings: PostSettings = {
    outlineWidth: 0.03,
    outlineOpacity: 0.94,
    outlineStep: [0.06, 0.2],
    outlineFade: [39.2, 63.2],
    fxaa: true,
    bloom: 0.32,
    bloomThreshold: [0.85, 0.5],
    vignette: 0.72,
    vignetteRange: [0.3, 1.4],
    vignetteShape: [0.85, 1.15, 0.12],
  }

  const gl = renderer.getContext()
  const supported = renderer.capabilities.isWebGL2 !== false && typeof (gl as WebGL2RenderingContext).renderbufferStorageMultisample === 'function'
  // Half-float targets keep highlights above 1 for the bloom and avoid banding in the dark vignette.
  // Without the extension fall back to 8-bit sRGB targets (same look, clipped highlights).
  const hdr = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float')
  const colorOpts: THREE.RenderTargetOptions = hdr
    ? { type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace }
    : { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, colorSpace: THREE.SRGBColorSpace }

  const depthTexture = new THREE.DepthTexture(4, 4, THREE.UnsignedIntType)
  depthTexture.minFilter = depthTexture.magFilter = THREE.NearestFilter
  const main = new THREE.WebGLRenderTarget(4, 4, { ...colorOpts, samples: 4, depthBuffer: true, stencilBuffer: false, depthTexture, generateMipmaps: false })
  main.texture.name = 'post.main'
  const mips = [0, 1, 2, 3].map(i => {
    const rt = new THREE.WebGLRenderTarget(2, 2, { ...colorOpts, depthBuffer: false, generateMipmaps: false })
    rt.texture.name = 'post.bloom' + i
    return rt
  })

  const tri = new THREE.BufferGeometry()
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
  tri.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2))
  tri.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity)

  // --- outline (rendered inside pass 2 as part of the scene) ---
  const outlineMat = raw(
    OUTLINE_FRAG,
    {
      tDepth: { value: depthTexture },
      uTexel: { value: new THREE.Vector2() },
      uNearFar: { value: new THREE.Vector2(1, 200) },
      uTanHalf: { value: new THREE.Vector2(1, 1) },
      uUpView: { value: new THREE.Vector3(0, 1, 0) },
      uPxPerM: { value: 1 },
      uWidth: { value: settings.outlineWidth },
      uStep: { value: new THREE.Vector2() },
      uFade: { value: new THREE.Vector2() },
      // near-black with the blue cast of the scene's shadows (linear)
      uColor: { value: new THREE.Vector4(0.006, 0.008, 0.013, 1) },
    },
    { transparent: true, depthTest: true, depthWrite: true },
  )
  const outlineMesh = new THREE.Mesh(tri, outlineMat)
  outlineMesh.name = 'post.outline'
  outlineMesh.frustumCulled = false
  outlineMesh.matrixAutoUpdate = false
  outlineMesh.renderOrder = -1e9
  outlineMesh.layers.set(FX_LAYER)
  outlineMesh.userData.postInternal = true

  // --- full-screen passes ---
  const fsScene = new THREE.Scene()
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const fsMesh = new THREE.Mesh(tri)
  fsMesh.frustumCulled = false
  fsScene.add(fsMesh)
  const brightMat = raw(BRIGHT_FRAG, { tMap: { value: main.texture }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: new THREE.Vector2() } })
  const downMat = raw(DOWN_FRAG, { tMap: { value: null }, uTexel: { value: new THREE.Vector2() } })
  const upMat = raw(UP_FRAG, { tMap: { value: null }, uTexel: { value: new THREE.Vector2() } }, { blending: THREE.AdditiveBlending, transparent: true })
  const finalMat = raw(FINAL_FRAG, { tColor: { value: main.texture }, tBloom: { value: mips[0]!.texture }, uBloom: { value: 0 }, uVignette: { value: new THREE.Vector3() }, uVigShape: { value: new THREE.Vector3() }, uTexel: { value: new THREE.Vector2() }, uFxaa: { value: 1 } })

  const pass = (mat: THREE.Material, target: THREE.WebGLRenderTarget | null) => {
    fsMesh.material = mat
    renderer.setRenderTarget(target)
    renderer.render(fsScene, fsCam)
  }

  let W = 0
  let H = 0
  const up = new THREE.Vector3()

  const post: Post = {
    settings,
    supported,
    outlineMesh,
    setSize(width, height) {
      width = Math.max(1, Math.floor(width))
      height = Math.max(1, Math.floor(height))
      if (width === W && height === H) return
      W = width
      H = height
      main.setSize(W, H)
      let w = W
      let h = H
      for (let i = 0; i < mips.length; i++) {
        const div = i === 0 ? 4 : 2
        w = Math.max(1, Math.round(w / div))
        h = Math.max(1, Math.round(h / div))
        mips[i]!.setSize(w, h)
      }
      ;(outlineMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / W, 1 / H)
    },
    render(r, scene, camera, zoom) {
      const autoClear = r.autoClear
      const mask = camera.layers.mask
      const prevTarget = r.getRenderTarget()
      const u = outlineMat.uniforms
      const s = settings

      // ---- pass 1: everything that can be outlined ----
      r.autoClear = true
      camera.layers.set(0)
      r.setRenderTarget(main)
      r.render(scene, camera)

      // ---- pass 2: FX layer + outline, on top ----
      const tanY = Math.tan((camera.fov * Math.PI) / 360) / camera.zoom
      ;(u.uNearFar!.value as THREE.Vector2).set(camera.near, camera.far)
      ;(u.uTanHalf!.value as THREE.Vector2).set(tanY * camera.aspect, tanY)
      ;(u.uUpView!.value as THREE.Vector3).copy(up.set(0, 1, 0).transformDirection(camera.matrixWorldInverse))
      u.uPxPerM!.value = (0.5 * H) / tanY
      u.uWidth!.value = s.outlineWidth
      ;(u.uStep!.value as THREE.Vector2).set(s.outlineStep[0], s.outlineStep[1])
      ;(u.uFade!.value as THREE.Vector2).set(s.outlineFade[0] * zoom, s.outlineFade[1] * zoom)
      ;(u.uColor!.value as THREE.Vector4).w = s.outlineOpacity
      outlineMesh.visible = s.outlineOpacity > 0
      // a Color background forces a clear even with autoClear = false, so take it away for this pass
      const background = scene.background
      scene.background = null
      r.autoClear = false
      camera.layers.set(FX_LAYER)
      r.render(scene, camera)
      camera.layers.mask = mask
      scene.background = background

      // ---- pass 3: bloom ----
      const bloomOn = s.bloom > 0
      if (bloomOn) {
        r.autoClear = false
        ;(brightMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / W, 1 / H)
        ;(brightMat.uniforms.uThreshold!.value as THREE.Vector2).set(s.bloomThreshold[0], s.bloomThreshold[1])
        pass(brightMat, mips[0]!)
        for (let i = 1; i < mips.length; i++) {
          const src = mips[i - 1]!
          downMat.uniforms.tMap!.value = src.texture
          ;(downMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / src.width, 1 / src.height)
          pass(downMat, mips[i]!)
        }
        for (let i = mips.length - 1; i > 0; i--) {
          const src = mips[i]!
          upMat.uniforms.tMap!.value = src.texture
          ;(upMat.uniforms.uTexel!.value as THREE.Vector2).set(0.5 / src.width, 0.5 / src.height)
          pass(upMat, mips[i - 1]!)
        }
      }

      // ---- pass 4: composite to the canvas ----
      finalMat.uniforms.uBloom!.value = bloomOn ? s.bloom : 0
      ;(finalMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / W, 1 / H)
      finalMat.uniforms.uFxaa!.value = s.fxaa ? 1 : 0
      ;(finalMat.uniforms.uVignette!.value as THREE.Vector3).set(s.vignette, s.vignetteRange[0], s.vignetteRange[1])
      ;(finalMat.uniforms.uVigShape!.value as THREE.Vector3).set(s.vignetteShape[0], s.vignetteShape[1], s.vignetteShape[2])
      pass(finalMat, prevTarget)
      r.autoClear = autoClear
    },
    compile(r, scene, camera) {
      // a program depends on the output colour space, so the scene is compiled for the target it is drawn into
      const prevTarget = r.getRenderTarget()
      r.setRenderTarget(main)
      const linked = [r.compileAsync(scene, camera)]
      r.setRenderTarget(prevTarget)
      for (const m of [brightMat, downMat, upMat, finalMat]) {
        fsMesh.material = m
        linked.push(r.compileAsync(fsScene, fsCam))
      }
      return Promise.all(linked)
    },
    dispose() {
      main.dispose()
      depthTexture.dispose()
      for (const m of mips) m.dispose()
      tri.dispose()
      for (const m of [outlineMat, brightMat, downMat, upMat, finalMat]) m.dispose()
    },
  }
  return post
}
