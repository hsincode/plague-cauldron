// Deterministic PRNG (mulberry32). The simulation must only use this, never Math.random,
// so that headless bot runs are reproducible.

export interface Rng {
  /** Internal state; plain number so the whole game state stays serialisable. */
  s: number
}

export const makeRng = (seed: number): Rng => ({ s: seed >>> 0 || 1 })

/** Uniform float in [0, 1). */
export const rand = (r: Rng): number => {
  r.s = (r.s + 0x6d2b79f5) >>> 0
  let t = r.s
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const randRange = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * rand(r)
export const randInt = (r: Rng, lo: number, hiInclusive: number) => lo + Math.floor(rand(r) * (hiInclusive - lo + 1))
export const randSign = (r: Rng) => (rand(r) < 0.5 ? -1 : 1)
export const pick = <T>(r: Rng, arr: readonly T[]): T => arr[Math.floor(rand(r) * arr.length)]!
