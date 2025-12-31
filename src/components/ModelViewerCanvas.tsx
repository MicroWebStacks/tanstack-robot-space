import { OrbitControls, useGLTF } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { Suspense } from 'react'

import { useRobotState } from '../lib/robotStateClient'

type RobotModelProps = {
  url: string
}

function RobotModel({ url }: RobotModelProps) {
  useGLTF.preload(url)
  const gltf = useGLTF(url)

  return (
    <>
      <primitive object={gltf.scene} dispose={null} />
    </>
  )
}

function Scene({ modelUrl }: { modelUrl: string | null }) {
  const hasModel = Boolean(modelUrl)
  const { state } = useRobotState()

  const pose = state?.poseOdom ?? null
  // Coordinate mapping: ROS (X forward, Y left, Z up) -> Three (X, Y up, Z forward)
  // We use a proper rotation mapping (no mirroring): threeX=rosY, threeY=rosZ, threeZ=rosX
  const modelPos: [number, number, number] = pose
    ? [pose.y, pose.z, pose.x]
    : [0, 0, 0]
  const modelRot: [number, number, number] = pose ? [0, pose.yawZ, 0] : [0, 0, 0]

  return (
    <>
      <color attach="background" args={['#0b1020']} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[6, 8, 4]} intensity={1.2} />

      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#0f172a" />
      </mesh>

      {!hasModel && (
        <mesh position={[0, 0.75, 0]} castShadow>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#60a5fa" />
        </mesh>
      )}

      {modelUrl ? (
        <Suspense fallback={null}>
          <group position={modelPos} rotation={modelRot}>
            <RobotModel url={modelUrl} />
          </group>
        </Suspense>
      ) : null}
    </>
  )
}

export default function ModelViewerCanvas({
  active,
  modelUrl,
}: {
  active: boolean
  modelUrl: string | null
}) {
  return (
    <Canvas
      shadows
      camera={{ position: [3.5, 2.25, 4.25], fov: 50, near: 0.1, far: 200 }}
      style={{ width: '100%', height: '100%' }}
    >
      <Scene modelUrl={modelUrl} />
      <OrbitControls enabled={active} />
    </Canvas>
  )
}
