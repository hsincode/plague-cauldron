// Economy package: pallet / wallet / bursar (economy.ts), price pads (pads.ts), guide arrow + win + housekeeping
// (guide.ts), porter and cart driver (helpers.ts). Scenarios are built by setting state fields directly and calling
// only this package's step functions, so they hold whether the other packages are stubs or real.
import { describe, expect, test } from 'bun:test'
import { L, P, UNLOCKS, UNLOCK_DISCHARGE_GATE, type UnlockId } from '../src/config'
import { BURSAR_RATE, stepEconomy } from '../src/sim/economy'
import type { EventOf, EventType } from '../src/sim/events'
import { pickupFlasks, stepFlasks } from '../src/sim/flasks'
import { FLASK_ARROW_HOVER, MAX_UNREAD_EVENTS, stepGuide } from '../src/sim/guide'
import { stepHelpers } from '../src/sim/helpers'
import { PAD_A_DELAY, padPayDuration, stepPads } from '../src/sim/pads'
import { stepCartMover } from '../src/sim/player'
import { createState } from '../src/sim/state'
import type { GameState, Pad, Villager } from '../src/sim/types'

const DTS = [1 / 60, 1 / 144]
const dtName = (dt: number) => `dt = 1/${Math.round(1 / dt)}`

type Sys = (s: GameState, dt: number) => void

/** Step `sys` for `seconds`; `each` runs after every step. */
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

/** Mark every unlock before `id` as bought and let the pads catch up. */
function buyBefore(s: GameState, id: UnlockId) {
  for (const u of UNLOCKS) {
    if (u.id === id) break
    s.unlocks[u.id] = true
  }
}

// ---------------------------------------------------------------------------------------------------------------
describe('pallet and wallet', () => {
  for (const dt of DTS) {
    test(`fountain gold lands when its flight time is over (${dtName(dt)})`, () => {
      const s = createState()
      farAway(s)
      s.pallet.incoming.push(0.5, 30, 1.0, 20)
      run(s, 0.45, dt, stepEconomy)
      expect(s.pallet.gold).toBe(0)
      expect(s.pallet.incoming.length).toBe(4)
      run(s, 0.1, dt, stepEconomy)
      expect(s.pallet.gold).toBe(30)
      expect(s.pallet.sinceLanding).toBeLessThan(0.1)
      run(s, 0.5, dt, stepEconomy)
      expect(s.pallet.gold).toBe(50)
      expect(s.pallet.incoming.length).toBe(0)
      run(s, 1, dt, stepEconomy)
      expect(s.pallet.sinceLanding).toBeGreaterThan(0.9)
      expect(s.wallet).toBe(0) // nobody near: nothing is collected
    })

    test(`pickup runs at PICKUP_RATE in whole gold, nothing lost or duplicated (${dtName(dt)})`, () => {
      const s = createState()
      atPallet(s)
      s.pallet.gold = 100
      let sawCollecting = false
      const check = () => {
        expect(Number.isInteger(s.wallet)).toBe(true)
        expect(Number.isInteger(s.pallet.gold)).toBe(true)
        expect(s.wallet + s.pallet.gold).toBe(100)
        expect(s.player.carriedGold).toBe(s.wallet)
        expect(s.stats.totalGold).toBe(s.wallet)
        sawCollecting ||= s.pallet.collecting
      }
      run(s, 0.5, dt, stepEconomy, check)
      expect(Math.abs(s.wallet - P.PICKUP_RATE * 0.5)).toBeLessThanOrEqual(2)
      expect(s.pallet.collecting).toBe(true)
      expect(s.pallet.pickups).toBe(0)
      run(s, 0.5 + 3 * dt, dt, stepEconomy, check)
      expect(s.wallet).toBe(100)
      expect(s.pallet.gold).toBe(0)
      expect(s.pallet.collecting).toBe(false)
      expect(sawCollecting).toBe(true)
      expect(s.pallet.pickups).toBe(1)
      expect(events(s, 'coinPickupStart').length).toBe(1)
      expect(events(s, 'coinPickupEnd').map(e => e.gold)).toEqual([100])
      run(s, 1, dt, stepEconomy, check) // an empty pallet does not start pickups
      expect(events(s, 'coinPickupStart').length).toBe(1)
    })

    test(`one pickup spans a fountain that is still landing (${dtName(dt)})`, () => {
      const s = createState()
      atPallet(s)
      // a rope of 25 coin meshes worth 2 gold each plus one odd coin, as the bath would push it
      for (let i = 0; i < 25; i++) s.pallet.incoming.push(0.1 + i * 0.04, 2)
      s.pallet.incoming.push(1.3, 7)
      const total = 57
      run(s, 2.5, dt, stepEconomy, () => {
        expect(Number.isInteger(s.wallet)).toBe(true)
        expect(s.wallet + s.pallet.gold + flying(s)).toBe(total)
      })
      expect(s.wallet).toBe(total)
      expect(s.player.carriedGold).toBe(total)
      expect(s.pallet.pickups).toBe(1)
      expect(events(s, 'coinPickupStart').length).toBe(1)
      expect(events(s, 'coinPickupEnd').map(e => e.gold)).toEqual([total])
    })
  }

  test('walking away pauses the pickup and leaves the rest on the pallet', () => {
    const dt = 1 / 60
    const s = createState()
    atPallet(s)
    s.pallet.gold = 100
    run(s, 0.3, dt, stepEconomy)
    const taken = s.wallet
    expect(taken).toBeGreaterThan(25)
    expect(taken).toBeLessThan(35)
    farAway(s)
    run(s, 1, dt, stepEconomy)
    expect(s.pallet.collecting).toBe(false)
    expect(s.wallet).toBe(taken)
    expect(s.pallet.gold).toBe(100 - taken)
    expect(s.pallet.pickups).toBe(0) // the pallet was not emptied
    expect(events(s, 'coinPickupEnd').map(e => e.gold)).toEqual([taken])
    atPallet(s)
    run(s, 1, dt, stepEconomy)
    expect(s.wallet).toBe(100)
    expect(s.pallet.pickups).toBe(1)
    expect(events(s, 'coinPickupEnd').map(e => e.gold)).toEqual([taken, 100 - taken])
  })

  test('pickup needs the doctor within PALLET_PICKUP_RADIUS of the pallet centre', () => {
    const s = createState()
    s.pallet.gold = 40
    standAt(s, L.PALLET.x - (P.PALLET_PICKUP_RADIUS + 0.05), L.PALLET.z)
    run(s, 1, 1 / 60, stepEconomy)
    expect(s.wallet).toBe(0)
    standAt(s, L.PALLET.x - (P.PALLET_PICKUP_RADIUS - 0.05), L.PALLET.z)
    run(s, 1, 1 / 60, stepEconomy)
    expect(s.wallet).toBe(40)
  })

  test('carriedGold rises with pickups only and is spent first, never below zero', () => {
    const dt = 1 / 60
    const s = createState()
    s.wallet = 250 // rat coins went straight to the HUD: no discs on the back
    atPallet(s)
    s.pallet.gold = 30
    run(s, 1, dt, stepEconomy)
    expect(s.wallet).toBe(280)
    expect(s.player.carriedGold).toBe(30)

    pad(s, 'nurses').state = 'idle'
    besidePad(s, 'nurses')
    run(s, 0.25, dt, stepPads, () => expect(s.player.carriedGold).toBeGreaterThanOrEqual(0))
    expect(s.player.carriedGold).toBeLessThan(30)
    expect(s.player.carriedGold).toBe(Math.max(0, 30 - pad(s, 'nurses').paid))
    run(s, 1, dt, stepPads, () => expect(s.player.carriedGold).toBeGreaterThanOrEqual(0))
    expect(s.wallet).toBe(230)
    expect(s.player.carriedGold).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('bursar', () => {
  for (const dt of DTS) {
    test(`collects BURSAR_DELAY after the fountain has ended, straight to the wallet (${dtName(dt)})`, () => {
      const s = createState()
      s.unlocks.bursar = true
      farAway(s)
      s.pallet.incoming.push(0.2, 20, 0.9, 30)
      const check = () => {
        expect(Number.isInteger(s.wallet)).toBe(true)
        expect(s.wallet + s.pallet.gold + flying(s)).toBe(50)
      }
      // 0.9 s flight + 0.5 s delay: nothing may move before 1.4 s
      run(s, 0.9 + P.BURSAR_DELAY - 0.05, dt, stepEconomy, check)
      expect(s.wallet).toBe(0)
      expect(s.pallet.gold).toBe(50)
      expect(events(s, 'bursarCollect').length).toBe(0)
      run(s, 0.05 + 50 / BURSAR_RATE + 0.1, dt, stepEconomy, check)
      expect(s.wallet).toBe(50)
      expect(s.pallet.gold).toBe(0)
      expect(s.stats.totalGold).toBe(50)
      expect(s.player.carriedGold).toBe(0)
      expect(events(s, 'bursarCollect').map(e => e.gold)).toEqual([50])
      expect(events(s, 'coinPickupStart').length).toBe(0)
      expect(s.pallet.pickups).toBe(0)
      run(s, 2, dt, stepEconomy, check)
      expect(events(s, 'bursarCollect').length).toBe(1) // once per collection
    })

    test(`flies at about BURSAR_RATE (${dtName(dt)})`, () => {
      const s = createState()
      s.unlocks.bursar = true
      farAway(s)
      s.pallet.gold = 600 // left there before the bursar was hired
      run(s, 1, dt, stepEconomy)
      expect(Math.abs(s.wallet - BURSAR_RATE)).toBeLessThanOrEqual(6)
      run(s, 1.1, dt, stepEconomy)
      expect(s.wallet).toBe(600)
      expect(events(s, 'bursarCollect').map(e => e.gold)).toEqual([600])
    })
  }

  test('without the unlock the gold just waits on the pallet', () => {
    const s = createState()
    farAway(s)
    s.pallet.gold = 80
    run(s, 3, 1 / 60, stepEconomy)
    expect(s.wallet).toBe(0)
    expect(s.pallet.gold).toBe(80)
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('pad triggers', () => {
  const dt = 1 / 60
  const hidden = (s: GameState, id: UnlockId, seconds = 0.5) => {
    run(s, seconds, dt, stepPads)
    expect(pad(s, id).state).toBe('hidden')
  }
  const pops = (s: GameState, id: UnlockId) => {
    run(s, 2 * dt, dt, stepPads)
    expect(pad(s, id).state).toBe('popIn')
    const pop = events(s, 'padPop').filter(e => e.id === id)
    expect(pop.length).toBe(1)
    expect(pop[0]!.x).toBe(pad(s, id).x)
    expect(pop[0]!.z).toBe(pad(s, id).z)
    run(s, P.PAD_POP_TIME + 2 * dt, dt, stepPads)
    expect(pad(s, id).state).toBe('idle')
    expect(events(s, 'padPop').filter(e => e.id === id).length).toBe(1)
  }

  test('nothing is for sale at the start', () => {
    const s = createState()
    s.wallet = 9999
    run(s, 2, dt, stepPads)
    expect(s.pads.every(p => p.state === 'hidden')).toBe(true)
    expect(s.events.length).toBe(0)
  })

  test('A (nurses): 0.2 s after a patient lies in a bed that has no nurse', () => {
    const s = createState()
    s.beds[0]!.state = 'reserved' // on his way: not lying yet
    s.beds[0]!.villager = 7
    hidden(s, 'nurses')
    s.beds[0]!.state = 'occupied'
    run(s, PAD_A_DELAY - 0.05, dt, stepPads)
    expect(pad(s, 'nurses').state).toBe('hidden')
    run(s, 0.05, dt, stepPads)
    pops(s, 'nurses')
    expect(s.pads.filter(p => p.state !== 'hidden').length).toBe(1)
  })

  test('A stays hidden while every occupied bed has a nurse', () => {
    const s = createState()
    s.beds[1]!.state = 'occupied'
    s.nurses.push({ id: 1, bed: 1, x: 0, z: 0, heading: 0, state: 'idle', path: [], pathI: 0, age: 0 })
    hidden(s, 'nurses')
  })

  test('B (usher): nurses bought and the first drill sortie paid out', () => {
    const s = createState()
    s.flags.firstSortiePaid = true
    hidden(s, 'usher') // nurses not bought yet
    s.flags.firstSortiePaid = false
    buyBefore(s, 'usher')
    hidden(s, 'usher')
    s.flags.firstSortiePaid = true
    pops(s, 'usher')
  })

  test('C (cart): usher bought, then the next pallet pickup completes', () => {
    const s = createState()
    const both: Sys = (st, d) => {
      stepEconomy(st, d)
      stepPads(st, d)
    }
    buyBefore(s, 'usher')
    // a pickup BEFORE the usher is bought does not count
    atPallet(s)
    s.pallet.gold = 20
    run(s, 0.5, dt, both)
    expect(s.pallet.pickups).toBe(1)
    farAway(s)
    s.unlocks.usher = true
    run(s, 0.5, dt, both)
    expect(pad(s, 'cart').state).toBe('hidden')
    // gold on the pallet is not enough either: it has to be picked up completely
    s.pallet.gold = 50
    run(s, 0.5, dt, both)
    expect(pad(s, 'cart').state).toBe('hidden')
    atPallet(s)
    run(s, 0.3, dt, both)
    expect(pad(s, 'cart').state).toBe('hidden')
    const t = runUntil(s, 1, dt, both, () => pad(s, 'cart').state !== 'hidden')
    expect(t).toBeGreaterThan(0)
    expect(s.pallet.pickups).toBe(2)
    expect(s.pallet.gold).toBe(0)
    expect(events(s, 'padPop').map(e => e.id)).toEqual(['cart'])
  })

  test('D (ward 2): cart bought and the bath blocked by reserved beds', () => {
    const s = createState()
    buyBefore(s, 'ward2')
    hidden(s, 'ward2')
    s.cauldron.blockedByBeds = true
    s.cauldron.blockedT = 0
    hidden(s, 'ward2')
    s.cauldron.blockedByBeds = false
    s.cauldron.blockedT = 1.5 // blocked for another reason (no potion)
    hidden(s, 'ward2')
    s.cauldron.blockedByBeds = true
    pops(s, 'ward2')
  })

  test('D also appears once 8 villagers are discharged', () => {
    const s = createState()
    buyBefore(s, 'ward2')
    s.stats.discharged = 7
    hidden(s, 'ward2')
    s.stats.discharged = 8
    pops(s, 'ward2')
  })

  test('D needs the cart first', () => {
    const s = createState()
    buyBefore(s, 'cart')
    s.cauldron.blockedByBeds = true
    s.cauldron.blockedT = 3
    s.stats.discharged = 50
    hidden(s, 'ward2')
  })

  for (const id of ['porter', 'bursar', 'bigCauldron', 'drill2', 'driver'] as const) {
    test(`${id}: previous pad bought and discharged >= ${UNLOCK_DISCHARGE_GATE[id]}`, () => {
      const gate = UNLOCK_DISCHARGE_GATE[id]!
      const s = createState()
      const prev = UNLOCKS[UNLOCKS.findIndex(u => u.id === id) - 1]!.id
      buyBefore(s, prev) // everything except the previous pad
      s.stats.discharged = P.TOTAL_VILLAGERS
      hidden(s, id)
      s.unlocks[prev] = true
      s.stats.discharged = gate - 1
      hidden(s, id)
      s.stats.discharged = gate
      pops(s, id)
    })
  }

  test('an unlock set from outside removes its pad without events', () => {
    const s = createState()
    s.unlocks.nurses = true
    run(s, 0.1, dt, stepPads)
    expect(pad(s, 'nurses').state).toBe('gone')
    expect(s.events.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('paying a pad', () => {
  /** A fresh state in which `id` lies idle and the doctor stands still next to it. */
  function ready(id: UnlockId, wallet: number) {
    const s = createState()
    buyBefore(s, id)
    run(s, 0.05, 1 / 60, stepPads) // earlier pads disappear
    const p = pad(s, id)
    p.state = 'idle'
    p.t = 0
    s.wallet = wallet
    besidePad(s, id)
    s.events.length = 0
    return s
  }

  for (const dt of DTS) {
    for (const id of ['nurses', 'ward2', 'porter', 'driver'] as const) {
      test(`${id}: the wallet counts down linearly for clamp(price / 135, 0.5, 0.9) s (${dtName(dt)})`, () => {
        const price = UNLOCKS.find(u => u.id === id)!.price
        const duration = padPayDuration(price)
        expect(duration).toBeCloseTo(Math.min(0.9, Math.max(0.5, price / 135)), 9)
        const start = price + 7
        const s = ready(id, start)
        const p = pad(s, id)
        s.player.carriedGold = 20

        s.time += dt
        stepPads(s, dt)
        expect(p.state).toBe('paying')
        expect(events(s, 'padPayStart').map(e => e.id)).toEqual([id])
        expect(s.wallet).toBe(start)

        let last = s.wallet
        const check = () => {
          expect(Number.isInteger(s.wallet)).toBe(true)
          expect(s.wallet + p.paid).toBe(start)
          expect(s.wallet).toBeLessThanOrEqual(last)
          last = s.wallet
        }
        run(s, duration / 2, dt, stepPads, check)
        expect(Math.abs(p.paid - price / 2)).toBeLessThanOrEqual((price / duration) * dt + 1)
        const rest = runUntil(s, 2, dt, stepPads, () => {
          check()
          return p.state !== 'paying'
        })
        expect(Math.abs(duration / 2 + rest - duration)).toBeLessThanOrEqual(2.5 * dt)
        expect(p.state).toBe('done')
        expect(p.paid).toBe(price)
        expect(s.wallet).toBe(7)
        expect(s.player.carriedGold).toBe(0)

        // the unlock is applied PAD_DONE_DELAY later, with both events
        expect(s.unlocks[id]).toBe(false)
        run(s, P.PAD_DONE_DELAY - 2 * dt, dt, stepPads)
        expect(s.unlocks[id]).toBe(false)
        expect(events(s, 'unlock').length).toBe(0)
        run(s, 4 * dt, dt, stepPads)
        expect(s.unlocks[id]).toBe(true)
        expect(p.state).toBe('gone')
        expect(events(s, 'padPaid')).toEqual([{ type: 'padPaid', id, x: p.x, z: p.z }])
        expect(events(s, 'unlock')).toEqual([{ type: 'unlock', id, x: p.x, z: p.z }])
        run(s, 1, dt, stepPads)
        expect(events(s, 'unlock').length).toBe(1)
        expect(s.wallet).toBe(7)
      })
    }
  }

  test('leaving the radius pauses the payment and keeps the progress', () => {
    const dt = 1 / 60
    const s = ready('ward2', 150)
    const p = pad(s, 'ward2')
    const duration = padPayDuration(100)
    run(s, 0.3, dt, stepPads)
    const paid = p.paid
    expect(paid).toBeGreaterThan(25)
    expect(paid).toBeLessThan(55)
    standAt(s, p.x + P.PAD_PAY_RADIUS + 0.3, p.z)
    run(s, 1, dt, stepPads)
    expect(p.state).toBe('idle')
    expect(p.paid).toBe(paid)
    expect(s.wallet).toBe(150 - paid)
    besidePad(s, 'ward2')
    const rest = runUntil(s, 2, dt, stepPads, () => p.state === 'done')
    // 0.3 s before the pause (one step of it spent on the dwell check) + the rest = the full duration
    expect(Math.abs(0.3 + rest - duration)).toBeLessThanOrEqual(4 * dt)
    expect(s.wallet).toBe(50)
    expect(events(s, 'padPayStart').length).toBe(2)
    run(s, 0.5, dt, stepPads)
    expect(s.unlocks.ward2).toBe(true)
  })

  test('nothing happens while the wallet does not cover the remaining price', () => {
    const dt = 1 / 60
    const s = ready('ward2', 99)
    const p = pad(s, 'ward2')
    run(s, 2, dt, stepPads)
    expect(p.state).toBe('idle')
    expect(p.paid).toBe(0)
    expect(s.wallet).toBe(99)
    expect(s.events.length).toBe(0)
    s.wallet = 100
    run(s, 2, dt, stepPads)
    expect(s.unlocks.ward2).toBe(true)
    expect(s.wallet).toBe(0)
  })

  test('a half-paid pad only needs the remaining price', () => {
    const s = ready('ward2', 30)
    pad(s, 'ward2').paid = 70
    run(s, 2, 1 / 60, stepPads)
    expect(s.unlocks.ward2).toBe(true)
    expect(s.wallet).toBe(0)
  })

  test('payment needs the dwell and the radius', () => {
    const dt = 1 / 60
    const s = ready('nurses', 500)
    const p = pad(s, 'nurses')
    s.player.stillT = 0 // still moving
    run(s, 1, dt, stepPads)
    expect(p.state).toBe('idle')
    s.player.stillT = P.PAD_PAY_DWELL
    standAt(s, p.x + P.PAD_PAY_RADIUS + 0.1, p.z)
    run(s, 1, dt, stepPads)
    expect(p.state).toBe('idle')
    standAt(s, p.x + P.PAD_PAY_RADIUS - 0.1, p.z)
    run(s, 2 * dt, dt, stepPads)
    expect(p.state).toBe('paying')
  })

  test('pads are bought strictly in UNLOCKS order, one at a time', () => {
    const dt = 1 / 60
    const s = createState()
    const total = UNLOCKS.reduce((sum, u) => sum + u.price, 0)
    s.wallet = total + 11
    // every trigger that does not depend on the previous purchase is already true
    s.stats.discharged = P.TOTAL_VILLAGERS - 1
    s.flags.firstSortiePaid = true
    s.cauldron.blockedByBeds = true
    s.cauldron.blockedT = 5
    s.beds[0]!.state = 'occupied'
    const order: UnlockId[] = []
    let seen = 0
    for (let i = 0; i < 60 / dt && order.length < UNLOCKS.length; i++) {
      s.time += dt
      stepEconomy(s, dt)
      stepPads(s, dt)
      const open = s.pads.filter(p => p.state !== 'hidden' && p.state !== 'gone')
      expect(open.length).toBeLessThanOrEqual(1)
      expect(s.pads.filter(p => p.state === 'paying').length).toBeLessThanOrEqual(1)
      for (; seen < s.events.length; seen++) {
        const e = s.events[seen]!
        if (e.type === 'unlock') order.push(e.id)
      }
      if (open[0]) besidePad(s, open[0].id)
      else if (s.unlocks.usher && !s.unlocks.cart) {
        // pad C wants a completed pallet pickup after the usher
        if (s.pallet.pickups === 0 && s.pallet.gold === 0) s.pallet.gold = 10
        atPallet(s)
      }
    }
    expect(order).toEqual(UNLOCKS.map(u => u.id))
    expect(UNLOCKS.every(u => s.unlocks[u.id])).toBe(true)
    expect(s.wallet).toBe(11 + 10)
    expect(s.pads.every(p => p.state === 'gone')).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('guide arrow', () => {
  const dt = 1 / 60
  const tick = (s: GameState, n = 1) => run(s, n * dt, dt, stepGuide)
  let nextFlask = 1
  const flask = (x: number, z: number, age = 1) => ({ id: nextFlask++, x, z, fromX: 8.5, fromZ: z, age, rot: 0 })

  test('hidden at the start', () => {
    const s = createState()
    tick(s, 10)
    expect(s.guide.kind).toBe('none')
    expect(s.events.length).toBe(0)
  })

  test('first flask pile: from the last landing until the pickup starts, never again', () => {
    const s = createState()
    s.groundFlasks.push(flask(7, -2), flask(8, -3), flask(7.5, -1, 0.01)) // one still in the air
    tick(s, 3)
    expect(s.guide.kind).toBe('none')
    s.groundFlasks[2]!.age = 1
    s.grinder.toEject = 4 // more to come
    tick(s, 3)
    expect(s.guide.kind).toBe('none')
    s.grinder.toEject = 0
    tick(s, 30)
    expect(s.guide.kind).toBe('flasks')
    expect(s.guide.x).toBeCloseTo(7.5, 6)
    expect(s.guide.z).toBeCloseTo(-2, 6)
    expect(s.guide.y).toBe(FLASK_ARROW_HOVER)
    expect(events(s, 'guide').map(e => e.kind)).toEqual(['flasks']) // emitted on change only

    s.groundFlasks.pop() // the doctor's magnet took the first mesh
    s.flaskHalf = 1
    tick(s)
    expect(s.guide.kind).toBe('none')
    expect(events(s, 'guide').map(e => e.kind)).toEqual(['flasks', 'none'])

    s.flaskHalf = 0
    s.groundFlasks.length = 0
    s.groundFlasks.push(flask(7, -2), flask(8, -3)) // a later pile gets no arrow
    tick(s, 30)
    expect(s.guide.kind).toBe('none')
  })

  test('pallet: holds gold, no fountain in flight, nobody collecting, no bursar', () => {
    const s = createState()
    farAway(s)
    const both: Sys = (st, d) => {
      stepEconomy(st, d)
      stepGuide(st, d)
    }
    s.pallet.incoming.push(0.3, 25, 0.6, 25)
    run(s, 0.5, dt, both)
    expect(s.pallet.gold).toBe(25)
    expect(s.guide.kind).toBe('none') // the fountain is still in flight
    run(s, 0.2, dt, both)
    expect(s.guide.kind).toBe('pallet')
    expect([s.guide.x, s.guide.z, s.guide.y]).toEqual([L.PALLET.x, L.PALLET.z, P.ARROW_HOVER])
    atPallet(s)
    run(s, 0.1, dt, both)
    expect(s.pallet.collecting).toBe(true)
    expect(s.guide.kind).toBe('none') // hidden as soon as the pickup starts
    farAway(s)
    run(s, 0.1, dt, both)
    expect(s.guide.kind).toBe('pallet') // he left coins behind
    s.unlocks.bursar = true
    stepGuide(s, dt)
    expect(s.guide.kind).toBe('none')
    expect(events(s, 'guide').map(e => e.kind)).toEqual(['pallet', 'none', 'pallet', 'none'])
  })

  test('pad: idle and affordable, until its payment starts', () => {
    const s = createState()
    farAway(s)
    const p = pad(s, 'nurses')
    p.state = 'idle'
    s.wallet = 49
    tick(s, 5)
    expect(s.guide.kind).toBe('none')
    s.wallet = 50
    tick(s, 5)
    expect(s.guide.kind).toBe('pad')
    expect([s.guide.x, s.guide.z, s.guide.y]).toEqual([p.x, p.z, P.ARROW_HOVER])
    p.state = 'paying'
    tick(s)
    expect(s.guide.kind).toBe('none')
    p.state = 'idle' // paused half-way: 20 more would do
    p.paid = 30
    s.wallet = 20
    tick(s)
    expect(s.guide.kind).toBe('pad')
    p.state = 'gone'
    tick(s)
    expect(s.guide.kind).toBe('none')
  })

  test('priority: flask pile, then pallet, then pad; one event per change', () => {
    const s = createState()
    farAway(s)
    s.groundFlasks.push(flask(7, -2), flask(8, -3))
    s.pallet.gold = 50
    pad(s, 'nurses').state = 'idle'
    s.wallet = 500
    tick(s, 20)
    expect(s.guide.kind).toBe('flasks')
    s.player.flasks = 1
    s.groundFlasks.length = 0
    tick(s, 20)
    expect(s.guide.kind).toBe('pallet')
    s.pallet.gold = 0
    tick(s, 20)
    expect(s.guide.kind).toBe('pad')
    expect(events(s, 'guide').map(e => e.kind)).toEqual(['flasks', 'pallet', 'pad'])
    // a different pad is a new target even though the kind stays the same
    pad(s, 'nurses').state = 'gone'
    pad(s, 'usher').state = 'idle'
    tick(s, 20)
    expect(s.guide.x).toBe(pad(s, 'usher').x)
    expect(events(s, 'guide').map(e => e.kind)).toEqual(['flasks', 'pallet', 'pad', 'pad'])
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('win and housekeeping', () => {
  const dt = 1 / 60

  test('win when every villager is discharged, announced once', () => {
    const s = createState()
    s.stats.discharged = P.TOTAL_VILLAGERS - 1
    run(s, 1, dt, stepGuide)
    expect(s.won).toBe(false)
    expect(s.wonAt).toBe(0)
    s.stats.discharged = P.TOTAL_VILLAGERS
    s.pallet.gold = 50 // would attract the arrow
    s.time += dt
    stepGuide(s, dt)
    expect(s.won).toBe(true)
    expect(s.wonAt).toBe(s.time)
    const wonAt = s.wonAt
    run(s, 2, dt, stepGuide)
    expect(s.wonAt).toBe(wonAt)
    expect(events(s, 'win').length).toBe(1)
    expect(s.guide.kind).toBe('none')
  })

  test("villagers in state 'gone' are removed, the others keep their order", () => {
    const s = createState()
    const mk = (id: number, state: Villager['state']): Villager => ({
      id, state, t: 0, x: 0, z: 0, y: 0, heading: 0, look: 'healed', path: [], pathI: 0, speed: 0, slot: -1, bed: -1,
      fromX: 0, fromZ: 0, toX: 0, toZ: 0, delay: 0, seed: 0, alpha: 1,
    })
    const vs = [mk(1, 'gone'), mk(2, 'queued'), mk(3, 'gone'), mk(4, 'toExit'), mk(5, 'inBed'), mk(6, 'gone')]
    s.villagers.push(...vs)
    stepGuide(s, dt)
    expect(s.villagers.map(v => v.id)).toEqual([2, 4, 5])
    expect(s.villagers[0]).toBe(vs[1]!)
    stepGuide(s, dt)
    expect(s.villagers.length).toBe(3)
  })

  test('an undrained event queue is cut to its newest half', () => {
    const s = createState()
    for (let i = 0; i < MAX_UNREAD_EVENTS; i++) s.events.push({ type: 'gateOpen' })
    stepGuide(s, dt)
    expect(s.events.length).toBe(MAX_UNREAD_EVENTS) // at the limit: untouched
    s.events.push({ type: 'gateClose' })
    stepGuide(s, dt)
    expect(s.events.length).toBe(MAX_UNREAD_EVENTS + 1 - ((MAX_UNREAD_EVENTS + 1) >> 1))
    expect(s.events[s.events.length - 1]).toEqual({ type: 'gateClose' })
    // headless run: the queue stays bounded
    for (let i = 0; i < 4 * MAX_UNREAD_EVENTS; i++) {
      s.events.push({ type: 'gateOpen' })
      stepGuide(s, dt)
      expect(s.events.length).toBeLessThanOrEqual(MAX_UNREAD_EVENTS)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('porter', () => {
  const dt = 1 / 60
  let nextFlask = 1000
  const flask = (x: number, z: number) => ({ id: nextFlask++, x, z, fromX: 8.5, fromZ: z, age: 1, rot: 0 })
  const pile = (s: GameState, meshes: number) => {
    for (let i = 0; i < meshes; i++) s.groundFlasks.push(flask(L.FLASK_AREA.x - 0.8 + (i % 4) * 0.5, L.FLASK_AREA.z - 1.2 + Math.floor(i / 4) * 0.8))
  }
  const atHome = (s: GameState) => Math.hypot(s.porter.x - L.PORTER_HOME.x, s.porter.z - L.PORTER_HOME.z) < 0.05
  // The porter runs on flasks.ts (production package). While that is a stub the test plays its part by hand.
  const flasksAreReal = (() => {
    const s = createState()
    s.groundFlasks.push(flask(0, 0), flask(0.1, 0))
    const carrier = { x: 0, z: 0, flasks: 0, pickupAcc: 0 }
    for (let i = 0; i < 60; i++) pickupFlasks(s, carrier, 12, 'porter', dt)
    return carrier.flasks > 0
  })()
  const sys: Sys = (s, d) => {
    stepHelpers(s, d)
    stepFlasks(s, d) // lands thrown flasks; the doctor is far away and takes no part
  }

  function hired() {
    const s = createState()
    farAway(s)
    s.unlocks.porter = true
    return s
  }

  test('appears at his pad when unlocked and walks to his post', () => {
    const s = createState()
    farAway(s)
    run(s, 1, dt, sys)
    expect(s.porter.present).toBe(false)
    s.unlocks.porter = true
    s.time += dt
    sys(s, dt)
    const padE = UNLOCKS.find(u => u.id === 'porter')!
    expect(s.porter.present).toBe(true)
    expect([s.porter.x, s.porter.z]).toEqual([padE.x, padE.z])
    expect(s.porter.age).toBe(0)
    run(s, 1, dt, sys)
    expect(s.porter.state).toBe('idle')
    expect(atHome(s)).toBe(true)
    run(s, 3, dt, sys) // no pile: he stays
    expect(s.porter.state).toBe('idle')
    expect(atHome(s)).toBe(true)
  })

  test('carries a pile into the pot without the doctor and returns home', () => {
    const s = hired()
    run(s, 1, dt, sys)
    pile(s, 10) // 5 units
    expect(runUntil(s, 5, dt, sys, () => s.porter.state === 'collect')).toBeGreaterThan(0)
    // he stopped within the magnet's reach of a flask
    expect(Math.min(...s.groundFlasks.map(f => Math.hypot(f.x - s.porter.x, f.z - s.porter.z)))).toBeLessThan(P.FLASK_PICKUP_RADIUS)
    if (!flasksAreReal) {
      run(s, 0.2, dt, sys)
      s.porter.flasks = 5
      s.groundFlasks.length = 0
    }
    expect(runUntil(s, 8, dt, sys, () => s.porter.state === 'pour')).toBeGreaterThan(0)
    expect(s.groundFlasks.length).toBe(0)
    expect(s.porter.flasks).toBe(5)
    expect(Math.hypot(s.porter.x - L.PORTER_POUR.x, s.porter.z - L.PORTER_POUR.z)).toBeLessThan(0.05)
    expect(Math.hypot(s.porter.x, s.porter.z)).toBeLessThan(P.DEPOSIT_RADIUS)
    if (!flasksAreReal) {
      run(s, 1, dt, sys)
      s.cauldron.potion += s.porter.flasks
      s.porter.flasks = 0
    }
    expect(runUntil(s, 8, dt, sys, () => s.porter.state === 'idle')).toBeGreaterThan(0)
    expect(atHome(s)).toBe(true)
    expect(s.porter.flasks).toBe(0)
    run(s, 1, dt, sys)
    expect(s.cauldron.potion + s.cauldron.incoming.length).toBe(5)
    expect(s.player.flasks).toBe(0)
  })

  test('carries at most PORTER_CARRY units per round', () => {
    const s = hired()
    run(s, 1, dt, sys)
    pile(s, 18) // 9 units
    let most = 0
    const t = runUntil(s, 30, dt, sys, () => {
      most = Math.max(most, s.porter.flasks)
      if (!flasksAreReal && s.porter.state === 'collect' && s.porter.t > 0.2) {
        const take = Math.min(P.PORTER_CARRY, s.groundFlasks.length / 2)
        s.porter.flasks += take
        s.groundFlasks.length -= take * 2
      }
      if (!flasksAreReal && s.porter.state === 'pour' && s.porter.t > 0.5) {
        s.cauldron.potion += s.porter.flasks
        s.porter.flasks = 0
      }
      return s.cauldron.potion + s.cauldron.incoming.length === 9 && s.porter.state === 'idle'
    })
    expect(t).toBeGreaterThan(0)
    expect(most).toBe(P.PORTER_CARRY)
    expect(s.groundFlasks.length).toBe(0)
  })

  test('stays at his post while the pot is full', () => {
    const s = hired()
    run(s, 1, dt, sys)
    s.cauldron.potion = s.cauldron.capacity
    pile(s, 10)
    run(s, 3, dt, sys)
    expect(s.porter.state).toBe('idle')
    expect(atHome(s)).toBe(true)
    expect(s.groundFlasks.length).toBe(10)
  })

  test("never takes what the doctor's own pickup can reach", () => {
    const s = hired()
    run(s, 1, dt, stepHelpers)
    pile(s, 6)
    standAt(s, L.FLASK_AREA.x, L.FLASK_AREA.z) // the doctor stands in the pile with an empty back
    // stepFlasks is left out on purpose: the doctor's magnet never runs, so every flask taken would be the porter's
    run(s, 1.2, dt, stepHelpers)
    expect(s.porter.state).toBe('collect')
    expect(s.porter.flasks).toBe(0)
    expect(s.groundFlasks.length).toBe(6)
  })
})

// ---------------------------------------------------------------------------------------------------------------
describe('cart driver', () => {
  const dt = 1 / 60
  const SEATED = ['seek', 'deliver', 'backOff']
  // stepCartMover belongs to the physics package; while it is a stub the cart cannot move at all.
  const moverIsReal = (() => {
    const s = createState()
    const m = { x: 17, z: -3, vx: 0, vz: 0, heading: Math.PI }
    for (let i = 0; i < 60; i++) stepCartMover(s, m, 0, -1, dt)
    return Math.hypot(m.x - 17, m.z + 3) > 0.5
  })()

  /** The cart parked east of the grinder, the doctor on foot somewhere else. */
  function withParkedCart() {
    const s = createState()
    const cart = s.tools[0]!
    s.unlocks.cart = true
    cart.kind = 'cart'
    cart.holder = 'none'
    cart.armed = true
    cart.x = 13.8
    cart.z = -3.0
    cart.heading = -Math.PI / 2
    s.player.mode = 'foot'
    s.player.tool = -1
    standAt(s, 4, -4)
    return s
  }

  test('appears at his pad, the spare hand scoop appears for the doctor', () => {
    const s = withParkedCart()
    run(s, 1, dt, stepHelpers)
    expect(s.driver.present).toBe(false)
    expect(s.tools[1]!.exists).toBe(false)
    s.unlocks.driver = true
    s.time += dt
    stepHelpers(s, dt)
    const padI = UNLOCKS.find(u => u.id === 'driver')!
    expect(s.driver.present).toBe(true)
    expect(s.driver.state).toBe('toCart')
    expect([s.driver.x, s.driver.z]).toEqual([padI.x, padI.z])
    const spare = s.tools[1]!
    expect(spare.kind).toBe('scoop')
    expect(spare.exists).toBe(true)
    expect(spare.armed).toBe(true)
    expect(spare.holder).toBe('none')
    expect(spare.age).toBe(0)
    expect([spare.x, spare.z]).toEqual([L.SPARE_SCOOP_REST.x, L.SPARE_SCOOP_REST.z])
    expect(s.tools[0]!.armed).toBe(false) // the cart is reserved for him
  })

  test('walks to the seat and takes the cart', () => {
    const s = withParkedCart()
    s.unlocks.driver = true
    const cart = s.tools[0]!
    const t = runUntil(s, 12, dt, stepHelpers, () => cart.holder === 'driver')
    expect(t).toBeGreaterThan(0.5) // he walks there (4 m at running speed), he does not teleport
    expect(t).toBeLessThan(3)
    expect(SEATED).toContain(s.driver.state)
    expect([s.driver.x, s.driver.z, s.driver.heading]).toEqual([cart.x, cart.z, cart.heading])
  })

  test('takes the cart out of the doctor\'s hands as well', () => {
    const s = createState() // the doctor starts with tools[0] in his hands
    s.unlocks.driver = true
    expect(runUntil(s, 12, dt, stepHelpers, () => s.tools[0]!.holder === 'driver')).toBeGreaterThan(0)
    run(s, 1, dt, stepHelpers)
    expect(s.tools[0]!.holder).toBe('driver')
  })

  test('walks round the grinder when the cart is parked on its far side', () => {
    const s = withParkedCart()
    const cart = s.tools[0]!
    cart.x = 9.6
    cart.z = 1.6 // south of the grinder; his pad is north-east of it
    s.unlocks.driver = true
    const [x0, z0, x1, z1] = L.GRINDER
    const t = runUntil(s, 12, dt, stepHelpers, () => {
      const d = s.driver
      if (d.state === 'toCart') expect(d.x > x0 && d.x < x1 && d.z > z0 && d.z < z1).toBe(false)
      return cart.holder === 'driver'
    })
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThan(6)
  })

  /** A fake bubble seated on the cart's blade (docking is the river's job). */
  function dockBubble(s: GameState, id: number) {
    const cart = s.tools[0]!
    s.bubbles.push({ id, size: 'L', r: P.BUBBLE_DIAMETER.L / 2, x: cart.x, z: cart.z, vx: 0, vz: 0, roll: 0, state: 'docked', t: 0, tool: 0, age: 5 })
    cart.bubble = id
  }
  function seated() {
    const s = withParkedCart()
    s.unlocks.driver = true
    runUntil(s, 12, dt, stepHelpers, () => s.tools[0]!.holder === 'driver')
    run(s, 0.5, dt, stepHelpers)
    return s
  }

  test('a capture makes him happy and sends him to the grinder; a delivery restarts the cycle', () => {
    const s = seated()
    const cart = s.tools[0]!
    expect(events(s, 'emoji').length).toBe(0)
    dockBubble(s, 77)
    run(s, 0.2, dt, stepHelpers)
    expect(s.driver.state).toBe('deliver')
    expect(events(s, 'emoji').length).toBe(0) // the emoji shows 0.3 s after contact (SPEC 2.2)
    run(s, 0.3, dt, stepHelpers)
    expect(events(s, 'emoji')).toEqual([{ type: 'emoji', kind: 'happy', who: 'driver' }])
    // the grinder takes it
    s.bubbles.length = 0
    cart.bubble = -1
    s.time += dt
    stepHelpers(s, dt)
    expect(s.driver.state).toBe('backOff')
    expect(s.driver.cycleT).toBeLessThan(0.1)
    run(s, 30, dt, stepHelpers)
    expect(events(s, 'emoji').length).toBe(1)
  })

  test('one emoji per capture, even when the bubble is gone at once or the delivery drags on', () => {
    const s = seated()
    const cart = s.tools[0]!
    dockBubble(s, 78)
    run(s, 0.1, dt, stepHelpers)
    s.bubbles.length = 0
    cart.bubble = -1 // on the tray before the emoji was due
    run(s, 1, dt, stepHelpers)
    expect(events(s, 'emoji').length).toBe(1)
    dockBubble(s, 79)
    let longest = 0
    run(s, 60, dt, stepHelpers, () => {
      expect(s.driver.state).toBe('deliver') // nobody takes the bubble: he keeps trying
      longest = Math.max(longest, s.driver.t)
    })
    expect(longest).toBeLessThan(15)
    expect(events(s, 'emoji').length).toBe(2)
  })

  for (const stepDt of DTS) {
    test(`drives for 120 s: pose copied to the cart, never NaN, never stuck in a state (${dtName(stepDt)})`, () => {
      const s = withParkedCart()
      s.unlocks.driver = true
      const cart = s.tools[0]!
      const d = s.driver
      let reachedRiver = -1
      let longest = 0
      run(s, 120, stepDt, stepHelpers, () => {
        expect(Number.isFinite(d.x + d.z + d.heading + d.vx + d.vz + d.t + d.cycleT)).toBe(true)
        if (d.state === 'toCart') return
        expect(SEATED).toContain(d.state)
        expect(cart.holder).toBe('driver')
        expect(cart.x).toBe(d.x)
        expect(cart.z).toBe(d.z)
        expect(cart.heading).toBe(d.heading)
        longest = Math.max(longest, d.t)
        if (reachedRiver < 0 && d.state === 'seek') reachedRiver = s.time
      })
      expect(d.state).not.toBe('toCart')
      expect(longest).toBeLessThan(25) // every state times out into another one
      if (moverIsReal) {
        // with a cart that really moves he must have driven from the grinder to his post in the river
        expect(reachedRiver).toBeGreaterThan(0)
        expect(reachedRiver).toBeLessThan(15)
        expect(d.x).toBeGreaterThan(L.GRINDER[2] + 4)
      }
      expect(s.events.filter(e => e.type === 'emoji').length).toBe(0) // no river in this test: nothing to catch
    })
  }
})
