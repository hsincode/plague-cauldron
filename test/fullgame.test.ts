// Integration: the four packages played together, start to finish, by the autopilot (sim/bot.ts) through the
// same input a player has. A run prints its timeline; the assertions are the things that break when two packages
// disagree (a pad that never appears, a villager who never leaves, a tool that cannot be taken again, ...).
import { describe, expect, test } from 'bun:test'
import { P, UNLOCKS, type UnlockId } from '../src/config'
import { botInput } from '../src/sim/bot'
import type { EventType } from '../src/sim/events'
import { createState } from '../src/sim/state'
import { step } from '../src/sim/step'
import type { GameState } from '../src/sim/types'

const LIMIT = 25 * 60
// Wall-clock budget of one step(). Shared CI runners are several times slower and noisy, so there it only catches blow-ups.
const STEP_BUDGET_MS = process.env.CI ? 12 : 2.5
/** The pads of the ad (SPEC 3.2 A-D): a decent player has them well inside the first minutes. */
const OPENING: UnlockId[] = ['nurses', 'usher', 'cart', 'ward2']
const OPENING_LIMIT = 150
const BENCH_FROM = 60
const BENCH_TO = 120
const TOTAL_PRICE = UNLOCKS.reduce((n, u) => n + u.price, 0)

/** Every event type of sim/events.ts; the Record makes the compiler complain when the list and the union drift apart. */
const EVENT_TYPES = Object.keys({
  toolGrab: 1, toolPark: 1, cartMount: 1, cartDismount: 1, toolSwap: 1, bubbleSpawn: 1, bubbleDock: 1, bubbleReject: 1, bubbleFall: 1,
  grindStart: 1, grindCrack: 1, grindShell: 1, grindShatter: 1, grindEnd: 1, flaskEject: 1, flaskPickup: 1, flaskThrow: 1, flaskLand: 1,
  gateOpen: 1, gateClose: 1, villagerRelease: 1, bathHopIn: 1, bathSplash: 1, bathCured: 1, bathHopOut: 1, coinFountain: 1,
  patientLie: 1, needsNurse: 1, treatStart: 1, treatJab: 1, healed: 1, nursesSpawn: 1, discharged: 1,
  drillCrewJoin: 1, drillPush: 1, drillKill: 1, drillHeapLift: 1, drillPaid: 1, swarmReady: 1,
  coinPickupStart: 1, coinPickupEnd: 1, bursarCollect: 1, padPop: 1, padPayStart: 1, padPaid: 1, unlock: 1,
  emoji: 1, guide: 1, win: 1,
} satisfies Record<EventType, 1>) as EventType[]

interface Purchase {
  id: UnlockId
  /** Simulated time of the unlock. */
  t: number
  /** Wallet when the payment started and right after the pad was paid. */
  walletBefore: number
  walletAfter: number
  discharged: number
  bubbles: number
}

interface Run {
  s: GameState
  purchases: Purchase[]
  events: Partial<Record<EventType, number>>
  /** Wall-clock milliseconds per step() between BENCH_FROM and BENCH_TO simulated seconds (0 if not reached). */
  stepMs: number
  /** Simulated time of the first of each of these events. */
  first: Partial<Record<EventType, number>>
}

function play(seed: number, dt: number, until: number): Run {
  const s = createState(seed)
  const purchases: Purchase[] = []
  const events: Partial<Record<EventType, number>> = {}
  const first: Partial<Record<EventType, number>> = {}
  let walletBefore = 0
  let benchMs = 0
  let benchSteps = 0
  while (!s.won && s.time < until) {
    const input = botInput(s)
    const bench = s.time >= BENCH_FROM && s.time < BENCH_TO
    const t0 = bench ? performance.now() : 0
    step(s, input, dt)
    if (bench) {
      benchMs += performance.now() - t0
      benchSteps++
    }
    for (const e of s.events) {
      events[e.type] = (events[e.type] ?? 0) + 1
      first[e.type] ??= s.time
      // a payment that was interrupted starts again with part of the price already on the pad
      if (e.type === 'padPayStart') walletBefore = s.wallet + (s.pads.find(p => p.id === e.id)?.paid ?? 0)
      if (e.type === 'unlock') purchases.push({ id: e.id, t: s.time, walletBefore, walletAfter: s.wallet, discharged: s.stats.discharged, bubbles: s.stats.bubblesCaught })
    }
    s.events.length = 0
  }
  return { s, purchases, events, stepMs: benchSteps > 0 ? benchMs / benchSteps : 0, first }
}

const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`

/** The beats of SPEC 3.5 (the ad's first minute), in the order the ad has them, with the ad's own times. */
const OPENING_BEATS: [EventType, string, number][] = [
  ['bubbleDock', 'catch', 3.8],
  ['grindStart', 'grind', 5.4],
  ['flaskLand', 'pour', 9.9],
  ['gateOpen', 'release', 12.0],
  ['bathSplash', 'bath', 13.6],
  ['coinPickupEnd', 'coins', 19.2],
  ['patientLie', 'in bed', 16.3],
  ['healed', 'healed', 22.9],
  ['drillPaid', 'sortie paid', 26.6],
  ['cartMount', 'on the cart', 37.3],
]

function printTimeline(label: string, r: Run) {
  const lines = [`--- ${label}`]
  lines.push('  first ' + OPENING_BEATS.map(([type, name, ad]) => `${name} ${r.first[type]?.toFixed(1) ?? '-'} (ad ${ad})`).join(', '))
  for (const p of r.purchases) {
    lines.push(`  ${mmss(p.t).padStart(7)}  ${p.id.padEnd(11)} wallet ${String(p.walletBefore).padStart(4)} -> ${String(p.walletAfter).padStart(4)}   discharged ${String(p.discharged).padStart(3)}   bubbles caught ${p.bubbles}`)
  }
  const s = r.s
  lines.push(
    s.won
      ? `  ${mmss(s.wonAt).padStart(7)}  WIN         wallet ${s.wallet}, ${s.stats.totalGold} gold earned, ${s.stats.bubblesCaught} bubbles caught, ${s.drill.sorties} sorties`
      : `  ${mmss(s.time).padStart(7)}  (stopped)   wallet ${s.wallet}, discharged ${s.stats.discharged}, ${s.stats.bubblesCaught} bubbles caught`,
  )
  console.log(lines.join('\n'))
}

/** Path of the first non-finite number in a state, or null. */
function findNaN(v: unknown, path = 's', depth = 0): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? null : path
  if (v === null || typeof v !== 'object' || depth > 8) return null
  if (ArrayBuffer.isView(v)) {
    const a = v as unknown as ArrayLike<number>
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return `${path}[${i}]`
    return null
  }
  for (const [k, child] of Object.entries(v)) {
    const hit = findNaN(child, `${path}.${k}`, depth + 1)
    if (hit) return hit
  }
  return null
}

const boughtAt = (r: Run, id: UnlockId) => r.purchases.find(p => p.id === id)?.t ?? Infinity

function expectOpening(r: Run) {
  for (const id of OPENING) expect(boughtAt(r, id), `'${id}' bought within ${OPENING_LIMIT} s`).toBeLessThanOrEqual(OPENING_LIMIT)
  // pads sell strictly in order
  expect(r.purchases.map(p => p.id)).toEqual(UNLOCKS.slice(0, r.purchases.length).map(u => u.id))
}

function expectWholeGame(r: Run) {
  const s = r.s
  expect(s.won, 'won within 25 simulated minutes').toBe(true)
  expect(s.wonAt).toBeLessThan(LIMIT)
  expectOpening(r)
  for (const u of UNLOCKS) expect(s.unlocks[u.id], `unlock '${u.id}' bought`).toBe(true)
  expect(s.stats.discharged).toBe(P.TOTAL_VILLAGERS)
  expect(s.stats.bathed).toBe(P.TOTAL_VILLAGERS)
  expect(s.crowd.remaining).toBe(0)
  expect(s.villagers.length).toBe(0)
  expect(findNaN(s)).toBeNull()
  // every gold piece that reached the wallet is still there or went into a pad
  expect(s.wallet).toBeGreaterThanOrEqual(0)
  expect(s.stats.totalGold).toBe(s.wallet + TOTAL_PRICE)
  // nothing is left half-done
  for (const b of s.beds) expect(b.state).toBe('free')
  expect(s.cauldron.bath).toBe('empty')
  expect(s.drill.crew.length).toBe(0)
}

describe('full game with the autopilot', () => {
  test(
    'seed 1 at 60 Hz: every unlock bought, every villager discharged; step() stays fast',
    () => {
      const r = play(1, 1 / 60, LIMIT)
      printTimeline('seed 1, dt = 1/60', r)
      console.log(`step(): ${r.stepMs.toFixed(3)} ms average over simulated ${BENCH_FROM}-${BENCH_TO} s (mid-game, autopilot not included)`)
      expectWholeGame(r)

      // SPEC 3.3, the wallet of the ad up to the cart: 0 -> 100 -> 50 -> 300 -> 250 -> 300 -> 250
      const [nurses, usher, cart] = r.purchases
      expect([nurses!.walletBefore, nurses!.walletAfter]).toEqual([100, 50])
      expect([usher!.walletBefore, usher!.walletAfter]).toEqual([300, 250])
      expect([cart!.walletBefore, cart!.walletAfter]).toEqual([300, 250])
      // SPEC 3.5: the first catch is the M bubble (5 flasks), and the first sortie pays before the usher pad shows
      expect(r.first.bubbleDock!).toBeLessThan(6)
      expect(r.first.drillPaid!).toBeLessThan(usher!.t)

      // the presentation layer hears about everything (the scoop never meets an oversize bubble: see below)
      for (const type of EVENT_TYPES) {
        if (type !== 'bubbleReject') expect(r.events[type] ?? 0, `event '${type}' emitted`).toBeGreaterThan(0)
      }
      expect(r.events.bubbleReject ?? 0, 'the autopilot keeps the hand scoop away from oversize bubbles').toBe(0)
      expect(r.events.unlock).toBe(UNLOCKS.length)
      expect(r.events.discharged).toBe(P.TOTAL_VILLAGERS)
      expect(r.events.win).toBe(1)

      expect(r.stepMs).toBeGreaterThan(0)
      expect(r.stepMs).toBeLessThan(STEP_BUDGET_MS)
    },
    180_000,
  )

  for (const seed of [2, 3]) {
    test(
      `seed ${seed} at 60 Hz: every unlock bought, every villager discharged`,
      () => {
        const r = play(seed, 1 / 60, LIMIT)
        printTimeline(`seed ${seed}, dt = 1/60`, r)
        expectWholeGame(r)
      },
      180_000,
    )
  }

  test(
    'seed 1 at 144 Hz, first 120 s: the same four unlocks (frame-rate independence)',
    () => {
      const r = play(1, 1 / 144, 120)
      printTimeline('seed 1, dt = 1/144, first 120 s', r)
      expectOpening(r)
      expect(findNaN(r.s)).toBeNull()
      // the opening is the same game at any frame rate: the first three pads within a tenth of a second
      const at60 = play(1, 1 / 60, 35)
      for (const id of OPENING.slice(0, 3)) expect(Math.abs(boughtAt(r, id) - boughtAt(at60, id)), `'${id}' at 144 Hz vs 60 Hz`).toBeLessThan(0.15)
    },
    180_000,
  )

  test('the same seed gives the same game (the autopilot keeps its memory per state and uses no clock)', () => {
    const digest = (s: GameState) => [s.time, s.wallet, s.rng.s, s.nextId, s.player.x, s.player.z, s.player.heading, s.bubbles.length, s.villagers.length, s.balls.x[100], s.balls.z[2000]]
    const a = play(5, 1 / 60, 25)
    // a second state driven in between must not disturb the first one's memory
    const other = createState(9)
    const b = createState(5)
    while (b.time < 25) {
      step(other, botInput(other), 1 / 60)
      step(b, botInput(b), 1 / 60)
      other.events.length = 0
      b.events.length = 0
    }
    expect(digest(b)).toEqual(digest(a.s))
  })

  test('a hand scoop walked straight into the river meets the oversize bubble: bubbleReject, then the scared emoji', () => {
    // the one event the autopilot never causes; SPEC 3.5 has the ad's player bounce off this bubble at 1.4 s
    const s = createState(1)
    let reject = -1
    let scared = -1
    while (s.time < 3) {
      step(s, { mx: s.time < 1 ? 1 : 0, mz: 0 }, 1 / 60)
      for (const e of s.events) {
        if (e.type === 'bubbleReject' && reject < 0) reject = s.time
        if (e.type === 'emoji' && e.kind === 'scared' && scared < 0) scared = s.time
      }
      s.events.length = 0
    }
    expect(reject).toBeGreaterThan(0)
    expect(scared - reject).toBeCloseTo(0.5, 1)
  })
})
