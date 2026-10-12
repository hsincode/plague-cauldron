// One-shot recipes (SPEC section 10). Each schedules a handful of voices on the mixer, starting at time t, into
// the output node `o` (Mixer.at for a place in the world, Mixer.to for the HUD or the doctor himself).
// A recipe that follows a sound of the ad says so and gives its place in the ad's sound track (seconds); the others
// are our own. Every tune is in C major pentatonic, the key of the music bed; the coins, the flask ting and the
// unlock chimes ring at the pitches they have in the ad.
import type { Mixer } from './mixer'

/** Equal-tempered pitch of a MIDI note (69 = A4 = 440 Hz). */
export const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12)

const PENTA = [0, 2, 4, 7, 9]
/** Pentatonic degree above `base`: 0 = C5, 5 = C6, ... */
const penta = (degree: number, base = 72) => midi(base + 12 * Math.floor(degree / 5) + PENTA[degree % 5]!)

export type Surface = 'dirt' | 'tile' | 'plank' | 'beads'

// ---------------------------------------------------------------- building blocks

/** Wood on wood. */
export function knock(m: Mixer, o: AudioNode, t: number, pitch = 1, gain = 1) {
  pitch *= m.detune(80)
  m.tone(o, t, 'sine', 210 * pitch, 130 * pitch, 0.09, 0.45 * gain, 0.002)
  m.tone(o, t, 'triangle', 680 * pitch, 620 * pitch, 0.05, 0.3 * gain, 0.001)
  m.noise(o, t, 'white', 'bandpass', 1300 * pitch, 900 * pitch, 2.2, 0.04, 0.9 * gain, 0.001)
}

/** Glass tick. */
const tink = (m: Mixer, o: AudioNode, t: number, f: number, gain: number, dur = 0.07) => m.fm(o, t, f, 2.41, 1.1, dur, gain)

/** Small bell: the voice of every chime, ding and sparkle. */
function bell(m: Mixer, o: AudioNode, t: number, f: number, gain: number, dur = 0.8) {
  m.fm(o, t, f, 3.5, 0.8, dur, gain * 0.6)
  m.tone(o, t, 'sine', f, f, dur, gain * 0.5, 0.002)
  m.tone(o, t, 'sine', f * 2.01, f * 2.01, dur * 0.5, gain * 0.2, 0.002)
}

/** Droplets flying off a splash. */
function drips(m: Mixer, o: AudioNode, t: number, n: number, spread: number) {
  for (let i = 0; i < n; i++) {
    const f = 700 + m.rnd() * 1300
    m.tone(o, t + m.rnd() * spread, 'sine', f, f * 1.7, 0.045, 0.07 + m.rnd() * 0.08, 0.003)
  }
}

/** Sawtooth section through one low-pass that opens on the attack: the fanfare voice. */
function brass(m: Mixer, o: AudioNode, t: number, notes: readonly number[], dur: number, gain: number) {
  const { ctx } = m
  const lp = ctx.createBiquadFilter()
  const g = ctx.createGain()
  lp.type = 'lowpass'
  lp.Q.value = 1.2
  m.begin(lp.frequency, 700, t)
  lp.frequency.linearRampToValueAtTime(3400, t + 0.04)
  lp.frequency.exponentialRampToValueAtTime(1100, t + dur)
  const peak = (gain * 1.4) / (notes.length * 2)
  m.begin(g.gain, 0, t)
  g.gain.linearRampToValueAtTime(peak, t + 0.018)
  g.gain.setValueAtTime(peak, t + dur * 0.55)
  g.gain.linearRampToValueAtTime(0, t + dur)
  lp.connect(g).connect(o)
  for (const n of notes) {
    for (let side = -1; side <= 1; side += 2) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = midi(n)
      osc.detune.value = side * 7
      osc.connect(lp)
      osc.start(t)
      osc.stop(t + dur + 0.01)
    }
  }
}

// ---------------------------------------------------------------- tools and river

/** Wet "bloop" of a bubble seating in the blade, and the beads it throws up. */
export function dock(m: Mixer, o: AudioNode, t: number, r: number) {
  const k = (1.3 / r) * m.detune(70)
  m.tone(o, t, 'sine', 150 * k, 560 * k, 0.13, 0.7, 0.006)
  m.tone(o, t + 0.07, 'sine', 420 * k, 980 * k, 0.07, 0.25, 0.004)
  m.noise(o, t, 'pink', 'lowpass', 900, 300, 0.7, 0.12, 0.35, 0.004)
  m.slice(o, t + 0.01, 'plough', 0.3, 0.55, 1.25, 0.015)
}

/** Oversize bubble against the hand scoop: low rubbery thud. */
export function reject(m: Mixer, o: AudioNode, t: number) {
  m.tone(o, t, 'sine', 140, 55, 0.3, 0.6, 0.004)
  m.tone(o, t, 'triangle', 330, 110, 0.16, 0.45, 0.003)
  m.fm(o, t + 0.02, 210, 0.14, 1.6, 0.32, 0.4, 0.01)
  m.noise(o, t, 'pink', 'lowpass', 1100, 300, 0.7, 0.12, 0.6, 0.002)
  m.slice(o, t, 'plough', 0.22, 0.3, 0.9)
}

/** A bubble rolls over the cliff: a breath of air, then it lands somewhere below. */
export function fall(m: Mixer, o: AudioNode, t: number) {
  m.noise(o, t, 'pink', 'bandpass', 900, 300, 1.2, 0.4, 0.35, 0.25, true)
  m.tone(o, t + 0.38, 'sine', 130, 65, 0.22, 0.5, 0.006)
  m.noise(o, t + 0.38, 'pink', 'lowpass', 700, 250, 0.7, 0.3, 0.4, 0.01)
}

/** A tool appears (the cart where the scoop stood, the spare scoop): three knocks of carpentry. */
export function build(m: Mixer, o: AudioNode, t: number) {
  for (let i = 0; i < 3; i++) knock(m, o, t + 0.12 + i * 0.075, 0.75 + i * 0.2, 0.8)
}

// ---------------------------------------------------------------- grinder and flasks
// `r` is the bubble radius (1.0 - 1.8 m): bigger bubbles sound lower.

export function grindStart(m: Mixer, o: AudioNode, t: number) {
  m.tone(o, t, 'sine', 180, 80, 0.16, 0.7)
  m.fm(o, t, 310, 3.37, 2.2, 0.22, 0.4)
  m.noise(o, t, 'white', 'bandpass', 1800, 900, 1.5, 0.05, 0.35, 0.001)
}

export function crack(m: Mixer, o: AudioNode, t: number, r: number) {
  const k = Math.sqrt(1.3 / r)
  m.noise(o, t, 'white', 'highpass', 3200, 3200, 0.7, 0.04, 0.8, 0.0005)
  m.tone(o, t, 'triangle', 340 * k, 170 * k, 0.06, 0.5, 0.001)
  for (let i = 0; i < 4; i++) tink(m, o, t + i * 0.028 + m.rnd() * 0.012, (2400 + m.rnd() * 2800) * k, 0.4 - i * 0.07, 0.06 + m.rnd() * 0.08)
}

export function shell(m: Mixer, o: AudioNode, t: number, r: number) {
  const k = Math.sqrt(1.3 / r)
  m.slice(o, t, 'crunch', 0.24, 0.9, 0.8 * k, 0.004)
  m.noise(o, t, 'pink', 'bandpass', 1500 * k, 700 * k, 1.1, 0.18, 0.7, 0.003)
  m.tone(o, t, 'sine', 160 * k, 70 * k, 0.16, 0.6)
}

export function shatter(m: Mixer, o: AudioNode, t: number, r: number) {
  const k = Math.sqrt(1.3 / r)
  m.noise(o, t, 'white', 'highpass', 2400, 5200, 0.7, 0.55, 0.6, 0.001)
  m.slice(o, t, 'crunch', 0.7, 0.8, 1.15 * k, 0.005)
  m.tone(o, t, 'sine', 115 * k, 50 * k, 0.22, 0.6)
  for (let i = 0; i < 8; i++) tink(m, o, t + m.rnd() * m.rnd() * 0.45, (2200 + m.rnd() * 4600) * k, 0.12 + m.rnd() * 0.25, 0.06 + m.rnd() * 0.22)
}

/** A flask pops out of the tray. */
export function eject(m: Mixer, o: AudioNode, t: number) {
  const p = m.detune(300)
  m.tone(o, t, 'sine', 430 * p, 800 * p, 0.04, 0.22, 0.002)
}

const TING_HZ = [3230, 2530, 3550, 6250]
const TING_LEVEL = [1, 0.45, 0.2, 0.15]
/**
 * Flasks ring as they land. The ad has one glass "ting" for it, always at this pitch, about four times a second
 * while a pile builds up (6.8-7.6 s and 41.5-42.5 s).
 */
export function ting(m: Mixer, o: AudioNode, t: number) {
  for (let i = 0; i < TING_HZ.length; i++) m.tone(o, t, 'sine', TING_HZ[i]!, TING_HZ[i]!, 0.2, 0.3 * TING_LEVEL[i]!, 0.004, true)
}

/**
 * A flask lands on the stack: `step` is the stack height, so the pops climb the scale as it grows. As in the ad
 * (7.8-8.2 s), each sweeps up a little over an octave in 60 ms, into 700 Hz for the first flask and 1.1 kHz for the
 * fifth.
 */
export function pickup(m: Mixer, o: AudioNode, t: number, step: number, unit: boolean) {
  const f = penta(step)
  if (unit) {
    m.tone(o, t, 'sine', f * 0.45, f, 0.075, 0.5, 0.025, true)
    m.fm(o, t, f * 2, 3.01, 0.7, 0.06, 0.12)
  } else m.tone(o, t, 'sine', f * 0.45, f * 0.75, 0.05, 0.16, 0.003)
}

/** A flask leaves the stack for the pot. */
export function toss(m: Mixer, o: AudioNode, t: number) {
  const p = m.detune(150)
  m.noise(o, t, 'white', 'bandpass', 900 * p, 2800 * p, 2.5, 0.09, 0.7, 0.04, true)
  m.tone(o, t, 'sine', 520 * p, 1150 * p, 0.06, 0.22, 0.004)
}

/** A flask drops into the potion: plop and fizz, higher as the pot fills (`fill` 0..1). */
export function plop(m: Mixer, o: AudioNode, t: number, fill: number) {
  const f = 320 * (1 + 0.7 * fill) * m.detune(120)
  m.tone(o, t, 'sine', f, f * 2.4, 0.09, 0.32, 0.004)
  m.tone(o, t, 'sine', f * 0.55, f * 0.3, 0.13, 0.26, 0.004)
  m.noise(o, t + 0.01, 'white', 'highpass', 5200, 7000, 0.7, 0.24, 0.1, 0.012)
}

// ---------------------------------------------------------------- crowd and bath

/** Wooden hinge: a stick-slip sawtooth through two body resonances, then the panel hits its stop. */
export function gate(m: Mixer, o: AudioNode, t: number, dur: number, opening: boolean) {
  const { ctx } = m
  const osc = ctx.createOscillator()
  const body = ctx.createBiquadFilter()
  const edge = ctx.createBiquadFilter()
  const g = ctx.createGain()
  osc.type = 'sawtooth'
  // the slip rate climbs unevenly as the panel speeds up, and falls when it closes
  const f0 = opening ? 52 : 112
  const f1 = opening ? 118 : 46
  m.begin(osc.frequency, f0, t)
  osc.frequency.linearRampToValueAtTime((f0 * 0.55 + f1 * 0.45) * m.detune(200), t + dur * 0.35)
  osc.frequency.linearRampToValueAtTime((f0 * 0.5 + f1 * 0.5) * m.detune(200), t + dur * 0.6)
  osc.frequency.linearRampToValueAtTime(f1, t + dur)
  body.type = 'bandpass'
  body.frequency.value = 640
  body.Q.value = 5
  edge.type = 'bandpass'
  edge.frequency.value = 1650
  edge.Q.value = 7
  m.env(g.gain, t, dur * 0.3, dur, 1.5, true)
  osc.connect(body).connect(g)
  osc.connect(edge).connect(g)
  g.connect(o)
  osc.start(t)
  osc.stop(t + dur + 0.01)
  knock(m, o, t + dur, opening ? 0.7 : 0.9, opening ? 0.8 : 0.55)
}

/** The leap over the rim. */
export function hopIn(m: Mixer, o: AudioNode, t: number) {
  const p = m.detune(200)
  m.noise(o, t, 'white', 'bandpass', 500 * p, 1900 * p, 1.8, 0.2, 0.7, 0.12, true)
}

/** Bathers land in the pot (`size` 1 for a pair, more for four). */
export function splash(m: Mixer, o: AudioNode, t: number, size: number) {
  m.noise(o, t, 'white', 'lowpass', 5200, 650, 0.7, 0.45 * size, 0.55, 0.004)
  m.noise(o, t, 'pink', 'bandpass', 1100, 380, 1.1, 0.26, 0.5, 0.004)
  m.tone(o, t, 'sine', 170, 52, 0.24, 0.65 * size, 0.004)
  drips(m, o, t + 0.07, 5, 0.3)
}

export function hopOut(m: Mixer, o: AudioNode, t: number) {
  const p = m.detune(200)
  m.noise(o, t, 'white', 'bandpass', 1400, 3200, 1.2, 0.2, 0.45, 0.02)
  m.tone(o, t, 'sine', 240 * p, 420 * p, 0.07, 0.35, 0.004)
  drips(m, o, t + 0.05, 3, 0.2)
}

const SHIMMER = [1, 1.004, 2, 3.01]
/** Rising shimmer under a filling progress pie. */
export function shimmer(m: Mixer, o: AudioNode, t: number, dur: number) {
  const f = midi(72)
  for (const h of SHIMMER) m.tone(o, t, 'sine', f * h, f * h * 2, dur, 0.09 / Math.sqrt(h), dur * 0.8, true)
  m.noise(o, t, 'white', 'bandpass', 5000, 9500, 3, dur, 0.06, dur * 0.8, true)
}

/**
 * The check mark over the pot. In the ad it is the loudest effect of all (14.4, 32.4, 46.2 and 48.1 s): a short low
 * note that is struck twice, and 60 ms after it one two octaves higher that rings for half a second. The low note
 * there is 678 Hz, between E and F; this is E.
 */
export function cured(m: Mixer, o: AudioNode, t: number) {
  const f = midi(76)
  m.tone(o, t, 'sine', f, f, 0.25, 0.8, 0.004)
  m.tone(o, t + 0.14, 'sine', f, f, 0.5, 0.32, 0.004)
  m.tone(o, t + 0.06, 'sine', f * 4, f * 4, 0.7, 0.65, 0.004)
  m.tone(o, t + 0.06, 'sine', f * 12, f * 12, 0.2, 0.05, 0.004)
}

// ---------------------------------------------------------------- coins and pads

/**
 * The coin "ting" of the ad, measured in its sound track wherever gold is counted, coin by coin (pallet pickups at
 * 18.3, 33.9 and 48.9 s, pad payments at 19.8, 27.7, 35.6 and 50.6 s): five inharmonic partials above COIN_PITCH.
 * The pitch is the same for every coin of a pickup and of a payment.
 */
const COIN_PITCH = 4254
const COIN_RATIO = [1, 1.333, 1.705, 2.273, 2.907]
const COIN_LEVEL = [0.47, 0.25, 1, 0.67, 0.14]
const COIN_DECAY = [0.065, 0.06, 0.055, 0.045, 0.035]

/** One coin on the counter. */
export function coinTick(m: Mixer, o: AudioNode, t: number, gain: number) {
  // in the ad every partial is a doublet 14 cents wide: no two coins ring at quite the same pitch, or as loud
  const f = COIN_PITCH * m.detune(14)
  gain *= 0.28 + 0.24 * m.rnd()
  for (let i = 0; i < COIN_RATIO.length; i++) m.tone(o, t, 'sine', f * COIN_RATIO[i]!, f * COIN_RATIO[i]!, COIN_DECAY[i]!, gain * COIN_LEVEL[i]!, 0.001)
}

/** A rope of coins in the air for `dur` seconds: the shower they will make, an octave down and soft. */
export function fountain(m: Mixer, o: AudioNode, t: number, dur: number, gain: number) {
  m.slice(o, t, 'coins', dur + 0.15, gain, 0.48 + m.rnd() * 0.08, 0.08)
}

/** The same coins landing on the pallet: this is the bright shower of the ad (14.9-15.8 s). */
export function clinks(m: Mixer, o: AudioNode, t: number, dur: number) {
  m.slice(o, t, 'coins', dur + 0.1, 1.1, 0.97 + m.rnd() * 0.06, 0.05)
}

/** Pickup complete. */
export function cash(m: Mixer, o: AudioNode, t: number) {
  bell(m, o, t, midi(93), 0.25, 0.35)
  bell(m, o, t + 0.07, midi(100), 0.3, 0.6)
  m.slice(o, t, 'coins', 0.25, 0.6, 1, 0.005)
}

export function padPop(m: Mixer, o: AudioNode, t: number) {
  m.tone(o, t, 'sine', 300, 720, 0.1, 0.45, 0.004)
  bell(m, o, t + 0.06, midi(79), 0.3, 0.3)
  bell(m, o, t + 0.13, midi(84), 0.35, 0.45)
  for (let i = 0; i < 3; i++) tink(m, o, t + 0.1 + m.rnd() * 0.15, 3500 + m.rnd() * 2500, 0.08, 0.1)
}

const TRIAD = [72, 76, 79]
/** Last coin on the pad: a quick triad that leads into the unlock fanfare. */
export function confirm(m: Mixer, o: AudioNode, t: number) {
  for (let i = 0; i < 3; i++) bell(m, o, t + i * 0.04, midi(TRIAD[i]!), 0.3, 0.35)
  knock(m, o, t, 0.8, 0.6)
}

/** The chimes of the unlock burst as they are struck in the ad: seconds after the burst, Hz, level, seconds of ring. */
const CHIMES: readonly (readonly [at: number, hz: number, level: number, ring: number])[] = [
  [0.03, 8700, 0.5, 0.4],
  [0.03, 11100, 0.3, 0.25],
  [0.25, 2722, 1, 1.2],
  [0.3, 3896, 0.7, 1.4],
  [0.35, 3440, 0.6, 1.5],
  [0.35, 4133, 0.5, 1],
  [0.4, 3860, 0.8, 1.2],
  [0.45, 2795, 0.8, 1.4],
  [0.55, 7169, 0.5, 0.5],
  [0.6, 2292, 0.8, 0.9],
  [0.7, 2722, 1, 1.1],
  [0.8, 3860, 0.9, 1],
  [0.8, 8700, 0.45, 0.5],
  [0.95, 4133, 0.6, 0.8],
]
/**
 * Unlock burst, after the ad (20.3 and 28.5 s, the same recording both times): a click, a wash of noise that takes a
 * second and a half to die away, a swell on D6 over G5, and a tree of chimes struck one after another through the
 * wash. Only the thump under it is ours.
 */
export function fanfare(m: Mixer, o: AudioNode, t: number) {
  m.noise(o, t, 'white', 'highpass', 7000, 7000, 0.7, 0.03, 0.5, 0.001)
  m.noise(o, t + 0.01, 'white', 'bandpass', 3200, 5200, 0.5, 1.5, 0.42, 0.03, true)
  m.tone(o, t, 'sine', 98, 62, 0.4, 0.3, 0.004)
  m.tone(o, t + 0.03, 'sine', midi(86), midi(86), 0.5, 0.22, 0.22, true)
  m.tone(o, t + 0.03, 'sine', midi(79), midi(79), 0.45, 0.1, 0.18, true)
  for (const [at, hz, level, ring] of CHIMES) m.tone(o, t + at, 'sine', hz, hz, ring, 0.14 * level, 0.012)
}

// ---------------------------------------------------------------- ward

/** A body flops on the mattress; the frame squeaks twice. */
export function lie(m: Mixer, o: AudioNode, t: number) {
  const p = m.detune(150)
  m.noise(o, t, 'pink', 'bandpass', 340 * p, 200 * p, 0.8, 0.14, 1.2, 0.006)
  m.tone(o, t + 0.03, 'sine', 620 * p, 540 * p, 0.05, 0.06, 0.004)
  m.tone(o, t + 0.09, 'sine', 700 * p, 600 * p, 0.05, 0.05, 0.004)
}

/** A speech bubble pops in. */
export function bubblePop(m: Mixer, o: AudioNode, t: number, f: number, gain: number) {
  m.tone(o, t, 'sine', f * 0.7, f * 1.5, 0.06, gain, 0.003)
}

/** "Needs a nurse": the pop and two insistent pips. */
export function needNurse(m: Mixer, o: AudioNode, t: number) {
  bubblePop(m, o, t, 660, 0.25)
  m.tone(o, t + 0.08, 'triangle', midi(81), midi(81), 0.08, 0.13, 0.004)
  m.tone(o, t + 0.17, 'triangle', midi(81), midi(81), 0.1, 0.13, 0.004)
}

/**
 * The syringe goes in. In the ad (21.9 s) that is a bright "zip" that rises an octave from 640 Hz in 70 ms; the
 * squirt after it is ours. Both differ a little from nurse to nurse.
 */
export function jab(m: Mixer, o: AudioNode, t: number) {
  const p = m.detune(150)
  m.tone(o, t, 'sawtooth', 640 * p, 1300 * p, 0.12, 0.3, 0.025, true)
  m.noise(o, t + 0.03, 'white', 'bandpass', 3400 * p, 1100 * p, 4, 0.2, 0.3, 0.03, true)
}

const HEAL_CHORD = [96, 103, 105, 108, 110, 115]
/** Accents on the chord: seconds after its start, MIDI note, level. */
const HEAL_ACCENTS: readonly (readonly [at: number, note: number, level: number])[] = [
  [0, 93, 1],
  [0.24, 103, 0.6],
  [0.24, 112, 0.4],
  [0.4, 98, 0.6],
  [0.4, 110, 0.5],
]
/**
 * Healed: the bright chord of the ad (22.7-23.3 s). It swells in under 0.1 s, holds for half a second with three
 * accents on the way, and has two partials of "air" near 10 kHz. In the ad its notes are F#, G#, B and C# between
 * 1.7 and 6 kHz; they are played a semitone higher here, which puts them in the key of the music.
 */
export function healed(m: Mixer, o: AudioNode, t: number) {
  // two beds healed at once are 15 cents apart in the ad
  const p = m.detune(10)
  for (const n of HEAL_CHORD) m.tone(o, t + 0.02, 'sine', midi(n) * p, midi(n) * p, 0.6, 0.09, 0.07, true)
  for (const [at, n, level] of HEAL_ACCENTS) m.tone(o, t + at, 'sine', midi(n) * p, midi(n) * p, 0.3, 0.22 * level, 0.01)
  m.tone(o, t + 0.04, 'sine', 10790 * p, 10790 * p, 0.35, 0.05, 0.03, true)
  m.tone(o, t + 0.3, 'sine', 9640 * p, 9640 * p, 0.3, 0.035, 0.03, true)
}

/** "Hey!": a glottal buzz through two moving formants; `seed` 0..1 picks the voice. */
export function cheer(m: Mixer, o: AudioNode, t: number, seed: number) {
  const { ctx } = m
  const dur = 0.26
  const f0 = 150 + seed * 70
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = 'sawtooth'
  m.begin(osc.frequency, f0, t)
  osc.frequency.linearRampToValueAtTime(f0 * 1.28, t + 0.09)
  osc.frequency.linearRampToValueAtTime(f0 * 1.05, t + dur)
  // formants glide from "e" to "i"
  for (let i = 0; i < 2; i++) {
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.Q.value = i === 0 ? 5 : 8
    m.begin(f.frequency, i === 0 ? 650 : 1750, t)
    f.frequency.linearRampToValueAtTime(i === 0 ? 420 : 2250, t + dur)
    osc.connect(f).connect(g)
  }
  m.env(g.gain, t, 0.03, dur, 1, true)
  g.connect(o)
  osc.start(t)
  osc.stop(t + dur + 0.01)
  m.noise(o, t, 'white', 'bandpass', 1600, 1600, 1.5, 0.05, 0.06, 0.01, true)
}

/** Nurses running to their posts: quick light steps on planks. */
export function patter(m: Mixer, o: AudioNode, t: number, steps: number) {
  for (let i = 0; i < steps; i++) footstep(m, o, t + i * 0.085 + m.rnd() * 0.02, 'plank', 0.3 + m.rnd() * 0.2)
}

// ---------------------------------------------------------------- drill and rats

/** A crew member grabs the iron handle. */
export function clank(m: Mixer, o: AudioNode, t: number) {
  m.fm(o, t, 420, 3.37, 1.5, 0.14, 0.3)
  knock(m, o, t, 1.1, 0.5)
}

/** The drill cart lurches off. */
export function drillPush(m: Mixer, o: AudioNode, t: number, dur: number) {
  knock(m, o, t, 0.6, 0.8)
  m.noise(o, t, 'pink', 'bandpass', 400, 2600, 1.5, dur, 0.25, dur * 0.85, true)
}

/** One rat squeak: a quick up-and-down chirp. */
export function squeal(m: Mixer, o: AudioNode, t: number, gain: number) {
  const { ctx } = m
  const dur = 0.07 + m.rnd() * 0.06
  const f = 2600 + m.rnd() * 1200
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = 'triangle'
  m.begin(osc.frequency, f, t)
  osc.frequency.exponentialRampToValueAtTime(f * 1.35, t + 0.025)
  osc.frequency.exponentialRampToValueAtTime(f * 0.6, t + dur)
  m.env(g.gain, t, 0.01, dur, gain, true)
  osc.connect(g).connect(o)
  osc.start(t)
  osc.stop(t + dur + 0.01)
}

/** The two big coins that take turns in the rat heap of the ad (25.0-26.5 s): three partials each. */
const HEAP_COIN = [5700, 9340, 12260, 5700, 9760, 11930]
const HEAP_LEVEL = [0.5, 1, 0.7]

/** Big coins dropping on a heap for `dur` seconds, five or six a second as in the ad. */
function heapCoins(m: Mixer, o: AudioNode, t: number, dur: number, gain: number) {
  for (let u = 0; u < dur; u += 0.13 + 0.1 * m.rnd()) {
    const coin = m.rnd() < 0.5 ? 0 : 3
    const g = gain * (0.4 + 0.6 * m.rnd())
    for (let i = 0; i < 3; i++) m.tone(o, t + u, 'sine', HEAP_COIN[coin + i]!, HEAP_COIN[coin + i]!, 0.24, g * HEAP_LEVEL[i]!, 0.001)
  }
}

/**
 * The cone tears through the swarm for `dur` seconds. From the ad (24.65-25.75 s): a hiss that falls from 7.5 to
 * 5 kHz, and from 0.35 s on the big coins dropping on the heap. The roar, the crunch and the squeals are ours.
 */
export function massacre(m: Mixer, o: AudioNode, t: number, dur: number) {
  m.noise(o, t, 'pink', 'bandpass', 260, 180, 0.8, dur, 0.8, 0.05, true)
  m.slice(o, t, 'crunch', dur, 1, 0.7, 0.05)
  m.noise(o, t, 'white', 'bandpass', 7500, 5000, 2.5, dur, 0.4, 0.08, true)
  heapCoins(m, o, t + 0.35, dur - 0.35, 0.25)
  for (let i = 0; i < 14; i++) {
    const u = m.rnd()
    squeal(m, o, t + dur * u * u, 0.06 + m.rnd() * 0.08)
  }
}

/** A few rats squeak: the swarm is back. */
export function chitter(m: Mixer, o: AudioNode, t: number) {
  for (let i = 0; i < 3; i++) squeal(m, o, t + i * 0.11 + m.rnd() * 0.05, 0.1)
}

/**
 * A heap of coins streams to the HUD for `dur` seconds. In the ad (26.0-26.5 s) the big coins of the heap ring on
 * through the flight and nothing is counted aloud; the rush of air under them is ours.
 */
export function sweep(m: Mixer, o: AudioNode, t: number, dur: number) {
  m.noise(o, t, 'white', 'bandpass', 1400, 9000, 2, dur + 0.08, 0.3, dur, true)
  for (let i = 0; i < 3; i++) m.tone(o, t, 'sine', HEAP_COIN[i]!, HEAP_COIN[i]!, dur + 0.1, 0.1 * HEAP_LEVEL[i]!, dur * 0.3, true)
  heapCoins(m, o, t, dur, 0.3)
}

const PAYOUT = [84, 88, 91, 96]
/** The payout lands in the wallet: cash drawer and a bell chord (one more bell for the Mk II reward). */
export function payout(m: Mixer, o: AudioNode, t: number, big: boolean) {
  m.tone(o, t, 'sine', 170, 85, 0.14, 0.5)
  for (let i = 0; i < (big ? 4 : 3); i++) bell(m, o, t + i * 0.03, midi(PAYOUT[i]!), 0.3, 0.7 + i * 0.1)
  m.slice(o, t, 'coins', 0.35, 0.7, 1, 0.005)
}

// ---------------------------------------------------------------- emoji, guide, win

/** Scared emoji: a short falling "uh-oh". */
export function scared(m: Mixer, o: AudioNode, t: number) {
  m.tone(o, t, 'triangle', midi(79), midi(78), 0.1, 0.3, 0.004, true)
  m.tone(o, t + 0.11, 'triangle', midi(74), midi(72), 0.2, 0.3, 0.004, true)
}

/** Happy emoji: two rising notes. */
export function happy(m: Mixer, o: AudioNode, t: number) {
  bell(m, o, t, midi(88), 0.22, 0.35)
  bell(m, o, t + 0.09, midi(93), 0.26, 0.5)
}

/** The guide arrow appears. */
export function pip(m: Mixer, o: AudioNode, t: number) {
  m.tone(o, t, 'sine', midi(81), midi(81), 0.08, 0.2)
  m.tone(o, t + 0.06, 'sine', midi(88), midi(88), 0.12, 0.2)
}

/** HUD counter: one more villager discharged. */
export function count(m: Mixer, o: AudioNode, t: number) {
  m.tone(o, t, 'sine', midi(91), midi(91), 0.12, 0.12)
}

const TUNE = [67, 72, 76, 79, 76, 79]
const FINAL_CHORD = [48, 60, 67, 72, 76, 79, 84]
/** "Plague cured": a run up the triad into a long chord with bells. */
export function winJingle(m: Mixer, o: AudioNode, t: number) {
  const step = 0.13
  for (let i = 0; i < TUNE.length; i++) {
    brass(m, o, t + i * step, [TUNE[i]! - 12, TUNE[i]!], step * 1.1, 0.3)
    bell(m, o, t + i * step, midi(TUNE[i]! + 12), 0.2, 0.3)
  }
  const end = t + TUNE.length * step
  brass(m, o, end, FINAL_CHORD, 1.9, 0.5)
  m.tone(o, end, 'sine', 98, 60, 0.6, 0.6, 0.004)
  for (let i = 0; i < 14; i++) bell(m, o, end + 0.1 + i * 0.09, penta(10 + ((i * 2) % 9)), 0.12, 0.6)
  m.noise(o, end, 'white', 'highpass', 6000, 9000, 0.7, 1.8, 0.05, 0.2, true)
}

// ---------------------------------------------------------------- footsteps

/** One footfall of the doctor (soft boots under a long coat) on the given ground. */
export function footstep(m: Mixer, o: AudioNode, t: number, surface: Surface, gain: number) {
  const p = m.detune(120)
  switch (surface) {
    case 'dirt':
      m.noise(o, t, 'pink', 'bandpass', 520 * p, 280, 0.8, 0.07, gain * 1.6, 0.004)
      m.noise(o, t, 'white', 'bandpass', 2600 * p, 1800, 0.8, 0.04, gain * 0.25, 0.002)
      break
    case 'tile':
      m.tone(o, t, 'sine', 170 * p, 110 * p, 0.05, gain * 0.5, 0.002)
      m.noise(o, t, 'white', 'bandpass', 1900 * p, 1400, 1.8, 0.03, gain * 0.5, 0.001)
      break
    case 'plank':
      m.tone(o, t, 'sine', 235 * p, 150 * p, 0.07, gain * 0.6, 0.002)
      m.noise(o, t, 'white', 'bandpass', 900 * p, 700, 2.5, 0.04, gain * 0.5, 0.001)
      break
    case 'beads':
      m.slice(o, t, 'plough', 0.09, gain * 0.9, 1.1 * p, 0.004)
      break
  }
}
