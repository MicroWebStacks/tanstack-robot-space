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
  const wheelBaseRotRef = useRef<
    Map<string, { x: number; y: number; z: number; order: string }>
  >(new Map())

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

      // URDF joints define wheel axis as xyz="0 0 1" (local +Z in the joint frame).
      // Apply spin around the node's local Z while preserving its base orientation.
      const base = wheelBaseRotRef.current.get(jointName)
      if (!base) {
        wheelBaseRotRef.current.set(jointName, {
          x: obj.rotation.x,
          y: obj.rotation.y,
          z: obj.rotation.z,
          order: obj.rotation.order ?? 'XYZ',
        })
      }

      const nextBase = wheelBaseRotRef.current.get(jointName)!
      obj.rotation.set(nextBase.x, nextBase.y, nextBase.z, nextBase.order)
      obj.rotation.z += angleRad
    }
  }, [gltf, wheelAnglesRad])

  return (
    <>
      <primitive object={gltf.scene} dispose={null} />
    </>
  )
}

function Scene({ modelUrl }: { modelUrl: string | null }) {
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
      <color attach="background" args={['#87cefa']} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[6, 8, 4]} intensity={1.2} />

      {showAxes ? (
        // World axes at origin: X=red, Y=green, Z=blue
        <group position={[0, 0, 0]}>
          <axesHelper args={[1]} />
        </group>
      ) : null}

      {/* Ground plane in ROS world is XY at z=0 (since Z is up). */}
      <mesh receiveShadow>
        <planeGeometry args={[10, 10]} />
        <meshStandardMaterial color="#666" roughness={1} metalness={0} />
      </mesh>

      {/* 1m grid lines over a 10x10m area, centered at origin. */}
      <gridHelper
        args={[10, 10, '#94a3b8', '#64748b']}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0, 0.001]}
      />

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
  // Default camera view direction (ROS world: X forward, Y left, Z up).
  // Tune distance here without changing the viewing angle.
  const CAMERA_DISTANCE = 2
  const CAMERA_DIR: [number, number, number] = [3.5, -4.25, 2.25]
  const cameraDirLen = Math.hypot(...CAMERA_DIR) || 1
  const cameraPos: [number, number, number] = [
    (CAMERA_DIR[0] * CAMERA_DISTANCE) / cameraDirLen,
    (CAMERA_DIR[1] * CAMERA_DISTANCE) / cameraDirLen,
    (CAMERA_DIR[2] * CAMERA_DISTANCE) / cameraDirLen,
  ]

  return (
    <Canvas
      shadows
      camera={{ position: cameraPos, fov: 50, near: 0.1, far: 200 }}
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
