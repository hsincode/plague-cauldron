import { expect, test } from 'bun:test'
import { createState } from '../src/sim/state'
import { advance } from '../src/sim/step'

test('state can be created and stepped', () => {
  const s = createState(1)
  advance(s, { mx: 0, mz: 0 }, 1 / 30)
  expect(s.time).toBeCloseTo(1 / 30)
  expect(s.pads.length).toBe(9)
  expect(s.beds.filter(b => b.exists).length).toBe(4)
})
