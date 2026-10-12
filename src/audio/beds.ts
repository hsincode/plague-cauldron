// Continuous beds driven from the state every frame: river, ploughing, the cliff fall, the fire and the potion
// under the pot, cart wheels, the grinder and the drill. Every level follows the distance to the doctor, so each
// bed fades in as he walks up to its source. All sources run from the start; update() only moves parameters.
import { L, P } from '../config'
import { TAU, clamp01, fwdX, fwdZ, smoothstep } from '../core/math'
import type { GameState } from '../sim/types'
import { riverSample } from '../world/river'
import type { TextureName } from './loops'
import type { Mixer } from './mixer'

/** Blade centre ahead of whoever holds the tool: that is where the beads are ploughed. */
const BLADE_AHEAD = { scoop: P.SCOOP_OFFSET, cart: P.CART_BLADE_OFFSET } as const
const GRINDER = { x: (L.GRINDER[0] + L.GRINDER[2]) / 2, z: (L.GRINDER[1] + L.GRINDER[3]) / 2 }
const FALL = { x: L.RIVER[L.RIVER.length - 1]!.x, z: L.CLIFF_Z + 0.5 }
/** Disc speeds of sim/grinder.ts, revolutions per second. */
const GRINDER_REV_IDLE = 0.5
const GRINDER_REV_GRIND = 4
/** Cone speed of a sortie at full tilt (sim/drill.ts SPIN_RATE), radians per second. */
const DRILL_SPIN = 28

export interface Beds {
  update(s: GameState, simDt: number): void
}

/** A parameter that is only touched when its target really changes, then eased there. */
interface Ctl {
  p: AudioParam
  v: number
  tc: number
}

export function createBeds(m: Mixer): Beds {
  const { ctx } = m
  const out = m.bus.bed

  const ctl = (p: AudioParam, v: number, tc = 0.08): Ctl => {
    p.value = v
    return { p, v, tc }
  }
  const set = (c: Ctl, v: number) => {
    if (v === c.v || (v !== 0 && Math.abs(v - c.v) < 0.015 * (Math.abs(c.v) + 0.2))) return
    c.v = v
    m.glide(c.p, v, c.tc)
  }
  /** A level control feeding a panner on the bed bus. */
  const channel = (tc?: number) => {
    const g = ctx.createGain()
    const p = ctx.createStereoPanner()
    g.connect(p).connect(out)
    return { node: g, level: ctl(g.gain, 0, tc), pan: ctl(p.pan, 0, 0.15) }
  }
  const filter = (type: BiquadFilterType, f: number, q = 0.7) => {
    const n = ctx.createBiquadFilter()
    n.type = type
    n.frequency.value = f
    n.Q.value = q
    return n
  }
  /** Two copies of a loop at different speeds: the pattern only repeats after their common period. */
  const layers = (name: TextureName, dst: AudioNode) => {
    const half = ctx.createGain()
    half.gain.value = 0.71
    half.connect(dst)
    m.loop(name, half)
    m.loop(name, half, 0.87)
  }
  const osc = (type: OscillatorType, f: number) => {
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.value = f
    o.start()
    return o
  }

  // --- river: bead rattle, the denser rattle of ploughing, and the curtain of beads over the cliff ---
  const river = channel(0.2)
  layers('river', river.node)
  const plough = channel(0.07)
  m.loop('plough', plough.node)
  const fall = channel(0.2)
  m.loop('plough', fall.node, 0.8)
  const fallBody = filter('bandpass', 420, 0.6)
  m.loop('pink', fallBody)
  fallBody.connect(fall.node)

  // --- cauldron: fire, and the potion on the boil ---
  const fire = channel(0.2)
  layers('fire', fire.node)
  const potion = channel(0.12)
  const potionRate = ctl(m.loop('bubbling', potion.node).playbackRate, 1, 0.2)

  // --- cart wheels ---
  const wheels = channel(0.09)
  const wheelRate = ctl(m.loop('wheels', wheels.node).playbackRate, 1, 0.15)

  // --- grinder: two sawtooth shafts a fifth apart, chopped by the passing teeth; the crunch loop on top ---
  const grinder = channel(0.07)
  const shaftA = osc('sawtooth', 50)
  const shaftB = osc('sawtooth', 75)
  const shaftTone = filter('lowpass', 320, 1.5)
  const shaftBody = filter('highpass', 75)
  const teeth = ctx.createGain()
  teeth.gain.value = 0.18
  const teethLfo = osc('triangle', 6)
  const teethDepth = ctx.createGain()
  teethDepth.gain.value = 0.12
  teethLfo.connect(teethDepth).connect(teeth.gain)
  shaftA.connect(shaftTone)
  shaftB.connect(shaftTone)
  shaftTone.connect(shaftBody).connect(teeth).connect(grinder.node)
  const shaftAHz = ctl(shaftA.frequency, 50, 0.1)
  const shaftBHz = ctl(shaftB.frequency, 75, 0.1)
  const shaftCut = ctl(shaftTone.frequency, 320, 0.1)
  const teethHz = ctl(teethLfo.frequency, 6, 0.1)
  const grit = ctx.createGain()
  const gritLevel = ctl(grit.gain, 0, 0.05)
  m.loop('crunch', grit)
  grit.connect(grinder.node)

  // --- drill: a whining, whirring motor that climbs with the cone speed ---
  const drill = channel(0.05)
  const motor = osc('sawtooth', 60)
  const whine = osc('square', 121)
  const whineGain = ctx.createGain()
  whineGain.gain.value = 0.35
  const drillTone = filter('bandpass', 400, 1.6)
  // the cone's flutes chop the tone: without this it is a plain buzz
  const flutes = ctx.createGain()
  flutes.gain.value = 0.65
  const flutesLfo = osc('triangle', 31)
  const flutesDepth = ctx.createGain()
  flutesDepth.gain.value = 0.35
  flutesLfo.connect(flutesDepth).connect(flutes.gain)
  const whirr = ctx.createGain()
  whirr.gain.value = 1.5
  m.loop('pink', whirr)
  motor.connect(drillTone)
  whine.connect(whineGain).connect(drillTone)
  whirr.connect(drillTone)
  drillTone.connect(flutes).connect(drill.node)
  const motorHz = ctl(motor.frequency, 60, 0.05)
  const whineHz = ctl(whine.frequency, 121, 0.05)
  const drillCut = ctl(drillTone.frequency, 400, 0.05)

  let lastDrillSpin = 0

  /** 0..1 of how hard a blade at (x, z) ploughs the beads when it moves at `speed` out of `cruise`. */
  const ploughing = (x: number, z: number, speed: number, cruise: number) => {
    if (z > L.CLIFF_Z + 0.5) return 0
    const r = riverSample(x, z)
    return smoothstep(r.halfW + 0.7, r.halfW - 0.6, Math.abs(r.d)) * clamp01(speed / cruise)
  }

  return {
    update(s, simDt) {
      const pl = s.player

      // river
      const r = riverSample(pl.x, pl.z)
      const away = Math.max(0, Math.abs(r.d) - r.halfW)
      set(river.level, 0.5 / (1 + (away * away) / 25))
      // the west bank is the right-hand side looking downstream: from there the river lies to the east
      set(river.pan, 0.45 * Math.sign(r.d) * clamp01(away / 6))
      set(fall.level, 0.5 * m.near(FALL.x, FALL.z, 6))
      set(fall.pan, m.pan(FALL.x, FALL.z))

      const tool = pl.tool >= 0 ? s.tools[pl.tool]! : null
      const ahead = tool ? BLADE_AHEAD[tool.kind] : 0
      const speed = Math.hypot(pl.vx, pl.vz)
      // on foot only his own body parts the beads
      let push = ploughing(pl.x + fwdX(pl.heading) * ahead, pl.z + fwdZ(pl.heading) * ahead, speed, pl.mode === 'cart' ? P.CART_SPEED : P.PLAYER_SPEED) * (tool ? 1 : 0.3)
      let roll = pl.mode === 'cart' ? clamp01(speed / P.CART_SPEED) : 0
      const dr = s.driver
      if (dr.present && s.tools[dr.tool]?.holder === 'driver') {
        const v = Math.hypot(dr.vx, dr.vz)
        const k = m.near(dr.x, dr.z)
        push = Math.max(push, k * ploughing(dr.x + fwdX(dr.heading) * P.CART_BLADE_OFFSET, dr.z + fwdZ(dr.heading) * P.CART_BLADE_OFFSET, v, P.CART_SPEED))
        roll = Math.max(roll, k * clamp01(v / P.CART_SPEED))
      }
      set(plough.level, push * 0.7)
      set(wheels.level, roll * 0.7)
      set(wheelRate, 0.75 + 0.5 * roll)

      // cauldron
      const c = s.cauldron
      const pot = m.near(L.CAULDRON.x, L.CAULDRON.z, 6)
      const side = m.pan(L.CAULDRON.x, L.CAULDRON.z)
      const fill = c.potion / c.capacity
      set(fire.level, 0.9 * pot)
      set(fire.pan, side)
      // it boils up while bathers are in it and for a moment after every flask
      const stir = c.bath === 'curing' || c.bath === 'check' ? 1.6 : c.sinceFill < 0.4 ? 1.35 : 1
      set(potion.level, c.potion > 0 ? (0.35 + 0.5 * fill) * stir * pot : 0)
      set(potion.pan, side)
      set(potionRate, 0.85 + 0.4 * fill)

      // grinder
      const g = s.grinder
      const grinding = g.state === 'grinding'
      const rev = grinding ? GRINDER_REV_GRIND : GRINDER_REV_IDLE
      const hz = 40 + 20 * rev
      grinder.level.tc = shaftAHz.tc = shaftBHz.tc = teethHz.tc = shaftCut.tc = grinding ? 0.06 : 0.3
      set(grinder.level, (grinding ? 1 : 0.15) * m.near(GRINDER.x, GRINDER.z, 8))
      set(grinder.pan, m.pan(GRINDER.x, GRINDER.z))
      set(shaftAHz, hz)
      set(shaftBHz, hz * 1.498)
      set(shaftCut, 220 + 120 * rev)
      set(teethHz, 3 + 5 * rev)
      // glass is in the rollers from the shatter on; the chips keep hopping after the tray is free (SPEC 2.4)
      const chewing = grinding && g.t >= P.GRIND_SHARDS
      gritLevel.tc = chewing ? 0.04 : 0.3
      set(gritLevel, chewing ? 0.8 : 0)

      // drill: the cone speed is read off its spin angle, so the motor follows whatever the sortie does
      const d = s.drill
      const spin = simDt > 1e-6 ? clamp01(((d.spin - lastDrillSpin + TAU) % TAU) / simDt / DRILL_SPIN) : 0
      lastDrillSpin = d.spin
      set(drill.level, spin > 0 ? (0.4 + 1.1 * spin) * Math.max(0.2, m.near(d.x, d.z)) : 0)
      set(drill.pan, m.pan(d.x, d.z))
      set(motorHz, 55 + 110 * spin)
      set(whineHz, (55 + 110 * spin) * 2.02)
      set(drillCut, 300 + 1500 * spin)
    },
  }
}
