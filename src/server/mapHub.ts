import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

import type { Pose3D } from '../lib/robotState'
import type { OccupancyMap } from '../lib/occupancyMap'
import { DEFAULT_BRIDGE_STALE_MS, DEFAULT_GRPC_ADDR, DEFAULT_GRPC_RECONNECT_MS } from '../lib/robotStatus'

import { isEnvTrue, loadRootEnvOnce } from './env'

loadRootEnvOnce()

const LOG_PREFIX = '[map]'

const debugMap = isEnvTrue('DEBUG_MAP')

function debugLog(line: string) {
  if (!debugMap) return
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

type OccupancyMapListener = (map: OccupancyMap | null) => void

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

type RawMapUpdate = {
  timestamp_unix_ms?: unknown
  seq?: unknown
  frame_id?: unknown
  resolution_m_per_px?: unknown
  width?: unknown
  height?: unknown
  origin?: unknown
  png?: unknown
}

const grpcAddr = process.env.UI_GATEWAY_GRPC_ADDR ?? DEFAULT_GRPC_ADDR
const grpcReconnectMs =
  Number(process.env.UI_GATEWAY_GRPC_RECONNECT_MS ?? DEFAULT_GRPC_RECONNECT_MS) ||
  DEFAULT_GRPC_RECONNECT_MS

const mapStaleMs =
  Number(
    process.env.BRIDGE_STALE_MAP_MS ??
      process.env.BRIDGE_STALE_MS ??
      DEFAULT_BRIDGE_STALE_MS,
  ) || DEFAULT_BRIDGE_STALE_MS

let started = false
let latestMap: OccupancyMap | null = null
let staleTimer: NodeJS.Timeout | null = null
const subscribers = new Set<OccupancyMapListener>()

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

export function getOccupancyMapSnapshot(): OccupancyMap | null {
  ensureStarted()
  return latestMap
}

export function subscribeOccupancyMap(listener: OccupancyMapListener): () => void {
  ensureStarted()
  subscribers.add(listener)
  if (latestMap) listener(latestMap)
  return () => subscribers.delete(listener)
}

function ensureStarted() {
  if (started) return
  started = true
  startGrpcLoop()
}

function publish(map: OccupancyMap | null) {
  latestMap = map
  for (const listener of subscribers) listener(map)
}

function clearAsStale() {
  publish(null)
}

function scheduleStaleClear() {
  if (staleTimer) clearTimeout(staleTimer)
  staleTimer = setTimeout(clearAsStale, mapStaleMs)
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

function yawFromQuaternionZUp(qx: number, qy: number, qz: number, qw: number): number {
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

function normalizeSeq(seqRaw: unknown): string {
  return typeof seqRaw === 'string'
    ? seqRaw
    : typeof seqRaw === 'number'
      ? String(seqRaw)
      : seqRaw != null
        ? String(seqRaw)
        : '0'
}

function normalizePose3D(raw: unknown): Pose3D | null {
  const p = raw as RawPose3D
  const frameId = typeof p?.frame_id === 'string' ? p.frame_id : ''

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

function normalizePngBase64(png: unknown): string | null {
  if (typeof png === 'string') {
    const trimmed = png.trim()
    return trimmed ? trimmed : null
  }

  if (png instanceof Uint8Array) {
    const base64 = Buffer.from(png).toString('base64')
    return base64 ? base64 : null
  }

  if (Buffer.isBuffer(png)) {
    const base64 = png.toString('base64')
    return base64 ? base64 : null
  }

  return null
}

function normalizeMapUpdate(raw: RawMapUpdate): OccupancyMap | null {
  const timestampUnixMs = numberRequired(raw.timestamp_unix_ms)
  if (timestampUnixMs == null) return null

  const seq = normalizeSeq(raw.seq)
  const frameId = typeof raw.frame_id === 'string' ? raw.frame_id : ''

  const resolutionMPerPx = numberRequired(raw.resolution_m_per_px)
  if (resolutionMPerPx == null || resolutionMPerPx <= 0) return null

  const width = numberRequired(raw.width)
  if (width == null || width <= 0) return null

  const height = numberRequired(raw.height)
  if (height == null || height <= 0) return null

  const origin = normalizePose3D(raw.origin)
  if (!origin) return null

  const pngBase64 = normalizePngBase64(raw.png)
  if (!pngBase64) return null

  return {
    timestampUnixMs,
    seq,
    frameId,
    resolutionMPerPx,
    width,
    height,
    origin,
    pngBase64,
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

    const call = client.StreamMap({})
    activeCall = call
    gotDataSinceConnect = false

    call.on('data', (raw: RawMapUpdate) => {
      if (!gotDataSinceConnect) {
        gotDataSinceConnect = true
        reconnectAttempt = 0
      }

      const normalized = normalizeMapUpdate(raw)
      if (!normalized) return

      debugLog(
        `seq=${normalized.seq} ${normalized.width}x${normalized.height} res=${normalized.resolutionMPerPx} png_b64=${normalized.pngBase64.length}`,
      )

      publish(normalized)
      scheduleStaleClear()
    })

    const onDisconnect = (err?: unknown) => {
      if (err) errorLog('disc', err)
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
    errorLog('start fail', err)
    activeCall?.removeAllListeners()
    activeCall = null
    activeClient?.close()
    activeClient = null
    scheduleReconnect()
  }
}

