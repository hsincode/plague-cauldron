// The mix graph and the voice primitives every sound is built from. It only needs a BaseAudioContext, so the same
// graph can be rendered in an OfflineAudioContext and measured.
//
//   voice -> (distance gain -> pan) -> bus -+-> master (mute fade) -> rumble filter -> compressor -> soft clip -> out
//                                           +-> reverb send -> convolver -^
//
// Envelope convention: `dur` is the whole length of a voice. Percussive voices decay exponentially to -60 dB at
// `dur`, swelling ones ramp linearly; both end on a short linear ramp to exactly 0 before the source stops, and
// every automated parameter starts through begin(), so no voice can click at either end.
import { SCREEN_RIGHT } from '../config'
import { clamp } from '../core/math'
import type { LoopName, Loops, NoiseColor, TextureName } from './loops'
import { type Rnd, impulse, xorshift } from './textures'

export type BusName = 'sfx' | 'glass' | 'coin' | 'voice' | 'ui' | 'bed' | 'music'

/** Per-category level and reverb send. The compressor adds about 5 dB of make-up gain on top. */
const BUS: Record<BusName, { gain: number; send: number }> = {
  sfx: { gain: 0.5, send: 0.2 },
  glass: { gain: 0.36, send: 0.25 },
  coin: { gain: 0.36, send: 0.18 },
  voice: { gain: 0.34, send: 0.3 },
  ui: { gain: 0.42, send: 0.28 },
  bed: { gain: 0.4, send: 0.06 },
  music: { gain: 0.12, send: 0.35 },
}
const MASTER = 0.7
const MUTE_FADE = 0.05
/** Distance at which a world sound has lost 6 dB. */
const REF_DISTANCE = 9
/** Metres to the side of the doctor at which a sound is panned fully (to PAN_WIDTH). */
const PAN_DISTANCE = 12
const PAN_WIDTH = 0.6
/** The soft clipper is transparent below this and never exceeds CLIP_KNEE + CLIP_ROOM. */
const CLIP_KNEE = 0.6
const CLIP_ROOM = 0.28

/** Sounds that can come in bursts; each has its own rate limiter (see Mixer.free). */
export type GateKey =
  | 'knock' | 'build' | 'dock' | 'reject' | 'fall' | 'crack' | 'shatter' | 'eject' | 'ting' | 'pickup' | 'pickupFar' | 'throw'
  | 'plop' | 'gate' | 'door' | 'bubble' | 'hop' | 'splash' | 'cure' | 'exit' | 'fountain' | 'clink' | 'lie' | 'jab'
  | 'healed' | 'cheer' | 'patter' | 'count' | 'crew' | 'drill' | 'cash' | 'padPop' | 'fanfare' | 'emoji' | 'pip' | 'step'

export interface Mixer {
  readonly ctx: BaseAudioContext
  /** Last node of the chain (already connected to the destination): tap it to measure the mix. */
  readonly out: AudioNode
  readonly bus: Record<BusName, GainNode>
  /** Seconds added to "now" for everything scheduled next (offline renders place events with it). */
  lead: number
  /** Start time for a sound triggered now. */
  now(): number
  rnd: Rnd
  /** Random pitch factor within +-cents. */
  detune(cents: number): number
  setListener(x: number, z: number): void
  /** 0..1 loudness of a world position heard from the doctor (ref = distance of -6 dB). */
  near(x: number, z: number, ref?: number): number
  /** -1..1 stereo position of a world position on screen. */
  pan(x: number, z: number): number
  /** Output for a world sound: attenuated by distance (never below `floor`) and panned. */
  at(bus: BusName, x: number, z: number, gain?: number, floor?: number): AudioNode
  /** Output for a sound that is not in the world (HUD, the doctor himself). */
  to(bus: BusName, gain?: number): AudioNode
  /**
   * Rate limiter on start times, which also caps the voices of a sound at dur / gap: false when a voice of `key`
   * already starts less than `gap` seconds before t. Works for sounds scheduled ahead as long as each key is
   * scheduled in rising time order.
   */
  free(key: GateKey, t: number, gap: number): boolean
  /** Oscillator blip gliding f0 -> f1. */
  tone(dst: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, dur: number, gain: number, attack?: number, swell?: boolean): void
  /** Two-operator FM bell / metal: modulator at fc * ratio, the index decays faster than the level. */
  fm(dst: AudioNode, t: number, fc: number, ratio: number, index: number, dur: number, gain: number, attack?: number): void
  /** Filtered noise burst with the filter frequency gliding f0 -> f1. */
  noise(dst: AudioNode, t: number, color: NoiseColor, filter: BiquadFilterType, f0: number, f1: number, q: number, dur: number, gain: number, attack?: number, swell?: boolean): void
  /** A random slice of a texture loop under a swell envelope. */
  slice(dst: AudioNode, t: number, tex: TextureName, dur: number, gain: number, rate?: number, attack?: number): void
  /**
   * First value of a parameter that is automated from t on; exposed, like env(), for voices assembled by hand.
   * It is also made the plain value, because a node that starts at t still runs on the plain value at first: a gain
   * for one sample (sources and automation round t differently), an oscillator's frequency for the rest of that
   * render quantum. Left at the defaults, a noise voice opens with a full-level sample and a tone with a fragment
   * of 440 Hz.
   */
  begin(p: AudioParam, v: number, t: number): void
  /** Shapes a gain parameter. */
  env(p: AudioParam, t: number, attack: number, dur: number, peak: number, swell?: boolean): void
  /** A looping source of a texture or noise colour, started at a random phase. */
  loop(name: LoopName, dst: AudioNode, rate?: number): AudioBufferSourceNode
  /** Smoothed parameter change for the per-frame controls. */
  glide(p: AudioParam, v: number, tc?: number): void
  setMuted(muted: boolean): void
  /** Multiplies the music level for `seconds` (fanfares duck the bed). */
  duck(level: number, seconds: number): void
}

/** Seconds after `dur` over which a voice is forced to exactly 0 before it stops. */
const TAIL = 0.006

export function createMixer(ctx: BaseAudioContext, loops: Loops, muted = false): Mixer {
  const sr = ctx.sampleRate
  const rnd = xorshift(0x9e3779b9)

  // --- output chain ---
  const master = ctx.createGain()
  master.gain.value = muted ? 0 : MASTER
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -16
  comp.knee.value = 10
  comp.ratio.value = 5
  comp.attack.value = 0.003
  comp.release.value = 0.2
  const clip = ctx.createWaveShaper()
  const curve = new Float32Array(2049)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    const a = Math.abs(x)
    curve[i] = Math.sign(x) * (a <= CLIP_KNEE ? a : CLIP_KNEE + CLIP_ROOM * Math.tanh((a - CLIP_KNEE) / CLIP_ROOM))
  }
  clip.curve = curve
  // nothing below the range of any speaker reaches the compressor
  const rumble = ctx.createBiquadFilter()
  rumble.type = 'highpass'
  rumble.frequency.value = 28
  master.connect(rumble).connect(comp).connect(clip).connect(ctx.destination)

  // the one buffer that is rendered here: a convolver only takes an impulse at the rate of its own context
  const reverb = ctx.createConvolver()
  const tail = ctx.createBuffer(2, Math.round(sr * 1.1), sr)
  for (let ch = 0; ch < 2; ch++) tail.getChannelData(ch).set(impulse(sr, rnd, 1.1))
  reverb.buffer = tail
  const wet = ctx.createGain()
  wet.gain.value = 0.9
  reverb.connect(wet).connect(master)

  const bus = {} as Record<BusName, GainNode>
  for (const name of Object.keys(BUS) as BusName[]) {
    const g = ctx.createGain()
    g.gain.value = BUS[name].gain
    g.connect(master)
    const send = ctx.createGain()
    send.gain.value = BUS[name].send
    g.connect(send).connect(reverb)
    bus[name] = g
  }

  let lx = 0
  let lz = 0
  const gates: Partial<Record<GateKey, number>> = {}

  const begin = (p: AudioParam, v: number, t: number) => {
    p.value = v
    p.setValueAtTime(v, t)
  }
  const env = (p: AudioParam, t: number, attack: number, dur: number, peak: number, swell = false) => {
    begin(p, 0, t)
    p.linearRampToValueAtTime(peak, t + attack)
    if (swell) p.linearRampToValueAtTime(0, t + dur)
    else {
      // an exponential ramp cannot end on 0
      p.exponentialRampToValueAtTime(Math.max(peak * 1e-3, 1e-7), t + dur)
      p.linearRampToValueAtTime(0, t + dur + TAIL)
    }
  }

  const m: Mixer = {
    ctx,
    out: clip,
    bus,
    lead: 0,
    now: () => ctx.currentTime + m.lead + 0.004,
    rnd,
    detune: cents => Math.pow(2, ((rnd() * 2 - 1) * cents) / 1200),
    setListener(x, z) {
      lx = x
      lz = z
    },
    near(x, z, ref = REF_DISTANCE) {
      const dx = x - lx
      const dz = z - lz
      return 1 / (1 + (dx * dx + dz * dz) / (ref * ref))
    },
    pan: (x, z) => clamp(((x - lx) * SCREEN_RIGHT.x + (z - lz) * SCREEN_RIGHT.z) / PAN_DISTANCE, -1, 1) * PAN_WIDTH,
    at(name, x, z, gain = 1, floor = 0) {
      const g = ctx.createGain()
      g.gain.value = gain * Math.max(floor, m.near(x, z))
      const p = ctx.createStereoPanner()
      p.pan.value = m.pan(x, z)
      g.connect(p).connect(bus[name])
      return g
    },
    to(name, gain = 1) {
      if (gain === 1) return bus[name]
      const g = ctx.createGain()
      g.gain.value = gain
      g.connect(bus[name])
      return g
    },
    free(key, t, gap) {
      if (t < (gates[key] ?? 0)) return false
      gates[key] = t + gap
      return true
    },
    tone(dst, t, type, f0, f1, dur, gain, attack = 0.003, swell = false) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = type
      begin(o.frequency, f0, t)
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur)
      env(g.gain, t, attack, dur, gain, swell)
      o.connect(g).connect(dst)
      o.start(t)
      o.stop(t + dur + TAIL * 2)
    },
    fm(dst, t, fc, ratio, index, dur, gain, attack = 0.001) {
      const car = ctx.createOscillator()
      const mod = ctx.createOscillator()
      const depth = ctx.createGain()
      const g = ctx.createGain()
      car.frequency.value = fc
      mod.frequency.value = fc * ratio
      begin(depth.gain, index * fc * ratio, t)
      depth.gain.exponentialRampToValueAtTime(index * fc * ratio * 0.02, t + dur * 0.6)
      env(g.gain, t, attack, dur, gain)
      mod.connect(depth).connect(car.frequency)
      car.connect(g).connect(dst)
      car.start(t)
      mod.start(t)
      car.stop(t + dur + TAIL * 2)
      mod.stop(t + dur + TAIL * 2)
    },
    noise(dst, t, color, filter, f0, f1, q, dur, gain, attack = 0.002, swell = false) {
      const src = ctx.createBufferSource()
      const f = ctx.createBiquadFilter()
      const g = ctx.createGain()
      src.buffer = loops.get(color)
      src.loop = true
      f.type = filter
      f.Q.value = q
      begin(f.frequency, f0, t)
      if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur)
      env(g.gain, t, attack, dur, gain, swell)
      src.connect(f).connect(g).connect(dst)
      src.start(t, rnd() * src.buffer.duration)
      src.stop(t + dur + TAIL * 2)
    },
    slice(dst, t, tex, dur, gain, rate = 1, attack = 0.01) {
      const src = ctx.createBufferSource()
      const g = ctx.createGain()
      src.buffer = loops.get(tex)
      src.loop = true
      src.playbackRate.value = rate
      env(g.gain, t, attack, dur, gain, true)
      src.connect(g).connect(dst)
      src.start(t, rnd() * src.buffer.duration)
      src.stop(t + dur + TAIL)
    },
    begin,
    env,
    loop(name, dst, rate = 1) {
      const src = ctx.createBufferSource()
      src.buffer = loops.get(name)
      src.loop = true
      src.playbackRate.value = rate
      src.connect(dst)
      src.start(0, rnd() * src.buffer.duration)
      return src
    },
    glide(p, v, tc = 0.06) {
      p.setTargetAtTime(v, ctx.currentTime, tc)
    },
    setMuted(mute) {
      const t = ctx.currentTime
      master.gain.cancelScheduledValues(t)
      master.gain.setValueAtTime(master.gain.value, t)
      master.gain.linearRampToValueAtTime(mute ? 0 : MASTER, t + MUTE_FADE)
    },
    duck(lvl, seconds) {
      const t = ctx.currentTime
      const g = bus.music.gain
      g.cancelScheduledValues(t)
      g.setTargetAtTime(BUS.music.gain * lvl, t, 0.08)
      g.setTargetAtTime(BUS.music.gain, t + seconds, 0.5)
    },
  }
  return m
}
