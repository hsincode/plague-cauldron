// The simulation state. Plain data only (no classes, no three.js) so that it can run headless under `bun test`
// and so that the view can read it freely. Every system in sim/*.ts mutates this state inside step().
//
// Conventions: positions are on the ground plane (x east, z south); `y` is height above ground where present.
// Headings follow core/math.ts (forward = (sin h, cos h)). All timers are in seconds.
import type { BubbleSize, ToolKind, UnlockId } from '../config'
import type { Rng } from '../core/rng'
import type { GameEvent } from './events'

/** Desired movement in WORLD space, magnitude 0..1 (the UI maps screen-relative input through SCREEN_UP/RIGHT). */
export interface Input {
  mx: number
  mz: number
}

export type PlayerMode = 'foot' | 'scoop' | 'cart'

export interface Player {
  x: number
  z: number
  vx: number
  vz: number
  heading: number
  /** foot = no tool in hand; scoop = pushing the hand scoop; cart = seated on the cart. */
  mode: PlayerMode
  /** Index into state.tools of the tool being held/driven, or -1. */
  tool: number
  /** > 0 while hopping onto the cart (counts down from CART_MOUNT_TIME); input is ignored meanwhile. */
  mountT: number
  /** > 0 while hopping off the cart. */
  dismountT: number
  /** True after the cart he drives delivered its bubble: the cart brakes and he hops off on the next movement input. */
  dismountPending: boolean
  /** > 0 while being shoved by an oversize bubble. */
  pushedT: number
  pushVx: number
  pushVz: number
  /** Seconds the speed has been below PAD_PAY_MAX_SPEED. */
  stillT: number
  /** Carried flask units (the stack on the back). */
  flasks: number
  /** Gold collected from the pallet and not yet spent: drives the coin column on the back. */
  carriedGold: number
  emoji: 'none' | 'scared' | 'happy'
  /** Emoji timeline: negative = delay before it shows, then counts up while visible; emoji resets to 'none' when done. */
  emojiT: number
  /** Countdown before the next flask leaves the stack toward the cauldron. */
  depositT: number
  /** Fractional accumulators for rate-based transfers. */
  pickupAcc: number
  /** Total distance walked (drives walk animation / footsteps). */
  odo: number
}

export interface Tool {
  kind: ToolKind
  /** Pose of the holder anchor (see world/tools.ts). When held this equals the holder's pose. */
  x: number
  z: number
  heading: number
  holder: 'none' | 'player' | 'driver'
  /** A parked tool can only be grabbed when armed; it re-arms once the player has been farther than its rearm distance. */
  armed: boolean
  /** Docked bubble id, or -1. */
  bubble: number
  /** False while the tool does not exist in the world (e.g. the hand scoop after the cart replaced it). */
  exists: boolean
  /** Seconds since the tool (re)appeared in the world; the view plays the pop-in/golden glow from it. */
  age: number
}

export const BALL_FLOW = 0 // in the river, driven by the flow field
export const BALL_LOOSE = 1 // displaced by a tool/bubble, outside the bed or airborne
export const BALL_STRAY = 2 // resting on the bank, static
export const BALL_FALL = 3 // going over the cliff; recycled at the source when t runs out

export interface Balls {
  n: number
  x: Float32Array
  z: Float32Array
  /** Height of the ball centre above the ground minus the radius (0 = resting). Used by bursts and the fall. */
  y: Float32Array
  vx: Float32Array
  vz: Float32Array
  vy: Float32Array
  state: Uint8Array
  /** Time in the current state. */
  t: Float32Array
}

export type BubbleState = 'drift' | 'docking' | 'docked' | 'grinder' | 'gone'

export interface Bubble {
  id: number
  size: BubbleSize
  /** Radius. */
  r: number
  x: number
  z: number
  vx: number
  vz: number
  /** Rolling angle (radians) accumulated from travel, for the view. */
  roll: number
  state: BubbleState
  /** Time in the current state. */
  t: number
  /** Tool index while docking/docked, else -1. */
  tool: number
  /** Seconds since spawn (fade-in at the source). */
  age: number
}

export interface Grinder {
  state: 'idle' | 'grinding'
  /** Seconds since the bubble came to rest on the tray (grinding only). */
  t: number
  /** Bubble being ground, or -1. The Bubble stays in state.bubbles in state 'grinder' until GRIND_SHARDS, then is removed. */
  bubble: number
  size: BubbleSize
  /** Rest position/radius of the bubble on the tray (kept after the Bubble object is removed, for the shard effect). */
  bx: number
  bz: number
  br: number
  /** Ground flask meshes still to eject. */
  toEject: number
  ejectT: number
  /** Disc spin angle (radians), for the view. */
  spin: number
}

/** A flask lying on the ground west of the grinder (half a carried unit). */
export interface GroundFlask {
  id: number
  x: number
  z: number
  /** Where it was ejected from (tray edge). */
  fromX: number
  fromZ: number
  /** Seconds since ejection; it is airborne while age < FLASK_EJECT_FLIGHT and cannot be picked up. */
  age: number
  /** Yaw on the ground, for the view. */
  rot: number
}

export type BathState = 'empty' | 'preHop' | 'hopIn' | 'curing' | 'check' | 'hopOut'

export interface Cauldron {
  /** Potion units in the pot (flasks that have landed). */
  potion: number
  capacity: number
  /** Bath slots (2, or 4 after 'bigCauldron'). */
  slots: number
  /** Remaining flight times of flasks thrown at the pot (they count toward capacity while airborne). */
  incoming: number[]
  bath: BathState
  /** Time in the current bath state. */
  t: number
  /** Villager ids in the current batch. */
  bathers: number[]
  /** Number of batches completed (the first pays double). */
  batches: number
  /** Seconds the bath has been unable to start although villagers are queued (drives partial batches and pad D). */
  blockedT: number
  /** True while the last blocking reason was "no free bed". */
  blockedByBeds: boolean
  /** Seconds since the last flask landed (the view over-brightens the surface briefly). */
  sinceFill: number
  /** Seconds a reduced batch (big-cauldron partial batch / end-of-crowd leftovers) has been possible; owned by sim/bath.ts. */
  waitT: number
  /** Coin fountains waiting FOUNTAIN_DELAY after a bather landed outside: [delay, villagerId, gold, ...]; owned by sim/bath.ts. */
  fountains: number[]
}

export type VillagerState =
  // owned by sim/crowd.ts + sim/bath.ts
  | 'toQueue' // walking from the gate to a queue slot
  | 'queued' // standing in a queue slot (may shuffle forward)
  | 'preHop' // selected for the batch, waiting BATH_PRE_HOP_WAIT (+ stagger)
  | 'hopIn' // parabola over the west rim
  | 'bathing' // chest-deep in the pot
  | 'hopOut' // parabola over the east rim
  // owned by sim/ward.ts
  | 'toBed' // bathed, walking to the reserved bed
  | 'lieDown' // rolling onto the bed
  | 'inBed' // lying; nurse timeline is tracked on the Bed
  | 'cheer' // sitting up, fist raised
  | 'hopOff' // hopping off the bed
  | 'toExit' // healed, running out of the map (fades at the end of the path)
  // owned by sim/drill.ts
  | 'toDrill' // healed, running to the drill handle
  | 'atDrill' // waiting at the handle
  | 'pushing' // pushing the drill cart (position follows the drill)
  | 'gone' // removed at the end of this step

export interface Villager {
  id: number
  state: VillagerState
  /** Time in the current state. */
  t: number
  x: number
  z: number
  y: number
  heading: number
  /** sick = green skin, blue shirt; bathed = healthy skin + red wound glow; healed = fully cured. */
  look: 'sick' | 'bathed' | 'healed'
  /** Remaining waypoints as [x0, z0, x1, z1, ...]; pathI is the index of the next waypoint (in points). */
  path: number[]
  pathI: number
  speed: number
  /** Queue slot index while toQueue/queued, bath seat index while in the bath, else -1. */
  slot: number
  /** Reserved/occupied bed id, or -1. */
  bed: number
  /** Start/end of the current hop (hopIn, hopOut, lieDown, hopOff). */
  fromX: number
  fromZ: number
  toX: number
  toZ: number
  /** Per-state delay (e.g. hop stagger). */
  delay: number
  /** 0..1 visual variation. */
  seed: number
  /** 1 -> 0 fade while leaving the map. */
  alpha: number
}

export interface Gate {
  /** 0 closed .. 1 fully open. */
  open: number
  wantOpen: boolean
  /** Seconds since the last villager passed (closes after GATE_CLOSE_DELAY). */
  idleT: number
}

export interface Crowd {
  /** Villagers still standing in the crowd (not yet released). */
  remaining: number
  /** Total released so far. */
  released: number
  /** Villagers still to walk through the gate in the current release group. */
  pendingRelease: number
  releaseT: number
  /** Manual-release dwell timer. */
  manualT: number
}

export interface Usher {
  present: boolean
  x: number
  z: number
  heading: number
  /** True once standing at the post. */
  arrived: boolean
  /** Seconds since spawn. */
  age: number
}

export interface Bed {
  id: number
  ward: 1 | 2
  /** False for ward-2 beds until 'ward2' is bought. */
  exists: boolean
  state: 'free' | 'reserved' | 'occupied'
  /** Villager id (reserved or occupied), or -1. */
  villager: number
  /** Seconds the patient has been lying (occupied only). */
  lieT: number
  /** Nurse treatment timeline: -1 = not started, else seconds since t = 0 (SPEC 2.10 table). */
  treatT: number
  /** Seconds since the bed appeared (unlock glow). */
  age: number
}

export interface Nurse {
  id: number
  bed: number
  x: number
  z: number
  heading: number
  /** running = on the way from the pad to her post. */
  state: 'running' | 'idle' | 'treating'
  path: number[]
  pathI: number
  age: number
}

/** Door swing, 0 closed .. 1 fully open. Owned by sim/ward.ts: a door opens for healed villagers running out. */
export interface Doors {
  /** Ward-1 south door (L.WARD1_DOOR), swings outward. */
  south: number
  /** North double door of the yard / ward 2 (L.NORTH_DOOR). */
  north: number
}

export interface Pallet {
  /** Gold lying on the pallet (already landed). */
  gold: number
  /** Gold still airborne in fountains: [timeUntilLanding, amount, ...]. */
  incoming: number[]
  /** Seconds since the last fountain coin landed (guide arrow / bursar wait for the fountain to end). */
  sinceLanding: number
  /** Fractional accumulator for pickup. */
  acc: number
  /** True while the player is collecting this step. */
  collecting: boolean
  /** Number of completed pickups (pallet emptied by the player). */
  pickups: number
  /** Gold the player has taken in the pickup that is in progress (reported by 'coinPickupEnd'). */
  picked: number
  /** Gold still to fly to the HUD in the bursar's current collection (0 = bursar idle). */
  bursarLeft: number
}

export interface Pad {
  id: UnlockId
  state: 'hidden' | 'popIn' | 'idle' | 'paying' | 'done' | 'gone'
  /** Time in the current state. */
  t: number
  /** Gold paid so far (kept when the player walks away). */
  paid: number
  price: number
  x: number
  z: number
}

export type DrillState = 'parked' | 'pushing' | 'burst' | 'heap' | 'collect' | 'return'

export interface Drill {
  state: DrillState
  t: number
  x: number
  z: number
  heading: number
  /** Villager ids at the handle. */
  crew: number[]
  /** Seconds the first crew member has waited alone. */
  loneT: number
  /** Cone spin angle for the view. */
  spin: number
  sorties: number
  /** Reward of the sortie in progress. */
  reward: number
  /** Part of the reward already added to the wallet while the heap flies to the HUD. */
  paid: number
}

export interface Swarm {
  ready: boolean
  /** Seconds until ready again. */
  regrowT: number
  /** 0..1 how full the rat carpet is (view spawns RAT_COUNT * fill rats). */
  fill: number
}

export interface Porter {
  present: boolean
  state: 'idle' | 'toPile' | 'collect' | 'toPot' | 'pour' | 'toHome'
  t: number
  x: number
  z: number
  heading: number
  flasks: number
  depositT: number
  pickupAcc: number
  path: number[]
  pathI: number
  age: number
}

export interface Driver {
  present: boolean
  state: 'toCart' | 'seek' | 'deliver' | 'backOff'
  t: number
  /** Mover pose (equals the cart pose while driving). */
  x: number
  z: number
  vx: number
  vz: number
  heading: number
  /** Index of the cart in state.tools. */
  tool: number
  /** Bubble id being chased, or -1. */
  target: number
  age: number
  /** Seconds since his last delivery to the grinder (enforces DRIVER_MIN_CYCLE). */
  cycleT: number
}

export interface Guide {
  /** Target kind, or 'none' when hidden. */
  kind: 'none' | 'flasks' | 'pallet' | 'pad'
  x: number
  z: number
  /** Height of the arrow tip above the ground. */
  y: number
}

export interface Stats {
  /** Villagers that left the map fully healed. Win when == TOTAL_VILLAGERS. */
  discharged: number
  bathed: number
  totalGold: number
  flasksMade: number
  bubblesCaught: number
}

export interface GameState {
  /** Simulated seconds since the start. */
  time: number
  rng: Rng
  /** Monotonic id source for bubbles, villagers, flasks. */
  nextId: number
  won: boolean
  /** Simulated time at which the game was won (0 until then). */
  wonAt: number
  /** Integer gold shown in the HUD. */
  wallet: number
  unlocks: Record<UnlockId, boolean>
  player: Player
  /** tools[0] is created at start (hand scoop). Systems must tolerate any number of tools. */
  tools: Tool[]
  balls: Balls
  bubbles: Bubble[]
  bubbleSpawnT: number
  grinder: Grinder
  groundFlasks: GroundFlask[]
  /** Parity of picked-up ground meshes (2 meshes = 1 unit). */
  flaskHalf: number
  cauldron: Cauldron
  crowd: Crowd
  gate: Gate
  usher: Usher
  villagers: Villager[]
  beds: Bed[]
  nurses: Nurse[]
  doors: Doors
  pallet: Pallet
  pads: Pad[]
  drill: Drill
  swarm: Swarm
  porter: Porter
  driver: Driver
  guide: Guide
  stats: Stats
  /** Events emitted during the current step() call sequence; the host drains them (view, audio) and clears the array. */
  events: GameEvent[]
  /** One-shot flags for tutorial-ish triggers (e.g. 'firstPile', 'firstSortiePaid'). */
  flags: Record<string, boolean>
}
