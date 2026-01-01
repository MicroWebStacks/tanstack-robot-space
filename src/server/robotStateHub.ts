import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

import type { RobotState } from '../lib/robotState'
import { DEFAULT_GRPC_ADDR, DEFAULT_GRPC_RECONNECT_MS } from '../lib/robotStatus'

import { isEnvTrue, loadRootEnvOnce } from './env'

loadRootEnvOnce()

const LOG_PREFIX = '[robot-state]'

const debugPose =
  isEnvTrue('DEBUG_POSE')

function poseLog(line: string) {
  if (!debugPose) return
  process.stdout.write(`${LOG_PREFIX} ${line}\n`)
}

function errorLog(line: string, err?: unknown) {
  const suffix = err ? ` ${String(err)}` : ''
  process.stderr.write(`${LOG_PREFIX} ${line}${suffix}\n`)
}

function resolveProtoPath() {
  const candidates = [
    path.resolve(process.cwd(), 'proto', 'ui_bridge.proto'),
    path.resolve(process.cwd(), 'proto', 'ui_gateway.proto'),
    fileURLToPath(new URL('../../proto/ui_bridge.proto', import.meta.url)),
    fileURLToPath(new URL('../../proto/ui_gateway.proto', import.meta.url)),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  throw new Error('Unable to locate ui_bridge.proto (or ui_gateway.proto fallback)')
}

type RobotStateListener = (state: RobotState | null) => void

type RawPose3D = {
  frame_id?: unknown
  x?: unknown
  y?: unknown
  z?: unknown
  qx?: unknown
  qy?: unknown
  qz?: unknown
  qw?: unknown
}

type RawJointAngle = {
  joint_name?: unknown
  position_rad?: unknown
}

type RawRobotStateUpdate = {
  timestamp_unix_ms?: unknown
  seq?: unknown
  pose?: unknown
  // Back-compat: older protos used pose_odom
  pose_odom?: unknown
  wheel_angles?: unknown
}

const grpcAddr = process.env.UI_GATEWAY_GRPC_ADDR ?? DEFAULT_GRPC_ADDR
const grpcReconnectMs =
  Number(process.env.UI_GATEWAY_GRPC_RECONNECT_MS ?? DEFAULT_GRPC_RECONNECT_MS) ||
  DEFAULT_GRPC_RECONNECT_MS


let started = false
let latestState: RobotState | null = null
const subscribers = new Set<RobotStateListener>()

let reconnectTimer: NodeJS.Timeout | null = null
let activeClient: grpc.Client | null = null
let activeCall: grpc.ClientReadableStream<unknown> | null = null

let reconnectAttempt = 0
let gotDataSinceConnect = false

function getReconnectDelayMs(attempt: number): number {
  if (attempt <= 5) return grpcReconnectMs
  if (attempt <= 10) return 60_000
  return 300_000
}

export function getRobotStateSnapshot(): RobotState | null {
  ensureStarted()
  return latestState
}

export function subscribeRobotState(listener: RobotStateListener): () => void {
  ensureStarted()
  subscribers.add(listener)
  if (latestState) listener(latestState)
  return () => subscribers.delete(listener)
}

function ensureStarted() {
  if (started) return
  started = true
  startGrpcLoop()
}

function publish(state: RobotState | null) {
  latestState = state
  for (const listener of subscribers) listener(state)
}

function scheduleReconnect() {
  if (reconnectTimer) return

  const nextAttempt = reconnectAttempt + 1
  const delayMs = getReconnectDelayMs(nextAttempt)
  reconnectAttempt = nextAttempt

  poseLog(`reconn ${delayMs}ms #${reconnectAttempt}`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startGrpcLoop()
  }, delayMs)
}

function yawFromQuaternionZUp(qx: number, qy: number, qz: number, qw: number): number {
  // ROS REP-103 yaw about +Z. Standard quaternion->yaw conversion.
  const siny = 2 * (qw * qz + qx * qy)
  const cosy = 1 - 2 * (qy * qy + qz * qz)
  return Math.atan2(siny, cosy)
}

function numberOrDefault(value: unknown, defaultValue: number): number | null {
  if (value == null) return defaultValue
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function numberRequired(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizePose3D(raw: unknown): RobotState['pose'] | null {
  const p = raw as RawPose3D
  const frameId = typeof p?.frame_id === 'string' ? p.frame_id : ''

  // With proto-loader `defaults: false`, proto3 scalar fields that are 0 may be omitted.
  // Treat missing scalars as proto3 defaults so we don't drop valid frames.
  const x = numberOrDefault(p?.x, 0)
  const y = numberOrDefault(p?.y, 0)
  const z = numberOrDefault(p?.z, 0)
  const qx = numberOrDefault(p?.qx, 0)
  const qy = numberOrDefault(p?.qy, 0)
  const qz = numberOrDefault(p?.qz, 0)
  const qw = numberOrDefault(p?.qw, 1)

  if (x == null || y == null || z == null || qx == null || qy == null || qz == null || qw == null) {
    return null
  }

  const yawZ = yawFromQuaternionZUp(qx, qy, qz, qw)

  return {
    frameId,
    x,
    y,
    z,
    qx,
    qy,
    qz,
    qw,
    yawZ,
  }
}

function normalizeRobotStateUpdate(raw: RawRobotStateUpdate): RobotState | null {
  const timestampUnixMs = numberRequired(raw.timestamp_unix_ms)
  if (timestampUnixMs == null) return null

  const seqRaw = raw.seq
  const seq =
    typeof seqRaw === 'string'
      ? seqRaw
      : typeof seqRaw === 'number'
        ? String(seqRaw)
        : seqRaw != null
          ? String(seqRaw)
          : '0'

  const pose = normalizePose3D(raw.pose ?? raw.pose_odom)
  if (!pose) return null

  const wheelAnglesRad: Record<string, number> = {}
  const wheelAnglesRaw = Array.isArray(raw.wheel_angles)
    ? (raw.wheel_angles as RawJointAngle[])
    : []
  for (const wa of wheelAnglesRaw) {
    const name = typeof wa?.joint_name === 'string' ? wa.joint_name : null
    const pos = numberOrDefault(wa?.position_rad, 0)
    if (!name || pos == null) continue
    wheelAnglesRad[name] = pos
  }

  return {
    timestampUnixMs,
    seq,
    pose,
    wheelAnglesRad,
  }
}

function formatWheelAngles(wheelAnglesRad: Record<string, number>): string {
  const wfl = wheelAnglesRad.front_left_joint
  const wfr = wheelAnglesRad.front_right_joint
  const wbl = wheelAnglesRad.back_left_joint
  const wbr = wheelAnglesRad.back_right_joint

  const parts: string[] = []
  if (typeof wfl === 'number') parts.push(`wfl=${wfl.toFixed(3)}`)
  if (typeof wfr === 'number') parts.push(`wfr=${wfr.toFixed(3)}`)
  if (typeof wbl === 'number') parts.push(`wbl=${wbl.toFixed(3)}`)
  if (typeof wbr === 'number') parts.push(`wbr=${wbr.toFixed(3)}`)

  return parts.length ? ` ${parts.join(' ')}` : ''
}

function startGrpcLoop() {
  if (activeCall) return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  try {
    const protoPath = resolveProtoPath()


    const packageDef = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true,
    })

    const proto = grpc.loadPackageDefinition(packageDef) as any
    const UiBridgeClientCtor = proto?.roblibs?.ui_bridge?.v1?.UiBridge as
      | grpc.ServiceClientConstructor
      | undefined
    if (!UiBridgeClientCtor) {
      throw new Error(
        'Failed to load UiBridge from proto; expected roblibs.ui_bridge.v1.UiBridge',
      )
    }

    const client = new UiBridgeClientCtor(
      grpcAddr,
      grpc.credentials.createInsecure(),
    ) as any

    activeClient = client as grpc.Client

    const call = client.StreamRobotState({})
    activeCall = call
    gotDataSinceConnect = false

    call.on('data', (msg: RawRobotStateUpdate) => {
      if (!gotDataSinceConnect) {
        gotDataSinceConnect = true
        reconnectAttempt = 0
      }
      const normalized = normalizeRobotStateUpdate(msg)
      if (!normalized) return

      const p = normalized.pose
      const wheels = formatWheelAngles(normalized.wheelAnglesRad)
      poseLog(
        `seq=${normalized.seq} pose x=${p.x.toFixed(3)} y=${p.y.toFixed(3)} yawZ=${p.yawZ.toFixed(3)}${wheels}`,
      )

      publish(normalized)
    })

    const onDisconnect = (err?: unknown) => {
      if (err) errorLog('disc', err)
      activeCall?.removeAllListeners()
      activeCall = null

      activeClient?.close()
      activeClient = null

      scheduleReconnect()
    }

    call.on('error', (err: unknown) => onDisconnect(err))
    call.on('end', () => onDisconnect())
  } catch (err) {
    errorLog('start fail', err)
    activeCall?.removeAllListeners()
    activeCall = null
    activeClient?.close()
    activeClient = null
    scheduleReconnect()
  }
}
