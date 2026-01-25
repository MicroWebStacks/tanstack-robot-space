const ONE_MIN_MS = 60_000
const FIVE_MIN_MS = 300_000
const MAX_LEN = 120

function formatError(err: unknown): string {
  if (!err) return 'unknown error'

  const code =
    typeof err === 'object' && err && 'code' in err && typeof (err as any).code === 'string'
      ? (err as any).code
      : null

  const raw = err instanceof Error ? err.message : String(err)

  const cleaned = raw
    .replace(/Last error:\s*Error:\s*/gi, '')
    .replace(/Resolution note:\s*/gi, '')
    .replace(/No connection established\.?\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

  const withCode = code ? `${code} ${cleaned}` : cleaned
  if (withCode.length <= MAX_LEN) return withCode
  return `${withCode.slice(0, MAX_LEN - 3)}...`
}

export function createRetryLogger(prefix: string) {
  let lastLoggedAt: number | null = null
  let nextWindowMs = ONE_MIN_MS
  let suppressed = 0
  let windowStart = Date.now()

  function reset() {
    lastLoggedAt = null
    nextWindowMs = ONE_MIN_MS
    suppressed = 0
    windowStart = Date.now()
  }

  function logFailure(context: string, err?: unknown) {
    const now = Date.now()

    // first failure: log immediately
    if (lastLoggedAt === null) {
      const ts = new Date(now).toISOString()
      process.stderr.write(
        `${ts} ${prefix} ${context}: ${formatError(err)} hidden=0 over=0s\n`,
      )
      lastLoggedAt = now
      nextWindowMs = ONE_MIN_MS
      suppressed = 0
      windowStart = now
      return
    }

    const withinWindow = now - lastLoggedAt < nextWindowMs
    if (withinWindow) {
      suppressed += 1
      return
    }

    const hidden = suppressed
    const overMs = now - windowStart
    const ts = new Date(now).toISOString()
    process.stderr.write(
      `${ts} ${prefix} ${context}: ${formatError(err)} hidden=${hidden} over=${Math.round(overMs / 1000)}s\n`,
    )

    suppressed = 0
    windowStart = now
    lastLoggedAt = now
    nextWindowMs = FIVE_MIN_MS
  }

  function markSuccess() {
    reset()
  }

  return { logFailure, markSuccess }
}

declare global {
  // eslint-disable-next-line no-var
  var __tanstackGrpcRetryLogger: ReturnType<typeof createRetryLogger> | undefined
}

export function getGrpcRetryLogger(): ReturnType<typeof createRetryLogger> {
  const g = globalThis as typeof globalThis & {
    __tanstackGrpcRetryLogger?: ReturnType<typeof createRetryLogger>
  }
  if (!g.__tanstackGrpcRetryLogger) {
    g.__tanstackGrpcRetryLogger = createRetryLogger('[grpc]')
  }
  return g.__tanstackGrpcRetryLogger
}
