import { memo, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import { EffectComposer, Bloom, ToneMapping, Vignette } from '@react-three/postprocessing'
import { BlendFunction, ToneMappingMode } from 'postprocessing'
import { gsap } from '../../lib/gsap'
import { BACK_FRAG, BACK_VERT, POOL_FRAG, POOL_VERT, SPLATS } from './shaders'
import { TURN, YAW_JITTER, buildWord, createMirrorMaterial, createSharedUniforms, createSteelMaterial, heatAt } from './word'
import { SparkField } from './sparks'
import { blackbody } from './heat'

const INK = '#0a0a10'
const HEAT = '#ff4b1f'
const FOV = 24 // narrow lens: monumental letters, little distortion
const SLAM_Z = 5.2 // letters start this far in front of their place, toward the camera
const STEP = 0.09 // s between letter slams
const O_INDEX = 1
const PORTRAIT_HFOV = 30 // degrees across a phone held upright

// cooling after the slam (s → heat): fast through white and yellow, slower through the reds, like real stock
const COOL_T = [0, 0.5, 1.05, 1.6, 2.1, 2.55, 2.95]
const COOL_H = [1.05, 0.78, 0.52, 0.3, 0.14, 0.045, 0]
const COOL_END = COOL_T[COOL_T.length - 1]
const coolAt = (t) => {
  if (t <= 0) return COOL_H[0]
  for (let i = 1; i < COOL_T.length; i++) {
    if (t <= COOL_T[i]) return COOL_H[i - 1] + ((COOL_H[i] - COOL_H[i - 1]) * (t - COOL_T[i - 1])) / (COOL_T[i] - COOL_T[i - 1])
  }
  return 0
}

// scroll exit: the O holds and the camera dives through its counter; the others peel away past the lens
const FLIGHT = [
  { d: [-3.4, 0.7, 4.6], s: [0.35, -1.0, 0.45], delay: 0 },
  null,
  { d: [2.0, 2.3, 3.8], s: [-0.8, 0.9, -0.5], delay: 0.03 },
  { d: [3.4, 0.5, 4.8], s: [0.45, 1.15, 0.35], delay: 0.015 },
  { d: [4.6, 1.7, 3.6], s: [-0.55, 1.35, -0.6], delay: 0.045 },
]
const FLY = 0.3 // exit progress each letter takes to leave
// camera distance to the O's counter along the dive (exit progress → world units; first key is the rest distance)
const DIVE_E = [0, 0.16, 0.29, 0.36, 0.43, 0.55, 0.7]
const DIVE_D = [1, 0.62, 2.6, 0.95, -0.7, -5, -17]
const GLINT_DUR = 1.5 // s for the glint to travel across the word
const GLINT_EVERY = 6.8

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt))
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const rand = (a, b) => a + Math.random() * (b - a)

/** Monotone cubic through (DIVE_E, d) so the dive never stalls or backs up. */
const diveSlopes = (() => {
  const n = DIVE_E.length
  return (d) => {
    const m = new Array(n)
    const s = new Array(n - 1)
    for (let i = 0; i < n - 1; i++) s[i] = (d[i + 1] - d[i]) / (DIVE_E[i + 1] - DIVE_E[i])
    m[0] = s[0]
    m[n - 1] = s[n - 2]
    for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (2 * s[i - 1] * s[i]) / (s[i - 1] + s[i])
    return m
  }
})()
const diveAt = (e, d, m) => {
  const n = DIVE_E.length
  if (e <= 0) return d[0]
  if (e >= DIVE_E[n - 1]) return d[n - 1] + m[n - 1] * (e - DIVE_E[n - 1])
  let i = 0
  while (e > DIVE_E[i + 1]) i++
  const h = DIVE_E[i + 1] - DIVE_E[i]
  const t = (e - DIVE_E[i]) / h
  const t2 = t * t
  const t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * d[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * d[i + 1] + (t3 - t2) * h * m[i + 1]
}

// scratch objects (no allocation per frame)
const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _n = new THREE.Vector3()
const _p = new THREE.Vector3()
const _ax = new THREE.Vector3()
const _dr = new THREE.Vector3()
const _t0 = new THREE.Vector3()
const _u1 = new THREE.Vector3()
const _u2 = new THREE.Vector3()
const _e = new THREE.Euler()
const _ndc = new THREE.Vector2()
const _ray = new THREE.Raycaster()
const _plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
const _m3 = new THREE.Matrix3()
const _mirror = new THREE.Matrix4()
const _col = [0, 0, 0]
const _hits = []
const _dive = new Array(DIVE_D.length)

function createSim(n, reduced) {
  const L = []
  for (let i = 0; i < n; i++) {
    L.push({
      vis: reduced ? 1 : 0,
      cool: reduced ? COOL_END : 0,
      iz: 0,
      is: 1,
      base: 0,
      heat: 0,
      combo: 0,
      temp: 0,
      temper: 0,
      rim: 0,
      kz: 0,
      kzv: 0,
      sq: 0,
      sqv: 0,
      rx: 0,
      rxv: 0,
      ry: 0,
      ryv: 0,
    })
  }
  return {
    L,
    frames: 0,
    time: 0, // sim clock (s): splats, glint, breathing and shake all run on it
    introAt: 0,
    compiled: false,
    live: false,
    introStarted: reduced,
    introDone: reduced,
    tl: null,
    shake: 0,
    pulse: 0,
    flash: 0,
    flashAt: new THREE.Vector3(),
    strikes: 0,
    glint: { t0: -1e9, next: 1e12 },
    spl: {
      x: new Float32Array(SPLATS),
      y: new Float32Array(SPLATS),
      r: new Float32Array(SPLATS).fill(0.2),
      i0: new Float32Array(SPLATS),
      k: new Float32Array(SPLATS).fill(1),
      tp: new Float32Array(SPLATS),
      t: new Float32Array(SPLATS).fill(-1e9),
      next: 1,
    },
    torch: { on: false, x: 0, y: 0, heat: 0, speed: 0, travel: 0, i: -1, grind: 0, dx: 1, dy: 0 },
    last: { t: -1e9, x: 0, y: 0, i: -1 },
    frame: {
      W: 0,
      H: 0,
      bt: -2,
      bb: -2,
      D: 14,
      ox: 0,
      oy: 0,
      fov: FOV,
      el: 0.075,
      yaw: 0,
      turn: TURN,
      ty: 0,
      front: 0.2,
      spread: 1,
      portrait: false,
    },
    look: { x: 0, y: 0 },
    lx: new Float32Array(n), // letter x for the current layout
    prevExit: 0,
    perf: { t0: 0, last: 0, n: 0, slow: 0 },
  }
}

/* ------------------------------------------------------------------ */
/* Studio: satin steel must read silver from every angle, never black, */
/* with a real range of light and dark across the faces                */
/* ------------------------------------------------------------------ */
const faceOrigin = (g) => g?.lookAt(0, 0, 0)
const Studio = memo(function Studio({ lite }) {
  return (
    <Environment resolution={lite ? 128 : 256} frames={1}>
      {/* dark slate world: the darkest a face can get is graphite, never black */}
      <color attach="background" args={['#1a1c24']} />
      {/* overhead softbox: bright crowns and top chamfers */}
      <Lightformer form="rect" intensity={1.9} color="#ffffff" position={[0, 8, 0.5]} scale={[16, 5, 1]} />
      {/* a soft wall behind the word */}
      <Lightformer form="rect" intensity={0.75} color="#dfe3ec" position={[0, 1.2, -10]} scale={[26, 4, 1]} />
      {/* broad soft panels behind left and right: no side wall anywhere on the word goes black */}
      <Lightformer form="rect" intensity={0.95} color="#d9dde6" position={[-6.2, 0.4, -6.6]} scale={[7, 4.5, 1]} />
      <Lightformer form="rect" intensity={0.6} color="#d9dde6" position={[6.2, 0.4, -6.6]} scale={[7, 4.5, 1]} />
      {/* hard strips back-left and back-right: crisp bands down the side walls */}
      <Lightformer form="rect" intensity={3} color="#ffffff" position={[-6.5, 0.6, -5.5]} scale={[1.4, 9, 1]} />
      <Lightformer form="rect" intensity={2} color="#f4f6fb" position={[6.5, 0.6, -5.5]} scale={[1.2, 9, 1]} />
      {/* side strips for the walls and chamfers that face the camera's sides */}
      <Lightformer form="rect" intensity={2.2} color="#ffffff" position={[-8, 1, 3]} scale={[1.2, 10, 1]} />
      <Lightformer form="rect" intensity={1.6} color="#eef1f7" position={[8, 1, 2]} scale={[1, 10, 1]} />
      {/* behind the camera: one long diagonal key strip the faces reflect as a bright band, and a thin echo */}
      <group position={[4.2, 0.3, 9.1]} ref={faceOrigin}>
        <Lightformer form="rect" intensity={2.9} color="#ffffff" rotation={[0, 0, 0.62]} scale={[1.15, 17, 1]} />
      </group>
      <group position={[0.4, -0.9, 10]} ref={faceOrigin}>
        <Lightformer form="rect" intensity={1.6} color="#f2f4f8" rotation={[0, 0, 0.62]} scale={[0.32, 17, 1]} />
      </group>
      {/* a soft panel further round to the right: the receding letters of the phone view catch it */}
      <Lightformer form="rect" intensity={1.25} color="#e6e9f0" position={[7.6, 0.8, 5.5]} scale={[3.2, 6, 1]} />
      {/* a dim wide fill low behind the camera, so the shadow side of a face is graphite, not a hole */}
      <Lightformer form="rect" intensity={0.3} color="#cfd3dd" position={[-3, -1.6, 10]} scale={[12, 3, 1]} />
      {/* faint floor bounce: lower chamfers stay grey */}
      <Lightformer form="rect" intensity={0.3} color="#d4d7e1" position={[0, -6, 1]} scale={[22, 22, 1]} />
      {/* the forge: a small warm source low behind, a hint of heat on a few edges */}
      <Lightformer form="rect" intensity={1.3} color={HEAT} position={[3.5, -1.6, -8]} scale={[4, 1.1, 1]} />
    </Environment>
  )
})

/* ------------------------------------------------------------------ */
/* The forge: letters, heat simulation, sparks, floor, camera          */
/* ------------------------------------------------------------------ */
function Forge({ motion, reduced, lite, software, onDecline, onFrame, onLive }) {
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const word = useMemo(() => buildWord({ lite }), [lite])
  const shared = useMemo(() => createSharedUniforms(), [])
  const mats = useMemo(
    () => word.letters.map((L, i) => createSteelMaterial(shared, { rest: [L.x, L.y], seed: 1.3 + i * 3.17, lite, sdf: L.sdf })),
    [word, shared, lite],
  )
  const mirrorMats = useMemo(() => mats.map((m) => createMirrorMaterial(shared, m, word.floorY)), [mats, shared, word])
  const field = useMemo(() => {
    const f = new SparkField(lite ? 300 : 680, lite ? 18 : 34)
    f.setEmberVolume(word.width * 0.62, word.floorY)
    f.setFloor(word.floorY)
    f.material.uniforms.uSize.value = lite ? 1.4 : 1
    if (reduced) f.hideEmbers()
    return f
  }, [lite, word, reduced])
  const quad = useMemo(() => new THREE.PlaneGeometry(2, 2), [])
  const poolGeo = useMemo(() => new THREE.PlaneGeometry(40, 30), [])
  const floorGeo = useMemo(() => new THREE.PlaneGeometry(400, 400), [])
  const floorMat = useMemo(() => new THREE.MeshBasicMaterial({ colorWrite: false }), [])
  const backMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: BACK_VERT,
        fragmentShader: BACK_FRAG,
        uniforms: {
          uAspect: { value: 1 },
          uGlow: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector4(0.5, 0.5, 0, 0.2)) },
          uCore: { value: new THREE.Vector3(0.5, 0.45, 0.2) },
          uPulse: { value: 0 },
          uHorizon: { value: 0.4 },
          uFlare: { value: new THREE.Vector4(0.5, 0.5, 0, 0.05) },
          uTime: { value: 0 },
        },
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
      }),
    [],
  )
  const poolMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: POOL_VERT,
        fragmentShader: POOL_FRAG,
        uniforms: {
          uPool: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector4()) },
          uPulse: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    [],
  )
  useEffect(() => () => mats.forEach((m) => m.dispose()), [mats])
  useEffect(() => () => mirrorMats.forEach((m) => m.dispose()), [mirrorMats])
  useEffect(() => () => word.dispose(), [word])
  useEffect(() => () => field.dispose(), [field])
  useEffect(
    () => () => {
      backMat.dispose()
      poolMat.dispose()
      floorMat.dispose()
      quad.dispose()
      poolGeo.dispose()
      floorGeo.dispose()
    },
    [backMat, poolMat, floorMat, quad, poolGeo, floorGeo],
  )

  const meshes = useRef([])
  const mirrors = useRef([])
  const light = useRef(null)
  const st = useRef(null)
  if (!st.current) {
    st.current = createSim(word.letters.length, reduced)
    word.letters.forEach((L, i) => (st.current.lx[i] = L.x))
  }

  // compile every program off the main thread before the entrance can start (the slam must never hitch)
  useEffect(() => {
    let alive = true
    const S = st.current
    const done = () => {
      if (alive) S.compiled = true
    }
    const safety = setTimeout(done, 2500)
    try {
      if (gl.extensions.has('KHR_parallel_shader_compile')) gl.compileAsync(scene, camera).then(done, done)
      else {
        gl.compile(scene, camera)
        done()
      }
    } catch {
      done()
    }
    return () => {
      alive = false
      clearTimeout(safety)
    }
  }, [gl, scene, camera])

  /* ---------------- heat splats: ring buffer (slot 0 is the live torch) ---------------- */
  const pushSplat = (x, y, r, i0, k, temper) => {
    const s = st.current.spl
    const j = s.next
    s.next = 1 + (s.next % (SPLATS - 1))
    s.x[j] = x
    s.y[j] = y
    s.r[j] = r
    s.i0[j] = i0
    s.k[j] = k
    s.tp[j] = temper
    s.t[j] = st.current.time
  }

  /* ---------------- hammer strike ---------------- */
  const strike = (i, point, normal) => {
    const S = st.current
    const Ls = S.L[i]
    const L = word.letters[i]
    const mesh = meshes.current[i]
    if (!mesh) return
    // hit point in rest coordinates: the heat sticks to the steel wherever the letter moves
    _v2.copy(point)
    mesh.worldToLocal(_v2)
    const rx = _v2.x + S.lx[i]
    const ry = _v2.y + L.y
    // the heat stays where the hammer landed; only sustained hammering brings the whole letter up
    pushSplat(rx, ry, 0.3, 1.5, 1.9, 0.72)
    Ls.combo = Math.min(6, Ls.combo + 1)
    // a third blow inside ~0.6 s and onward: the whole letter starts to come up to red
    const cap = Math.max(0, Ls.combo - 2) * 0.08
    Ls.heat = Math.max(Ls.heat, Math.min(cap, Ls.heat + 0.06 * Ls.combo))
    S.strikes += 1
    S.last.t = S.time
    S.last.x = rx
    S.last.y = ry
    S.last.i = i
    S.flash = 1
    S.flashAt.copy(point).addScaledVector(normal, 0.5)
    if (reduced) return
    // the punch: squash along the depth, kick back, tip around the hit
    Ls.kzv -= 3.4
    Ls.sqv += 11
    Ls.rxv += -_v2.y * 7
    Ls.ryv += _v2.x * 4.5
    const big = lite ? 130 : 120
    field.burst(
      Math.round(big * rand(0.8, 1.2)),
      point.x,
      point.y,
      point.z + 0.02,
      normal.x * 0.8,
      normal.y * 0.8 + 0.45,
      normal.z * 0.8 + 0.3,
      0.8,
      2.2,
      lite ? 9.5 : 9.5,
      0.88,
      1.05,
    )
    S.shake = Math.min(1.2, S.shake + 0.55)
    S.pulse = Math.min(1.6, S.pulse + 0.8)
  }

  const raycastLetters = (x, y) => {
    _ndc.set(x, y)
    _ray.setFromCamera(_ndc, camera)
    _hits.length = 0
    const list = meshes.current.filter(Boolean)
    _ray.intersectObjects(list, false, _hits)
    return _hits.length ? _hits[0] : null
  }

  // pointer inside the word's box (grown by ~12 px) but between strokes: the nearest letter by projected centre
  const nearestLetter = (x, y) => {
    const z = motion.zone
    const F = st.current.frame
    if (!z || !F.W) return -1
    const px = ((x + 1) / 2) * F.W
    const py = ((1 - y) / 2) * F.H
    const pad = 12
    if (px < z.left - pad || px > z.left + z.width + pad || py < z.top - pad || py > z.top + z.height + pad) return -1
    let best = -1
    let bd = Infinity
    for (let i = 0; i < meshes.current.length; i++) {
      const m = meshes.current[i]
      if (!m) continue
      m.getWorldPosition(_v).project(camera)
      const d = Math.hypot(((_v.x + 1) / 2) * F.W - px, ((1 - _v.y) / 2) * F.H - py)
      if (d < bd) {
        bd = d
        best = i
      }
    }
    return best
  }

  const hitNormal = (hit) => {
    _n.copy(hit.face.normal)
    _m3.getNormalMatrix(hit.object.matrixWorld)
    return _n.applyMatrix3(_m3).normalize()
  }

  // strike letter i near the pointer: walk from the pointer toward its centre until the ray finds steel
  const strikeToward = (i, x, y) => {
    const mesh = meshes.current[i]
    if (!mesh) return false
    mesh.getWorldPosition(_v).project(camera)
    const cx = _v.x
    const cy = _v.y
    for (let s = 1; s <= 6; s++) {
      const f = s / 6
      const hit = raycastLetters(x + (cx - x) * f, y + (cy - y) * f)
      if (hit && hit.object === mesh) {
        strike(i, hit.point, hitNormal(hit))
        return true
      }
    }
    // the front face's centre
    _n.set(0, 0, 1).applyQuaternion(mesh.quaternion)
    mesh.getWorldPosition(_v).addScaledVector(_n, word.depth * 0.5)
    strike(i, _v, _n)
    return true
  }

  // API for the HTML layer (pointer + keyboard)
  useEffect(() => {
    const api = {
      pick: (x, y) => !!raycastLetters(x, y) || nearestLetter(x, y) >= 0,
      strikeAt: (x, y) => {
        if (motion.exit > 0.02 || !st.current.introStarted) return false
        const hit = raycastLetters(x, y)
        if (hit) {
          strike(meshes.current.indexOf(hit.object), hit.point, hitNormal(hit))
          return true
        }
        const i = nearestLetter(x, y)
        return i >= 0 ? strikeToward(i, x, y) : false
      },
      strikeRandom: () => {
        if (!st.current.introStarted) return false
        const S = st.current
        let i = Math.floor(Math.random() * word.letters.length)
        if (i === S.last.i) i = (i + 1 + Math.floor(Math.random() * (word.letters.length - 1))) % word.letters.length
        const L = word.letters[i]
        const mesh = meshes.current[i]
        if (!mesh) return false
        for (let tries = 0; tries < 8; tries++) {
          _v.set(S.lx[i] + rand(-0.32, 0.32) * L.w, L.y + rand(-0.32, 0.32) * L.h, 0.2)
          _v.project(camera)
          const hit = raycastLetters(_v.x, _v.y)
          if (hit && hit.object === mesh) {
            strike(i, hit.point, hitNormal(hit))
            return true
          }
        }
        mesh.getWorldPosition(_v).project(camera)
        return strikeToward(i, _v.x, _v.y)
      },
    }
    motion.api = api
    return () => {
      if (motion.api === api) motion.api = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, word, field, lite, reduced])

  // the entrance timeline lives as long as the scene
  useEffect(
    () => () => {
      st.current?.tl?.kill()
    },
    [],
  )

  /* ---------------- entrance: hammered in left to right, white-hot, then cooling ---------------- */
  const startIntro = () => {
    const S = st.current
    S.introStarted = true
    S.introAt = S.time
    S.glint.next = S.time + 3.35
    const tl = gsap.timeline({ paused: import.meta.env.DEV && !!motion.dbgStep, onComplete: () => (S.introDone = true) })
    // the copy lands as the word passes through orange
    tl.call(() => motion.onCopy?.(), null, 1.25)
    S.L.forEach((Ls, i) => {
      const t0 = 0.04 + i * STEP
      tl.set(Ls, { vis: 1, cool: 0 }, t0)
      // yanked in from in front of the lens, overshooting back past its place
      tl.fromTo(Ls, { iz: SLAM_Z, is: 1.5 }, { iz: -0.2, is: 0.97, duration: 0.17, ease: 'expo.out' }, t0)
      tl.call(() => impact(i), null, t0 + 0.06)
      tl.to(Ls, { iz: 0, is: 1, duration: 0.55, ease: 'elastic.out(1, 0.45)' }, t0 + 0.17)
      // cool: white → yellow → orange → cherry → dark oxide → temper colours → steel
      tl.to(Ls, { cool: COOL_END, duration: COOL_END, ease: 'none' }, t0 + 0.18)
    })
    S.tl = tl
  }

  const impact = (i) => {
    const S = st.current
    const Ls = S.L[i]
    const L = word.letters[i]
    Ls.sqv += 9
    S.shake = Math.min(1.1, S.shake + (i === 4 ? 0.5 : 0.3))
    S.pulse = Math.min(1.6, S.pulse + 0.55)
    // sparks off the anvil line and off the face
    const n = lite ? 52 : 90
    for (let j = 0; j < n; j++) {
      const onBase = j < n * 0.55
      const px = S.lx[i] + rand(-0.5, 0.5) * L.w
      const py = onBase ? word.floorY + rand(0, 0.08) : L.y + rand(-0.45, 0.45) * L.h
      const side = Math.sign(px - S.lx[i]) || 1
      const sp = rand(2, 7.5) * (onBase ? 1 : 0.8)
      const vx = side * rand(0.35, 1) * sp
      const vy = (onBase ? rand(0.25, 0.9) : rand(-0.1, 0.8)) * sp
      const vz = rand(0.15, onBase ? 0.8 : 1.1) * sp
      field.emit(px, py, 0.25, vx, vy, vz, rand(0.4, 1.0), rand(0.88, 1.05), 0.007 + Math.random() * 0.009, rand(0.9, 1.6))
    }
  }

  /* ---------------- layout: the word fills its band; phones see it in strong perspective ---------------- */
  const placeCam = (D, F) => {
    camera.position.set(Math.sin(F.yaw) * Math.cos(F.el) * D, F.ty + Math.sin(F.el) * D, Math.cos(F.yaw) * Math.cos(F.el) * D)
    camera.lookAt(0, F.ty, 0)
    camera.updateMatrixWorld()
  }
  const box = { x0: 0, x1: 0, y0: 0, y1: 0 }
  const projectWord = (W, H) => {
    box.x0 = Infinity
    box.y0 = Infinity
    box.x1 = -Infinity
    box.y1 = -Infinity
    const F = st.current.frame
    for (let i = 0; i < word.letters.length; i++) {
      const L = word.letters[i]
      _e.set(0, F.turn + YAW_JITTER[i], 0)
      for (let c = 0; c < 8; c++) {
        _v.set(c & 1 ? L.w / 2 : -L.w / 2, c & 2 ? L.h / 2 : -L.h / 2, c & 4 ? L.d / 2 : -L.d / 2)
          .applyEuler(_e)
          .add(_v2.set(L.x * F.spread, L.y, 0))
          .project(camera)
        const px = ((_v.x + 1) / 2) * W
        const py = ((1 - _v.y) / 2) * H
        box.x0 = Math.min(box.x0, px)
        box.x1 = Math.max(box.x1, px)
        box.y0 = Math.min(box.y0, py)
        box.y1 = Math.max(box.y1, py)
      }
    }
    return box
  }
  const solveFrame = (W, H, band) => {
    const F = st.current.frame
    const aspect = W / H
    const portrait = aspect < 0.85
    F.portrait = portrait
    // phones: a low camera off to the left and close in (a tall screen takes a wide vertical lens while the
    // horizontal one stays moderate), so the F stands near and big and the E recedes
    F.fov = portrait ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(PORTRAIT_HFOV / 2)) / aspect)) : FOV
    F.yaw = portrait ? -0.98 : 0
    F.el = portrait ? 0.035 : 0.075
    F.turn = portrait ? -0.1 : TURN
    F.ty = portrait ? 0.04 : 0
    F.spread = portrait ? 1.04 : 1
    F.front = word.depth * 0.5
    for (let i = 0; i < word.letters.length; i++) {
      st.current.lx[i] = word.letters[i].x * F.spread
      mats[i].userData.uniforms.uRest.value.x = st.current.lx[i]
    }
    const top = band ? band.top : H * 0.14
    const bottom = band ? band.bottom : H * 0.6
    const bandH = Math.max(90, bottom - top)
    const fillW = portrait ? 1.03 : clamp(0.86 - (aspect - 1.6) * 0.04, 0.82, 0.87)
    const fillH = portrait ? 0.92 : 0.7
    camera.fov = F.fov
    camera.aspect = aspect
    camera.clearViewOffset()
    camera.updateProjectionMatrix()
    let lo = 1.5
    let hi = 160
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2
      placeCam(mid, F)
      const b = projectWord(W, H)
      const f = Math.max((b.x1 - b.x0) / (fillW * W), (b.y1 - b.y0) / (fillH * bandH))
      if (f > 1) lo = mid
      else hi = mid
    }
    F.D = hi
    placeCam(F.D, F)
    const b = projectWord(W, H)
    const yc = top + bandH * 0.5
    // portrait: the receding far end stays inside the screen; only the near F's side wall may run off the left
    F.ox = portrait ? b.x1 - (W - Math.max(10, W * 0.03)) : (b.x0 + b.x1) / 2 - W / 2
    F.oy = (b.y0 + b.y1) / 2 - yc
    scene.fog.near = F.D + 2
    scene.fog.far = F.D + 26
    field.material.uniforms.uAspect.value = aspect
    _plane.constant = -F.front

    // hit zone for the cursor label: the word's box through the resting camera
    camera.setViewOffset(W, H, F.ox, F.oy, W, H)
    camera.updateMatrixWorld()
    const z = projectWord(W, H)
    motion.zone = { left: z.x0, top: z.y0, width: z.x1 - z.x0, height: z.y1 - z.y0 }
    motion.onZone?.()
    // horizon of the floor, for the backdrop's lift
    _v.set(0, word.floorY, -80).project(camera)
    backMat.uniforms.uHorizon.value = (_v.y + 1) / 2
  }

  /* ---------------- per frame ---------------- */
  useFrame((state, delta) => {
    const S = st.current
    let dt = Math.min(delta, 1 / 20)
    // dev only: deterministic frame stepping for the capture scripts (each frame = dbgStep s, the entrance
    // timeline included), optionally frozen once the entrance reaches dbgHold s
    if (import.meta.env.DEV && motion.dbgStep) {
      dt = motion.dbgStep
      if (S.introStarted && motion.dbgHold != null && S.time - S.introAt >= motion.dbgHold) dt = 1e-6
    }
    S.time += dt
    if (import.meta.env.DEV && motion.dbgStep && S.tl) {
      S.tl.pause()
      S.tl.totalTime(Math.min(S.tl.totalDuration(), S.time - S.introAt))
    }
    const now = S.time
    const t = S.time
    const wall = performance.now() / 1000
    const { width: W, height: H } = state.size
    const F = S.frame

    S.frames += 1
    if (S.frames === 1) onFrame?.()
    if (!S.live && S.compiled && S.frames >= 2) {
      S.live = true
      onLive?.()
    }
    if (!S.introStarted && motion.go && S.live) startIntro()

    const band = motion.band
    const bt = band ? band.top : -1
    const bb = band ? band.bottom : -1
    if (F.W !== W || F.H !== H || F.bt !== bt || F.bb !== bb) {
      F.W = W
      F.H = H
      F.bt = bt
      F.bb = bb
      solveFrame(W, H, band)
    }

    /* quality governor: two slow seconds in a row on a real GPU step the render cost down (never back up) */
    const P = S.perf
    if (!software && S.frames > 20 && !document.hidden) {
      // a pause (hidden tab, canvas scrolled off and back) is not a slow frame: start the window again
      if (!P.t0 || wall - P.last > 0.25) {
        P.t0 = wall
        P.n = 0
      }
      P.last = wall
      P.n += 1
      if (wall - P.t0 >= 1) {
        const fps = P.n / (wall - P.t0)
        P.slow = fps < 48 ? P.slow + 1 : 0
        P.t0 = wall
        P.n = 0
        if (P.slow >= 2) {
          P.slow = 0
          onDecline?.()
        }
      }
    }

    const exit = reduced ? 0 : motion.exit
    const live = S.introStarted && exit < 0.02

    /* torch: pointer ray onto the letters' front plane */
    const T = S.torch
    const ptr = motion.ptr
    let over = false
    if (live && ptr.active) {
      _ndc.set(ptr.x, ptr.y)
      _ray.setFromCamera(_ndc, camera)
      if (_ray.ray.intersectPlane(_plane, _v)) {
        over = Math.abs(_v.x) < (word.width / 2) * F.spread + 0.04 && _v.y > word.floorY - 0.02 && _v.y < word.top + 0.04
      }
    }
    if (over) {
      const px0 = T.x
      const py0 = T.y
      const dx = _v.x - T.x
      const dy = _v.y - T.y
      const dist = T.on ? Math.hypot(dx, dy) : 0
      T.speed = damp(T.speed, dist / dt, 14, dt)
      if (dist > 1e-4) {
        T.dx = damp(T.dx, dx / dist, 18, dt)
        T.dy = damp(T.dy, dy / dist, 18, dt)
        const l = Math.hypot(T.dx, T.dy) || 1
        T.dx /= l
        T.dy /= l
      }
      T.x = _v.x
      T.y = _v.y
      T.on = true
      // a still torch slowly brings a spot up to red; a fast pass heats harder and leaves a glowing trail
      T.heat = Math.min(0.82, T.heat + dt * (0.32 + Math.min(T.speed, 8) * 0.22))
      // trail splats laid along the whole path since last frame, so it stays continuous at any frame rate
      T.travel += dist
      const gap = 0.13
      if (T.travel >= gap) {
        const n = Math.min(6, Math.floor(T.travel / gap))
        // an orange line, not a white smear: overlapping splats sum to about 1.6x one splat
        const hot = Math.min(0.46, Math.max(T.heat * 0.5, 0.2 + Math.min(T.speed, 9) * 0.03))
        const r = 0.13 + Math.min(T.speed, 6) * 0.008
        for (let j = 1; j <= n; j++) {
          const f = dist > 0 ? Math.max(0, 1 - ((n - j) * gap) / dist) : 1
          pushSplat(px0 + dx * f, py0 + dy * f, r, hot, 1.25, Math.min(0.32, hot * 0.7))
        }
        T.travel -= n * gap
        if (T.travel > gap) T.travel = 0
      }
      // the letter under the torch (for the readout); the heat itself stays in the torch spot and its trail
      let best = -1
      let bd = Infinity
      for (let i = 0; i < word.letters.length; i++) {
        const d = Math.abs(S.lx[i] - T.x)
        if (d < bd) {
          bd = d
          best = i
        }
      }
      T.i = best
      // grinding sparks: fast passes throw sparks off the surface in the direction of travel
      if (!reduced && T.speed > 1.6) {
        T.grind += dt * Math.min(T.speed - 1.6, 9) * (lite ? 22 : 40)
        while (T.grind >= 1) {
          T.grind -= 1
          const sp = rand(2.2, 6.5) * (0.6 + Math.min(T.speed, 10) * 0.07)
          field.emit(
            T.x + rand(-0.04, 0.04),
            T.y + rand(-0.04, 0.04),
            F.front + 0.04,
            (T.dx * 0.85 + rand(-0.35, 0.35)) * sp,
            (T.dy * 0.6 + rand(0.05, 0.6)) * sp,
            rand(0.2, 0.9) * sp,
            rand(0.3, 0.75),
            rand(0.75, 0.95),
            0.006 + Math.random() * 0.007,
            rand(1, 1.8),
          )
        }
      }
    } else {
      T.on = false
      T.speed = 0
      T.heat = Math.max(0, T.heat - dt * 2.2)
    }

    /* splats: decay and upload (heat fades in about a second, the temper film over several) */
    const spl = S.spl
    const U = shared.uSplats.value
    const UT = shared.uSplatT.value
    U[0].set(T.x, T.y, 0.21, T.heat)
    shared.uTorch.value.set(T.dx, T.dy, Math.min(1.8, T.speed * 0.3))
    let anySplat = T.heat > 0.002
    for (let j = 0; j < SPLATS; j++) {
      let tw = 0
      if (j > 0) {
        const a = now - spl.t[j]
        const k = spl.i0[j] * Math.exp(-spl.k[j] * a)
        U[j].set(spl.x[j], spl.y[j], spl.r[j], k > 0.003 ? k : 0)
        tw = spl.tp[j] * Math.exp(-0.42 * a)
        if (tw < 0.005) tw = 0
        if (k > 0.003 || tw > 0) anySplat = true
      }
      UT[j >> 2].setComponent(j & 3, tw)
    }
    shared.uSplatOn.value = anySplat ? 1 : 0

    /* letters: heat, springs, entrance, exit flight */
    const hs = reduced ? 1 : 2
    const sdt = dt / hs
    let tMax = 0
    let tSum = 0
    let hx = 0
    let hw = 0
    const de = exit - S.prevExit
    S.prevExit = exit
    const flyFrom = F.portrait || lite ? 0.1 : 0.06
    // slams and hammer kicks travel along the lens axis (from the camera's rest direction)
    const ax = Math.sin(F.yaw) * Math.cos(F.el)
    const ay = Math.sin(F.el)
    const az = Math.cos(F.yaw) * Math.cos(F.el)
    for (let i = 0; i < S.L.length; i++) {
      const Ls = S.L[i]
      const L = word.letters[i]
      const mesh = meshes.current[i]
      // Newtonian cooling of strike/torch heat
      Ls.heat = Math.max(0, Ls.heat - dt * (Ls.heat * 0.34 + 0.01))
      Ls.combo = Math.max(0, Ls.combo - dt * 1.6)
      for (let s = 0; s < hs; s++) {
        Ls.kzv += (-Ls.kz * 230 - Ls.kzv * 15) * sdt
        Ls.kz += Ls.kzv * sdt
        Ls.sqv += (-Ls.sq * 420 - Ls.sqv * 19) * sdt
        Ls.sq += Ls.sqv * sdt
        Ls.rxv += (-Ls.rx * 170 - Ls.rxv * 11) * sdt
        Ls.rx += Ls.rxv * sdt
        Ls.ryv += (-Ls.ry * 170 - Ls.ryv * 11) * sdt
        Ls.ry += Ls.ryv * sdt
      }
      const fl = FLIGHT[i]
      const k = fl ? clamp((exit - flyFrom - fl.delay) / FLY, 0, 1) : 0
      const kk = k * k
      Ls.base = Ls.vis > 0 ? coolAt(Ls.cool) : 0
      const base = import.meta.env.DEV && motion.dbgHeat != null ? motion.dbgHeat : Ls.base
      Ls.temp = Math.min(1.25, base + Ls.heat)
      // the oxide film remembers the heat: held while glowing, then it fades
      // (letter-wide it stays on the warm side: oxide clears through bronze and straw to bright steel)
      if (Ls.temp > 0.115) Ls.temper = Math.max(Ls.temper, Math.min(0.5, (Ls.temp - 0.05) * 6))
      else if (Ls.temp < 0.04) Ls.temper = Math.max(0, Ls.temper - dt * 0.42)
      // exit: the flying letters flare at their edges only; the O's rim heats as the camera closes in
      Ls.rim = reduced ? 0 : fl ? 0.42 * smooth(0, 0.5, k) : 0.48 * smooth(0.12, 0.36, exit)
      const u = mats[i].userData.uniforms
      u.uTemp.value = Ls.temp
      u.uTemper.value = import.meta.env.DEV && motion.dbgTemper != null ? motion.dbgTemper : Ls.temper
      u.uRim.value = Ls.rim
      const glowT = Ls.temp + Ls.rim * 0.4
      tMax = Math.max(tMax, glowT)
      tSum += glowT
      hx += S.lx[i] * glowT
      hw += glowT
      if (!mesh) continue
      // drawn (at a speck) before the slam so it is part of the compile, not a mid-entrance hitch
      mesh.visible = k < 0.999
      const breathe = reduced ? 0 : Math.sin(t * 1.3 + i * 0.9) * 0.0032
      const sq = Ls.sq
      const sc = Ls.vis > 0 ? Ls.is * (1 + breathe) : 1e-4
      mesh.scale.set(sc * (1 + sq * 0.07), sc * (1 + sq * 0.05), sc * Math.max(0.35, 1 - sq * 0.38))
      const fd = fl ? fl.d : null
      const zk = Ls.iz + Ls.kz
      mesh.position.set(
        S.lx[i] + ax * zk + (fd ? fd[0] * kk : 0),
        L.y + ay * zk + (fd ? fd[1] * kk + Math.sin(k * Math.PI) * 0.3 : 0),
        az * zk + (fd ? fd[2] * kk : 0),
      )
      mesh.rotation.set(Ls.rx + (fl ? fl.s[0] * kk : 0), F.turn + YAW_JITTER[i] + Ls.ry + (fl ? fl.s[1] * kk : 0), fl ? fl.s[2] * kk : 0)
      mesh.updateMatrix()
      const mir = mirrors.current[i]
      if (mir) {
        mir.visible = mesh.visible && Ls.vis > 0
        mir.matrix.multiplyMatrices(_mirror, mesh.matrix)
        mir.matrixWorldNeedsUpdate = true
      }
      // a few sparks shed off the hot edges as they fly
      if (!reduced && de > 0 && k > 0.02 && k < 0.95) {
        let n = de * (lite ? 110 : 220) + Math.random()
        while (n >= 1) {
          n -= 1
          field.emit(
            mesh.position.x + rand(-0.45, 0.45) * L.w,
            mesh.position.y + rand(-0.45, 0.45),
            mesh.position.z,
            rand(-1.5, 1.5),
            rand(0.2, 2.5),
            rand(-2, 0.5),
            rand(0.3, 0.6),
            rand(0.75, 0.95),
            0.006 + Math.random() * 0.005,
          )
        }
      }
    }

    /* glint: a strip of light travels through the steel's reflections every few seconds once it is cold */
    const G = shared.uGlint.value
    G.z = 0
    if (!reduced && S.introStarted && exit < 0.02) {
      if (now >= S.glint.next) {
        S.glint.t0 = now
        S.glint.next = now + GLINT_EVERY
      }
      const gp = import.meta.env.DEV && motion.dbgGlint != null ? motion.dbgGlint : (now - S.glint.t0) / GLINT_DUR
      if (gp >= 0 && gp <= 1) {
        const e = gp * gp * (3 - 2 * gp)
        G.x = -0.42 + e * 1.5
        G.y = 0.042
        G.z = 2.6 * Math.pow(Math.sin(Math.PI * gp), 0.8)
      }
    }

    /* sparks + embers */
    field.update(dt, word.floorY, t, reduced)

    /* camera: rest framing, a hint of parallax, impact shake, then the dive through the O */
    S.shake *= Math.exp(-dt * 7.5)
    S.pulse *= Math.exp(-dt * 3.2)
    S.flash *= Math.exp(-dt * 13)
    const look = S.look
    look.x = damp(look.x, reduced ? 0 : motion.look.x, 3, dt)
    look.y = damp(look.y, reduced ? 0 : motion.look.y, 3, dt)
    const bl = reduced ? 0 : smooth(0.02, 0.3, exit) // swing from the rest orbit onto the O's axis
    const yaw = F.yaw + look.x * 0.045 * (1 - bl)
    const el = F.el - look.y * 0.022 * (1 - bl)
    const D = F.D
    _t0.set(0, F.ty, 0)
    _v.set(Math.sin(yaw) * Math.cos(el) * D, F.ty + Math.sin(el) * D, Math.cos(yaw) * Math.cos(el) * D)
    const O = word.letters[O_INDEX]
    const Om = meshes.current[O_INDEX]
    if (exit > 0 && Om && O.hole) {
      // the counter's centre and axis in world space
      _p.set(O.hole.x, O.hole.y, 0).applyMatrix4(Om.matrix)
      _ax.set(0, 0, 1).applyQuaternion(Om.quaternion).normalize()
      const d0 = _v.distanceTo(_p)
      for (let j = 0; j < DIVE_D.length; j++) _dive[j] = j === 0 ? d0 : j === 1 ? d0 * DIVE_D[1] : DIVE_D[j]
      const dist = diveAt(exit, _dive, diveSlopes(_dive))
      _dr.subVectors(_v, _p).normalize().lerp(_ax, bl).normalize()
      // look direction swings from the word's centre onto the O's axis with the same blend as the position
      _v2.subVectors(_t0, _v).normalize()
      _v.copy(_p).addScaledVector(_dr, dist)
      _v2.lerp(_n.copy(_ax).negate(), bl).normalize()
      _t0.copy(_v).add(_v2)
    }
    const sh = reduced ? 0 : S.shake * (1 - bl)
    _v.x += sh * (Math.sin(t * 47.3) * 0.6 + Math.sin(t * 31.1 + 1.3) * 0.4) * 0.05
    _v.y += sh * (Math.sin(t * 43.7 + 2.1) * 0.6 + Math.sin(t * 29.3) * 0.4) * 0.045
    camera.position.copy(_v)
    camera.lookAt(_t0)
    camera.rotateZ(sh * Math.sin(t * 39.7) * 0.006 + smooth(0.12, 0.5, exit) * 0.07)
    camera.fov = F.fov + 10 * smooth(0.2, 0.45, exit)
    // as the next section rises over the canvas, keep the dive centred in what is still visible
    const ye = smooth(0.05, 0.4, exit)
    const oy = F.oy * (1 - ye) + (H / 2 - (1 - exit) * H * 0.48) * ye
    const ox = F.ox * (1 - bl)
    camera.setViewOffset(W, H, ox, oy, W, H)
    camera.updateMatrixWorld()

    /* heat light: warm orange-yellow (never red on cold silver), plus the hammer's flash at the hit */
    const pulse = S.pulse
    if (light.current) {
      const pl = light.current
      blackbody(Math.max(0.7, Math.min(1, tMax)), _col)
      const m = Math.max(_col[0], _col[1], _col[2], 1e-4)
      pl.color.setRGB(_col[0] / m, _col[1] / m, _col[2] / m)
      const heatI = Math.pow(Math.min(tMax, 1.1), 1.7) * 3.4 * (1 - smooth(0.2, 0.5, exit))
      pl.intensity = heatI + S.flash * 4.5
      if (S.flash > 0.05 && S.flash * 4.5 > heatI) pl.position.copy(S.flashAt)
      else pl.position.set(hw > 0.01 ? hx / hw : 0, 0.2, 1.1)
    }
    const bu = backMat.uniforms
    bu.uAspect.value = W / H
    bu.uPulse.value = pulse * 0.6
    bu.uTime.value = t
    const radius = clamp((H / (2 * F.D * Math.tan(THREE.MathUtils.degToRad(F.fov / 2))) / H) * 1.25, 0.05, 0.5)
    for (let i = 0; i < S.L.length; i++) {
      const mesh = meshes.current[i]
      const g = bu.uGlow.value[i]
      if (mesh) mesh.getWorldPosition(_v)
      else _v.set(word.letters[i].x, 0, 0)
      const wx = _v.x
      const wz = _v.z
      _v.project(camera)
      const glowT = S.L[i].vis > 0 ? S.L[i].temp + S.L[i].rim * 0.25 : 0
      g.set((_v.x + 1) / 2, (_v.y + 1) / 2, _v.z < 1 ? glowT * (1 - smooth(0.25, 0.45, exit)) : 0, radius)
      poolMat.uniforms.uPool.value[i].set(wx, wz, glowT * (1 - smooth(0.12, 0.4, exit)), word.letters[i].w / 2)
    }
    // the forge mouth far down the O's axis: a tight core, brightest just before the cut to black
    if (exit > 0 && O.hole) {
      _v.copy(_p).addScaledVector(_ax, -40).project(camera)
      const fz = smooth(0.12, 0.4, exit) * (1 + 1.6 * smooth(0.5, 0.64, exit))
      bu.uFlare.value.set((_v.x + 1) / 2, (_v.y + 1) / 2, _v.z < 1 ? fz : 0, 0.022 + 0.05 * smooth(0.4, 0.66, exit))
    } else bu.uFlare.value.z = 0
    _v.set(0, word.floorY + 0.12, -7).project(camera)
    const coreK = 0.12 + Math.min(tSum / 5, 1) * 0.55
    bu.uCore.value.set((_v.x + 1) / 2, (_v.y + 1) / 2, coreK * (1 - smooth(0, 0.3, exit)))
    poolMat.uniforms.uPulse.value = pulse * 0.5 + S.flash * 0.6

    /* exit: sparks pour out of the forge mouth and stream radially past the lens */
    if (!reduced && de > 0 && exit > 0.26 && exit < 0.68 && O.hole) {
      _u1.set(0, 1, 0).cross(_ax).normalize()
      _u2.crossVectors(_ax, _u1)
      let n = de * (lite ? 700 : 1300) + Math.random()
      while (n >= 1) {
        n -= 1
        const a = Math.random() * Math.PI * 2
        const r = rand(0.05, 0.5)
        const ca = Math.cos(a)
        const sa = Math.sin(a)
        const back = rand(7, 16)
        const sp = rand(10, 19)
        const out = rand(0.8, 3.4)
        _v.copy(_p).addScaledVector(_ax, -back).addScaledVector(_u1, ca * r).addScaledVector(_u2, sa * r)
        if (_v.y < word.floorY + 0.03) _v.y = word.floorY + 0.03
        field.emit(
          _v.x,
          _v.y,
          _v.z,
          _ax.x * sp + (_u1.x * ca + _u2.x * sa) * out,
          _ax.y * sp + (_u1.y * ca + _u2.y * sa) * out,
          _ax.z * sp + (_u1.z * ca + _u2.z * sa) * out,
          rand(0.7, 1.3),
          rand(0.9, 1.05),
          0.006 + Math.random() * 0.008,
          0.15,
          0,
        )
      }
    }

    /* readout probe: the torch, the last strike, or the hottest letter */
    let probe
    if (T.on && T.i >= 0) probe = heatAt(S.L[T.i].temp, U, T.x, T.y)
    else if (now - S.last.t < 2.4 && S.last.i >= 0) probe = heatAt(S.L[S.last.i].temp, U, S.last.x, S.last.y)
    else probe = S.introStarted ? tMax : 0
    motion.read.heat = probe
    motion.read.strikes = S.strikes
    if (import.meta.env.DEV) {
      motion.dbg = motion.dbg || { temps: [] }
      motion.dbg.frames = S.frames
      motion.dbg.intro = S.introStarted
      for (let i = 0; i < S.L.length; i++) motion.dbg.temps[i] = +S.L[i].temp.toFixed(3)
      motion.dbg.D = +F.D.toFixed(2)
      motion.dbg.frame = F
      motion.dbg.splats = U
      motion.dbg.hole = O.hole
      motion.dbg.glint = G.z
      motion.dbg.clearSparks = () => field.clear()
      motion.dbg.glintNow = () => {
        S.glint.t0 = S.time
      }
      motion.dbg.project = (i, fx, fy) => {
        const L = word.letters[i]
        const m = meshes.current[i]
        _v.set(fx * L.w, fy * L.h, L.d / 2)
        m.localToWorld(_v).project(camera)
        return { x: ((_v.x + 1) / 2) * F.W, y: ((1 - _v.y) / 2) * F.H }
      }
      motion.dbg.settle = () => {
        S.tl?.progress(1)
        if (S.tl) S.introAt = S.time - S.tl.totalDuration()
        for (const l of S.L) l.temper = 0
        field.clear()
        S.glint.next = S.time + 1e6
      }
      motion.dbg.introT = S.introStarted ? +(S.time - S.introAt).toFixed(3) : -1
      motion.dbg.time = +S.time.toFixed(3)
      motion.dbg.temper = motion.dbg.temper || []
      for (let i = 0; i < S.L.length; i++) motion.dbg.temper[i] = +S.L[i].temper.toFixed(2)
    }
  }, -1)

  _mirror.makeScale(1, -1, 1).setPosition(0, 2 * word.floorY, 0)

  return (
    <>
      <mesh geometry={quad} material={backMat} frustumCulled={false} renderOrder={-10} />
      {/* the floor plate's reflection: mirrored letters and sparks under the plate, then the plate's depth */}
      {word.letters.map((L, i) => (
        <mesh
          key={`m${L.char}${i}`}
          ref={(m) => {
            mirrors.current[i] = m
          }}
          geometry={L.geometry}
          material={mirrorMats[i]}
          matrixAutoUpdate={false}
          visible={reduced}
          renderOrder={-6}
        />
      ))}
      <primitive object={field.mirror} />
      <mesh geometry={floorGeo} material={floorMat} rotation-x={-Math.PI / 2} position={[0, word.floorY, 0]} renderOrder={-5} />
      {word.letters.map((L, i) => (
        <mesh
          key={L.char + i}
          ref={(m) => {
            meshes.current[i] = m
          }}
          geometry={L.geometry}
          material={mats[i]}
          position={[L.x, L.y, 0]}
          rotation={[0, TURN + YAW_JITTER[i], 0]}
          scale={reduced ? 1 : 1e-4}
        />
      ))}
      <primitive object={field.mesh} />
      <mesh geometry={poolGeo} material={poolMat} rotation-x={-Math.PI / 2} position={[0, word.floorY + 0.004, -3]} renderOrder={1} />
      <pointLight ref={light} color={HEAT} intensity={0} decay={2} distance={0} />
    </>
  )
}

function Post({ msaa }) {
  return (
    <EffectComposer multisampling={msaa}>
      {/* additive: the default screen blend goes negative on HDR input and fringes bright sparks cyan */}
      <Bloom mipmapBlur blendFunction={BlendFunction.ADD} luminanceThreshold={1} luminanceSmoothing={0.22} intensity={0.62} radius={0.62} />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      <Vignette offset={0.26} darkness={0.55} />
    </EffectComposer>
  )
}

/** Render budget: dpr capped at 1.75 and at ~3.4 Mpx in total; the governor steps down to 1.25 without MSAA, then 1. */
const dprFor = (tier, lite) => {
  if (typeof window === 'undefined') return 1
  const budget = Math.sqrt(3.4e6 / Math.max(1, window.innerWidth * window.innerHeight))
  const cap = tier >= 2 ? 1.75 : tier === 1 ? 1.25 : 1
  return Math.max(1, Math.min(window.devicePixelRatio || 1, lite ? Math.min(cap, 1.5) : cap, budget))
}

export function ForgedScene({ motion, active = true, reduced = false, lite = false, onFrame, onLive }) {
  const [tier, setTier] = useState(lite ? 1 : 2)
  // a software rasteriser (no GPU) is never a visitor's real frame rate: don't adapt to it
  const [software, setSoftware] = useState(false)
  const onCreated = ({ gl }) => {
    try {
      const ctx = gl.getContext()
      const ext = ctx.getExtension('WEBGL_debug_renderer_info')
      const name = String(ctx.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : ctx.RENDERER) || '')
      if (/swiftshader|llvmpipe|software/i.test(name)) setSoftware(true)
    } catch {
      /* keep adapting */
    }
  }
  const onDecline = () => setTier((v) => Math.max(0, v - 1))
  return (
    <Canvas
      dpr={dprFor(tier, lite)}
      frameloop={active ? 'always' : 'never'}
      gl={{ antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' }}
      camera={{ position: [0, 1, 14], fov: FOV, near: 0.1, far: 90 }}
      onCreated={onCreated}
    >
      <color attach="background" args={[INK]} />
      <fog attach="fog" args={[INK, 16, 40]} />
      <Studio lite={lite} />
      <Forge
        motion={motion}
        reduced={reduced}
        lite={lite}
        software={software}
        onDecline={onDecline}
        onFrame={onFrame}
        onLive={onLive}
      />
      <Post msaa={tier >= 2 && !lite ? 4 : 0} />
    </Canvas>
  )
}

export default ForgedScene
