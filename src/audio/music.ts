// A quiet generative music bed: four chords in 6/8, a plucked arpeggio with random rests, a soft drone and now
// and then a few notes of melody. It only uses chord tones of Am7 - Fmaj7 - C - G6, so it cannot clash with the
// pitched effects (C major pentatonic). Notes are scheduled a little ahead of the audio clock from update().
import type { Mixer } from './mixer'
import { midi } from './sounds'

const EIGHTH = 0.36
/** Two bars of 6/8 per chord. */
const STEPS = 12
const LOOKAHEAD = 0.25
const FADE_IN = 4

/** Root of the drone and the four tones the arpeggio walks over. */
const CHORDS = [
  { root: 45, tones: [57, 60, 64, 67] },
  { root: 41, tones: [53, 57, 60, 64] },
  { root: 48, tones: [55, 60, 64, 67] },
  { root: 43, tones: [55, 59, 62, 64] },
]
/** Arpeggio shapes over the two bars: index into the tones (4..7 = an octave up), -1 = rest. */
const SHAPES = [
  [0, 2, 3, 5, 3, 2, 0, 1, 2, 4, 2, 1],
  [0, 1, 2, 3, 2, 1, 0, 2, 3, 6, 3, 2],
  [0, 2, 4, 3, -1, 2, 0, 3, 5, 4, -1, 1],
]

export interface Music {
  update(): void
}

export function createMusic(m: Mixer): Music {
  const { ctx } = m
  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 1900
  const fade = ctx.createGain()
  fade.gain.setValueAtTime(0, ctx.currentTime)
  fade.gain.linearRampToValueAtTime(1, ctx.currentTime + FADE_IN)
  tone.connect(fade).connect(m.bus.music)

  let next = ctx.currentTime + 0.6
  let step = 0
  let shape = SHAPES[0]!
  let melody = false

  const pluck = (t: number, note: number, vel: number) => {
    const f = midi(note)
    m.tone(tone, t, 'triangle', f, f, 1.7, 0.5 * vel, 0.004)
    m.tone(tone, t, 'sine', f * 2, f * 2, 0.7, 0.1 * vel, 0.004)
  }

  const schedule = (t: number) => {
    const chord = CHORDS[Math.floor(step / STEPS) % CHORDS.length]!
    const k = step % STEPS
    if (k === 0) {
      shape = SHAPES[Math.floor(m.rnd() * SHAPES.length)]!
      melody = m.rnd() < 0.55
      // drone: root and fifth swell in and die away under the next chord
      const len = STEPS * EIGHTH
      m.tone(tone, t, 'sine', midi(chord.root + 12), midi(chord.root + 12), len + 1.6, 0.13, 1.4, true)
      m.tone(tone, t, 'sine', midi(chord.root + 19), midi(chord.root + 19), len + 1.6, 0.06, 1.8, true)
      m.tone(tone, t, 'sine', midi(chord.root), midi(chord.root), 2.4, 0.2, 0.02)
    }
    const i = shape[k]!
    // the downbeats always sound; elsewhere a quarter of the notes rest
    if (i >= 0 && (k % 6 === 0 || m.rnd() < 0.75)) {
      pluck(t + m.rnd() * 0.012, chord.tones[i % 4]! + (i >= 4 ? 12 : 0), k % 6 === 0 ? 1 : 0.45 + m.rnd() * 0.3)
    }
    if (melody && k >= 3 && k % 3 === 0 && m.rnd() < 0.6) {
      const f = midi(chord.tones[1 + Math.floor(m.rnd() * 3)]! + 12)
      m.tone(tone, t, 'sine', f, f, 1.4, 0.16, 0.012)
    }
  }

  return {
    update() {
      const now = ctx.currentTime
      // after a pause (hidden tab) the missed steps are skipped, not played in a burst
      if (next < now) next = now + 0.05
      while (next < now + LOOKAHEAD) {
        schedule(next)
        step++
        next += EIGHTH
      }
    },
  }
}
