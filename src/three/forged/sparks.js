import * as THREE from 'three'
import { SPARK_FRAG, SPARK_VERT } from './shaders'

export const UNITS_PER_M = 2 // 1 world unit = 0.5 m (the letters' cap height)
const GRAVITY = -9.81 * UNITS_PER_M

/**
 * Steel sparks and forge embers. A spark is a hot fleck of steel: it leaves fast, slows hard in the air (drag),
 * falls under gravity, skids once off the floor plate, and near the end of its life may burst into a few short
 * branches (the carbon in the steel flashing), which is what makes steel sparks fork. Embers are slow, soft
 * glows riding the warm air.
 * All state lives in typed arrays; emitting reuses the oldest slot, so nothing is allocated per particle.
 * Indices [0, embers) are embers, the rest are sparks.
 */
export class SparkField {
  constructor(sparks, embers) {
    const cap = sparks + embers
    this.cap = cap
    this.embers = embers
    this.cursor = embers
    this.p = new Float32Array(cap * 3)
    this.v = new Float32Array(cap * 3)
    this.age = new Float32Array(cap)
    this.life = new Float32Array(cap).fill(1)
    this.heat = new Float32Array(cap)
    this.size = new Float32Array(cap)
    this.drag = new Float32Array(cap)
    this.grav = new Float32Array(cap)
    this.fork = new Float32Array(cap)
    this.forkAt = new Float32Array(cap)
    this.bounced = new Uint8Array(cap)
    this.alive = new Uint8Array(cap)
    this.seed = new Float32Array(cap)
    for (let i = 0; i < cap; i++) this.seed[i] = Math.random() * 100

    const geo = new THREE.InstancedBufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3))
    geo.setIndex([0, 2, 1, 2, 3, 1])
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage)
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage)
    this.aInfo = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aPos', this.aPos)
    geo.setAttribute('aVel', this.aVel)
    geo.setAttribute('aInfo', this.aInfo)
    geo.instanceCount = cap
    this.geometry = geo
    this.material = new THREE.ShaderMaterial({
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      uniforms: {
        uShutter: { value: 1 / 60 },
        uAspect: { value: 1 },
        uGain: { value: 1 },
        uSize: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      // additive light; the alpha channel (the floor reflection's height) is left as it is
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      // the quad's winding follows the streak direction, so it must never be back-face culled
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 3
    this.bounds = { x: 4, y0: -0.6, y1: 0.4, z0: -3.5, z1: 0.8 }
  }

  /** Embers are spread through a volume around the word. */
  setEmberVolume(halfWidth, floorY) {
    this.bounds.x = halfWidth
    this.bounds.y0 = floorY
    this.bounds.y1 = floorY + 1.1
    for (let i = 0; i < this.embers; i++) this.respawnEmber(i, true)
  }

  respawnEmber(i, scatter) {
    const b = this.bounds
    const k = i * 3
    this.p[k] = (Math.random() * 2 - 1) * b.x
    this.p[k + 1] = b.y0 + Math.random() * (scatter ? 2.4 : b.y1 - b.y0)
    this.p[k + 2] = b.z0 + Math.random() * (b.z1 - b.z0)
    this.v[k] = (Math.random() - 0.5) * 0.06
    this.v[k + 1] = 0.18 + Math.random() * 0.22
    this.v[k + 2] = (Math.random() - 0.5) * 0.04
    this.life[i] = 5 + Math.random() * 5
    this.age[i] = scatter ? Math.random() * 0.9 : 0
    this.heat[i] = 0.34 + Math.random() * 0.3
    this.size[i] = 0.006 + Math.random() * 0.008
    this.alive[i] = 1
  }

  /**
   * One spark at (x,y,z) with velocity (vx,vy,vz) in units/s. drag in 1/s; fork = chance (0..1) that it bursts
   * into branches near the end of its life. Overwrites the oldest slot when the pool is full.
   */
  emit(x, y, z, vx, vy, vz, life, heat, size, drag = 3, grav = 1, fork = 0.25) {
    const span = this.cap - this.embers
    if (span <= 0) return
    const i = this.cursor
    this.cursor = this.embers + ((this.cursor - this.embers + 1) % span)
    const k = i * 3
    this.p[k] = x
    this.p[k + 1] = y
    this.p[k + 2] = z
    this.v[k] = vx
    this.v[k + 1] = vy
    this.v[k + 2] = vz
    this.life[i] = life
    this.age[i] = 0
    this.heat[i] = heat
    this.size[i] = size
    this.drag[i] = drag
    this.grav[i] = grav
    this.fork[i] = fork
    this.forkAt[i] = 0.5 + Math.random() * 0.35
    this.bounced[i] = 0
    this.alive[i] = 1
  }

  /** Spray of `n` sparks from a point around direction (dx,dy,dz) with cone `spread` (0 = tight, 1 = hemisphere). */
  burst(n, x, y, z, dx, dy, dz, spread, speedMin, speedMax, heatMin, heatMax, lifeMin = 0.25, lifeMax = 0.7, fork = 0.3) {
    for (let j = 0; j < n; j++) {
      let rx = Math.random() * 2 - 1
      let ry = Math.random() * 2 - 1
      let rz = Math.random() * 2 - 1
      const rl = Math.hypot(rx, ry, rz) || 1
      rx /= rl
      ry /= rl
      rz /= rl
      let ux = dx + rx * spread
      let uy = dy + ry * spread + 0.15
      let uz = dz + rz * spread
      const ul = Math.hypot(ux, uy, uz) || 1
      // a few very fast long streaks, most medium
      const sp = speedMin + (speedMax - speedMin) * Math.pow(Math.random(), 1.7)
      ux = (ux / ul) * sp
      uy = (uy / ul) * sp
      uz = (uz / ul) * sp
      this.emit(
        x,
        y,
        z,
        ux,
        uy,
        uz,
        lifeMin + Math.random() * (lifeMax - lifeMin),
        heatMin + Math.random() * (heatMax - heatMin),
        0.0055 + Math.random() * 0.0075,
        2.4 + Math.random() * 2.2,
        1,
        fork,
      )
    }
  }

  // the carbon burst: a spark ends in two to four short, bright branches
  forkSpark(i) {
    const k = i * 3
    const n = 2 + Math.floor(Math.random() * 3)
    const vx = this.v[k]
    const vy = this.v[k + 1]
    const vz = this.v[k + 2]
    for (let j = 0; j < n; j++) {
      const a = Math.random() * Math.PI * 2
      const b = Math.random() * 2 - 1
      const s = 2.5 + Math.random() * 4
      const c = Math.sqrt(1 - b * b)
      this.emit(
        this.p[k],
        this.p[k + 1],
        this.p[k + 2],
        vx * 0.4 + Math.cos(a) * c * s,
        vy * 0.4 + b * s,
        vz * 0.4 + Math.sin(a) * c * s,
        0.05 + Math.random() * 0.1,
        Math.min(1, this.heat[i] * (1 - this.age[i] * 0.4) + 0.25),
        this.size[i] * 0.7,
        4,
        0.6,
        0,
      )
    }
  }

  update(dt, floorY, time, still) {
    const { p, v, age, life, alive, size, heat, aPos, aVel, aInfo, embers } = this
    const pa = aPos.array
    const va = aVel.array
    const ia = aInfo.array
    for (let i = 0; i < this.cap; i++) {
      const k = i * 3
      const q = i * 4
      if (!alive[i]) {
        if (ia[q + 1] !== 0) ia[q + 1] = 0
        continue
      }
      if (i < embers) {
        if (!still) {
          age[i] += dt / life[i]
          if (age[i] >= 1) this.respawnEmber(i, false)
          const s = this.seed[i]
          // riding the warm air: buoyancy fades as the ember cools, the air sways it slowly
          const lift = 0.12 * (1 - age[i])
          v[k] += (Math.sin(time * 0.53 + s) * 0.05 + Math.sin(time * 0.31 + s * 2.1) * 0.03 - v[k] * 0.6) * dt
          v[k + 1] += (lift - v[k + 1] * 0.25) * dt
          v[k + 2] += (Math.cos(time * 0.41 + s * 1.3) * 0.03 - v[k + 2] * 0.6) * dt
          p[k] += v[k] * dt
          p[k + 1] += v[k + 1] * dt
          p[k + 2] += v[k + 2] * dt
        }
        pa[k] = p[k]
        pa[k + 1] = p[k + 1]
        pa[k + 2] = p[k + 2]
        va[k] = 0
        va[k + 1] = 0
        va[k + 2] = 0
        ia[q] = age[i]
        ia[q + 1] = size[i]
        ia[q + 2] = heat[i] * (0.86 + 0.14 * Math.sin(time * 5.3 + this.seed[i]) * Math.sin(time * 2.9 + this.seed[i] * 0.7))
        ia[q + 3] = 1
        continue
      }
      age[i] += dt / life[i]
      if (this.fork[i] > 0 && age[i] >= this.forkAt[i]) {
        const f = this.fork[i]
        this.fork[i] = 0
        if (Math.random() < f) {
          this.forkSpark(i)
          age[i] = 1
        }
      }
      if (age[i] >= 1) {
        alive[i] = 0
        ia[q + 1] = 0
        continue
      }
      const damp = Math.exp(-this.drag[i] * dt)
      v[k] *= damp
      v[k + 1] = v[k + 1] * damp + GRAVITY * this.grav[i] * dt
      v[k + 2] *= damp
      p[k] += v[k] * dt
      p[k + 1] += v[k + 1] * dt
      p[k + 2] += v[k + 2] * dt
      if (p[k + 1] < floorY && v[k + 1] < 0) {
        if (!this.bounced[i]) {
          // one skid off the plate: most of the vertical energy goes, some of the run
          this.bounced[i] = 1
          p[k + 1] = floorY + (floorY - p[k + 1]) * 0.35
          v[k + 1] = -v[k + 1] * 0.35
          v[k] *= 0.7
          v[k + 2] *= 0.7
          heat[i] *= 0.9
        } else {
          alive[i] = 0
          ia[q + 1] = 0
          continue
        }
      }
      pa[k] = p[k]
      pa[k + 1] = p[k + 1]
      pa[k + 2] = p[k + 2]
      va[k] = v[k]
      va[k + 1] = v[k + 1]
      va[k + 2] = v[k + 2]
      ia[q] = age[i]
      ia[q + 1] = size[i]
      ia[q + 2] = heat[i]
      ia[q + 3] = 0
    }
    aPos.needsUpdate = true
    aVel.needsUpdate = true
    aInfo.needsUpdate = true
  }

  /** Kill every spark (embers stay). */
  clear() {
    for (let i = this.embers; i < this.cap; i++) this.alive[i] = 0
  }

  hideEmbers() {
    for (let i = 0; i < this.embers; i++) this.alive[i] = 0
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}
