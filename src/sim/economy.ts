// Coins (SPEC 2.8, 2.12): fountain gold landing on the pallet, the doctor's pickup, and the bursar.
// Every transfer moves whole gold, so pallet.gold + wallet (+ what is still airborne) is conserved exactly.
import { L, P } from '../config'
import { dist2 } from '../core/math'
import { emit } from './events'
import type { GameState, Pallet } from './types'

/** Gold per second the bursar sends from the pallet straight to the HUD (same ribbons as the rat heap). */
export const BURSAR_RATE = 300

export function stepEconomy(s: GameState, dt: number) {
  const p = s.pallet
  landFountains(p, dt)
  if (s.unlocks.bursar || p.bursarLeft > 0) stepBursar(s, p, dt)
  stepPickup(s, p, dt)
}

function landFountains(p: Pallet, dt: number) {
  const inc = p.incoming
  let w = 0
  let landed = false
  for (let i = 0; i + 1 < inc.length; i += 2) {
    const t = inc[i]! - dt
    if (t <= 1e-9) {
      p.gold += inc[i + 1]!
      landed = true
    } else {
      inc[w++] = t
      inc[w++] = inc[i + 1]!
    }
  }
  inc.length = w
  p.sinceLanding = landed ? 0 : p.sinceLanding + dt
  // A fountain is worth whole gold in total; this only removes float dust if a fee was split into fractions.
  if (landed && w === 0) p.gold = Math.round(p.gold)
}

function stepBursar(s: GameState, p: Pallet, dt: number) {
  if (p.bursarLeft <= 0) {
    if (p.collecting || p.gold < 1 || p.incoming.length > 0 || p.sinceLanding < P.BURSAR_DELAY) return
    p.bursarLeft = Math.floor(p.gold)
    p.acc = 0
    emit(s, { type: 'bursarCollect', gold: p.bursarLeft })
  }
  p.acc += BURSAR_RATE * dt
  const n = Math.min(Math.floor(p.acc), p.bursarLeft, Math.floor(p.gold))
  p.acc -= n
  p.gold -= n
  p.bursarLeft -= n
  s.wallet += n
  s.stats.totalGold += n
  if (p.bursarLeft <= 0 || p.gold < 1) {
    p.bursarLeft = 0
    p.acc = 0
  }
}

function stepPickup(s: GameState, p: Pallet, dt: number) {
  const pl = s.player
  const near = dist2(pl.x, pl.z, L.PALLET.x, L.PALLET.z) <= P.PALLET_PICKUP_RADIUS * P.PALLET_PICKUP_RADIUS
  const flying = p.incoming.length > 0
  // One pickup spans a whole fountain: the pallet may be bare between two coins landing without ending it.
  const active = near && p.bursarLeft <= 0 && (p.gold >= 1 || (p.collecting && flying))
  if (!active) {
    if (p.collecting) endPickup(s, p)
    return
  }
  if (!p.collecting) {
    p.collecting = true
    p.picked = 0
    p.acc = 0
    emit(s, { type: 'coinPickupStart' })
  }
  p.acc += P.PICKUP_RATE * dt
  const n = Math.min(Math.floor(p.acc), Math.floor(p.gold))
  p.acc -= n
  if (n > 0) {
    p.gold -= n
    p.picked += n
    s.wallet += n
    pl.carriedGold += n
    s.stats.totalGold += n
  }
  if (p.gold < 1) {
    p.acc = 0 // no credit is banked while waiting for the next coin to land
    if (!flying) endPickup(s, p)
  }
}

function endPickup(s: GameState, p: Pallet) {
  p.collecting = false
  p.acc = 0
  emit(s, { type: 'coinPickupEnd', gold: p.picked })
  // Walking off between two coins of a fountain leaves the rest of it to land: that pallet was not emptied.
  if (p.picked > 0 && p.gold < 1 && p.incoming.length === 0) {
    p.pickups++
    // Pad C waits for "the next pallet pickup after the usher was bought" (SPEC 3.2); pads.ts reads this flag.
    if (s.unlocks.usher) s.flags.pickupAfterUsher = true
  }
  p.picked = 0
}
