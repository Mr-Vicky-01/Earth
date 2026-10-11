import * as THREE from 'three'
import { SPARK_FRAG, SPARK_VERT } from './shaders'

const GRAVITY = -9.2

/**
 * Pooled sparks (stretched streaks: gravity, drag, one bounce off the floor) and embers (slow, rising dots).
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
        uStretch: { value: 0.034 },
        uAspect: { value: 1 },
        uGain: { value: 1 },
        uSize: { value: 1 },
        uMirror: { value: 0 },
        uFloor: { value: -0.5 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // the quad's winding follows the streak direction, so it must never be back-face culled
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 3
    // the same particles mirrored under the black floor plate (drawn before the plate's depth pass)
    this.mirrorMaterial = this.material.clone()
    this.mirrorMaterial.uniforms.uMirror.value = 1
    this.mirrorMaterial.uniforms.uStretch = this.material.uniforms.uStretch
    this.mirrorMaterial.uniforms.uAspect = this.material.uniforms.uAspect
    this.mirrorMaterial.uniforms.uSize = this.material.uniforms.uSize
    this.mirrorMaterial.transparent = false
    this.mirror = new THREE.Mesh(geo, this.mirrorMaterial)
    this.mirror.frustumCulled = false
    this.mirror.renderOrder = -5.5
    this.mirror.matrixAutoUpdate = false
    this.bounds = { x: 4, y0: -0.6, y1: 0.4, z0: -3.5, z1: 0.8 }
  }

  /** Mirror the particles about the floor plane y = floorY. */
  setFloor(floorY) {
    this.mirrorMaterial.uniforms.uFloor.value = floorY
    this.mirror.matrix.makeScale(1, -1, 1).setPosition(0, 2 * floorY, 0)
    this.mirror.matrixWorldNeedsUpdate = true
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
    this.p[k + 1] = b.y0 + Math.random() * (scatter ? 2.2 : b.y1 - b.y0)
    this.p[k + 2] = b.z0 + Math.random() * (b.z1 - b.z0)
    this.v[k] = (Math.random() - 0.5) * 0.08
    this.v[k + 1] = 0.16 + Math.random() * 0.24
    this.v[k + 2] = (Math.random() - 0.5) * 0.05
    this.life[i] = 4.5 + Math.random() * 4.5
    this.age[i] = scatter ? Math.random() : 0
    this.heat[i] = 0.36 + Math.random() * 0.3
    this.size[i] = 0.007 + Math.random() * 0.009
    this.alive[i] = 1
  }

  /** One spark. Overwrites the oldest slot when the pool is full. */
  emit(x, y, z, vx, vy, vz, life, heat, size, drag = 1.1, grav = 1) {
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
    this.bounced[i] = 0
    this.alive[i] = 1
  }

  /** Spray of `n` sparks from a point around direction (dx,dy,dz) with cone `spread` (0 = tight, 1 = hemisphere). */
  burst(n, x, y, z, dx, dy, dz, spread, speedMin, speedMax, heatMin, heatMax, lifeMin = 0.45, lifeMax = 1.15) {
    for (let j = 0; j < n; j++) {
      // random unit vector
      let rx = Math.random() * 2 - 1
      let ry = Math.random() * 2 - 1
      let rz = Math.random() * 2 - 1
      const rl = Math.hypot(rx, ry, rz) || 1
      rx /= rl
      ry /= rl
      rz /= rl
      let ux = dx + rx * spread
      let uy = dy + ry * spread + 0.22
      let uz = dz + rz * spread
      const ul = Math.hypot(ux, uy, uz) || 1
      // a few very fast long streaks, most medium
      const sp = speedMin + (speedMax - speedMin) * Math.pow(Math.random(), 1.8)
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
        0.0075 + Math.random() * 0.0095,
        0.9 + Math.random() * 0.9,
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
          // lazy sway in the rising air
          v[k] += Math.sin(time * 0.9 + s) * 0.05 * dt
          v[k + 2] += Math.cos(time * 0.7 + s * 1.3) * 0.03 * dt
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
        ia[q + 2] = heat[i] * (0.85 + 0.15 * Math.sin(time * 6 + this.seed[i]))
        ia[q + 3] = 1
        continue
      }
      age[i] += dt / life[i]
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
          // one skip off the floor, losing most of the energy
          this.bounced[i] = 1
          p[k + 1] = floorY + (floorY - p[k + 1]) * 0.3
          v[k + 1] = -v[k + 1] * 0.3
          v[k] *= 0.62
          v[k + 2] *= 0.62
          age[i] = Math.min(0.99, age[i] + 0.12)
          heat[i] *= 0.85
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
    this.mirrorMaterial.dispose()
  }
}
