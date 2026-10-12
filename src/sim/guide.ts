// Last system of a step: the guide arrow (SPEC 2.11), the win condition (SPEC 3.4) and end-of-step housekeeping.
import { L, P } from '../config'
import { emit } from './events'
import type { GameState, Guide } from './types'

/** The arrow sits lower over the first flask pile than over the pallet and the pads (SPEC review log). */
export const FLASK_ARROW_HOVER = 1.5
/** Headless runs never drain the event queue; beyond this many unread events the oldest half is dropped. */
export const MAX_UNREAD_EVENTS = 5000

// Scratch target of pickTarget() (module-level so that no object is allocated per step).
let kind: Guide['kind'] = 'none'
let tx = 0
let tz = 0
let ty = 0

const aim = (k: Guide['kind'], x: number, z: number, y: number) => {
  kind = k
  tx = x
  tz = z
  ty = y
}

/** True once every ejected flask of the pile lies on the ground; aims at the centre of the pile. */
function aimAtRestingPile(s: GameState): boolean {
  const fl = s.groundFlasks
  if (fl.length === 0 || s.grinder.toEject > 0) return false
  let sx = 0
  let sz = 0
  for (let i = 0; i < fl.length; i++) {
    const f = fl[i]!
    if (f.age < P.FLASK_EJECT_FLIGHT) return false
    sx += f.x
    sz += f.z
  }
  aim('flasks', sx / fl.length, sz / fl.length, FLASK_ARROW_HOVER)
  return true
}

function pickTarget(s: GameState) {
  kind = 'none'
  if (s.won) return

  // 1. The first flask pile of the game, from the last flask landing until anybody starts picking it up.
  if (!s.flags.firstPileDone) {
    const c = s.cauldron
    if (s.player.flasks > 0 || s.flaskHalf !== 0 || s.porter.flasks > 0 || c.potion > 0 || c.incoming.length > 0) s.flags.firstPileDone = true
    else if (aimAtRestingPile(s)) return
  }

  // 2. The pallet once the fountain has ended, until the pickup starts. The bursar makes it pointless.
  const p = s.pallet
  if (!s.unlocks.bursar && p.gold >= 1 && p.incoming.length === 0 && !p.collecting) {
    aim('pallet', L.PALLET.x, L.PALLET.z, P.ARROW_HOVER)
    return
  }

  // 3. A visible pad the player can afford, until its payment starts.
  for (let i = 0; i < s.pads.length; i++) {
    const pad = s.pads[i]!
    if ((pad.state === 'idle' || pad.state === 'popIn') && s.wallet >= pad.price - pad.paid) {
      aim('pad', pad.x, pad.z, P.ARROW_HOVER)
      return
    }
  }
}

function updateArrow(s: GameState) {
  pickTarget(s)
  const g = s.guide
  if (kind === 'none') {
    if (g.kind === 'none') return
    g.kind = 'none' // x/z/y stay so that the view can shrink the arrow out where it was
  } else {
    if (g.kind === kind && Math.abs(g.x - tx) < 1e-3 && Math.abs(g.z - tz) < 1e-3) return
    g.kind = kind
    g.x = tx
    g.z = tz
    g.y = ty
  }
  emit(s, { type: 'guide', kind })
}

function removeGoneVillagers(s: GameState) {
  const vs = s.villagers
  let w = 0
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i]!
    if (v.state !== 'gone') vs[w++] = v
  }
  vs.length = w
}

export function stepGuide(s: GameState, _dt: number) {
  if (!s.won && s.stats.discharged >= P.TOTAL_VILLAGERS) {
    s.won = true
    s.wonAt = s.time
    emit(s, { type: 'win' })
  }
  updateArrow(s)
  removeGoneVillagers(s)
  if (s.events.length > MAX_UNREAD_EVENTS) s.events.splice(0, s.events.length >> 1)
}
