import { Environment, Lightformer } from '@react-three/drei'

/** Shared lighting rig: a few hard lights plus a procedural HDR-style environment (no external assets). */
export function Studio({ accent = '#c6ff00' }) {
  return (
    <>
      <ambientLight intensity={0.22} />
      <spotLight position={[5, 7, 6]} angle={0.55} penumbra={1} intensity={110} color="#ffffff" />
      <pointLight position={[-5, -3, -3]} intensity={40} color={accent} />
      <pointLight position={[0, -4, 4]} intensity={14} color="#ffffff" />
      <Environment resolution={256} frames={1}>
        <group rotation={[-Math.PI / 3, 0, 0]}>
          <Lightformer form="circle" intensity={5} rotation-x={Math.PI / 2} position={[0, 5, -9]} scale={2} />
          <Lightformer form="rect" intensity={3} rotation-y={Math.PI / 2} position={[-6, 1, -1]} scale={[8, 3, 1]} />
          <Lightformer form="rect" intensity={3} rotation-y={-Math.PI / 2} position={[6, 1, -1]} scale={[8, 3, 1]} />
          <Lightformer form="ring" color={accent} intensity={6} position={[0, -5, 2]} scale={5} />
          <Lightformer form="rect" color={accent} intensity={1.5} position={[0, 2, 8]} scale={[12, 1, 1]} />
        </group>
      </Environment>
    </>
  )
}
