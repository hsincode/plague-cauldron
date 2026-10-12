import { BEDS, L, P, UNLOCKS, type UnlockId } from '../config'
import { makeRng } from '../core/rng'
import { initRiver } from './river'
import type { Balls, GameState } from './types'

function makeBalls(n: number): Balls {
  return {
    n,
    x: new Float32Array(n),
    z: new Float32Array(n),
    y: new Float32Array(n),
    vx: new Float32Array(n),
    vz: new Float32Array(n),
    vy: new Float32Array(n),
    state: new Uint8Array(n),
    t: new Float32Array(n),
  }
}

export function createState(seed = 1): GameState {
  const unlocks = Object.fromEntries(UNLOCKS.map(u => [u.id, false])) as Record<UnlockId, boolean>
  const s: GameState = {
    time: 0,
    rng: makeRng(seed),
    nextId: 1,
    won: false,
    wonAt: 0,
    wallet: 0,
    unlocks,
    player: {
      x: L.PLAYER_START.x,
      z: L.PLAYER_START.z,
      vx: 0,
      vz: 0,
      heading: L.PLAYER_START.heading,
      mode: 'scoop',
      tool: 0,
      mountT: 0,
      dismountT: 0,
      dismountPending: false,
      pushedT: 0,
      pushVx: 0,
      pushVz: 0,
      stillT: 0,
      flasks: 0,
      carriedGold: 0,
      emoji: 'none',
      emojiT: 0,
      depositT: 0,
      pickupAcc: 0,
      odo: 0,
    },
    tools: [
      // tools[0]: the primary tool. Starts as the hand scoop in the doctor's hands; becomes the cart on 'cart'.
      { kind: 'scoop', x: L.PLAYER_START.x, z: L.PLAYER_START.z, heading: L.PLAYER_START.heading, holder: 'player', armed: false, bubble: -1, exists: true, age: 10 },
      // tools[1]: spare hand scoop that appears for the player when the 'driver' takes over the cart.
      { kind: 'scoop', x: L.SPARE_SCOOP_REST.x, z: L.SPARE_SCOOP_REST.z, heading: L.SPARE_SCOOP_REST.heading, holder: 'none', armed: true, bubble: -1, exists: false, age: 0 },
    ],
    balls: makeBalls(P.BALL_COUNT),
    bubbles: [],
    bubbleSpawnT: 0.2,
    grinder: { state: 'idle', t: 0, bubble: -1, size: 'M', bx: 0, bz: 0, br: 0, toEject: 0, ejectT: 0, spin: 0 },
    groundFlasks: [],
    flaskHalf: 0,
    cauldron: { potion: 0, capacity: P.POTION_CAPACITY, slots: P.BATH_SLOTS, incoming: [], bath: 'empty', t: 0, bathers: [], batches: 0, blockedT: 0, blockedByBeds: false, sinceFill: 99, waitT: 0, fountains: [] },
    crowd: { remaining: P.TOTAL_VILLAGERS, released: 0, pendingRelease: 0, releaseT: 0, manualT: 0 },
    gate: { open: 0, wantOpen: false, idleT: 99 },
    usher: { present: false, x: 0, z: 0, heading: 0, arrived: false, age: 0 },
    villagers: [],
    beds: BEDS.map(b => ({ id: b.id, ward: b.ward, exists: b.ward === 1, state: 'free' as const, villager: -1, lieT: 0, treatT: -1, age: 99 })),
    nurses: [],
    doors: { south: 0, north: 0 },
    pallet: { gold: 0, incoming: [], sinceLanding: 99, acc: 0, collecting: false, pickups: 0, picked: 0, bursarLeft: 0 },
    pads: UNLOCKS.map(u => ({ id: u.id, state: 'hidden' as const, t: 0, paid: 0, price: u.price, x: u.x, z: u.z })),
    drill: { state: 'parked', t: 0, x: L.DRILL_PARK.x, z: L.DRILL_PARK.z, heading: L.DRILL_PARK.heading, crew: [], loneT: 0, spin: 0, sorties: 0, reward: 0, paid: 0 },
    swarm: { ready: true, regrowT: 0, fill: 1 },
    porter: { present: false, state: 'idle', t: 0, x: L.PORTER_HOME.x, z: L.PORTER_HOME.z, heading: 0, flasks: 0, depositT: 0, pickupAcc: 0, path: [], pathI: 0, age: 0 },
    driver: { present: false, state: 'toCart', t: 0, x: 0, z: 0, vx: 0, vz: 0, heading: 0, tool: 0, target: -1, age: 0, cycleT: 0 },
    guide: { kind: 'none', x: 0, z: 0, y: 0 },
    stats: { discharged: 0, bathed: 0, totalGold: 0, flasksMade: 0, bubblesCaught: 0 },
    events: [],
    flags: {},
  }
  initRiver(s)
  return s
}
