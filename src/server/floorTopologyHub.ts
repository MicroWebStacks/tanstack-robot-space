import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

import type { FloorPolyline, FloorTopology, Point3 } from '../lib/floorTopology'
import { DEFAULT_BRIDGE_STALE_MS, DEFAULT_GRPC_ADDR, DEFAULT_GRPC_RECONNECT_MS } from '../lib/robotStatus'

import { isEnvTrue, loadRootEnvOnce } from './env'
import { getGrpcRetryLogger } from './retryLogger'

loadRootEnvOnce()

const LOG_PREFIX = '[topology]'

const debugTopology = isEnvTrue('DEBUG_TOPOLOGY')
const retryLog = getGrpcRetryLogger()

const EXPECTED_POLYLINE_FRAME_ID = 'base_footprint'

function debugLog(line: string) {
  if (!debugTopology) return
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

type FloorTopologyListener = (topology: FloorTopology | null) => void

type RawPoint3 = {
  x?: unknown
  y?: unknown
  z?: unknown
}

type RawFloorPolyline = {
  ns?: unknown
  id?: unknown
  frame_id?: unknown
  points?: unknown
  closed?: unknown
}

type RawFloorTopologyUpdate = {
  timestamp_unix_ms?: unknown
  seq?: unknown
  polylines?: unknown
}

const grpcAddr = process.env.UI_GATEWAY_GRPC_ADDR ?? DEFAULT_GRPC_ADDR
const grpcReconnectMs =
  Number(process.env.UI_GATEWAY_GRPC_RECONNECT_MS ?? DEFAULT_GRPC_RECONNECT_MS) ||
  DEFAULT_GRPC_RECONNECT_MS

const topologyStaleMs =
  Number(
    process.env.BRIDGE_STALE_TOPOLOGY_MS ??
      process.env.BRIDGE_STALE_MS ??
      DEFAULT_BRIDGE_STALE_MS,
  ) || DEFAULT_BRIDGE_STALE_MS

let started = false
let latestTopology: FloorTopology | null = null
let staleTimer: NodeJS.Timeout | null = null
const subscribers = new Set<FloorTopologyListener>()

let reconnectTimer: NodeJS.Timeout | null = null
let activeClient: grpc.Client | null = null
let activeCall: grpc.ClientReadableStream<unknown> | null = null
let noDataTimer: NodeJS.Timeout | null = null

let reconnectAttempt = 0
let gotDataSinceConnect = false
let fatalError: string | null = null

function getReconnectDelayMs(attempt: number): number {
  if (attempt <= 5) return grpcReconnectMs
  if (attempt <= 10) return 60_000
  return 300_000
}

export function getFloorTopologySnapshot(): FloorTopology | null {
  ensureStarted()
  return latestTopology
}

export function subscribeFloorTopology(listener: FloorTopologyListener): () => void {
  ensureStarted()
  subscribers.add(listener)
  debugLog(`sub +1 total=${subscribers.size}`)
  if (latestTopology) listener(latestTopology)
  return () => {
    subscribers.delete(listener)
    debugLog(`sub -1 total=${subscribers.size}`)
  }
}

function ensureStarted() {
  if (started) return
  started = true
  debugLog('start')
  startGrpcLoop()
}

function publish(topology: FloorTopology | null) {
  latestTopology = topology
  for (const listener of subscribers) listener(topology)
}

function clearAsStale() {
  debugLog('clear stale')
  publish(null)
}

function scheduleStaleClear() {
  if (staleTimer) clearTimeout(staleTimer)
  staleTimer = setTimeout(clearAsStale, topologyStaleMs)
}

function scheduleReconnect() {
  if (reconnectTimer) return
  if (fatalError) return

  const nextAttempt = reconnectAttempt + 1
  const delayMs = getReconnectDelayMs(nextAttempt)
  reconnectAttempt = nextAttempt

  debugLog(`reconn ${delayMs}ms #${reconnectAttempt}`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startGrpcLoop()
  }, delayMs)
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

function numberOrNull(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizePoint3(raw: unknown): Point3 | null {
  const p = raw as RawPoint3
  const x = numberOrNull(p?.x)
  const y = numberOrNull(p?.y)
  const z = numberOrNull(p?.z)
  if (x == null || y == null || z == null) return null
  return { x, y, z }
}

function normalizePolyline(raw: unknown): FloorPolyline | null {
  const p = raw as RawFloorPolyline

  const ns = typeof p?.ns === 'string' ? p.ns : ''

  const idRaw = p?.id
  const id = typeof idRaw === 'number' ? idRaw : Number(idRaw ?? 0)
  if (!Number.isFinite(id) || id < 0) return null

  const frameId = typeof p?.frame_id === 'string' ? p.frame_id : ''
  if (frameId !== EXPECTED_POLYLINE_FRAME_ID) {
    throw new Error(
      `Unexpected FloorPolyline.frame_id="${frameId}" ns="${ns}" id=${id} (expected "${EXPECTED_POLYLINE_FRAME_ID}")`,
    )
  }

  const pointsRaw = p?.points
  const pts = Array.isArray(pointsRaw) ? pointsRaw : []

  const points: Point3[] = []
  for (const pt of pts) {
    const normalized = normalizePoint3(pt)
    if (!normalized) continue
    points.push(normalized)
  }

  const closed = Boolean(p?.closed)

  return { ns, id, frameId, points, closed }
}

function normalizeFloorTopologyUpdate(raw: RawFloorTopologyUpdate): FloorTopology | null {
  const timestampUnixMs = numberOrNull(raw.timestamp_unix_ms)
  if (timestampUnixMs == null) {
    debugLog(`drop: invalid timestamp_unix_ms=${String(raw.timestamp_unix_ms)}`)
    return null
  }

  const seq = normalizeSeq(raw.seq)

  const polylinesRaw = raw.polylines
  if (polylinesRaw != null && !Array.isArray(polylinesRaw)) {
    debugLog(`drop: polylines not array (type=${typeof polylinesRaw})`)
    return null
  }
  const arr = Array.isArray(polylinesRaw) ? polylinesRaw : []

  const polylines: FloorPolyline[] = []
  for (const p of arr) {
    const normalized = normalizePolyline(p)
    if (!normalized) continue
    polylines.push(normalized)
  }

  return { timestampUnixMs, seq, polylines }
}

function failFatal(err: unknown) {
  if (fatalError) return
  fatalError = err instanceof Error ? err.message : String(err)

  errorLog(`fatal: ${fatalError}`)

  activeCall?.removeAllListeners()
  activeCall = null

  activeClient?.close()
  activeClient = null

  if (noDataTimer) {
    clearTimeout(noDataTimer)
    noDataTimer = null
  }

  clearAsStale()
}

function startGrpcLoop() {
  if (activeCall) return
  if (fatalError) return
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

    const call = client.StreamFloorTopology({})
    activeCall = call
    gotDataSinceConnect = false
    if (noDataTimer) {
      clearTimeout(noDataTimer)
      noDataTimer = null
    }
    noDataTimer = setTimeout(() => {
      if (fatalError) return
      if (activeCall && !gotDataSinceConnect) {
        debugLog('waiting (no data yet) — is /floor/topology publishing?')
      }
    }, 5_000)

    call.on('data', (raw: RawFloorTopologyUpdate) => {
      if (fatalError) return
      if (!gotDataSinceConnect) {
        gotDataSinceConnect = true
        reconnectAttempt = 0
        retryLog.markSuccess()
        if (noDataTimer) {
          clearTimeout(noDataTimer)
          noDataTimer = null
        }
      }

      try {
        const normalized = normalizeFloorTopologyUpdate(raw)
        if (!normalized) return

        debugLog(
          `seq=${normalized.seq} polylines=${normalized.polylines.length} points=${normalized.polylines.reduce((acc, p) => acc + p.points.length, 0)}`,
        )

        publish(normalized)
        scheduleStaleClear()
      } catch (err) {
        failFatal(err)
        try {
          call.cancel()
        } catch {
          // ignore cancel errors
        }
      }
    })

    const onDisconnect = (err?: unknown) => {
      if (fatalError) return
      if (err) retryLog.logFailure('down', err)
      else debugLog('end')

      activeCall?.removeAllListeners()
      activeCall = null

      activeClient?.close()
      activeClient = null

      if (noDataTimer) {
        clearTimeout(noDataTimer)
        noDataTimer = null
      }

      // Clear on disconnect for staleness policy
      clearAsStale()

      scheduleReconnect()
    }

    call.on('error', (err: unknown) => onDisconnect(err))
    call.on('end', () => onDisconnect())
  } catch (err) {
    if (fatalError) return
    retryLog.logFailure('down', err)
    activeCall?.removeAllListeners()
    activeCall = null
    activeClient?.close()
    activeClient = null
    if (noDataTimer) {
      clearTimeout(noDataTimer)
      noDataTimer = null
    }
    scheduleReconnect()
  }
}
