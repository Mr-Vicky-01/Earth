import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import { scroll } from '../../lib/scroll'
import { BLOCK, LAYOUTS } from './layout'
import { rasterHeadline, rng, sampleBlockAsync, sampleHeadlineAsync } from './targets'
import { canSimulate, createSim } from './sim'
import { BG_VERT, GRAIN_FRAG, GRAIN_VERT, MOTE_FRAG, MOTE_VERT } from './shaders'
import { G, M, ROOM, ROOM_COMPOSITE_FRAG, createRoom, keyPose, maskTexture, spotPose } from './room'
import { createGrit } from './grit'
import { ChalkLensEffect } from './lens'

const ChalkFallback = lazy(() => import('./ChalkFallback.jsx').then((m) => ({ default: m.ChalkFallback })))

const FOV = 30
const SUB = 1 / 120 // the simulation step: the same motion at 30, 60, 120 or 144 Hz
const MAX_SUB = 6
const SHUTTER = 1 / 120 // exposure of the motion blur on the falling block (and on the chips)
const COC = 0.016 // the lens: a point at infinity blurs to 1.6 % of the frame height (the letters are in focus)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const lerp = (a, b, t) => a + (b - a) * t
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
/** critically damped spring step (value, velocity) toward a target: eases in and out, never overshoots */
const spring = (o, kx, kv, target, w, dt) => {
  const x = o[kx] - target
  const v = o[kv]
  const e = Math.exp(-w * dt)
  const tmp = (v + w * x) * dt
  o[kx] = target + (x + tmp) * e
  o[kv] = (v - w * tmp) * e
}

/* The opening, in seconds after the impact (the fall before it is worked out from the frame) ------------------ */
const A_YANK = 0.1 // the pull back into the letters starts to open (grain by grain) as the cloud rolls up
const A_LOCK = 0.88 // letters legible: the HTML copy is pulled in
const A_SETTLE = 1.25
const A_END = 2.0
const K_FLOW = 60
const K_IDLE = 38
// the powder crushed out of the block surges out along the floor and slows by drag (63 % of its run in 1/SURGE s)
const SURGE = 8
// the crush runs through the block from the corner that hits at this speed (caps/s): ~50 ms for the whole brick
const CRACK_V = 22
// the throw: tossed down at 0.6 m/s from above the frame, then gravity; spinning about a fixed axis
const V0 = 3
const VX = 4.2
const SPIN = 5.5
const SPIN_AXIS = new THREE.Vector3(0.62, 0.35, 0.7).normalize()
const LANDING = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.36, -0.52, -0.16))
const BLOCK_REACH = Math.hypot(BLOCK.hx, BLOCK.hy, BLOCK.hz)

/** handheld drift: a sum of slow sines (0.1 – 0.35 Hz), smooth and never repeating visibly */
const drift = (t, p) =>
  Math.sin(t * 0.73 + p) * 0.55 + Math.sin(t * 1.31 + p * 2.3 + 2.1) * 0.3 + Math.sin(t * 2.07 + p * 4.1 + 4.2) * 0.15

/* ------------------------------------------------------------------ */
/* The room: rendered small into its own target, upsampled here         */
/* ------------------------------------------------------------------ */
function Room({ state }) {
  const room = useMemo(() => createRoom(), [])
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
    return g
  }, [])
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: BG_VERT,
        fragmentShader: ROOM_COMPOSITE_FRAG,
        depthTest: false,
        depthWrite: false,
        uniforms: { tRoom: { value: room.rt.texture }, uTexel: { value: new THREE.Vector2(1, 1) } },
      }),
    [room],
  )
  useEffect(() => {
    state.room = room
    state.roomComposite = mat.uniforms
    return () => {
      state.room = null
      state.roomComposite = null
      room.dispose()
      geo.dispose()
      mat.dispose()
    }
  }, [room, geo, mat, state])
  return <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={-10} />
}

/* ------------------------------------------------------------------ */
/* Debris off the slam                                                  */
/* ------------------------------------------------------------------ */
function Grit({ state, lite }) {
  const grit = useMemo(() => createGrit(lite ? 28 : 44, lite ? 4 : 5, lite ? 5 : 6), [lite])
  useEffect(() => {
    state.grit = grit.uniforms
    return () => {
      state.grit = null
      grit.geometry.dispose()
      grit.material.dispose()
    }
  }, [grit, state])
  return <mesh geometry={grit.geometry} material={grit.material} frustumCulled={false} renderOrder={-1} />
}

/* ------------------------------------------------------------------ */
/* Compile every program and upload every texture before the first     */
/* visible frame                                                        */
/* ------------------------------------------------------------------ */
const TRI = new THREE.BufferGeometry()
TRI.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
const ORTHO = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
const WARM_SIZE = new THREE.Vector2()

/** a throwaway scene holding one full-screen mesh per material, for compileAsync */
function materialScene(materials) {
  const s = new THREE.Scene()
  for (const m of materials) {
    if (!m) continue
    const mesh = new THREE.Mesh(TRI, m)
    mesh.frustumCulled = false
    s.add(mesh)
  }
  return s
}

/** the post chain's own programs: the bloom's luminance and mip passes render to targets, the final pass to screen */
function composerMaterials(composer) {
  const toTarget = []
  const toScreen = []
  for (const pass of composer?.passes || []) {
    if (pass.fullscreenMaterial) (pass.renderToScreen ? toScreen : toTarget).push(pass.fullscreenMaterial)
    for (const e of pass.effects || []) {
      if (e.luminancePass?.fullscreenMaterial) toTarget.push(e.luminancePass.fullscreenMaterial)
      const mb = e.mipmapBlurPass
      if (mb) toTarget.push(mb.downsamplingMaterial, mb.upsamplingMaterial)
    }
  }
  return { toTarget, toScreen }
}

/* ------------------------------------------------------------------ */
/* Dust: GPGPU sim + grains + powder body/haze + motes + camera         */
/* ------------------------------------------------------------------ */
function Dust({ motion, reduced, lite, variant, state, composer, lens, onWarm, onLock, onFrame, onLive }) {
  const { gl, invalidate, scene, camera: cam0 } = useThree()
  const setDpr = useThree((s) => s.setDpr)
  const size = lite ? 224 : 384
  const count = size * size
  const hazeStep = lite ? 9 : 13
  const moteCount = lite ? 34 : 64
  // CPU data: grain targets in the letters and on the chalk block, sampled in small slices so the main thread
  // (and the preloader pulling away) never stalls
  const [data, setData] = useState(null)
  useEffect(() => {
    const ac = new AbortController()
    ;(async () => {
      const head = await sampleHeadlineAsync(count, lite ? 100 : 150, 11, variant, ac.signal)
      if (!head) return
      const block = await sampleBlockAsync(count, 5, ac.signal)
      if (!block) return
      setData({ ...head, block, variant })
    })()
    return () => ac.abort()
  }, [count, lite, variant])
  // frame the layout the grains were sampled for (a new one takes over once its targets are ready)
  const layout = LAYOUTS[data?.variant || variant] || LAYOUTS.wide

  // the headline's silhouette, for its shadow on the floor
  const mask = useMemo(() => maskTexture(rasterHeadline(layout, 40)), [layout])
  useEffect(() => () => mask.tex.dispose(), [mask])

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
    face.setDrawRange(0, 0)
    const hazeN = Math.floor(count / hazeStep)
    const hrefs = new Float32Array(hazeN * 2)
    for (let i = 0; i < hazeN; i++) {
      hrefs[i * 2] = refs[i * hazeStep * 2]
      hrefs[i * 2 + 1] = refs[i * hazeStep * 2 + 1]
    }
    const haze = new THREE.BufferGeometry()
    haze.setAttribute('position', new THREE.BufferAttribute(new Float32Array(hazeN * 3), 3))
    haze.setAttribute('aRef', new THREE.BufferAttribute(hrefs, 2))
    haze.setDrawRange(0, 0)
    const r = rng(3)
    const seeds = new Float32Array(moteCount * 4)
    for (let i = 0; i < seeds.length; i++) seeds[i] = r()
    const motes = new THREE.BufferGeometry()
    motes.setAttribute('position', new THREE.BufferAttribute(new Float32Array(moteCount * 3), 3))
    motes.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4))
    return { walls, face, haze, motes, hazeN }
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
      uLight: { value: 0 },
      uShed: { value: 0 },
      uWind: { value: 0 },
      uWindBox: { value: new THREE.Vector2(-3.4, 6.8) },
      uHaze: { value: 0 },
      uMaxSize: { value: 40 },
      uAirMax: { value: 40 },
      uIntro: { value: 1e3 },
      uImpact: { value: 0.33 },
      uBlockR: { value: new THREE.Matrix3() },
      uBlockH: { value: new THREE.Vector3(BLOCK.hx, BLOCK.hy, BLOCK.hz) },
      uBlockRad: { value: BLOCK.r },
      uBlockV: { value: new THREE.Vector3() },
      uBlockW: { value: new THREE.Vector3() },
      uShutter: { value: SHUTTER },
      uImpR: { value: new THREE.Matrix3() },
      uImpC: { value: new THREE.Vector3(0, 100, 0) },
      uImpV: { value: new THREE.Vector3(0, -20, 0) },
      uImpP: { value: new THREE.Vector3(0, 100, 0) },
      uCrackV: { value: CRACK_V },
      uFloorY: { value: -1.3 },
      uKeyPos: { value: new THREE.Vector3() },
      uCloudC: { value: new THREE.Vector3() },
      uCloudRad: { value: new THREE.Vector3(3, 1.5, 1.2) },
      uCloudOn: { value: 0 },
      uGrow: { value: 1 },
      uPuffShape: { value: new THREE.Vector2(1, 1) },
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
    const cosd = (d) => Math.cos(THREE.MathUtils.degToRad(d))
    const motes = new THREE.ShaderMaterial({
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uBoxMin: { value: new THREE.Vector3() },
        uBoxMax: { value: new THREE.Vector3() },
        uFarMin: { value: new THREE.Vector3() },
        uFarMax: { value: new THREE.Vector3() },
        uPxK: { value: 1000 },
        uFocus: { value: 9 },
        uCocK: { value: 10 },
        uWind: { value: 0 },
        uAlpha: { value: 0 },
        uKeyPos: { value: new THREE.Vector3() },
        uKeyDir: { value: new THREE.Vector3(0, -1, 0) },
        uKeyCone: { value: new THREE.Vector2(cosd(ROOM.key.outer), cosd(ROOM.key.inner)) },
        uKeyI: { value: ROOM.key.power },
        uSpotPos: { value: ROOM.spots.map(() => new THREE.Vector3()) },
        uSpotDir: { value: ROOM.spots.map(() => new THREE.Vector3(0, -1, 0)) },
        uSpotCone: { value: ROOM.spots.map((s) => new THREE.Vector2(cosd(s.outer), cosd(s.inner))) },
        uSpotI: { value: ROOM.spots.map((s) => s.power) },
      },
    })
    const grains = mk(false)
    const haze = mk(true)
    return { grains, haze, motes, both: [grains, haze] }
  }, [])

  useEffect(
    () => () => {
      for (const k of ['walls', 'face', 'haze', 'motes']) geos[k].dispose()
      mats.grains.dispose()
      mats.haze.dispose()
      mats.motes.dispose()
    },
    [geos, mats],
  )

  /*
   * GPU sim, built in an effect so StrictMode's mount → unmount → mount builds and frees it cleanly. Before the
   * canvas draws its first frame, every program it will ever use is compiled off the main thread (the sim's, the
   * scene's, the room's and the post chain's) and every texture is uploaded; one hidden frame then flushes the
   * rest. The first frame anyone sees is an ordinary frame.
   */
  const simRef = useRef(null)
  const warmRef = useRef(false)
  useEffect(() => {
    if (!data || data.target.length !== count * 4) return
    // every grain starts on its letter (reduced motion shows that at once), at rest: w is the agitation
    const start = Float32Array.from(data.target)
    for (let i = 3; i < start.length; i += 4) start[i] = 0
    const sim = createSim(gl, size, { ...data, start })
    let live = true
    for (const m of mats.both) {
      m.uniforms.tTarget.value = sim.tTarget
      m.uniforms.tInfo.value = sim.tInfo
      m.uniforms.tBlock.value = sim.tBlock
    }
    gl.initTexture(sim.tTarget)
    gl.initTexture(sim.tInfo)
    gl.initTexture(sim.tBlock)
    gl.initTexture(mask.tex)
    const prev = gl.getRenderTarget()
    const jobs = []
    const rtF = new THREE.WebGLRenderTarget(2, 2, { type: THREE.FloatType, depthBuffer: false })
    const rtH = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false })
    gl.setRenderTarget(rtF)
    jobs.push(gl.compileAsync(materialScene(sim.materials), ORTHO))
    // the scene draws into the composer's half-float buffer, the room into its own half-float target
    gl.setRenderTarget(rtH)
    if (!warmRef.current) {
      jobs.push(gl.compileAsync(scene, cam0))
      if (state.room) jobs.push(gl.compileAsync(state.room.scene, state.room.cam))
      const post = composerMaterials(composer.current)
      jobs.push(gl.compileAsync(materialScene(post.toTarget), ORTHO))
      gl.setRenderTarget(null)
      jobs.push(gl.compileAsync(materialScene(post.toScreen), ORTHO))
    }
    gl.setRenderTarget(prev)
    Promise.all(jobs)
      .catch(() => {})
      .then(() => {
        rtF.dispose()
        rtH.dispose()
        if (!live) return
        simRef.current = sim
        geos.walls.setDrawRange(0, data.nWall)
        geos.face.setDrawRange(data.nWall, count - data.nWall)
        geos.haze.setDrawRange(0, geos.hazeN)
        if (!warmRef.current) {
          warmRef.current = true
          // one hidden frame through the whole chain, at the real size: allocates the targets and flushes the rest
          if (state.room) {
            gl.getDrawingBufferSize(WARM_SIZE)
            state.room.setSize(WARM_SIZE.x, WARM_SIZE.y, state.room.scale)
            state.room.render(gl)
          }
          composer.current?.render(0)
          onWarm()
        }
        invalidate()
      })
    return () => {
      live = false
      simRef.current = null
      geos.walls.setDrawRange(0, 0)
      geos.face.setDrawRange(0, 0)
      geos.haze.setDrawRange(0, 0)
      sim.dispose()
    }
  }, [gl, size, count, data, mats, geos, invalidate, scene, cam0, state, composer, mask, onWarm])

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
      dtPrev: 1 / 120,
      hit: false,
      locked: false,
      // the lights are not fully off at first (the gym's work lights): they come up from a glow
      light: reduced ? 1 : 0.06,
      lightV: 0,
      blow: 0,
      shed: 0,
      breath: 0,
      alpha: reduced ? 1 : 0,
      cloud: 0,
      grow: 1,
      splat: 0,
      maskOn: reduced ? 1 : 0,
      lx: 0,
      ly: 0,
      lxv: 0,
      lyv: 0,
      shY: 0,
      shYv: 0,
      shR: 0,
      shRv: 0,
      exit: 0,
      exitV: 0,
      exitPrev: 0,
      windC: 0,
      windP: 0,
      gust: 0,
      dolly: 1.04,
      pv: new THREE.Vector3(),
      ptrRaw: new THREE.Vector3(0, 0, 100),
      ptrF: new THREE.Vector3(0, 0, 100),
      ptrIn: false,
      lastPtrT: -1,
      calm: 0,
      rmBusy: 0,
      ray: new THREE.Raycaster(),
      ndc: new THREE.Vector2(),
      hitP: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      qs: new THREE.Quaternion(),
      m4: new THREE.Matrix4(),
      R: new THREE.Matrix3(),
      C: new THREE.Vector3(0, 100, 0),
      Cprev: new THREE.Vector3(0, 100, 0),
      V: new THREE.Vector3(),
      W: new THREE.Vector3(),
      impV: new THREE.Vector3(),
      throwDir: new THREE.Vector2(1, 0),
      corner: new THREE.Vector3(),
      impactP: new THREE.Vector3(0, -100, 0),
      cloudC: new THREE.Vector3(),
      cloudRad: new THREE.Vector3(3, 1.5, 1.2),
      F: { capPx: 100, cx: 0, cy: 0, D: 9, floorY: -1.3 },
      fall: null,
      frames: 0,
      simFrames: 0,
      liveSent: false,
      clap: false,
      cam: null,
      shPulse: 0,
      shAmp: 0,
      tmp: new THREE.Vector3(),
      keyPos: new THREE.Vector3(),
      keyDir: new THREE.Vector3(),
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

  /**
   * The throw, worked out once when it starts: the block begins wholly above the top of the frame, is tossed down
   * at V0 and falls under gravity, turning at a steady rate about a fixed axis, so that it lands on a corner.
   */
  const planFall = (S, F) => {
    // the landing pose and how far its lowest point sits below the centre
    S.m4.makeRotationFromQuaternion(LANDING)
    S.R.setFromMatrix4(S.m4)
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
    const zI = 0.3
    const z0 = 1.1
    const xI = -0.25
    const yI = F.floorY + ext
    // the top edge of the frame at the block's starting depth
    const yTop = (F.cy / F.capPx) * ((F.D - z0) / F.D)
    const y0 = yTop + BLOCK_REACH + 0.12
    const h = Math.max(1.5, y0 - yI)
    const T = (-V0 + Math.sqrt(V0 * V0 + 2 * G * h)) / G
    S.fall = { T, vI: V0 + G * T, xI, yI, zI, vx: VX, vz: (zI - z0) / T }
    S.impactP.x += xI
    S.impactP.z += zI
    S.impactP.y = F.floorY
    // its spin in the world: the landing pose turns the body axis
    S.W.copy(SPIN_AXIS).multiplyScalar(SPIN).applyQuaternion(LANDING)
    S.impV.set(VX, -S.fall.vI, S.fall.vz)
    S.throwDir.set(VX, S.fall.vz).normalize()
  }

  /** Pose of the block at intro time t (before the impact): rotation S.R, centre S.C */
  const poseBlock = (S, t) => {
    const F = S.fall
    const r = Math.max(F.T - t, 0)
    S.qs.setFromAxisAngle(SPIN_AXIS, -SPIN * r)
    S.q.copy(LANDING).multiply(S.qs)
    S.m4.makeRotationFromQuaternion(S.q)
    S.R.setFromMatrix4(S.m4)
    S.C.set(F.xI - F.vx * r, F.yI + F.vI * r - 0.5 * G * r * r, F.zI - F.vz * r)
  }

  /** The block's pose at the impact goes to the sim and the grain shaders: they work out the crush from it. */
  const setImpact = (S, U) => {
    for (const u of [U, mats.grains.uniforms, mats.haze.uniforms]) {
      u.uImpR.value.copy(S.R)
      u.uImpC.value.copy(S.C)
      u.uImpV.value.copy(S.impV)
      u.uImpP.value.copy(S.impactP)
    }
  }

  /* One simulation step of length h (≤ SUB). `first`: the first step of this frame (one-shot events go here). */
  const step = (S, sim, F, h, first, wind) => {
    const U = sim.uniforms
    const m = motion
    const intro = S.phase === 'intro'
    let K = K_IDLE
    let zeta = 0.82
    let drag = 1.1
    let turb = reduced ? 0 : 0.07
    let billow = 0
    let eddy = reduced ? 0 : 2.8
    let yank = 100
    let agitDecay = 2.2
    let agitSoft = 0.7
    let agitTurb = 3
    let introT = 1e3
    let slam = 0
    let vcap = 12
    let swirl = 0
    let cloud = 0
    let settle = reduced ? 0 : 0.9
    if (S.phase === 'wait') introT = -1
    if (intro) {
      const t = S.t
      introT = t
      const T = S.fall.T
      const a = t - T
      S.Cprev.copy(S.C)
      poseBlock(S, Math.min(t, T))
      if (t === 0) S.Cprev.copy(S.C)
      if (a < 0) S.V.set(S.fall.vx, -(S.fall.vI - G * (T - t)), S.fall.vz)
      else S.V.set(0, 0, 0)
      S.alpha = 1
      if (a >= 0 && !S.hit) {
        S.hit = true
        slam = 1
        setImpact(S, U)
        S.cloudC.copy(S.impactP)
        m.air = Math.max(m.air || 0, S.fall.vI / M)
        // the floor takes the blow: the camera on it feels a short, damped jolt (a 30 ms push, not a step)
        S.shPulse = 0.03
        S.shAmp = 1
        if (state.grit) {
          state.grit.uEv.value.set(S.impactP.x, F.floorY, S.impactP.z, S.time)
          state.grit.uThrow.value.copy(S.throwDir)
        }
      }
      if (a < 0) {
        // powder shed during the throw just hangs and curls in the air the block leaves behind
        K = 0
        drag = 2.2
        turb = 0.35
        agitDecay = 2
        agitTurb = 1.2
        eddy = 0
        settle = 0
      } else {
        yank = a - A_YANK
        K = a < A_SETTLE ? K_FLOW : lerp(K_FLOW, K_IDLE, smooth(A_SETTLE, A_END, a))
        zeta = lerp(0.86, 0.82, smooth(A_SETTLE, A_END, a))
        drag = lerp(0.5, 1.1, smooth(A_YANK, A_END, a))
        turb = lerp(0.3, 0.07, smooth(A_YANK, A_SETTLE, a))
        // the big rolling swirls come in as the surge runs out, and die away as the letters form
        billow = 3.2 * smooth(0, 0.1, a) * (1 - smooth(0.1, A_YANK + 0.8, a))
        eddy = 1.6 * (1 - smooth(0.3, 1.2, a))
        agitDecay = 3.2
        agitTurb = 0.7
        agitSoft = lerp(0, 0.7, smooth(A_SETTLE, A_END, a))
        vcap = lerp(6.5, 11, smooth(A_YANK, A_SETTLE + 0.3, a))
        swirl = 2.4 * (1 - smooth(A_YANK + 0.25, A_SETTLE + 0.25, a))
        cloud = 1
        settle = 1.2 * (1 - smooth(0.8, 1.4, a))
      }
      if (!S.locked && a >= A_LOCK) {
        S.locked = true
        onLock?.()
      }
      if (a >= A_END) S.phase = 'live'
      S.t += h
    } else if (S.phase === 'live' && !S.locked) {
      S.locked = true
      onLock?.()
    }
    // (the gust carries the grains itself; while it moves they may also hurry a little more to keep up)
    const windMoving = clamp(Math.abs(S.exitV) * 1.2, 0, 1)
    vcap += 10 * windMoving
    if (reduced) {
      turb = 0
      agitSoft = 0
      // a clap still answers, but the dust is pulled straight back
      K = K_IDLE * 2.6
      zeta = 1
      vcap = 30
    }

    U.uBurst.value.w = 0
    if (first && S.clap) {
      U.uBurst.value.set(S.hitP.x, S.hitP.y, 0, reduced ? 5 : 13)
      U.uBurstR.value = Math.max(1.45, 115 / F.capPx)
      S.clap = false
    }

    U.uDt.value = h
    U.uDtPrev.value = S.dtPrev
    U.uTime.value = S.time
    U.uIntro.value = introT
    U.uImpact.value = S.fall ? S.fall.T : 1
    U.uSlam.value = slam
    U.uBlockR.value.copy(S.R)
    U.uBlockC.value.copy(S.C)
    U.uBlockV.value.copy(S.V)
    U.uK.value = K
    U.uZeta.value = zeta
    U.uYank.value = yank
    U.uDrag.value = drag
    U.uTurb.value = turb
    U.uBillow.value = billow
    U.uEddy.value = eddy
    U.uAgitDecay.value = agitDecay
    U.uAgitSoft.value = agitSoft
    U.uAgitTurb.value = agitTurb
    U.uVCap.value = vcap
    U.uSwirl.value = swirl
    U.uCloud.value = cloud
    U.uSettle.value = settle
    U.uFloor.value = F.floorY
    U.uSurge.value = SURGE
    U.uCrackV.value = CRACK_V
    U.uThrowDir.value.copy(S.throwDir)
    U.uWindPrev2.value = S.windP
    U.uWindPrev.value = S.windC
    U.uWind.value = wind
    S.windP = S.windC
    S.windC = wind
    U.uMaxV.value = 40 + 20 * windMoving
    sim.compute()
    S.dtPrev = h
    if (!reduced) S.time += h
  }

  const tick = (three, delta) => {
    const S = st.current
    const sim = simRef.current
    const m = motion
    const { camera, size: sz } = three
    const W = sz.width
    const H = sz.height
    // a dropped frame or a tab switch is clamped (the motion pauses rather than jumps); a device that is slow all
    // the time is allowed longer frames, split into more steps, so the opening still plays in real time
    const dt = clamp(delta, 0, gov.current.slow ? 1 / 12 : 1 / 20)
    const dpr = gl.getPixelRatio()
    if (import.meta.env.DEV) {
      gl.info.autoReset = false
      gl.info.reset()
      S.cam = camera
    }

    /* ---------- framing: the headline block lands exactly on the HTML layout box ---------- */
    const box = m.box
    const bw = box && box.w > 10 ? box.w : Math.min(W * 0.86, 1240)
    const capPx = bw / layout.W
    const cx = box && box.w > 10 ? box.x + box.w / 2 : W / 2
    const cy = box && box.w > 10 ? box.y + box.h / 2 : H * 0.45
    const halfTan = Math.tan(THREE.MathUtils.degToRad(FOV / 2))
    const D = H / capPx / 2 / halfTan
    const viewW = W / capPx
    const portrait = W / H < 0.9
    const floorY = -layout.H / 2 - 0.12
    const F = S.F
    F.capPx = capPx
    F.cx = cx
    F.cy = cy
    F.D = D
    F.floorY = floorY
    // soft walls for the dust: inside the stage (between the tag row and the copy) and the screen sides
    const stage = m.stage
    const bTop = Math.max(stage ? (cy - stage.y) / capPx + 0.05 : 0, layout.H / 2 + 0.6)
    const bBot = Math.max(Math.min(stage ? (cy - (stage.y + stage.h)) / capPx - 0.05 : 0, -layout.H / 2 - 0.6), floorY)
    const bSide = Math.max((W / 2 - 14) / capPx, layout.W / 2 + 0.6)

    /* ---------- the lights come up (a curve, from the first frame) ---------- */
    if (!reduced) spring(S, 'light', 'lightV', 1, 5.5, dt)

    /* ---------- the opening: once the page is ready and the room is lit ---------- */
    if (S.phase === 'wait' && m.go && sim && S.light > 0.45) {
      S.phase = 'intro'
      S.t = 0
      planFall(S, F)
    }

    /* ---------- pointer, claps, hold-to-blow (low-pass filtered before they touch anything) ---------- */
    const ptr = m.ptr
    let ptrStr = 0
    let interacting = false
    if (!reduced && ptr && ptr.inside && S.phase !== 'wait') {
      toPlane(S, camera, ptr.x, ptr.y, W, H, S.ptrRaw)
      if (!S.ptrIn) S.ptrF.copy(S.ptrRaw)
      S.ptrF.lerp(S.ptrRaw, 1 - Math.exp(-dt * 32))
      S.ptrIn = true
      if (ptr.t !== S.lastPtrT) {
        S.lastPtrT = ptr.t
        S.tmp.set(ptr.vx / capPx, -ptr.vy / capPx, 0)
        S.pv.lerp(S.tmp, 1 - Math.exp(-dt * 30))
      } else {
        S.pv.multiplyScalar(Math.exp(-dt * 10))
      }
      if (performance.now() - ptr.t > 90) S.pv.multiplyScalar(Math.exp(-dt * 14))
      ptrStr = clamp(S.pv.length() / 4, 0, 1)
      if (ptrStr > 0.05) interacting = true
    } else {
      S.ptrIn = false
      S.pv.multiplyScalar(Math.exp(-dt * 14))
    }
    S.blow += ((!reduced && m.hold && ptr?.inside ? 1 : 0) - S.blow) * (1 - Math.exp(-dt * (m.hold ? 7 : 12)))
    if (S.blow > 0.05) interacting = true

    if (m.claps.length) {
      const c = m.claps[m.claps.length - 1]
      m.claps.length = 0
      toPlane(S, camera, c.x, c.y, W, H, S.hitP)
      if (S.phase !== 'wait') {
        // (a clap is a puff of air in front of the lens: the camera itself doesn't move)
        S.clap = true
        interacting = true
        if (reduced) S.rmBusy = 0.9
      }
    }
    if (interacting) S.calm = 0
    else S.calm += dt

    /* ---------- scroll exit (wind), filtered; idle life ---------- */
    S.exitPrev = S.exit
    spring(S, 'exit', 'exitV', reduced ? 0 : m.exit, 30, dt)
    const exit = clamp(S.exit, 0, 1)
    S.gust += ((reduced ? 0 : scroll.abs) - S.gust) * (1 - Math.exp(-dt * 6))
    const settled = S.phase === 'live' && !reduced
    S.shed += ((settled && exit < 0.01 && S.calm > 1.2 ? 1 : 0) - S.shed) * (1 - Math.exp(-dt * 2))
    S.breath += ((settled ? 1 : 0) - S.breath) * (1 - Math.exp(-dt * 1.5))

    /* ---------- simulation: fixed-size substeps ---------- */
    if (sim) {
      const U = sim.uniforms
      U.uPtr.value.copy(S.ptrF)
      U.uPtrVel.value.copy(S.pv)
      U.uPtrStr.value = ptrStr
      U.uPtrR.value = Math.max(0.75, 130 / capPx)
      U.uBlow.value = S.blow
      U.uGust.value = S.gust
      U.uWindBox.value.set(-layout.W / 2, layout.W)
      U.uBreath.value = S.breath
      U.uShed.value = S.shed
      U.uBounds.value.set(-bSide, bSide, bBot, bTop)
      U.uBoundsOn.value = 1
      U.uBlockH.value.set(BLOCK.hx, BLOCK.hy, BLOCK.hz)
      U.uBlockRad.value = BLOCK.r
      U.uBurstO.value.set(S.fall ? S.fall.xI * 0.6 : 0, floorY + 0.05, 0)
      // the cloud's reach (cap heights): about the headline's own box, so it never buries the copy
      if (layout === LAYOUTS.stack) U.uPuffShape.value.set(layout.W * 0.46, layout.H * 0.78)
      else U.uPuffShape.value.set(layout.W * 0.48, layout.H * 0.8)
      if (dt > 0) {
        // (the same number of steps per frame unless the frame really is longer: rAF jitter around 16.7 ms
        // doesn't flip it between 2 and 3)
        const n = clamp(Math.round(dt / SUB), 1, MAX_SUB)
        const h = dt / n
        const e0 = clamp(S.exitPrev, 0, 1)
        for (let i = 0; i < n; i++) step(S, sim, F, h, i === 0, lerp(e0, exit, (i + 1) / n))
      }
      S.simFrames += 1
    }

    /* ---------- the cloud and the floor as the opening plays ---------- */
    let blockShadow = 0
    if (S.phase === 'intro' && S.fall) {
      const a = S.t - S.fall.T
      blockShadow = a < 0 ? 1 : 1 - smooth(0, 0.07, a)
      if (a >= 0) {
        S.cloud = smooth(0, 0.05, a) * (1 - smooth(A_YANK + 0.25, A_LOCK + 0.05, a))
        S.grow = 1.25 + 0.65 * smooth(0, 0.5, a)
        S.splat = 0.85 * smooth(0, 0.35, a)
        S.maskOn = smooth(A_YANK + 0.25, A_LOCK + 0.25, a)
        // the cloud as a whole, for its shading: low and wide as the surge runs out, then rolling up
        const sh = 1 - Math.exp(-SURGE * a)
        const sv = 1 - Math.exp(-3.6 * Math.max(a - 0.035, 0))
        const pu = sim ? sim.uniforms.uPuffShape.value : null
        const px = pu ? pu.x : layout.W * 0.48
        const py = pu ? pu.y : layout.H * 0.8
        S.cloudC.set(lerp(S.impactP.x, 0, sh), floorY + 0.15 + py * 0.48 * sv, 0)
        S.cloudRad.set(0.4 + px * 1.1 * sh, 0.3 + py * 0.62 * sv, 1.2)
      } else S.cloud = 0
      S.dolly = 1 + 0.04 * (1 - smooth(-0.1, A_LOCK + 0.35, a))
    } else if (S.phase === 'live') {
      S.cloud = 0
      S.maskOn = 1
      S.splat = S.hit ? 0.85 : 0
      S.dolly = 1
    }

    /* ---------- camera: frame the block, lean with the pointer, handheld drift, the jolt of the slam ---------- */
    const fine = !portrait && !reduced
    spring(S, 'lx', 'lxv', fine && ptr?.inside ? ptr.nx : 0, 5.5, dt)
    spring(S, 'ly', 'lyv', fine && ptr?.inside ? ptr.ny : 0, 5.5, dt)
    // the jolt: a damped oscillator (7 Hz, light damping) kicked by impulses, integrated in small steps
    for (let rem = dt; rem > 1e-6; rem -= SUB) {
      const hh = Math.min(SUB, rem)
      // the push: a raised-cosine force over 30 ms (the same total impulse at any frame rate)
      let fy = 0
      let fr = 0
      if (S.shPulse > 0) {
        const u = 1 - S.shPulse / 0.03
        const k = (Math.PI / 0.03) * 0.5 * Math.sin(Math.PI * clamp(u, 0, 1))
        fy = -0.85 * S.shAmp * k
        fr = 0.11 * S.shAmp * k
        S.shPulse -= hh
      }
      const w = 2 * Math.PI * 7
      S.shYv += (fy - w * w * S.shY - 2 * 0.3 * w * S.shYv) * hh
      S.shY += S.shYv * hh
      const wr = 2 * Math.PI * 5
      S.shRv += (fr - wr * wr * S.shR - 2 * 0.35 * wr * S.shRv) * hh
      S.shR += S.shRv * hh
    }
    const life = reduced ? 0 : 1
    const tt = S.time
    const yaw = S.lx * 0.05 + (Math.sin(tt * 0.21) * 0.02 + drift(tt, 0.3) * 0.0016) * life
    const pitch = S.ly * 0.03 + (Math.sin(tt * 0.17 + 1.3) * 0.012 + drift(tt, 1.9) * 0.0013) * life
    const dist = D * S.dolly
    camera.position.set(Math.sin(yaw) * dist, Math.sin(pitch) * dist + S.shY, Math.cos(yaw) * Math.cos(pitch) * dist)
    // it looks a little off the letters' centre, the way it has moved: the letters shift a few px with the drift and
    // the lean, so they and the room move as one shot instead of a pinned plate over a moving backdrop
    camera.lookAt(camera.position.x * 0.15, camera.position.y * 0.15 + S.shY * 0.35, 0)
    camera.rotateZ(S.shR)
    camera.near = Math.max(0.05, D * 0.02)
    camera.far = D + 80
    if (camera.fov !== FOV) camera.fov = FOV
    // as the page scrolls up, the world lags it more and more (from none at first, so the copy that leaves first
    // never slides over the letters): the dust lingers while the gust carries it off
    const exitShift = exit * exit * H * 0.32
    camera.setViewOffset(W, H, W / 2 - cx, H / 2 - cy - exitShift, W, H)
    camera.updateMatrixWorld()

    /* ---------- materials ---------- */
    keyPose(floorY, S.keyPos, S.keyDir)
    // grains big enough to close up into a powdery surface at this density, still fine enough to read as dust
    const grainPx = (lite ? clamp(capPx * 0.033, 1.5, 3.2) : clamp(capPx * 0.0175, 1.4, 3.3)) * dpr
    const pu = sim ? sim.uniforms.uPuffShape.value : null
    const introClock = S.phase === 'intro' ? S.t : S.phase === 'wait' ? -1 : 1e3
    for (let i = 0; i < 2; i++) {
      const g = mats.both[i].uniforms
      g.tPos.value = sim ? sim.pos : null
      g.uDist.value = D
      g.uTime.value = S.time
      g.uAlpha.value = S.alpha
      g.uLight.value = S.light
      g.uShed.value = S.shed
      g.uWind.value = exit
      g.uWindBox.value.set(-layout.W / 2, layout.W)
      g.uMaxSize.value = 48 * dpr
      g.uAirMax.value = Math.max(12, capPx * 0.14) * dpr
      g.uIntro.value = introClock
      g.uImpact.value = S.fall ? S.fall.T : 1
      g.uBlockR.value.copy(S.R)
      g.uBlockV.value.copy(S.V)
      g.uBlockW.value.copy(S.W)
      g.uFloorY.value = floorY
      g.uKeyPos.value.copy(S.keyPos)
      g.uCloudC.value.copy(S.cloudC)
      g.uCloudRad.value.copy(S.cloudRad)
      if (pu) g.uPuffShape.value.copy(pu)
      g.uCloudOn.value = S.cloud
      g.uGrow.value = S.grow
      g.uSize.value = grainPx
      g.uHazeSize.value = Math.max(6, capPx * 0.085) * dpr
    }

    const pxK = (H * dpr) / (2 * halfTan)
    const cocK = H * dpr * COC
    const mu = mats.motes.uniforms
    mu.uTime.value = S.time
    mu.uPxK.value = pxK
    mu.uFocus.value = dist
    mu.uCocK.value = cocK
    mu.uBoxMin.value.set(-viewW * 0.55, floorY + 0.2, -3)
    mu.uBoxMax.value.set(viewW * 0.55, floorY + 0.2 + H / capPx, 3.2)
    mu.uFarMin.value.set(-16, floorY + 0.5, -24)
    mu.uFarMax.value.set(16, floorY + 17, -9)
    mu.uWind.value = exit
    mu.uAlpha.value = S.light
    mu.uKeyPos.value.copy(S.keyPos)
    mu.uKeyDir.value.copy(S.keyDir)
    for (let i = 0; i < ROOM.spots.length; i++) spotPose(i, floorY, W / H, mu.uSpotPos.value[i], mu.uSpotDir.value[i])

    if (state.grit) {
      const gu = state.grit
      gu.uTime.value = S.time
      gu.uFloorY.value = floorY
      gu.uG.value = G
      gu.uRes.value.set(W * dpr, H * dpr)
      gu.uPxK.value = pxK
      gu.uKeyPos.value.copy(S.keyPos)
      gu.uLight.value = S.light
      // the nearest a piece may come to rest: where the floor would show under the top of the copy
      const footTop = stage ? stage.y + stage.h : cy + layout.H * capPx * 0.5 + 40
      const Q = (footTop - cy - 30) / Math.max(1, -floorY * capPx)
      // (on a short frame the copy starts right at the letters' floor line: then pieces stay behind the letters)
      gu.uZMax.value = D * (1 - 1 / Math.max(Q, 0.5))
    }

    /* ---------- the room ---------- */
    const room = state.room
    if (room) {
      const ru = room.uniforms
      room.setSize(W * dpr, H * dpr, room.scale)
      room.update(camera, floorY, W / H)
      ru.uFocus.value = dist
      ru.uCocK.value = room.rt.height * COC
      ru.uTime.value = S.time
      ru.uLight.value = S.light
      if (ru.uMask.value !== mask.tex) ru.uMask.value = mask.tex
      ru.uMaskBox.value.copy(mask.box)
      ru.uMaskRes.value = mask.res
      ru.uMaskOn.value = S.maskOn * (1 - smooth(0.05, 0.6, exit))
      ru.uLetterY.value.set(-layout.H / 2, layout.H / 2)
      if (blockShadow > 0) {
        if (S.t < S.fall.T) ru.uBlock.value.set(S.C.x, S.C.y, S.C.z, BLOCK_REACH * 0.75)
        else ru.uBlock.value.set(S.C.x, Math.max(S.C.y - 0.3 * (S.t - S.fall.T) * 20, floorY + 0.2), S.C.z, BLOCK_REACH * 0.75 * blockShadow)
      } else ru.uBlock.value.w = 0
      ru.uCloud.value.set(S.cloudC.x, S.cloudC.y, S.cloudC.z, 0.5 + S.cloudRad.x * 0.55)
      ru.uCloudA.value = S.cloud * 0.8
      ru.uSplat.value.set(S.impactP.x + 0.15, S.impactP.z - 0.35, S.splat, 1.5)
      room.render(gl)
      if (state.roomComposite) state.roomComposite.uTexel.value.set(1 / room.rt.width, 1 / room.rt.height)
    }
    if (lens) lens.animate = !reduced
    S.frames += 1
  }

  /*
   * Adaptive quality. Frame time is smoothed over half a second; if it stays over 18.5 ms (a 60 Hz screen missing
   * frames) for a second, quality steps down one rung, and back up after 3 s under 12 ms. Rungs: a lighter room
   * (smaller target, fewer march steps), then the drawing buffer (1.75 → 1.4 → 1 dpr), then the lightest room.
   * Below ~25 fps the sim also takes longer frames (more steps each), so the opening still plays in real time.
   */
  const gov = useRef({ avg: 16.7, t: 0, level: 0, slow: false, dpr: 0 })
  const applyLevel = (level) => {
    const g = gov.current
    const top = Math.min(window.devicePixelRatio || 1, lite ? 1.5 : 1.75)
    const dpr = level >= 3 ? 1 : level === 2 ? Math.max(1, top * 0.8) : top
    if (dpr !== g.dpr) {
      g.dpr = dpr
      setDpr(dpr)
    }
    state.room?.setQuality(level === 0 ? 0 : level < 4 ? 1 : 2)
  }
  const governor = (delta) => {
    const g = gov.current
    if (delta > 0.25 || delta <= 0 || reduced) return
    g.avg += (delta * 1000 - g.avg) * (1 - Math.exp(-delta / 0.5))
    g.t += delta
    g.slow = g.avg > 40
    let next = g.level
    if (g.avg > 18.5 && g.t > 1 && g.level < 4) next = g.level + 1
    else if (g.avg < 12 && g.t > 3 && g.level > 0) next = g.level - 1
    if (next !== g.level) {
      g.level = next
      g.t = 0
      applyLevel(next)
    }
  }

  // the entrance is gated on the dust itself having drawn, in a lit room (not an empty canvas)
  useFrame((three, delta) => {
    const S = st.current
    tick(three, delta)
    governor(delta)
    if (S.frames === 1) onFrame?.()
    if (simRef.current && S.simFrames >= 2 && S.light > 0.45 && !S.liveSent) {
      S.liveSent = true
      onLive?.()
    }
    // on demand (reduced motion): keep drawing while a clap settles or the first frames come in
    if (reduced) {
      S.rmBusy -= Math.min(delta, 0.05)
      if (S.rmBusy > 0 || S.frames < 4 || (simRef.current && S.simFrames < 3)) invalidate()
    }
    if (import.meta.env.DEV) motion.dbg = S
  })

  // dev only: a probe for frame-stepped captures (virtual clock) and the renderer's numbers
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const buf = new Float32Array(size * 4 * 4)
    const probe = () => {
      const S = st.current
      const sim = simRef.current
      let err = null
      if (sim && data) {
        // mean distance of a band of face grains from their letters
        const row = Math.floor(size * 0.55)
        gl.readRenderTargetPixels(sim.posTarget, 0, row, size, 4, buf)
        let sum = 0
        let n = 0
        for (let i = 0; i < size * 4; i += 3) {
          const k = (row * size + i) * 4
          const dx = buf[i * 4] - data.target[k]
          const dy = buf[i * 4 + 1] - data.target[k + 1]
          const dz = buf[i * 4 + 2] - data.target[k + 2]
          if (buf[i * 4 + 3] < -0.5) continue
          sum += Math.sqrt(dx * dx + dy * dy + dz * dz)
          n++
        }
        err = n ? +(sum / n).toFixed(4) : null
      }
      const cam = S.cam
      const op = document.querySelector('.hc-foot [data-pull]')
      return {
        phase: S.phase === 'wait' ? 0 : S.phase === 'intro' ? 1 : 2,
        t: +S.t.toFixed(4),
        blockY: S.phase === 'intro' && S.fall && S.t < S.fall.T ? +S.C.y.toFixed(4) : null,
        camX: cam ? +cam.position.x.toFixed(5) : 0,
        camY: cam ? +cam.position.y.toFixed(5) : 0,
        camZ: cam ? +cam.position.z.toFixed(5) : 0,
        light: +S.light.toFixed(4),
        cloud: +S.cloud.toFixed(4),
        exit: +S.exit.toFixed(4),
        ptrX: +S.ptrF.x.toFixed(4),
        shake: +S.shY.toFixed(5),
        grainErr: err,
        copyOp: op ? +getComputedStyle(op).opacity : null,
        level: gov.current.level,
      }
    }
    window.__heroProbe = probe
    window.__heroInfo = () => ({
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      points: gl.info.render.points,
      lines: gl.info.render.lines,
      programs: gl.info.programs?.length,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      dpr: gl.getPixelRatio(),
      room: state.room ? [state.room.rt.width, state.room.rt.height] : null,
      level: gov.current.level,
    })
    return () => {
      if (window.__heroProbe === probe) delete window.__heroProbe
    }
  }, [gl, size, data, state])
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
  const state = useMemo(() => ({ room: null, roomComposite: null, grit: null }), [])
  const [warm, setWarm] = useState(false)
  const [shown, setShown] = useState(false)
  const composer = useRef(null)
  const lens = useMemo(() => new ChalkLensEffect({ grain: 0.012, vignette: 1.7 }), [])
  useEffect(() => () => lens.dispose(), [lens])
  const onWarm = useMemo(() => () => setWarm(true), [])
  const frameCb = useMemo(
    () => () => {
      setShown(true)
      onFrame?.()
    },
    [onFrame],
  )
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
      frameloop={!warm || !active ? 'never' : reduced ? 'demand' : 'always'}
      flat
      // the first frame fades in over the section's own background (which matches the room with its lights low)
      style={{ opacity: shown ? 1 : 0, transition: reduced ? 'none' : 'opacity 0.32s cubic-bezier(0.33, 0, 0.2, 1)' }}
      gl={{ antialias: false, alpha: false, stencil: false, depth: false, powerPreference: 'high-performance' }}
      camera={{ position: [0, 0, 8], fov: FOV, near: 0.1, far: 80 }}
    >
      <Room state={state} />
      <Dust
        motion={motion}
        reduced={reduced}
        lite={lite}
        variant={variant}
        state={state}
        composer={composer}
        lens={lens}
        onWarm={onWarm}
        onLock={onLock}
        onFrame={frameCb}
        onLive={onLive}
      />
      <Grit state={state} lite={lite} />
      <EffectComposer ref={composer} multisampling={0}>
        <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.3} intensity={lite ? 0.22 : 0.28} radius={0.62} />
        <primitive object={lens} />
      </EffectComposer>
    </Canvas>
  )
}

export default ChalkScene
