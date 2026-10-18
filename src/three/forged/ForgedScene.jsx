import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import { EffectComposer, Bloom, ToneMapping, Vignette } from '@react-three/postprocessing'
import { BlendFunction, ToneMappingMode } from 'postprocessing'
import { DEPTH, TURN, YAW_JITTER, buildWord, createSharedUniforms, createSteelMaterial, heatAt } from './word'
import { DENTS } from './shaders'
import { SparkField, UNITS_PER_M } from './sparks'
import { AMBIENT_C, SLAM_C, blackbody, celsiusToHeat, coolRate, heatGain, heatToCelsius } from './heat'
import {
  FOOT_N,
  FORGE_POS,
  NLIGHTS,
  Reflector,
  SIDE_X,
  WALL_Z,
  LAMP_POS,
  createFloorMaterial,
  createPostMaterial,
  createWallMaterial,
  createWorldUniforms,
} from './world'
import { LensEffect } from './lens'

const INK = '#0a0a10'
const FOV = 24 // narrow lens: monumental letters, little distortion
const O_INDEX = 1
const PORTRAIT_HFOV = 30 // degrees across a phone held upright
const G = 9.81 * UNITS_PER_M // gravity in world units (1 unit = 0.5 m)
const SUB_HZ = 240 // spring and contact integration rate, independent of the display's refresh rate

// entrance: each letter drops from rest just above the frame onto the floor plate, white-hot, landing 90 ms
// after the one before (each is let go earlier by its own fall time)
const STEP = 0.09 // s between landings
const FALL_MAX = 0.5 // s: a longer drop starts with a little downward speed instead
const ENTRY_RX = 0.32 // rad the letter is tipped toward the lens as it is let go
const LAND_RX = 0.06 // still tipped a few degrees as it meets the plate (it rocks flat from there)
const ENTRY_RY = [0.12, -0.1, 0.08, -0.12, 0.1]
const RESTITUTION = 0.12 // hot steel is soft: it barely bounces
const COPY_HEAT = 0.62 // the copy lands as the whole word passes through orange

// scroll exit: the O holds and the camera dives through its counter; the others peel away past the lens
const FLIGHT = [
  { d: [-3.4, 0.7, 4.6], s: [0.35, -1.0, 0.45], delay: 0 },
  null,
  { d: [2.0, 2.3, 3.8], s: [-0.8, 0.9, -0.5], delay: 0.03 },
  { d: [3.4, 0.5, 4.8], s: [0.45, 1.15, 0.35], delay: 0.015 },
  { d: [4.6, 1.7, 3.6], s: [-0.55, 1.35, -0.6], delay: 0.045 },
]
const FLY = 0.3 // exit progress each letter takes to leave
// camera distance to the O's counter along the dive (exit progress → world units; first key is the rest
// distance); it ends short of the back wall, by which point the frame has cut to black
const DIVE_E = [0, 0.16, 0.29, 0.36, 0.43, 0.55, 0.7]
const DIVE_D = [1, 0.62, 2.6, 0.95, -0.7, -4.2, -8.2]

// lights (linear colour × candela, inverse-square)
const FORGE_COL = [1.0, 0.4, 0.12]
const FORGE_I = 30
const LAMP_COL = [1.0, 0.8, 0.6] // tungsten, ≈ 2,700 K
const LAMP_I = 22
const POST_W = 0.5 // 250 mm square oak

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt))
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const smoother = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * t * (t * (t * 6 - 15) + 10)
}
const rand = (a, b) => a + Math.random() * (b - a)
const allDown = (L) => {
  for (let i = 0; i < L.length; i++) if (L[i].phase !== 2) return false
  return true
}

/* smooth 1D value noise (quintic, so its acceleration is continuous too): camera drift, shake, fire flicker */
const NT = new Float32Array(512)
for (let i = 0; i < NT.length; i++) NT[i] = Math.random() * 2 - 1
const noise1 = (x) => {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * f * (f * (f * 6 - 15) + 10)
  const a = NT[i & 511]
  return a + (NT[(i + 1) & 511] - a) * u
}

/** The fire breathes: a slow swell, quicker licks, a fast shimmer, and now and then a flare as fresh coal catches. */
const forgeFlicker = (t) => {
  const base = 0.14 * noise1(t * 0.55 + 3) + 0.09 * noise1(t * 1.7 + 17) + 0.045 * noise1(t * 4.3 + 41) + 0.02 * noise1(t * 9.1 + 5)
  const flare = smooth(0.3, 0.85, noise1(t * 0.21 + 61)) * (0.75 + 0.25 * noise1(t * 2.9 + 11))
  return 1 + 1.25 * base + 0.32 * flare
}

/** Monotone cubic through (DIVE_E, d) so the dive never stalls or backs up (writes into scratch arrays). */
const _dm = new Array(DIVE_E.length)
const _ds = new Array(DIVE_E.length - 1)
const diveSlopes = (d) => {
  const n = DIVE_E.length
  const m = _dm
  const s = _ds
  for (let i = 0; i < n - 1; i++) s[i] = (d[i + 1] - d[i]) / (DIVE_E[i + 1] - DIVE_E[i])
  m[0] = s[0]
  m[n - 1] = s[n - 2]
  for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (2 * s[i - 1] * s[i]) / (s[i - 1] + s[i])
  return m
}
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
const _v3 = new THREE.Vector3()
const _n = new THREE.Vector3()
const _p = new THREE.Vector3()
const _ax = new THREE.Vector3()
const _dr = new THREE.Vector3()
const _t0 = new THREE.Vector3()
const _cr = new THREE.Vector3()
const _cu = new THREE.Vector3()
const _e = new THREE.Euler()
const _ndc = new THREE.Vector2()
const _ray = new THREE.Raycaster()
const _plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
const _m3 = new THREE.Matrix3()
const _col = [0, 0, 0]
const _hits = []
const _dive = new Array(DIVE_D.length)
const _hide = [null]
const FORGE_ENV = [0.8, 0.8 * 0.144, 0.8 * 0.019] // the room's forge panel (linear), for its flicker

function createSim(n, reduced) {
  const L = []
  for (let i = 0; i < n; i++) {
    L.push({
      phase: reduced ? 2 : 0, // 0 waiting, 1 in flight, 2 on the plate
      t0: 0,
      tf: 0.24,
      p0: [0, 0, 0],
      v0: [0, 0, 0],
      ox: 0,
      oy: 0,
      oz: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      rx: 0,
      rxv: 0,
      ry: 0,
      ryv: 0,
      sq: 0,
      sqv: 0,
      kz: 0,
      kzv: 0,
      sd: 0,
      sdv: 0,
      wx: 0, // angular velocity in flight (rad/s)
      wy: 0,
      c: AMBIENT_C, // °C of the stock
      heat: 0, // extra heat from the hammer (heat units)
      combo: 0,
      temp: 0,
      scale: 0, // mill scale coverage
      clr: 1, // how far the scale has flaked off (0..1)
      tint: 0, // straw film along the arrises
      rim: 0,
      light: reduced ? 1 : 0,
    })
  }
  return {
    L,
    frames: 0,
    time: 0,
    introAt: 0,
    compiled: false,
    compiledAt: 0,
    calm: 0,
    live: false,
    introStarted: reduced,
    copied: reduced,
    shake: 0,
    // the camera rig: a damped spring bumped by short, smooth force pulses (impacts, blows)
    rig: { x: 0, y: 0, vx: 0, vy: 0, kicks: [] },
    pulse: 0,
    flash: 0,
    flashIn: 0,
    pulseIn: 0,
    flashAt: new THREE.Vector3(),
    strikes: 0,
    // heat capsules (slot 0 is the live torch): start, end, radius, peak heat, decay, temper film, birth time
    spl: {
      x: new Float32Array(32),
      y: new Float32Array(32),
      x1: new Float32Array(32),
      y1: new Float32Array(32),
      r: new Float32Array(32).fill(0.1),
      i0: new Float32Array(32),
      k: new Float32Array(32).fill(1),
      tp: new Float32Array(32),
      t: new Float32Array(32).fill(-1e9),
      next: 1,
    },
    dents: { n: 0 },
    torch: { on: false, x: 0, y: 0, sx: 0, sy: 0, heat: 0, speed: 0, travel: 0, i: -1, grind: 0, dx: 1, dy: 0 },
    // the readout's value, critically damped (≈ 0.15 s) so it reads like an instrument
    rd: AMBIENT_C,
    rdV: 0,
    rdOn: false,
    ptr: { x: 0, y: 0, vx: 0, vy: 0, on: false },
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
      entryU: [3, 3, 3, 3, 3],
      entryB: 0.9,
    },
    look: { x: 0, y: 0 },
    lx: new Float32Array(n),
    prevExit: 0,
    exitF: 0,
    exitV: 0,
    perf: { t0: 0, last: 0, n: 0, slow: 0 },
    info: { calls: 0, tris: 0 },
  }
}

/* ------------------------------------------------------------------ */
/* The room as the steel sees it: dark, sooty and warm, with a forge    */
/* low on the left, a 2,700 K work lamp high on the right and an open   */
/* door behind the camera whose daylight keeps the faces silver         */
/* ------------------------------------------------------------------ */
const Room = memo(function Room({ lite }) {
  return (
    <Environment resolution={lite ? 128 : 256} frames={1}>
      {/* the room's dark: soot and brick, warm graphite at worst, never a hole */}
      <color attach="background" args={['#18120f']} />
      {/* the back wall, lit low and warm by the forge, going dark up into the soot */}
      <Lightformer form="rect" intensity={0.26} color="#6e5444" position={[-2.5, 0.1, -10]} scale={[22, 3.6, 1]} />
      {/* the forge mouth, low on the left: its average glow (the flicker is added in the steel shader) */}
      <Lightformer form="rect" intensity={1.0} color="#ff6a26" position={[-8.4, 0.2, -8.2]} scale={[2.2, 0.9, 1]} />
      {/* the caged work lamp high on the right, and the warm pool it throws on the ceiling */}
      <Lightformer form="circle" intensity={6} color="#ffb877" position={[5.6, 5.3, -4.4]} scale={[0.9, 0.9, 1]} />
      <Lightformer form="rect" intensity={0.28} color="#b0866a" position={[3, 8, -1]} scale={[12, 8, 1]} />
      {/* an open door behind the camera: neutral daylight. The faces reflect it (or the wall it lights round it),
          so they read as silver, brighter on the letters that catch the door itself */}
      <Lightformer form="rect" intensity={1.0} color="#e2e7ef" position={[3.0, 0.4, 9.0]} scale={[3.2, 6.5, 1]} />
      {/* its frame: a dark jamb either side, so the reflection has an edge */}
      <Lightformer form="rect" intensity={0.02} color="#ffffff" position={[1.2, 0.4, 9.2]} scale={[0.35, 6.5, 1]} />
      {/* the wall round the door, lit by the daylight coming in: brightest near it, falling off away from it */}
      <Lightformer form="rect" intensity={0.34} color="#bdb9b2" position={[2.6, 0.3, 9.6]} scale={[8.5, 7, 1]} />
      <Lightformer form="rect" intensity={0.16} color="#a49e95" position={[0.8, 0.2, 9.9]} scale={[18, 7, 1]} />
      {/* a high window strip: a cool line along the top bevels */}
      <Lightformer form="rect" intensity={0.7} color="#d8dfea" position={[-1, 6.5, 7]} scale={[9, 0.8, 1]} />
      {/* the right-hand wall in the lamp's spill: what the right-facing walls of the letters see */}
      <Lightformer form="rect" intensity={0.42} color="#c4936b" position={[9, 1.2, 0.5]} scale={[3.5, 6, 1]} />
      {/* phones look in from the left: a soft panel further round to the right for the receding letters */}
      <Lightformer form="rect" intensity={0.5} color="#d6d2ca" position={[7.6, 0.8, 5.5]} scale={[3.2, 6, 1]} />
      {/* the iron floor: barely there, warm toward the forge */}
      <Lightformer form="rect" intensity={0.12} color="#8a5a40" position={[-2, -6, 1]} scale={[22, 22, 1]} />
    </Environment>
  )
})

/* ------------------------------------------------------------------ */
/* The forge: letters, heat simulation, sparks, workshop, camera        */
/* ------------------------------------------------------------------ */
function Forge({ motion, reduced, lite, software, tier, lens, onDecline, onFrame, onLive }) {
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const word = useMemo(() => buildWord({ lite }), [lite])
  const shared = useMemo(() => {
    const u = createSharedUniforms()
    u.uFloorY.value = word.floorY
    return u
  }, [word])
  const mats = useMemo(
    () => word.letters.map((L, i) => createSteelMaterial(shared, { rest: [L.x, L.y], seed: 1.3 + i * 3.17, lite, sdf: L.sdf })),
    [word, shared, lite],
  )
  const field = useMemo(() => {
    const f = new SparkField(lite ? 320 : 720, lite ? 16 : 30)
    f.setEmberVolume(word.width * 0.62, word.floorY)
    f.material.uniforms.uSize.value = lite ? 1.35 : 1
    if (reduced) f.hideEmbers()
    return f
  }, [lite, word, reduced])
  const world = useMemo(() => createWorldUniforms(word.floorY, shared.uMirror), [word, shared])
  const reflector = useMemo(() => new Reflector(word.floorY), [word])
  const env = useMemo(() => {
    const backGeo = new THREE.PlaneGeometry(90, 26)
    const sideGeo = new THREE.PlaneGeometry(44, 26)
    const floorGeo = new THREE.PlaneGeometry(130, 64)
    // a 250 mm oak post: the card spans its silhouette at any viewing angle (≤ width × √2)
    const postGeo = new THREE.PlaneGeometry(POST_W * 1.45, 14).translate(0, 7, 0)
    return {
      backGeo,
      sideGeo,
      floorGeo,
      postGeo,
      backMat: createWallMaterial(world, true),
      sideMat: createWallMaterial(world, false),
      floorMat: createFloorMaterial(world, reflector),
      postMat: createPostMaterial(world, POST_W),
    }
  }, [world, reflector])
  useEffect(() => () => mats.forEach((m) => m.dispose()), [mats])
  useEffect(() => () => word.dispose(), [word])
  useEffect(() => () => field.dispose(), [field])
  useEffect(() => () => reflector.dispose(), [reflector])
  useEffect(
    () => () => {
      for (const v of Object.values(env)) v.dispose?.()
    },
    [env],
  )

  const meshes = useRef([])
  const floor = useRef(null)
  const post = useRef(null)
  const light = useRef(null)
  const forgeLight = useRef(null)
  const st = useRef(null)
  if (!st.current) {
    st.current = createSim(word.letters.length, reduced)
    word.letters.forEach((L, i) => (st.current.lx[i] = L.x))
  }

  // compile every program before the entrance can start (the slam must never hitch)
  useEffect(() => {
    let alive = true
    const S = st.current
    const done = () => {
      if (alive && !S.compiled) {
        S.compiled = true
        S.compiledAt = performance.now() / 1000
      }
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

  // per-frame draw call / triangle totals (dev probe): the composer renders in several calls per frame
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const prev = gl.info.autoReset
    gl.info.autoReset = false
    return () => {
      gl.info.autoReset = prev
    }
  }, [gl])

  /* ---------------- heat capsules: ring buffer (slot 0 is the live torch) ---------------- */
  const pushSplat = (x, y, x1, y1, r, i0, k, temper) => {
    const s = st.current.spl
    const j = s.next
    s.next = 1 + (s.next % 31)
    s.x[j] = x
    s.y[j] = y
    s.x1[j] = x1
    s.y1[j] = y1
    s.r[j] = r
    s.i0[j] = i0
    s.k[j] = k
    s.tp[j] = temper
    s.t[j] = st.current.time
  }
  // a blow leaves a shallow dent in the face (kept: up to DENTS, the oldest goes first)
  const pushDent = (x, y) => {
    const D = st.current.dents
    const v = shared.uDents.value[D.n % DENTS]
    // shallow (≈ 2°): it bends the reflections a touch; a deeper bowl would mirror the forge as a hot-looking dot
    v.set(x, y, 0.05 + Math.random() * 0.015, 0.0012 + Math.random() * 0.0005)
    D.n += 1
    shared.uDentOn.value = 1
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
    // white for an instant at the hit, then down through yellow and orange (Newton: exponential), spreading a
    // little as the heat soaks into the steel; temper rings form round it
    pushSplat(rx, ry, rx, ry, 0.12, 1.1, 3.0, 0.85)
    // a dent where the face took the blow
    _v3.set(0, 0, 1).applyQuaternion(mesh.quaternion)
    if (normal.dot(_v3) > 0.6) pushDent(rx, ry)
    Ls.combo = Math.min(6, Ls.combo + 1)
    // a third blow inside ~0.6 s and onward: the whole letter starts to come up to red
    const cap = Math.max(0, Ls.combo - 2) * 0.08
    Ls.heat = Math.max(Ls.heat, Math.min(cap, Ls.heat + 0.06 * Ls.combo))
    S.strikes += 1
    S.last.t = S.time
    S.last.x = rx
    S.last.y = ry
    S.last.i = i
    S.flashIn = 1
    // the flash sits just off the face, so inverse-square keeps it on the struck letter
    S.flashAt.copy(point).addScaledVector(normal, 0.28)
    if (reduced) return
    // the blow: a heavy letter barely moves. A centimetre of slide that friction stops at once (it creeps back
    // over seconds, no spring-back), a stiff, critically damped give along the depth, a tiny damped tip
    Ls.kzv -= 0.75 * Math.max(0, 1 + Ls.kz / 0.05)
    Ls.sdv += 2.6
    Ls.rxv += -_v2.y * 0.9
    Ls.ryv += _v2.x * 0.6
    field.burst(
      Math.round((lite ? 90 : 120) * rand(0.8, 1.2)),
      point.x,
      point.y,
      point.z + 0.02,
      normal.x * 0.8,
      normal.y * 0.8 + 0.35,
      normal.z * 0.8 + 0.3,
      0.85,
      5,
      19,
      0.88,
      1.05,
      0.22,
      0.62,
      0.35,
    )
    kick(0.8, -normal.x)
    S.pulseIn = Math.min(1.6, S.pulseIn + 0.8)
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
    _n.set(0, 0, 1).applyQuaternion(mesh.quaternion)
    mesh.getWorldPosition(_v).addScaledVector(_n, word.depth * 0.5)
    strike(i, _v, _n)
    return true
  }

  const canStrike = () => st.current.introStarted && allDown(st.current.L)

  // API for the HTML layer (pointer + keyboard)
  useEffect(() => {
    const api = {
      pick: (x, y) => !!raycastLetters(x, y) || nearestLetter(x, y) >= 0,
      strikeAt: (x, y) => {
        if (motion.exit > 0.02 || !canStrike()) return false
        const hit = raycastLetters(x, y)
        if (hit) {
          strike(meshes.current.indexOf(hit.object), hit.point, hitNormal(hit))
          return true
        }
        const i = nearestLetter(x, y)
        return i >= 0 ? strikeToward(i, x, y) : false
      },
      strikeRandom: () => {
        if (!canStrike()) return false
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

  /* ---------------- entrance: dropped onto the plate, left to right, white-hot ---------------- */
  // each letter is let go by its own fall time before its landing, so the landings keep a 90 ms beat
  const startIntro = () => {
    const S = st.current
    S.introStarted = true
    S.introAt = S.time
    let tmax = 0
    for (let i = 0; i < S.L.length; i++) {
      prepare(i)
      tmax = Math.max(tmax, S.L[i].tf)
    }
    S.L.forEach((Ls, i) => {
      Ls.phase = 0
      Ls.t0 = 0.03 + tmax + i * STEP - Ls.tf
    })
  }

  // lens axis (from the word toward the resting camera)
  const lensAxis = (F, out) => out.set(Math.sin(F.yaw) * Math.cos(F.el), Math.sin(F.el), Math.cos(F.yaw) * Math.cos(F.el))

  // an impact bumps the camera rig: a half-sine force over 50 ms, never an instant jump
  const kick = (mag, dirx = rand(-0.5, 0.5)) => {
    if (reduced) return
    const R = st.current.rig
    if (R.kicks.length > 5) R.kicks.shift()
    R.kicks.push({ t0: st.current.time, fx: dirx * mag, fy: -mag })
  }

  // where letter i is let go: just above the top of the frame and a little toward the lens; it falls from rest
  // (a long drop starts with a little downward speed so it never hangs for more than half a second)
  const prepare = (i) => {
    const S = st.current
    const F = S.frame
    const Ls = S.L[i]
    lensAxis(F, _ax)
    const U = F.entryU[i]
    const B = F.entryB
    Ls.p0[0] = _ax.x * B
    Ls.p0[1] = _ax.y * B + U
    Ls.p0[2] = _ax.z * B
    Ls.tf = Math.min(Math.sqrt((2 * U) / G), FALL_MAX)
  }

  const launch = (i) => {
    const S = st.current
    const Ls = S.L[i]
    prepare(i)
    // ballistic from the start point to the plate
    const tf = Ls.tf
    Ls.v0[0] = -Ls.p0[0] / tf
    Ls.v0[1] = (-Ls.p0[1] + 0.5 * G * tf * tf) / tf
    Ls.v0[2] = -Ls.p0[2] / tf
    // no torque in the air: it turns at a steady rate and is still a few degrees off flat when it lands
    Ls.wx = (LAND_RX - ENTRY_RX) / tf
    Ls.wy = (ENTRY_RY[i] * 0.3 - ENTRY_RY[i]) / tf
    Ls.phase = 1
    Ls.c = SLAM_C
    Ls.clr = 0
    Ls.scale = 1
  }

  const land = (i) => {
    const S = st.current
    const Ls = S.L[i]
    const L = word.letters[i]
    const mesh = meshes.current[i]
    const vyI = -(Ls.v0[1] - G * Ls.tf) // downward speed at impact
    Ls.phase = 2
    Ls.ox = 0
    Ls.oy = 0
    Ls.oz = 0
    // the blow kills most of the run; what is left is a short skid the springs take up
    Ls.vx = Ls.v0[0] * 0.12
    Ls.vy = vyI * RESTITUTION
    Ls.vz = Ls.v0[2] * 0.12
    Ls.sqv += vyI * 0.55
    // the turn it came in with carries straight on through the contact, and the plate rocks it flat
    Ls.rx = LAND_RX
    Ls.rxv = Ls.wx
    Ls.ry = ENTRY_RY[i] * 0.3
    Ls.ryv = Ls.wy
    kick(Math.min(1.6, vyI * 0.085) * (i === word.letters.length - 1 ? 1.25 : 1))
    if (reduced || !mesh) return
    // sparks and scale skate off the plate from under the foot
    mesh.updateMatrix()
    const n = lite ? 34 : 62
    for (const [a, b] of L.feet) {
      const m = Math.max(4, Math.round((n * (b - a)) / L.w))
      for (let j = 0; j < m; j++) {
        _v.set(rand(a, b), L.bottom + 0.01, rand(-0.5, 0.5) * L.d).applyMatrix4(mesh.matrix)
        const side = Math.sign(_v.x - mesh.position.x) || (Math.random() < 0.5 ? -1 : 1)
        // mostly short, a few long fast ones
        const sp = 2.2 + 15 * Math.pow(Math.random(), 1.8)
        field.emit(
          _v.x,
          word.floorY + 0.01,
          _v.z,
          side * rand(0.5, 1) * sp,
          rand(0.15, 0.7) * sp,
          rand(-0.1, 0.9) * sp,
          rand(0.25, 0.6),
          rand(0.86, 1.02),
          0.0055 + Math.random() * 0.007,
          rand(2.4, 4.4),
          1,
          0.3,
        )
      }
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
  // how high above its place letter i must start to be just wholly above the top of the frame (so it shows
  // within a few frames of being let go)
  const entryHeight = (i, F) => {
    const L = word.letters[i]
    lensAxis(F, _ax)
    const tip = (L.d / 2) * Math.abs(Math.sin(ENTRY_RX))
    for (let U = 0.4; U < 16; U += 0.03) {
      let lo = Infinity
      _e.set(ENTRY_RX, F.turn + YAW_JITTER[i] + ENTRY_RY[i], 0)
      for (let c = 0; c < 8; c++) {
        _v.set(c & 1 ? L.w / 2 : -L.w / 2, c & 2 ? L.h / 2 : -L.h / 2, c & 4 ? L.d / 2 : -L.d / 2)
          .applyEuler(_e)
          .add(_v2.set(st.current.lx[i] + _ax.x * F.entryB, L.y + _ax.y * F.entryB + U + tip, _ax.z * F.entryB))
          .project(camera)
        lo = Math.min(lo, _v.y)
      }
      if (lo > 1.005) return U
    }
    return 16
  }
  const solveFrame = (W, H, band) => {
    const S = st.current
    const F = S.frame
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
    F.entryB = portrait ? 0.5 : 0.9
    for (let i = 0; i < word.letters.length; i++) {
      S.lx[i] = word.letters[i].x * F.spread
      mats[i].userData.uniforms.uRest.value.x = S.lx[i]
    }
    const top = band ? band.top : H * 0.14
    const bottom = band ? band.bottom : H * 0.6
    const bandH = Math.max(90, bottom - top)
    const fillW = portrait ? 1.03 : clamp(0.86 - (aspect - 1.6) * 0.04, 0.82, 0.87)
    const fillH = portrait ? 0.92 : 0.7
    camera.fov = F.fov
    camera.aspect = aspect
    camera.near = 0.1
    camera.far = 120
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
    field.material.uniforms.uAspect.value = aspect
    _plane.constant = -F.front

    // hit zone for the cursor label: the word's box through the resting camera
    camera.setViewOffset(W, H, F.ox, F.oy, W, H)
    camera.updateMatrixWorld()
    const z = projectWord(W, H)
    motion.zone = { left: z.x0, top: z.y0, width: z.x1 - z.x0, height: z.y1 - z.y0 }
    motion.onZone?.()
    for (let i = 0; i < word.letters.length; i++) F.entryU[i] = entryHeight(i, F)

    // the mid-ground: a roof post standing in the right-hand margin of the frame, a little behind the word and
    // under the work lamp, so the face it turns to the word is lamp-lit (and glows when the letters are hot)
    if (post.current) {
      // the whole post stands in frame, its far edge a few px in from the side; it stands just behind the lamp,
      // so both faces the camera sees are lamp-lit, brightest near the top
      const pd = F.D * 1.55
      const pxu = H / 2 / (pd * Math.tan(THREE.MathUtils.degToRad(F.fov / 2)))
      const hwPx = POST_W * 0.68 * pxu
      _ndc.set(((W - 6 - hwPx) / W) * 2 - 1, 0)
      _ray.setFromCamera(_ndc, camera)
      _v.copy(_ray.ray.origin).addScaledVector(_ray.ray.direction, pd)
      const cx = camera.position.x
      const cz = camera.position.z
      post.current.position.set(_v.x, word.floorY, _v.z)
      post.current.rotation.set(0, Math.atan2(cx - _v.x, cz - _v.z), 0)
      env.postMat.uniforms.uTheta.value = Math.atan2(cx - _v.x, cz - _v.z)
    }
  }

  /* ---------------- per frame ---------------- */
  useFrame((state, delta) => {
    const S = st.current
    const dt = Math.min(delta, 1 / 20)
    if (import.meta.env.DEV) {
      S.info.calls = gl.info.render.calls
      S.info.tris = gl.info.render.triangles
      gl.info.reset()
    }
    S.time += dt
    const now = S.time
    const t = S.time
    const wall = performance.now() / 1000
    const { width: W, height: H } = state.size
    const F = S.frame

    S.frames += 1
    if (S.frames === 1) onFrame?.()
    // live once every program is compiled and two frames in a row have come at an even pace (lazy GPU work, such
    // as the post chain building its passes, is then behind us), or at most ~0.45 s after compiling whatever the
    // pace: a slow device must still get the word (dt is clamped, so its physics play correctly)
    S.calm = delta < 0.05 ? S.calm + 1 : 0
    if (!S.live && S.compiled && S.frames >= 3 && (S.calm >= 2 || wall - S.compiledAt > 0.45)) {
      S.live = true
      onLive?.()
    }
    // `go` can also come from the page's own fallback timer: then start as soon as the programs are ready
    if (!S.introStarted && motion.go && S.compiled && S.frames >= 2) startIntro()

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
    const dpr = state.viewport.dpr
    const rs = tier >= 2 ? 0.5 : tier === 1 ? 0.4 : 0.3
    reflector.setSize(W * dpr * rs, H * dpr * rs)

    /* quality governor: two slow seconds in a row on a real GPU step the render cost down (never back up). It
       never steps during the entrance (a resolution change mid-slam would show); it judges from 3.5 s on */
    const P = S.perf
    if (!software && S.introStarted && S.time - S.introAt > 3.5 && !document.hidden) {
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

    // scroll input is low-passed before it drives the camera and the letters (a jittery touch scroll never
    // steps the dive); it settles within ~0.15 s of the scroll
    // critically damped (ω = 16/s, ≈ 0.12 s behind): no step in speed even when scroll events arrive unevenly
    const exT = reduced ? 0 : motion.exit
    if (Math.abs(exT - S.exitF) < 1e-5 && Math.abs(S.exitV) < 1e-4) {
      S.exitF = exT
      S.exitV = 0
    } else {
      const ne = Math.max(1, Math.ceil(dt * SUB_HZ - 1e-6))
      const he = dt / ne
      for (let s2 = 0; s2 < ne; s2++) {
        S.exitV += ((exT - S.exitF) * 256 - S.exitV * 32) * he
        S.exitF += S.exitV * he
      }
    }
    const exit = clamp(S.exitF, 0, 1)
    const live = S.introStarted && exit < 0.02

    /* pointer: low-pass filtered before it drives anything */
    const nsubP = Math.max(1, Math.ceil(dt * SUB_HZ - 1e-6))
    const hP = dt / nsubP
    const ptr = motion.ptr
    const pf = S.ptr
    if (ptr.active) {
      if (!pf.on) {
        pf.x = ptr.x
        pf.y = ptr.y
        pf.vx = 0
        pf.vy = 0
      }
      // critically damped (ω ≈ 38/s): the torch follows the hand with no steps in speed or direction
      for (let s2 = 0; s2 < nsubP; s2++) {
        pf.vx += ((ptr.x - pf.x) * 1444 - pf.vx * 76) * hP
        pf.vy += ((ptr.y - pf.y) * 1444 - pf.vy * 76) * hP
        pf.x += pf.vx * hP
        pf.y += pf.vy * hP
      }
    }
    pf.on = ptr.active

    /* torch: filtered pointer ray onto the letters' front plane */
    const T = S.torch
    let over = false
    if (live && pf.on && allDown(S.L)) {
      _ndc.set(pf.x, pf.y)
      _ray.setFromCamera(_ndc, camera)
      if (_ray.ray.intersectPlane(_plane, _v)) {
        over = Math.abs(_v.x) < (word.width / 2) * F.spread + 0.04 && _v.y > word.floorY - 0.02 && _v.y < word.top + 0.04
      }
    }
    if (over) {
      const dx = _v.x - T.x
      const dy = _v.y - T.y
      const dist = T.on ? Math.hypot(dx, dy) : 0
      if (!T.on) {
        T.sx = _v.x
        T.sy = _v.y
      }
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
      // a still torch slowly brings a spot up to red; a fast pass heats harder and leaves a glowing track
      // comes up toward its ceiling and eases into it (no hard clamp)
      T.heat += dt * (0.32 + Math.min(T.speed, 8) * 0.22) * Math.max(0, 1 - T.heat / 0.82)
      T.travel += dist
      // the track is laid as capsules, each from where the last one ended: continuous, never beads
      if (T.travel >= 0.09) {
        const hot = Math.min(0.46, Math.max(T.heat * 0.5, 0.2 + Math.min(T.speed, 9) * 0.03))
        const r = 0.082 + Math.min(T.speed, 6) * 0.004
        pushSplat(T.sx, T.sy, T.x, T.y, r, hot, 0.9, Math.min(0.55, hot * 1.1))
        T.sx = T.x
        T.sy = T.y
        T.travel = 0
      }
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
        T.grind += dt * Math.min(T.speed - 1.6, 9) * (lite ? 20 : 36)
        while (T.grind >= 1) {
          T.grind -= 1
          const sp = rand(4, 13) * (0.6 + Math.min(T.speed, 10) * 0.06)
          field.emit(
            T.x + rand(-0.04, 0.04),
            T.y + rand(-0.04, 0.04),
            F.front + 0.04,
            (T.dx * 0.85 + rand(-0.35, 0.35)) * sp,
            (T.dy * 0.6 + rand(0.05, 0.55)) * sp,
            rand(0.2, 0.9) * sp,
            rand(0.2, 0.5),
            rand(0.78, 0.96),
            0.005 + Math.random() * 0.006,
            rand(3, 5),
            1,
            0.15,
          )
        }
      }
    } else {
      T.on = false
      T.speed = 0
      // the spot under a torch that has left cools like everything else: exponentially
      T.heat *= Math.exp(-6 * dt)
      if (T.heat < 0.002) T.heat = 0
    }

    /* heat capsules: cool (Newton) and spread as the heat soaks into the steel; the temper film fades slowly */
    const spl = S.spl
    const U = shared.uSplats.value
    const UB = shared.uSplatB.value
    // slot 0: the torch, from where its last capsule ended to where it is now
    U[0].set(T.sx, T.sy, 0.085, T.heat)
    UB[0].set(T.x, T.y, 0, 0.085)
    let anySplat = T.heat > 0.002
    for (let j = 1; j < 32; j++) {
      const a = now - spl.t[j]
      const sp = 1 + 1.6 * a
      const k = (spl.i0[j] * Math.exp(-spl.k[j] * a)) / sp
      let tw = spl.tp[j] * Math.exp(-0.35 * a)
      if (tw < 0.005) tw = 0
      U[j].set(spl.x[j], spl.y[j], spl.r[j] * Math.sqrt(sp), k > 0.003 ? k : 0)
      UB[j].set(spl.x1[j], spl.y1[j], tw, spl.r[j])
      if (k > 0.003 || tw > 0) anySplat = true
    }
    shared.uSplatOn.value = anySplat ? 1 : 0

    /* letters: entrance flight, contact, springs (fixed 240 Hz substeps), cooling, exit flight */
    const introT = S.introStarted ? now - S.introAt : -1
    const nsub = Math.max(1, Math.ceil(dt * SUB_HZ - 1e-6))
    const h = dt / nsub
    // the hottest glow, as a soft max (Σg⁴ / Σg³): no kink when the hottest letter changes
    let g3 = 0
    let g4 = 0
    let hx = 0
    let hw = 0
    let allLanded = true
    let maxHeat = 0
    const de = exit - S.prevExit
    S.prevExit = exit
    const flyFrom = F.portrait || lite ? 0.1 : 0.06
    lensAxis(F, _ax)
    const ax = _ax.x
    const ay = _ax.y
    const az = _ax.z
    for (let i = 0; i < S.L.length; i++) {
      const Ls = S.L[i]
      const L = word.letters[i]
      const mesh = meshes.current[i]
      if (Ls.phase === 0 && introT >= Ls.t0) launch(i)
      if (Ls.phase === 1 && introT - Ls.t0 >= Ls.tf) land(i)
      if (Ls.phase !== 2) allLanded = false
      for (let s = 0; s < nsub; s++) {
        // straight out of the fire: it barely loses heat in the half second it falls, then the plate and the air
        // take it (radiation, then convection)
        if (Ls.phase >= 1 && Ls.c > AMBIENT_C + 0.5) Ls.c += coolRate(Ls.c) * h * (Ls.phase === 1 ? 0.25 : 1)
        if (Ls.phase !== 2) continue
        // a short hop off the plate under gravity, then rest
        if (Ls.oy > 0 || Ls.vy > 0) {
          Ls.vy -= G * h
          Ls.oy += Ls.vy * h
          if (Ls.oy <= 0) {
            Ls.oy = 0
            if (-Ls.vy > 0.35) {
              Ls.sqv += -Ls.vy * 0.35
              Ls.vy = -Ls.vy * RESTITUTION
            } else Ls.vy = 0
          }
        }
        Ls.vx += (-Ls.ox * 404 - Ls.vx * 28) * h
        Ls.ox += Ls.vx * h
        Ls.vz += (-Ls.oz * 404 - Ls.vz * 28) * h
        Ls.oz += Ls.vz * h
        // rocking flat on the plate (ζ 0.5: one small rock, then still)
        Ls.rxv += (-Ls.rx * 800 - Ls.rxv * 28.3) * h
        Ls.rx += Ls.rxv * h
        Ls.ryv += (-Ls.ry * 800 - Ls.ryv * 28.3) * h
        Ls.ry += Ls.ryv * h
        Ls.sqv += (-Ls.sq * 1934 - Ls.sqv * 28) * h
        Ls.sq += Ls.sqv * h
        // a blow's slide: friction stops it within ~50 ms; a very weak pull brings it home over seconds
        Ls.kzv += (-Ls.kz * 4 - Ls.kzv * 40) * h
        Ls.kz += Ls.kzv * h
        // the give along the depth: stiff and critically damped (no wobble)
        Ls.sdv += (-Ls.sd * 900 - Ls.sdv * 60) * h
        Ls.sd += Ls.sdv * h
      }
      // Newtonian cooling of strike/torch heat
      Ls.heat = Math.max(0, Ls.heat - dt * (Ls.heat * 0.34 + 0.01))
      Ls.combo = Math.max(0, Ls.combo - dt * 1.6)
      const fl = FLIGHT[i]
      const k = fl ? clamp((exit - flyFrom - fl.delay) / FLY, 0, 1) : 0
      // thrown clear: the flight eases in (no step in acceleration) and is fastest as it passes the lens
      const kk = Math.pow(k, 2.4)
      const base = Ls.phase >= 1 || reduced ? celsiusToHeat(Ls.c) : 0
      Ls.temp = Math.min(1.25, base + Ls.heat)
      maxHeat = Math.max(maxHeat, base)
      // mill scale: a dark skin forms while the steel glows; once the glow is gone it flakes off over ~0.6 s, and a faint
      // straw film shows along the arrises as it goes, dulling over a few seconds (one way only: never back)
      // (it starts as the last faint glow goes, so the word never sits as black shapes in the dark)
      if (Ls.temp > 0.075) {
        Ls.clr = 0
        Ls.scale = damp(Ls.scale, 1, 14, dt)
      } else if (Ls.clr < 1) {
        Ls.clr = Math.min(1, Ls.clr + dt / 0.6)
        Ls.scale = Math.min(Ls.scale, 1 - smoother(0, 1, Ls.clr))
        Ls.tint = Math.max(Ls.tint, 0.5 * smoother(0, 1, Ls.clr) * (Ls.phase >= 1 ? 1 : 0))
      } else {
        Ls.scale = 0
        Ls.tint *= Math.exp(-0.35 * dt)
      }
      // exit: a thin hot glint runs along the arrises while a letter is in flight (fastest past the lens); the O
      // the camera dives through glints as it closes in
      Ls.rim = reduced ? 0 : fl ? 0.5 * Math.pow(Math.sin(Math.PI * k), 2) : 0.4 * smooth(0.12, 0.36, exit)
      // its light comes up with a curve as it nears (it was already hot, just further away)
      if (Ls.phase >= 1 && !reduced) Ls.light = smoother(0, 0.18, introT - Ls.t0)
      const u = mats[i].userData.uniforms
      u.uTemp.value = Ls.temp
      u.uScale.value = Ls.scale
      u.uTint.value = Ls.tint
      u.uRim.value = Ls.rim
      const glowT = (Ls.temp + Ls.rim * 0.12) * Ls.light
      g3 += glowT * glowT * glowT
      g4 += glowT * glowT * glowT * glowT
      hx += S.lx[i] * glowT
      hw += glowT
      if (!mesh) continue
      mesh.visible = k < 0.999
      // before its throw a letter waits as a speck off-screen (it is drawn, so its programs are warm)
      const shown = Ls.phase >= 1
      const breathe = reduced || !shown ? 0 : Math.sin(t * 1.1 + i * 0.9) * 0.0015
      let fx = 0
      let fy = 0
      let fz = 0
      let frx = 0
      let fry = 0
      if (Ls.phase === 1) {
        const tau = introT - Ls.t0
        fx = Ls.p0[0] + Ls.v0[0] * tau
        fy = Ls.p0[1] + Ls.v0[1] * tau - 0.5 * G * tau * tau
        fz = Ls.p0[2] + Ls.v0[2] * tau
        frx = ENTRY_RX + Ls.wx * tau
        fry = ENTRY_RY[i] + Ls.wy * tau
      } else if (Ls.phase === 0) {
        prepare(i)
        fx = Ls.p0[0]
        fy = Ls.p0[1]
        fz = Ls.p0[2]
        frx = ENTRY_RX
        fry = ENTRY_RY[i]
      } else {
        fx = Ls.ox
        fy = Ls.oy
        fz = Ls.oz
      }
      // landing squash (vertical, about the foot) and hammer squash (along the depth)
      const sy = 1 - 0.1 * Ls.sq
      const sxz = 1 + 0.05 * Ls.sq
      const sd = Ls.sd
      const sc = shown ? 1 + breathe : 1e-4
      mesh.scale.set(sc * sxz * (1 + sd * 0.07), sc * sy * (1 + sd * 0.05), sc * sxz * Math.max(0.35, 1 - sd * 0.38))
      const fd = fl ? fl.d : null
      const zk = Ls.kz
      // tipped about its middle, its lowest edge would dip under the plate: stand it on that edge instead
      const tip = (L.d / 2) * Math.abs(Math.sin(Ls.rx + frx))
      mesh.position.set(
        S.lx[i] + fx + ax * zk + (fd ? fd[0] * kk : 0),
        L.y + fy + tip + ay * zk - (1 - sy) * L.h * 0.5 + (fd ? fd[1] * kk + Math.pow(Math.sin(k * Math.PI), 2) * 0.3 : 0),
        fz + az * zk + (fd ? fd[2] * kk : 0),
      )
      mesh.rotation.set(Ls.rx + frx + (fl ? fl.s[0] * kk : 0), F.turn + YAW_JITTER[i] + Ls.ry + fry + (fl ? fl.s[1] * kk : 0), fl ? fl.s[2] * kk : 0)
      mesh.updateMatrix()
      // a few sparks shed off the hot edges as they fly
      if (!reduced && de > 0 && k > 0.02 && k < 0.95) {
        let n = de * (lite ? 110 : 220) + Math.random()
        while (n >= 1) {
          n -= 1
          field.emit(
            mesh.position.x + rand(-0.45, 0.45) * L.w,
            mesh.position.y + rand(-0.45, 0.45),
            mesh.position.z,
            rand(-2, 2),
            rand(0.3, 3),
            rand(-2.5, 0.5),
            rand(0.25, 0.5),
            rand(0.78, 0.95),
            0.005 + Math.random() * 0.005,
            2.5,
            1,
            0.2,
          )
        }
      }
    }
    const tMax = g3 > 1e-9 ? g4 / g3 : 0
    // the copy lands as the whole word passes through orange
    if (!S.copied && S.introStarted && allLanded && maxHeat < COPY_HEAT) {
      S.copied = true
      motion.onCopy?.()
    }

    /* contact shadows: each foot's segment on the floor, fading as the letter lifts */
    const fu = env.floorMat.uniforms
    let fi = 0
    for (let i = 0; i < S.L.length && fi < FOOT_N; i++) {
      const mesh = meshes.current[i]
      const L = word.letters[i]
      const Ls = S.L[i]
      if (!mesh) continue
      for (let j = 0; j < L.feet.length && fi < FOOT_N; j++) {
        _v.set(L.feet[j][0], L.bottom, 0).applyMatrix4(mesh.matrix)
        _v2.set(L.feet[j][1], L.bottom, 0).applyMatrix4(mesh.matrix)
        const lift = Math.min(_v.y, _v2.y) - word.floorY
        fu.uFoot.value[fi].set(_v.x, _v.z, _v2.x, _v2.z)
        const kf = Ls.phase >= 1 && mesh.visible && mesh.scale.x > 0.5 ? clamp(1 - lift * 2.2, 0, 1) : 0
        fu.uFootK.value[fi] = kf
        // a glowing foot lights the plate right where it stands
        const g = Math.min(Ls.temp, 1) * Ls.light * kf
        blackbody(g, _col)
        const ge = g > 0.02 ? heatGain(g) * 0.8 : 0
        fu.uFootC.value[fi].set(_col[0] * ge, _col[1] * ge, _col[2] * ge)
        fi++
      }
    }
    for (; fi < FOOT_N; fi++) {
      fu.uFootK.value[fi] = 0
      fu.uFootC.value[fi].set(0, 0, 0)
    }
    fu.uFootHalf.value = word.depth * 0.45
    if (post.current) fu.uPostFoot.value.set(post.current.position.x, post.current.position.z, POST_W * 0.5, 1)

    /* sparks + embers */
    field.update(dt, word.floorY, t, reduced)

    /* camera rig: spring (≈ 6 Hz, lightly damped) driven by the impact pulses, integrated at 240 Hz */
    const R = S.rig
    for (let s2 = 0; s2 < nsub; s2++) {
      const tt = now - dt + (s2 + 1) * h
      let fx = 0
      let fy = 0
      for (let j = 0; j < R.kicks.length; j++) {
        const k = R.kicks[j]
        const a = (tt - k.t0) / 0.06
        if (a > 0 && a < 1) {
          // raised cosine: the force builds and releases smoothly
          const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * a)
          fx += k.fx * w * 42
          fy += k.fy * w * 42
        }
      }
      R.vx += (fx - R.x * 1420 - R.vx * 17) * h
      R.vy += (fy - R.y * 1420 - R.vy * 17) * h
      R.x += R.vx * h
      R.y += R.vy * h
    }
    while (R.kicks.length && now - R.kicks[0].t0 > 0.07) R.kicks.shift()

    /* camera: rest framing, a hint of parallax, handheld drift, impact bumps, then the dive through the O */
    // light never switches on: a ~30 ms attack, then an exponential fall
    S.flash = damp(S.flash, S.flashIn, 40, dt)
    S.flashIn *= Math.exp(-dt * 12)
    S.pulse = damp(S.pulse, S.pulseIn, 30, dt)
    S.pulseIn *= Math.exp(-dt * 3.2)
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
      _p.set(O.hole.x, O.hole.y, 0).applyMatrix4(Om.matrix)
      _n.set(0, 0, 1).applyQuaternion(Om.quaternion).normalize()
      const d0 = _v.distanceTo(_p)
      for (let j = 0; j < DIVE_D.length; j++) _dive[j] = j === 0 ? d0 : j === 1 ? d0 * DIVE_D[1] : DIVE_D[j]
      const dist = diveAt(exit, _dive, diveSlopes(_dive))
      _dr.subVectors(_v, _p).normalize().lerp(_n, bl).normalize()
      _v2.subVectors(_t0, _v).normalize()
      _v.copy(_p).addScaledVector(_dr, dist)
      _v2.lerp(_v3.copy(_n).negate(), bl).normalize()
      _t0.copy(_v).add(_v2)
    }
    // handheld: slow smooth drift (well under 1 Hz, a few millimetres), moving eye and aim together
    _cr.set(Math.cos(F.yaw), 0, -Math.sin(F.yaw))
    _cu.set(0, 1, 0)
    if (!reduced) {
      const hxd = (noise1(t * 0.23) * 0.6 + noise1(t * 0.11 + 40) * 0.4) * 0.009
      const hyd = (noise1(t * 0.19 + 13) * 0.6 + noise1(t * 0.09 + 71) * 0.4) * 0.007
      _v.addScaledVector(_cr, hxd).addScaledVector(_cu, hyd)
      _t0.addScaledVector(_cr, hxd * 0.6).addScaledVector(_cu, hyd * 0.6)
    }
    // impact bumps: the rig spring moves the eye (the aim follows a little behind) and rolls the frame a touch
    const sk = 1 - bl
    _v.addScaledVector(_cr, R.x * sk).addScaledVector(_cu, R.y * sk)
    _t0.addScaledVector(_cr, R.x * sk * 0.35).addScaledVector(_cu, R.y * sk * 0.35)
    camera.position.copy(_v)
    camera.lookAt(_t0)
    camera.rotateZ((reduced ? 0 : noise1(t * 0.17 + 29) * 0.0007) + R.x * sk * 0.12 + smooth(0.12, 0.5, exit) * 0.07)
    camera.fov = F.fov + 10 * smooth(0.2, 0.45, exit)
    // as the next section rises over the canvas, keep the dive centred in what is still visible
    const ye = smooth(0.05, 0.4, exit)
    const oy = F.oy * (1 - ye) + (H / 2 - (1 - exit) * H * 0.48) * ye
    const ox = F.ox * (1 - bl)
    camera.setViewOffset(W, H, ox, oy, W, H)
    camera.updateMatrixWorld()
    // focus: on the word, then on the O's counter as the camera dives through it
    const focusD = exit > 0.02 && Om && O.hole ? Math.max(2, camera.position.distanceTo(_p)) : camera.position.length()

    /* lights: the forge flickers (smooth noise), hot letters light the room, the hammer flashes */
    const flick = (reduced ? 1 : forgeFlicker(t)) + 0.25 * smooth(0.15, 0.45, exit)
    const wl = world.uLPos.value
    const wc = world.uLCol.value
    wl[0].set(FORGE_POS[0] + noise1(t * 0.9 + 7) * 0.06, FORGE_POS[1] + noise1(t * 1.3 + 9) * 0.05, FORGE_POS[2], 0.3)
    // the same flicker in the steel's reflections of the forge mouth (the environment holds the average)
    shared.uForgeEnv.value.set(FORGE_ENV[0], FORGE_ENV[1], FORGE_ENV[2]).multiplyScalar(flick - 1)
    wc[0].set(FORGE_COL[0], FORGE_COL[1], FORGE_COL[2]).multiplyScalar(FORGE_I * flick)
    wl[1].set(LAMP_POS[0], LAMP_POS[1], LAMP_POS[2], 1.2)
    wc[1].set(LAMP_COL[0], LAMP_COL[1], LAMP_COL[2]).multiplyScalar(LAMP_I)
    const pulse = S.pulse
    for (let i = 0; i < S.L.length; i++) {
      const mesh = meshes.current[i]
      const Ls = S.L[i]
      const g = (Ls.temp + Ls.rim * 0.12) * Ls.light * (mesh && mesh.visible && Ls.phase >= 1 ? 1 : 0)
      if (mesh) wl[2 + i].set(mesh.position.x, mesh.position.y, mesh.position.z, 0.3)
      // the light hot steel throws on the room is warmer than its surface reads (≈ 1,600 K at white heat: the
      // eye and the lens clip the surface toward white, not the light it casts)
      blackbody(Math.min(g, 1) * 0.8, _col)
      const gain = g > 0.004 ? heatGain(g) * 1.5 * (1 + (S.last.i === i ? S.flash * 0.5 : 0)) : 0
      wc[2 + i].set(_col[0] * gain, _col[1] * gain, _col[2] * gain)
    }
    world.uHaze.value.w = reduced ? 0 : t
    world.uHaze.value.z = 0.85
    // past the O the dive runs into the forge's smoke: the air thickens and the focus stays on the O, so the room
    // beyond goes soft and warm-dark before the cut
    world.uHaze.value.x = 0.012 + 0.17 * smooth(0.34, 0.62, exit)
    // a real lens at this framing: the word sharp, the wall a few courses soft (the aperture opens up in the dive)
    world.uFocus.value.set(focusD, (lite ? 0.09 : 0.11) + 0.1 * smooth(0.28, 0.55, exit))
    if (forgeLight.current) {
      const fl = forgeLight.current
      fl.position.set(wl[0].x, wl[0].y, wl[0].z)
      fl.color.setRGB(1, FORGE_COL[1] / FORGE_COL[0], FORGE_COL[2] / FORGE_COL[0])
      // on satin steel a point source only makes a pin-point glint; the forge is a broad mouth, so keep it a
      // faint flickering warmth (the environment's forge panel carries the broad warm sheen)
      fl.intensity = FORGE_I * flick * 0.12
    }
    if (light.current) {
      const pl = light.current
      blackbody(Math.max(0.7, Math.min(1, tMax)), _col)
      const m = Math.max(_col[0], _col[1], _col[2], 1e-4)
      pl.color.setRGB(_col[0] / m, _col[1] / m, _col[2] / m)
      const heatI = Math.pow(Math.min(tMax, 1.1), 1.7) * 3.4 * (1 - smooth(0.2, 0.5, exit))
      const flashI = S.flash * 1.1
      pl.intensity = heatI + flashI + pulse * 0.3
      // the light sits between the glowing letters and the hammer's flash, weighted by their strength; the flash
      // is a small source right at the face with a short reach, so it lights the struck letter, not its neighbours
      const fw = flashI / (flashI + heatI + 1e-3)
      pl.position.set(hw > 0.01 ? hx / hw : 0, 0.2, 1.1).lerp(S.flashAt, fw)
      pl.distance = 30 + (1.3 - 30) * fw
    }

    /* lens: hot air shimmers above glowing letters */
    if (lens) {
      const lu = lens.uniforms
      lu.get('uT').value = reduced ? 0 : t
      const hot = lu.get('uHot').value
      for (let i = 0; i < S.L.length; i++) {
        const mesh = meshes.current[i]
        const L = word.letters[i]
        const g = S.L[i].temp * S.L[i].light
        const s = reduced || !mesh || !mesh.visible ? 0 : Math.pow(clamp((g - 0.12) / 0.9, 0, 1), 1.4) * (1 - smooth(0, 0.1, exit))
        if (s <= 0 || !mesh) {
          hot[i].w = 0
          continue
        }
        _v.copy(mesh.position)
        _v.y += L.h * 0.45
        _v.project(camera)
        _v2.copy(mesh.position)
        _v2.x += L.w * 0.5
        _v2.project(camera)
        hot[i].set((_v.x + 1) / 2, (_v.y + 1) / 2, Math.max(0.01, Math.abs(_v2.x - _v.x) * 0.5 + 0.01), s)
      }
    }

    /* the floor's reflection, rendered small and blurred (the composer then renders the frame) */
    if (floor.current) {
      _hide[0] = floor.current
      reflector.render(gl, scene, camera, _hide, shared.uMirror, lite ? 1.2 : 1.6)
    }

    /* readout probe: the torch, the last strike, or the hottest letter, critically damped (≈ 0.15 s) so the
       number counts through its values like an instrument instead of jumping when the source changes */
    let probe
    if (T.on && T.i >= 0) probe = heatAt(S.L[T.i].temp, U, UB, T.x, T.y)
    else if (now - S.last.t < 2.4 && S.last.i >= 0) probe = heatAt(S.L[S.last.i].temp, U, UB, S.last.x, S.last.y)
    else probe = S.introStarted ? tMax : 0
    // (filtered in °C, which is what the reader sees: the scale is steep below the first glow)
    const probeC = heatToCelsius(probe)
    if (!S.rdOn) {
      S.rd = probeC
      S.rdOn = true
    }
    for (let s2 = 0; s2 < nsub; s2++) {
      S.rdV += ((probeC - S.rd) * 169 - S.rdV * 26) * h
      S.rd += S.rdV * h
    }
    motion.read.heat = celsiusToHeat(Math.max(AMBIENT_C, S.rd))
    motion.read.strikes = S.strikes
    if (import.meta.env.DEV) {
      motion.dbg = motion.dbg || { temps: [] }
      const d = motion.dbg
      d.frames = S.frames
      d.intro = S.introStarted
      for (let i = 0; i < S.L.length; i++) d.temps[i] = +S.L[i].temp.toFixed(3)
      d.frame = F
      d.introT = S.introStarted ? +(now - S.introAt).toFixed(3) : -1
      d.clearSparks = () => field.clear()
      d.floorDbg = (v) => (env.floorMat.uniforms.uDbg.value = v)
      d.settle = () => {
        for (const l of S.L) {
          if (l.phase === 0) launch(S.L.indexOf(l))
          l.phase = 2
          l.c = AMBIENT_C
          l.scale = 0
          l.clr = 1
          l.tint = 0
          l.light = 1
        }
        if (!S.copied) motion.onCopy?.()
        S.copied = true
        field.clear()
      }
      d.project = (i, fx2, fy2) => {
        const L = word.letters[i]
        const m = meshes.current[i]
        _v3.set(fx2 * L.w, fy2 * L.h, L.d / 2)
        m.localToWorld(_v3).project(camera)
        return { x: ((_v3.x + 1) / 2) * F.W, y: ((1 - _v3.y) / 2) * F.H }
      }
      const m0 = meshes.current[0]
      const m4 = meshes.current[4]
      window.__heroProbe = () => ({
        fy: m0 ? +m0.position.y.toFixed(4) : 0,
        fz: m0 ? +m0.position.z.toFixed(4) : 0,
        ey: m4 ? +m4.position.y.toFixed(4) : 0,
        esy: m4 ? +m4.scale.y.toFixed(4) : 0,
        camx: +camera.position.x.toFixed(5),
        camy: +camera.position.y.toFixed(5),
        camz: +camera.position.z.toFixed(5),
        heatI: light.current ? +light.current.intensity.toFixed(4) : 0,
        forgeI: forgeLight.current ? +forgeLight.current.intensity.toFixed(3) : 0,
        t0: +S.L[0].temp.toFixed(4),
        t2: +S.L[2].temp.toFixed(4),
        t4: +S.L[4].temp.toFixed(4),
        l0: +S.L[0].light.toFixed(4),
        exit: +exit.toFixed(4),
        rz: meshes.current[2] ? +meshes.current[2].position.z.toFixed(4) : 0,
        rsz: meshes.current[2] ? +meshes.current[2].scale.z.toFixed(4) : 0,
        rrx: meshes.current[2] ? +meshes.current[2].rotation.x.toFixed(4) : 0,
        px: +S.ptr.x.toFixed(4),
        tx: +T.x.toFixed(4),
        th: +T.heat.toFixed(4),
        introT: d.introT,
        sparks: field.alive.reduce((a, b) => a + b, 0) - field.embers,
        info: { calls: S.info.calls, tris: S.info.tris, programs: gl.info.programs?.length ?? 0, dpr, refl: [reflector.w, reflector.h] },
      })
    }
  }, -1)

  return (
    <>
      <mesh geometry={env.backGeo} material={env.backMat} position={[0, word.floorY + 13, WALL_Z]} renderOrder={-10} />
      <mesh
        geometry={env.sideGeo}
        material={env.sideMat}
        position={[SIDE_X, word.floorY + 13, WALL_Z + 22]}
        rotation={[0, -Math.PI / 2, 0]}
        renderOrder={-10}
      />
      <mesh
        ref={floor}
        geometry={env.floorGeo}
        material={env.floorMat}
        rotation-x={-Math.PI / 2}
        position={[0, word.floorY, WALL_Z + 32]}
        renderOrder={-9}
      />
      <mesh ref={post} geometry={env.postGeo} material={env.postMat} renderOrder={-4} />
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
          // drawn every frame, even parked off-screen before its throw: its programs are compiled before the
          // entrance, never during it
          frustumCulled={false}
        />
      ))}
      <primitive object={field.mesh} />
      <pointLight ref={light} intensity={0} decay={2} distance={0} />
      <pointLight ref={forgeLight} intensity={0} decay={2} distance={0} />
    </>
  )
}

/*
 * The bloom's bright-pass, extended: hot steel tags itself in alpha (1 + its glow), so incandescent metal glows
 * from orange heat up while a cold specular highlight of the same brightness does not (it needs the normal
 * threshold, like the sparks' white heads).
 */
const GLOW_FRAG = /* glsl */ `#include <common>
#ifdef FRAMEBUFFER_PRECISION_HIGH
uniform mediump sampler2D inputBuffer;
#else
uniform lowp sampler2D inputBuffer;
#endif
uniform float threshold;
uniform float smoothing;
varying vec2 vUv;
void main() {
  vec4 texel = texture2D(inputBuffer, vUv);
  float l = luminance(texel.rgb);
  float mask = smoothstep(threshold, threshold + smoothing, l);
  float e = clamp(texel.a - 1.0, 0.0, 1.0);
  mask = max(mask, e * 0.75 * smoothstep(0.05, 0.45, l));
  gl_FragColor = vec4(texel.rgb * mask, 1.0);
}`

function Post({ msaa, lens }) {
  const bloom = useRef(null)
  // (re-checked on every render: the effect is rebuilt when its props change)
  useLayoutEffect(() => {
    const m = bloom.current?.luminanceMaterial
    if (!m || m.fragmentShader === GLOW_FRAG) return
    m.fragmentShader = GLOW_FRAG
    m.needsUpdate = true
  })
  return (
    <EffectComposer multisampling={msaa}>
      {/* additive: the default screen blend goes negative on HDR input and fringes bright sparks cyan;
          a tight radius keeps white-hot letterforms defined, the haze carries the wide glow */}
      <Bloom ref={bloom} mipmapBlur blendFunction={BlendFunction.ADD} luminanceThreshold={1.1} luminanceSmoothing={0.3} intensity={0.85} radius={0.55} />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      <Vignette offset={0.3} darkness={0.5} />
      <primitive object={lens} />
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

// memoised: the page's own state changes (the copy cue, the scene-live flag) must not re-render the canvas tree
export const ForgedScene = memo(function ForgedScene({ motion, active = true, reduced = false, lite = false, onFrame, onLive }) {
  const [tier, setTier] = useState(lite ? 1 : 2)
  // a software rasteriser (no GPU) is never a visitor's real frame rate: don't adapt to it
  const [software, setSoftware] = useState(false)
  const lens = useMemo(() => new LensEffect(), [])
  useEffect(() => () => lens.dispose(), [lens])
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
      camera={{ position: [0, 1, 14], fov: FOV, near: 0.1, far: 120 }}
      onCreated={onCreated}
    >
      <color attach="background" args={[INK]} />
      <Room lite={lite} />
      <Forge
        motion={motion}
        reduced={reduced}
        lite={lite}
        software={software}
        tier={tier}
        lens={lens}
        onDecline={onDecline}
        onFrame={onFrame}
        onLive={onLive}
      />
      {/* MSAA only where it is worth it: above ~1.25 dpr the pixels are already small */}
      <Post msaa={tier >= 2 && !lite && dprFor(tier, lite) <= 1.25 ? 4 : 0} lens={lens} />
    </Canvas>
  )
})

export default ForgedScene
