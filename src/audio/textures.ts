// Procedural loop buffers for the dense textures (bead rattle, fire, bubbling, grinding, coins, wheels) and the
// noise colours. Everything is plain DSP into Float32Arrays (audio/loops.ts renders each once per page); every
// grain wraps round the end of its buffer and every filter is run round the loop twice, so the loops are seamless.
import { TAU } from '../core/math'

export type Rnd = () => number

/** xorshift32: a seedable source of noise (the seed must not be 0). */
export function xorshift(seed: number): Rnd {
  return () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
}

const between = (rnd: Rnd, lo: number, hi: number) => lo + (hi - lo) * rnd()
/** Log-uniform, for frequencies. */
const octaves = (rnd: Rnd, lo: number, hi: number) => lo * Math.pow(hi / lo, rnd())

/** Decaying sine grain at sample i0 (frequency f, time constant tau), as a two-pole recurrence: no trig per sample. */
function ping(out: Float32Array, sr: number, i0: number, f: number, tau: number, amp: number) {
  const len = out.length
  const n = Math.min(len, Math.ceil(tau * 7 * sr))
  const r = Math.exp(-1 / (tau * sr))
  const w = (TAU * f) / sr
  const c = 2 * r * Math.cos(w)
  const r2 = r * r
  // y[0] = 0, so the grain starts without a step
  let y2 = (-amp * Math.sin(w)) / r
  let y1 = 0
  let j = i0
  for (let i = 0; i < n; i++) {
    const y = c * y1 - r2 * y2
    y2 = y1
    y1 = y
    out[j] += y
    if (++j === len) j = 0
  }
}

/** A bubble: a decaying sine whose pitch rises by `chirp` per second. */
function blub(out: Float32Array, sr: number, i0: number, f: number, tau: number, amp: number, chirp: number) {
  const len = out.length
  const n = Math.min(len, Math.ceil(tau * 6 * sr))
  const decay = Math.exp(-1 / (tau * sr))
  const w = (TAU * f) / sr
  const dw = (w * chirp) / sr
  let a = amp
  let ph = 0
  let j = i0
  for (let i = 0; i < n; i++) {
    ph += w + dw * i
    out[j] += a * Math.sin(ph) * (i < 48 ? i / 48 : 1)
    a *= decay
    if (++j === len) j = 0
  }
}

/** Noise-excited resonance at sample i0: a crackle or crunch around f, `burst` seconds of excitation. */
function crack(out: Float32Array, sr: number, rnd: Rnd, i0: number, f: number, tau: number, amp: number, burst: number) {
  const len = out.length
  const n = Math.min(len, Math.ceil((burst + tau * 7) * sr))
  const r = Math.exp(-1 / (tau * sr))
  const c = 2 * r * Math.cos((TAU * f) / sr)
  const r2 = r * r
  const nb = Math.max(1, Math.round(burst * sr))
  // the resonator gain grows with r; this keeps `amp` close to the peak of the grain
  const g = amp * (1 - r) * 4
  let y1 = 0
  let y2 = 0
  let j = i0
  for (let i = 0; i < n; i++) {
    const y = (i < nb ? (rnd() * 2 - 1) * (1 - i / nb) : 0) + c * y1 - r2 * y2
    y2 = y1
    y1 = y
    out[j] += y * g
    if (++j === len) j = 0
  }
}

/** One-pole low-pass run twice round the loop, so the state at the end equals the state at the start. */
function lowpass(buf: Float32Array, sr: number, fc: number) {
  const k = 1 - Math.exp((-TAU * fc) / sr)
  let y = 0
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < buf.length; i++) {
      y += (buf[i] - y) * k
      if (pass === 1) buf[i] = y
    }
  }
}

function highpass(buf: Float32Array, sr: number, fc: number) {
  const k = 1 - Math.exp((-TAU * fc) / sr)
  let y = 0
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < buf.length; i++) {
      y += (buf[i] - y) * k
      if (pass === 1) buf[i] -= y
    }
  }
}

/** Slow amplitude swell made of whole cycles per loop (so it loops too), evaluated once per block. */
function swell(buf: Float32Array, gain: number, cyclesA: number, depthA: number, cyclesB: number, depthB: number) {
  const BLOCK = 128
  for (let i0 = 0; i0 < buf.length; i0 += BLOCK) {
    const t = i0 / buf.length
    const g = gain * (1 + depthA * Math.sin(TAU * cyclesA * t) + depthB * Math.sin(TAU * cyclesB * t + 1))
    const end = Math.min(buf.length, i0 + BLOCK)
    for (let i = i0; i < end; i++) buf[i] *= g
  }
}

const KNEE = 0.5
const CEILING = 0.9
/** Scales to the given RMS and rounds off the rare peaks above KNEE so nothing exceeds CEILING. */
function level(buf: Float32Array, rms: number) {
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  const g = rms / Math.sqrt(sum / buf.length || 1)
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] * g
    const a = v < 0 ? -v : v
    buf[i] = a <= KNEE ? v : Math.sign(v) * (KNEE + (CEILING - KNEE) * Math.tanh((a - KNEE) / (CEILING - KNEE)))
  }
  return buf
}

export function whiteNoise(sr: number, rnd: Rnd, seconds: number) {
  const out = new Float32Array(Math.round(sr * seconds))
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 2 - 1
  return out
}

/** -3 dB per octave (Paul Kellet's economy filter), run twice round the loop like the other filters. */
export function pinkNoise(sr: number, rnd: Rnd, seconds: number) {
  const out = whiteNoise(sr, rnd, seconds)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < out.length; i++) {
      const w = out[i]
      b0 = 0.99765 * b0 + w * 0.099046
      b1 = 0.963 * b1 + w * 0.2965164
      b2 = 0.57 * b2 + w * 1.0526913
      if (pass === 1) out[i] = b0 + b1 + b2 + w * 0.1848
    }
  }
  return level(out, 0.25)
}

/**
 * Glass beads knocking together: `rate` clicks per second, each a ringing ping between f0 and f1, over the soft
 * hiss of their rolling. Used sparse for the river and dense for ploughing and bead scatters. (While the doctor
 * wades in the ad, 0.9-3.4 s, its sound track gains a rattle that is level from 4 to 9 kHz.)
 */
export function beads(sr: number, rnd: Rnd, seconds: number, rate: number, f0: number, f1: number) {
  const out = whiteNoise(sr, rnd, seconds)
  lowpass(out, sr, 1700)
  highpass(out, sr, 700)
  highpass(out, sr, 700)
  swell(out, 0.55, 3, 0.35, 7, 0.25)
  const n = Math.round(seconds * rate)
  for (let k = 0; k < n; k++) {
    const a = rnd()
    ping(out, sr, Math.floor(rnd() * out.length), octaves(rnd, f0, f1), between(rnd, 0.0012, 0.004), 0.15 + a * a * a)
  }
  return level(out, 0.12)
}

/** Log fire: a fluttering low roar with crackles and the odd loud pop. */
export function fire(sr: number, rnd: Rnd, seconds: number) {
  const out = whiteNoise(sr, rnd, seconds)
  lowpass(out, sr, 300)
  lowpass(out, sr, 600)
  highpass(out, sr, 90)
  swell(out, 1.3, 13, 0.3, 29, 0.22)
  const n = Math.round(seconds * 15)
  for (let k = 0; k < n; k++) {
    const loud = rnd() < 0.12
    crack(out, sr, rnd, Math.floor(rnd() * out.length), octaves(rnd, 900, 4200), between(rnd, 0.0006, 0.003), loud ? between(rnd, 0.6, 1) : between(rnd, 0.1, 0.4), loud ? 0.004 : 0.0015)
  }
  return level(out, 0.1)
}

/** Thick liquid on the boil: rising "blub" chirps. */
export function bubbling(sr: number, rnd: Rnd, seconds: number) {
  const out = new Float32Array(Math.round(sr * seconds))
  const n = Math.round(seconds * 13)
  for (let k = 0; k < n; k++) {
    const f = octaves(rnd, 190, 720)
    // small bubbles are short and rise fast, big ones are slow
    blub(out, sr, Math.floor(rnd() * out.length), f, between(rnd, 0.012, 0.03) * (400 / f + 0.5), between(rnd, 0.25, 1), between(rnd, 6, 16))
  }
  return level(out, 0.1)
}

/**
 * Glass being chewed by steel rollers: dense crunches with tinkles on top. In the ad the grinder is a hiss that is
 * level from 3 to 10 kHz (5.5-7.1 s and 40.9-42.8 s of its sound track), so the crunches sit in that band.
 */
export function crunch(sr: number, rnd: Rnd, seconds: number) {
  const out = new Float32Array(Math.round(sr * seconds))
  const n = Math.round(seconds * 60)
  for (let k = 0; k < n; k++) {
    const i0 = Math.floor(rnd() * out.length)
    if (rnd() < 0.3) ping(out, sr, i0, octaves(rnd, 4000, 11000), between(rnd, 0.002, 0.012), between(rnd, 0.1, 0.45))
    else crack(out, sr, rnd, i0, octaves(rnd, 1500, 7000), between(rnd, 0.0006, 0.003), between(rnd, 0.2, 1), between(rnd, 0.002, 0.012))
  }
  return level(out, 0.13)
}

/**
 * A stream of coins striking each other. The shower on the pallet in the ad (14.9-15.8 s) has most of its energy
 * between 9 and 10 kHz, some 10 dB less from 4 to 8 kHz and nothing above: every clink rings there, over two
 * weaker partials below.
 */
export function coins(sr: number, rnd: Rnd, seconds: number) {
  const out = new Float32Array(Math.round(sr * seconds))
  const n = Math.round(seconds * 46)
  for (let k = 0; k < n; k++) {
    const i0 = Math.floor(rnd() * out.length)
    const f = between(rnd, 9000, 9900)
    const a = between(rnd, 0.3, 1)
    const tau = between(rnd, 0.005, 0.015)
    ping(out, sr, i0, f, tau, a)
    ping(out, sr, i0, f * between(rnd, 0.74, 0.8), tau * 1.2, a * 0.3)
    ping(out, sr, i0, f * between(rnd, 0.56, 0.64), tau * 1.5, a * 0.35)
  }
  return level(out, 0.1)
}

/** Iron-shod wooden wheels on dirt: a low rumble with loose-plank rattles. */
export function wheels(sr: number, rnd: Rnd, seconds: number) {
  const out = whiteNoise(sr, rnd, seconds)
  lowpass(out, sr, 130)
  lowpass(out, sr, 260)
  highpass(out, sr, 55)
  swell(out, 9, 5, 0.25, 11, 0.2)
  const n = Math.round(seconds * 12)
  for (let k = 0; k < n; k++) {
    crack(out, sr, rnd, Math.floor(rnd() * out.length), octaves(rnd, 260, 720), between(rnd, 0.004, 0.012), between(rnd, 0.1, 0.5), 0.003)
  }
  return level(out, 0.12)
}

/** Reverb impulse response: a short, darkening tail (a walled courtyard, not a hall). */
export function impulse(sr: number, rnd: Rnd, seconds: number) {
  const out = new Float32Array(Math.round(sr * seconds))
  const decay = Math.exp(-6.9 / out.length)
  const fadeIn = 0.004 * sr
  let a = 1
  let y = 0
  let k = 1
  for (let i = 0; i < out.length; i++) {
    // the low-pass closes from 9 kHz to 1.5 kHz along the tail
    if ((i & 127) === 0) k = 1 - Math.exp((-TAU * (9000 - (7500 * i) / out.length)) / sr)
    y += ((rnd() * 2 - 1) * a - y) * k
    out[i] = i < fadeIn ? (y * i) / fadeIn : y
    a *= decay
  }
  return out
}
