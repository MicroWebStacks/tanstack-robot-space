import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

import { DEFAULT_GRPC_ADDR } from '../lib/robotStatus'

const MODEL_CACHE_DIR = path.resolve(process.cwd(), '.cache', 'models')
const MODEL_PREFIX = 'robot-model-'
const MODEL_EXT = '.glb'
const HASH_PREFIX_LEN = 10

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
  const client = loadUiBridgeClient()
  return await new Promise<RobotModelMeta>((resolve, reject) => {
    client.GetRobotModelMeta({}, (err: grpc.ServiceError | null, res: any) => {
      client.close()
      if (err) return reject(err)
      try {
        resolve(normalizeMeta(res))
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
}

async function ensureModelCached(): Promise<CachedModel> {
  if (inflight) return inflight

  inflight = (async () => {
    const meta = await fetchMeta()
    const hashPrefix = meta.sha256.slice(0, HASH_PREFIX_LEN)
    const filename = `${MODEL_PREFIX}${hashPrefix}${MODEL_EXT}`
    const filePath = path.join(MODEL_CACHE_DIR, filename)

    const existingSize = await fileSize(filePath)
    if (existingSize === meta.sizeBytes) {
      await deleteOtherModels(filename)
      return { meta, filename, filePath }
    }

    await downloadModel(meta, filePath)
    await deleteOtherModels(filename)
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
  return await ensureModelCached()
}

export async function serveRobotModelFile(
  filename: string,
  request: Request,
): Promise<Response> {
  const { filePath, meta } = await ensureModelCached()
  const expected = `${MODEL_PREFIX}${meta.sha256.slice(0, HASH_PREFIX_LEN)}${MODEL_EXT}`
  if (filename !== expected) {
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
      return new Response('Requested Range Not Satisfiable', { status: 416 })
    }

    const nodeStream = fs.createReadStream(filePath, { start, end })
    const stream = Readable.toWeb(nodeStream) as unknown as ReadableStream
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
  return new Response(stream, {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Length': String(size),
    },
  })
}
