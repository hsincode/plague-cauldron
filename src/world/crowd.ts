// Deterministic standing slots of the sick crowd, shared by sim (count only) and view (instances).
import { L, P } from '../config'

export interface CrowdSlot {
  x: number
  z: number
  /** 0..1 pseudo-random per slot, for visual variation. */
  seed: number
}

const hash = (i: number) => {
  let t = (i * 0x9e3779b1 + 0x6d2b79f5) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function build(): CrowdSlot[] {
  const cand: (CrowdSlot & { dist: number })[] = []
  const pitch = P.CROWD_PITCH
  const rowH = pitch * 0.866
  let i = 0
  for (let row = 0; row < 60; row++) {
    const z = -10 + row * rowH
    if (z > 22) break
    for (let col = 0; col < 40; col++) {
      const x = L.CROWD_EDGE_X - 0.5 - col * pitch - (row % 2 ? pitch / 2 : 0)
      if (x < -30) break
      i++
      // keep out of the pen bay (fence arc) with a small margin
      const dp = Math.hypot(x - L.PEN.x, z - L.PEN.z)
      if (dp < L.PEN.r + 0.55) continue
      // keep out of the rat field / drill area south of ward-1
      if (z > 12.6 && x > -5.6) continue
      const jx = (hash(i * 3 + 1) - 0.5) * 0.22
      const jz = (hash(i * 3 + 2) - 0.5) * 0.22
      cand.push({ x: x + jx, z: z + jz, seed: hash(i * 3), dist: Math.hypot(x - L.PEN_GATE.x, z - L.PEN_GATE.z) })
    }
  }
  // Nearest to the gate first, keep TOTAL_VILLAGERS of them, then order farthest-first so that
  // "remaining = n" means slots [TOTAL - n, TOTAL) are occupied (the far ones leave first, SPEC 2.7).
  cand.sort((a, b) => a.dist - b.dist)
  const kept = cand.slice(0, P.TOTAL_VILLAGERS)
  kept.reverse()
  return kept.map(({ x, z, seed }) => ({ x, z, seed }))
}

/** Slots ordered farthest-from-gate first. With `remaining` villagers left, slots [length - remaining, length) are occupied. */
export const CROWD_SLOTS: readonly CrowdSlot[] = build()
