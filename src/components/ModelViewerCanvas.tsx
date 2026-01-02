import { Line, OrbitControls, useGLTF } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { Suspense, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'

import { useLidarScan } from '../lib/lidarClient'
import { useOccupancyMap } from '../lib/occupancyMapClient'
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
  const { scan } = useLidarScan()
  const { map } = useOccupancyMap()

  const showAxes =
    import.meta.env.VITE_THREE_AXES_DEBUG === '1' ||
    String(import.meta.env.VITE_THREE_AXES_DEBUG).toLowerCase() === 'true' ||
    // Back-compat (older naming)
    import.meta.env.VITE_DEBUG_AXES === '1' ||
    String(import.meta.env.VITE_DEBUG_AXES).toLowerCase() === 'true'

  const lidarTsOffsetMs = Number(import.meta.env.VITE_LIDAR_TS_OFFSET_MS ?? 0) || 0

  // Single authoritative pose chosen by the bridge (frame in pose.frameId).
  // Staleness is handled server-side via `clear` events (state becomes null).
  const poseFromState = state?.pose ?? null
  const wheelAnglesRad = state?.wheelAnglesRad ?? null

  // Keep a short history of poses so we can pick the pose that matches the scan timestamp.
  // RViz effectively does a TF lookup at the scan timestamp (with interpolation).
  const POSE_HISTORY_MS = 2_000
  type PoseSample = {
    ts: number
    seq: string
    pose: NonNullable<NonNullable<typeof state>['pose']>
  }
  const poseHistoryRef = useRef<PoseSample[]>([])

  useEffect(() => {
    // If robot state is cleared (stale), drop the pose buffer so we don't
    // apply old poses to new scans.
    if (!state) {
      poseHistoryRef.current = []
      return
    }
    if (!poseFromState) return

    const ts = Number(state.timestampUnixMs)
    if (!Number.isFinite(ts)) return

    // Copy to avoid in-place mutations from upstream.
    const next: PoseSample = { ts, seq: state.seq, pose: { ...poseFromState } }
    const buf = poseHistoryRef.current

    // Assume monotonic timestamps; keep simple.
    buf.push(next)

    const cutoff = ts - POSE_HISTORY_MS
    while (buf.length && buf[0].ts < cutoff) buf.shift()
    // Hard cap to avoid unbounded growth if timestamps are weird.
    if (buf.length > 1_000) buf.splice(0, buf.length - 1_000)
  }, [state?.timestampUnixMs, state?.seq, poseFromState ? 1 : 0, state ? 1 : 0])

  const poseSampleForScan = useMemo(() => {
    if (!scan) return null

    const rawScanTs = Number(scan.timestampUnixMs)
    const scanTs = rawScanTs + lidarTsOffsetMs
    if (!Number.isFinite(scanTs)) return null

    const buf = poseHistoryRef.current
    if (!buf.length) return null
    // Fast paths for out-of-range.
    if (scanTs <= buf[0].ts) {
      return { ...buf[0], interp: { rawScanTs, scanTs, mode: 'clamp-low' as const } }
    }
    if (scanTs >= buf[buf.length - 1].ts) {
      const b = buf[buf.length - 1]
      const a = buf.length >= 2 ? buf[buf.length - 2] : null

      // If LiDAR timestamp is ahead of the newest pose sample, extrapolate a bit using velocity.
      const MAX_EXTRAP_MS = 250
      const aheadMsRaw = scanTs - b.ts
      const aheadMs = Math.min(MAX_EXTRAP_MS, Math.max(0, aheadMsRaw))

      if (a && aheadMs > 0) {
        const dtMs = b.ts - a.ts
        if (dtMs > 0) {
          const vx = (b.pose.x - a.pose.x) / dtMs
          const vy = (b.pose.y - a.pose.y) / dtMs
          const vz = (b.pose.z - a.pose.z) / dtMs
          const dyaw = Math.atan2(
            Math.sin(b.pose.yawZ - a.pose.yawZ),
            Math.cos(b.pose.yawZ - a.pose.yawZ),
          )
          const wyaw = dyaw / dtMs

          const pose = {
            ...b.pose,
            x: b.pose.x + vx * aheadMs,
            y: b.pose.y + vy * aheadMs,
            z: b.pose.z + vz * aheadMs,
            yawZ: b.pose.yawZ + wyaw * aheadMs,
          }

          return {
            ts: scanTs,
            seq: b.seq,
            pose,
            interp: {
              rawScanTs,
              scanTs,
              mode: 'extrap-high' as const,
              aTs: a.ts,
              aSeq: a.seq,
              bTs: b.ts,
              bSeq: b.seq,
              aheadMs: aheadMsRaw,
              usedMs: aheadMs,
            },
          }
        }
      }

      return {
        ...b,
        interp: { rawScanTs, scanTs, mode: 'clamp-high' as const, aheadMs: aheadMsRaw },
      }
    }

    // Find the bracketing samples. Buffer is append-only, so timestamps should be monotonic.
    let hi = 1
    while (hi < buf.length && buf[hi].ts < scanTs) hi++
    const lo = Math.max(hi - 1, 0)

    const a = buf[lo]
    const b = buf[hi]
    const span = b.ts - a.ts
    const t = span > 0 ? (scanTs - a.ts) / span : 0
    const alpha = Math.min(1, Math.max(0, t))

    const lerp = (x: number, y: number) => x + (y - x) * alpha
    const angleLerp = (x: number, y: number) => {
      const d = Math.atan2(Math.sin(y - x), Math.cos(y - x))
      return x + d * alpha
    }

    const pose = {
      ...a.pose,
      x: lerp(a.pose.x, b.pose.x),
      y: lerp(a.pose.y, b.pose.y),
      z: lerp(a.pose.z, b.pose.z),
      yawZ: angleLerp(a.pose.yawZ, b.pose.yawZ),
    }

    // Pick seq as the nearer of the two samples (for logging/debug only).
    const pick = Math.abs(scanTs - a.ts) <= Math.abs(b.ts - scanTs) ? a : b

    return {
      ts: scanTs,
      seq: pick.seq,
      pose,
      interp: {
        rawScanTs,
        scanTs,
        mode: 'interp' as const,
        aTs: a.ts,
        aSeq: a.seq,
        bTs: b.ts,
        bSeq: b.seq,
        alpha,
      },
    }
  }, [scan?.seq, scan?.timestampUnixMs, lidarTsOffsetMs])

  const poseForScan = poseSampleForScan?.pose ?? null

  // Minimal debug: log frameId once (or if it changes) to catch wrong-frame issues.
  const lastLidarFrameRef = useRef<string | null>(null)
  useEffect(() => {
    if (!scan) return
    const next = scan.frameId || '?'
    if (lastLidarFrameRef.current === next) return
    lastLidarFrameRef.current = next
    // eslint-disable-next-line no-console
    console.log(`[lidar] frame=${next}`)
  }, [scan?.frameId])

  // World frame matches ROS REP-103: X forward, Y left, Z up.
  const modelPos: [number, number, number] = poseFromState
    ? [poseFromState.x, poseFromState.y, poseFromState.z]
    : [0, 0, 0]
  const modelRot: [number, number, number] = poseFromState
    ? [0, 0, poseFromState.yawZ]
    : [0, 0, 0]

  // Fixed transform from base_link -> laser_link (URDF `laser_joint`)
  const LASER_OFFSET: [number, number, number] = [0.129, 0, 0.1645]
  const LASER_RPY: [number, number, number] = [0, 0, Math.PI]

  // Visual tuning
  const LIDAR_POINT_SIZE = 0.02
  const LIDAR_POINT_COLOR = '#ff0000'
  const LIDAR_LINE_COLOR = '#ff0000'
  const LIDAR_LINE_WIDTH = 1

  // If consecutive points are farther than this, don't connect them with lines/walls.
  const LIDAR_LINE_BREAK_M = 0.2

  const LIDAR_FLOOR_POINT_SIZE = 0.02
  const LIDAR_FLOOR_POINT_COLOR = '#000000'
  const LIDAR_FLOOR_LINE_COLOR = '#000000'
  const LIDAR_FLOOR_LINE_WIDTH = 1

  const LIDAR_WALL_COLOR = '#ff0000'
  const LIDAR_WALL_OPACITY = 0.22

  const MAP_Z_OFFSET = 0.0005

  const mapTexture = useMemo(() => {
    const tex = new THREE.Texture()
    tex.colorSpace = THREE.NoColorSpace
    tex.minFilter = THREE.NearestFilter
    tex.magFilter = THREE.NearestFilter
    tex.generateMipmaps = false
    return tex
  }, [])

  const mapMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        uMap: { value: mapTexture },
        uOpacity: { value: 0.9 },
        uUnknownBand: { value: 0.02 },
        uUnknownAlpha: { value: 0.18 },
        uOccColor: { value: new THREE.Color('#0f172a') },
        uUnknownColor: { value: new THREE.Color('#0f172a') },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          // Hardcoded orientation fix: flip V (ROS occupancy grid PNG row order).
          vUv = vec2(uv.x, 1.0 - uv.y);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uMap;
        uniform float uOpacity;
        uniform float uUnknownBand;
        uniform float uUnknownAlpha;
        uniform vec3 uOccColor;
        uniform vec3 uUnknownColor;
        varying vec2 vUv;
        void main() {
          float g = texture2D(uMap, vUv).r;
          float occ = 1.0 - g;
          float d = abs(g - 0.5);
          float isUnknown = 1.0 - step(uUnknownBand, d);
          float alpha = mix(occ * uOpacity, uUnknownAlpha * uOpacity, isUnknown);
          vec3 color = mix(uOccColor, uUnknownColor, isUnknown);
          gl_FragColor = vec4(color, alpha);
        }
      `,
    })
  }, [mapTexture])

  useEffect(() => {
    return () => {
      mapMaterial.dispose()
      mapTexture.dispose()
    }
  }, [mapMaterial, mapTexture])

  useEffect(() => {
    if (!map?.pngBase64) return

    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      mapTexture.image = img
      mapTexture.needsUpdate = true
    }
    img.onerror = () => {}
    img.src = `data:image/png;base64,${map.pngBase64}`

    return () => {
      cancelled = true
    }
  }, [map?.seq, map?.pngBase64, mapTexture])

  const mapPlane = useMemo(() => {
    if (!map) return null

    const widthM = map.width * map.resolutionMPerPx
    const heightM = map.height * map.resolutionMPerPx
    if (!Number.isFinite(widthM) || !Number.isFinite(heightM) || widthM <= 0 || heightM <= 0) {
      return null
    }

    const dx = widthM / 2
    const dy = heightM / 2
    const yaw = map.origin.yawZ
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)

    const centerX = map.origin.x + dx * cos - dy * sin
    const centerY = map.origin.y + dx * sin + dy * cos

    return {
      widthM,
      heightM,
      pos: [centerX, centerY, map.origin.z + MAP_Z_OFFSET] as [number, number, number],
      rot: [0, 0, yaw] as [number, number, number],
    }
  }, [map])

  const lidarGeo = useMemo(() => {
    if (!scan) return null

    const ranges = scan.ranges
    const angleMin = scan.angleMin
    const angleIncrement = scan.angleIncrement

    if (!Number.isFinite(angleMin) || !Number.isFinite(angleIncrement) || angleIncrement === 0) {
      return null
    }

    // Pre-count valid points to allocate once.
    let validCount = 0
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]
      if (!Number.isFinite(r)) continue
      if (r < scan.rangeMin || r > scan.rangeMax) continue
      validCount++
    }

    if (validCount === 0) return null

    if (!poseForScan) return null

    const poseX = poseForScan.x
    const poseY = poseForScan.y
    const poseZ = poseForScan.z
    const yawRobot = poseForScan.yawZ
    const yawLaser = LASER_RPY[2]

    const cosRobot = Math.cos(yawRobot)
    const sinRobot = Math.sin(yawRobot)
    const cosLaser = Math.cos(yawLaser)
    const sinLaser = Math.sin(yawLaser)

    const localPositions = new Float32Array(validCount * 3)
    const worldTopPositions = new Float32Array(validCount * 3)
    const worldFloorPositions = new Float32Array(validCount * 3)

    let outLocal = 0
    let outWorld = 0
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]
      if (!Number.isFinite(r)) continue
      if (r < scan.rangeMin || r > scan.rangeMax) continue

      const theta = angleMin + i * angleIncrement
      // ROS LaserScan: angles around +Z axis in the sensor frame.
      const xS = r * Math.cos(theta)
      const yS = r * Math.sin(theta)

      localPositions[outLocal++] = xS
      localPositions[outLocal++] = yS
      localPositions[outLocal++] = 0

      // Sensor -> base (laser yaw + offset)
      const xL = xS * cosLaser - yS * sinLaser
      const yL = xS * sinLaser + yS * cosLaser
      const xB = LASER_OFFSET[0] + xL
      const yB = LASER_OFFSET[1] + yL
      const zB = LASER_OFFSET[2]

      // Base -> world (robot yaw + pose)
      const xW = poseX + xB * cosRobot - yB * sinRobot
      const yW = poseY + xB * sinRobot + yB * cosRobot
      const zW = poseZ + zB

      worldTopPositions[outWorld] = xW
      worldFloorPositions[outWorld++] = xW
      worldTopPositions[outWorld] = yW
      worldFloorPositions[outWorld++] = yW
      worldTopPositions[outWorld] = zW
      worldFloorPositions[outWorld++] = 0
    }

    let localLineSegments: [number, number, number][][] | null = null
    let worldFloorLineSegments: [number, number, number][][] | null = null
    let wallPositions: Float32Array | null = null

    if (validCount >= 2) {
      localLineSegments = []
      worldFloorLineSegments = []

      const pushIfValid = (segments: [number, number, number][][], seg: [number, number, number][]) => {
        if (seg.length >= 2) segments.push(seg)
      }

      // Build segmented polyline in local (laser) frame.
      {
        let seg: [number, number, number][] = []
        let prevX = 0
        let prevY = 0
        let prevSet = false

        for (let i = 0; i < validCount; i++) {
          const ix = i * 3
          const x = localPositions[ix]
          const y = localPositions[ix + 1]
          const z = localPositions[ix + 2]

          if (!prevSet) {
            seg.push([x, y, z])
            prevX = x
            prevY = y
            prevSet = true
            continue
          }

          const dx = x - prevX
          const dy = y - prevY
          const dist = Math.hypot(dx, dy)

          if (dist <= LIDAR_LINE_BREAK_M) {
            seg.push([x, y, z])
          } else {
            pushIfValid(localLineSegments, seg)
            seg = [[x, y, z]]
          }

          prevX = x
          prevY = y
        }

        pushIfValid(localLineSegments, seg)

        // Closed loop only if we never broke the line and end-to-start is also within threshold.
        if (localLineSegments.length === 1 && localLineSegments[0].length === validCount) {
          const first = localLineSegments[0][0]
          const last = localLineSegments[0][localLineSegments[0].length - 1]
          const dist = Math.hypot(first[0] - last[0], first[1] - last[1])
          if (dist <= LIDAR_LINE_BREAK_M) {
            localLineSegments[0].push(first)
          }
        }
      }

      // Build segmented polyline on the world floor (z=0).
      {
        let seg: [number, number, number][] = []
        let prevX = 0
        let prevY = 0
        let prevSet = false

        for (let i = 0; i < validCount; i++) {
          const ix = i * 3
          const x = worldFloorPositions[ix]
          const y = worldFloorPositions[ix + 1]
          const z = worldFloorPositions[ix + 2]

          if (!prevSet) {
            seg.push([x, y, z])
            prevX = x
            prevY = y
            prevSet = true
            continue
          }

          const dx = x - prevX
          const dy = y - prevY
          const dist = Math.hypot(dx, dy)

          if (dist <= LIDAR_LINE_BREAK_M) {
            seg.push([x, y, z])
          } else {
            pushIfValid(worldFloorLineSegments, seg)
            seg = [[x, y, z]]
          }

          prevX = x
          prevY = y
        }

        pushIfValid(worldFloorLineSegments, seg)

        if (
          worldFloorLineSegments.length === 1 &&
          worldFloorLineSegments[0].length === validCount
        ) {
          const first = worldFloorLineSegments[0][0]
          const last = worldFloorLineSegments[0][worldFloorLineSegments[0].length - 1]
          const dist = Math.hypot(first[0] - last[0], first[1] - last[1])
          if (dist <= LIDAR_LINE_BREAK_M) {
            worldFloorLineSegments[0].push(first)
          }
        }
      }

      // Build "wall" quads only across short edges (skip huge jumps).
      {
        const wall: number[] = []
        const addQuad = (
          topAx: number,
          topAy: number,
          topAz: number,
          topBx: number,
          topBy: number,
          topBz: number,
          floorAx: number,
          floorAy: number,
          floorAz: number,
          floorBx: number,
          floorBy: number,
          floorBz: number,
        ) => {
          // Two triangles: topA-topB-floorB, topA-floorB-floorA
          wall.push(
            topAx,
            topAy,
            topAz,
            topBx,
            topBy,
            topBz,
            floorBx,
            floorBy,
            floorBz,
            topAx,
            topAy,
            topAz,
            floorBx,
            floorBy,
            floorBz,
            floorAx,
            floorAy,
            floorAz,
          )
        }

        const edgeOk = (i3: number, j3: number) => {
          const dx = worldTopPositions[j3] - worldTopPositions[i3]
          const dy = worldTopPositions[j3 + 1] - worldTopPositions[i3 + 1]
          return Math.hypot(dx, dy) <= LIDAR_LINE_BREAK_M
        }

        for (let i = 0; i < validCount - 1; i++) {
          const j = i + 1
          const i3 = i * 3
          const j3 = j * 3
          if (!edgeOk(i3, j3)) continue

          addQuad(
            worldTopPositions[i3],
            worldTopPositions[i3 + 1],
            worldTopPositions[i3 + 2],
            worldTopPositions[j3],
            worldTopPositions[j3 + 1],
            worldTopPositions[j3 + 2],
            worldFloorPositions[i3],
            worldFloorPositions[i3 + 1],
            worldFloorPositions[i3 + 2],
            worldFloorPositions[j3],
            worldFloorPositions[j3 + 1],
            worldFloorPositions[j3 + 2],
          )
        }

        // Close only if last->first is within threshold.
        if (validCount >= 3) {
          const i3 = (validCount - 1) * 3
          const j3 = 0
          if (edgeOk(i3, j3)) {
            addQuad(
              worldTopPositions[i3],
              worldTopPositions[i3 + 1],
              worldTopPositions[i3 + 2],
              worldTopPositions[j3],
              worldTopPositions[j3 + 1],
              worldTopPositions[j3 + 2],
              worldFloorPositions[i3],
              worldFloorPositions[i3 + 1],
              worldFloorPositions[i3 + 2],
              worldFloorPositions[j3],
              worldFloorPositions[j3 + 1],
              worldFloorPositions[j3 + 2],
            )
          }
        }

        wallPositions = wall.length ? new Float32Array(wall) : null
      }
    }

    return {
      localPositions,
      worldFloorPositions,
      localLineSegments,
      worldFloorLineSegments,
      wallPositions,
    }
  }, [scan, poseForScan?.x, poseForScan?.y, poseForScan?.z, poseForScan?.yawZ])

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

      {/* Occupancy grid map (XY plane) */}
      {mapPlane ? (
        <mesh position={mapPlane.pos} rotation={mapPlane.rot}>
          <planeGeometry args={[mapPlane.widthM, mapPlane.heightM]} />
          <primitive object={mapMaterial} attach="material" dispose={null} />
        </mesh>
      ) : null}

      {/* Floor-projected Lidar (world z=0) */}
      {lidarGeo ? (
        <>
          {/* Top lidar latched in world at scan arrival */}
          {poseForScan ? (
            <group
              position={[poseForScan.x, poseForScan.y, poseForScan.z]}
              rotation={[0, 0, poseForScan.yawZ]}
            >
              <group position={LASER_OFFSET} rotation={LASER_RPY}>
                <points>
                  <bufferGeometry>
                    <bufferAttribute
                      attach="attributes-position"
                      args={[lidarGeo.localPositions, 3]}
                    />
                  </bufferGeometry>
                  <pointsMaterial
                    size={LIDAR_POINT_SIZE}
                    color={LIDAR_POINT_COLOR}
                    sizeAttenuation
                    depthWrite={false}
                  />
                </points>

                {lidarGeo.localLineSegments
                  ? lidarGeo.localLineSegments.map((points, idx) => (
                      <Line
                        // eslint-disable-next-line react/no-array-index-key
                        key={`lidar-top-${idx}`}
                        points={points}
                        color={LIDAR_LINE_COLOR}
                        lineWidth={LIDAR_LINE_WIDTH}
                        depthWrite={false}
                      />
                    ))
                  : null}
              </group>
            </group>
          ) : null}

          <points>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[lidarGeo.worldFloorPositions, 3]}
              />
            </bufferGeometry>
            <pointsMaterial
              size={LIDAR_FLOOR_POINT_SIZE}
              color={LIDAR_FLOOR_POINT_COLOR}
              sizeAttenuation
              depthWrite={false}
            />
          </points>

          {lidarGeo.worldFloorLineSegments
            ? lidarGeo.worldFloorLineSegments.map((points, idx) => (
                <Line
                  // eslint-disable-next-line react/no-array-index-key
                  key={idx}
                  points={points}
                  color={LIDAR_FLOOR_LINE_COLOR}
                  lineWidth={LIDAR_FLOOR_LINE_WIDTH}
                  depthWrite={false}
                />
              ))
            : null}

          {lidarGeo.wallPositions ? (
            <mesh>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  args={[lidarGeo.wallPositions, 3]}
                />
              </bufferGeometry>
              <meshBasicMaterial
                color={LIDAR_WALL_COLOR}
                transparent
                opacity={LIDAR_WALL_OPACITY}
                side={2}
                depthWrite={false}
              />
            </mesh>
          ) : null}
        </>
      ) : null}

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
