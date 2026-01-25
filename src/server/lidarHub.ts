import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

import type { LidarScan } from '../lib/lidarScan'
import { DEFAULT_BRIDGE_STALE_MS, DEFAULT_GRPC_ADDR, DEFAULT_GRPC_RECONNECT_MS } from '../lib/robotStatus'

import { isEnvTrue, loadRootEnvOnce } from './env'
import { getGrpcRetryLogger } from './retryLogger'

loadRootEnvOnce()

const LOG_PREFIX = '[lidar]'

const debugLidar = isEnvTrue('DEBUG_LIDAR')
const retryLog = getGrpcRetryLogger()

function debugLog(line: string) {
  if (!debugLidar) return
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

type LidarScanListener = (scan: LidarScan | null) => void

type RawLidarUpdate = {
  timestamp_unix_ms?: unknown
  seq?: unknown
  frame_id?: unknown
  angle_min?: unknown
  angle_increment?: unknown
  range_min?: unknown
  range_max?: unknown
  ranges?: unknown
}

const grpcAddr = process.env.UI_GATEWAY_GRPC_ADDR ?? DEFAULT_GRPC_ADDR
const grpcReconnectMs =
  Number(process.env.UI_GATEWAY_GRPC_RECONNECT_MS ?? DEFAULT_GRPC_RECONNECT_MS) ||
  DEFAULT_GRPC_RECONNECT_MS
const lidarStaleMs =
  Number(process.env.BRIDGE_STALE_MS ?? DEFAULT_BRIDGE_STALE_MS) ||
  DEFAULT_BRIDGE_STALE_MS

let started = false
let latestScan: LidarScan | null = null
let staleTimer: NodeJS.Timeout | null = null
const subscribers = new Set<LidarScanListener>()

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

export function getLidarScanSnapshot(): LidarScan | null {
  ensureStarted()
  return latestScan
}

export function subscribeLidarScan(listener: LidarScanListener): () => void {
  ensureStarted()
  subscribers.add(listener)
  if (latestScan) listener(latestScan)
  return () => subscribers.delete(listener)
}

function ensureStarted() {
  if (started) return
  started = true
  startGrpcLoop()
}

function publish(scan: LidarScan | null) {
  latestScan = scan
  for (const listener of subscribers) listener(scan)
}

function clearAsStale() {
  publish(null)
}

function scheduleStaleClear() {
  if (staleTimer) clearTimeout(staleTimer)
  staleTimer = setTimeout(clearAsStale, lidarStaleMs)
}

function scheduleReconnect() {
  if (reconnectTimer) return

  const nextAttempt = reconnectAttempt + 1
  const delayMs = getReconnectDelayMs(nextAttempt)
  reconnectAttempt = nextAttempt

  debugLog(`reconn ${delayMs}ms #${reconnectAttempt}`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startGrpcLoop()
  }, delayMs)
}

function normalizeLidarUpdate(raw: RawLidarUpdate): LidarScan | null {
  const timestampUnixMs = Number(raw.timestamp_unix_ms)
  if (!Number.isFinite(timestampUnixMs)) return null

  const seqRaw = raw.seq
  const seq =
    typeof seqRaw === 'string'
      ? seqRaw
      : typeof seqRaw === 'number'
        ? String(seqRaw)
        : seqRaw != null
          ? String(seqRaw)
          : '0'

  const frameId = typeof raw.frame_id === 'string' ? raw.frame_id : ''

  // proto3 scalar fields with default values may be omitted by proto-loader when
  // `defaults: false` (ex: angle_min=0). Treat missing as 0.
  const angleMin = raw.angle_min == null ? 0 : Number(raw.angle_min)
  if (!Number.isFinite(angleMin)) return null

  const angleIncrement = Number(raw.angle_increment)
  if (!Number.isFinite(angleIncrement)) return null

  const rangeMin = Number(raw.range_min)
  if (!Number.isFinite(rangeMin)) return null

  const rangeMax = Number(raw.range_max)
  if (!Number.isFinite(rangeMax)) return null

  const rangesRaw = raw.ranges
  if (!Array.isArray(rangesRaw)) return null

  const ranges: number[] = []
  for (const r of rangesRaw) {
    const n = Number(r)
    // Keep Inf/NaN as-is (they represent invalid readings per ROS LaserScan)
    ranges.push(n)
  }

  return {
    timestampUnixMs,
    seq,
    frameId,
    angleMin,
    angleIncrement,
    rangeMin,
    rangeMax,
    ranges,
  }
}

function startGrpcLoop() {
  if (activeCall) return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  try {
    const protoPath = resolveProtoPath()
    debugLog(`connect ${grpcAddr}`)

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

    const call = client.StreamLidar({})
    activeCall = call
    gotDataSinceConnect = false

    call.on('data', (raw: RawLidarUpdate) => {
      if (!gotDataSinceConnect) {
        gotDataSinceConnect = true
        reconnectAttempt = 0
        retryLog.markSuccess()
      }
      const normalized = normalizeLidarUpdate(raw)
      if (!normalized) return

      debugLog(`seq=${normalized.seq} points=${normalized.ranges.length} ranges_bytes=${normalized.ranges.length * 4}`)

      publish(normalized)
      scheduleStaleClear()
    })

    const onDisconnect = (err?: unknown) => {
      if (err) retryLog.logFailure('down', err)
      else debugLog('end')

      activeCall?.removeAllListeners()
      activeCall = null

      activeClient?.close()
      activeClient = null

      // Clear on disconnect for staleness policy
      clearAsStale()

      scheduleReconnect()
    }

    call.on('error', (err: unknown) => onDisconnect(err))
    call.on('end', () => onDisconnect())
  } catch (err) {
    retryLog.logFailure('down', err)
    activeCall?.removeAllListeners()
    activeCall = null
    activeClient?.close()
    activeClient = null
    scheduleReconnect()
  }
}
