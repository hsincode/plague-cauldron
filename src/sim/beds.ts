// Bed bookkeeping shared by the bath (reserves a bed per bather) and the ward (occupies/frees them).
import type { GameState } from './types'

/** Beds that exist and are neither reserved nor occupied. */
export function freeBedCount(s: GameState): number {
  let n = 0
  for (const b of s.beds) if (b.exists && b.state === 'free') n++
  return n
}

/** Reserve the first free bed in fill order for a villager. Returns the bed id or -1. */
export function reserveBed(s: GameState, villagerId: number): number {
  for (const b of s.beds) {
    if (b.exists && b.state === 'free') {
      b.state = 'reserved'
      b.villager = villagerId
      b.lieT = 0
      b.treatT = -1
      return b.id
    }
  }
  return -1
}

export function releaseBed(s: GameState, bedId: number) {
  const b = s.beds[bedId]
  if (!b) return
  b.state = 'free'
  b.villager = -1
  b.lieT = 0
  b.treatT = -1
}
