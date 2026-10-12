// Ward loop (SPEC 2.10): bathed patients walk to their reserved bed and lie down, every bed runs its nurse's
// treatment timeline, healed patients run out (ward 1: south gate, crewing the drill when it wants them;
// ward 2: north door). Every villager in state 'toExit' is faded out and counted as discharged here.
//
// For the view: a patient in state inBed or cheer has x/z at the bed centre, y = BED_LIE_Y and heading = the way
// he faces (south); his body lies along the bed with the head toward +x. lieDown and hopOff are hops between
// the climbing spot (bed centre + L.BED_SIDE, y = 0) and that pose. A bed is 'occupied' from the moment he lies
// (end of lieDown) and lieT counts from there. The needs-nurse bubble starts with the 'needsNurse' event and
// lasts until bed.treatT reaches the plus-bubble time; the rest of the treatment table is a function of treatT.
import { BEDS, L, P, UNLOCKS, type BedDef } from '../config'
import { approach, clamp01, damp, dist2, headingOf, lerp, lerpAngle } from '../core/math'
import { releaseBed } from './beds'
import { DRILL_BYPASS, enlistForDrill, villagerById } from './drill'
import { emit } from './events'
import { followPath, hopY, setPath } from './npc'
import type { Bed, GameState, Nurse, Villager } from './types'

/** Height of a lying or sitting patient above the ground (mattress top, SPEC 7.4). */
export const BED_LIE_Y = 0.55
/** A leaving villager fades out over the last EXIT_FADE seconds of his path. */
export const EXIT_FADE = 1.0

const HOP_APEX = 0.35
const HOP_OFF_TIME = P.TREAT_END - P.TREAT_HOP_OFF
/** On the bed a patient faces south (his nurse, and the camera); a nurse at her post faces north (the bed). */
const FACE_SOUTH = 0
const FACE_NORTH = Math.PI
const TURN_RATE = 14
const NURSE_PAD = UNLOCKS.find(u => u.id === 'nurses')!
const NURSE_SPAWN_SPREAD = 0.35
/** Walkers closer than this push each other apart (SPEC 4.5), at most at SEPARATION_SPEED. */
const SEPARATION = 0.5
const SEPARATION_SPEED = 1.5
const DOOR_SENSE = 2.2
const DOOR_OPEN_TIME = 0.2
const DOOR_CLOSE_TIME = 0.35

// Ward 1 has two columns of beds with one aisle between them, which ends at the south gate (map in SPEC 4.2).
// Walkers keep to lanes in that aisle, so nobody cuts through a bed or through a nurse at her post.
const ward1 = BEDS.filter(b => b.ward === 1)
const W1_EAST_X = Math.max(...ward1.map(b => b.x))
const W1_WEST_X = Math.min(...ward1.map(b => b.x))
const W1_FIRST_Z = Math.min(...ward1.map(b => b.z))
const W1_LAST_Z = Math.max(...ward1.map(b => b.z))
const W1_LANE_E = W1_EAST_X - P.BED_W / 2 - 0.45 // just clear of the east column's foot ends
const W1_LANE_W = W1_WEST_X + P.BED_W / 2 + 0.5 // just clear of the west column's head ends
const W1_NORTH_Z = W1_FIRST_Z - P.BED_D / 2 - 0.15
const W1_SOUTH_Z = W1_LAST_Z + P.BED_D / 2 + 0.55
/** A west-column bed has its nurse between the aisle and the climbing spot: pass behind her (offset from the bed centre). */
const W1_PASS = { x: -0.3, z: L.NURSE_POST.z + 0.65 }

const inEastColumn = (b: BedDef) => b.x > (b.ward === 1 ? (W1_EAST_X + W1_WEST_X) / 2 : L.WARD2_AISLE_X)
const inLastRow = (b: BedDef) => b.z > W1_LAST_Z - 0.01

/** From a bath exit to the climbing spot beside the bed. */
function routeToBed(b: BedDef, out: number[]) {
  const sx = b.x + L.BED_SIDE.x
  const sz = b.z + L.BED_SIDE.z
  if (b.ward === 1) {
    out.push(L.WARD1_ENTRY.x, L.WARD1_ENTRY.z, W1_LANE_E, W1_NORTH_Z)
    if (inEastColumn(b)) out.push(W1_LANE_E, sz)
    else out.push(W1_LANE_W, b.z + W1_PASS.z, b.x + W1_PASS.x, b.z + W1_PASS.z)
  } else {
    for (const p of L.WARD2_ENTRY) out.push(p.x, p.z)
    out.push(L.WARD2_AISLE_X, sz)
  }
  out.push(sx, sz)
}

function pushWard1Door(out: number[]) {
  out.push(L.WARD1_DOOR_INSIDE.x, L.WARD1_DOOR_INSIDE.z, L.WARD1_DOOR.x, L.WARD1_DOOR.z)
}

/** From the climbing spot beside the bed to the ward's door (ward 2: all the way out of the map). */
function routeFromBed(b: BedDef, out: number[]) {
  const sz = b.z + L.BED_SIDE.z
  if (b.ward === 2) {
    out.push(L.WARD2_AISLE_X, sz, L.NORTH_DOOR.x, L.NORTH_DOOR.z, L.NORTH_EXIT.x, L.NORTH_EXIT.z)
    return
  }
  if (inEastColumn(b)) {
    if (!inLastRow(b)) out.push(W1_LANE_E, sz, W1_LANE_E, W1_SOUTH_Z)
  } else {
    out.push(b.x + W1_PASS.x, b.z + W1_PASS.z)
    if (!inLastRow(b)) out.push(W1_LANE_W, b.z + W1_PASS.z, W1_LANE_W, W1_SOUTH_Z)
  }
  pushWard1Door(out)
}

/**
 * A healed villager starts running out. `from` is the bed he leaves, or null when he never reached one (then he
 * crosses ward 1 from the bath side). Ward-1 patients may be taken by the drill instead of leaving at once.
 */
function sendHome(s: GameState, v: Villager, from: BedDef | null, mayCrew: boolean) {
  v.look = 'healed'
  v.state = 'toExit'
  v.t = 0
  v.y = 0
  v.alpha = 1
  v.bed = -1
  v.speed = P.HEALED_RUN_SPEED
  const path: number[] = []
  if (from) routeFromBed(from, path)
  else {
    path.push(L.WARD1_ENTRY.x, L.WARD1_ENTRY.z, W1_LANE_E, W1_NORTH_Z, W1_LANE_E, W1_SOUTH_Z)
    pushWard1Door(path)
  }
  if (!from || from.ward === 1) {
    // SPEC 2.10: he decides now, at the moment he leaves the bed. A crew member's path ends at the door.
    if (!(mayCrew && enlistForDrill(s, v))) path.push(DRILL_BYPASS.x, DRILL_BYPASS.z, L.SOUTH_EXIT.x, L.SOUTH_EXIT.z)
  }
  setPath(v, path)
}

/**
 * Called by the bath when a bather has landed outside the pot. The villager already has `bed` set to the bed
 * reserved for him at batch start (or -1 if none). Sets look = 'bathed', state = 'toBed' and the walking route.
 * Without a bed of his own he is treated as healed and sent out through ward 1 (state 'toExit'), so he is
 * still discharged. `slot` (his bath seat) is cleared: outside the queue and the pot it is -1 (sim/types.ts)
 * until sim/drill.ts gives a crew member his place at the handle.
 */
export function sendToBed(s: GameState, v: Villager): void {
  v.look = 'bathed'
  v.t = 0
  v.y = 0
  v.alpha = 1
  v.slot = -1
  const b = s.beds[v.bed]
  if (b && b.exists && b.state === 'free') {
    b.state = 'reserved'
    b.villager = v.id
  }
  if (!b || !b.exists || b.state !== 'reserved' || b.villager !== v.id) {
    // No bed of his own (should not happen): he must not stand around forever, so he goes home as if healed.
    sendHome(s, v, null, false)
    return
  }
  v.state = 'toBed'
  v.speed = P.BATHED_WALK_SPEED
  const path: number[] = []
  routeToBed(BEDS[b.id]!, path)
  setPath(v, path)
}

const reservedFor = (b: Bed | undefined, v: Villager): b is Bed => !!b && b.state === 'reserved' && b.villager === v.id
const lyingIn = (b: Bed | undefined, v: Villager): b is Bed => !!b && b.state === 'occupied' && b.villager === v.id

function nurseOf(s: GameState, bedId: number): Nurse | null {
  const ns = s.nurses
  for (let i = 0; i < ns.length; i++) if (ns[i]!.bed === bedId) return ns[i]!
  return null
}

function spawnNurse(s: GameState, bedId: number, fromPad: boolean) {
  const def = BEDS[bedId]!
  const px = def.x + L.NURSE_POST.x
  const pz = def.z + L.NURSE_POST.z
  const n: Nurse = { id: s.nextId++, bed: bedId, x: px, z: pz, heading: FACE_NORTH, state: 'idle', path: [], pathI: 0, age: 0 }
  if (fromPad) {
    // The four start as a small square on the pad, run down the aisle and step in beside their bed.
    const laneX = inEastColumn(def) ? W1_LANE_E : W1_LANE_W
    const laneZ = pz - 0.2
    n.x = NURSE_PAD.x + (inEastColumn(def) ? NURSE_SPAWN_SPREAD : -NURSE_SPAWN_SPREAD)
    n.z = NURSE_PAD.z + (def.z > (W1_FIRST_Z + W1_LAST_Z) / 2 ? NURSE_SPAWN_SPREAD : -NURSE_SPAWN_SPREAD)
    n.heading = headingOf(laneX - n.x, laneZ - n.z)
    n.state = 'running'
    setPath(n, [laneX, laneZ, px, pz])
  }
  s.nurses.push(n)
}

/** Every existing bed of the ward that has no nurse yet gets one. Returns true if any was spawned. */
function staffWard(s: GameState, ward: 1 | 2, fromPad: boolean): boolean {
  let spawned = false
  for (let i = 0; i < s.beds.length; i++) {
    const b = s.beds[i]!
    if (b.ward !== ward || !b.exists || nurseOf(s, b.id)) continue
    spawnNurse(s, b.id, fromPad)
    spawned = true
  }
  return spawned
}

/** Unlock effects, detected from our own state (beds that do not exist yet, beds without a nurse). */
function applyUnlocks(s: GameState) {
  if (s.unlocks.nurses && staffWard(s, 1, true)) emit(s, { type: 'nursesSpawn', ward: 1, x: NURSE_PAD.x, z: NURSE_PAD.z })
  if (s.unlocks.ward2) {
    for (let i = 0; i < s.beds.length; i++) {
      const b = s.beds[i]!
      if (b.ward !== 2 || b.exists) continue
      b.exists = true
      b.age = 0
    }
    // Ward 2 arrives complete: its nurses pop in at their posts together with the beds.
    if (staffWard(s, 2, false)) emit(s, { type: 'nursesSpawn', ward: 2, x: (L.WARD2[0] + L.WARD2[2]) / 2, z: (L.WARD2[1] + L.WARD2[3]) / 2 })
  }
}

function stepNurses(s: GameState, dt: number) {
  for (let i = 0; i < s.nurses.length; i++) {
    const n = s.nurses[i]!
    n.age += dt
    if (n.state === 'running') {
      if (followPath(n, P.NURSE_RUN_SPEED, dt)) n.state = 'idle'
      continue
    }
    n.heading = lerpAngle(n.heading, FACE_NORTH, damp(TURN_RATE, dt))
    const b = s.beds[n.bed]
    if (n.state === 'treating' && !(b && b.state === 'occupied' && b.treatT >= 0 && b.treatT < P.TREATMENT_TIME)) n.state = 'idle'
  }
}

/** The bed's patient, as long as he is still on it. */
function patientOf(s: GameState, b: Bed): Villager | null {
  const v = villagerById(s, b.villager)
  return v && v.bed === b.id && (v.state === 'inBed' || v.state === 'cheer' || v.state === 'hopOff') ? v : null
}

/** Nurse timeline of SPEC 2.10. The bed owns it, so a bed is always freed at TREAT_END whatever its patient does. */
function advanceTreatment(s: GameState, b: Bed, n: Nurse, dt: number) {
  const def = BEDS[b.id]!
  const t0 = b.treatT
  const t1 = t0 + dt
  b.treatT = t1
  if (t0 < P.TREAT_JAB && t1 >= P.TREAT_JAB) emit(s, { type: 'treatJab', bed: b.id })
  if (t0 < P.TREATMENT_TIME && t1 >= P.TREATMENT_TIME) {
    n.state = 'idle'
    const v = patientOf(s, b)
    if (v) v.look = 'healed'
    emit(s, { type: 'healed', bed: b.id, id: b.villager, x: def.x, z: def.z })
  }
  if (t0 < P.TREAT_SIT_UP && t1 >= P.TREAT_SIT_UP) {
    const v = patientOf(s, b)
    if (v && v.state === 'inBed') {
      v.state = 'cheer'
      v.t = 0
    }
  }
  if (t0 < P.TREAT_HOP_OFF && t1 >= P.TREAT_HOP_OFF) {
    const v = patientOf(s, b)
    if (v && v.state !== 'hopOff') {
      v.state = 'hopOff'
      v.t = 0
      v.fromX = v.x
      v.fromZ = v.z
      v.toX = def.x + L.BED_SIDE.x
      v.toZ = def.z + L.BED_SIDE.z
    }
  }
  if (t1 >= P.TREAT_END) {
    const v = patientOf(s, b)
    releaseBed(s, b.id)
    if (v) {
      v.x = def.x + L.BED_SIDE.x
      v.z = def.z + L.BED_SIDE.z
      sendHome(s, v, def, true)
    }
  }
}

function stepBeds(s: GameState, dt: number) {
  for (let i = 0; i < s.beds.length; i++) {
    const b = s.beds[i]!
    b.age += dt
    if (b.state !== 'occupied') continue
    const lain = b.lieT
    b.lieT = lain + dt
    const n = nurseOf(s, b.id)
    if (!n) {
      if (lain < P.NEEDS_NURSE_DELAY && b.lieT >= P.NEEDS_NURSE_DELAY) emit(s, { type: 'needsNurse', bed: b.id })
    } else if (b.treatT >= 0) {
      advanceTreatment(s, b, n, dt)
    } else if (n.state !== 'running' && b.lieT >= P.NURSE_START_DELAY) {
      // t = 0 = max(lie-down + NURSE_START_DELAY, nurse at her post)
      b.treatT = 0
      n.state = 'treating'
      emit(s, { type: 'treatStart', bed: b.id })
    }
  }
}

function startLieDown(s: GameState, v: Villager) {
  const def = BEDS[v.bed]
  if (!def || !reservedFor(s.beds[v.bed], v)) {
    sendHome(s, v, def ?? null, false)
    return
  }
  v.state = 'lieDown'
  v.t = 0
  v.fromX = v.x
  v.fromZ = v.z
  v.toX = def.x
  v.toZ = def.z
}

function stepLieDown(s: GameState, v: Villager, dt: number) {
  const u = clamp01(v.t / P.LIE_DOWN_TIME)
  v.x = lerp(v.fromX, v.toX, u)
  v.z = lerp(v.fromZ, v.toZ, u)
  v.y = BED_LIE_Y * u + hopY(u, HOP_APEX)
  v.heading = lerpAngle(v.heading, FACE_SOUTH, damp(TURN_RATE, dt))
  if (u < 1) return
  const b = s.beds[v.bed]
  if (!reservedFor(b, v)) {
    sendHome(s, v, BEDS[v.bed] ?? null, false)
    return
  }
  b.state = 'occupied'
  b.lieT = v.t - P.LIE_DOWN_TIME
  b.treatT = -1
  v.state = 'inBed'
  v.t = 0
  emit(s, { type: 'patientLie', bed: b.id, id: v.id })
}

function stepHopOff(s: GameState, v: Villager, dt: number) {
  const b = s.beds[v.bed]
  if (!lyingIn(b, v)) {
    sendHome(s, v, BEDS[v.bed] ?? null, false)
    return
  }
  const u = clamp01((b.treatT - P.TREAT_HOP_OFF) / HOP_OFF_TIME)
  v.x = lerp(v.fromX, v.toX, u)
  v.z = lerp(v.fromZ, v.toZ, u)
  v.y = BED_LIE_Y * (1 - u) + hopY(u, HOP_APEX)
  v.heading = lerpAngle(v.heading, headingOf(v.toX - v.fromX, v.toZ - v.fromZ), damp(TURN_RATE, dt))
}

/** Length of the path still ahead, cut short once it is known to exceed `limit`. */
function remainingPath(v: Villager, limit: number): number {
  let d = 0
  let x = v.x
  let z = v.z
  for (let i = v.pathI * 2; i < v.path.length && d <= limit; i += 2) {
    const nx = v.path[i]!
    const nz = v.path[i + 1]!
    d += Math.hypot(nx - x, nz - z)
    x = nx
    z = nz
  }
  return d
}

function stepExit(s: GameState, v: Villager, dt: number) {
  followPath(v, v.speed, dt)
  // Fade at a fixed rate from one EXIT_FADE before the end of the path; a path shorter than that simply ends
  // with him standing at the exit for the rest of the fade, so he is always gone after a bounded time.
  const fadeDist = v.speed * EXIT_FADE
  if (v.alpha < 1 || v.speed <= 0 || remainingPath(v, fadeDist) <= fadeDist) v.alpha -= dt / EXIT_FADE
  if (v.alpha > 0) return
  v.alpha = 0
  v.state = 'gone'
  v.t = 0
  s.stats.discharged++
  emit(s, { type: 'discharged', id: v.id, count: s.stats.discharged })
}

function stepPatients(s: GameState, dt: number) {
  for (let i = 0; i < s.villagers.length; i++) {
    const v = s.villagers[i]!
    switch (v.state) {
      case 'toBed':
        v.t += dt
        if (followPath(v, v.speed, dt)) startLieDown(s, v)
        break
      case 'lieDown':
        v.t += dt
        stepLieDown(s, v, dt)
        break
      case 'inBed':
      case 'cheer':
        v.t += dt
        v.heading = lerpAngle(v.heading, FACE_SOUTH, damp(TURN_RATE, dt))
        // A patient whose bed is no longer his would lie there forever: send him home instead.
        if (!lyingIn(s.beds[v.bed], v)) sendHome(s, v, BEDS[v.bed] ?? null, false)
        break
      case 'hopOff':
        v.t += dt
        stepHopOff(s, v, dt)
        break
      case 'toExit':
        v.t += dt
        stepExit(s, v, dt)
        break
    }
  }
}

const isWalker = (v: Villager) => (v.state === 'toBed' || v.state === 'toExit' || v.state === 'toDrill') && v.alpha >= 1

/** Soft separation between walking patients (SPEC 4.5). It only nudges: followPath steers back to the waypoints. */
function separateWalkers(s: GameState, dt: number) {
  const vs = s.villagers
  const maxPush = SEPARATION_SPEED * dt
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i]!
    if (!isWalker(a)) continue
    for (let j = i + 1; j < vs.length; j++) {
      const b = vs[j]!
      if (!isWalker(b)) continue
      const dx = b.x - a.x
      const dz = b.z - a.z
      const d2 = dx * dx + dz * dz
      if (d2 >= SEPARATION * SEPARATION) continue
      const d = Math.sqrt(d2)
      const nx = d > 1e-4 ? dx / d : 1
      const nz = d > 1e-4 ? dz / d : 0
      const push = Math.min((SEPARATION - d) / 2, maxPush)
      a.x -= nx * push
      a.z -= nz * push
      b.x += nx * push
      b.z += nz * push
    }
  }
}

function stepDoors(s: GameState, dt: number) {
  let south = false
  let north = false
  const r2 = DOOR_SENSE * DOOR_SENSE
  for (let i = 0; i < s.villagers.length; i++) {
    const v = s.villagers[i]!
    // The crew at the handle stands in the swing of the south gate's leaves: near it they hold it open, also outside.
    const crew = v.state === 'toDrill' || v.state === 'atDrill' || v.state === 'pushing'
    if (!crew && v.state !== 'toExit') continue
    // Anybody else holds a door open only while he is inside or in the doorway, not while he walks off outside.
    if ((crew || v.z < L.WARD1_DOOR.z + 0.5) && dist2(v.x, v.z, L.WARD1_DOOR.x, L.WARD1_DOOR.z) < r2) south = true
    if (v.z > L.NORTH_DOOR.z - 0.5 && dist2(v.x, v.z, L.NORTH_DOOR.x, L.NORTH_DOOR.z) < r2) north = true
  }
  s.doors.south = approach(s.doors.south, south ? 1 : 0, dt / (south ? DOOR_OPEN_TIME : DOOR_CLOSE_TIME))
  s.doors.north = approach(s.doors.north, north ? 1 : 0, dt / (north ? DOOR_OPEN_TIME : DOOR_CLOSE_TIME))
}

export function stepWard(s: GameState, dt: number) {
  applyUnlocks(s)
  stepNurses(s, dt)
  stepBeds(s, dt)
  stepPatients(s, dt)
  separateWalkers(s, dt)
  stepDoors(s, dt)
}
