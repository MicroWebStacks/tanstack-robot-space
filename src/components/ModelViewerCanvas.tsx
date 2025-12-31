import { OrbitControls, useGLTF } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { Suspense, useEffect, useRef } from 'react'

import { useRobotState } from '../lib/robotStateClient'

type RobotModelProps = {
  url: string
  wheelAnglesRad: Record<string, number> | null
}

function RobotModel({ url, wheelAnglesRad }: RobotModelProps) {
  useGLTF.preload(url)
  const gltf = useGLTF(url) as any

  const warnedMissingRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!wheelAnglesRad) return

    for (const [jointName, angleRad] of Object.entries(wheelAnglesRad)) {
      const obj = gltf.scene?.getObjectByName?.(jointName)
      if (!obj) {
        if (!warnedMissingRef.current.has(jointName)) {
          warnedMissingRef.current.add(jointName)
          // eslint-disable-next-line no-console
          console.warn(`[model] wheel joint not found in GLB: ${jointName}`)
        }
        continue
      }

      // ROS REP-103: X forward, Y left, Z up. Wheels spin about their axle which is typically +Y.
      obj.rotation.y = angleRad
    }
  }, [gltf, wheelAnglesRad])

  return (
    <>
      <primitive object={gltf.scene} dispose={null} />
    </>
  )
}

function Scene({ modelUrl }: { modelUrl: string | null }) {
  const hasModel = Boolean(modelUrl)
  const { state } = useRobotState()

  const showAxes =
    import.meta.env.VITE_THREE_AXES_DEBUG === '1' ||
    String(import.meta.env.VITE_THREE_AXES_DEBUG).toLowerCase() === 'true' ||
    // Back-compat (older naming)
    import.meta.env.VITE_DEBUG_AXES === '1' ||
    String(import.meta.env.VITE_DEBUG_AXES).toLowerCase() === 'true'

  const pose = state?.poseOdom ?? null
  const wheelAnglesRad = state?.wheelAnglesRad ?? null

  // World frame matches ROS REP-103: X forward, Y left, Z up.
  const modelPos: [number, number, number] = pose ? [pose.x, pose.y, pose.z] : [0, 0, 0]
  const modelRot: [number, number, number] = pose ? [0, 0, pose.yawZ] : [0, 0, 0]

  return (
    <>
      <color attach="background" args={['#0b1020']} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[6, 8, 4]} intensity={1.2} />

      {showAxes ? (
        // World axes at origin: X=red, Y=green, Z=blue
        <group position={[0, 0.01, 0]}>
          <axesHelper args={[3]} />
        </group>
      ) : null}

      {/* Ground plane in ROS world is XY at z=0 (since Z is up). */}
      <mesh receiveShadow>
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
            {showAxes ? (
              // Robot/model axes: same colors, attached to robot root
              <group position={[0, 0.01, 0]}>
                <axesHelper args={[1]} />
              </group>
            ) : null}
            <RobotModel url={modelUrl} wheelAnglesRad={wheelAnglesRad} />
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
      camera={{ position: [3.5, -4.25, 2.25], fov: 50, near: 0.1, far: 200 }}
      onCreated={({ camera, scene }) => {
        // ROS REP-103: Z is up.
        camera.up.set(0, 0, 1)
        scene.up.set(0, 0, 1)
      }}
      style={{ width: '100%', height: '100%' }}
    >
      <Scene modelUrl={modelUrl} />
      <OrbitControls enabled={active} />
    </Canvas>
  )
}
