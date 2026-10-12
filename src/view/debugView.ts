// Bare-bones visualisation of the whole simulation state with primitives (enable with ?debug=1).
// It exists to verify the simulation before/independently of the real views and stays useful for debugging.
import * as THREE from 'three'
import { BEDS, L, P, UNLOCKS } from '../config'
import { BALL_FALL } from '../sim/types'
import { bladeWorld } from '../sim/tools'
import { STATIC_COLLIDERS } from '../world/colliders'
import { CROWD_SLOTS } from '../world/crowd'
import type { ViewCtx, ViewModule } from './types'

export function createDebugView(ctx: ViewCtx): ViewModule {
  const root = new THREE.Group()
  ctx.scene.add(root)
  const basic = (c: number, o = 1) => new THREE.MeshBasicMaterial({ color: c, transparent: o < 1, opacity: o })
  const lamb = (c: number) => new THREE.MeshLambertMaterial({ color: c })
  // ground + layout
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), lamb(0x55534c))
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.02
  root.add(ground)
  const rect = (x0: number, z0: number, x1: number, z1: number, c: number, y = 0, h = 0.02) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, h, z1 - z0), lamb(c))
    m.position.set((x0 + x1) / 2, y + h / 2, (z0 + z1) / 2)
    root.add(m)
    return m
  }
  rect(...L.COURTYARD, 0x848691)
  rect(...L.WARD1, 0x77655b)
  const yard = rect(...L.WARD2, 0x5c5850)
  rect(...L.GRINDER, 0x666874, 0, 0.2)
  for (const c of STATIC_COLLIDERS) {
    if (c.t === 'seg') {
      const len = Math.hypot(c.bx - c.ax, c.bz - c.az)
      const m = new THREE.Mesh(new THREE.BoxGeometry(len + c.r * 2, c.r > 0.16 ? 2 : 1, c.r * 2), lamb(0x55555d))
      m.position.set((c.ax + c.bx) / 2, c.r > 0.16 ? 1 : 0.5, (c.az + c.bz) / 2)
      m.rotation.y = -Math.atan2(c.bz - c.az, c.bx - c.ax)
      root.add(m)
    } else if (c.t === 'circle' && c.r < 2) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(c.r, c.r, 1.2, 10), lamb(0x606662))
      m.position.set(c.x, 0.6, c.z)
      root.add(m)
    }
  }
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.2, 1.7, 20, 1, true), new THREE.MeshLambertMaterial({ color: 0x3d2e3b, side: THREE.DoubleSide }))
  pot.position.y = 0.85
  root.add(pot)
  const liquid = new THREE.Mesh(new THREE.CircleGeometry(1.6, 20), basic(0xaaf3f7))
  liquid.rotation.x = -Math.PI / 2
  root.add(liquid)
  const beds = BEDS.map(b => rect(b.x - P.BED_W / 2, b.z - P.BED_D / 2, b.x + P.BED_W / 2, b.z + P.BED_D / 2, 0xa8686f, 0, 0.55))
  const pallet = rect(L.PALLET.x - 0.8, L.PALLET.z - 0.65, L.PALLET.x + 0.8, L.PALLET.z + 0.65, 0xd98c47, 0, 0.15)
  const pads = UNLOCKS.map(u => {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.95, 24), basic(0xffffff))
    m.rotation.x = -Math.PI / 2
    m.position.set(u.x, 0.03, u.z)
    root.add(m)
    return m
  })
  // instanced things
  const balls = new THREE.InstancedMesh(new THREE.SphereGeometry(P.BALL_DIAMETER / 2, 8, 6), new THREE.MeshPhongMaterial({ color: 0x16959e, shininess: 80 }), P.BALL_COUNT)
  balls.frustumCulled = false
  root.add(balls)
  const crowd = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.35, 0.9, 2, 8), lamb(0x5876b1), CROWD_SLOTS.length)
  root.add(crowd)
  const pool = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number) => {
    const m = new THREE.InstancedMesh(geo, mat, n)
    m.frustumCulled = false
    root.add(m)
    return m
  }
  const people = pool(new THREE.CapsuleGeometry(0.35, 1.0, 2, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }), 64)
  const flasks = pool(new THREE.SphereGeometry(0.3, 8, 6), basic(0x49b3e4), 256)
  const coins = pool(new THREE.CylinderGeometry(0.27, 0.27, 0.09, 10), lamb(0xd98c47), 400)
  const bubbles: THREE.Mesh[] = []
  const bubbleGeo = new THREE.SphereGeometry(1, 20, 14)
  const bubbleMat = new THREE.MeshPhongMaterial({ color: 0x16bdc8, shininess: 90 })
  const player = new THREE.Group()
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.9, 12), lamb(0x403c43))
  body.position.y = 0.95
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.5), lamb(0xfbf3f5))
  nose.position.set(0, 1.6, 0.3)
  player.add(body, nose)
  root.add(player)
  const blades = [0, 1].map(() => {
    const line = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * 3), 3)), new THREE.LineBasicMaterial({ color: 0xe08447 }))
    line.frustumCulled = false
    root.add(line)
    const wall = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ color: 0xe08447, side: THREE.DoubleSide }))
    wall.frustumCulled = false
    root.add(wall)
    return { line, wall }
  })
  const drill = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.4, 10), lamb(0x828387))
  drill.geometry.rotateX(Math.PI / 2)
  root.add(drill)
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.9, 4), basic(0x5aff2e))
  arrow.rotation.x = Math.PI
  root.add(arrow)

  const o = new THREE.Object3D()
  const col = new THREE.Color()
  const poly = new Float32Array(18)
  const put = (m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, s = 1, ry = 0) => {
    o.position.set(x, y, z)
    o.rotation.set(0, ry, 0)
    o.scale.setScalar(s)
    o.updateMatrix()
    m.setMatrixAt(i, o.matrix)
  }
  CROWD_SLOTS.forEach((c, i) => put(crowd, i, c.x, 0.8, c.z))

  return {
    update(s, _dt, time) {
      const b = s.balls
      const arr = balls.instanceMatrix.array as Float32Array
      const r = P.BALL_DIAMETER / 2
      for (let i = 0; i < b.n; i++) {
        const k = i * 16
        const sc = b.state[i] === BALL_FALL ? 0.8 : 1
        arr[k] = sc; arr[k + 5] = sc; arr[k + 10] = sc; arr[k + 15] = 1
        arr[k + 12] = b.x[i]!; arr[k + 13] = b.y[i]! + r; arr[k + 14] = b.z[i]!
      }
      balls.instanceMatrix.needsUpdate = true
      while (bubbles.length < s.bubbles.length) {
        const m = new THREE.Mesh(bubbleGeo, bubbleMat)
        root.add(m)
        bubbles.push(m)
      }
      bubbles.forEach((m, i) => {
        const bb = s.bubbles[i]
        m.visible = !!bb
        if (bb) (m.position.set(bb.x, bb.r, bb.z), m.scale.setScalar(bb.r))
      })
      const p = s.player
      player.position.set(p.x, p.mode === 'cart' ? 0.6 : 0, p.z)
      player.rotation.y = p.heading
      s.tools.forEach((t, i) => {
        const bl = blades[i]
        if (!bl) return
        bl.line.visible = bl.wall.visible = t.exists
        if (!t.exists) return
        bladeWorld(t, poly)
        const pos: number[] = []
        const idx: number[] = []
        const h = t.kind === 'cart' ? P.CART_HEIGHT : P.SCOOP_HEIGHT
        for (let k = 0; k < 9; k++) {
          pos.push(poly[k * 2]!, 0, poly[k * 2 + 1]!, poly[k * 2]!, h, poly[k * 2 + 1]!)
          if (k < 8) idx.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 1, k * 2 + 3, k * 2 + 2)
        }
        bl.wall.geometry.dispose()
        bl.wall.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)).setIndex(idx)
        bl.wall.geometry.computeVertexNormals()
      })
      crowd.count = s.crowd.remaining
      // remaining villagers occupy the LAST `remaining` slots
      let ci = 0
      for (let i = CROWD_SLOTS.length - s.crowd.remaining; i < CROWD_SLOTS.length; i++) put(crowd, ci++, CROWD_SLOTS[i]!.x, 0.8, CROWD_SLOTS[i]!.z)
      crowd.instanceMatrix.needsUpdate = true
      let n = 0
      const person = (x: number, y: number, z: number, c: number, sc = 1) => {
        if (n >= 64) return
        put(people, n, x, y + 0.85 * sc, z, sc)
        people.setColorAt(n, col.setHex(c))
        n++
      }
      for (const v of s.villagers) {
        const lying = v.state === 'inBed' || v.state === 'lieDown'
        person(v.x, v.y + (lying ? -0.3 : 0), v.z, v.look === 'sick' ? 0xa4aa5e : v.look === 'bathed' ? 0xf65c69 : 0xe8e4e0, lying ? 0.6 : 1)
      }
      for (const nu of s.nurses) person(nu.x, 0, nu.z, 0xa33e4e, 0.9)
      if (s.usher.present) person(s.usher.x, 0, s.usher.z, 0xca9399, 0.9)
      if (s.porter.present) person(s.porter.x, 0, s.porter.z, 0x49b3e4, 0.9)
      if (s.driver.present) person(s.driver.x, 0.6, s.driver.z, 0x86593a, 0.9)
      people.count = n
      people.instanceMatrix.needsUpdate = true
      if (people.instanceColor) people.instanceColor.needsUpdate = true
      let f = 0
      for (const g of s.groundFlasks) if (f < 256) put(flasks, f++, g.x, 0.3, g.z)
      for (let i = 0; i < p.flasks && f < 256; i++) put(flasks, f++, p.x - Math.sin(p.heading) * 0.45, 0.6 + i * P.FLASK_STACK_PITCH, p.z - Math.cos(p.heading) * 0.45)
      for (let i = 0; i < s.porter.flasks && f < 256; i++) put(flasks, f++, s.porter.x, 2 + i * P.FLASK_STACK_PITCH, s.porter.z)
      flasks.count = f
      flasks.instanceMatrix.needsUpdate = true
      let c = 0
      const stackN = Math.min(200, Math.ceil(s.pallet.gold / P.GOLD_PER_COIN_MESH))
      for (let i = 0; i < stackN; i++) put(coins, c++, L.PALLET.x + ((i % 2) - 0.5) * 0.62, 0.2 + Math.floor(i / 4) * P.COIN_THICKNESS, L.PALLET.z + ((Math.floor(i / 2) % 2) - 0.5) * 0.62)
      const col2 = Math.min(P.BACK_COLUMN_MAX_DISCS, Math.ceil(p.carriedGold / 2))
      for (let i = 0; i < col2 && c < 400; i++) put(coins, c++, p.x - Math.sin(p.heading) * 0.75, 0.3 + i * P.COIN_THICKNESS, p.z - Math.cos(p.heading) * 0.75)
      coins.count = c
      coins.instanceMatrix.needsUpdate = true
      liquid.visible = s.cauldron.potion > 0
      liquid.position.y = 0.6 + (s.cauldron.potion / s.cauldron.capacity) * 1.0
      s.beds.forEach((bd, i) => {
        beds[i]!.visible = bd.exists
        ;(beds[i]!.material as THREE.MeshLambertMaterial).color.setHex(bd.state === 'free' ? 0xa8686f : bd.state === 'reserved' ? 0xc7a05a : bd.treatT >= 0 ? 0x58fb6c : 0xf65c69)
      })
      yard.visible = true
      pallet.visible = true
      s.pads.forEach((pd, i) => {
        pads[i]!.visible = pd.state !== 'hidden' && pd.state !== 'gone'
        ;(pads[i]!.material as THREE.MeshBasicMaterial).color.setHex(pd.state === 'paying' ? 0x24ee34 : 0xffffff)
      })
      drill.position.set(s.drill.x, 0.7, s.drill.z)
      drill.rotation.y = s.drill.heading
      arrow.visible = s.guide.kind !== 'none'
      arrow.position.set(s.guide.x, s.guide.y + Math.sin(time * 7) * 0.3, s.guide.z)
      ctx.stage.lantern.position.set(p.x, 2.2, p.z)
    },
  }
}
