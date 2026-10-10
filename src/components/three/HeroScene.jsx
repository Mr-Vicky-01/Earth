import { Suspense, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Float, Sparkles } from '@react-three/drei'
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import { Studio } from './Studio'
import { SceneBoundary, SceneFallback } from './SceneBoundary'

const ACID = '#c6ff00'
const acidHot = new THREE.Color(ACID).multiplyScalar(2.6)

/** One rubber hex head of the dumbbell (axis along X). */
function Head({ side }) {
  return (
    <group position={[side * 1.55, 0, 0]} rotation={[Math.PI / 6, 0, Math.PI / 2]}>
      <mesh>
        <cylinderGeometry args={[0.8, 0.8, 1.02, 6]} />
        <meshStandardMaterial color="#121212" roughness={0.62} metalness={0.2} flatShading />
      </mesh>
      <mesh>
        <cylinderGeometry args={[0.815, 0.815, 0.1, 6]} />
        <meshStandardMaterial color={ACID} emissive={ACID} emissiveIntensity={2.2} toneMapped={false} />
      </mesh>
      <mesh>
        <cylinderGeometry args={[0.42, 0.42, 1.08, 48]} />
        <meshStandardMaterial color="#d5d5d5" metalness={1} roughness={0.22} />
      </mesh>
      <mesh>
        <cylinderGeometry args={[0.3, 0.3, 1.1, 48]} />
        <meshStandardMaterial color="#1a1a1a" metalness={0.9} roughness={0.35} />
      </mesh>
    </group>
  )
}

/** Chrome handle with knurl rings and collars. */
function Handle() {
  const knurl = useMemo(() => Array.from({ length: 16 }, (_, i) => -0.9 + (i * 1.8) / 15), [])
  return (
    <group rotation={[0, 0, Math.PI / 2]}>
      <mesh>
        <cylinderGeometry args={[0.165, 0.165, 2.5, 48]} />
        <meshStandardMaterial color="#cfcfcf" metalness={1} roughness={0.28} />
      </mesh>
      {knurl.map((y, i) => (
        <mesh key={i} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.168, 0.007, 8, 48]} />
          <meshStandardMaterial color="#3a3a3a" metalness={1} roughness={0.5} />
        </mesh>
      ))}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0, s * 1.08, 0]}>
          <cylinderGeometry args={[0.27, 0.27, 0.14, 48]} />
          <meshStandardMaterial color="#8a8a8a" metalness={1} roughness={0.3} />
        </mesh>
      ))}
    </group>
  )
}

/** Glowing orbit arcs around the dumbbell, with a small satellite. */
function Orbits() {
  const g = useRef()
  const sat = useRef()
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    g.current.rotation.z += Math.min(dt, 0.05) * 0.12
    g.current.rotation.x = Math.PI / 2.35 + Math.sin(t * 0.3) * 0.05
    sat.current.position.set(Math.cos(t * 0.5) * 3.4, Math.sin(t * 0.5) * 3.4, 0)
  })
  return (
    <group ref={g} rotation={[Math.PI / 2.35, 0.25, 0]}>
      <mesh>
        <torusGeometry args={[2.75, 0.009, 8, 220, Math.PI * 1.5]} />
        <meshBasicMaterial color={acidHot} toneMapped={false} />
      </mesh>
      <mesh>
        <torusGeometry args={[3.4, 0.005, 8, 260]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.22} />
      </mesh>
      <mesh ref={sat}>
        <sphereGeometry args={[0.05, 16, 16]} />
        <meshBasicMaterial color={acidHot} toneMapped={false} />
      </mesh>
    </group>
  )
}

/** The hero dumbbell: floats, tilts toward the pointer, and rotates/sinks with scroll. */
function Dumbbell({ scrollRef }) {
  const outer = useRef()
  const inner = useRef()
  const { viewport } = useThree()

  useFrame((state, dt) => {
    const p = scrollRef.current || 0
    const d = Math.min(dt, 0.05)
    const mobile = viewport.width < 6
    const scale = THREE.MathUtils.clamp(viewport.width / 9.4, 0.42, 0.92) * (1 - p * 0.3)
    outer.current.position.set(mobile ? 0 : viewport.width * 0.13, (mobile ? 1.4 : 0.6) - p * 3.2, 0)
    outer.current.scale.setScalar(scale)
    outer.current.rotation.y = p * Math.PI * 1.4
    inner.current.rotation.x = THREE.MathUtils.damp(inner.current.rotation.x, 0.42 - state.pointer.y * 0.28, 3.5, d)
    inner.current.rotation.y = THREE.MathUtils.damp(inner.current.rotation.y, -0.42 + state.pointer.x * 0.4, 3.5, d)
  })

  return (
    <group ref={outer}>
      <Float speed={1.4} rotationIntensity={0.22} floatIntensity={0.7} floatingRange={[-0.15, 0.15]}>
        <group ref={inner} rotation={[0.42, -0.42, 0.32]}>
          <Handle />
          <Head side={-1} />
          <Head side={1} />
        </group>
      </Float>
      <Orbits />
    </group>
  )
}

export function HeroScene({ scrollRef, active = true }) {
  return (
    <SceneBoundary>
      <Canvas
        fallback={<SceneFallback />}
        frameloop={active ? 'always' : 'never'}
        dpr={[1, 1.6]}
        camera={{ position: [0, 0, 8], fov: 35 }}
        gl={{ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <color attach="background" args={['#050505']} />
        <fog attach="fog" args={['#050505', 9, 17]} />
        <Suspense fallback={null}>
          <Studio />
          <Dumbbell scrollRef={scrollRef} />
          <Sparkles count={140} scale={[16, 10, 8]} size={1.8} speed={0.35} opacity={0.55} color={ACID} />
          <Sparkles count={90} scale={[18, 10, 6]} size={1.2} speed={0.2} opacity={0.35} color="#ffffff" />
          <EffectComposer multisampling={4}>
            <Bloom luminanceThreshold={1} mipmapBlur intensity={1.1} radius={0.75} />
            <Vignette eskil={false} offset={0.15} darkness={0.85} />
          </EffectComposer>
        </Suspense>
      </Canvas>
    </SceneBoundary>
  )
}
