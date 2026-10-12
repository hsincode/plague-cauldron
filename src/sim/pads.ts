// Price pads (SPEC 2.9, 3.2): appearance triggers, paying by standing next to a pad, and setting the unlock flag.
// Pads are bought strictly in UNLOCKS order; the effects of an unlock live in the system that owns them.
import { P, UNLOCK_DISCHARGE_GATE } from '../config'
import { clamp, dist2 } from '../core/math'
import { emit } from './events'
import type { GameState, Pad } from './types'

/** Pad A pops this long after a bathed patient lies in a bed that has no nurse (SPEC 3.2). */
export const PAD_A_DELAY = 0.2
/** Deadlock guard for pad B: by this many discharges the first sortie is certainly over, whatever happened to its flag. */
const PAD_B_DISCHARGED_FALLBACK = 4

/** Seconds the wallet takes to count down the whole price (SPEC 2.9). */
export const padPayDuration = (price: number) => clamp(price / 135, 0.5, 0.9)

function patientWithoutNurse(s: GameState): boolean {
  for (const b of s.beds) {
    if (!b.exists || b.state !== 'occupied') continue
    let nursed = false
    for (const n of s.nurses) {
      if (n.bed === b.id) {
        nursed = true
        break
      }
    }
    if (!nursed) return true
  }
  return false
}

function triggered(s: GameState, i: number): boolean {
  const pad = s.pads[i]!
  if (i > 0 && !s.unlocks[s.pads[i - 1]!.id]) return false
  switch (pad.id) {
    case 'nurses':
      return patientWithoutNurse(s)
    case 'usher':
      return s.flags.firstSortiePaid === true || s.stats.discharged >= PAD_B_DISCHARGED_FALLBACK
    case 'cart':
      return s.flags.pickupAfterUsher === true // set by economy.ts
    case 'ward2':
      return (s.cauldron.blockedByBeds && s.cauldron.blockedT > 0) || s.stats.discharged >= 8
    default:
      return s.stats.discharged >= (UNLOCK_DISCHARGE_GATE[pad.id] ?? 0)
  }
}

const setState = (pad: Pad, state: Pad['state']) => {
  pad.state = state
  pad.t = 0
}

export function stepPads(s: GameState, dt: number) {
  const pl = s.player
  const pads = s.pads
  let paying = false
  for (let i = 0; i < pads.length; i++) if (pads[i]!.state === 'paying') paying = true

  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i]!
    if (pad.state === 'gone') continue
    if (s.unlocks[pad.id]) {
      // unlocked from outside (restored save, debug key): nothing left to sell
      if (pad.state === 'paying') paying = false
      setState(pad, 'gone')
      continue
    }
    pad.t += dt
    switch (pad.state) {
      case 'hidden':
        if (!triggered(s, i)) pad.t = 0
        else if (pad.t >= (pad.id === 'nurses' ? PAD_A_DELAY : 0)) {
          setState(pad, 'popIn')
          emit(s, { type: 'padPop', id: pad.id, x: pad.x, z: pad.z })
        }
        break
      case 'popIn':
        if (pad.t >= P.PAD_POP_TIME) setState(pad, 'idle')
        break
      case 'idle':
        if (paying || !inPayRange(s, pad) || pl.stillT < P.PAD_PAY_DWELL || s.wallet < pad.price - pad.paid) break
        pad.state = 'paying'
        // While paying, t is the total time spent paying, so a resumed payment continues where the count stopped.
        pad.t = (pad.paid / pad.price) * padPayDuration(pad.price)
        paying = true
        emit(s, { type: 'padPayStart', id: pad.id })
        break
      case 'paying': {
        if (!inPayRange(s, pad)) {
          setState(pad, 'idle')
          paying = false
          break
        }
        const duration = padPayDuration(pad.price)
        const due = pad.t >= duration - 1e-9 ? pad.price : Math.floor((pad.price * pad.t) / duration + 1e-9)
        const n = Math.min(due - pad.paid, Math.floor(s.wallet))
        if (n > 0) {
          s.wallet -= n
          pad.paid += n
          pl.carriedGold = Math.max(0, pl.carriedGold - n)
        }
        if (pad.paid >= pad.price) {
          setState(pad, 'done')
          paying = false
        } else if (s.wallet < 1) {
          // the wallet ran dry under us (it was affordable when the payment started): wait for more gold
          setState(pad, 'idle')
          paying = false
        }
        break
      }
      case 'done':
        if (pad.t < P.PAD_DONE_DELAY) break
        setState(pad, 'gone')
        s.unlocks[pad.id] = true
        emit(s, { type: 'padPaid', id: pad.id, x: pad.x, z: pad.z })
        emit(s, { type: 'unlock', id: pad.id, x: pad.x, z: pad.z })
        break
    }
  }
}

function inPayRange(s: GameState, pad: Pad): boolean {
  return dist2(s.player.x, s.player.z, pad.x, pad.z) <= P.PAD_PAY_RADIUS * P.PAD_PAY_RADIUS
}
