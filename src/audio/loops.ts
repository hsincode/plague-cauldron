// The loop buffers behind every bed and noise voice: the two noise colours and the dense textures of
// audio/textures.ts. Rendering them costs some 50 ms of a fast CPU, far too long for the click that starts the
// sound, so createAudio() renders them ahead of it, one per idle slice while the title is up. They belong to no
// context and have a fixed rate: the live context and every offline render play the same buffers, resampled by
// their sources where the rates differ.
import { type Rnd, beads, bubbling, coins, crunch, fire, pinkNoise, wheels, whiteNoise, xorshift } from './textures'

export type NoiseColor = 'white' | 'pink'
export type TextureName = 'river' | 'plough' | 'fire' | 'bubbling' | 'crunch' | 'coins' | 'wheels'
export type LoopName = NoiseColor | TextureName

const RATE = 48000

// loop lengths are mutually prime-ish so the beds never line up twice the same way
const RECIPES: Record<LoopName, (rnd: Rnd) => Float32Array> = {
  white: rnd => whiteNoise(RATE, rnd, 2.0),
  pink: rnd => pinkNoise(RATE, rnd, 2.7),
  river: rnd => beads(RATE, rnd, 5.3, 150, 3000, 9500),
  plough: rnd => beads(RATE, rnd, 2.9, 420, 2000, 7500),
  fire: rnd => fire(RATE, rnd, 4.7),
  bubbling: rnd => bubbling(RATE, rnd, 3.7),
  crunch: rnd => crunch(RATE, rnd, 1.9),
  coins: rnd => coins(RATE, rnd, 2.3),
  wheels: rnd => wheels(RATE, rnd, 3.1),
}
const NAMES = Object.keys(RECIPES) as LoopName[]

export interface Loops {
  /** The buffer of a loop, rendered on the spot if it is not there yet. */
  get(name: LoopName): AudioBuffer
  /** Renders one loop that is still missing; false when none was left. */
  renderNext(): boolean
}

export function createLoops(): Loops {
  const buffers: Partial<Record<LoopName, AudioBuffer>> = {}
  const get = (name: LoopName) => {
    let b = buffers[name]
    if (!b) {
      // each loop has its own noise source, so its content does not depend on the order they are rendered in
      const data = RECIPES[name](xorshift(Math.imul(NAMES.indexOf(name) + 1, 0x9e3779b9)))
      b = buffers[name] = new AudioBuffer({ length: data.length, sampleRate: RATE })
      b.getChannelData(0).set(data)
    }
    return b
  }
  return {
    get,
    renderNext() {
      const name = NAMES.find(n => !buffers[n])
      if (name) get(name)
      return name !== undefined
    },
  }
}
