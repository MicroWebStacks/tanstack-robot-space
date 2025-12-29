import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

import type { RobotStatus } from '../lib/robotStatus'
import {
  DEFAULT_GRPC_ADDR,
  DEFAULT_GRPC_RECONNECT_MS,
  DEFAULT_STATUS_STALE_MS,
} from '../lib/robotStatus'

type RobotStatusListener = (status: RobotStatus | null) => void

type RawRateMetric = {
  id?: unknown
  hz?: unknown
  target_hz?: unknown
}

type RawStatusUpdate = {
  timestamp_unix_ms?: unknown
  seq?: unknown
  cpu_percent?: unknown
  voltage_v?: unknown
  rates?: unknown
}

const grpcAddr = process.env.UI_GATEWAY_GRPC_ADDR ?? DEFAULT_GRPC_ADDR
const grpcReconnectMs =
  Number(
    process.env.UI_GATEWAY_GRPC_RECONNECT_MS ?? DEFAULT_GRPC_RECONNECT_MS,
  ) || DEFAULT_GRPC_RECONNECT_MS
const statusStaleMs =
  Number(process.env.UI_GATEWAY_STATUS_STALE_MS ?? DEFAULT_STATUS_STALE_MS) ||
  DEFAULT_STATUS_STALE_MS

let started = false

let latestStatus: RobotStatus | null = null
let staleTimer: NodeJS.Timeout | null = null
const subscribers = new Set<RobotStatusListener>()

let reconnectTimer: NodeJS.Timeout | null = null
let activeClient: grpc.Client | null = null
let activeCall: grpc.ClientReadableStream<unknown> | null = null

export function getRobotStatusSnapshot(): RobotStatus | null {
  ensureStarted()
  return latestStatus
}

export function subscribeRobotStatus(
  listener: RobotStatusListener,
): () => void {
  ensureStarted()
  subscribers.add(listener)
  if (latestStatus) listener(latestStatus)
  return () => subscribers.delete(listener)
}

function ensureStarted() {
  if (started) return
  started = true
  startGrpcLoop()
}

function publish(status: RobotStatus | null) {
  latestStatus = status
  for (const listener of subscribers) listener(status)
}

function clearAsStale() {
  publish(null)
}

function scheduleStaleClear() {
  if (staleTimer) clearTimeout(staleTimer)
  staleTimer = setTimeout(clearAsStale, statusStaleMs)
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startGrpcLoop()
  }, grpcReconnectMs)
}

function resolveProtoPath() {
  const fromCwd = path.resolve(process.cwd(), 'proto', 'ui_gateway.proto')
  if (fs.existsSync(fromCwd)) return fromCwd
  return fileURLToPath(new URL('../../proto/ui_gateway.proto', import.meta.url))
}

function normalizeStatusUpdate(update: RawStatusUpdate): RobotStatus | null {
  const timestampUnixMs = Number(update.timestamp_unix_ms)
  if (!Number.isFinite(timestampUnixMs)) return null

  const cpuPercent = Number(update.cpu_percent)
  if (!Number.isFinite(cpuPercent)) return null

  const seqRaw = update.seq
  const seq =
    typeof seqRaw === 'string'
      ? seqRaw
      : typeof seqRaw === 'number'
        ? String(seqRaw)
        : seqRaw != null
          ? String(seqRaw)
          : '0'

  const rates: RobotStatus['rates'] = {}
  const ratesRaw = Array.isArray(update.rates)
    ? (update.rates as RawRateMetric[])
    : []
  for (const metric of ratesRaw) {
    if (!metric) continue
    const id = typeof metric.id === 'string' ? metric.id : null
    if (!id) continue
    const hz = Number(metric.hz)
    if (!Number.isFinite(hz)) continue

    const targetHz = Number(metric.target_hz)
    rates[id] = Number.isFinite(targetHz) ? { hz, targetHz } : { hz }
  }

  const voltageV = Number(update.voltage_v)
  const normalized: RobotStatus = {
    timestampUnixMs,
    seq,
    cpuPercent,
    rates,
  }
  if (Number.isFinite(voltageV)) normalized.voltageV = voltageV

  return normalized
}

function startGrpcLoop() {
  if (activeCall) return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const protoPath = resolveProtoPath()
  const packageDef = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  })

  const proto = grpc.loadPackageDefinition(packageDef) as any
  const UiGatewayClientCtor = proto?.rovi?.ui_gateway?.v1?.UiGateway as
    | grpc.ServiceClientConstructor
    | undefined
  if (!UiGatewayClientCtor) {
    throw new Error(
      'Failed to load UiGateway from proto; expected rovi.ui_gateway.v1.UiGateway',
    )
  }

  const client = new UiGatewayClientCtor(
    grpcAddr,
    grpc.credentials.createInsecure(),
  ) as any
  activeClient = client as grpc.Client

  const call = client.GetStatus({})
  activeCall = call

  call.on('data', (raw: RawStatusUpdate) => {
    const normalized = normalizeStatusUpdate(raw)
    if (!normalized) return
    publish(normalized)
    scheduleStaleClear()
  })

  const onDisconnect = () => {
    activeCall?.removeAllListeners()
    activeCall = null

    activeClient?.close()
    activeClient = null
    scheduleReconnect()
  }

  call.on('error', onDisconnect)
  call.on('end', onDisconnect)
}
