// Sound: binds the simulation to a synthesised soundscape (SPEC section 10). WebAudio only, no asset files.
//
// Events trigger one-shots (audio/sounds.ts). Everything continuous is derived from the state in update(): the
// beds (audio/beds.ts), the footsteps (player.odo), the counter ticks (wallet), the payment ticks (pads), the ward
// doors and the healed chord (treatment clocks), so nothing depends on the events that __game.skip() drops. World
// sounds are attenuated by their distance to the doctor and panned by their place on screen; dense events go
// through per-sound rate limiters (Mixer.free).
//
// The AudioContext is created once resume() has been called and the browser counts a gesture (see wake()). Until
// then, and whenever the context is not running, events are dropped rather than queued, so nothing can burst when
// sound starts. The gesture itself only opens the context: the loop buffers are rendered before it (audio/loops.ts)
// and the graph is built on the next frame. A throw anywhere in here disables the sound and never reaches the game
// loop.
//
// createAudio().debug (window.__game.audio.debug) is for measuring: the live context, its output node (tap it with
// an AnalyserNode) and an offline render of the same graph (see AudioDebug).
import { BEDS, L, P } from '../config'
import { BURSAR_RATE } from '../sim/economy'
import type { GameEvent } from '../sim/events'
import type { GameState } from '../sim/types'
import { inRiverBed } from '../world/river'
import { createBeds } from './beds'
import { type Loops, createLoops } from './loops'
import { type Mixer, createMixer } from './mixer'
import { createMusic } from './music'
import * as snd from './sounds'

export interface Audio {
  /** Must be called from a user gesture to start the AudioContext. */
  resume(): void
  setMuted(muted: boolean): void
  readonly muted: boolean
  onEvent(e: GameEvent, s: GameState): void
  /** Per-frame update for continuous sounds (river, fire, footsteps, cart rumble, grinding). */
  update(s: GameState, dt: number): void
}

/** The sound of one context: what createAudio() drives live and AudioDebug.render() drives offline. */
export interface Engine {
  readonly mixer: Mixer
  onEvent(e: GameEvent, s: GameState): void
  update(s: GameState, dt: number): void
}

export interface AudioDebug {
  /** Null until the first resume(). */
  readonly ctx: AudioContext | null
  /** Last node before the destination. */
  readonly out: AudioNode | null
  /**
   * Renders `seconds` of the same graph in an OfflineAudioContext. `script` fills the timeline before rendering:
   * set engine.mixer.lead = t and call engine.onEvent() to place an event at t, or use at(t, fn) to run fn (state
   * pokes, engine.update()) when the render reaches t.
   */
  render(seconds: number, script: (engine: Engine, at: (t: number, fn: () => void) => void) => void): Promise<AudioBuffer>
}

/** One footfall per half stride of the doctor model (view/models/doctor.ts D_STRIDE = 1.3 m). */
const STEP_LENGTH = 0.65
/** A larger jump of the simulated clock between two frames is a skip or a restart: resynchronise silently. */
const MAX_SIM_STEP = 0.5
/**
 * Counter and payment ticks per second while gold is counted, laid on the audio clock (frame times would jitter).
 * The ad ticks once per coin, 13 to 45 ms apart: the gaps are scattered round the mean the same way (tickGap).
 */
const TICK_RATE = 44
/** Ticks are scheduled this far ahead: a little more than a frame. */
const TICK_AHEAD = 0.03
/** The pickup counts as streaming for this long after its last coin (the wallet does not rise on every frame). */
const STREAM_HOLD = 0.08
/**
 * Treatment time at which the healed chord starts: as the pie closes, 0.2 s before the check mark (in the ad the
 * chord comes in at 22.68 s and the check at 22.87 s).
 */
const HEAL_AT = P.TREATMENT_TIME - 0.2
/** From the first rat under the cone to the heap at rest: the rest of the push, then the burst (sim/drill.ts). */
const MASSACRE_TIME = P.DRILL_PUSH_TIME - P.DRILL_KILL_START + P.DRILL_COIN_FOUNTAIN
/** Swing times of the ward doors (sim/ward.ts DOOR_OPEN_TIME / DOOR_CLOSE_TIME). */
const DOOR_OPEN = 0.2
const DOOR_CLOSE = 0.35
/** Squeaks per second from a full swarm heard at its centre. */
const RAT_SQUEAKS = 1.2
const RAT_FIELD = { x: (L.RAT_FIELD[0] + L.RAT_FIELD[2]) / 2, z: (L.RAT_FIELD[1] + L.RAT_FIELD[3]) / 2 }

const tickGap = (m: Mixer) => (0.6 + 0.8 * m.rnd()) / TICK_RATE

const inRect = (r: readonly [number, number, number, number], x: number, z: number) => x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]

function surfaceAt(s: GameState, x: number, z: number): snd.Surface {
  if (inRiverBed(x, z)) return 'beads'
  if (inRect(L.WARD1, x, z) || (s.unlocks.ward2 && inRect(L.WARD2, x, z))) return 'plank'
  if (inRect(L.COURTYARD, x, z)) return 'tile'
  return 'dirt'
}

export function createEngine(ctx: BaseAudioContext, loops: Loops, muted = false): Engine {
  const m = createMixer(ctx, loops, muted)
  const beds = createBeds(m)
  const music = createMusic(m)
  // fixed outputs of the streams that belong to the doctor or the HUD
  const stepOut = m.to('sfx', 0.4)
  const stackOut = m.to('glass', 0.9)
  const tickOut = m.to('coin', 0.55)

  let primed = false
  let lastTime = 0
  let lastStep = 0
  let leftFoot = false
  let lastWallet = 0
  let streamT = 0
  let nextTick = 0
  let nextPayTick = 0
  /** Treatment clock of every bed on the last frame. */
  const treatT = new Float64Array(BEDS.length)
  // ward doors, south then north: how far open and which way they moved on the last frame
  const doorOpen = [0, 0]
  const doorDir = [0, 0]

  return {
    mixer: m,

    onEvent(e, s) {
      const pl = s.player
      m.setListener(pl.x, pl.z)
      const t = m.now()
      switch (e.type) {
        // --- tools and river ---
        case 'toolGrab':
          if (e.kind === 'scoop' && m.free('knock', t, 0.1)) snd.knock(m, m.to('sfx', 0.5), t, 1.25)
          break
        case 'toolPark':
          if (m.free('knock', t, 0.1)) snd.knock(m, m.at('sfx', e.x, e.z, 0.5), t, 0.85)
          break
        case 'cartMount':
          // he lands on the bench at the end of the hop
          snd.knock(m, m.to('sfx', 0.7), t + P.CART_MOUNT_TIME, 0.7)
          break
        case 'cartDismount':
          snd.footstep(m, m.to('sfx', 0.6), t + P.CART_DISMOUNT_TIME, 'dirt', 1)
          break
        case 'toolSwap':
          if (m.free('build', t, 0.5)) snd.build(m, m.at('sfx', e.x, e.z, 1, 0.3), t)
          break
        case 'bubbleDock':
          if (m.free('dock', t, 0.1)) snd.dock(m, m.at('sfx', e.x, e.z), t, e.r)
          break
        case 'bubbleReject':
          if (m.free('reject', t, 0.25)) snd.reject(m, m.at('sfx', e.x, e.z), t)
          break
        case 'bubbleFall':
          if (m.free('fall', t, 0.3)) snd.fall(m, m.at('sfx', e.x, e.z, 0.6), t)
          break

        // --- grinder and flasks ---
        case 'grindStart':
          snd.grindStart(m, m.at('glass', e.x, e.z), t)
          break
        case 'grindCrack':
          if (m.free('crack', t, 0.1)) snd.crack(m, m.at('glass', e.x, e.z), t, e.r)
          break
        case 'grindShell':
          snd.shell(m, m.at('glass', e.x, e.z), t, e.r)
          break
        case 'grindShatter':
          if (m.free('shatter', t, 0.2)) snd.shatter(m, m.at('glass', e.x, e.z), t, e.r)
          break
        case 'flaskEject':
          if (m.free('eject', t, 0.03)) snd.eject(m, m.at('glass', e.fromX, e.fromZ, 0.8), t)
          if (m.free('ting', t, 0.22)) snd.ting(m, m.at('glass', e.toX, e.toZ), t + P.FLASK_EJECT_FLIGHT)
          break
        case 'flaskPickup':
          if (e.by === 'player') {
            if (m.free('pickup', t, 0.028)) snd.pickup(m, stackOut, t, pl.flasks, e.unitAdded)
          } else if (m.free('pickupFar', t, 0.05)) snd.pickup(m, m.at('glass', s.porter.x, s.porter.z, 0.6), t, s.porter.flasks, e.unitAdded)
          break
        case 'flaskThrow':
          if (m.free('throw', t, 0.05)) snd.toss(m, m.at('sfx', e.fromX, e.fromZ, 0.8), t)
          break
        case 'flaskLand':
          if (m.free('plop', t, 0.045)) snd.plop(m, m.at('sfx', L.CAULDRON.x, L.CAULDRON.z), t, e.potion / s.cauldron.capacity)
          break

        // --- crowd and bath ---
        case 'gateOpen':
        case 'gateClose':
          if (m.free('gate', t, 0.2)) snd.gate(m, m.at('sfx', L.PEN_GATE.x, L.PEN_GATE.z, 0.7), t, P.GATE_SWING_TIME, e.type === 'gateOpen')
          break
        case 'villagerRelease':
          // the sick-face bubble that pops over him at the gate
          if (m.free('bubble', t, 0.1)) snd.bubblePop(m, m.at('ui', L.PEN_GATE.x, L.PEN_GATE.z, 0.7), t, 520 * m.detune(200), 0.25)
          break
        case 'bathHopIn':
          if (m.free('hop', t, 0.05)) snd.hopIn(m, m.at('sfx', L.CAULDRON.x, L.CAULDRON.z), t)
          break
        case 'bathSplash':
          if (m.free('splash', t, 0.2)) {
            snd.splash(m, m.at('sfx', L.CAULDRON.x, L.CAULDRON.z), t, e.count > P.BATH_SLOTS ? 1.25 : 1)
            snd.shimmer(m, m.at('ui', L.CAULDRON.x, L.CAULDRON.z, 1, 0.3), t + 0.05, P.BATH_CURE)
          }
          break
        case 'bathCured':
          if (m.free('cure', t, 0.2)) snd.cured(m, m.at('ui', L.CAULDRON.x, L.CAULDRON.z, 1, 0.3), t)
          break
        case 'bathHopOut':
          if (m.free('exit', t, 0.06)) snd.hopOut(m, m.at('sfx', L.CAULDRON.x, L.CAULDRON.z, 0.8), t)
          break
        case 'coinFountain':
          // the fountains of one batch overlap: the first sounds in full, the others only thicken it
          snd.fountain(m, m.at('coin', e.x, e.z), t, e.duration, m.free('fountain', t, 0.3) ? 0.5 : 0.2)
          if (m.free('clink', t, 0.3)) snd.clinks(m, m.at('coin', L.PALLET.x, L.PALLET.z), t + P.COIN_FLIGHT, e.duration)
          break

        // --- ward ---
        case 'patientLie':
          if (m.free('lie', t, 0.08)) snd.lie(m, m.at('sfx', BEDS[e.bed]!.x, BEDS[e.bed]!.z), t)
          break
        case 'needsNurse':
          if (m.free('bubble', t, 0.1)) snd.needNurse(m, m.at('ui', BEDS[e.bed]!.x, BEDS[e.bed]!.z, 1, 0.15), t)
          break
        case 'treatStart':
          if (m.free('bubble', t, 0.1)) snd.bubblePop(m, m.at('ui', BEDS[e.bed]!.x, BEDS[e.bed]!.z, 0.7), t, 740 * m.detune(200), 0.25)
          break
        case 'treatJab':
          if (m.free('jab', t, 0.08)) snd.jab(m, m.at('sfx', BEDS[e.bed]!.x + L.NURSE_POST.x, BEDS[e.bed]!.z + L.NURSE_POST.z), t)
          break
        case 'healed':
          // the chord is under way already (see update()); he sits up with a fist in the air a moment later
          if (m.free('cheer', t, 0.15)) snd.cheer(m, m.at('voice', e.x, e.z), t + P.TREAT_SIT_UP - P.TREATMENT_TIME, (e.id * 0.618) % 1)
          break
        case 'nursesSpawn':
          if (m.free('patter', t, 0.5)) snd.patter(m, m.at('sfx', e.x, e.z, 1, 0.2), t + 0.2, 10)
          break
        case 'discharged':
          if (m.free('count', t, 0.1)) snd.count(m, m.to('ui'), t)
          break

        // --- drill ---
        case 'drillCrewJoin':
          if (m.free('crew', t, 0.1)) snd.clank(m, m.at('sfx', L.DRILL_HANDLE.x, L.DRILL_HANDLE.z), t)
          break
        case 'drillPush':
          snd.drillPush(m, m.at('sfx', s.drill.x, s.drill.z, 1, 0.25), t, P.DRILL_PUSH_TIME)
          break
        case 'drillKill':
          if (m.free('drill', t, 0.5)) snd.massacre(m, m.at('sfx', e.x, e.z, 1, 0.3), t, MASSACRE_TIME)
          break
        case 'drillHeapLift':
          snd.sweep(m, m.to('coin'), t, P.DRILL_FLY_TO_HUD)
          break
        case 'drillPaid':
          if (m.free('cash', t, 0.2)) snd.payout(m, m.to('coin'), t, e.gold > P.DRILL_REWARD)
          break
        case 'swarmReady':
          snd.chitter(m, m.at('sfx', RAT_FIELD.x, RAT_FIELD.z, 0.6), t)
          break

        // --- economy ---
        case 'coinPickupEnd':
          if (e.gold > 0 && m.free('cash', t, 0.2)) snd.cash(m, m.to('coin'), t)
          break
        case 'bursarCollect':
          snd.sweep(m, m.to('coin', 0.6), t, Math.min(1.2, e.gold / BURSAR_RATE))
          break
        case 'padPop':
          if (m.free('padPop', t, 0.15)) snd.padPop(m, m.at('ui', e.x, e.z, 1, 0.45), t)
          break
        case 'padPaid':
          if (m.free('fanfare', t, 0.6)) {
            snd.confirm(m, m.to('ui'), t)
            snd.fanfare(m, m.at('ui', e.x, e.z, 1, 0.6), t + 0.1)
            m.duck(0.4, 1.7)
          }
          break
        case 'unlock':
          // bought on a pad: the fanfare is already under way; this covers unlocks from anywhere else
          if (m.free('fanfare', t, 0.6)) {
            snd.fanfare(m, m.at('ui', e.x, e.z, 1, 0.6), t)
            m.duck(0.4, 1.6)
          }
          break

        // --- misc ---
        case 'emoji':
          if (m.free('emoji', t, 0.2)) {
            const o = e.who === 'player' ? m.to('ui') : m.at('ui', s.driver.x, s.driver.z, 0.8)
            if (e.kind === 'scared') snd.scared(m, o, t)
            else snd.happy(m, o, t)
          }
          break
        case 'guide':
          if (e.kind !== 'none' && m.free('pip', t, 0.3)) snd.pip(m, m.to('ui'), t)
          break
        case 'win':
          snd.winJingle(m, m.to('ui'), t + 0.3)
          m.duck(0.15, 4.5)
          break
        // silent on purpose: bubbleSpawn and grindEnd (nothing to hear), coinPickupStart and padPayStart (their
        // ticks follow the wallet and the pad in update())
      }
    },

    update(s, dt) {
      const pl = s.player
      m.setListener(pl.x, pl.z)
      const simDt = s.time - lastTime
      const jumped = !primed || simDt < 0 || simDt > MAX_SIM_STEP
      primed = true
      lastTime = s.time
      beds.update(s, jumped ? 0 : simDt)
      music.update()
      const t = m.now()

      // footsteps
      const step = Math.floor(pl.odo / STEP_LENGTH)
      if (!jumped && step !== lastStep && pl.mode !== 'cart' && pl.mountT <= 0 && m.free('step', t, 0.06)) {
        leftFoot = !leftFoot
        snd.footstep(m, stepOut, t, surfaceAt(s, pl.x, pl.z), leftFoot ? 1 : 0.85)
      }
      lastStep = step

      // ward doors: the sim has no event for them, so the creak starts when a leaf starts to swing
      for (let i = 0; i < 2; i++) {
        const open = i === 0 ? s.doors.south : s.doors.north
        const dir = Math.sign(open - doorOpen[i]!)
        if (!jumped && dir !== 0 && dir !== doorDir[i] && m.free('door', t, 0.25)) {
          const door = i === 0 ? L.WARD1_DOOR : L.NORTH_DOOR
          snd.gate(m, m.at('sfx', door.x, door.z, 0.5), t, dir > 0 ? DOOR_OPEN : DOOR_CLOSE, dir > 0)
        }
        doorOpen[i] = open
        doorDir[i] = dir
      }

      // the swarm: a squeak now and then when he is close to it
      if (m.rnd() < dt * RAT_SQUEAKS * s.swarm.fill * m.near(RAT_FIELD.x, RAT_FIELD.z, 7)) {
        snd.squeal(m, m.at('sfx', RAT_FIELD.x + (m.rnd() - 0.5) * 12, RAT_FIELD.z, 0.5), t, 0.1)
      }

      // healed chord: it leads the check mark, so it follows the treatment clock and not the 'healed' event
      for (let i = 0; i < treatT.length; i++) {
        const tt = s.beds[i]!.treatT
        if (!jumped && treatT[i]! < HEAL_AT && tt >= HEAL_AT && m.free('healed', t, 0.12)) snd.healed(m, m.at('ui', BEDS[i]!.x, BEDS[i]!.z, 1, 0.25), t)
        treatT[i] = tt
      }

      // counter ticks: one per coin he takes off the pallet. Gold that flies to the HUD by itself (rat heap, bursar)
      // is not counted aloud in the ad: snd.sweep() is all there is to hear.
      const gain = s.wallet - lastWallet
      lastWallet = s.wallet
      streamT = jumped ? 0 : gain > 0 && s.pallet.collecting ? STREAM_HOLD : streamT - dt
      if (streamT > 0) {
        if (nextTick < t) nextTick = t
        for (; nextTick < t + TICK_AHEAD; nextTick += tickGap(m)) snd.coinTick(m, tickOut, nextTick, 1)
      }

      // payment ticks: the same coin, as in the ad
      let paying = false
      for (let i = 0; i < s.pads.length; i++) paying ||= s.pads[i]!.state === 'paying'
      if (!jumped && paying) {
        if (nextPayTick < t) nextPayTick = t
        for (; nextPayTick < t + TICK_AHEAD; nextPayTick += tickGap(m)) snd.coinTick(m, tickOut, nextPayTick, 0.9)
      }
    },
  }
}

export function createAudio(): Audio & { readonly debug: AudioDebug } {
  const Ctor: typeof AudioContext | undefined = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  const loops = createLoops()
  let ctx: AudioContext | null = null
  let engine: Engine | null = null
  let muted = false
  let broken = false
  /** resume() has been asked for: the context starts at the first moment the browser allows it. */
  let wanted = false

  const fail = (err: unknown) => {
    broken = true
    engine = null
    console.warn('[audio] disabled after error', err)
    void Promise.resolve()
      .then(() => ctx?.close())
      .catch(() => {})
  }
  /** The engine, only while sound can actually play. */
  const live = () => (engine && ctx!.state === 'running' ? engine : null)

  /**
   * Creates the context, or wakes it. Only a gesture may do either, and a touch only counts as one when the finger
   * lifts: a context created on the way down stays suspended and logs a warning for every source it starts.
   * Opening the audio device already takes a frame or two, so nothing else is done here (see update()).
   */
  const wake = () => {
    if (!wanted || broken || !Ctor) return
    try {
      if (!ctx) {
        if (globalThis.navigator?.userActivation?.isActive === false) return
        ctx = new Ctor({ latencyHint: 'interactive' })
      }
      // not only 'suspended': iOS leaves a context 'interrupted' after a phone call or an app switch
      if (ctx.state !== 'running') void ctx.resume().catch(() => {})
    } catch (err) {
      fail(err)
    }
  }

  // One loop per idle slice while the title is up. Whatever is still missing at the gesture is left to update().
  const idle: (fn: () => void) => void = globalThis.requestIdleCallback ?? (fn => setTimeout(fn, 30))
  const warm = () => {
    if (broken) return
    try {
      if (loops.renderNext()) idle(warm)
    } catch (err) {
      fail(err)
    }
  }
  if (Ctor) idle(warm)

  if (typeof document !== 'undefined') {
    // the frame loop stops in a hidden tab: stop the beds with it
    document.addEventListener('visibilitychange', () => {
      if (!ctx || broken) return
      if (document.hidden) void ctx.suspend().catch(() => {})
      else void ctx.resume().catch(() => {})
    })
    // every later gesture retries, in the capture phase so that no handler of the game can hide it
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown']) document.addEventListener(type, wake, { capture: true, passive: true })
  }

  const debug: AudioDebug = {
    get ctx() {
      return ctx
    },
    get out() {
      return engine?.mixer.out ?? null
    },
    render(seconds, script) {
      const off = new OfflineAudioContext(2, Math.ceil(seconds * 48000), 48000)
      const e = createEngine(off, loops)
      script(e, (t, fn) => {
        void off.suspend(t).then(() => {
          e.mixer.lead = 0
          fn()
          void off.resume()
        })
      })
      return off.startRendering()
    },
  }

  const api = {
    resume() {
      wanted = true
      wake()
    },
    setMuted(mute: boolean) {
      muted = mute
      try {
        engine?.mixer.setMuted(mute)
      } catch (err) {
        fail(err)
      }
    },
    get muted() {
      return muted
    },
    onEvent(e: GameEvent, s: GameState) {
      try {
        live()?.onEvent(e, s)
      } catch (err) {
        fail(err)
      }
    },
    update(s: GameState, dt: number) {
      try {
        // the graph is built here, out of the gesture: after one frame for every loop that is still missing
        if (ctx && !engine && !broken && !loops.renderNext()) engine = createEngine(ctx, loops, muted)
        live()?.update(s, dt)
      } catch (err) {
        fail(err)
      }
    },
    debug,
  }
  return api
}
