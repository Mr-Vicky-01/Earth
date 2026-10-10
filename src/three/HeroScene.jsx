import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import { EffectComposer, Bloom, ChromaticAberration, Vignette } from '@react-three/postprocessing'
import { scroll } from '../lib/scroll'
import {
  KB_BADGE_BOTTOM_Y,
  KB_BADGE_BOTTOM_Z,
  KB_CENTER_Y,
  createKettlebellGeometry,
  createLabelTexture,
  disposeKettlebell,
} from './kettlebell'

const COBALT = '#2236ff'
const HEAT = '#ff4b1f'
const BASE_SPEED = 7
const REST_Z = 7.6
const FAR_Z = 18
const Z_NEAR = 5.5
const Z_FAR = -45
const Z_SPAN = Z_NEAR - Z_FAR

const REST_FOV = 34
const heatLinear = new THREE.Color(HEAT)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt))
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Is the frame tall/narrow? Then the kettlebell sits centred in the band between the top row and the headline. */
const isPortrait = (w, h) => w / h < 0.9 || (w < 900 && w / h < 1.25)

// portrait framing ---------------------------------------------------------------------------------------
const BOB = 0.06 // world units, idle float amplitude
const RIG_TILT = new THREE.Euler(0.1, 0, -0.13) // the rig's resting tilt (see Kettlebell)
// silhouette points in rig space (bell centred on the origin): handle top, lower edge of the badge
const P_TOP = new THREE.Vector3(0, 1.965 - KB_CENTER_Y, 0)
const P_BADGE = new THREE.Vector3(0, KB_BADGE_BOTTOM_Y - KB_CENTER_Y, KB_BADGE_BOTTOM_Z)
const fitCam = new THREE.PerspectiveCamera(REST_FOV, 1, 0.1, 90)
const fitV = new THREE.Vector3()

/** Screen y (px, no view offset) of a rig-space point at scale s, through the resting camera. */
function screenY(p, s, h) {
  fitV.copy(p).applyEuler(RIG_TILT).multiplyScalar(s).project(fitCam)
  return ((1 - fitV.y) / 2) * h
}

/**
 * Scale + vertical view offset that fit the bell into the free band of a stacked (portrait) layout.
 * band: { top, bottom } in CSS px from the top of the canvas. Everything down to the badge's lower edge stays
 * above the headline (only the strip under the badge may tuck behind it), the handle stays under the top row,
 * and the idle bob is reserved at both ends. Runs only when the size or the band changes.
 */
function portraitFrame(w, h, band, out) {
  fitCam.aspect = w / h
  fitCam.fov = REST_FOV
  fitCam.position.set(0, 0.72, REST_Z)
  fitCam.lookAt(0, 0, 0)
  fitCam.updateProjectionMatrix()
  fitCam.updateMatrixWorld()
  const pxPerUnit = h / (2 * Math.hypot(REST_Z, 0.72) * Math.tan(THREE.MathUtils.degToRad(REST_FOV / 2)))
  const bob = BOB * pxPerUnit
  const top = band.top + 8 + bob
  const bottom = band.bottom - 6 - bob
  const avail = Math.max(40, bottom - top)
  // widest silhouette ≈ belly diameter, plus a little for the tilt
  const sWide = (w - 48) / (2.2 * pxPerUnit)
  const cap = Math.min(w > 600 ? 0.7 : 0.95, sWide)
  let s = 0.6
  for (let i = 0; i < 4; i++) {
    const span = screenY(P_BADGE, s, h) - screenY(P_TOP, s, h)
    s = Math.min(cap, (s * avail) / span)
  }
  const yTop = screenY(P_TOP, s, h)
  const yBadge = screenY(P_BADGE, s, h)
  // the band is only filled when the scale isn't capped; otherwise centre the bell in it
  const shift = (top + bottom) / 2 - (yTop + yBadge) / 2
  out.s = s
  out.fx = 0
  out.fy = -shift / h
  return out
}

// right-hand silhouette (rig space, bell centred): outer edge of the handle's horn, then down the belly
const RIGHT_EDGE = [
  [0.72, 1.465],
  [0.72, 1.1],
  [0.72, 0.6],
  [0.9, 0.0],
  [1.0, -0.51],
  [0.88, -0.98],
].map(([x, y]) => new THREE.Vector3(x, y, 0))

function screenX(p, s, w) {
  fitV.copy(p).applyEuler(RIG_TILT).multiplyScalar(s).project(fitCam)
  return ((fitV.x + 1) / 2) * w
}

/**
 * Side-by-side layouts: the bell sits right of centre. Short or narrow frames shrink it and push it right/down
 * (heuristics tuned by eye), then a check keeps every part of the bell above the HUD's bottom edge out of the
 * HUD's column, sliding it left (or, without room, lower) when they'd overlap. Runs only on resize.
 */
function landscapeFrame(w, h, band, out) {
  const aspect = w / h
  let s = 0.84 * clamp(aspect / 1.55, 0.86, 1) * clamp(h / 820, 0.8, 1) * clamp(w / 1320, 0.86, 1)
  let fx = 0.175 + clamp((1320 - w) / 420, 0, 1) * 0.05
  let fy = 0.085 - clamp((820 - h) / 300, 0, 1) * 0.075
  if (band && band.hudLeft > 0) {
    fitCam.aspect = aspect
    fitCam.fov = REST_FOV
    fitCam.position.set(0, 0.72, REST_Z)
    fitCam.lookAt(0, 0, 0)
    fitCam.updateProjectionMatrix()
    fitCam.updateMatrixWorld()
    const pxPerUnit = h / (2 * Math.hypot(REST_Z, 0.72) * Math.tan(THREE.MathUtils.degToRad(REST_FOV / 2)))
    const bob = BOB * pxPerUnit
    const limitX = band.hudLeft - 14
    const limitY = band.top + 10 + bob
    for (let pass = 0; pass < 3; pass++) {
      let over = 0
      for (const p of RIGHT_EDGE) {
        const y = screenY(p, s, h) - fy * h
        if (y > limitY) continue
        over = Math.max(over, screenX(p, s, w) + fx * w - limitX)
      }
      if (over <= 0) break
      // slide left, but keep the bell's centre right of the middle so it never sits on the headline
      const room = Math.max(0, fx - 0.1) * w
      const slide = Math.min(over, room)
      fx -= slide / w
      if (slide < over) {
        // no room left: drop it a little and shrink it slightly, then check again
        fy -= 0.03
        s *= 0.94
      }
    }
  }
  out.s = s
  out.fx = fx
  out.fy = fy
  return out
}

/* ------------------------------------------------------------------ */
/* Warp streaks: thin boxes in a hollow cylinder, flying at the lens   */
/* Paper-white streaks fade into the cobalt fog. Heat streaks live in  */
/* their own mesh without fog (fog would mix heat + cobalt into pink)  */
/* and fade out at the far end by shrinking instead.                   */
/* ------------------------------------------------------------------ */
function Streaks({ count, motion, reduced, heat = false }) {
  const mesh = useRef(null)
  const geo = useMemo(() => new THREE.BoxGeometry(0.012, 0.012, 1), [])
  const mat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        // heat stays under the bloom threshold: a bright core in the real signal colour, no purple halo on cobalt
        color: heat ? heatLinear.clone().multiplyScalar(1.7) : new THREE.Color('#efeee9').multiplyScalar(1.22),
        toneMapped: false,
        fog: !heat,
      }),
    [heat],
  )
  // per instance: x, y, z, thickness, length factor, speed factor
  const data = useMemo(() => {
    const d = new Float32Array(count * 6)
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const r = 2.5 + Math.pow(Math.random(), 0.8) * 7.5
      d[i * 6] = Math.cos(a) * r
      d[i * 6 + 1] = Math.sin(a) * r
      d[i * 6 + 2] = Z_FAR + Math.random() * Z_SPAN
      d[i * 6 + 3] = (0.7 + Math.random() * 1.3) * (heat ? 1.6 : 1)
      d[i * 6 + 4] = 0.55 + Math.random() * 0.9
      d[i * 6 + 5] = 0.8 + Math.random() * 0.4
    }
    return d
  }, [count, heat])

  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    const arr = m.instanceMatrix.array
    for (let i = 0; i < count; i++) {
      const o = i * 16
      arr.fill(0, o, o + 16)
      arr[o + 15] = 1
    }
    m.instanceMatrix.needsUpdate = true
    m.frustumCulled = false
  }, [count])

  useEffect(
    () => () => {
      geo.dispose()
      mat.dispose()
    },
    [geo, mat],
  )

  useFrame(({ camera }, delta) => {
    const m = mesh.current
    if (!m) return
    const dt = Math.min(delta, 1 / 20)
    const speed = reduced ? 0 : BASE_SPEED * motion.warp
    // long enough at rest to read as light trails, not confetti; much longer at warp
    const len = reduced ? 1 : 0.9 + speed * 0.05
    const camZ = camera.position.z
    const arr = m.instanceMatrix.array
    for (let i = 0; i < count; i++) {
      const k = i * 6
      let z = data[k + 2] + speed * data[k + 5] * dt
      if (z > Z_NEAR) z -= Z_SPAN
      data[k + 2] = z
      const o = i * 16
      // thinner as they pass the lens, so near streaks stay light trails instead of planks
      const near = (camZ - z) / 11
      let t = data[k + 3] * (near < 0.3 ? 0.3 : near > 1.4 ? 1.4 : near)
      let l = len * data[k + 4]
      if (heat) {
        const f = smooth(Z_FAR + 2, Z_FAR + 24, z)
        t *= f
        l *= 0.25 + 0.75 * f
      }
      arr[o] = t
      arr[o + 5] = t
      arr[o + 10] = l
      arr[o + 12] = data[k]
      arr[o + 13] = data[k + 1]
      arr[o + 14] = z
    }
    m.instanceMatrix.needsUpdate = true
  })

  return <instancedMesh ref={mesh} args={[geo, mat, count]} />
}

/* ------------------------------------------------------------------ */
/* Silver kettlebell + camera rig + reactive lights                    */
/* ------------------------------------------------------------------ */
function Kettlebell({ motion, reduced }) {
  const geo = useMemo(() => createKettlebellGeometry(), [])
  const labelTex = useMemo(() => createLabelTexture(), [])
  const mats = useMemo(
    () => ({
      // satin silver steel: rough enough that it holds its own silver tone everywhere (a mirror only shows
      // its surroundings and went dark underneath), with a light lacquer for crisp highlights
      body: new THREE.MeshPhysicalMaterial({
        color: '#dadde6',
        metalness: 1,
        roughness: 0.26,
        clearcoat: 0.55,
        clearcoatRoughness: 0.1,
        envMapIntensity: 1.05,
      }),
      handle: new THREE.MeshPhysicalMaterial({
        color: '#d4d7e0',
        metalness: 1,
        roughness: 0.32,
        clearcoat: 0.4,
        clearcoatRoughness: 0.14,
        envMapIntensity: 1.0,
      }),
      foot: new THREE.MeshStandardMaterial({ color: '#191a26', metalness: 1, roughness: 0.34, envMapIntensity: 0.9 }),
      label: new THREE.MeshStandardMaterial({
        map: labelTex,
        transparent: true,
        metalness: 0.1,
        roughness: 0.38,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    }),
    [labelTex],
  )
  useEffect(() => () => disposeKettlebell(geo, [...Object.values(mats), labelTex]), [geo, mats, labelTex])

  const rig = useRef(null)
  const spinner = useRef(null)
  const rim = useRef(null)
  const lean = useRef({ x: 0, y: 0 })
  const frame = useRef({ s: 0.7, fx: 0, fy: 0.15, w: 0, h: 0, bt: 0, bb: 0, hl: 0 })

  useFrame((state, delta) => {
    const dt = Math.min(delta, 1 / 20)
    const { size, camera, clock } = state
    const portrait = isPortrait(size.width, size.height)
    const intro = motion.intro
    const exit = motion.exit
    const energy = motion.energy
    const pulse = motion.pulse
    const t = clock.elapsedTime

    // pointer lean (damped)
    const L = lean.current
    L.x = damp(L.x, reduced ? 0 : motion.px, 3.2, dt)
    L.y = damp(L.y, reduced ? 0 : motion.py, 3.2, dt)

    // camera: dolly in from warp, roll settles, FOV kicks with speed; each rep pulse punches in a touch
    const z = FAR_Z + (REST_Z - FAR_Z) * intro - exit * 1.2 - pulse * 0.45
    camera.position.set(L.x * 0.35, 0.72 - L.y * 0.22, z)
    camera.lookAt(0, 0.05 * exit, 0)
    camera.rotateZ((1 - intro) * 0.32)
    camera.fov = Math.min(54, REST_FOV + energy * 5 + (1 - intro) * 12 + exit * 12 + scroll.abs * 4 + pulse * 2.5)

    // composition: push the subject right (desktop) or fit it into the band above the headline (stacked)
    // framing is solved only when the size, the layout band or the orientation changes
    const band = motion.band
    const f = frame.current
    const bt = band ? band.top : -1
    const bb = band ? band.bottom : -1
    const hl = band ? band.hudLeft : -1
    if (f.w !== size.width || f.h !== size.height || f.bt !== bt || f.bb !== bb || f.hl !== hl) {
      f.w = size.width
      f.h = size.height
      f.bt = bt
      f.bb = bb
      f.hl = hl
      if (portrait && band && band.bottom > band.top) portraitFrame(size.width, size.height, band, f)
      else if (portrait) {
        f.s = clamp((size.width / size.height) * 1.3, 0.56, 0.9)
        f.fx = 0
        f.fy = 0.152
      } else landscapeFrame(size.width, size.height, band, f)
    }
    const { s, fx, fy } = f
    camera.setViewOffset(size.width, size.height, -fx * size.width, fy * size.height, size.width, size.height)

    // kettlebell
    const g = rig.current
    const sp = spinner.current
    if (g && sp) {
      g.scale.setScalar(s)
      const bob = reduced ? 0 : Math.sin(t * 1.15) * BOB
      // a rep pulse snaps the bell up a hair (no rotation: the bell never idles round), then it settles
      // scroll exit: rises, tips away and shoots off down the tunnel
      g.position.set(0, bob + pulse * (portrait ? 0.05 : 0.1) + exit * 1.6, -exit * exit * 12)
      g.rotation.set(0.1 + L.y * 0.12 + exit * 0.5, 0, -0.13 - L.x * 0.14)
      sp.rotation.set(motion.tilt + exit * 0.9, motion.angle + exit * Math.PI * 1.4, 0)
    }
    // heat rim catches the edge as it spins; the steel itself only warms a touch (it must stay silver, not pink)
    if (rim.current) rim.current.intensity = 6 + energy * 90 + pulse * 40 + (1 - intro) * 60
    const glow = Math.min(0.1, energy * 0.08 + pulse * 0.05)
    mats.body.emissive.copy(heatLinear)
    mats.body.emissiveIntensity = glow
    mats.handle.emissive.copy(heatLinear)
    mats.handle.emissiveIntensity = glow
  })

  return (
    <>
      <group ref={rig}>
        <group ref={spinner}>
          <group position-y={-KB_CENTER_Y}>
            <mesh geometry={geo.body} material={mats.body} />
            <mesh geometry={geo.handle} material={mats.handle} />
            <mesh geometry={geo.foot} material={mats.foot} />
            <mesh geometry={geo.label} material={mats.label} renderOrder={2} />
          </group>
        </group>
      </group>
      <spotLight position={[4.5, 7, 6]} angle={0.45} penumbra={0.9} intensity={90} decay={2} distance={0} color="#ffffff" />
      <pointLight ref={rim} position={[-2.6, 1.2, -3.6]} color={HEAT} intensity={6} decay={2} distance={0} />
      <pointLight position={[3.5, -2.5, 2.5]} color="#6f7dff" intensity={18} decay={2} distance={0} />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Studio for reflections: hard strips, a heat ring, a cobalt panel     */
/* ------------------------------------------------------------------ */
// memoised: <Environment> re-renders its cube map whenever its children change
const Studio = memo(function Studio() {
  return (
    <Environment resolution={256} frames={1}>
      {/* mid slate world: the silver reflects a mid tone everywhere, never black */}
      <color attach="background" args={['#4b5278']} />
      {/* big softbox overhead: smooth bright crown and shoulders */}
      <Lightformer form="rect" intensity={2.1} color="#ffffff" position={[0, 7, 2]} rotation-x={-Math.PI / 2.4} scale={[12, 6, 1]} />
      {/* tall side strips: long vertical highlights down each flank */}
      <Lightformer form="rect" intensity={4.2} position={[-6.5, 0.5, 2.5]} rotation-y={Math.PI / 2.6} scale={[1.6, 12, 1]} />
      <Lightformer form="rect" intensity={3} position={[6.5, 0.5, 1]} rotation-y={-Math.PI / 2.4} scale={[1, 12, 1]} />
      {/* light floor: the underside reflects a bright surface, so the bottom stays silver */}
      <Lightformer form="rect" intensity={1.25} color="#dfe2ec" position={[0, -6, 0]} rotation-x={Math.PI / 2} scale={[22, 22, 1]} />
      {/* soft horizon band from the camera side */}
      <Lightformer form="rect" intensity={0.55} color="#e9ecff" position={[0, -0.6, 9]} scale={[24, 3, 1]} />
      {/* cobalt bounce low-left so the steel sits in the scene's colour */}
      <Lightformer form="rect" intensity={1.4} color={COBALT} position={[-6, -2.5, 4]} rotation-y={Math.PI / 4} scale={[8, 4, 1]} />
      {/* heat rim from behind-right and a small heat glint */}
      <Lightformer form="rect" intensity={4} color={HEAT} position={[5, 1, -5]} rotation-y={-Math.PI / 4} scale={[1.2, 9, 1]} />
      <Lightformer form="circle" intensity={3} color={HEAT} position={[-4, 4.5, 3]} scale={0.9} />
    </Environment>
  )
})

/* ------------------------------------------------------------------ */
/* Post: bloom, speed-driven chromatic aberration, light vignette       */
/* ------------------------------------------------------------------ */
function Post({ motion, reduced, lite }) {
  const ca = useRef(null)
  const offset = useMemo(() => new THREE.Vector2(0.0004, 0.00015), [])
  useFrame(() => {
    const fx = ca.current
    if (!fx) return
    const o = reduced
      ? 0.0004
      : 0.0004 +
        motion.energy * 0.003 +
        scroll.abs * 0.0025 +
        (1 - motion.intro) * 0.003 +
        motion.exit * 0.001 +
        motion.pulse * 0.0015 +
        motion.burst * 0.0015
    // capped low: a hint of lens split at speed, not a cyan/magenta VHS look
    const c = Math.min(o, 0.003)
    fx.offset.set(c, c * 0.35)
  })
  return (
    <EffectComposer multisampling={lite ? 0 : 4}>
      <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.25} intensity={1.1} radius={0.72} />
      {/* radial modulation keeps the centre (the bell) clean; the split only shows toward the edges */}
      <ChromaticAberration ref={ca} offset={offset} radialModulation modulationOffset={0.3} />
      <Vignette offset={0.3} darkness={0.4} />
    </EffectComposer>
  )
}

/** `onFrame` on the first frame (the one that compiles the shaders), `onLive` once frames are flowing. */
function LiveSignal({ onFrame, onLive }) {
  const n = useRef(0)
  useFrame(() => {
    n.current += 1
    if (n.current === 1) onFrame?.()
    if (n.current === 2) onLive?.()
  })
  return null
}

export function HeroScene({ motion, active = true, reduced = false, lite = false, onFrame, onLive }) {
  const total = lite ? 260 : 500
  const heatCount = Math.round(total * 0.1)
  return (
    <Canvas
      dpr={lite ? [1, 1.5] : [1, 1.75]}
      frameloop={active ? 'always' : 'never'}
      gl={{ antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' }}
      camera={{ position: [0, 0.72, FAR_Z], fov: REST_FOV, near: 0.1, far: 90 }}
    >
      <color attach="background" args={[COBALT]} />
      <fog attach="fog" args={[COBALT, 9, 46]} />
      <Studio />
      <Kettlebell motion={motion} reduced={reduced} />
      <Streaks count={total - heatCount} motion={motion} reduced={reduced} />
      <Streaks count={heatCount} motion={motion} reduced={reduced} heat />
      <Post motion={motion} reduced={reduced} lite={lite} />
      <LiveSignal onFrame={onFrame} onLive={onLive} />
    </Canvas>
  )
}

export default HeroScene
