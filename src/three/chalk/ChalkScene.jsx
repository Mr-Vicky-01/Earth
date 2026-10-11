import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import { scroll } from '../../lib/scroll'
import { BLOCK, LAYOUTS } from './layout'
import { rng, sampleBlockAsync, sampleHeadlineAsync } from './targets'
import { canSimulate, createSim } from './sim'
import { BG_FRAG, BG_VERT, GRAIN_FRAG, GRAIN_VERT, MOTE_FRAG, MOTE_VERT, SPARK_FRAG, SPARK_VERT } from './shaders'

const ChalkFallback = lazy(() => import('./ChalkFallback.jsx').then((m) => ({ default: m.ChalkFallback })))

const FOV = 30
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const lerp = (a, b, t) => a + (b - a) * t
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt))
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/* The opening slam, in simulation seconds -------------------------------------------------------------- */
const T_IMPACT = 0.3 // the chalk block hits the floor
const T_YANK = 0.47 // the cloud is yanked into the letters
const T_LOCK = 0.95 // letters legible: the HTML copy is pulled in
const T_SETTLE = 1.35
const T_END = 2.1
const K_YANK = 210
const K_IDLE = 38
const SLAM_MS = 6.4 // the block's speed at impact, shown on the air readout (m/s)
// the burst cloud decelerates hard: it billows out and hangs. With drag c a lump launched at reach * c comes to
// rest at its reach (70 % of the way there 0.17 s after impact)
const PUFF_DRAG = 7

/* ------------------------------------------------------------------ */
/* Background                                                          */
/* ------------------------------------------------------------------ */
function Background({ state }) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
    return g
  }, [])
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: BG_VERT,
        fragmentShader: BG_FRAG,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          uRes: { value: new THREE.Vector2(1, 1) },
          uTime: { value: 0 },
          uFlash: { value: 0 },
          uFlashUv: { value: new THREE.Vector2(0.5, 0.5) },
          uFlashK: { value: new THREE.Vector2(1, 1) },
          uGrain: { value: 0.022 },
        },
      }),
    [],
  )
  useEffect(() => {
    state.bg = mat.uniforms
    return () => {
      state.bg = null
      geo.dispose()
      mat.dispose()
    }
  }, [geo, mat, state])
  return <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={-10} />
}

/* ------------------------------------------------------------------ */
/* Sparks: hot streaks off the slam and the claps (4 event slots)      */
/* ------------------------------------------------------------------ */
function Sparks({ state, lite }) {
  const per = lite ? 64 : 120
  const geo = useMemo(() => {
    const g = new THREE.InstancedBufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0]), 3))
    g.setIndex([0, 1, 2, 2, 1, 3])
    const n = per * 4
    const r = rng(9)
    const seeds = new Float32Array(n * 4)
    const slots = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 4; k++) seeds[i * 4 + k] = r()
      slots[i] = Math.floor(i / per)
    }
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4))
    g.setAttribute('aSlot', new THREE.InstancedBufferAttribute(slots, 1))
    g.instanceCount = n
    return g
  }, [per])
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: SPARK_VERT,
        fragmentShader: SPARK_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uEv: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 0, -100)) },
          uEvP: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, -1e3, 1)) },
          uRes: { value: new THREE.Vector2(1, 1) },
          uWidth: { value: 1.6 },
        },
      }),
    [],
  )
  useEffect(() => {
    let slot = 0
    state.sparks = {
      u: mat.uniforms,
      emit(x, y, z, time, strength, up, floorY, share) {
        mat.uniforms.uEv.value[slot].set(x, y, z, time)
        mat.uniforms.uEvP.value[slot].set(strength, up, floorY, share)
        slot = (slot + 1) % 4
      },
    }
    return () => {
      state.sparks = null
      geo.dispose()
      mat.dispose()
    }
  }, [geo, mat, state])
  return <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={4} />
}

/* ------------------------------------------------------------------ */
/* Dust: GPGPU sim + grains + powder body/haze + motes + camera         */
/* ------------------------------------------------------------------ */
function Dust({ motion, reduced, lite, variant, state, onLock, onFrame, onLive }) {
  const { gl, invalidate } = useThree()
  const size = lite ? 224 : 384
  const count = size * size
  const hazeStep = lite ? 9 : 13
  const moteCount = lite ? 18 : 36
  // CPU data: grain targets in the letters and on the chalk block, sampled in small slices so the main thread
  // (and the preloader pulling away) never stalls
  const [data, setData] = useState(null)
  useEffect(() => {
    const ac = new AbortController()
    ;(async () => {
      const head = await sampleHeadlineAsync(count, lite ? 100 : 150, 11, variant, ac.signal)
      if (!head) return
      const block = await sampleBlockAsync(count, T_IMPACT, 5, ac.signal)
      if (!block) return
      setData({ ...head, block, variant })
    })()
    return () => ac.abort()
  }, [count, lite, variant])
  // frame the layout the grains were sampled for (a new one takes over once its targets are ready)
  const layout = LAYOUTS[data?.variant || variant] || LAYOUTS.wide

  const geos = useMemo(() => {
    const refs = new Float32Array(count * 2)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 2
        refs[i] = (x + 0.5) / size
        refs[i + 1] = (y + 0.5) / size
      }
    }
    // one set of grains, drawn in two calls: the walls of the letters, then (over the powder body) their face
    const refAttr = new THREE.BufferAttribute(refs, 2)
    const posAttr = new THREE.BufferAttribute(new Float32Array(count * 3), 3)
    const walls = new THREE.BufferGeometry()
    walls.setAttribute('position', posAttr)
    walls.setAttribute('aRef', refAttr)
    const face = new THREE.BufferGeometry()
    face.setAttribute('position', posAttr)
    face.setAttribute('aRef', refAttr)
    walls.setDrawRange(0, 0)
    const hazeN = Math.floor(count / hazeStep)
    const hrefs = new Float32Array(hazeN * 2)
    for (let i = 0; i < hazeN; i++) {
      hrefs[i * 2] = refs[i * hazeStep * 2]
      hrefs[i * 2 + 1] = refs[i * hazeStep * 2 + 1]
    }
    const haze = new THREE.BufferGeometry()
    haze.setAttribute('position', new THREE.BufferAttribute(new Float32Array(hazeN * 3), 3))
    haze.setAttribute('aRef', new THREE.BufferAttribute(hrefs, 2))
    const r = rng(3)
    const seeds = new Float32Array(moteCount * 4)
    for (let i = 0; i < seeds.length; i++) seeds[i] = r()
    const motes = new THREE.BufferGeometry()
    motes.setAttribute('position', new THREE.BufferAttribute(new Float32Array(moteCount * 3), 3))
    motes.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4))
    return { walls, face, haze, motes }
  }, [count, size, hazeStep, moteCount])

  const mats = useMemo(() => {
    const grainUniforms = () => ({
      tPos: { value: null },
      tTarget: { value: null },
      tInfo: { value: null },
      tBlock: { value: null },
      uSize: { value: 1.5 },
      uHazeSize: { value: 12 },
      uDist: { value: 8 },
      uTime: { value: 0 },
      uAlpha: { value: 0 },
      uShed: { value: 0 },
      uWind: { value: 0 },
      uWindBox: { value: new THREE.Vector2(-3.4, 6.8) },
      uHaze: { value: 0 },
      uMaxSize: { value: 40 },
      uIntro: { value: 1e3 },
      uImpact: { value: T_IMPACT },
      uBlockR: { value: new THREE.Matrix3() },
      uBlockH: { value: new THREE.Vector3(BLOCK.hx, BLOCK.hy, BLOCK.hz) },
      uBlockRad: { value: BLOCK.r },
      uCloudC: { value: new THREE.Vector3() },
      uCloudR: { value: 2 },
      uCloudOn: { value: 0 },
    })
    const mk = (haze) => {
      const u = grainUniforms()
      u.uHaze.value = haze ? 1 : 0
      return new THREE.ShaderMaterial({
        vertexShader: GRAIN_VERT,
        fragmentShader: GRAIN_FRAG,
        uniforms: u,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
    }
    const motes = new THREE.ShaderMaterial({
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: 4 },
        uDist: { value: 8 },
        uBox: { value: new THREE.Vector3(4, 3, 2.5) },
        uCentre: { value: new THREE.Vector3() },
        uWind: { value: 0 },
        uAlpha: { value: 0 },
        uBeamO: { value: new THREE.Vector2(-4, 3) },
        uBeamD: { value: new THREE.Vector2(0.82, -0.57) },
      },
    })
    return { grains: mk(false), haze: mk(true), motes }
  }, [])

  useEffect(
    () => () => {
      Object.values(geos).forEach((g) => g.dispose())
      Object.values(mats).forEach((m) => m.dispose())
    },
    [geos, mats],
  )

  // GPU sim: created in an effect so StrictMode's mount → unmount → mount builds and frees it cleanly
  const simRef = useRef(null)
  useEffect(() => {
    if (!data || data.target.length !== count * 4) return
    // every grain starts on its letter (reduced motion shows that at once), at rest: w is the agitation
    const start = Float32Array.from(data.target)
    for (let i = 3; i < start.length; i += 4) start[i] = 0
    const sim = createSim(gl, size, { ...data, start })
    simRef.current = sim
    for (const m of [mats.grains, mats.haze]) {
      m.uniforms.tTarget.value = sim.tTarget
      m.uniforms.tInfo.value = sim.tInfo
      m.uniforms.tBlock.value = sim.tBlock
    }
    geos.walls.setDrawRange(0, data.nWall)
    geos.face.setDrawRange(data.nWall, count - data.nWall)
    invalidate()
    return () => {
      simRef.current = null
      sim.dispose()
    }
  }, [gl, size, count, data, mats, geos, invalidate])

  useEffect(() => {
    motion.invalidate = invalidate
    return () => {
      if (motion.invalidate === invalidate) motion.invalidate = null
    }
  }, [motion, invalidate])

  const st = useRef(null)
  if (!st.current) {
    st.current = {
      phase: reduced ? 'live' : 'wait',
      t: 0,
      time: 0,
      dtPrev: 1 / 60,
      hit: false,
      locked: false,
      flash: 0,
      kick: 0,
      blow: 0,
      shed: 0,
      breath: 0,
      alpha: reduced ? 1 : 0,
      cloud: 0,
      lean: new THREE.Vector2(),
      pv: new THREE.Vector3(),
      ptrWorld: new THREE.Vector3(0, 0, 100),
      lastPtrT: -1,
      calm: 0,
      ray: new THREE.Raycaster(),
      ndc: new THREE.Vector2(),
      hitP: new THREE.Vector3(),
      euler: new THREE.Euler(),
      m4: new THREE.Matrix4(),
      R: new THREE.Matrix3(),
      C: new THREE.Vector3(),
      Cprev: new THREE.Vector3(),
      V: new THREE.Vector3(),
      corner: new THREE.Vector3(),
      impactP: new THREE.Vector3(),
      cloudC: new THREE.Vector3(),
      frames: 0,
    }
  }

  // world point on the letter plane under a canvas pixel
  const toPlane = (S, camera, px, py, W, H, out) => {
    S.ndc.set((px / W) * 2 - 1, -(py / H) * 2 + 1)
    S.ray.setFromCamera(S.ndc, camera)
    const o = S.ray.ray.origin
    const d = S.ray.ray.direction
    const t = Math.abs(d.z) > 1e-5 ? -o.z / d.z : 0
    return out.set(o.x + d.x * t, o.y + d.y * t, 0)
  }

  /** Pose of the chalk block at intro time t: rotation S.R, centre S.C (its lowest corner meets the floor at impact). */
  const poseBlock = (S, t, x0, y0, xI, floorY) => {
    const u = clamp(t / T_IMPACT, 0, 1)
    // a third of a turn on the way down, landing on a corner
    S.euler.set(lerp(1.0, 0.36, u), lerp(-1.3, -0.52, u), lerp(0.62, -0.16, u))
    S.m4.makeRotationFromEuler(S.euler)
    S.R.setFromMatrix4(S.m4)
    // how far the lowest point of the rotated block sits below its centre
    let ext = 0
    const a = BLOCK.hx - BLOCK.r
    const b = BLOCK.hy - BLOCK.r
    const c = BLOCK.hz - BLOCK.r
    for (let i = 0; i < 8; i++) {
      S.corner.set(i & 1 ? a : -a, i & 2 ? b : -b, i & 4 ? c : -c).applyMatrix3(S.R)
      if (-S.corner.y > ext) {
        ext = -S.corner.y
        S.impactP.copy(S.corner)
      }
    }
    ext += BLOCK.r
    // thrown in from the upper left: steady across, accelerating down (a slam, not a float)
    const e = Math.pow(u, 1.75)
    S.C.set(lerp(x0, xI, u), lerp(y0 + ext, floorY + ext, e), lerp(1.1, 0.3, u))
    S.impactP.add(S.C)
    S.impactP.y -= BLOCK.r
  }

  const tick = (three, delta) => {
    const sim = simRef.current
    if (!sim) return
    const S = st.current
    const m = motion
    const { camera, size: sz } = three
    const W = sz.width
    const H = sz.height
    const dt = import.meta.env.DEV && m.dbgDt ? m.dbgDt : clamp(delta, 1 / 240, 1 / 20)
    const U = sim.uniforms
    const dpr = gl.getPixelRatio()

    /* ---------- framing: the headline block lands exactly on the HTML layout box ---------- */
    const box = m.box
    const bw = box && box.w > 10 ? box.w : Math.min(W * 0.86, 1240)
    const capPx = bw / layout.W
    const cx = box && box.w > 10 ? box.x + box.w / 2 : W / 2
    const cy = box && box.w > 10 ? box.y + box.h / 2 : H * 0.45
    const halfTan = Math.tan(THREE.MathUtils.degToRad(FOV / 2))
    const D = H / capPx / 2 / halfTan
    const viewW = W / capPx
    const viewH = H / capPx
    const portrait = W / H < 0.9
    const floorY = -layout.H / 2 - 0.1
    // soft walls for the dust: inside the stage (between the tag row and the copy) and the screen sides
    const stage = m.stage
    // (the sim's cushion starts 0.45 inside a wall, so a wall never sits closer than that to the letters)
    const bTop = Math.max(stage ? (cy - stage.y) / capPx + 0.05 : 0, layout.H / 2 + 0.6)
    const bBot = Math.min(stage ? (cy - (stage.y + stage.h)) / capPx - 0.05 : 0, -layout.H / 2 - 0.6)
    const bSide = Math.max((W / 2 - 14) / capPx, layout.W / 2 + 0.6)

    /* ---------- the opening slam ---------- */
    if (S.phase === 'wait' && m.go) {
      S.phase = 'intro'
      S.t = 0
    }
    const intro = S.phase === 'wait' || S.phase === 'intro'
    let K = K_IDLE
    let zeta = 0.82
    let drag = 1.1
    let dragHold = 0
    let turb = reduced ? 0 : 0.07
    let billow = 0
    let yank = 100
    let agitDecay = 0.8
    let agitSoft = 0.9
    let agitTurb = 3
    let floor = -1e3
    let introT = 1e3
    let dolly = 1
    let slam = 0
    // the block's bottom starts just inside the top of the frame, so it is on screen from the first frame
    const persp = (D * 1.045 - 1.1) / (D * 1.045)
    const x0 = -Math.min(viewW * 0.2, 2.2) * persp
    const y0 = (cy / capPx) * persp - 0.3
    const xI = -0.25
    if (intro) {
      const t = S.t
      introT = S.phase === 'wait' ? -1 : t
      S.Cprev.copy(S.C)
      poseBlock(S, Math.max(t, 0), x0, y0, xI, floorY)
      if (S.phase === 'wait') S.Cprev.copy(S.C)
      S.V.subVectors(S.C, S.Cprev).divideScalar(dt)
      if (S.phase === 'wait') {
        S.alpha = 0
      } else {
        S.alpha = smooth(0, 0.04, t)
        if (t >= T_IMPACT && !S.hit) {
          S.hit = true
          slam = 1
          S.flash = 1
          S.kick = 1
          S.cloudC.copy(S.impactP)
          m.air = Math.max(m.air || 0, SLAM_MS)
          if (state.bg) {
            const ip = S.impactP
            state.bg.uFlashUv.value.set((cx + ip.x * capPx) / W, 1 - (cy - ip.y * capPx) / H)
            state.bg.uFlashK.value.set(0.55, 1.5)
          }
          state.sparks?.emit(S.impactP.x, S.impactP.y + 0.05, S.impactP.z, S.time, 1, 1, floorY, 1)
        }
        if (t < T_IMPACT) {
          // powder shed during the throw just hangs and curls in the air the block leaves behind
          K = 0
          drag = 2.2
          turb = 0.35
          agitDecay = 2
          agitTurb = 1.2
        } else {
          yank = t - T_YANK
          K = t < T_YANK ? 0 : t < T_SETTLE ? K_YANK : lerp(K_YANK, K_IDLE, smooth(T_SETTLE, T_END, t))
          zeta = t < T_SETTLE ? 0.52 : lerp(0.52, 0.82, smooth(T_SETTLE, T_END, t))
          drag = t < T_YANK ? PUFF_DRAG : lerp(0.4, 1.1, smooth(T_YANK, T_END, t))
          dragHold = t < T_YANK ? 0 : PUFF_DRAG
          turb = t < T_YANK ? 0.3 : lerp(0.25, 0.07, smooth(T_YANK, T_SETTLE, t))
          billow = 5 * (1 - smooth(T_IMPACT + 0.12, T_YANK + 0.3, t))
          agitDecay = 3.2
          agitTurb = t < T_YANK ? 1.0 : 0.8
          agitSoft = lerp(0, 0.75, smooth(T_SETTLE, T_END, t))
          floor = t < T_YANK + 0.3 ? floorY : -1e3
          // the cloud rises off the floor as it billows
          S.cloudC.set(lerp(S.impactP.x, 0, smooth(T_IMPACT, T_YANK, t)), floorY + lerp(0.2, layout.H * 0.45, smooth(T_IMPACT, T_YANK + 0.1, t)), 0)
        }
        if (!S.locked && t >= T_LOCK) {
          S.locked = true
          onLock?.()
        }
        if (t >= T_END) S.phase = 'live'
        dolly = 1 + 0.045 * (1 - smooth(T_IMPACT - 0.1, T_LOCK + 0.35, t))
      }
      S.cloud = S.phase === 'intro' && t >= T_IMPACT ? 1 - smooth(T_YANK + 0.1, T_LOCK, t) : 0
      if (S.phase !== 'wait') S.t += dt
    } else {
      S.cloud = 0
      if (!S.locked) {
        S.locked = true
        onLock?.()
      }
    }
    if (reduced) {
      turb = 0
      agitSoft = 0
    }

    /* ---------- pointer, claps, hold-to-blow ---------- */
    const ptr = m.ptr
    let ptrStr = 0
    let interacting = false
    if (!reduced && ptr && ptr.inside && S.phase !== 'wait') {
      toPlane(S, camera, ptr.x, ptr.y, W, H, S.ptrWorld)
      if (ptr.t !== S.lastPtrT) {
        S.lastPtrT = ptr.t
        S.pv.set(ptr.vx / capPx, -ptr.vy / capPx, 0)
      } else {
        S.pv.multiplyScalar(Math.exp(-dt * 10))
      }
      if (performance.now() - ptr.t > 90) S.pv.multiplyScalar(Math.exp(-dt * 14))
      ptrStr = clamp(S.pv.length() / 4, 0, 1)
      if (ptrStr > 0.05) interacting = true
    } else {
      S.pv.multiplyScalar(Math.exp(-dt * 14))
    }
    S.blow = damp(S.blow, !reduced && m.hold && ptr?.inside ? 1 : 0, m.hold ? 7 : 12, dt)
    if (S.blow > 0.05) interacting = true

    U.uBurst.value.w = 0
    if (m.claps.length) {
      const c = m.claps[m.claps.length - 1]
      m.claps.length = 0
      toPlane(S, camera, c.x, c.y, W, H, S.hitP)
      if (!reduced && S.phase !== 'wait') {
        U.uBurst.value.set(S.hitP.x, S.hitP.y, 0, 13)
        U.uBurstR.value = Math.max(1.45, 115 / capPx)
        S.kick = Math.max(S.kick, 0.55)
        interacting = true
        state.sparks?.emit(S.hitP.x, S.hitP.y, 0.1, S.time, 0.72, 0.25, -1e3, 0.55)
      }
      S.flash = Math.max(S.flash, 0.7)
      if (state.bg) {
        state.bg.uFlashUv.value.set(c.x / W, 1 - c.y / H)
        state.bg.uFlashK.value.set(1, 1)
      }
    }
    if (interacting) S.calm = 0
    else S.calm += dt

    /* ---------- scroll exit (wind) and idle life ---------- */
    const exit = reduced ? 0 : m.exit
    const settled = S.phase === 'live' && !reduced
    S.shed = damp(S.shed, settled && exit < 0.01 && S.calm > 1.2 ? 1 : 0, 2, dt)
    S.breath = damp(S.breath, settled ? 1 : 0, 1.5, dt)
    S.flash *= Math.exp(-dt * 6)
    S.kick *= Math.exp(-dt * 7)
    if (!reduced) S.time += dt

    U.uDt.value = dt
    U.uDtPrev.value = S.dtPrev
    U.uTime.value = S.time
    U.uIntro.value = introT
    U.uImpact.value = T_IMPACT
    U.uSlam.value = slam
    U.uBlockR.value.copy(S.R)
    U.uBlockC.value.copy(S.C)
    U.uBlockV.value.copy(S.V)
    U.uBlockH.value.set(BLOCK.hx, BLOCK.hy, BLOCK.hz)
    U.uBlockRad.value = BLOCK.r
    U.uK.value = K
    U.uZeta.value = zeta
    U.uYank.value = yank
    U.uDrag.value = drag
    U.uDragHold.value = dragHold
    U.uTurb.value = turb
    U.uBillow.value = billow
    U.uAgitDecay.value = agitDecay
    U.uAgitSoft.value = agitSoft
    U.uAgitTurb.value = agitTurb
    // the cloud's reach (cap heights): about the headline's own box, so it never buries the copy
    U.uPuffSpeed.value = PUFF_DRAG
    U.uBurstO.value.set(S.C.x * 0.6, floorY + 0.05, 0)
    if (layout === LAYOUTS.stack) U.uPuffShape.value.set(layout.W * 0.42, layout.H * 0.86)
    else U.uPuffShape.value.set(layout.W * 0.41, layout.H * 0.84)
    U.uFloor.value = floor
    // crumbs only fall while the cloud is out (afterwards the letters' spring owns them)
    U.uGravity.value = S.phase === 'intro' && S.t < T_YANK + 0.1 ? 26 : 0
    U.uBounds.value.set(-bSide, bSide, bBot, bTop)
    U.uBoundsOn.value = 1 - smooth(0, 0.04, exit)
    U.uPtr.value.copy(S.ptrWorld)
    U.uPtrVel.value.copy(S.pv)
    U.uPtrStr.value = ptrStr
    U.uPtrR.value = Math.max(0.75, 130 / capPx)
    U.uBlow.value = S.blow
    U.uWind.value = exit
    U.uGust.value = reduced ? 0 : scroll.abs
    U.uWindBox.value.set(-layout.W / 2, layout.W)
    U.uBreath.value = S.breath
    U.uShed.value = S.shed

    sim.compute()
    S.dtPrev = dt

    /* ---------- camera: frame the block, lean with the pointer, kick on impact ---------- */
    const L = S.lean
    const fine = !portrait && !reduced
    L.x = damp(L.x, fine && ptr?.inside ? ptr.nx : 0, 2.6, dt)
    L.y = damp(L.y, fine && ptr?.inside ? ptr.ny : 0, 2.6, dt)
    const sway = reduced ? 0 : 1
    const yaw = L.x * 0.11 + Math.sin(S.time * 0.21) * 0.03 * sway
    const pitch = L.y * 0.06 + Math.sin(S.time * 0.17 + 1.3) * 0.018 * sway
    const shake = S.kick * S.kick
    const dist = D * dolly * (1 - S.kick * 0.035)
    camera.position.set(
      Math.sin(yaw) * dist + Math.sin(S.time * 63) * shake * 0.04,
      Math.sin(pitch) * dist + Math.cos(S.time * 71) * shake * 0.05,
      Math.cos(yaw) * Math.cos(pitch) * dist,
    )
    camera.lookAt(0, 0, 0)
    camera.near = Math.max(0.05, D * 0.02)
    camera.far = D + 60
    if (camera.fov !== FOV) camera.fov = FOV
    // the world drifts down a little as the page scrolls up, so the dust lingers while the gust carries it off
    const exitShift = exit * H * 0.32
    camera.setViewOffset(W, H, W / 2 - cx, H / 2 - cy - exitShift, W, H)

    /* ---------- materials ---------- */
    // grains big enough to close up into a powdery surface at this density, still fine enough to read as dust
    const grainPx = (lite ? clamp(capPx * 0.033, 1.5, 3.2) : clamp(capPx * 0.0175, 1.4, 3.3)) * dpr
    for (const mat of [mats.grains, mats.haze]) {
      const g = mat.uniforms
      g.tPos.value = sim.pos
      g.uDist.value = D
      g.uTime.value = S.time
      g.uAlpha.value = S.alpha
      g.uShed.value = S.shed
      g.uWind.value = exit
      g.uWindBox.value.set(-layout.W / 2, layout.W)
      g.uMaxSize.value = 42 * dpr
      g.uIntro.value = introT
      g.uBlockR.value.copy(S.R)
      g.uCloudC.value.copy(S.cloudC)
      g.uCloudR.value = layout.W * 0.32
      g.uCloudOn.value = S.cloud
      g.uSize.value = grainPx
      g.uHazeSize.value = Math.max(6, capPx * 0.085) * dpr
    }

    const mu = mats.motes.uniforms
    mu.uTime.value = S.time
    mu.uDist.value = D
    mu.uSize.value = Math.max(2, capPx * 0.02) * dpr
    mu.uCentre.value.set((W / 2 - cx) / capPx, -(H / 2 - cy) / capPx, 0)
    mu.uBox.value.set(viewW / 2 + 0.6, viewH / 2 + 0.6, 2.6)
    mu.uWind.value = exit
    mu.uAlpha.value = reduced ? 1 : smooth(T_IMPACT, T_LOCK, S.phase === 'live' ? 9 : S.t)
    mu.uBeamO.value.set(mu.uCentre.value.x - 0.62 * viewW, mu.uCentre.value.y + 0.62 * viewH)

    if (state.sparks) {
      state.sparks.u.uTime.value = S.time
      state.sparks.u.uRes.value.set(W * dpr, H * dpr)
      state.sparks.u.uWidth.value = clamp(capPx * 0.011, 1.2, 2.4) * dpr
    }

    if (state.bg) {
      state.bg.uRes.value.set(W, H)
      state.bg.uTime.value = reduced ? 0 : S.time
      state.bg.uFlash.value = S.flash
    }
  }

  // the entrance is gated on the dust itself having drawn (not just an empty canvas)
  const drawnFrames = useRef(0)
  useFrame((three, delta) => {
    if (simRef.current) {
      drawnFrames.current += 1
      if (drawnFrames.current === 1) onFrame?.()
      if (drawnFrames.current === 2) onLive?.()
    }
    // dev only: `__hc.dbgSteps = n` fast-forwards the sim n steps per frame (software GL is slow to verify with)
    let n = 1
    const S = st.current
    if (import.meta.env.DEV) {
      // `__hc.dbgPauseAt = t` freezes the sim once the intro clock reaches t (for frame-exact entrance shots)
      if (motion.dbgPauseAt != null && S.phase !== 'wait' && S.t >= motion.dbgPauseAt - 1e-6) motion.dbgPause = true
      // while paused, `__hc.dbgRun = n` advances exactly n steps
      if (motion.dbgPause) {
        n = motion.dbgRun > 0 ? 1 : 0
        if (n) motion.dbgRun -= 1
      } else n = motion.dbgSteps || 1
    }
    for (let i = 0; i < n; i++) tick(three, delta)
    // on demand (reduced motion): keep drawing only while a flash fades or the first frames come in
    if (reduced && (S.flash > 0.004 || drawnFrames.current < 4)) invalidate()
    if (import.meta.env.DEV) {
      motion.dbg = S
      S.frames += 1
    }
  })

  return (
    <>
      <points geometry={geos.motes} material={mats.motes} frustumCulled={false} renderOrder={-5} />
      <points geometry={geos.walls} material={mats.grains} frustumCulled={false} renderOrder={0} />
      <points geometry={geos.haze} material={mats.haze} frustumCulled={false} renderOrder={1} />
      <points geometry={geos.face} material={mats.grains} frustumCulled={false} renderOrder={2} />
    </>
  )
}

export function ChalkScene({ motion, active = true, reduced = false, lite = false, variant = 'wide', onFrame, onLive, onLock }) {
  const [ok] = useState(canSimulate)
  const state = useMemo(() => ({ bg: null, sparks: null }), [])
  useEffect(() => {
    if (ok) return
    // no float render targets: the static chalk type stands in, and the page enters at once
    onFrame?.()
    onLive?.()
    onLock?.()
  }, [ok, onFrame, onLive, onLock])
  if (!ok)
    return (
      <Suspense fallback={null}>
        <ChalkFallback motion={motion} variant={variant} />
      </Suspense>
    )
  return (
    <Canvas
      dpr={lite ? [1, 1.5] : [1, 1.75]}
      frameloop={active ? (reduced ? 'demand' : 'always') : 'never'}
      flat
      gl={{ antialias: false, alpha: false, stencil: false, depth: false, powerPreference: 'high-performance' }}
      camera={{ position: [0, 0, 8], fov: FOV, near: 0.1, far: 80 }}
    >
      <Background state={state} />
      <Dust
        motion={motion}
        reduced={reduced}
        lite={lite}
        variant={variant}
        state={state}
        onLock={onLock}
        onFrame={onFrame}
        onLive={onLive}
      />
      <Sparks state={state} lite={lite} />
      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.2} intensity={lite ? 0.75 : 0.9} radius={0.62} />
      </EffectComposer>
    </Canvas>
  )
}

export default ChalkScene
