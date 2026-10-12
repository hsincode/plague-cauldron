// Registry of the view modules that bind models to the simulation state. main.ts calls createViews() once.
// Order = update order: stations (static props, UI decals), actors (doctor, villagers, staff; they publish
// ctx.anchors), river (balls, bubbles, tools, grinder, flasks), drill (drill, rats, sortie), coins.
import type { GameState } from '../sim/types'
import { createActorsView } from './actorsView'
import { defaultAnchors } from './anchors'
import { createCoinsView } from './coinsView'
import { createDrillView } from './drillView'
import { createRiverView } from './riverView'
import { createStationsView } from './stationsView'
import type { ViewCtx, ViewModule } from './types'

const FACTORIES: Record<string, (ctx: ViewCtx) => ViewModule | null> = {
  stations: createStationsView,
  actors: createActorsView,
  river: createRiverView,
  drill: createDrillView,
  coins: createCoinsView,
}

/**
 * Builds every view (or only those named in `only`, e.g. ?views=river,coins). A view that throws while it is being
 * built or updated is reported once and switched off, so one broken module cannot blank the whole game.
 *
 * `warm` is a throwaway state that each view is shown once, as soon as it is built, so that the models it only builds
 * when the state first needs them exist before the game starts (see the warm-up in main.ts). A view that cannot
 * draw that state loses its warm-up and nothing else.
 */
export function createViews(ctx: ViewCtx, only?: string[], warm?: GameState): ViewModule[] {
  const out: ViewModule[] = []
  if (warm) defaultAnchors(ctx.anchors, warm)
  for (const [name, make] of Object.entries(FACTORIES)) {
    if (only && !only.includes(name)) continue
    let v: ViewModule | null = null
    try {
      v = make(ctx)
    } catch (err) {
      console.error(`[view:${name}] create failed`, err)
    }
    if (!v) continue
    const inner = v
    if (warm) {
      try {
        inner.update(warm, 0, 0)
      } catch (err) {
        console.warn(`[view:${name}] warm-up failed`, err)
      }
    }
    let dead = false
    const guard = (fn: () => void) => {
      if (dead) return
      try {
        fn()
      } catch (err) {
        dead = true
        console.error(`[view:${name}] disabled after error`, err)
      }
    }
    out.push({
      update: (s, dt, time) => guard(() => inner.update(s, dt, time)),
      onEvent: inner.onEvent ? (e, s) => guard(() => inner.onEvent!(e, s)) : undefined,
    })
  }
  if (warm) ctx.fx.clear()
  return out
}
