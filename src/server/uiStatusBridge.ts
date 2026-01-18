import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

import type {
  UiStatusSnapshot,
  UiStatusUpdate,
  UiTime,
  UiStatusFieldMeta,
} from '../lib/robotStatus'
import { DEFAULT_GRPC_ADDR, DEFAULT_GRPC_RECONNECT_MS } from '../lib/robotStatus'

import { isEnvTrue, loadRootEnvOnce } from './env'
import { getUiStatusConfig } from './uiStatusConfig'

loadRootEnvOnce()

const LOG_PREFIX = '[ui-status]'

const debugStatus = isEnvTrue('DEBUG_STATUS')

function debugLog(line: string) {
  if (!debugStatus) return
  process.stdout.write(`${LOG_PREFIX} ${line}\n`)
}

function debugError(line: string, err?: unknown) {
  const suffix = err ? ` ${String(err)}` : ''
  process.stderr.write(`${LOG_PREFIX} ${line}${suffix}\n`)
}

type RawTime = {
  sec?: unknown
  nanosec?: unknown
}

type RawStatusFieldMeta = {
  id?: unknown
  unit?: unknown
  min?: unknown
  max?: unknown
  target?: unknown
}

type RawStatusFieldValue = {
  id?: unknown
  value?: unknown
  stamp?: unknown
}

type RawStatusSnapshot = {
  stamp?: unknown
  seq?: unknown
  wall_time_unix_ms?: unknown
  fields?: unknown
  values?: unknown
  current_launch_ref?: unknown
  stack?: unknown
  fixed_frame?: unknown
}

type RawStatusUpdate = {
  stamp?: unknown
  seq?: unknown
  wall_time_unix_ms?: unknown
  values?: unknown
  current_launch_ref?: unknown
  stack?: unknown
  fixed_frame?: unknown
}

type UiBridgeClient = grpc.Client & {
  GetStatus: (
    req: Record<string, never>,
    meta: grpc.Metadata,
    options: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res?: RawStatusSnapshot) => void,
  ) => void
  GetStatus: (
    req: Record<string, never>,
    options: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res?: RawStatusSnapshot) => void,
  ) => void
  StreamStatus: (req: Record<string, never>) => grpc.ClientReadableStream<RawStatusUpdate>
}

const grpcAddr = process.env.UI_GATEWAY_GRPC_ADDR ?? DEFAULT_GRPC_ADDR

const grpcDeadlineMs =
  Number(process.env.UI_GATEWAY_GRPC_DEADLINE_MS ?? DEFAULT_GRPC_RECONNECT_MS) ||
  DEFAULT_GRPC_RECONNECT_MS

let cachedClientCtor: grpc.ServiceClientConstructor | null = null

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

function getUiBridgeClientCtor(): grpc.ServiceClientConstructor {
  if (cachedClientCtor) return cachedClientCtor

  const protoPath = resolveProtoPath()
  const packageDef = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  })

  const proto = grpc.loadPackageDefinition(packageDef) as any
  const UiBridgeCtor = proto?.roblibs?.ui_bridge?.v1?.UiBridge as
    | grpc.ServiceClientConstructor
    | undefined
  if (!UiBridgeCtor) {
    throw new Error(
      'Failed to load UiBridge from proto; expected roblibs.ui_bridge.v1.UiBridge',
    )
  }

  cachedClientCtor = UiBridgeCtor
  return UiBridgeCtor
}

function createUiBridgeClient(): UiBridgeClient {
  const Ctor = getUiBridgeClientCtor()
  return new Ctor(grpcAddr, grpc.credentials.createInsecure()) as unknown as UiBridgeClient
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function numberOrDefault(value: unknown, defaultValue: number): number | null {
  if (value == null) return defaultValue
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

function normalizeTime(raw: unknown): UiTime {
  const t = raw as RawTime
  const sec = Number(t?.sec ?? 0)
  const nanosec = Number(t?.nanosec ?? 0)
  return {
    sec: Number.isFinite(sec) ? sec : 0,
    nanosec: Number.isFinite(nanosec) ? nanosec : 0,
  }
}

function normalizeMeta(raw: RawStatusFieldMeta): UiStatusFieldMeta | null {
  const id = typeof raw?.id === 'string' ? raw.id : null
  if (!id) return null

  return {
    id,
    unit: typeof raw?.unit === 'string' ? raw.unit : '',
    min: numberOrNull(raw?.min),
    max: numberOrNull(raw?.max),
    target: numberOrNull(raw?.target),
  }
}

function normalizeValuesMap(
  rawValues: unknown,
  selectedIds: string[],
): Record<string, number | null> {
  const selectedSet = new Set(selectedIds)
  const out: Record<string, number | null> = {}
  for (const id of selectedIds) out[id] = null

  const values = Array.isArray(rawValues) ? (rawValues as RawStatusFieldValue[]) : []
  for (const v of values) {
    const id = typeof v?.id === 'string' ? v.id : null
    if (!id || !selectedSet.has(id)) continue
    // proto3 float defaults to 0, and proto-loader may omit 0 when `defaults:false`.
    // Presence is represented by the StatusFieldValue message itself, so treat missing
    // scalar values as 0 rather than null.
    const value = numberOrDefault(v?.value, 0)
    if (value == null) continue
    out[id] = value
  }
  return out
}

function normalizeContextString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeSnapshot(
  raw: RawStatusSnapshot,
  selectedIds: string[],
  labelsById: Record<string, string>,
): UiStatusSnapshot {
  const fieldsRaw = Array.isArray(raw.fields) ? (raw.fields as RawStatusFieldMeta[]) : []
  const metaById = new Map<string, UiStatusFieldMeta>()
  for (const m of fieldsRaw) {
    const meta = normalizeMeta(m)
    if (!meta) continue
    metaById.set(meta.id, meta)
  }

  const fields: UiStatusFieldMeta[] = selectedIds.map((id) => {
    const meta = metaById.get(id)
    const label = labelsById[id]
    return (
      meta
        ? { ...meta, label }
        : {
            id,
            label,
            unit: '',
            min: null,
            max: null,
            target: null,
          }
    )
  })

  return {
    stamp: normalizeTime(raw.stamp),
    seq: normalizeSeq(raw.seq),
    wallTimeUnixMs: numberOrNull(raw.wall_time_unix_ms),
    fields,
    values: normalizeValuesMap(raw.values, selectedIds),
    currentLaunchRef: normalizeContextString(raw.current_launch_ref),
    stack: normalizeContextString(raw.stack),
    fixedFrame: normalizeContextString(raw.fixed_frame),
  }
}

function normalizeUpdate(
  raw: RawStatusUpdate,
  selectedIds: string[],
): UiStatusUpdate {
  return {
    stamp: normalizeTime(raw.stamp),
    seq: normalizeSeq(raw.seq),
    wallTimeUnixMs: numberOrNull(raw.wall_time_unix_ms),
    values: normalizeValuesMap(raw.values, selectedIds),
    currentLaunchRef: normalizeContextString(raw.current_launch_ref),
    stack: normalizeContextString(raw.stack),
    fixedFrame: normalizeContextString(raw.fixed_frame),
  }
}

export async function fetchUiStatusSnapshot(
  config = getUiStatusConfig(),
): Promise<UiStatusSnapshot> {
  const selectedIds = config.selectedIds
  const labelsById = config.labelsById
  const client = createUiBridgeClient()
  try {
    const deadline = new Date(Date.now() + grpcDeadlineMs)
    const raw = await new Promise<RawStatusSnapshot>((resolve, reject) => {
      client.GetStatus(
        {},
        { deadline },
        (err: grpc.ServiceError | null, res?: RawStatusSnapshot) => {
          if (err) reject(err)
          else resolve(res ?? ({} as RawStatusSnapshot))
        },
      )
    })
    const normalized = normalizeSnapshot(raw, selectedIds, labelsById)
    if (debugStatus) {
      const rawValueIds = Array.isArray(raw.values)
        ? Array.from(
            new Set(
              (raw.values as RawStatusFieldValue[])
                .map((v) => (typeof v?.id === 'string' ? v.id : null))
                .filter((v): v is string => Boolean(v)),
            ),
          )
        : []
      const present = selectedIds.filter((id) => normalized.values[id] != null)
      const missing = selectedIds.filter((id) => normalized.values[id] == null)
      const filteredOut = rawValueIds.filter((id) => !selectedIds.includes(id))

      debugLog(
        [
          `get seq=${normalized.seq}`,
          `selected=${selectedIds.length}`,
          `present=${present.length}${present.length ? `(${present.join(',')})` : ''}`,
          `missing=${missing.length}${missing.length ? `(${missing.join(',')})` : ''}`,
          `raw_ids=${rawValueIds.length}${rawValueIds.length ? `(${rawValueIds.join(',')})` : ''}`,
          `filtered_out=${filteredOut.length}${filteredOut.length ? `(${filteredOut.join(',')})` : ''}`,
        ].join(' '),
      )
    }
    return normalized
  } finally {
    client.close()
  }
}

export function openUiStatusStream(
  config = getUiStatusConfig(),
): {
  call: grpc.ClientReadableStream<RawStatusUpdate>
  close: () => void
  selectedIds: string[]
} {
  const selectedIds = config.selectedIds
  const client = createUiBridgeClient()
  const call = client.StreamStatus({})

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      call.cancel()
    } catch {
      // ignore
    }
    try {
      client.close()
    } catch {
      // ignore
    }
  }

  call.on('error', (err: unknown) => {
    debugError('stream err', err)
    close()
  })
  call.on('end', () => {
    debugLog('stream end')
    close()
  })

  return { call, close, selectedIds }
}

export function normalizeUiStatusUpdate(
  raw: RawStatusUpdate,
  selectedIds: string[],
): UiStatusUpdate {
  const update = normalizeUpdate(raw, selectedIds)
  if (debugStatus) {
    const present = selectedIds.filter((id) => update.values[id] != null)
    const missing = selectedIds.filter((id) => update.values[id] == null)
    debugLog(
      [
        `stream seq=${update.seq}`,
        `present=${present.length}${present.length ? `(${present.join(',')})` : ''}`,
        `missing=${missing.length}${missing.length ? `(${missing.join(',')})` : ''}`,
      ].join(' '),
    )
  }
  return update
}
