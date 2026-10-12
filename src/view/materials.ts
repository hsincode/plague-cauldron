// Shared material factory so every model has the same shading model and materials are reused (fewer programs).
// Look: stylised low-poly, matte Lambert shading with flat facets by default; glossy Phong for balls/bubbles/flasks;
// unlit for UI decals, glows and emissive things. Outlines are a post-process (view/post.ts), not per-material.
import * as THREE from 'three'

/**
 * `instanced: true` asks for a separate instance of the material for InstancedMesh users: three.js re-resolves the
 * shader program each time one material alternates between instanced and plain draws within a frame.
 */
type Shared = { map?: THREE.Texture | null; instanced?: boolean }
type LamOpts = Shared & { flat?: boolean; emissive?: number; emissiveIntensity?: number; side?: THREE.Side; transparent?: boolean; opacity?: number; vertexColors?: boolean }
type GlossOpts = LamOpts & { shininess?: number; specular?: number }
type UnlitOpts = Shared & { transparent?: boolean; opacity?: number; additive?: boolean; side?: THREE.Side; depthWrite?: boolean; depthTest?: boolean; fog?: boolean; vertexColors?: boolean }

const cache = new Map<string, THREE.Material>()
// the texture goes in by uuid: JSON.stringify would call Texture.toJSON, which encodes the whole canvas as a PNG
const key = (kind: string, color: number, o: Shared) => kind + color.toString(16) + JSON.stringify({ ...o, map: o.map?.uuid })

/** Matte material (the default for everything solid). Flat-shaded unless { flat: false }. */
export function lam(color: number, o: LamOpts = {}): THREE.MeshLambertMaterial {
  const k = key('lam', color, o)
  let m = cache.get(k) as THREE.MeshLambertMaterial | undefined
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color,
      flatShading: o.flat ?? true,
      emissive: o.emissive ?? 0x000000,
      emissiveIntensity: o.emissiveIntensity ?? 1,
      side: o.side ?? THREE.FrontSide,
      transparent: o.transparent ?? false,
      opacity: o.opacity ?? 1,
      vertexColors: o.vertexColors ?? false,
      map: o.map ?? null,
    })
    cache.set(k, m)
  }
  return m
}

/** Glossy material with a specular highlight (balls, bubbles, flasks, metal). Smooth-shaded unless { flat: true }. */
export function gloss(color: number, o: GlossOpts = {}): THREE.MeshPhongMaterial {
  const k = key('gloss', color, o)
  let m = cache.get(k) as THREE.MeshPhongMaterial | undefined
  if (!m) {
    m = new THREE.MeshPhongMaterial({
      color,
      flatShading: o.flat ?? false,
      shininess: o.shininess ?? 60,
      specular: o.specular ?? 0xffffff,
      emissive: o.emissive ?? 0x000000,
      emissiveIntensity: o.emissiveIntensity ?? 1,
      side: o.side ?? THREE.FrontSide,
      transparent: o.transparent ?? false,
      opacity: o.opacity ?? 1,
      vertexColors: o.vertexColors ?? false,
      map: o.map ?? null,
    })
    cache.set(k, m)
  }
  return m
}

/** Unlit material (UI decals, glows, emissive liquids, coins in flight). */
export function unlit(color: number, o: UnlitOpts = {}): THREE.MeshBasicMaterial {
  const k = key('unlit', color, o)
  let m = cache.get(k) as THREE.MeshBasicMaterial | undefined
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color,
      transparent: o.transparent ?? (o.additive || (o.opacity ?? 1) < 1 || !!o.map),
      opacity: o.opacity ?? 1,
      blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: o.side ?? THREE.FrontSide,
      depthWrite: o.depthWrite ?? !(o.additive || (o.opacity ?? 1) < 1),
      depthTest: o.depthTest ?? true,
      fog: o.fog ?? true,
      map: o.map ?? null,
      vertexColors: o.vertexColors ?? false,
    })
    cache.set(k, m)
  }
  return m
}

/** Convenience: mesh with position/rotation/scale set, added to a parent. */
export function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, parent?: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat)
  m.position.set(x, y, z)
  parent?.add(m)
  return m
}

/** Soft round blob-shadow decal (the game has no crisp cast shadows, SPEC 7.3). Lies flat at y = 0.015. */
let blobTex: THREE.Texture | null = null
export function blobShadow(w: number, d = w, opacity = 0.45): THREE.Mesh {
  if (!blobTex) {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')!
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    grad.addColorStop(0, 'rgba(10,14,24,1)')
    grad.addColorStop(0.55, 'rgba(10,14,24,0.55)')
    grad.addColorStop(1, 'rgba(10,14,24,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 64)
    blobTex = new THREE.CanvasTexture(c)
    blobTex.colorSpace = THREE.SRGBColorSpace
  }
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  )
  m.rotation.x = -Math.PI / 2
  m.position.y = 0.015
  m.renderOrder = 1
  return m
}

/** Entry shown in the model gallery (gallery.html) so models can be inspected and screenshotted in isolation. */
export interface GalleryItem {
  name: string
  /** Build a fresh instance standing on y = 0 at the origin. */
  make: () => THREE.Object3D
  /** Approximate footprint radius in metres (camera framing). */
  size: number
  /** Optional per-frame animation for the gallery (t = seconds). */
  animate?: (obj: THREE.Object3D, t: number) => void
}
