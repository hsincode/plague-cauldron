// Model gallery for look-dev and screenshot tests, independent of the simulation.
//
//   /gallery                       every item of every module in a grid
//   /gallery?m=doctor,staff        only these modules (file names in src/view/models or src/ui)
//   /gallery?i=cart                only items whose name contains "cart"
//   &view=game|front|back|side|top|close   camera (default game = the in-game camera direction)
//   &t=1.5                         freeze animation time (default: running clock)
//   &scene=env&cam=x,z&zoom=1      show the environment with the game camera looking at (x, z)
//   &gate=0..1&ward2=1&lantern=x,z environment state for scene=env
//   &hud=1&coins=300               mount the DOM HUD (any scene)
//   &ground=0                      hide the ground plane, &dark=1 no lantern (ambient only)
import * as THREE from 'three'
import { PAL, UNLOCKS, type UnlockId } from './config'
import type { GameState } from './sim/types'
import * as uiArrow from './ui/arrow'
import * as uiBubbles from './ui/bubbles'
import * as uiDecals from './ui/decals'
import * as uiIcons from './ui/icons'
import { createHud } from './ui/hud'
import * as envMod from './view/env'
import { createEnv } from './view/env'
import type { GalleryItem } from './view/materials'
import * as cauldron from './view/models/cauldron'
import * as coin from './view/models/coin'
import * as doctor from './view/models/doctor'
import * as drill from './view/models/drill'
import * as flask from './view/models/flask'
import * as furniture from './view/models/furniture'
import * as grinder from './view/models/grinder'
import * as rat from './view/models/rat'
import * as river from './view/models/river'
import * as staff from './view/models/staff'
import * as tools from './view/models/tools'
import * as villager from './view/models/villager'
import { createStage } from './view/stage'

const MODULES: Record<string, { GALLERY: GalleryItem[] }> = {
  doctor, villager, staff, rat, tools, river, grinder, flask, cauldron, furniture, coin, drill,
  icons: uiIcons, decals: uiDecals, bubbles: uiBubbles, arrow: uiArrow, env: envMod,
}

const q = new URLSearchParams(location.search)
const canvas = document.getElementById('c') as HTMLCanvasElement
const stage = createStage(canvas)
const { scene, camera } = stage
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d)
const pair = (k: string): [number, number] | null => {
  const v = q.get(k)?.split(',').map(Number)
  return v && v.length === 2 && v.every(Number.isFinite) ? [v[0]!, v[1]!] : null
}

const fit = () => stage.resize(innerWidth, innerHeight, Math.min(devicePixelRatio, 2))
addEventListener('resize', fit)
fit()

const animated: { item: GalleryItem; obj: THREE.Object3D }[] = []
const labels: { el: HTMLElement; pos: THREE.Vector3 }[] = []
let envUpdate: ((dt: number, t: number) => void) | null = null

if (q.get('scene') === 'env') {
  const env = createEnv(scene)
  const cam = pair('cam') ?? [0, 0]
  stage.setTarget(cam[0], cam[1])
  stage.setZoom(num('zoom', 1))
  const lan = pair('lantern') ?? cam
  stage.lantern.position.set(lan[0], 2.2, lan[1])
  const unlocks = Object.fromEntries(UNLOCKS.map(u => [u.id, q.get(u.id) === '1'])) as Record<UnlockId, boolean>
  const fake = { time: 0, unlocks, gate: { open: num('gate', 0), wantOpen: false, idleT: 0 }, villagers: [], cauldron: { potion: num('potion', 0), capacity: 10 } } as unknown as GameState
  if (env) envUpdate = (dt, t) => ((fake.time = t), env.update(fake, dt, t))
  else document.body.insertAdjacentHTML('beforeend', '<div class="lbl" style="left:50%;top:8px">createEnv() returned null (stub)</div>')
} else {
  if (q.get('ground') !== '0') {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshLambertMaterial({ color: PAL.dirt }))
    g.rotation.x = -Math.PI / 2
    scene.add(g)
  }
  const mods = q.get('m')?.split(',') ?? Object.keys(MODULES)
  const filter = q.get('i')
  const items: GalleryItem[] = []
  for (const m of mods) for (const it of MODULES[m]?.GALLERY ?? []) if (!filter || it.name.includes(filter)) items.push(it)
  // grid layout along world x (columns) and z (rows)
  let x = 0
  let z = 0
  let rowDepth = 0
  const maxRow = Math.max(12, Math.sqrt(items.reduce((a, it) => a + (it.size * 2 + 1.5) ** 2, 0)) * 1.3)
  const bounds = new THREE.Box3()
  for (const it of items) {
    const cell = it.size * 2 + 1.5
    if (x + cell > maxRow && x > 0) {
      x = 0
      z += rowDepth
      rowDepth = 0
    }
    const obj = it.make()
    obj.position.x += x + cell / 2
    obj.position.z += z + cell / 2
    scene.add(obj)
    bounds.expandByPoint(new THREE.Vector3(x, 0, z)).expandByPoint(new THREE.Vector3(x + cell, it.size * 2, z + cell))
    if (it.animate) animated.push({ item: it, obj })
    if (items.length > 1) {
      const el = document.createElement('div')
      el.className = 'lbl'
      el.textContent = it.name
      document.body.appendChild(el)
      labels.push({ el, pos: new THREE.Vector3(x + cell / 2, 0, z + cell * 0.95) })
    }
    x += cell
    rowDepth = Math.max(rowDepth, cell)
  }
  if (items.length === 0) document.body.insertAdjacentHTML('beforeend', '<div class="lbl" style="left:50%;top:8px">no gallery items match</div>')
  // camera
  const c = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3())
  const r = bounds.isEmpty() ? 5 : bounds.getSize(new THREE.Vector3()).length() / 2
  const view = q.get('view') ?? 'game'
  const dirs: Record<string, [number, number, number]> = {
    game: [-12.0, 15.8, 14.5], front: [0, 0.35, 1], back: [0, 0.35, -1], side: [1, 0.35, 0], top: [0, 1, 0.001], close: [-0.6, 0.5, 1],
  }
  const d = new THREE.Vector3(...(dirs[view] ?? dirs.game!)).normalize()
  const dist = (r / Math.sin((camera.fov * Math.PI) / 360)) * (camera.aspect < 1 ? 1 / camera.aspect : 1) * num('zoom', 0.62)
  camera.position.copy(c).addScaledVector(d, dist)
  camera.lookAt(c)
  camera.far = dist * 3 + 100
  camera.updateProjectionMatrix()
  stage.manualCamera = true
  if (scene.fog) (scene.fog as THREE.Fog).far = 1e6
  const lan = pair('lantern')
  if (q.get('dark') === '1') stage.lantern.intensity = 0
  stage.lantern.position.set(lan ? lan[0] : c.x - r * 0.3, 2.2 + r * 0.3, lan ? lan[1] : c.z + r * 0.5)
  stage.lantern.distance = Math.max(9, r * 4)
  stage.fireLight.intensity = 0
}

// &hud=1&coins=300 mounts the DOM HUD over the canvas
if (q.get('hud') === '1') {
  createHud(document.body)?.set({ coins: num('coins', 300), discharged: num('discharged', 31), total: 180, flasks: num('flasks', 5), potion: num('potion', 3), potionCap: 10, level: num('level', 3), totalGold: num('totalGold', 1250) })
}

const clock = new THREE.Clock()
const fixedT = q.has('t') ? Number(q.get('t')) : null
const v = new THREE.Vector3()
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1)
  const t = fixedT ?? clock.elapsedTime
  for (const a of animated) a.item.animate!(a.obj, t)
  envUpdate?.(dt, t)
  stage.render(dt)
  for (const l of labels) {
    v.copy(l.pos).project(camera)
    l.el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`
    l.el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`
  }
  ;(window as unknown as { __frames: number }).__frames = ((window as unknown as { __frames: number }).__frames ?? 0) + 1
  requestAnimationFrame(frame)
}
frame()
