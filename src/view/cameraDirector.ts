// Camera behaviour of SPEC section 5: a smoothed follow that frames the station the doctor is using, a base zoom that
// follows the progress, scripted pans (first bath, first sortie, unlock reveals, win) and shake.
import { BEDS, L, P, SCREEN_RIGHT, SCREEN_UP, UNLOCKS, type UnlockId } from '../config'
import { approach, clamp, damp, dist, smoothstep } from '../core/math'
import type { GameEvent } from '../sim/events'
import type { GameState, Input } from '../sim/types'
import type { Stage } from './stage'

interface Pt {
  x: number
  z: number
}

interface PanDef {
  /** Writes the point to look at; evaluated every frame. */
  focus: (s: GameState, out: Pt) => void
  easeIn: number
  /** Longest stay at full weight (Infinity: the pan never ends and cannot be cancelled). */
  hold: number
  easeOut: number
  /** Zoom factor on top of the base zoom. */
  zoom: number
  /** The hold ends `linger` seconds after this turns false. */
  until?: (s: GameState) => boolean
  linger: number
  /**
   * Keep the doctor on screen whenever he moves, so that the pan can run while he is walked about; it is cancelled
   * only when he walks out of the shot (away from the focus, against the edge of the frame), and not before `lock`
   * seconds. Without it any movement input cancels the pan.
   */
  tether: boolean
  lock: number
}

interface Pan {
  def: PanDef
  /** 0..1 strength of the tether: it eases in when the doctor moves and lets go when he stands. */
  tether: number
  /** Metres the shot is short of holding the doctor too (0: he is inside the frame). */
  strain: number
  /** Seconds since the start; stops counting when the ease-out begins. */
  t: number
  /** Eased 0..1 progress of the ease-in. */
  e: number
  /** Seconds into the ease-out, or -1. */
  out: number
  /** Slope of the fade-out curve at its start: a pan cancelled while it eases in keeps its momentum for a moment. */
  slope: number
  hold: number
  /**
   * Where the pan starts from: weight, focus and zoom factor of the pan it took over from (w0 = 0: none). The
   * ease-out reuses them for the camera's place at the moment it began, with e back at 0.
   */
  w0: number
  x0: number
  z0: number
  zoom0: number
}

interface Station extends Pt {
  /** Pull of the follow target toward this aim, 0..1, and its rate of change. */
  w: number
  v: number
  /** The pull at full use. */
  blend: number
}

export interface CameraDirector {
  update(s: GameState, input: Input, dt: number): void
  onEvent(e: GameEvent): void
  /** amplitude in metres, duration in seconds. */
  shake(amplitude: number, duration: number): void
  /** Jump straight to the follow target (after a restart or fast-forward). */
  snap(s: GameState): void
}

// --- station framing --------------------------------------------------------------------------------------------------
// Aims and weights are read off the ad's camera track: the doctor's ring on screen while he stands at a known spot
// gives the camera target, and the target sits this far from the plain follow point toward what he is using.

/** Pot, queue and bath exit in one shot [SEEN 9.6-10.6 pouring, 13.2-14.4 and 30.6-33.0 watching the bath]. */
const CAULDRON_AIM = { x: 0.3, z: -0.5 }
const CAULDRON_BLEND = 0.7
/** The pot's pull fades in over this distance outside the deposit radius: wide, so that walking up to it does not whip. */
const CAULDRON_FADE = 3
/** Just past the pallet, so that the coins sit mid-screen with the doctor to their left [SEEN 18.4-18.8, 33.6-34.4]. */
const PALLET_AIM = { x: L.PALLET.x + 0.9, z: L.PALLET.z - 0.5 }
/** Gate, bay and queue while he lets patients out by hand [SEEN 11.8-12.2]. */
const PEN_AIM = { x: -3.45, z: 0 }
/** Beds A and C with their nurses' posts [SEEN 16.1-17.3, 21.0-24.0]. */
const WARD1_SHOT = { x: 3.87, z: 6.4 }
/** The south gate at the top, the drill's run and the rat field below it [SEEN 25.3-26.6]. */
const DRILL_SHOT = { x: L.DRILL_PARK.x + 1.4, z: L.DRILL_PARK.z + 0.8 }
/** All six new beds with the doctor left in the bottom-right corner [SEEN 51.2-52.6]. */
const WARD2_SHOT = (() => {
  const beds = BEDS.filter(b => b.ward === 2)
  return { x: beds.reduce((a, b) => a + b.x, 0) / beds.length + 0.5, z: beds.reduce((a, b) => a + b.z, 0) / beds.length + 0.4 }
})()
/** A pad he is paying is framed together with what it is about to unlock; the other pads with themselves. */
const PAD_AIM: Partial<Record<UnlockId, Pt>> = {
  nurses: WARD1_SHOT, // [SEEN 19.6-20.0]
  usher: { x: -3.1, z: -4.1 }, // [SEEN 27.8-29.8]
  cart: { x: 11.3, z: -5.2 }, // between the pad and the scoop's rest [SEEN 35.2-36.0]
  ward2: { x: -0.7, z: -9.0 }, // the yard behind the pad [SEEN 50.4-50.8]
}
const GRINDER = { x: (L.GRINDER[0] + L.GRINDER[2]) / 2, z: (L.GRINDER[1] + L.GRINDER[3]) / 2 }
/** Tray and flask landing area together [SEEN 5.4-7.0]. */
const GRINDER_AIM = { x: (GRINDER.x + L.FLASK_AREA.x) / 2, z: (GRINDER.z + L.FLASK_AREA.z) / 2 }
const CARRY_BLEND = 0.35
const GRIND_BLEND = 0.5
/** From the cart's seat the pile lies beyond the blade and the tray [SEEN 41.0-41.4]. */
const GRIND_BLEND_SEATED = 0.6
// The grinder pulls from far away: a tool reaches up to 5 m ahead of the doctor, and the tray must be in view before it.
const GRINDER_NEAR = 6
const GRINDER_FAR = 9.5
/** A station's pull fades in over this distance outside its interaction radius. */
const STATION_FADE = 1.5
/** Spring rate of a pull: it settles in about 0.6 s, starting and ending gently (the ad's re-framings take 0.4-0.8 s). */
const STATION_OMEGA = 2 / 0.3
/** On the cart the camera looks this far ahead of the seat: at the wagon, or most of the way to a docked bubble [SEEN 37.0-40.6]. */
const CART_AHEAD = 2.0
const CART_AHEAD_LOADED = 0.66
const LEAD_RATE = 4

// --- pans -------------------------------------------------------------------------------------------------------------

const ZOOM_RATE = 0.12 // base zoom change per second: the opening's 16 % takes 1.3 s
const MOVING = 0.2 // stick deflection that counts as walking
const WATCHING = 0.25 // seconds on foot at rest before a pan may take the camera away from the doctor
const MAX_SLOPE = 3 // of a cancelled pan's fade-out: it overshoots the weight it had by at most 30 %
const TETHER_RATE = 6
const STRAINED = 0.05 // metres of tether correction that count as "he is at the edge of the shot"
const IN_REACH = 1.5 // the first-bath pan runs for a walking doctor when its shot can hold him too, give or take this

const BATHED_WALK: readonly string[] = ['hopOut', 'toBed', 'lieDown', 'inBed']
/** Mean position of the bathed patients on their way to bed, no farther than the ward shot. False when there are none. */
const bathFocus = (s: GameState, out: Pt) => {
  let x = 0
  let z = 0
  let n = 0
  for (const v of s.villagers) {
    if (!BATHED_WALK.includes(v.state)) continue
    x += v.x
    z += v.z
    n++
  }
  out.x = n > 0 ? Math.min(x / n, WARD1_SHOT.x) : WARD1_SHOT.x
  out.z = n > 0 ? Math.min(z / n, WARD1_SHOT.z) : WARD1_SHOT.z
  return n > 0
}
const cartFocus = (s: GameState, out: Pt) => {
  let cart: Pt = L.TOOL_REST
  for (const t of s.tools) if (t.kind === 'cart' && t.exists) cart = t
  out.x = cart.x + 1.0
  out.z = cart.z - 0.6
}
const fixed = (p: Pt) => (_s: GameState, out: Pt) => {
  out.x = p.x
  out.z = p.z
}
const ward1Busy = (s: GameState) => {
  for (const b of s.beds) if (b.ward === 1 && b.state !== 'free') return true
  return false
}

/** SPEC 5 pan 1: with the first patients from the pot to their beds, until pad A has popped in [SEEN 14.6-17.7]. */
const BATH_PAN: PanDef = { focus: bathFocus, easeIn: 0.5, hold: 6, easeOut: 0.4, zoom: 1, until: s => s.pads[0]!.state === 'hidden', linger: 0.6, tether: true, lock: 1 }
/** SPEC 5 pan 3: gate, crew and drill from the moment the first healed patients run for the handle until the heap is paid out. */
const SORTIE_PAN: PanDef = { focus: fixed(DRILL_SHOT), easeIn: 1.1, hold: 6, easeOut: 0.3, zoom: 1.04, until: s => s.drill.sorties === 0, linger: 0.1, tether: false, lock: 0 }
const WIN_PAN: PanDef = { focus: fixed(L.CAULDRON), easeIn: 1.2, hold: Infinity, easeOut: 1, zoom: 1.2, linger: 0, tether: false, lock: 0 }
const reveal = (focus: PanDef['focus'], easeIn: number, hold: number, easeOut: number, zoom = 1): PanDef => ({ focus, easeIn, hold, easeOut, zoom, linger: 0.3, tether: true, lock: easeIn + 0.5 })
/** Unlock reveals (SPEC 5 pans 2, 4, 5). The usher has none: the ad's camera stays put [SEEN 28.0-29.8]. */
const REVEALS: Partial<Record<UnlockId, PanDef>> = {
  // stays on the ward while the first patients are treated, then hands over to the sortie pan [SEEN 20.47-24.17]
  nurses: { ...reveal(fixed(WARD1_SHOT), 0.5, 8, 0.8), until: ward1Busy },
  cart: reveal(cartFocus, 0.25, 0.9, 0.8),
  // a whip, so that the camera is there while the beds are still glowing [SEEN 51.00-51.10]
  ward2: reveal(fixed(WARD2_SHOT), 0.2, 1.5, 0.8, 1.05),
}
const firstBathRunning = (s: GameState) => !s.unlocks.nurses && s.pads[0]!.state === 'hidden' && bathFocus(s, tmp)
const firstSortieRunning = (s: GameState) => s.drill.sorties === 0 && (s.drill.state !== 'parked' || s.drill.crew.length > 0)

// --- the 9:16 reference frame, for keeping the doctor on screen (SPEC 5) ----------------------------------------------

const CAM_GROUND = Math.hypot(P.CAMERA_OFFSET[0], P.CAMERA_OFFSET[2])
const CAM_DIST = Math.hypot(CAM_GROUND, P.CAMERA_OFFSET[1])
const SIN_PITCH = P.CAMERA_OFFSET[1] / CAM_DIST
const COS_PITCH = CAM_GROUND / CAM_DIST
const TAN_V = Math.tan((P.CAMERA_FOV * Math.PI) / 360)
const TAN_H = (TAN_V * 9) / 16
/** Metres beyond the target (along SCREEN_UP, at zoom 1) of the ground point at height `y` of the frame (-1 bottom .. 1 top). */
const beyond = (y: number) => (y * TAN_V * CAM_DIST) / (SIN_PITCH - y * TAN_V * COS_PITCH)
// his ring may touch the frame's edge as it does in the ad's ward shots, and his hat stays below the HUD
const FRAME_SIDE = 0.92
const BEYOND_TOP = beyond(0.5)
const BEYOND_BOTTOM = beyond(-0.72)
/** Moves the camera target `t` just enough to have the doctor inside the safe part of the frame; returns by how many metres. */
const keepInFrame = (s: GameState, zoom: number, t: Pt) => {
  const dx = s.player.x - t.x
  const dz = s.player.z - t.z
  const u = dx * SCREEN_RIGHT.x + dz * SCREEN_RIGHT.z
  const v = dx * SCREEN_UP.x + dz * SCREEN_UP.z
  const v1 = clamp(v, BEYOND_BOTTOM * zoom, BEYOND_TOP * zoom)
  const side = FRAME_SIDE * TAN_H * (CAM_DIST * zoom + v1 * COS_PITCH)
  const u1 = clamp(u, -side, side)
  t.x += (u - u1) * SCREEN_RIGHT.x + (v - v1) * SCREEN_UP.x
  t.z += (u - u1) * SCREEN_RIGHT.z + (v - v1) * SCREEN_UP.z
  return Math.hypot(u - u1, v - v1)
}

const ease = (t: number) => t * t * (3 - 2 * t)
const station = (aim: Pt, blend: number): Station => ({ x: aim.x, z: aim.z, w: 0, v: 0, blend })
const reach = (d: number, r: number) => smoothstep(r + STATION_FADE, r, d)
const tmp = { x: 0, z: 0 }

export function createCameraDirector(stage: Stage): CameraDirector {
  const cauldron = station(CAULDRON_AIM, CAULDRON_BLEND)
  const pallet = station(PALLET_AIM, P.CAMERA_STATION_BLEND)
  const pen = station(PEN_AIM, P.CAMERA_STATION_BLEND)
  const grinder = station(GRINDER_AIM, GRIND_BLEND_SEATED)
  const pads = UNLOCKS.map(u => station(PAD_AIM[u.id] ?? u, P.CAMERA_STATION_BLEND))
  const stations = [cauldron, pallet, pen, grinder, ...pads]
  // offset of the follow point from the doctor: the framing bias on foot, a look-ahead along the heading on the cart
  let leadX: number = P.CAMERA_TARGET_BIAS[0]
  let leadZ: number = P.CAMERA_TARGET_BIAS[2]
  let cx: number = L.PLAYER_START.x
  let cz: number = L.PLAYER_START.z
  let zoomRamp = 1
  let zoomBase = 1
  let pan: Pan | null = null
  /** Pan asked for by an event; it starts on the next update, which knows the state and the stick. */
  let queued: PanDef | null = null
  // what the running pan adds this frame (the next pan takes over from here)
  let panW = 0
  let panX = 0
  let panZ = 0
  let panZoom = 1
  // the target handed to the stage last frame
  let lastX = cx
  let lastZ = cz
  let bathShown = false
  let sortieShown = false
  let shakeAmp = 0
  let shakeT = 0
  let shakeDur = 1
  let seed = 1
  const rnd = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647 - 0.5
  }

  const leadAim = (s: GameState, out: Pt) => {
    const p = s.player
    const tool = s.tools[p.tool]
    if (!tool || (p.mode !== 'cart' && p.mountT <= 0)) {
      out.x = P.CAMERA_TARGET_BIAS[0]
      out.z = P.CAMERA_TARGET_BIAS[2]
      return
    }
    let ahead = CART_AHEAD
    for (const b of s.bubbles) if (b.id === tool.bubble) ahead = CART_AHEAD_LOADED * (P.CART_BLADE_OFFSET + P.DOCK_SEAT * b.r)
    out.x = Math.sin(tool.heading) * ahead
    out.z = Math.cos(tool.heading) * ahead
  }
  // one station's pull through a critically damped spring; `walking`, `stepDt` and `decay` belong to the assign() pass
  let walking = false
  let stepDt = 0
  let decay = 1
  /** `use` 0..1 of the station's blend, `near` 0..1 by distance, `room` 0..1 left by the stations of higher rank. */
  const pull = (st: Station, use: number, near: number, room: number) => {
    const want = st.blend * use * near * room
    if (want > st.w || walking || near === 0) {
      const d = st.w - want
      const step = (st.v + STATION_OMEGA * d) * stepDt
      st.v = (st.v - STATION_OMEGA * step) * decay
      st.w = want + (d + step) * decay
    } else st.v = 0
    st.w = Math.min(st.w, st.blend * room)
  }
  /**
   * Relaxes the pull of every station toward what the doctor is using: a pad he can pay, the pallet, the pen gate,
   * the grinder, else the pot. A pull rises whenever its use begins but falls only while he walks, once he is out of
   * reach or when a station of higher rank takes over, so what he has just used stays framed until he moves on
   * [SEEN 28.4-30.0 after pad B].
   */
  const assign = (s: GameState, dt: number) => {
    const p = s.player
    walking = p.stillT === 0
    stepDt = dt
    const x = STATION_OMEGA * dt
    decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
    let room = 1
    for (let i = 0; i < pads.length; i++) {
      const pad = s.pads[i]!
      const paying = pad.state === 'paying' || pad.state === 'done'
      const payable = (pad.state === 'idle' || pad.state === 'popIn') && s.wallet >= pad.price - pad.paid && !s.pallet.collecting
      pull(pads[i]!, paying || payable ? 1 : 0, reach(dist(p.x, p.z, pad.x, pad.z), P.PAD_PAY_RADIUS), 1)
      room = Math.min(room, 1 - pads[i]!.w / pads[i]!.blend)
    }
    // once the bursar empties the pallet it is no station of his any more
    const coins = !s.unlocks.bursar && (s.pallet.gold > 0 || s.pallet.incoming.length > 0 || s.pallet.collecting)
    pull(pallet, coins ? 1 : 0, reach(dist(p.x, p.z, L.PALLET.x, L.PALLET.z), P.PALLET_PICKUP_RADIUS), room)
    const byHand = !s.unlocks.usher && s.crowd.remaining > 0
    pull(pen, byHand ? 1 : 0, reach(dist(p.x, p.z, L.MANUAL_RELEASE.x, L.MANUAL_RELEASE.z), P.MANUAL_RELEASE_RADIUS), room)
    const carrying = p.tool >= 0 && s.tools[p.tool]!.bubble >= 0
    // the pile is his business until he takes a tool out for the next bubble
    const grinding = s.grinder.state === 'grinding' || (s.groundFlasks.length > 0 && (p.tool < 0 || p.dismountPending))
    const blend = grinding ? (p.mode === 'cart' ? GRIND_BLEND_SEATED : GRIND_BLEND) : carrying ? CARRY_BLEND : 0
    pull(grinder, blend / grinder.blend, smoothstep(GRINDER_FAR, GRINDER_NEAR, dist(p.x, p.z, GRINDER.x, GRINDER.z)), room)
    room = Math.min(room, 1 - pallet.w / pallet.blend, 1 - pen.w / pen.blend)
    // the pot takes what the others leave, by position alone: the camera settles on it as he walks up and stops with him
    cauldron.w = cauldron.blend * smoothstep(P.DEPOSIT_RADIUS + CAULDRON_FADE, P.DEPOSIT_RADIUS, dist(p.x, p.z, L.CAULDRON.x, L.CAULDRON.z)) * room
  }
  const followTarget = (s: GameState, out: Pt) => {
    const p = s.player
    // the hop off the cart is not a walk: no look-ahead for it
    const ahead = p.dismountT > 0 ? 0 : P.CAMERA_LOOKAHEAD
    const x = p.x + leadX + p.vx * ahead
    const z = p.z + leadZ + p.vz * ahead
    let sum = 0
    let dx = 0
    let dz = 0
    for (const st of stations) {
      sum += st.w
      dx += (st.x - x) * st.w
      dz += (st.z - z) * st.w
    }
    const n = Math.max(1, sum)
    out.x = x + dx / n
    out.z = z + dz / n
  }
  const baseZoom = (s: GameState) => (s.stats.flasksMade === 0 ? P.CAMERA_ZOOM_OPENING : s.unlocks.ward2 ? P.CAMERA_ZOOM_LATE : 1)
  /** True when the pan's shot can hold the doctor as well. */
  const inReach = (def: PanDef, s: GameState) => {
    def.focus(s, tmp)
    return keepInFrame(s, zoomBase * def.zoom, tmp) < IN_REACH
  }
  const startPan = (def: PanDef, moving: boolean) => {
    pan = { def, tether: moving ? 1 : 0, strain: 0, t: 0, e: 0, out: -1, slope: 0, hold: def.hold, w0: panW, x0: panX, z0: panZ, zoom0: panZoom }
  }

  return {
    snap(s) {
      leadAim(s, tmp)
      leadX = tmp.x
      leadZ = tmp.z
      for (const st of stations) st.w = st.v = 0
      assign(s, 1e3)
      for (const st of stations) st.v = 0
      followTarget(s, tmp)
      cx = tmp.x
      cz = tmp.z
      zoomRamp = zoomBase = baseZoom(s)
      pan = queued = null
      panW = 0
      panZoom = 1
    },
    shake(amplitude, duration) {
      if (amplitude >= shakeAmp * (1 - shakeT / shakeDur) || shakeT >= shakeDur) {
        shakeAmp = amplitude
        shakeDur = duration
        shakeT = 0
      }
    },
    onEvent(e) {
      switch (e.type) {
        case 'bubbleReject':
          this.shake(0.08, 0.13)
          break
        case 'grindCrack':
          this.shake(0.07, 0.35)
          break
        case 'bathSplash':
          this.shake(0.06, 0.2)
          break
        case 'unlock':
          this.shake(0.1, 0.25)
          if (e.id !== 'usher') queued = REVEALS[e.id] ?? reveal(fixed(e), 0.3, 0.7, 0.8)
          break
        case 'drillKill':
          this.shake(0.06, P.DRILL_COIN_FOUNTAIN)
          break
        case 'win':
          queued = WIN_PAN
          break
      }
    },
    update(s, input, dt) {
      leadAim(s, tmp)
      const kl = damp(LEAD_RATE, dt)
      leadX += (tmp.x - leadX) * kl
      leadZ += (tmp.z - leadZ) * kl
      assign(s, dt)
      followTarget(s, tmp)
      const k = damp(1 / (P.CAMERA_SMOOTH_TIME * 0.5), dt)
      cx += (tmp.x - cx) * k
      cz += (tmp.z - cz) * k
      zoomRamp = approach(zoomRamp, baseZoom(s), ZOOM_RATE * dt)
      zoomBase += (zoomRamp - zoomBase) * damp(4, dt)

      // The first-time pans are state-driven (once each, whenever their event is running), so a fast-forward neither
      // replays nor loses them. They are for a player who stands and watches, not for one who waits at a tool for a
      // bubble; the first bath also runs for one who walks near enough to stay in its shot, as the ad's player does.
      const moving = Math.hypot(input.mx, input.mz) > MOVING
      const watching = !moving && s.player.mode === 'foot' && s.player.stillT > WATCHING
      if (queued) {
        startPan(queued, moving)
        queued = null
      } else if (!bathShown && firstBathRunning(s) && (watching || inReach(BATH_PAN, s))) {
        bathShown = true
        startPan(BATH_PAN, moving)
      } else if (!sortieShown && firstSortieRunning(s) && watching) {
        sortieShown = true
        startPan(SORTIE_PAN, moving)
      }

      tmp.x = cx
      tmp.z = cz
      let zoom = zoomBase
      if (pan) {
        const def = pan.def
        if (pan.out < 0) {
          pan.t += dt
          const q = Math.min(1, pan.t / def.easeIn)
          pan.e = ease(q)
          if (def.until && !def.until(s)) pan.hold = Math.min(pan.hold, Math.max(0, pan.t - def.easeIn) + def.linger)
          // tethered: he may walk about inside the shot, and into it from its edge; walking out of it ends it
          const leaving = pan.strain > STRAINED && (s.player.x - panX) * s.player.vx + (s.player.z - panZ) * s.player.vz > 0
          const cancelled = moving && def.hold < Infinity && (!def.tether || (leaving && pan.t >= def.lock))
          if (cancelled || pan.t >= def.easeIn + pan.hold) {
            // it eases out from where the camera stands (weight reached, tether included), never from the full pan
            pan.out = 0
            const w = pan.w0 + (1 - pan.w0) * pan.e
            pan.slope = Math.min(MAX_SLOPE, (((1 - pan.w0) * 6 * q * (1 - q)) / def.easeIn) * (def.easeOut / Math.max(w, 1e-3)))
            pan.w0 = 1
            pan.x0 = lastX
            pan.z0 = lastZ
            pan.zoom0 = panZoom
            pan.e = 0
          }
        } else pan.out += dt
        const o = pan.out < 0 ? 0 : Math.min(1, pan.out / def.easeOut)
        // cubic from 1 to 0 that leaves with the slope the weight had and arrives flat
        const fade = 1 - ease(o) + pan.slope * o * (1 - o) * (1 - o)
        def.focus(s, tmp)
        panX = pan.w0 > 0 ? pan.x0 + (tmp.x - pan.x0) * pan.e : tmp.x
        panZ = pan.w0 > 0 ? pan.z0 + (tmp.z - pan.z0) * pan.e : tmp.z
        panW = (pan.w0 + (1 - pan.w0) * pan.e) * fade
        panZoom = 1 + (pan.zoom0 - 1 + (def.zoom - pan.zoom0) * pan.e) * fade
        tmp.x = cx + (panX - cx) * panW
        tmp.z = cz + (panZ - cz) * panW
        zoom *= panZoom
        if (def.tether) {
          // also when something else moves him (a bubble's shove)
          pan.tether += ((moving || s.player.stillT === 0 ? 1 : 0) - pan.tether) * damp(TETHER_RATE, dt)
          const x = tmp.x
          const z = tmp.z
          pan.strain = keepInFrame(s, zoom, tmp)
          tmp.x = x + (tmp.x - x) * pan.tether
          tmp.z = z + (tmp.z - z) * pan.tether
        }
        if (pan.out >= def.easeOut) {
          pan = null
          panW = 0
          panZoom = 1
        }
      }
      lastX = tmp.x
      lastZ = tmp.z
      stage.setTarget(lastX, lastZ)
      stage.setZoom(zoom)
      if (shakeT < shakeDur) {
        shakeT += dt
        const a = shakeAmp * Math.max(0, 1 - shakeT / shakeDur)
        stage.setShake(rnd() * 2 * a, rnd() * 2 * a, rnd() * 2 * a)
      } else stage.setShake(0, 0, 0)
    },
  }
}
