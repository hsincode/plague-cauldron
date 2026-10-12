// Input (SPEC section 6): one-finger drag anywhere = floating joystick; WASD / arrow keys on desktop.
// Screen directions are mapped onto the ground through SCREEN_UP / SCREEN_RIGHT.
import { SCREEN_RIGHT, SCREEN_UP } from '../config'
import type { Input } from '../sim/types'

/** Drag distance for full speed (px): the knob then touches the ring. A finger that goes further pulls the origin along. */
const FULL = 40
/** Drags shorter than this do not move him (px). */
const DEAD = 4

export interface InputSource {
  /** Current desired movement in world space (zero while disabled). */
  read(out: Input): Input
  /** While false nothing steers and a drag in progress is let go (title and win screens). */
  enabled: boolean
}

/** Pointers that go down on `el` (or anything inside it that is not a button, a link or .no-joy) steer. */
export function createInput(el: HTMLElement): InputSource {
  const keys = new Set<string>()
  /** Pointers that are down, newest last. The newest one is the stick; when it lifts, the one before takes over. */
  const live: { id: number; x: number; y: number }[] = []
  let enabled = true
  let ox = 0
  let oy = 0
  let dx = 0
  let dy = 0
  // client position of el's corner, for placing the ring
  let ex = 0
  let ey = 0
  const ring = document.createElement('div')
  ring.className = 'joy'
  ring.innerHTML = '<i></i>'
  el.appendChild(ring)
  const knob = ring.firstElementChild as HTMLElement

  const place = () => {
    ring.style.left = `${ox - ex}px`
    ring.style.top = `${oy - ey}px`
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`
  }
  /** The stick is now this pointer, centred where it is. */
  const grab = (p: { x: number; y: number }) => {
    const r = el.getBoundingClientRect()
    ex = r.left
    ey = r.top
    ox = p.x
    oy = p.y
    dx = dy = 0
    place()
    ring.classList.add('on')
  }
  const letGo = () => {
    live.length = 0
    dx = dy = 0
    ring.classList.remove('on')
  }

  const down = (e: PointerEvent) => {
    if (!enabled || (e.pointerType === 'mouse' && e.button !== 0)) return
    if ((e.target as HTMLElement).closest('button, a, .no-joy')) return
    up(e) // a pointer whose release was missed
    const p = { id: e.pointerId, x: e.clientX, y: e.clientY }
    live.push(p)
    grab(p)
    el.setPointerCapture?.(p.id)
    e.preventDefault()
  }
  const move = (e: PointerEvent) => {
    const p = live.find(q => q.id === e.pointerId)
    if (!p) return
    // the button was released outside the page, so no pointerup came
    if (e.pointerType === 'mouse' && e.buttons === 0) return up(e)
    p.x = e.clientX
    p.y = e.clientY
    if (p !== live[live.length - 1]) return
    dx = p.x - ox
    dy = p.y - oy
    const l = Math.hypot(dx, dy)
    if (l > FULL) {
      // past full deflection the origin follows the finger: turning back responds at once, wherever the drag went
      dx *= FULL / l
      dy *= FULL / l
      ox = p.x - dx
      oy = p.y - dy
    }
    place()
  }
  const up = (e: PointerEvent) => {
    const i = live.findIndex(q => q.id === e.pointerId)
    if (i < 0) return
    const stick = i === live.length - 1
    live.splice(i, 1)
    if (live.length === 0) letGo()
    else if (stick) grab(live[live.length - 1]!)
  }
  const kd = (e: KeyboardEvent) => {
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault()
    keys.add(e.code)
  }
  const ku = (e: KeyboardEvent) => keys.delete(e.code)
  const blur = () => {
    keys.clear()
    letGo()
  }
  el.addEventListener('pointerdown', down)
  // only the capture taken in down(): the event also bubbles up from a child that loses a touch's implicit capture to it
  el.addEventListener('lostpointercapture', e => e.target === el && up(e))
  addEventListener('pointermove', move)
  addEventListener('pointerup', up)
  addEventListener('pointercancel', up)
  addEventListener('keydown', kd)
  addEventListener('keyup', ku)
  addEventListener('blur', blur)
  el.addEventListener('contextmenu', e => e.preventDefault())

  return {
    read(out) {
      let sx = 0
      let sy = 0
      // no pointer is tracked while disabled
      if (live.length > 0) {
        const l = Math.hypot(dx, dy)
        if (l > DEAD) {
          const m = Math.min(1, l / FULL)
          sx = (dx / l) * m
          sy = (-dy / l) * m
        }
      } else if (enabled) {
        if (keys.has('KeyW') || keys.has('ArrowUp')) sy += 1
        if (keys.has('KeyS') || keys.has('ArrowDown')) sy -= 1
        if (keys.has('KeyD') || keys.has('ArrowRight')) sx += 1
        if (keys.has('KeyA') || keys.has('ArrowLeft')) sx -= 1
        const l = Math.hypot(sx, sy)
        if (l > 1) {
          sx /= l
          sy /= l
        }
      }
      out.mx = sx * SCREEN_RIGHT.x + sy * SCREEN_UP.x
      out.mz = sx * SCREEN_RIGHT.z + sy * SCREEN_UP.z
      return out
    },
    get enabled() {
      return enabled
    },
    set enabled(on) {
      enabled = on
      if (!on) letGo()
    },
  }
}
