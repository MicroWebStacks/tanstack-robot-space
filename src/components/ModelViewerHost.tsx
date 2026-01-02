import { useRouterState } from '@tanstack/react-router'
import { Maximize2, Minimize2 } from 'lucide-react'
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

import type { ModelMetaResponse } from '../lib/robotModelClient'
import { ensureRobotModelReady, getCachedRobotModelMeta } from '../lib/robotModelClient'
import { LidarScanProvider } from '../lib/lidarClient'
import { OccupancyMapProvider } from '../lib/occupancyMapClient'

const ModelViewerCanvas = lazy(() => import('./ModelViewerCanvas'))

function useIsModelRoute() {
  return useRouterState({
    select: (state) => state.location.pathname === '/model',
  })
}

export default function ModelViewerHost() {
  const isModelRoute = useIsModelRoute()
  const containerRef = useRef<HTMLDivElement | null>(null)

  const [isClient, setIsClient] = useState(false)
  const [hasEverBeenActive, setHasEverBeenActive] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [modelMeta, setModelMeta] = useState<ModelMetaResponse | null>(null)
  const [modelUrl, setModelUrl] = useState<string | null>(null)
  const [metaError, setMetaError] = useState<string | null>(null)

  useEffect(() => {
    setIsClient(true)
  }, [])

  useEffect(() => {
    if (!isModelRoute) return
    setHasEverBeenActive(true)
  }, [isModelRoute])

  useEffect(() => {
    if (!isClient) return

    const onChange = () => {
      const container = containerRef.current
      setIsFullscreen(
        container != null && document.fullscreenElement === container,
      )
    }

    document.addEventListener('fullscreenchange', onChange)
    onChange()

    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [isClient])

  useEffect(() => {
    if (!isClient) return
    if (isModelRoute) return

    const container = containerRef.current
    if (container != null && document.fullscreenElement === container) {
      document.exitFullscreen().catch(() => {})
    }
  }, [isClient, isModelRoute])

  useEffect(() => {
    if (!isClient) return

    // Consume the startup singleton. No refetches on route swaps.
    const cached = getCachedRobotModelMeta()
    if (cached) {
      setModelMeta(cached)
      setModelUrl(cached.url)
      return
    }

    let cancelled = false
    setMetaError(null)
    ensureRobotModelReady()
      .then((data) => {
        if (cancelled) return
        setModelMeta(data)
        setModelUrl(data.url)
      })
      .catch((err) => {
        if (cancelled) return
        setMetaError(String(err))
      })

    return () => {
      cancelled = true
    }
  }, [isClient])

  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current
    if (!container) return

    try {
      if (document.fullscreenElement === container) {
        await document.exitFullscreen()
      } else {
        await container.requestFullscreen()
      }
    } catch {
      // ignore fullscreen errors (blocked, user gesture missing, etc.)
    }
  }, [])

  if (!isClient) return null
  if (!hasEverBeenActive && !isModelRoute) return null

  return (
    <div
      ref={containerRef}
      className={[
        'fixed left-0 right-0 bottom-0 z-40 bg-black',
        isModelRoute ? '' : 'hidden',
      ].join(' ')}
      style={{
        top: isFullscreen ? 0 : 'var(--app-header-height, 72px)',
        left: isFullscreen ? 0 : 'var(--app-sidebar-width, 0px)',
      }}
    >
      <div className="absolute top-3 right-3 z-10">
        <button
          type="button"
          onClick={toggleFullscreen}
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 text-sm font-medium text-white shadow-lg shadow-black/30 backdrop-blur hover:bg-slate-900/90"
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          {isFullscreen ? 'Exit' : 'Fullscreen'}
        </button>
      </div>

      <Suspense
        fallback={
          <div className="flex h-full w-full items-center justify-center text-sm text-slate-300">
            Loading viewer…
          </div>
        }
      >
        {isModelRoute ? (
          <LidarScanProvider>
            <OccupancyMapProvider>
              <ModelViewerCanvas active={isModelRoute} modelUrl={modelUrl} />
            </OccupancyMapProvider>
          </LidarScanProvider>
        ) : null}
      </Suspense>
      {(metaError || modelMeta) && (
        <div className="pointer-events-none absolute left-4 bottom-4 rounded-lg bg-white/10 px-3 py-2 text-xs text-white shadow-xl backdrop-blur">
          {metaError
            ? `Model error: ${metaError}`
            : `Model cached: ${modelMeta?.filename ?? 'loading…'}`}
        </div>
      )}
    </div>
  )
}
