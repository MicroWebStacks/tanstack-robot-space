import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { isEnvTrue, loadRootEnvOnce } from './env'

const LOG_PREFIX = '[robot-model-cache]'

function shouldLogModel(): boolean {
  loadRootEnvOnce()
  return (
    isEnvTrue('DEBUG_MODEL')
  )
}

function log(message: string, data?: unknown) {
  if (!shouldLogModel()) return
  const suffix =
    data === undefined
      ? ''
      : ` ${JSON.stringify(data, (_k, v) => (v === undefined ? null : v))}`

  // Write directly to stdout to avoid noisy dev wrappers that add file/URL metadata.
  process.stdout.write(`${LOG_PREFIX} ${message}${suffix}\n`)
}

function normalizeEnvPath(raw: string): string {
  const trimmed = raw.trim()

  if (process.platform === 'win32') {
    // Support WSL UNC paths like:
    //   \\wsl.localhost\Ubuntu\home\...
    // and also tolerate forward slashes after the host:
    //   \\wsl.localhost/Ubuntu/home/...
    // plus the //wsl.localhost/Ubuntu/... form.
    if (trimmed.startsWith('\\') || trimmed.startsWith('//')) {
      let p = trimmed
      if (p.startsWith('//')) p = `\\\\${p.slice(2)}`
      p = p.split('/').join('\\')

      // If a config/parser collapses the UNC prefix to a single leading slash,
      // repair common WSL forms.
      if (p.startsWith('\\wsl.localhost\\') && !p.startsWith('\\\\wsl.localhost\\')) {
        p = `\\${p}`
      }
      if (p.startsWith('\\wsl$\\') && !p.startsWith('\\\\wsl$\\')) {
        p = `\\${p}`
      }
      return p
    }
  }

  if (path.isAbsolute(trimmed)) return trimmed
  return path.resolve(process.cwd(), trimmed)
}

type RobotModelMeta = {
  coordinate_convention?: unknown
  generator?: unknown
  glb: {
    filename: string
  }
  [k: string]: unknown
}

type CachedModel = {
  meta: RobotModelMeta
  filename: string
  filePath: string
}
async function fileSize(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(filePath)
    return stat.size
  } catch {
    return null
  }
}

function resolveModelMetaPath(): string {
  loadRootEnvOnce()
  const raw = process.env.MODEL_META
  if (!raw) {
    throw new Error('MODEL_META is not set (expected an absolute path to *.meta.json)')
  }
  return normalizeEnvPath(raw)
}

async function readModelMeta(): Promise<CachedModel> {
  const metaPath = resolveModelMetaPath()
  const raw = await fs.promises.readFile(metaPath, 'utf8')
  const meta = JSON.parse(raw) as RobotModelMeta

  const filename = meta?.glb?.filename
  if (typeof filename !== 'string' || !filename.length) {
    throw new Error('MODEL_META JSON missing glb.filename')
  }

  // The .glb sits next to the meta json file.
  const filePath = path.join(path.dirname(metaPath), filename)
  return { meta, filename, filePath }
}

export async function getRobotModelMeta(): Promise<{
  meta: RobotModelMeta
  filename: string
  filePath: string
}> {
  log('meta>get')
  return await readModelMeta()
}

export async function serveRobotModelFile(
  filename: string,
  request: Request,
): Promise<Response> {
  log('glb>get', {
    file: filename,
    range: request.headers.get('range') ?? null,
  })
  const { filePath, filename: expectedFilename } = await readModelMeta()
  if (filename !== expectedFilename) {
    log('glb>mismatch', { requested: filename, expected: expectedFilename })
    return new Response('Not found', { status: 404 })
  }

  const size = await fileSize(filePath)
  if (size == null) return new Response('Not found', { status: 404 })

  const etag = `"${filename}"`
  const ifNoneMatch = request.headers.get('if-none-match')
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: etag,
      },
    })
  }

  const range = request.headers.get('range')
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'model/gltf-binary',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
    'Accept-Ranges': 'bytes',
  }

  if (range && range.startsWith('bytes=')) {
    const [startStr, endStr] = range.replace('bytes=', '').split('-', 2)
    const start = Number(startStr)
    const end =
      endStr && endStr.length > 0 ? Number(endStr) : Number(size) - 1

    if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < start || start >= size) {
      log('glb>range-invalid', { start, end, size })
      return new Response('Requested Range Not Satisfiable', { status: 416 })
    }

    const nodeStream = fs.createReadStream(filePath, { start, end })
    const stream = Readable.toWeb(nodeStream) as unknown as ReadableStream
    log('glb>206', { file: filename, start, end, size })
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
  log('glb>200', { file: filename, size })
  return new Response(stream, {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Length': String(size),
    },
  })
}
