// Adversarial review tests for the economy package (economy.ts, pads.ts, guide.ts, helpers.ts): edge cases,
// seeded random runs with invariants checked after every step, and the same scenarios at several step sizes.
// Whatever another package does is either played by hand here or probed first, so that these tests only ever
// fail for something this package owns.
import { describe, expect, test } from 'bun:test'
import { L, P, UNLOCKS, type BubbleSize, type UnlockId } from '../src/config'
import { makeRng, rand, randInt, randRange, type Rng } from '../src/core/rng'
import { stepBath } from '../src/sim/bath'
import { stepCrowd } from '../src/sim/crowd'
import { stepDrill } from '../src/sim/drill'
import { BURSAR_RATE, stepEconomy } from '../src/sim/economy'
import type { EventOf, EventType } from '../src/sim/events'
import { pickupFlasks, stepFlasks } from '../src/sim/flasks'
import { stepGrinder } from '../src/sim/grinder'
import { stepGuide } from '../src/sim/guide'
import { stepHelpers } from '../src/sim/helpers'
import { PAD_A_DELAY, padPayDuration, stepPads } from '../src/sim/pads'
import { stepCartMover, stepPlayer } from '../src/sim/player'
import { createState } from '../src/sim/state'
import { step } from '../src/sim/step'
import type { GameState, Pad } from '../src/sim/types'
import { stepWard } from '../src/sim/ward'

const DTS = [1 / 60, 1 / 144]
const dtName = (dt: number) => `dt = 1/${Math.round(1 / dt)}`

type Sys = (s: GameState, dt: number) => void

function run(s: GameState, seconds: number, dt: number, sys: Sys, each?: () => void) {
  const n = Math.round(seconds / dt)
  for (let i = 0; i < n; i++) {
    s.time += dt
    sys(s, dt)
    each?.()
  }
}

/** Step until `done()`; returns the simulated seconds it took, or -1 after `max` seconds. */
function runUntil(s: GameState, max: number, dt: number, sys: Sys, done: () => boolean): number {
  const n = Math.round(max / dt)
  for (let i = 1; i <= n; i++) {
    s.time += dt
    sys(s, dt)
    if (done()) return i * dt
  }
  return -1
}

const events = <T extends EventType>(s: GameState, type: T) => s.events.filter(e => e.type === type) as EventOf<T>[]
const pad = (s: GameState, id: UnlockId): Pad => s.pads.find(p => p.id === id)!
const flying = (s: GameState) => s.pallet.incoming.reduce((sum, v, i) => (i % 2 ? sum + v : sum), 0)
const paidSoFar = (s: GameState) => s.pads.reduce((sum, p) => sum + p.paid, 0)

function standAt(s: GameState, x: number, z: number) {
  s.player.x = x
  s.player.z = z
  s.player.vx = 0
  s.player.vz = 0
  s.player.stillT = 1
}
const atPallet = (s: GameState) => standAt(s, L.PALLET.x - 1.2, L.PALLET.z - 1.0)
const farAway = (s: GameState) => standAt(s, 14, -12)
const besidePad = (s: GameState, id: UnlockId) => standAt(s, pad(s, id).x + 2.0, pad(s, id).z)

function buyBefore(s: GameState, id: UnlockId) {
  for (const u of UNLOCKS) {
    if (u.id === id) break
    s.unlocks[u.id] = true
  }
}

const economy: Sys = (s, dt) => {
  stepEconomy(s, dt)
  stepPads(s, dt)
  stepGuide(s, dt)
}

/** A fountain as the bath pushes it: `gold` in coin meshes of `worth`, launched over 0.6 s, 0.4 s in the air each. */
function fountain(s: GameState, gold: number, worth: number = P.GOLD_PER_COIN_MESH, delay = 0) {
  const meshes = Math.ceil(gold / worth)
  let left = gold
  for (let j = 0; j < meshes; j++) {
    const amount = Math.min(worth, left)
    left -= amount
    const launch = meshes > 1 ? (j / (meshes - 1)) * (P.FOUNTAIN_DURATION - P.COIN_FLIGHT) : 0
    s.pallet.incoming.push(delay + launch + P.COIN_FLIGHT, amount)
  }
}

// ---------------------------------------------------------------------------------------------------------------
describe('review: pallet pickup', () => {
  for (const dt of DTS) {
    test(`a big heap leaves at PICKUP_RATE, whatever the step (${dtName(dt)})`, () => {
      const s = createState()
      atPallet(s)
      s.pallet.gold = 437
      const t = runUntil(s, 10, dt, stepEconomy, () => !s.pallet.collecting && s.wallet > 0)
      expect(s.wallet).toBe(437)
      expect(Math.abs(t - 437 / P.PICKUP_RATE)).toBeLessThanOrEqual(3 * dt)
      expect(events(s, 'coinPickupEnd').map(e => e.gold)).toEqual([437])
      expect(s.pallet.pickups).toBe(1)
    })

    test(`walking off between two coins of a fountain is not a completed pickup (${dtName(dt)})`, () => {
      const s = createState()
      buyBefore(s, 'cart') // pad C waits for the next completed pickup
      atPallet(s)
      // slow rope: one coin every 0.25 s, so the pallet is bare between two landings
      for (let i = 0; i < 8; i++) s.pallet.incoming.push(0.1 + i * 0.25, 2)
      run(s, 0.75, dt, economy)
      expect(s.pallet.collecting).toBe(true)
      expect(s.pallet.gold).toBe(0)
      expect(s.pallet.incoming.length).toBeGreaterThan(0)
      farAway(s)
      run(s, 0.1, dt, economy)
      expect(s.pallet.collecting).toBe(false)
      expect(events(s, 'coinPickupEnd').length).toBe(1)
      expect(s.pallet.pickups).toBe(0)
      expect(pad(s, 'cart').state).toBe('hidden')
      // the rest lands and waits for him
      run(s, 3, dt, economy)
      expect(s.pallet.gold + s.wallet).toBe(16)
      expect(s.pallet.gold).toBeGreaterThan(0)
      expect(pad(s, 'cart').state).toBe('hidden')
      expect(s.guide.kind).toBe('pallet')
      atPallet(s)
      run(s, 1, dt, economy)
      expect(s.wallet).toBe(16)
      expect(s.pallet.pickups).toBe(1)
      expect(pad(s, 'cart').state).not.toBe('hidden')
    })

    test(`waiting at the bare pallet: the pickup starts with the first coin and spans the whole fountain (${dtName(dt)})`, () => {
      const s = createState()
      atPallet(s)
      run(s, 1, dt, stepEconomy)
      expect(events(s, 'coinPickupStart').length).toBe(0)
      fountain(s, 25)
      fountain(s, 25, P.GOLD_PER_COIN_MESH, 2 / 30)
      let sawBare = false
      run(s, 2, dt, stepEconomy, () => {
        if (s.pallet.collecting && s.pallet.gold === 0) sawBare = true
        expect(s.wallet + s.pallet.gold + flying(s)).toBe(50)
      })
      expect(sawBare).toBe(true) // he takes 100 gold/s, the rope brings less
      expect(s.wallet).toBe(50)
      expect(events(s, 'coinPickupStart').length).toBe(1)
      expect(events(s, 'coinPickupEnd').map(e => e.gold)).toEqual([50])
      expect(s.pallet.pickups).toBe(1)
    })
  }

  test('the wallet trace of the ad (SPEC 3.3), with the coin column that goes with it (SPEC 2.8)', () => {
    const dt = 1 / 60
    const s = createState()
    const trace: number[] = [s.wallet]
    const settle = (seconds: number) =>
      run(s, seconds, dt, economy, () => {
        if (s.wallet !== trace[trace.length - 1] && !s.pallet.collecting && !s.pads.some(p => p.state === 'paying')) trace.push(s.wallet)
      })
    const buy = (id: UnlockId) => {
      const p = pad(s, id)
      p.state = 'idle'
      besidePad(s, id)
      settle(1.5)
      expect(s.unlocks[id]).toBe(true)
    }
    farAway(s)
    fountain(s, 50, 4)
    fountain(s, 50, 4)
    settle(1.2)
    atPallet(s)
    settle(1.2)
    expect(s.player.carriedGold).toBe(100)
    buy('nurses')
    expect(s.player.carriedGold).toBe(50)
    s.wallet += 250 // rat coins go straight to the HUD
    s.stats.totalGold += 250
    settle(dt)
    expect(s.player.carriedGold).toBe(50)
    buy('usher')
    expect(s.player.carriedGold).toBe(0)
    farAway(s)
    fountain(s, 25)
    fountain(s, 25)
    settle(1.2)
    atPallet(s)
    settle(0.7)
    expect(s.player.carriedGold).toBe(50)
    expect(pad(s, 'cart').state).not.toBe('hidden') // the pickup after the usher brings up pad C
    buy('cart')
    expect(s.player.carriedGold).toBe(0)
    expect(trace).toEqual([0, 100, 50, 300, 250, 300, 250])
    expect(s.stats.totalGold).toBe(400)
  })

  test('gold that reaches the wallet is counted once in stats.totalGold, by whichever way it came', () => {
    const dt = 1 / 144
    const s = createState()
    s.unlocks.bursar = true
    atPallet(s)
    fountain(s, 25)
    run(s, 1.5, dt, stepEconomy) // he stands there: his own pickup comes first
    expect(s.wallet).toBe(25)
    expect(s.player.carriedGold).toBe(25)
    expect(events(s, 'bursarCollect').length).toBe(0)
    farAway(s)
    fountain(s, 75)
    run(s, 3, dt, stepEconomy)
    expect(s.wallet).toBe(100)
    expect(s.player.carriedGold).toBe(25)
    expect(s.stats.totalGold).toBe(100)
    expect(events(s, 'bursarCollect').map(e => e.gold)).toEqual([75])
    expect(s.pallet.pickups).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('review: bursar', () => {
  for (const dt of DTS) {
    test(`waits for the end of the fountain, then BURSAR_DELAY, at any step size (${dtName(dt)})`, () => {
      const s = createState()
      s.unlocks.bursar = true
      farAway(s)
      fountain(s, 25)
      fountain(s, 25, P.GOLD_PER_COIN_MESH, 0.07)
      const last = 0.07 + P.FOUNTAIN_DURATION
      const t = runUntil(s, 5, dt, stepEconomy, () => events(s, 'bursarCollect').length > 0)
      expect(Math.abs(t - (last + P.BURSAR_DELAY))).toBeLessThanOrEqual(2.5 * dt)
      expect(s.wallet).toBeLessThanOrEqual(Math.ceil(BURSAR_RATE * dt))
      const done = runUntil(s, 5, dt, stepEconomy, () => s.pallet.gold === 0)
      expect(Math.abs(done - 50 / BURSAR_RATE)).toBeLessThanOrEqual(2.5 * dt)
      expect(s.wallet).toBe(50)
      expect(s.pallet.bursarLeft).toBe(0)
    })

    test(`coins that land during a collection wait for the next one (${dtName(dt)})`, () => {
      const s = createState()
      s.unlocks.bursar = true
      farAway(s)
      s.pallet.gold = 150
      s.time += dt
      stepEconomy(s, dt)
      expect(events(s, 'bursarCollect').map(e => e.gold)).toEqual([150])
      fountain(s, 25) // lands 0.4..1.0 s from now; the 150 take 0.5 s
      run(s, 0.6, dt, stepEconomy, () => expect(s.wallet + s.pallet.gold + flying(s)).toBe(175))
      expect(s.wallet).toBe(150)
      expect(s.pallet.bursarLeft).toBe(0)
      run(s, 0.4 + P.BURSAR_DELAY - 0.1, dt, stepEconomy)
      expect(s.wallet).toBe(150) // the second collection is not due yet
      run(s, 0.5, dt, stepEconomy)
      expect(s.wallet).toBe(175)
      expect(events(s, 'bursarCollect').map(e => e.gold)).toEqual([150, 25])
      expect(s.player.carriedGold).toBe(0)
    })
  }

  test('the doctor cannot take what the bursar has already announced, and nothing is paid twice', () => {
    const dt = 1 / 60
    const s = createState()
    s.unlocks.bursar = true
    farAway(s)
    s.pallet.gold = 300
    run(s, 0.2, dt, stepEconomy)
    const before = s.wallet
    expect(before).toBeGreaterThan(0)
    atPallet(s) // he arrives in the middle of the collection
    run(s, 2, dt, stepEconomy, () => expect(s.wallet + s.pallet.gold).toBe(300))
    expect(s.wallet).toBe(300)
    expect(s.player.carriedGold).toBe(0)
    expect(events(s, 'coinPickupStart').length).toBe(0)
    expect(events(s, 'bursarCollect').map(e => e.gold)).toEqual([300])
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('review: pads', () => {
  function ready(id: UnlockId, wallet: number) {
    const s = createState()
    buyBefore(s, id)
    run(s, 0.05, 1 / 60, stepPads)
    const p = pad(s, id)
    p.state = 'idle'
    p.t = 0
    s.wallet = wallet
    besidePad(s, id)
    s.events.length = 0
    return s
  }

  for (const dt of DTS) {
    test(`A pops PAD_A_DELAY after the patient lies down; a bed that empties meanwhile restarts the wait (${dtName(dt)})`, () => {
      const s = createState()
      s.beds[0]!.state = 'occupied'
      run(s, PAD_A_DELAY - 3 * dt, dt, stepPads)
      s.beds[0]!.state = 'free'
      run(s, 3 * dt, dt, stepPads)
      s.beds[0]!.state = 'occupied'
      const t = runUntil(s, 2, dt, stepPads, () => pad(s, 'nurses').state !== 'hidden')
      expect(Math.abs(t - PAD_A_DELAY)).toBeLessThanOrEqual(1.5 * dt)
      expect(events(s, 'padPop').length).toBe(1)
      const idle = runUntil(s, 2, dt, stepPads, () => pad(s, 'nurses').state === 'idle')
      expect(Math.abs(idle - P.PAD_POP_TIME)).toBeLessThanOrEqual(1.5 * dt)
    })

    test(`pausing and resuming three times: the paying time adds up to the duration (${dtName(dt)})`, () => {
      const s = ready('drill2', 5000)
      const p = pad(s, 'drill2')
      const duration = padPayDuration(p.price)
      let paying = 0
      let last = 0
      const count = () => {
        if (p.state === 'paying') paying += dt
        expect(p.paid).toBeGreaterThanOrEqual(last)
        expect(s.wallet + p.paid).toBe(5000)
        last = p.paid
      }
      for (let k = 0; k < 3; k++) {
        besidePad(s, 'drill2')
        run(s, 0.2, dt, stepPads, count)
        expect(p.state).toBe('paying')
        standAt(s, p.x, p.z + P.PAD_PAY_RADIUS + 0.05)
        run(s, 0.3, dt, stepPads, count)
        expect(p.state).toBe('idle')
      }
      besidePad(s, 'drill2')
      expect(runUntil(s, 3, dt, stepPads, () => (count(), p.state === 'done'))).toBeGreaterThan(0)
      expect(p.paid).toBe(p.price)
      // one step is lost at every (re)start, one may be gained at the end
      expect(Math.abs(paying - duration)).toBeLessThanOrEqual(5 * dt)
      expect(events(s, 'padPayStart').length).toBe(4)
      expect(events(s, 'unlock').length).toBe(0)
      run(s, P.PAD_DONE_DELAY + 2 * dt, dt, stepPads)
      expect(events(s, 'unlock').map(e => e.id)).toEqual(['drill2'])
    })
  }

  test('a wallet that exactly covers the price ends at 0, never below', () => {
    for (const dt of DTS) {
      for (const u of UNLOCKS) {
        const s = ready(u.id, u.price)
        s.player.carriedGold = 13
        run(s, 2, dt, stepPads, () => {
          expect(s.wallet).toBeGreaterThanOrEqual(0)
          expect(s.player.carriedGold).toBeGreaterThanOrEqual(0)
          expect(s.player.carriedGold).toBeLessThanOrEqual(s.wallet)
        })
        expect(s.wallet).toBe(0)
        expect(s.unlocks[u.id]).toBe(true)
      }
    }
  })

  test('one gold short: nothing is taken, no event, however long he stands there', () => {
    for (const u of UNLOCKS) {
      const s = ready(u.id, u.price - 1)
      run(s, 3, 1 / 60, economy)
      expect(s.wallet).toBe(u.price - 1)
      expect(pad(s, u.id).paid).toBe(0)
      expect(pad(s, u.id).state).toBe('idle')
      expect(events(s, 'padPayStart').length).toBe(0)
      expect(s.guide.kind).toBe('none') // the arrow only points at a pad he can afford
    }
  })

  test('income during the payment does not speed it up; walking inside the radius does not stop it', () => {
    const dt = 1 / 60
    const s = ready('ward2', 100)
    const p = pad(s, 'ward2')
    s.time += dt
    stepPads(s, dt)
    expect(p.state).toBe('paying')
    s.wallet += 250
    s.player.stillT = 0 // he shuffles about, still next to the pad
    run(s, padPayDuration(100) / 2, dt, stepPads)
    expect(p.state).toBe('paying')
    expect(Math.abs(p.paid - 50)).toBeLessThanOrEqual(4)
    run(s, 1, dt, stepPads)
    expect(s.wallet).toBe(250)
    expect(s.unlocks.ward2).toBe(true)
  })

  test('a pad cannot be paid while it pops in, and the purchase goes through after he has walked away', () => {
    const dt = 1 / 144
    const s = createState()
    s.wallet = 60
    s.beds[0]!.state = 'occupied'
    besidePad(s, 'nurses')
    runUntil(s, 1, dt, stepPads, () => pad(s, 'nurses').state === 'popIn')
    run(s, P.PAD_POP_TIME - 3 * dt, dt, stepPads)
    expect(pad(s, 'nurses').state).toBe('popIn')
    expect(s.wallet).toBe(60)
    runUntil(s, 2, dt, stepPads, () => pad(s, 'nurses').state === 'done')
    expect(s.wallet).toBe(10)
    farAway(s)
    run(s, P.PAD_DONE_DELAY + 2 * dt, dt, stepPads)
    expect(s.unlocks.nurses).toBe(true)
    expect(events(s, 'padPaid').length).toBe(1)
  })

  test('D does not pop for a bath that is blocked by something else, nor before the cart', () => {
    const dt = 1 / 60
    const s = createState()
    buyBefore(s, 'cart')
    s.cauldron.blockedByBeds = true
    s.cauldron.blockedT = 2
    run(s, 1, dt, stepPads)
    expect(pad(s, 'ward2').state).toBe('hidden')
    s.unlocks.cart = true
    s.cauldron.blockedByBeds = false
    run(s, 1, dt, stepPads)
    expect(pad(s, 'ward2').state).toBe('hidden')
    s.cauldron.blockedByBeds = true
    s.cauldron.blockedT = 0 // flag left over from an earlier block
    run(s, 1, dt, stepPads)
    expect(pad(s, 'ward2').state).toBe('hidden')
    s.cauldron.blockedT = dt
    run(s, 2 * dt, dt, stepPads)
    expect(pad(s, 'ward2').state).toBe('popIn')
  })

  test('a visible pad stays when its trigger goes away again', () => {
    const dt = 1 / 60
    const s = createState()
    s.beds[2]!.state = 'occupied'
    run(s, 1, dt, stepPads)
    expect(pad(s, 'nurses').state).toBe('idle')
    s.beds[2]!.state = 'free'
    run(s, 5, dt, stepPads)
    expect(pad(s, 'nurses').state).toBe('idle')
    expect(events(s, 'padPop').length).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('review: guide arrow and housekeeping', () => {
  const dt = 1 / 60

  test('the pallet arrow hides for every fountain in flight and comes back after it', () => {
    const s = createState()
    farAway(s)
    fountain(s, 50)
    run(s, 1.2, dt, economy)
    expect(s.guide.kind).toBe('pallet')
    fountain(s, 50) // the next batch
    run(s, 0.2, dt, economy)
    expect(s.guide.kind).toBe('none')
    run(s, 1.0, dt, economy)
    expect(s.guide.kind).toBe('pallet')
    expect(events(s, 'guide').map(e => e.kind)).toEqual(['pallet', 'none', 'pallet'])
  })

  test('the pallet outranks an affordable pad; while he collects the arrow moves on to the pad', () => {
    const s = createState()
    farAway(s)
    s.wallet = 50
    pad(s, 'nurses').state = 'idle'
    s.pallet.gold = 100
    run(s, 0.1, dt, economy)
    expect(s.guide.kind).toBe('pallet')
    atPallet(s)
    run(s, 0.1, dt, economy)
    expect(s.guide.kind).toBe('pad')
    expect([s.guide.x, s.guide.z]).toEqual([pad(s, 'nurses').x, pad(s, 'nurses').z])
  })

  test('a second bubble ground before the first pile was touched does not count as a new pile; any pickup ends it for good', () => {
    const s = createState()
    farAway(s)
    let id = 1
    const drop = (n: number, age: number) => {
      for (let i = 0; i < n; i++) s.groundFlasks.push({ id: id++, x: 6.5 + (i % 3) * 0.5, z: -3.5 + Math.floor(i / 3) * 0.5, fromX: 8.5, fromZ: -2.5, age, rot: 0 })
    }
    drop(6, 1)
    run(s, 0.1, dt, stepGuide)
    expect(s.guide.kind).toBe('flasks')
    s.grinder.toEject = 10 // the grinder is at it again
    run(s, 0.1, dt, stepGuide)
    expect(s.guide.kind).toBe('none')
    s.grinder.toEject = 0
    drop(10, 1)
    run(s, 0.1, dt, stepGuide)
    expect(s.guide.kind).toBe('flasks')
    s.porter.flasks = 1 // somebody other than the doctor took the first unit
    run(s, 0.1, dt, stepGuide)
    expect(s.guide.kind).toBe('none')
    s.porter.flasks = 0
    run(s, 1, dt, stepGuide)
    expect(s.guide.kind).toBe('none')
    expect(events(s, 'guide').map(e => e.kind)).toEqual(['flasks', 'none', 'flasks', 'none'])
  })

  test('after the win the arrow is gone for good and the win is not announced again', () => {
    const s = createState()
    farAway(s)
    s.pallet.gold = 50
    s.wallet = 9999
    pad(s, 'nurses').state = 'idle'
    run(s, 0.1, dt, economy)
    expect(s.guide.kind).toBe('pallet')
    s.stats.discharged = P.TOTAL_VILLAGERS
    run(s, 5, dt, economy)
    expect(s.guide.kind).toBe('none')
    expect(events(s, 'win').length).toBe(1)
    expect(events(s, 'guide').map(e => e.kind)).toEqual(['pallet', 'none'])
    expect(s.wonAt).toBeGreaterThan(0)
    expect(s.wonAt).toBeLessThan(0.2)
  })

  test('a headless run never accumulates events or departed villagers', () => {
    const s = createState()
    let most = 0
    for (let i = 0; i < 40000; i++) {
      s.events.push({ type: 'gateOpen' })
      if (i % 7 === 0) {
        s.villagers.push({
          id: i, state: i % 14 === 0 ? 'gone' : 'toExit', t: 0, x: 0, z: 0, y: 0, heading: 0, look: 'healed', path: [], pathI: 0, speed: 0, slot: -1,
          bed: -1, fromX: 0, fromZ: 0, toX: 0, toZ: 0, delay: 0, seed: 0, alpha: 1,
        })
      }
      for (const v of s.villagers) if (v.state === 'toExit' && i - v.id > 50) v.state = 'gone'
      stepGuide(s, dt)
      most = Math.max(most, s.events.length)
      expect(s.villagers.every(v => v.state !== 'gone')).toBe(true)
      expect(s.villagers.length).toBeLessThan(12)
    }
    expect(most).toBeLessThanOrEqual(5000)
    expect(s.events[s.events.length - 1]).toEqual({ type: 'gateOpen' }) // the newest survive
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('review: random play keeps the books straight', () => {
  /**
   * A doctor who teleports at random between the pallet, the open pad and nowhere, in a world where fountains,
   * rat gold, discharges and the pad triggers happen at random. Returns the order of the unlocks.
   */
  function randomPlay(seed: number, seconds: number, nextDt: (rng: Rng) => number): UnlockId[] {
    const rng = makeRng(seed)
    const s = createState(seed)
    let injected = 0
    let external = 0
    let starts = 0
    let ends = 0
    let pickedUp = 0
    let announced = 0
    let whereT = 0
    let seen = 0
    let lastGuide = 'none'
    const order: UnlockId[] = []
    const lastPaid = s.pads.map(() => 0)
    while (s.time < seconds) {
      const dt = nextDt(rng)
      s.time += dt
      if (rand(rng) < dt * 0.12) {
        const bathers = randInt(rng, 1, 4)
        for (let b = 0; b < bathers; b++) {
          const double = rand(rng) < 0.1
          fountain(s, double ? 50 : 25, double ? 4 : 2, b * (2 / 30))
          injected += double ? 50 : 25
        }
      }
      if (rand(rng) < dt * 0.05) {
        const gold = rand(rng) < 0.5 ? 250 : 500
        s.wallet += gold
        s.stats.totalGold += gold
        external += gold
        s.flags.firstSortiePaid = true
      }
      if (rand(rng) < dt * 0.15) s.stats.discharged = Math.min(P.TOTAL_VILLAGERS - 1, s.stats.discharged + randInt(rng, 1, 3))
      if (rand(rng) < dt * 0.2) s.beds[randInt(rng, 0, 3)]!.state = rand(rng) < 0.5 ? 'occupied' : 'free'
      if (rand(rng) < dt * 0.2) {
        s.cauldron.blockedByBeds = rand(rng) < 0.5
        s.cauldron.blockedT = rand(rng)
      }
      whereT -= dt
      if (whereT <= 0) {
        whereT = randRange(rng, 0.05, 3)
        const r = rand(rng)
        const open = s.pads.find(p => p.state !== 'hidden' && p.state !== 'gone')
        if (r < 0.35) {
          s.player.x = L.PALLET.x + randRange(rng, -2.2, 2.2)
          s.player.z = L.PALLET.z + randRange(rng, -2.2, 2.2)
        } else if (r < 0.8 && open) {
          s.player.x = open.x + randRange(rng, -2.6, 2.6)
          s.player.z = open.z + randRange(rng, -2.6, 2.6)
        } else {
          s.player.x = randRange(rng, -4, 20)
          s.player.z = randRange(rng, -15, 10)
        }
        s.player.stillT = 0
      }
      s.player.stillT += dt
      if (rand(rng) < dt * 0.5) s.player.stillT = 0

      economy(s, dt)

      expect(Number.isInteger(s.wallet) && s.wallet >= 0).toBe(true)
      expect(Number.isInteger(s.pallet.gold) && s.pallet.gold >= 0).toBe(true)
      expect(Number.isInteger(s.player.carriedGold) && s.player.carriedGold >= 0 && s.player.carriedGold <= s.wallet).toBe(true)
      expect(s.wallet + paidSoFar(s) + s.pallet.gold + flying(s)).toBe(injected + external)
      expect(s.stats.totalGold).toBe(s.wallet + paidSoFar(s))
      let open = 0
      for (let i = 0; i < s.pads.length; i++) {
        const p = s.pads[i]!
        if (p.state !== 'hidden' && p.state !== 'gone') open++
        expect(p.paid >= lastPaid[i]! && p.paid <= p.price).toBe(true)
        lastPaid[i] = p.paid
        if (s.unlocks[p.id]) expect(p.paid).toBe(p.price)
      }
      expect(open).toBeLessThanOrEqual(1)
      if (seen > s.events.length) seen = s.events.length
      for (; seen < s.events.length; seen++) {
        const e = s.events[seen]!
        if (e.type === 'coinPickupStart') expect(++starts).toBe(ends + 1)
        else if (e.type === 'coinPickupEnd') {
          expect(++ends).toBe(starts)
          pickedUp += e.gold
        } else if (e.type === 'bursarCollect') announced += e.gold
        else if (e.type === 'unlock') order.push(e.id)
        else if (e.type === 'guide') {
          if (e.kind !== 'pad') expect(e.kind).not.toBe(lastGuide) // an event is a change (or another pad)
          lastGuide = e.kind
        }
      }
      expect(s.guide.kind).toBe(lastGuide as typeof s.guide.kind)
      expect(s.pallet.collecting).toBe(starts > ends)
      if (s.guide.kind === 'pallet') expect(s.pallet.gold > 0 && s.pallet.incoming.length === 0 && !s.pallet.collecting && !s.unlocks.bursar).toBe(true)
      if (s.guide.kind === 'pad') {
        const p = s.pads.find(q => q.x === s.guide.x && q.z === s.guide.z)!
        expect(p.state === 'idle' || p.state === 'popIn').toBe(true)
        expect(s.wallet >= p.price - p.paid).toBe(true)
      }
      expect(s.guide.kind === 'none' || s.guide.y === P.ARROW_HOVER).toBe(true)
    }
    // what the events announced is what arrived (a collection or pickup may still be under way at the end)
    const inProgress = s.pallet.picked + s.pallet.bursarLeft
    expect(Math.abs(pickedUp + s.pallet.picked + announced - (s.stats.totalGold - external))).toBeLessThanOrEqual(inProgress)
    return order
  }

  const ALL = UNLOCKS.map(u => u.id)
  for (const dt of DTS) {
    for (const seed of [1, 2, 3]) {
      test(`seed ${seed}, ${dtName(dt)}: invariants hold and every pad is bought, in order`, () => {
        expect(randomPlay(seed, 600, () => dt)).toEqual(ALL)
      })
    }
  }
  test('seed 4, a different step size every step', () => {
    expect(randomPlay(4, 600, rng => randRange(rng, 1 / 144, 1 / 60))).toEqual(ALL)
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('review: the same scenario at different step sizes', () => {
  /** A scripted minute of economy; returns the times of everything the presentation layer hears about. */
  function script(dt: number) {
    const s = createState()
    const times: Record<string, number> = {}
    let seen = 0
    const note = () => {
      for (; seen < s.events.length; seen++) {
        const e = s.events[seen]!
        const key = 'id' in e ? `${e.type}:${e.id}` : 'kind' in e ? `${e.type}:${e.kind}` : e.type
        let k = key
        for (let n = 2; k in times; n++) k = `${key}#${n}`
        times[k] = s.time
      }
    }
    // phases end at the same absolute times for every step size, so that rounding does not add up
    let until = 0
    const go = (seconds: number) => {
      until += seconds
      while (s.time < until - 1e-9) {
        s.time += dt
        economy(s, dt)
        note()
      }
    }
    farAway(s)
    fountain(s, 50, 4)
    fountain(s, 50, 4, 2 / 30)
    go(0.5)
    s.beds[0]!.state = 'occupied'
    go(1.5)
    atPallet(s)
    go(1.5)
    besidePad(s, 'nurses')
    go(1.5)
    s.wallet += 250
    s.stats.totalGold += 250
    s.flags.firstSortiePaid = true
    go(0.5)
    besidePad(s, 'usher')
    go(1.5)
    farAway(s)
    fountain(s, 25)
    fountain(s, 25, 2, 2 / 30)
    go(1.5)
    atPallet(s)
    go(1.0)
    besidePad(s, 'cart')
    go(1.5)
    s.cauldron.blockedByBeds = true
    s.cauldron.blockedT = 0.5
    go(0.5)
    besidePad(s, 'ward2')
    go(0.4)
    farAway(s) // leaves half-way through pad D
    go(0.5)
    besidePad(s, 'ward2')
    go(1.5)
    return { times, wallet: s.wallet, carried: s.player.carriedGold, total: s.stats.totalGold, pickups: s.pallet.pickups }
  }

  test('the same events at the same times (within three steps) and the same final books', () => {
    const a = script(1 / 60)
    for (const dt of [1 / 144, 1 / 100, 1 / 75]) {
      const b = script(dt)
      expect(Object.keys(b.times)).toEqual(Object.keys(a.times))
      // a chain like "stops -> pays -> done -> unlock" is quantised at every link
      for (const k of Object.keys(a.times)) expect(Math.abs(a.times[k]! - b.times[k]!)).toBeLessThanOrEqual(3 / 60 + 1e-9)
      expect([b.wallet, b.carried, b.total, b.pickups]).toEqual([a.wallet, a.carried, a.total, a.pickups])
    }
    expect(a.wallet).toBe(150)
    expect(Object.keys(a.times).filter(k => k.startsWith('unlock:'))).toEqual(['unlock:nurses', 'unlock:usher', 'unlock:cart', 'unlock:ward2'])
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('review: the whole game with a teleporting doctor (no river)', () => {
  // Every system except the river; the grinder's output is dropped on the pile by hand. The doctor is put where
  // he would walk to. Only what this package owns is asserted, and only as far as the others let the game get.
  const SPOT: Record<UnlockId, [number, number]> = {
    nurses: [0, -1.5], usher: [1.3, 0.2], cart: [1.6, 0], ward2: [0, 1.4], porter: [0, 1.4],
    bursar: [1.5, 0], bigCauldron: [1.5, 0], drill2: [-1.5, 0], driver: [0, 1.5],
  }
  const ZERO = { mx: 0, mz: 0 }
  const all: Sys = (s, dt) => {
    stepPlayer(s, ZERO, dt)
    stepHelpers(s, dt)
    stepGrinder(s, dt)
    stepFlasks(s, dt)
    stepCrowd(s, dt)
    stepBath(s, dt)
    stepWard(s, dt)
    stepDrill(s, dt)
    economy(s, dt)
  }

  for (const dt of DTS) {
    test(`pads come up and are bought in order, the books stay whole (${dtName(dt)})`, () => {
      const s = createState(5)
      s.player.mode = 'foot'
      s.player.tool = -1
      s.tools[0]!.holder = 'none'
      let goal = ''
      let busy = 0
      const go = (name: string, x: number, z: number) => {
        if (goal === name) return
        goal = name
        busy = Math.hypot(x - s.player.x, z - s.player.z) / P.PLAYER_SPEED + 0.25
        s.player.x = x
        s.player.z = z
        s.player.vx = 0
        s.player.vz = 0
      }
      let feedT = 5
      let flaskId = 1e6
      const order: UnlockId[] = []
      const pops: UnlockId[] = []
      let lastGuide = 'none'
      const limit = 300
      while (s.time < limit && order.length < UNLOCKS.length) {
        feedT -= dt
        if (feedT <= 0 && s.groundFlasks.length === 0) {
          feedT = 11
          const units = s.unlocks.cart ? P.FLASK_YIELD.L : P.FLASK_YIELD.M
          for (let k = 0; k < units * P.GROUND_MESHES_PER_UNIT; k++) {
            s.groundFlasks.push({ id: flaskId++, x: L.FLASK_AREA.x + ((k % 4) - 1.5) * 0.5, z: L.FLASK_AREA.z + (Math.floor(k / 4) - 2) * 0.6, fromX: L.GRINDER[0], fromZ: L.FLASK_AREA.z, age: 0, rot: 0 })
          }
        }
        if (busy > 0) busy -= dt
        else {
          const c = s.cauldron
          const want = s.pads.find(p => p.state === 'idle' && s.wallet >= p.price - p.paid)
          const landed = s.groundFlasks.length > 0 && s.groundFlasks.every(f => f.age >= P.FLASK_EJECT_FLIGHT)
          const waiting = s.villagers.some(v => v.state === 'toQueue' || v.state === 'queued')
          if (s.pads.some(p => p.state === 'paying' || p.state === 'done') || s.pallet.collecting) {
            // stay
          } else if (want) go(want.id, want.x + SPOT[want.id][0], want.z + SPOT[want.id][1])
          else if (!s.unlocks.bursar && s.pallet.gold >= 1 && s.pallet.incoming.length === 0) go('pallet', L.PALLET.x - 1.2, L.PALLET.z - 1.0)
          else if (s.player.flasks > 0 && c.potion + c.incoming.length < c.capacity) go('pot', 0.3, -3.9)
          else if (landed && s.player.flasks < P.FLASK_CARRY_MAX && !s.unlocks.porter) go('pile', L.FLASK_AREA.x, L.FLASK_AREA.z)
          else if (!s.unlocks.usher && c.potion >= c.slots && !waiting && c.bath === 'empty') go('pen', L.MANUAL_RELEASE.x + 0.8, L.MANUAL_RELEASE.z + 1.4)
        }
        s.time += dt
        all(s, dt)

        expect(Number.isInteger(s.wallet) && s.wallet >= 0).toBe(true)
        expect(s.player.carriedGold >= 0 && s.player.carriedGold <= s.wallet).toBe(true)
        expect(s.stats.totalGold).toBe(s.wallet + paidSoFar(s))
        expect(s.pads.filter(p => p.state !== 'hidden' && p.state !== 'gone').length).toBeLessThanOrEqual(1)
        expect(s.villagers.every(v => v.state !== 'gone')).toBe(true)
        for (const e of s.events) {
          if (e.type === 'unlock') order.push(e.id)
          else if (e.type === 'padPop') pops.push(e.id)
          else if (e.type === 'guide') lastGuide = e.kind
        }
        expect(s.guide.kind).toBe(lastGuide as typeof s.guide.kind)
        s.events.length = 0
      }
      const ids = UNLOCKS.map(u => u.id)
      expect(order).toEqual(ids.slice(0, order.length))
      expect(pops).toEqual(ids.slice(0, pops.length))
      expect(pops.length - order.length === 0 || pops.length - order.length === 1).toBe(true)
      // Wherever the rest of the game got to, the pads must have kept up with it.
      const d = s.stats.discharged
      if (s.stats.bathed >= 2 && s.time >= limit) expect(pops.length).toBeGreaterThanOrEqual(1)
      if (d >= 8 + 6 && s.time >= limit) expect(order.length).toBeGreaterThanOrEqual(3)
      if (order.length === UNLOCKS.length) {
        run(s, 3 * dt, dt, all) // helpers react to the flag in their own step
        expect(s.porter.present).toBe(true)
        expect(s.tools[1]!.exists).toBe(true)
      }
    })
  }
})

// ---------------------------------------------------------------------------------------------------------------
describe('review: porter', () => {
  // The porter runs on flasks.ts (production package); without a real one there is nothing to carry.
  const flasksAreReal = (() => {
    const s = createState()
    s.groundFlasks.push({ id: 1, x: 0, z: 0, fromX: 0, fromZ: 0, age: 1, rot: 0 }, { id: 2, x: 0.1, z: 0, fromX: 0, fromZ: 0, age: 1, rot: 0 })
    const carrier = { x: 0, z: 0, flasks: 0, pickupAcc: 0 }
    for (let i = 0; i < 60; i++) pickupFlasks(s, carrier, 12, 'porter', 1 / 60)
    return carrier.flasks > 0
  })()
  const sys: Sys = (s, d) => {
    stepHelpers(s, d)
    stepFlasks(s, d)
  }
  const units = (s: GameState) => (s.groundFlasks.length + s.flaskHalf) / P.GROUND_MESHES_PER_UNIT + s.porter.flasks + s.player.flasks + s.cauldron.potion + s.cauldron.incoming.length

  for (const dt of DTS) {
    test.skipIf(!flasksAreReal)(`random piles and a pot that drains: nothing is lost, he never dawdles, never runs (${dtName(dt)})`, () => {
      const rng = makeRng(77)
      const s = createState()
      farAway(s)
      s.unlocks.porter = true
      let made = 0
      let used = 0
      let id = 1
      let workT = 0 // seconds a landed flask has been lying there with room in the pot
      let stateT = 0
      let state = s.porter.state
      let px = 0
      let pz = 0
      let present = false
      run(s, 240, dt, sys, () => {
        const p = s.porter
        const c = s.cauldron
        if (rand(rng) < dt * 0.12 && s.groundFlasks.length < 60) {
          const n = randInt(rng, 1, 9) * P.GROUND_MESHES_PER_UNIT
          for (let i = 0; i < n; i++) {
            s.groundFlasks.push({ id: id++, x: L.FLASK_AREA.x + randRange(rng, -1, 1), z: L.FLASK_AREA.z + randRange(rng, -1.6, 1.6), fromX: 8.5, fromZ: -2.5, age: rand(rng) < 0.5 ? 0 : 1, rot: 0 })
          }
          made += n / P.GROUND_MESHES_PER_UNIT
        }
        if (rand(rng) < dt * 0.5 && c.potion >= 2) {
          c.potion -= 2
          used += 2
        }
        expect(units(s)).toBe(made - used)
        expect(p.flasks).toBeGreaterThanOrEqual(0)
        expect(p.flasks).toBeLessThanOrEqual(P.PORTER_CARRY)
        expect(c.potion + c.incoming.length).toBeLessThanOrEqual(c.capacity)
        expect(s.player.flasks).toBe(0)
        expect(Number.isFinite(p.x + p.z + p.heading)).toBe(true)
        if (present) expect(Math.hypot(p.x - px, p.z - pz)).toBeLessThanOrEqual(P.PORTER_SPEED * dt + 1e-9)
        present = p.present
        px = p.x
        pz = p.z
        stateT = p.state === state ? stateT + dt : 0
        state = p.state
        if (p.state !== 'idle') expect(stateT).toBeLessThan(12)
        const work = c.potion + c.incoming.length < c.capacity && (p.flasks > 0 || s.groundFlasks.some(f => f.age >= P.FLASK_EJECT_FLIGHT))
        workT = work && p.state === 'idle' ? workT + dt : 0
        expect(workT).toBeLessThan(1.5) // PORTER_REST plus a step or two
      })
      expect(used).toBeGreaterThan(40)
      // the pile is cleared once the pot has room and nothing new arrives
      const c = s.cauldron
      const end = runUntil(s, 120, dt, sys, () => {
        if (c.potion >= c.capacity) c.potion -= 2
        return s.groundFlasks.length === 0 && s.porter.flasks === 0 && s.porter.state === 'idle'
      })
      expect(end).toBeGreaterThan(0)
    })
  }

  test.skipIf(!flasksAreReal)('a pot that fills up under him: he takes the rest home and comes back when there is room', () => {
    const dt = 1 / 60
    const s = createState()
    farAway(s)
    s.unlocks.porter = true
    run(s, 1, dt, sys)
    for (let i = 0; i < 12; i++) s.groundFlasks.push({ id: i + 1, x: L.FLASK_AREA.x + (i % 4) * 0.3, z: L.FLASK_AREA.z + Math.floor(i / 4) * 0.3, fromX: 8.5, fromZ: -2.5, age: 1, rot: 0 })
    s.cauldron.potion = s.cauldron.capacity - 2
    expect(runUntil(s, 10, dt, sys, () => s.porter.state === 'pour')).toBeGreaterThan(0)
    expect(s.porter.flasks).toBe(6)
    expect(runUntil(s, 10, dt, sys, () => s.porter.state === 'idle')).toBeGreaterThan(0)
    expect(s.cauldron.potion).toBe(s.cauldron.capacity)
    expect(s.porter.flasks).toBe(4)
    run(s, 5, dt, sys)
    expect(s.porter.state).toBe('idle') // nothing to do while the pot is full
    expect(s.porter.flasks).toBe(4)
    s.cauldron.potion = 0
    expect(runUntil(s, 10, dt, sys, () => s.cauldron.potion === 4 && s.porter.state === 'idle')).toBeGreaterThan(0)
    expect(s.porter.flasks).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('review: cart driver', () => {
  const SEATED = ['seek', 'deliver', 'backOff']
  // stepCartMover belongs to the physics package; while it is a stub the cart cannot move at all.
  const moverIsReal = (() => {
    const s = createState()
    const m = { x: 17, z: -3, vx: 0, vz: 0, heading: Math.PI }
    for (let i = 0; i < 60; i++) stepCartMover(s, m, 0, -1, 1 / 60)
    return Math.hypot(m.x - 17, m.z + 3) > 0.5
  })()

  /** The cart parked at a pose, the doctor on foot in the courtyard; null if the wagon body would not fit there. */
  function parkedAt(x: number, z: number, heading: number): GameState | null {
    const s = createState()
    const cart = s.tools[0]!
    s.unlocks.cart = true
    cart.kind = 'cart'
    cart.holder = 'none'
    cart.armed = true
    s.player.mode = 'foot'
    s.player.tool = -1
    standAt(s, 2, -4)
    // a pose the static colliders would push the cart out of is not one the doctor could have left it in
    const probe = { x, z, vx: 0, vz: 0, heading }
    stepCartMover(s, probe, 0, 0, 1 / 60)
    if (Math.hypot(probe.x - x, probe.z - z) > 1e-9) return null
    cart.x = x
    cart.z = z
    cart.heading = heading
    return s
  }

  const M = P.GRINDER_ACCEPT_MARGIN
  /** Where the river would hold a bubble of radius r docked on the cart (SPEC 2.3). */
  function seatOf(s: GameState, r: number) {
    const cart = s.tools[0]!
    const o = P.CART_BLADE_OFFSET + P.DOCK_SEAT * r
    return { x: cart.x + Math.sin(cart.heading) * o, z: cart.z + Math.cos(cart.heading) * o }
  }
  const onTray = (p: { x: number; z: number }) => p.x >= L.GRINDER[0] - M && p.x <= L.GRINDER[2] + M && p.z >= L.GRINDER[1] - M && p.z <= L.GRINDER[3] + M
  function dock(s: GameState, id: number, size: BubbleSize) {
    const r = P.BUBBLE_DIAMETER[size] / 2
    const at = seatOf(s, r)
    s.bubbles.push({ id, size, r, x: at.x, z: at.z, vx: 0, vz: 0, roll: 0, state: 'docked', t: 0, tool: 0, age: 5 })
    s.tools[0]!.bubble = id
    return r
  }
  /**
   * Plays the river and the grinder for one docked bubble: it rides on the blade and is taken off as soon as its
   * centre is in the accept zone while the grinder is idle. Returns the seconds until then, or -1.
   */
  function deliver(s: GameState, r: number, dt: number, max: number, each?: () => void): number {
    return runUntil(s, max, dt, stepHelpers, () => {
      each?.()
      const at = seatOf(s, r)
      const b = s.bubbles[0]!
      b.x = at.x
      b.z = at.z
      if (s.grinder.state !== 'idle' || !onTray(at)) return false
      s.bubbles.length = 0
      s.tools[0]!.bubble = -1
      return true
    })
  }
  function checkPose(s: GameState, dt: number, last: { x: number; z: number; state: string }) {
    const d = s.driver
    const cart = s.tools[0]!
    expect(Number.isFinite(d.x + d.z + d.heading + d.vx + d.vz + d.t + d.cycleT)).toBe(true)
    if (d.state !== 'toCart') {
      expect(cart.holder).toBe('driver')
      expect([cart.x, cart.z, cart.heading]).toEqual([d.x, d.z, d.heading])
      expect(cart.armed).toBe(false)
      // the cart never jumps: he only moves it through the mover
      if (last.state !== 'toCart') expect(Math.hypot(d.x - last.x, d.z - last.z)).toBeLessThanOrEqual(P.CART_SPEED * dt + 0.05)
    }
    last.x = d.x
    last.z = d.z
    last.state = d.state
  }

  test.skipIf(!moverIsReal)('from any pose the doctor can have parked the cart in, he gets to his post in the river and waits there', () => {
    const rng = makeRng(2024)
    let tried = 0
    let worst = 0
    for (let k = 0; tried < 60 && k < 1000; k++) {
      // half of them where a doctor really leaves a cart: at the work-area boundary, pointing west
      const boundary = k % 2 === 0
      const x = boundary ? P.WORK_AREA_MIN_X : randRange(rng, P.WORK_AREA_MIN_X, 21)
      const z = randRange(rng, -19, 3.5)
      const h = boundary ? -Math.PI / 2 + randRange(rng, -1, 1) : randRange(rng, -Math.PI, Math.PI)
      const s = parkedAt(x, z, h)
      if (!s) continue
      tried++
      const dt = DTS[tried % 2]!
      s.unlocks.driver = true
      const d = s.driver
      const last = { x: 0, z: 0, state: 'toCart' }
      let seeking = 0
      const t = runUntil(s, 80, dt, stepHelpers, () => {
        checkPose(s, dt, last)
        seeking = d.state === 'seek' ? seeking + dt : 0
        return seeking >= 2 // two seconds in a row: he is inside the leash of his post, not just passing through
      })
      if (t < 0) throw new Error(`never settled from (${x.toFixed(2)}, ${z.toFixed(2)}, ${h.toFixed(2)}) at ${dtName(dt)}: ${d.state} at (${d.x.toFixed(2)}, ${d.z.toFixed(2)})`)
      worst = Math.max(worst, t)
      // in the river beside the grinder, east of it
      expect(d.x).toBeGreaterThan(L.GRINDER[2] + 4)
      expect(d.z).toBeGreaterThan(L.GRINDER[1] - 1)
      expect(d.z).toBeLessThan(L.GRINDER[3] + 1)
    }
    expect(tried).toBe(60)
    expect(worst).toBeGreaterThan(0)
  })

  test.skipIf(!moverIsReal)('a bubble handed over with the cart behind the grinder is carried out, not wedged against it', () => {
    // [x, z, heading]: south and west of the grinder, where the straight line to the river is closed
    const poses: [number, number, number][] = [[9.0, 1.6, 1.17], [9.8, 0.6, 0.07], [12.0, 1.6, -0.85], [8.4, 1.4, 0.02], [10.6, 2.9, 2.99], [9.0, 3.3, 2.02], [8.3, 0.6, -0.21], [9.4, 2.7, -2.93]]
    let i = 0
    for (const [x, z, h] of poses) {
      for (const dt of DTS) {
        const s = parkedAt(x, z, h)
        expect(s).not.toBeNull()
        if (!s) continue
        const size = (['S', 'M', 'L'] as const)[i++ % 3]!
        const r = dock(s, 500, size)
        s.unlocks.driver = true
        const last = { x: 0, z: 0, state: 'toCart' }
        const t = deliver(s, r, dt, 45, () => checkPose(s, dt, last))
        if (t < 0) throw new Error(`never delivered from (${x}, ${z}, ${h}) at ${dtName(dt)}: stuck at (${s.driver.x.toFixed(2)}, ${s.driver.z.toFixed(2)})`)
        // and he is back at work afterwards
        let seeking = 0
        expect(runUntil(s, 60, dt, stepHelpers, () => (seeking = s.driver.state === 'seek' ? seeking + dt : 0) >= 2)).toBeGreaterThan(0)
      }
    }
  })

  for (const dt of DTS) {
    test.skipIf(!moverIsReal)(`ten catches at random moments: each one reaches the tray, at least DRIVER_MIN_CYCLE apart, one emoji each (${dtName(dt)})`, () => {
      const rng = makeRng(99)
      const s = parkedAt(13.8, -3.0, -Math.PI / 2)!
      s.unlocks.driver = true
      const last = { x: 0, z: 0, state: 'toCart' }
      const check = () => checkPose(s, dt, last)
      runUntil(s, 20, dt, stepHelpers, () => (check(), s.driver.state === 'seek'))
      let busyUntil = -1
      let lastDelivery = -Infinity
      const gaps: number[] = []
      for (let c = 0; c < 10; c++) {
        // the next bubble drifts into the blade some time after he is ready for it
        let seeking = 0
        const wait = randRange(rng, 0.3, 4)
        expect(runUntil(s, 40, dt, stepHelpers, () => {
          check()
          s.grinder.state = s.time < busyUntil ? 'grinding' : 'idle'
          seeking = s.driver.state === 'seek' ? seeking + dt : 0
          return seeking >= wait
        })).toBeGreaterThan(0)
        const r = dock(s, 600 + c, (['S', 'M', 'L'] as const)[randInt(rng, 0, 2)]!)
        // the doctor sometimes feeds the grinder himself just then
        if (rand(rng) < 0.4) busyUntil = s.time + randRange(rng, 0.5, 3)
        const t = deliver(s, r, dt, 30, () => {
          check()
          s.grinder.state = s.time < busyUntil ? 'grinding' : 'idle'
          expect(s.driver.state).toBe('deliver')
        })
        expect(t).toBeGreaterThan(0)
        if (lastDelivery > -Infinity) gaps.push(s.time - lastDelivery)
        lastDelivery = s.time
        busyUntil = s.time + P.GRIND_SLIDE_TIME + P.GRIND_FREE
        s.time += dt
        stepHelpers(s, dt)
        check()
        expect(s.driver.state).toBe('backOff')
      }
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(P.DRIVER_MIN_CYCLE - 2 * dt)
      expect(Math.max(...gaps)).toBeLessThan(25)
      run(s, 1, dt, stepHelpers, check)
      expect(events(s, 'emoji')).toEqual(new Array(10).fill({ type: 'emoji', kind: 'happy', who: 'driver' }))
    })
  }

  test('he is hired once: a later step never resets the spare scoop or his walk', () => {
    const dt = 1 / 60
    const s = parkedAt(13.8, -3.0, -Math.PI / 2)!
    s.unlocks.driver = true
    run(s, 0.1, dt, stepHelpers)
    const spare = s.tools[1]!
    expect(spare.exists).toBe(true)
    // the doctor picks the spare scoop up and walks off with it
    spare.holder = 'player'
    spare.armed = false
    spare.x = 15
    spare.z = -4
    spare.age = 3
    s.tools[0]!.armed = true // stepTools re-arms a parked tool when the doctor is far away
    run(s, 0.05, dt, stepHelpers)
    expect(s.tools[0]!.armed).toBe(false) // still reserved for the driver
    run(s, 30, dt, stepHelpers)
    expect([spare.holder, spare.x, spare.z, spare.exists]).toEqual(['player', 15, -4, true])
    expect(spare.age).toBe(3)
    expect(s.tools[0]!.holder).toBe('driver')
  })

  // The real thing: river, bubbles, docking and the grinder. Skipped while any of them is a stub.
  for (const dt of DTS) {
    test.skipIf(!moverIsReal)(`with the real river he catches and delivers bubbles (${dtName(dt)})`, () => {
      const s = createState(3)
      s.unlocks.cart = true
      s.unlocks.driver = true
      const input = { mx: 0, mz: 0 }
      const d = s.driver
      const deliveries: number[] = []
      let docks = 0
      let emoji = 0
      let seated = 0
      for (let i = 0; i < Math.round(32 / dt); i++) {
        step(s, input, dt)
        expect(Number.isFinite(d.x + d.z + d.heading + d.vx + d.vz)).toBe(true)
        if (d.present && d.state !== 'toCart') {
          seated++
          expect(SEATED).toContain(d.state)
          expect(s.tools[0]!.holder).toBe('driver')
        }
        for (const e of s.events) {
          if (e.type === 'grindStart') deliveries.push(s.time)
          else if (e.type === 'bubbleDock' && e.tool === 0) docks++
          else if (e.type === 'emoji' && e.who === 'driver') emoji++
        }
        s.events.length = 0
      }
      expect(seated).toBeGreaterThan(0)
      expect(Math.abs(docks - emoji)).toBeLessThanOrEqual(1) // the last catch may be younger than the emoji delay
      if (docks === 0) return // no river yet
      expect(deliveries.length).toBeGreaterThanOrEqual(2)
      for (let i = 1; i < deliveries.length; i++) expect(deliveries[i]! - deliveries[i - 1]!).toBeGreaterThanOrEqual(P.DRIVER_MIN_CYCLE - 0.01)
      expect(s.player.mode).toBe('foot') // the cart was taken out of the doctor's hands
      expect(s.tools[1]!.exists).toBe(true)
    })
  }
})
