// Static obstacles for the player (and the cart body). NPCs follow waypoints and ignore these.
import { BEDS, L, P, type UnlockId } from '../config'

export type Collider =
  | { t: 'circle'; x: number; z: number; r: number; when?: (u: Record<UnlockId, boolean>) => boolean }
  | { t: 'box'; x0: number; z0: number; x1: number; z1: number; when?: (u: Record<UnlockId, boolean>) => boolean }
  /** Capsule: segment a-b with radius r. */
  | { t: 'seg'; ax: number; az: number; bx: number; bz: number; r: number; when?: (u: Record<UnlockId, boolean>) => boolean }

const list: Collider[] = []
const half = P.WALL_THICKNESS / 2

for (const [ax, az, bx, bz] of L.WALLS) list.push({ t: 'seg', ax, az, bx, bz, r: half + 0.05 })
// closed doors: the yard's north double door and ward-1's south gate (they only ever open for villagers)
for (const d of [L.NORTH_DOOR, L.WARD1_DOOR]) list.push({ t: 'seg', ax: d.x - d.w / 2, az: d.z, bx: d.x + d.w / 2, bz: d.z, r: half })
// pen picket fence: arc radius PEN.r around PEN centre from north (-90 deg) through west to south
{
  const n = 14
  let px = 0
  let pz = 0
  for (let i = 0; i <= n; i++) {
    // angle measured from north (-z) turning toward west (-x) and on to south (+z)
    const a = (Math.PI * i) / n
    const x = L.PEN.x - L.PEN.r * Math.sin(a)
    const z = L.PEN.z - L.PEN.r * Math.cos(a)
    if (i > 0) list.push({ t: 'seg', ax: px, az: pz, bx: x, bz: z, r: 0.15 })
    px = x
    pz = z
  }
}
list.push({ t: 'circle', x: L.CAULDRON.x, z: L.CAULDRON.z, r: P.CAULDRON_COLLIDER_RADIUS })
{
  const [x0, z0, x1, z1] = L.GRINDER
  list.push({ t: 'box', x0, z0, x1, z1 })
}
list.push({ t: 'box', x0: L.PALLET.x - L.PALLET.w / 2, z0: L.PALLET.z - L.PALLET.d / 2, x1: L.PALLET.x + L.PALLET.w / 2, z1: L.PALLET.z + L.PALLET.d / 2 })
list.push({ t: 'box', x0: L.SIDE_TABLE.x - 0.4, z0: L.SIDE_TABLE.z - 0.4, x1: L.SIDE_TABLE.x + 0.4, z1: L.SIDE_TABLE.z + 0.4 })
list.push({ t: 'box', x0: L.BURSAR_CHEST.x - 0.43, z0: L.BURSAR_CHEST.z - 0.28, x1: L.BURSAR_CHEST.x + 0.43, z1: L.BURSAR_CHEST.z + 0.28, when: u => u.bursar })
for (const b of BEDS) {
  list.push({
    t: 'box',
    x0: b.x - P.BED_W / 2,
    z0: b.z - P.BED_D / 2,
    x1: b.x + P.BED_W / 2,
    z1: b.z + P.BED_D / 2,
    when: b.ward === 2 ? u => u.ward2 : undefined,
  })
}
for (const [x, z, w, d] of L.YARD_PROPS) list.push({ t: 'box', x0: x - w / 2, z0: z - d / 2, x1: x + w / 2, z1: z + d / 2, when: u => !u.ward2 })
for (const [x, z, r] of L.BOULDERS) list.push({ t: 'circle', x, z, r })
for (const [x, z] of L.CONIFERS) list.push({ t: 'circle', x, z, r: 0.5 })
// cliff lip south of the dirt, east of ward-1 (the teal lowland is unreachable)
list.push({ t: 'box', x0: 6.5, z0: L.CLIFF_Z, x1: 40, z1: 40 })
// keep the player out of the crowd: west of the courtyard / ward-1 line except the pen bay
list.push({ t: 'box', x0: -40, z0: -40, x1: -5.45, z1: L.PEN.z - L.PEN.r - 0.2 })
list.push({ t: 'box', x0: -40, z0: L.PEN.z + L.PEN.r + 0.2, x1: -5.05, z1: 40 })

export const STATIC_COLLIDERS: readonly Collider[] = list

/** Boulders that the river balls and bubbles also collide with (circles). */
export const RIVER_ROCKS: readonly { x: number; z: number; r: number }[] = L.BOULDERS.map(([x, z, r]) => ({ x, z, r }))
