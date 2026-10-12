// Layout invariants (SPEC 3.2, 4.3, 4.4): positions in src/config.ts that have to agree with each other and with
// the fixed camera. Nothing here runs the simulation.
import { describe, expect, test } from 'bun:test'
import { BEDS, L, P, UNLOCKS } from '../src/config'
import { queueSlotX, queueSlotZ } from '../src/sim/crowd'
import { crewSlotX, crewSlotZ, DRILL_BYPASS } from '../src/sim/drill'
import { STATIC_COLLIDERS } from '../src/world/colliders'

type Pt = readonly [number, number]

function pointSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax
  const ez = bz - az
  const d = ex * ex + ez * ez
  const t = d > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / d)) : 0
  return Math.hypot(px - ax - ex * t, pz - az - ez * t)
}

/** Distance from a point to a convex polygon (0 inside). */
function pointPoly(px: number, pz: number, poly: readonly Pt[]): number {
  let inside = true
  let best = Infinity
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    best = Math.min(best, pointSeg(px, pz, a[0], a[1], b[0], b[1]))
    const c = (b[0] - a[0]) * (pz - a[1]) - (b[1] - a[1]) * (px - a[0])
    if (c !== 0) {
      if (sign === 0) sign = Math.sign(c)
      else if (Math.sign(c) !== sign) inside = false
    }
  }
  return inside ? 0 : best
}

const PAD_R = P.PAD_DIAMETER / 2
/** The icon and the price of a pad lie within this distance of its centre; the brackets reach PAD_R. */
const PAD_CORE = 0.7
/** Ground hidden behind something h metres tall lies h * VIEW_SHIFT away from its foot (the camera never turns). */
const VIEW_SHIFT = [-P.CAMERA_OFFSET[0] / P.CAMERA_OFFSET[1], -P.CAMERA_OFFSET[2] / P.CAMERA_OFFSET[1]] as const

/** Everything that stands as high as a wall: the wall segments and the closed doors between them. */
const SCREENS: (readonly [number, number, number, number])[] = [
  ...L.WALLS,
  ...[L.WARD1_DOOR, L.NORTH_DOOR].map(d => [d.x - d.w / 2, d.z, d.x + d.w / 2, d.z] as const),
]

describe('pads', () => {
  test('no wall or closed door stands between a pad and the camera', () => {
    for (const u of UNLOCKS) {
      for (const [ax, az, bx, bz] of SCREENS) {
        const sx = VIEW_SHIFT[0] * P.WALL_HEIGHT
        const sz = VIEW_SHIFT[1] * P.WALL_HEIGHT
        const hidden: Pt[] = [[ax, az], [bx, bz], [bx + sx, bz + sz], [ax + sx, az + sz]]
        expect(pointPoly(u.x, u.z, hidden), `pad '${u.id}' behind the wall (${ax}, ${az})-(${bx}, ${bz})`).toBeGreaterThan(PAD_CORE)
      }
    }
  })

  test('no pad lies under a bed, a nurse, a queue place or anything else that blocks the doctor', () => {
    for (const u of UNLOCKS) {
      for (const b of BEDS) {
        const dx = Math.max(Math.abs(u.x - b.x) - P.BED_W / 2, 0)
        const dz = Math.max(Math.abs(u.z - b.z) - P.BED_D / 2, 0)
        expect(Math.hypot(dx, dz), `pad '${u.id}' and bed ${b.id}`).toBeGreaterThanOrEqual(PAD_R)
        expect(Math.hypot(u.x - b.x - L.NURSE_POST.x, u.z - b.z - L.NURSE_POST.z), `pad '${u.id}' and the nurse of bed ${b.id}`).toBeGreaterThan(PAD_R)
      }
      for (let i = 0; i < P.QUEUE_MAX_BIG; i++) {
        expect(Math.hypot(u.x - queueSlotX(i), u.z - queueSlotZ(i)), `pad '${u.id}' and queue place ${i}`).toBeGreaterThan(PAD_R + 0.3)
      }
      for (const c of STATIC_COLLIDERS) {
        const d =
          c.t === 'circle'
            ? Math.hypot(u.x - c.x, u.z - c.z) - c.r
            : c.t === 'box'
              ? Math.hypot(Math.max(c.x0 - u.x, 0, u.x - c.x1), Math.max(c.z0 - u.z, 0, u.z - c.z1))
              : pointSeg(u.x, u.z, c.ax, c.az, c.bx, c.bz) - c.r
        expect(d, `pad '${u.id}' and a ${c.t} collider`).toBeGreaterThan(PAD_CORE)
      }
    }
  })
})

describe('ward-1 south gate and the drill', () => {
  const door = L.WARD1_DOOR
  const park = L.DRILL_PARK
  const fwd = [Math.sin(park.heading), Math.cos(park.heading)] as const

  test('the gate fills the gap between the two south wall segments, at the end of the aisle', () => {
    for (const end of [door.x - door.w / 2, door.x + door.w / 2]) {
      expect(L.WALLS.some(w => w[1] === door.z && w[3] === door.z && (w[0] === end || w[2] === end))).toBe(true)
    }
    const ward1 = BEDS.filter(b => b.ward === 1)
    const west = Math.max(...ward1.filter(b => b.x < door.x).map(b => b.x + P.BED_W / 2))
    const east = Math.min(...ward1.filter(b => b.x > door.x).map(b => b.x - P.BED_W / 2))
    expect(L.WARD1_DOOR_INSIDE.x).toBeGreaterThan(west + P.PLAYER_RADIUS)
    expect(L.WARD1_DOOR_INSIDE.x).toBeLessThan(east - P.PLAYER_RADIUS)
    expect(L.WARD1_DOOR_INSIDE.z).toBeLessThan(door.z)
  })

  test('the cart is parked outside the gate with its handle toward it, inside the dashed circle', () => {
    const hx = L.DRILL_HANDLE.x - park.x
    const hz = L.DRILL_HANDLE.z - park.z
    expect(hx * fwd[0] + hz * fwd[1]).toBeCloseTo(-1, 6)
    expect(hx * fwd[1] - hz * fwd[0]).toBeCloseTo(0, 6)
    expect(L.DRILL_HANDLE.z).toBeGreaterThan(door.z + P.WALL_THICKNESS)
    expect(Math.hypot(park.x - L.DASHED_CIRCLE.x, park.z - L.DASHED_CIRCLE.z)).toBeLessThan(P.DASHED_CIRCLE_RADIUS - 1)
    // the crew comes straight out of the gate: both places at the handle are in front of the opening
    for (let i = 0; i < P.DRILL_CREW; i++) {
      expect(Math.abs(crewSlotX(i) - door.x)).toBeLessThan(door.w / 2 - P.POST_SIZE)
      expect(crewSlotZ(i)).toBeGreaterThan(door.z)
    }
  })

  test('the sortie runs DRILL_PUSH_DISTANCE along the heading, out of the circle into the rat field', () => {
    expect(L.DRILL_END.x).toBeCloseTo(park.x + fwd[0] * P.DRILL_PUSH_DISTANCE, 6)
    expect(L.DRILL_END.z).toBeCloseTo(park.z + fwd[1] * P.DRILL_PUSH_DISTANCE, 6)
    expect(Math.hypot(L.DRILL_END.x - L.DASHED_CIRCLE.x, L.DRILL_END.z - L.DASHED_CIRCLE.z)).toBeGreaterThan(P.DASHED_CIRCLE_RADIUS + 1.5)
    const [x0, z0, x1, z1] = L.RAT_FIELD
    for (const p of [L.DASHED_CIRCLE, park, L.DRILL_END]) {
      expect(p.x).toBeGreaterThan(x0)
      expect(p.x).toBeLessThan(x1)
      expect(p.z).toBeGreaterThan(z0)
      expect(p.z).toBeLessThan(z1)
    }
  })

  test('the way home passes beside the cart, clear of its wheel', () => {
    const dx = DRILL_BYPASS.x - park.x
    const dz = DRILL_BYPASS.z - park.z
    expect(Math.abs(dx * fwd[1] - dz * fwd[0])).toBeGreaterThan(1.3)
    expect(DRILL_BYPASS.z).toBeGreaterThan(door.z + P.WALL_THICKNESS)
  })
})

describe('pen bay', () => {
  const { x: cx, z: cz, r } = L.PEN
  const gate = L.PEN_GATE
  const fromCentre = (x: number, z: number) => Math.hypot(x - cx, z - cz)

  test('the fence arc ends at the two parts of the courtyard west wall', () => {
    for (const endZ of [cz - r, cz + r]) {
      const gap = Math.min(...L.WALLS.flatMap(w => [Math.hypot(w[0] - cx, w[1] - endZ), Math.hypot(w[2] - cx, w[3] - endZ)]))
      expect(gap).toBeLessThan(P.POST_SIZE / 2 + 0.05)
    }
  })

  test('the gate lies on the arc at its angle; the usher stands inside the fence beside the tiles', () => {
    const a = (gate.angleDeg * Math.PI) / 180
    expect(gate.x).toBeCloseTo(cx - r * Math.cos(a), 2)
    expect(gate.z).toBeCloseTo(cz + r * Math.sin(a), 2)
    expect(L.USHER_POST.x).toBeLessThan(cx)
    expect(fromCentre(L.USHER_POST.x, L.USHER_POST.z)).toBeLessThan(r - 0.4)
    expect(fromCentre(L.PEN_INNER.x, L.PEN_INNER.z)).toBeLessThan(r - 0.4)
  })

  test('every queue place is on the tiles or inside the fence, clear of its neighbours and of the gate leaf', () => {
    // the leaf is hinged at the south end of the gate and swings inward
    const hinge = (gate.angleDeg * Math.PI) / 180 + gate.w / 2 / r
    const hx = cx - r * Math.cos(hinge)
    const hz = cz + r * Math.sin(hinge)
    for (let i = 0; i < P.QUEUE_MAX_BIG; i++) {
      const x = queueSlotX(i)
      const z = queueSlotZ(i)
      if (x < cx) {
        expect(fromCentre(x, z), `place ${i} and the fence`).toBeLessThan(r - 0.35)
        expect(Math.hypot(x - hx, z - hz), `place ${i} and the gate leaf`).toBeGreaterThan(gate.w + 0.3)
      }
      for (let j = 0; j < i; j++) expect(Math.hypot(x - queueSlotX(j), z - queueSlotZ(j))).toBeGreaterThan(0.85)
      expect(Math.hypot(x - L.USHER_POST.x, z - L.USHER_POST.z)).toBeGreaterThan(0.8)
    }
  })
})
