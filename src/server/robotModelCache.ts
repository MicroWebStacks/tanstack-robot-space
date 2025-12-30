import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

import { DEFAULT_GRPC_ADDR } from '../lib/robotStatus'

const LOG_PREFIX = '[robot-model-cache]'
const MODEL_CACHE_DIR = path.resolve(process.cwd(), '.cache', 'models')
const MODEL_PREFIX = 'robot-model-'
const MODEL_EXT = '.glb'
const HASH_PREFIX_LEN = 10

function log(message: string, data?: unknown) {
  if (data !== undefined) {
    console.log(`${LOG_PREFIX} ${message}`, data)
  } else {
    console.log(`${LOG_PREFIX} ${message}`)
  }
}

type RobotModelMeta = {
  sha256: string
  sizeBytes: number
  wheelJointNames: string[]
  odomFrame?: string
  baseFrame?: string
  mapFrame?: string
}

type CachedModel = {
  meta: RobotModelMeta
  filename: string
  filePath: string
}

type UiBridgeClient = grpc.Client & {
  GetRobotModelMeta: (
    req: unknown,
    cb: (err: grpc.ServiceError | null, res: any) => void,
  ) => grpc.ClientUnaryCall
  GetRobotModel: (req: unknown) => grpc.ClientReadableStream<any>
}

const grpcAddr = process.env.UI_GATEWAY_GRPC_ADDR ?? DEFAULT_GRPC_ADDR

let inflight: Promise<CachedModel> | null = null

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

function loadUiBridgeClient(): UiBridgeClient {
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

  return new UiBridgeClientCtor(
    grpcAddr,
    grpc.credentials.createInsecure(),
  ) as UiBridgeClient
}

function normalizeMeta(raw: any): RobotModelMeta {
  const sha256 = typeof raw?.sha256 === 'string' ? raw.sha256 : ''
  if (!sha256) throw new Error('GetRobotModelMeta returned empty sha256')

  const sizeBytes = Number(raw?.size_bytes)
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error('GetRobotModelMeta returned invalid size_bytes')
  }

  const wheelJointNames = Array.isArray(raw?.wheel_joint_names)
    ? raw.wheel_joint_names.filter((n: unknown) => typeof n === 'string')
    : []

  return {
    sha256,
    sizeBytes,
    wheelJointNames,
    odomFrame: typeof raw?.odom_frame === 'string' ? raw.odom_frame : undefined,
    baseFrame: typeof raw?.base_frame === 'string' ? raw.base_frame : undefined,
    mapFrame: typeof raw?.map_frame === 'string' ? raw.map_frame : undefined,
  }
}

async function fetchMeta(): Promise<RobotModelMeta> {
  log('Fetching robot model metadata from grpc')
  const client = loadUiBridgeClient()
  return await new Promise<RobotModelMeta>((resolve, reject) => {
    client.GetRobotModelMeta({}, (err: grpc.ServiceError | null, res: any) => {
      client.close()
      if (err) return reject(err)
      try {
        const normalized = normalizeMeta(res)
        log('Normalized metadata', {
          sha256: normalized.sha256,
          sizeBytes: normalized.sizeBytes,
        })
        resolve(normalized)
      } catch (e) {
        reject(e)
      }
    })
  })
}

async function ensureCacheDir() {
  await fs.promises.mkdir(MODEL_CACHE_DIR, { recursive: true })
}

async function deleteOtherModels(keepFilename: string) {
  const entries = await fs.promises.readdir(MODEL_CACHE_DIR).catch(() => [])
  await Promise.all(
    entries
      .filter((name) => name !== keepFilename && name.endsWith(MODEL_EXT))
      .map((name) =>
        fs.promises.unlink(path.join(MODEL_CACHE_DIR, name)).catch(() => {}),
      ),
  )
}

async function fileSize(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(filePath)
    return stat.size
  } catch {
    return null
  }
}

async function downloadModel(meta: RobotModelMeta, filePath: string) {
  await ensureCacheDir()
  const tmpPath = `${filePath}.partial`

  await fs.promises.rm(tmpPath, { force: true })

  const client = loadUiBridgeClient()
  const call = client.GetRobotModel({})

  log('Downloading model from grpc stream', {
    tmpPath,
    sizeBytes: meta.sizeBytes,
    sha256: meta.sha256,
  })
  const hash = crypto.createHash('sha256')
  const writeStream = fs.createWriteStream(tmpPath)

  await new Promise<void>((resolve, reject) => {
    call.on('data', (chunk: any) => {
      const buf =
        chunk?.chunk instanceof Uint8Array
          ? chunk.chunk
          : chunk?.chunk?.buffer instanceof ArrayBuffer
            ? Buffer.from(chunk.chunk.buffer)
            : null
      if (!buf) return
      hash.update(buf)
      writeStream.write(buf)
    })

    call.on('end', () => resolve())
    call.on('error', (err: unknown) => reject(err))
    writeStream.on('error', (err) => reject(err))
  })
    .finally(() => {
      writeStream.end()
      client.close()
    })

  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve)
    writeStream.on('error', reject)
  })

  const digest = hash.digest('hex')
  if (digest !== meta.sha256) {
    await fs.promises.rm(tmpPath, { force: true })
    throw new Error(
      `Model digest mismatch (expected ${meta.sha256} got ${digest})`,
    )
  }

  const downloadedSize = await fileSize(tmpPath)
  if (downloadedSize !== meta.sizeBytes) {
    await fs.promises.rm(tmpPath, { force: true })
    throw new Error(
      `Model size mismatch (expected ${meta.sizeBytes} got ${downloadedSize ?? 0})`,
    )
  }

  await fs.promises.rename(tmpPath, filePath)
  log('Model download completed and cached', { filePath })
}

async function ensureModelCached(): Promise<CachedModel> {
  if (inflight) return inflight

  inflight = (async () => {
    const meta = await fetchMeta()
    const hashPrefix = meta.sha256.slice(0, HASH_PREFIX_LEN)
    const filename = `${MODEL_PREFIX}${hashPrefix}${MODEL_EXT}`
    const filePath = path.join(MODEL_CACHE_DIR, filename)

    log('Ensuring cache for model', {
      filename,
      sha256: meta.sha256,
      sizeBytes: meta.sizeBytes,
    })

    const existingSize = await fileSize(filePath)
    if (existingSize === meta.sizeBytes) {
      log('Cache hit, using existing model file', { filename, filePath })
      await deleteOtherModels(filename)
      return { meta, filename, filePath }
    }

    log('Cache miss, downloading new model', { filename, filePath })

    await downloadModel(meta, filePath)
    await deleteOtherModels(filename)
    log('Cache updated with new model', { filename, filePath })
    return { meta, filename, filePath }
  })()

  try {
    return await inflight
  } finally {
    inflight = null
  }
}

export async function getRobotModelMeta(): Promise<{
  meta: RobotModelMeta
  filename: string
  filePath: string
}> {
  log('Client requested robot model metadata')
  return await ensureModelCached()
}

export async function serveRobotModelFile(
  filename: string,
  request: Request,
): Promise<Response> {
  log('Serving model file request', {
    filename,
    url: request.url,
    range: request.headers.get('range'),
  })
  const { filePath, meta } = await ensureModelCached()
  const expected = `${MODEL_PREFIX}${meta.sha256.slice(0, HASH_PREFIX_LEN)}${MODEL_EXT}`
  if (filename !== expected) {
    log('Requested filename mismatch', {
      requested: filename,
      expected,
    })
    return new Response('Not found', { status: 404 })
  }

  const size = await fileSize(filePath)
  if (size == null) return new Response('Not found', { status: 404 })

  const range = request.headers.get('range')
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'model/gltf-binary',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: `"${meta.sha256}"`,
    'Accept-Ranges': 'bytes',
  }

  if (range && range.startsWith('bytes=')) {
    const [startStr, endStr] = range.replace('bytes=', '').split('-', 2)
    const start = Number(startStr)
    const end =
      endStr && endStr.length > 0 ? Number(endStr) : Number(size) - 1

    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start < 0 ||
      end < start ||
      start >= size
    ) {
      log('Invalid range requested', { start, end, size })
      return new Response('Requested Range Not Satisfiable', { status: 416 })
    }

    const nodeStream = fs.createReadStream(filePath, { start, end })
    const stream = Readable.toWeb(nodeStream) as unknown as ReadableStream
    log('Returning partial content for model', {
      start,
      end,
      size,
      filename,
    })
    return new Response(stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
      },
    })
  }

  const nodeStream = fs.createReadStream(filePath)
  const stream = Readable.toWeb(nodeStream) as unknown as ReadableStream
  log('Returning full model content', { filename, size })
  return new Response(stream, {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Length': String(size),
    },
  })
}
