// One simulation step. dt must be <= 1/60 (the host sub-steps longer frames). Order matters:
// movers first, then the river reacts to the tools, then the production chain from the grinder downstream.
import { stepBath } from './bath'
import { stepCrowd } from './crowd'
import { stepDrill } from './drill'
import { stepEconomy } from './economy'
import { stepFlasks } from './flasks'
import { stepGrinder } from './grinder'
import { stepGuide } from './guide'
import { stepHelpers } from './helpers'
import { stepPads } from './pads'
import { stepPlayer } from './player'
import { stepRiver } from './river'
import type { GameState, Input } from './types'
import { stepWard } from './ward'

export const MAX_DT = 1 / 60

export function step(s: GameState, input: Input, dt: number) {
  s.time += dt
  stepPlayer(s, input, dt) // player.ts: movement modes, static collisions, tool grab/park/mount, unlock 'cart'
  stepHelpers(s, dt) // helpers.ts: porter and cart driver (unlocks 'porter', 'driver')
  stepRiver(s, dt) // river.ts: balls, bubbles, docking/rejection against every tool blade
  stepGrinder(s, dt) // grinder.ts: accepts a docked bubble, grinding timeline, flask ejection
  stepFlasks(s, dt) // flasks.ts: player pickup from the pile, pouring into the cauldron, flasks in flight
  stepCrowd(s, dt) // crowd.ts: gate, manual release, usher, queue walking (unlock 'usher')
  stepBath(s, dt) // bath.ts: batch state machine, potion use, coin fountains (unlock 'bigCauldron')
  stepWard(s, dt) // ward.ts: toBed..toExit, nurses, treatment timeline (unlocks 'nurses', 'ward2')
  stepDrill(s, dt) // drill.ts: crew, sortie, reward, swarm regrow (unlock 'drill2')
  stepEconomy(s, dt) // economy.ts: pallet landing + pickup, bursar (unlock 'bursar')
  stepPads(s, dt) // pads.ts: pad appearance triggers, paying, unlock application
  stepGuide(s, dt) // guide.ts: guide arrow target, win condition, housekeeping of 'gone' villagers
}

/** Advance by an arbitrary frame time using sub-steps of at most MAX_DT. */
export function advance(s: GameState, input: Input, frameDt: number) {
  const n = Math.max(1, Math.ceil(frameDt / MAX_DT - 1e-9))
  const dt = frameDt / n
  for (let i = 0; i < n; i++) step(s, input, dt)
}
