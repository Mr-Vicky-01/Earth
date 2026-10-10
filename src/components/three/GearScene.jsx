import { Suspense, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Sparkles } from '@react-three/drei'
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import { Studio } from './Studio'
import { SceneBoundary, SceneFallback } from './SceneBoundary'

const ACID = '#c6ff00'
const SLEEVE_START = 2.25

export const PLATES = [
  { r: 0.95, t: 0.22, color: '#111113', stripe: ACID, kg: 25 },
  { r: 0.74, t: 0.18, color: '#1d1d21', stripe: '#f2f1ec', kg: 15 },
  { r: 0.58, t: 0.14, color: ACID, stripe: '#050505', kg: 10, glow: 0.35 },
]
/** Each plate animates in during [start, start + dur] of the section's scroll progress. */
export const PLATE_WINDOWS = PLATES.map((_, i) => ({ start: i * 0.28, dur: 0.24 }))
export const COLLAR_WINDOW = { start: 0.84, dur: 0.16 }

let acc = SLEEVE_START
const SLOTS = PLATES.map((p) => {
  const c = acc + p.t / 2
  acc += p.t + 0.02
  return c
})
const COLLAR_X = acc + 0.08

const easeOut = (t) => 1 - Math.pow(1 - t, 3)
const window01 = (p, { start, dur }) => THREE.MathUtils.clamp((p - start) / dur, 0, 1)

function Plate({ r, t, color, stripe, glow = 0 }) {
  const stripeGlow = stripe === ACID ? 1.8 : 0.35
  return (
    <group rotation={[0, 0, Math.PI / 2]}>
      <mesh>
        <cylinderGeometry args={[r, r, t, 72]} />
        <meshStandardMaterial color={color} roughness={0.55} metalness={0.15} emissive={color} emissiveIntensity={glow} />
      </mesh>
      <mesh>
        <cylinderGeometry args={[r + 0.004, r + 0.004, t * 0.34, 72, 1, true]} />
        <meshStandardMaterial color={stripe} emissive={stripe} emissiveIntensity={stripeGlow} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0, s * (t / 2 + 0.003), 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[r * 0.7, 0.006, 8, 96]} />
          <meshStandardMaterial color="#000000" roughness={0.9} />
        </mesh>
      ))}
      <mesh>
        <cylinderGeometry args={[0.22, 0.22, t + 0.02, 48]} />
        <meshStandardMaterial color="#cfcfcf" metalness={1} roughness={0.25} />
      </mesh>
    </group>
  )
}

function Barbell({ progressRef }) {
  const bar = useRef()
  const plates = useRef([])
  const collars = useRef([])
  const { viewport } = useThree()

  useFrame((state, dt) => {
    const p = progressRef.current || 0
    const d = Math.min(dt, 0.05)
    const mobile = viewport.width < 6
    const b = bar.current
    b.scale.setScalar(THREE.MathUtils.clamp(viewport.width / 9.6, 0.4, 1))
    b.position.x = mobile ? 0 : 0.7
    b.rotation.x += d * 0.5
    b.rotation.y = THREE.MathUtils.damp(b.rotation.y, (mobile ? 0.85 : 0.35) + state.pointer.x * 0.15 - p * 0.3, 3, d)
    b.rotation.z = THREE.MathUtils.damp(b.rotation.z, 0.08 + state.pointer.y * 0.06, 3, d)

    PLATES.forEach((_, i) => {
      const e = easeOut(window01(p, PLATE_WINDOWS[i]))
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -1 : 1
        const g = plates.current[i * 2 + k]
        if (!g) continue
        g.position.x = side * THREE.MathUtils.lerp(8, SLOTS[i], e)
        g.rotation.x = (1 - e) * Math.PI * 2 * side
      }
    })
    const ec = easeOut(window01(p, COLLAR_WINDOW))
    collars.current.forEach((g, k) => {
      if (!g) return
      const side = k === 0 ? -1 : 1
      g.position.x = side * THREE.MathUtils.lerp(6.5, COLLAR_X, ec)
      g.scale.setScalar(0.5 + 0.5 * ec)
    })
  })

  return (
    <group ref={bar} rotation={[0, 0.35, 0.08]}>
      <group rotation={[0, 0, Math.PI / 2]}>
        <mesh>
          <cylinderGeometry args={[0.075, 0.075, 4.5, 32]} />
          <meshStandardMaterial color="#d9d9d9" metalness={1} roughness={0.22} />
        </mesh>
        {[-1.3, 0, 1.3].map((y) => (
          <mesh key={y} position={[0, y, 0]}>
            <cylinderGeometry args={[0.077, 0.077, y === 0 ? 0.14 : 1.1, 32]} />
            <meshStandardMaterial color="#7d7d7d" metalness={1} roughness={0.55} />
          </mesh>
        ))}
        {[-1, 1].map((s) => (
          <mesh key={s} position={[0, s * 2.2, 0]}>
            <cylinderGeometry args={[0.17, 0.17, 0.1, 32]} />
            <meshStandardMaterial color="#9a9a9a" metalness={1} roughness={0.3} />
          </mesh>
        ))}
        {[-1, 1].map((s) => (
          <mesh key={s} position={[0, s * 2.95, 0]}>
            <cylinderGeometry args={[0.1, 0.1, 1.5, 32]} />
            <meshStandardMaterial color="#bdbdbd" metalness={1} roughness={0.3} />
          </mesh>
        ))}
      </group>

      {PLATES.map((pl, i) =>
        [-1, 1].map((side, k) => (
          <group key={`${i}-${k}`} ref={(el) => (plates.current[i * 2 + k] = el)} position={[side * 8, 0, 0]}>
            <Plate {...pl} />
          </group>
        )),
      )}

      {[-1, 1].map((side, k) => (
        <group key={k} ref={(el) => (collars.current[k] = el)} position={[side * 6.5, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
          <mesh>
            <cylinderGeometry args={[0.2, 0.2, 0.12, 32]} />
            <meshStandardMaterial color={ACID} emissive={ACID} emissiveIntensity={1.2} roughness={0.4} metalness={0.3} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

export function GearScene({ progressRef, active = true }) {
  return (
    <SceneBoundary>
      <Canvas
        fallback={<SceneFallback />}
        frameloop={active ? 'always' : 'never'}
        dpr={[1, 1.6]}
        camera={{ position: [0, 0, 8.5], fov: 35 }}
        gl={{ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <color attach="background" args={['#050505']} />
        <fog attach="fog" args={['#050505', 9, 18]} />
        <Suspense fallback={null}>
          <Studio />
          <Barbell progressRef={progressRef} />
          <Sparkles count={110} scale={[18, 10, 8]} size={1.6} speed={0.3} opacity={0.45} color={ACID} />
          <EffectComposer multisampling={4}>
            <Bloom luminanceThreshold={1} mipmapBlur intensity={0.9} radius={0.7} />
            <Vignette eskil={false} offset={0.2} darkness={0.9} />
          </EffectComposer>
        </Suspense>
      </Canvas>
    </SceneBoundary>
  )
}
