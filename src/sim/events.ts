// Events are how the simulation tells the presentation layer (view, VFX, camera, audio) that something
// discrete happened. The sim pushes them with emit(); the host drains state.events once per rendered frame.
// Positions are world coordinates on the ground unless a `y` is given.
import type { BubbleSize, ToolKind, UnlockId } from '../config'
import type { GameState } from './types'

export type GameEvent =
  // --- tools & river (sim/player.ts, sim/river.ts) ---
  | { type: 'toolGrab'; tool: number; kind: ToolKind }
  | { type: 'toolPark'; tool: number; kind: ToolKind; x: number; z: number }
  | { type: 'cartMount' }
  | { type: 'cartDismount' }
  | { type: 'toolSwap'; tool: number; kind: ToolKind; x: number; z: number } // a tool appeared (unlock glow): the cart in place of the scoop, or the spare scoop when the driver takes the cart
  | { type: 'bubbleSpawn'; id: number; size: BubbleSize }
  | { type: 'bubbleDock'; id: number; tool: number; x: number; z: number; r: number; byPlayer: boolean }
  | { type: 'bubbleReject'; id: number; x: number; z: number } // oversize bubble hit the hand scoop
  | { type: 'bubbleFall'; id: number; x: number; z: number; r: number } // rolled over the cliff
  // --- grinder & flasks (sim/grinder.ts, sim/flasks.ts) ---
  | { type: 'grindStart'; x: number; z: number; r: number; size: BubbleSize }
  | { type: 'grindCrack'; x: number; z: number; r: number }
  | { type: 'grindShell'; x: number; z: number; r: number }
  | { type: 'grindShatter'; x: number; z: number; r: number }
  | { type: 'grindEnd' }
  | { type: 'flaskEject'; id: number; fromX: number; fromZ: number; toX: number; toZ: number }
  | { type: 'flaskPickup'; fromX: number; fromZ: number; by: 'player' | 'porter'; unitAdded: boolean }
  | { type: 'flaskThrow'; fromX: number; fromZ: number; fromY: number; by: 'player' | 'porter' }
  | { type: 'flaskLand'; potion: number }
  // --- crowd & bath (sim/crowd.ts, sim/bath.ts) ---
  | { type: 'gateOpen' }
  | { type: 'gateClose' }
  | { type: 'villagerRelease'; id: number }
  | { type: 'bathHopIn'; id: number }
  | { type: 'bathSplash'; count: number } // batch landed in the pot (label flips to n/n, camera shake)
  | { type: 'bathCured'; count: number } // pie complete -> check mark
  | { type: 'bathHopOut'; id: number }
  | { type: 'coinFountain'; x: number; z: number; gold: number; meshes: number; duration: number } // from a bather to the pallet
  // --- ward (sim/ward.ts) ---
  | { type: 'patientLie'; bed: number; id: number }
  | { type: 'needsNurse'; bed: number }
  | { type: 'treatStart'; bed: number }
  | { type: 'treatJab'; bed: number }
  | { type: 'healed'; bed: number; id: number; x: number; z: number }
  | { type: 'nursesSpawn'; ward: 1 | 2; x: number; z: number }
  | { type: 'discharged'; id: number; count: number }
  // --- drill (sim/drill.ts) ---
  | { type: 'drillCrewJoin'; id: number; crew: number }
  | { type: 'drillPush' }
  | { type: 'drillKill'; x: number; z: number; rats: number } // start of the rat massacre / coin fountain
  | { type: 'drillHeapLift'; gold: number } // heap flies to the HUD
  | { type: 'drillPaid'; gold: number }
  | { type: 'swarmReady' }
  // --- economy (sim/economy.ts, sim/pads.ts) ---
  | { type: 'coinPickupStart' }
  | { type: 'coinPickupEnd'; gold: number }
  | { type: 'bursarCollect'; gold: number }
  | { type: 'padPop'; id: UnlockId; x: number; z: number }
  | { type: 'padPayStart'; id: UnlockId }
  | { type: 'padPaid'; id: UnlockId; x: number; z: number }
  | { type: 'unlock'; id: UnlockId; x: number; z: number }
  // --- misc ---
  | { type: 'emoji'; kind: 'scared' | 'happy'; who: 'player' | 'driver' }
  | { type: 'guide'; kind: 'none' | 'flasks' | 'pallet' | 'pad' }
  | { type: 'win' }

export type EventType = GameEvent['type']
export type EventOf<T extends EventType> = Extract<GameEvent, { type: T }>

export const emit = (s: GameState, e: GameEvent) => {
  s.events.push(e)
}
