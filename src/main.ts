// Application shell: frame sizing, start/win overlays, the main loop and the debug API.
//
// URL parameters (for testing): ?debug=1 primitive debug view, ?nostart=1 skip the title, ?autoplay=1 the bot plays,
// ?ff=<seconds> fast-forward that many simulated seconds with the bot first, ?seed=<n>, ?speed=<multiplier>,
// ?wide=1 fill the window instead of the 9:16 frame, ?mute=1, ?quality=low|high|auto (see the resolution scale).
// Development only: ?views=river,coins (only these view modules), ?unlock=nurses,usher|all, ?gold=<n>, ?potion=<n>,
// ?flasks=<n>, ?cam=x,z[,zoom] (camera held there), ?dev=1 (P pauses). See window.__game at the bottom.
import * as THREE from 'three'
import { createAudio } from './audio/sfx'
import { P, UNLOCKS, type UnlockId } from './config'
import { botInput } from './sim/bot'
import { createState } from './sim/state'
import { advance, step } from './sim/step'
import type { GameState, Input } from './sim/types'
import { createHud, type HudData } from './ui/hud'
import { createInput } from './ui/input'
import { createAnchors, defaultAnchors } from './view/anchors'
import { createCameraDirector } from './view/cameraDirector'
import { createDebugView } from './view/debugView'
import { createEnv } from './view/env'
import { createFx } from './view/fx'
import { createViews } from './view/index'
import { createStage } from './view/stage'
import type { ViewCtx, ViewModule } from './view/types'

const q = new URLSearchParams(location.search)
const app = document.getElementById('app') as HTMLElement
const frame = document.getElementById('frame') as HTMLElement
const canvas = document.getElementById('c') as HTMLCanvasElement
const titleEl = document.getElementById('title') as HTMLElement
const winEl = document.getElementById('win') as HTMLElement
const startBtn = document.getElementById('start') as HTMLButtonElement
const muteBtn = document.getElementById('mute') as HTMLElement

/** The game cannot go on: say so on the title card instead of leaving a blank or frozen page. */
function fail(message: string) {
  winEl.hidden = true
  titleEl.hidden = false
  titleEl.classList.remove('out')
  startBtn.hidden = true
  titleEl.querySelector('.help')!.textContent = message
}
// until the first frame is due, anything that throws (no WebGL2, above all) is a failed start
const bootFailed = () => fail('起動できませんでした。WebGL2 が使えるブラウザで開いてください。')
addEventListener('error', bootFailed)

const qualityParam = q.get('quality')
/**
 * Whether the resolution scale below may lower the picture. ?quality=low|high pins it, and so does an automated
 * browser, whose captures must not depend on how busy the machine is (?quality=auto adapts there too).
 */
let adaptive = qualityParam ? qualityParam === 'auto' : !navigator.webdriver
let wide = q.get('wide') === '1'
const stage = createStage(canvas, qualityParam === 'low' ? 'low' : 'high')

/**
 * Drawing-buffer pixels allowed. The render targets take about 100 bytes per pixel, too much for a tablet or a wide
 * 4K window at full size.
 */
const PIXEL_BUDGET = 3e6
/** A 9:16 frame narrower than this (a phone held sideways, a short window) is too small to play: the window is filled instead. */
const MIN_FRAME_WIDTH = 280
/** Pixel-ratio factors of the resolution scale; one level past the last is quality 'low'. */
const SCALE = [1, 0.75, 0.5]
let scaleLevel = 0
/** devicePixelRatio the frame was last laid out for. */
let laidOutFor = 0

function layout() {
  laidOutFor = devicePixelRatio
  const W = innerWidth
  const H = innerHeight
  const w9 = Math.round((H * 9) / 16)
  const w = wide || (w9 < MIN_FRAME_WIDTH && w9 < W) ? W : Math.min(W, w9)
  frame.style.width = `${w}px`
  frame.style.height = `${H}px`
  const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(PIXEL_BUDGET / (w * H)))
  stage.resize(w, H, ratio * SCALE[Math.min(scaleLevel, SCALE.length - 1)]!)
}
addEventListener('resize', layout)
layout()

const state = createState(Number(q.get('seed') ?? 1) || 1)
const fx = createFx()
stage.scene.add(fx.root)
const director = createCameraDirector(stage)
const hud = createHud(frame)
const audio = createAudio()
if (q.get('mute') === '1') audio.setMuted(true)

const ndc = new THREE.Vector3()
const ndc2 = new THREE.Vector2()
const ray = new THREE.Raycaster()
const ctx: ViewCtx = {
  stage,
  scene: stage.scene,
  camera: stage.camera,
  fx,
  director,
  frame,
  hud,
  anchors: createAnchors(),
  toScreen(x, y, z, out) {
    ndc.set(x, y, z).project(stage.camera)
    out.x = (ndc.x * 0.5 + 0.5) * frame.clientWidth
    out.y = (-ndc.y * 0.5 + 0.5) * frame.clientHeight
    return out
  },
  fromScreen(px, py, h, out) {
    ray.setFromCamera(ndc2.set((px / frame.clientWidth) * 2 - 1, -(py / frame.clientHeight) * 2 + 1), stage.camera)
    const t = (h - ray.ray.origin.y) / ray.ray.direction.y
    return out.copy(ray.ray.origin).addScaledVector(ray.ray.direction, t)
  },
}

// --- warm-up ---
// The views build some models only when the state first needs them (the cart, the spare scoop, the nurses, a bubble),
// and three.js compiles a shader program when its material is first drawn: both would cost frames at the unlocks. So
// the views are first shown a throwaway state with everything unlocked, and the stage compiles every program before
// the first frame (see the bottom of this file). That state's clock is far in the past, which makes the first real
// frame a jump for the views, as after __game.skip().
function warmState(): GameState {
  const w = createState()
  w.time = -1000
  w.bubbleSpawnT = 0
  for (const u of UNLOCKS) w.unlocks[u.id] = true
  // one step: the owning systems apply the unlocks (staff, cart, spare scoop, ward 2) and a bubble spawns
  step(w, { mx: 0, mz: 0 }, 1 / 60)
  return w
}

const debug = q.get('debug') === '1'
const env = debug ? null : createEnv(stage.scene)
let views: ViewModule[] = debug ? [] : createViews(ctx, q.get('views')?.split(','), warmState())
if (views.length === 0) views = [createDebugView(ctx)]

const inputSrc = createInput(app)
const input: Input = { mx: 0, mz: 0 }
const autoplay = q.get('autoplay') === '1'
const speed = Number(q.get('speed') ?? 1) || 1
let started = q.get('nostart') === '1' || autoplay
/** state.time at which the player took over: the time spent on the title screen is not play time. */
let startedAt = 0
let ready = false
let paused = false
inputSrc.enabled = started

// --- development cheats (also on window.__game.cheat) ---
/** Scripted stick: when set it replaces the keyboard / touch / bot input. World-space direction, length <= 1. */
let drive: Input | null = null
/** Camera held by ?cam= / __game.lookAt(); the director is not updated while it is set. */
let freeCam = false
const cheat = {
  gold(n: number) {
    state.wallet += n
    state.player.carriedGold += n
    state.stats.totalGold += n
  },
  /** Sets the unlock flag (the owning systems react on the next step) and fires the 'unlock' event for the VFX. */
  unlock(id: UnlockId | 'all') {
    for (const u of UNLOCKS) {
      if ((id !== 'all' && u.id !== id) || state.unlocks[u.id]) continue
      state.unlocks[u.id] = true
      state.events.push({ type: 'unlock', id: u.id, x: u.x, z: u.z })
    }
  },
  potion(n: number) {
    state.cauldron.potion = Math.min(state.cauldron.capacity, n)
  },
  flasks(n: number) {
    state.player.flasks = n
  },
  /** Teleports the doctor (and whatever he holds follows on the next step). */
  tp(x: number, z: number) {
    state.player.x = x
    state.player.z = z
  },
  /** Holds the stick at (mx, mz) in world space (+x east, +z south); drive() releases it. */
  drive(mx?: number, mz?: number) {
    drive = mx === undefined ? null : { mx, mz: mz ?? 0 }
  },
}
for (const id of q.get('unlock')?.split(',') ?? []) cheat.unlock(id as UnlockId)
if (q.has('gold')) cheat.gold(Number(q.get('gold')))

const ff = Number(q.get('ff') ?? 0)
if (ff > 0) {
  const n = Math.round(ff * 60)
  for (let i = 0; i < n && !state.won; i++) {
    step(state, botInput(state), 1 / 60)
    state.events.length = 0
  }
}
if (q.has('potion')) cheat.potion(Number(q.get('potion')))
if (q.has('flasks')) cheat.flasks(Number(q.get('flasks')))
director.snap(state)
director.update(state, input, 0)
const camQ = q.get('cam')?.split(',').map(Number)
if (camQ && camQ.length >= 2) {
  freeCam = true
  stage.setTarget(camQ[0]!, camQ[1]!)
  stage.setZoom(camQ[2] ?? 1)
}

function start() {
  if (started || !ready) return
  started = true
  startedAt = state.time
  inputSrc.enabled = true
  audio.resume()
  titleEl.classList.add('out')
  setTimeout(() => (titleEl.hidden = true), 400)
}
if (started) titleEl.hidden = true
startBtn.addEventListener('click', start)
document.getElementById('again')!.addEventListener('click', () => location.reload())
muteBtn.addEventListener('click', () => {
  audio.resume()
  audio.setMuted(!audio.muted)
  muteBtn.classList.toggle('off', audio.muted)
  muteBtn.blur() // the keyboard stays with the game
})
muteBtn.classList.toggle('off', audio.muted)
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.repeat) return
  if (e.code === 'Enter' || e.code === 'Space') {
    e.preventDefault() // these keys start the game even while a button has the focus; they must not also press it
    audio.resume()
    if (winEl.hidden) start()
    else location.reload()
  }
  if (e.code === 'KeyM') muteBtn.click()
  if (e.code === 'KeyF') {
    wide = !wide
    layout()
  }
  if (e.code === 'KeyR' && state.won) location.reload()
  if (e.code === 'KeyP' && q.has('dev')) paused = !paused
})
addEventListener('pointerdown', () => audio.resume(), { once: true })

// --- automatic resolution scale ---
// The frame time is averaged over WINDOW seconds. After a slow window the pixel ratio steps down through SCALE, and
// past its end the stage drops to quality 'low'. A step that does not shorten the frame is taken back and the scale
// stops adapting: the device is not held up by pixels then (a slow CPU, or a browser that caps the frame rate), so a
// blurrier picture would buy nothing. After FAST_HOLD seconds of fast windows it tries one level up again, once.
const WINDOW = 2
const SLOW = 1 / 45
const FAST = 1 / 55
const FAST_HOLD = 30
let windowT = 0
let windowFrames = 0
let fastT = 0
/** Average frame time of the window before the last step down, until that step has been judged (0 = nothing to judge). */
let before = 0
let retry = true

function setScaleLevel(n: number) {
  scaleLevel = n
  stage.setQuality(n < SCALE.length ? 'high' : 'low')
  layout()
}

/** gap = real time since the previous frame (seconds). */
function adapt(gap: number) {
  if (gap > 0.5) return // a pause (hidden tab, __game.skip), not a frame
  windowT += gap
  windowFrames++
  if (windowT < WINDOW) return
  const avg = windowT / windowFrames
  windowT = windowFrames = 0
  if (avg > SLOW) {
    fastT = 0
    const gained = before === 0 || avg < before * 0.9
    before = 0
    if (!gained) {
      adaptive = false
      setScaleLevel(scaleLevel - 1)
    } else if (scaleLevel < SCALE.length) {
      before = avg
      setScaleLevel(scaleLevel + 1)
    }
  } else {
    before = 0
    fastT = avg < FAST ? fastT + WINDOW : 0
    if (fastT >= FAST_HOLD && scaleLevel > 0 && retry) {
      retry = false
      setScaleLevel(scaleLevel - 1)
    }
  }
}

const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
const hudData: HudData = { coins: 0, discharged: 0, total: P.TOTAL_VILLAGERS, flasks: 0, potion: 0, potionCap: 0, level: 1, totalGold: 0 }
function showHud() {
  hudData.coins = state.wallet
  hudData.discharged = state.stats.discharged
  hudData.flasks = state.player.flasks
  hudData.potion = state.cauldron.potion
  hudData.potionCap = state.cauldron.capacity
  hudData.level = 1
  for (const u of UNLOCKS) if (state.unlocks[u.id]) hudData.level++
  hudData.totalGold = state.stats.totalGold
  hud.set(hudData)
}
showHud() // the numbers are there while the programs still compile
/** Frames in a row that threw before they were finished. */
let failing = 0
let winShown = false
let last = 0
let time = 0
let frames = 0

function frameLoop(now: number) {
  // A frame that throws never reaches the reset at the bottom. The next frame is asked for first, so one bad frame
  // costs one frame; when every frame fails the loop ends with a message instead of a frozen picture.
  if (++failing > 30) return fail('エラーが発生しました。ページを再読み込みしてください。')
  requestAnimationFrame(frameLoop)
  // the first rAF timestamp can predate `last`: never step backwards
  const gap = Math.max(0, (now - last) / 1000)
  const dt = Math.min(0.1, gap)
  last = now
  // the ratio can change without a 'resize' (the window dragged to another monitor)
  if (devicePixelRatio !== laidOutFor) {
    layout()
    hud.layout()
  }
  if (!paused) {
    time += dt
    if (drive) {
      input.mx = drive.mx
      input.mz = drive.mz
    } else if (autoplay) {
      const b = botInput(state)
      input.mx = b.mx
      input.mz = b.mz
    } else inputSrc.read(input)
    advance(state, input, dt * speed)
    for (const e of state.events) {
      director.onEvent(e)
      audio.onEvent(e, state)
      for (const v of views) v.onEvent?.(e, state)
    }
    state.events.length = 0
    if (!freeCam) director.update(state, input, dt)
    env?.update(state, dt, time)
    defaultAnchors(ctx.anchors, state)
    for (const v of views) v.update(state, dt, time)
    fx.update(dt)
    audio.update(state, dt)
    showHud()
    if (state.won && !winShown) {
      winShown = true
      inputSrc.enabled = false
      setTimeout(() => {
        document.getElementById('win-stats')!.textContent = `${fmtTime(state.wonAt - startedAt)} ・ ${state.stats.totalGold.toLocaleString()} G`
        winEl.hidden = false
      }, 2500)
    }
  }
  stage.render(dt)
  if (adaptive && time > WINDOW) adapt(gap) // not the first seconds: start-up is slow on any device
  frames++
  failing = 0
}

// The first frame waits until every shader program is linked: compiling happens off the main thread where the driver
// can, and nothing is left to compile when something first appears. The title card is already on screen (plain CSS).
stage.compile().then(() => {
  removeEventListener('error', bootFailed)
  ready = true
  startBtn.disabled = false
  last = performance.now()
  requestAnimationFrame(frameLoop)
})

// Debug API for automated tests (tools/shot.ts evaluates expressions against it).
Object.assign(window, {
  __game: {
    state,
    stage,
    ctx,
    fx,
    get frames() {
      return frames
    },
    director,
    audio,
    cheat,
    pause: (p = true) => (paused = p),
    /**
     * Advance the simulation headlessly by `seconds` with the bot (or the held drive() stick, or no input). The
     * events of the skipped steps are dropped, so views must be able to rebuild everything persistent from the state.
     */
    skip(seconds: number, useBot = true) {
      const n = Math.round(seconds * 60)
      for (let i = 0; i < n && !state.won; i++) {
        step(state, drive ?? (useBot ? botInput(state) : { mx: 0, mz: 0 }), 1 / 60)
        state.events.length = 0
      }
      if (!freeCam) director.snap(state)
    },
    /** Holds the camera on (x, z); follow() gives it back to the director. */
    lookAt(x: number, z: number, zoom = 1) {
      freeCam = true
      stage.setTarget(x, z)
      stage.setZoom(zoom)
    },
    follow() {
      freeCam = false
      director.snap(state)
    },
  },
})
