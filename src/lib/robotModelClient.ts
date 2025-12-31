export type ModelMetaResponse = {
  meta: {
    glb?: {
      filename?: unknown
    }
    [k: string]: unknown
  }
  filename: string
  url: string
}

let cached: ModelMetaResponse | null = null
let inflight: Promise<ModelMetaResponse> | null = null

async function fetchModelMeta(): Promise<ModelMetaResponse> {
  const res = await fetch('/api/model/meta', {
    // Always hit the server once per page load. We memoize in memory.
    cache: 'no-store',
  })
  if (!res.ok) {
    let details: string | null = null
    try {
      const body = (await res.json()) as any
      if (typeof body?.error === 'string') details = body.error
    } catch {
      // ignore
    }
    throw new Error(
      details
        ? `Model meta request failed (${res.status}): ${details}`
        : `Model meta request failed (${res.status})`,
    )
  }
  return (await res.json()) as ModelMetaResponse
}

async function prefetchGlb(url: string): Promise<void> {
  const res = await fetch(url, {
    // Prefer using the HTTP cache; URL is hash-protected.
    cache: 'force-cache',
  })

  if (!res.ok) {
    throw new Error(`Model prefetch failed (${res.status})`)
  }

  // Consume the body so browsers will actually cache it.
  await res.arrayBuffer()
}

/**
 * Ensures the model meta + the GLB are fetched once per page load.
 * Subsequent calls reuse the same in-flight promise or cached result.
 */
export function ensureRobotModelReady(): Promise<ModelMetaResponse> {
  if (cached) return Promise.resolve(cached)
  if (inflight) return inflight

  inflight = (async () => {
    const meta = await fetchModelMeta()
    await prefetchGlb(meta.url)
    cached = meta
    return meta
  })().finally(() => {
    inflight = null
  })

  return inflight
}

export function getCachedRobotModelMeta(): ModelMetaResponse | null {
  return cached
}
