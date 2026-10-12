// Contract between main.ts and the view modules that bind models to the live simulation state.
import type * as THREE from 'three'
import type { GameEvent } from '../sim/events'
import type { GameState } from '../sim/types'
import type { Hud } from '../ui/hud'
import type { Anchors } from './anchors'
import type { CameraDirector } from './cameraDirector'
import type { Fx } from './fx'
import type { Stage } from './stage'

export interface ViewCtx {
  stage: Stage
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /** Shared particle system (already added to the scene and updated by main.ts). */
  fx: Fx
  /** Camera rig: shake(), pans; view modules may call director.shake(...) for impacts they own. */
  director: CameraDirector
  /** DOM element of the 9:16 game frame (overlays are positioned inside it). */
  frame: HTMLElement
  hud: Hud | null
  /** Shared attachment points (doctor's back, porter's carry point); see view/anchors.ts. */
  anchors: Anchors
  /** Project a world position to CSS pixels inside the frame (for effects that fly to the HUD). */
  toScreen(x: number, y: number, z: number, out: { x: number; y: number }): { x: number; y: number }
  /** Inverse: world point on the plane y = h under a frame pixel (for coin ribbons ending at the HUD). */
  fromScreen(px: number, py: number, h: number, out: THREE.Vector3): THREE.Vector3
}

export interface ViewModule {
  /** Called once per rendered frame after the simulation advanced. dt = real frame time, time = seconds since start. */
  update(s: GameState, dt: number, time: number): void
  /** Called for every simulation event of this frame, in order, BEFORE update(). */
  onEvent?(e: GameEvent, s: GameState): void
}
