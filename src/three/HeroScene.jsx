import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import { EffectComposer, Bloom, ChromaticAberration, Vignette } from '@react-three/postprocessing'
import { scroll } from '../lib/scroll'
import { KB_CENTER_Y, createKettlebellGeometry, createLabelTexture, disposeKettlebell } from './kettlebell'

const COBALT = '#2236ff'
const HEAT = '#ff4b1f'
const BASE_SPEED = 7
const REST_Z = 7.6
const FAR_Z = 18
const Z_NEAR = 5.5
const Z_FAR = -45
const Z_SPAN = Z_NEAR - Z_FAR

const heatLinear = new THREE.Color(HEAT)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt))

/** Is the frame tall/narrow? Then the kettlebell sits centred in the top half. */
const isPortrait = (w, h) => w < 900 || w / h < 0.9

/* ------------------------------------------------------------------ */
/* Warp streaks: one InstancedMesh of thin boxes in a hollow cylinder  */
/* ------------------------------------------------------------------ */
function Streaks({ count, motion, reduced }) {
  const mesh = useRef(null)
  const geo = useMemo(() => new THREE.BoxGeometry(0.012, 0.012, 1), [])
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, fog: true }), [])
  // per instance: x, y, z, thickness, length factor, speed factor  (+ which ones run hot)
  const [data, hot] = useMemo(() => {
    const d = new Float32Array(count * 6)
    const h = new Uint8Array(count)
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const r = 2.5 + Math.pow(Math.random(), 0.8) * 7.5
      h[i] = Math.random() < 0.15 ? 1 : 0
      d[i * 6] = Math.cos(a) * r
      d[i * 6 + 1] = Math.sin(a) * r
      d[i * 6 + 2] = Z_FAR + Math.random() * Z_SPAN
      d[i * 6 + 3] = (0.7 + Math.random() * 1.3) * (h[i] ? 1.9 : 1)
      d[i * 6 + 4] = 0.55 + Math.random() * 0.9
      d[i * 6 + 5] = 0.8 + Math.random() * 0.4
    }
    return [d, h]
  }, [count])

  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    const paper = new THREE.Color('#efeee9').multiplyScalar(1.22)
    const heat = heatLinear.clone().multiplyScalar(4.2)
    const arr = m.instanceMatrix.array
    for (let i = 0; i < count; i++) {
      m.setColorAt(i, hot[i] ? heat : paper)
      const o = i * 16
      arr.fill(0, o, o + 16)
      arr[o + 15] = 1
    }
    m.instanceColor.needsUpdate = true
    m.frustumCulled = false
  }, [count, hot])

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
    const len = reduced ? 0.7 : 0.35 + speed * 0.05
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
      const t = data[k + 3] * (near < 0.3 ? 0.3 : near > 1.4 ? 1.4 : near)
      arr[o] = t
      arr[o + 5] = t
      arr[o + 10] = len * data[k + 4]
      arr[o + 12] = data[k]
      arr[o + 13] = data[k + 1]
      arr[o + 14] = z
    }
    m.instanceMatrix.needsUpdate = true
  })

  return <instancedMesh ref={mesh} args={[geo, mat, count]} />
}

/* ------------------------------------------------------------------ */
/* Chrome kettlebell + camera rig + reactive lights                    */
/* ------------------------------------------------------------------ */
function Kettlebell({ motion, reduced }) {
  const geo = useMemo(() => createKettlebellGeometry(), [])
  const labelTex = useMemo(() => createLabelTexture(), [])
  const mats = useMemo(
    () => ({
      // single-layer polished chrome: a clear coat on top doubled every reflection into hard bars
      chrome: new THREE.MeshStandardMaterial({ color: '#eceef4', metalness: 1, roughness: 0.13, envMapIntensity: 1.35 }),
      grip: new THREE.MeshStandardMaterial({ color: '#e6e8ef', metalness: 1, roughness: 0.17, envMapIntensity: 1.3 }),
      foot: new THREE.MeshStandardMaterial({ color: '#191a26', metalness: 1, roughness: 0.34, envMapIntensity: 0.9 }),
      band: new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }),
      label: new THREE.MeshStandardMaterial({
        map: labelTex,
        transparent: true,
        metalness: 0.6,
        roughness: 0.42,
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

  useFrame((state, delta) => {
    const dt = Math.min(delta, 1 / 20)
    const { size, camera, clock } = state
    const portrait = isPortrait(size.width, size.height)
    const intro = motion.intro
    const exit = motion.exit
    const energy = motion.energy
    const t = clock.elapsedTime

    // pointer lean (damped)
    const L = lean.current
    L.x = damp(L.x, reduced ? 0 : motion.px, 3.2, dt)
    L.y = damp(L.y, reduced ? 0 : motion.py, 3.2, dt)

    // camera: dolly in from warp, roll settles, FOV kicks with speed
    const z = FAR_Z + (REST_Z - FAR_Z) * intro - exit * 1.2
    camera.position.set(L.x * 0.35, 0.72 - L.y * 0.22, z)
    camera.lookAt(0, 0.05 * exit, 0)
    camera.rotateZ((1 - intro) * 0.32)
    camera.fov = Math.min(54, 34 + energy * 5 + (1 - intro) * 12 + exit * 12 + scroll.abs * 4)
    // composition: push the subject right (desktop) or up (phone) without changing perspective
    // narrower desktops push the bell further right so the headline and HUD keep clear of it
    const fx = portrait ? 0 : 0.175 + clamp((1320 - size.width) / 420, 0, 1) * 0.05
    // short desktop frames sit the bell lower so the handle clears the HUD in the top-right
    const fy = portrait ? 0.152 : 0.085 - clamp((820 - size.height) / 300, 0, 1) * 0.075
    camera.setViewOffset(size.width, size.height, -fx * size.width, fy * size.height, size.width, size.height)

    // kettlebell
    const g = rig.current
    const sp = spinner.current
    if (g && sp) {
      const aspect = size.width / size.height
      // short or narrow desktop frames get a smaller bell so the handle stays below the HUD
      const s = portrait
        ? clamp(aspect * 1.3, 0.56, 0.9)
        : 0.84 * clamp(aspect / 1.55, 0.86, 1) * clamp(size.height / 820, 0.8, 1) * clamp(size.width / 1320, 0.86, 1)
      g.scale.setScalar(s)
      const bob = reduced ? 0 : Math.sin(t * 1.15) * 0.06
      // scroll exit: rises, tips away and shoots off down the tunnel
      g.position.set(0, bob + exit * 1.6, -exit * exit * 12)
      g.rotation.set(0.1 + L.y * 0.12 + exit * 0.5, 0, -0.13 - L.x * 0.14)
      sp.rotation.set(motion.tilt + exit * 0.9, motion.angle + exit * Math.PI * 1.4, 0)
    }
    if (rim.current) rim.current.intensity = 6 + energy * 150 + (1 - intro) * 60
    mats.band.color.copy(heatLinear).multiplyScalar(4.5 + energy * 7)
  })

  return (
    <>
      <group ref={rig}>
        <group ref={spinner}>
          <group position-y={-KB_CENTER_Y}>
            <mesh geometry={geo.body} material={mats.chrome} />
            <mesh geometry={geo.handle} material={mats.grip} />
            <mesh geometry={geo.foot} material={mats.foot} />
            <mesh geometry={geo.band} material={mats.band} />
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
      <color attach="background" args={['#070a24']} />
      {/* broad soft key above-front: one smooth highlight across the crown and shoulders */}
      <Lightformer form="rect" intensity={2.6} color="#eef0ff" position={[0, 6, 4]} rotation-x={-Math.PI / 3} scale={[10, 5, 1]} />
      {/* tall side strips: long vertical highlights down each flank, the classic chrome read */}
      <Lightformer form="rect" intensity={5.5} position={[-6.5, 0.5, 2.5]} rotation-y={Math.PI / 2.6} scale={[1.6, 12, 1]} />
      <Lightformer form="rect" intensity={3.2} position={[6.5, 0.5, 1]} rotation-y={-Math.PI / 2.4} scale={[1, 12, 1]} />
      {/* soft fill from the camera side so the front never goes black */}
      <Lightformer form="rect" intensity={0.45} color="#c9d0ff" position={[0, -1.6, 9]} scale={[26, 2.4, 1]} />
      {/* heat rim from behind-right and a small heat glint */}
      <Lightformer form="rect" intensity={4} color={HEAT} position={[5, 1, -5]} rotation-y={-Math.PI / 4} scale={[1.2, 9, 1]} />
      <Lightformer form="circle" intensity={3} color={HEAT} position={[-4, 4.5, 3]} scale={0.9} />
      {/* deep cobalt floor so the lower half sits in the scene's colour */}
      <Lightformer form="rect" intensity={1.8} color={COBALT} position={[0, -6, 0]} rotation-x={Math.PI / 2} scale={[20, 20, 1]} />
    </Environment>
  )
})

/* ------------------------------------------------------------------ */
/* Post: bloom, speed-driven chromatic aberration, light vignette       */
/* ------------------------------------------------------------------ */
function Post({ motion, reduced, lite }) {
  const ca = useRef(null)
  const offset = useMemo(() => new THREE.Vector2(0.0005, 0.0002), [])
  useFrame(() => {
    const fx = ca.current
    if (!fx) return
    const o = reduced
      ? 0.0005
      : 0.0005 + motion.energy * 0.006 + scroll.abs * 0.004 + (1 - motion.intro) * 0.005 + motion.exit * 0.0015
    const c = Math.min(o, 0.006)
    fx.offset.set(c, c * 0.35)
  })
  return (
    <EffectComposer multisampling={lite ? 2 : 4}>
      <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.25} intensity={1.1} radius={0.72} />
      <ChromaticAberration ref={ca} offset={offset} radialModulation modulationOffset={0.12} />
      <Vignette offset={0.3} darkness={0.4} />
    </EffectComposer>
  )
}

/** Calls `onLive` once the scene has actually drawn a couple of frames. */
function LiveSignal({ onLive }) {
  const n = useRef(0)
  useFrame(() => {
    n.current += 1
    if (n.current === 3) onLive?.()
  })
  return null
}

export function HeroScene({ motion, active = true, reduced = false, lite = false, onLive }) {
  return (
    <Canvas
      dpr={[1, 1.75]}
      frameloop={active ? 'always' : 'never'}
      gl={{ antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' }}
      camera={{ position: [0, 0.72, FAR_Z], fov: 34, near: 0.1, far: 90 }}
    >
      <color attach="background" args={[COBALT]} />
      <fog attach="fog" args={[COBALT, 9, 46]} />
      <Studio />
      <Kettlebell motion={motion} reduced={reduced} />
      <Streaks count={lite ? 260 : 500} motion={motion} reduced={reduced} />
      <Post motion={motion} reduced={reduced} lite={lite} />
      <LiveSignal onLive={onLive} />
    </Canvas>
  )
}

export default HeroScene
