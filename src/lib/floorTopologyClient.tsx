import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { FloorTopology } from './floorTopology'
import { DEFAULT_BRIDGE_STALE_MS } from './robotStatus'

type FloorTopologyContextValue = {
  topology: FloorTopology | null
}

const FloorTopologyContext = createContext<FloorTopologyContextValue | null>(null)

export function FloorTopologyProvider({ children }: { children: React.ReactNode }) {
  const [topology, setTopology] = useState<FloorTopology | null>(null)
  const staleTimeoutRef = useRef<number | null>(null)
  const debugFirstUpdateRef = useRef(false)
  const debugWarnedSnapshotRef = useRef(false)
  const debugWarnedSseErrorRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const debug = import.meta.env.DEV

    const clearStaleTimeout = () => {
      if (staleTimeoutRef.current == null) return
      window.clearTimeout(staleTimeoutRef.current)
      staleTimeoutRef.current = null
    }

    const applyTopology = (next: FloorTopology | null) => {
      if (cancelled) return

      clearStaleTimeout()
      setTopology(next)

      if (!next) return
      staleTimeoutRef.current = window.setTimeout(() => {
        setTopology(null)
      }, DEFAULT_BRIDGE_STALE_MS)
    }

    fetch('/api/floor-topology')
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`)
        }
        return res.json() as Promise<{ topology: FloorTopology | null }>
      })
      .then((data) => applyTopology(data.topology ?? null))
      .catch((err) => {
        if (debug && !debugWarnedSnapshotRef.current) {
          debugWarnedSnapshotRef.current = true
          // eslint-disable-next-line no-console
          console.warn('[topology] snapshot fetch failed', err)
        }
      })

    const es = new EventSource('/api/floor-topology/stream')

    es.onopen = () => {
      if (!debug) return
      // eslint-disable-next-line no-console
      console.log('[topology] sse open')
    }

    const onTopology = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as FloorTopology
        if (debug && !debugFirstUpdateRef.current) {
          debugFirstUpdateRef.current = true
          const points = parsed.polylines.reduce((acc, p) => acc + p.points.length, 0)
          // eslint-disable-next-line no-console
          console.log(
            `[topology] first update seq=${parsed.seq} polylines=${parsed.polylines.length} points=${points}`,
          )
        }
        applyTopology(parsed)
      } catch {
        // ignore malformed frames
      }
    }

    const onClear = () => applyTopology(null)

    es.addEventListener('topology', onTopology as EventListener)
    es.addEventListener('clear', onClear)
    es.addEventListener('error', onClear)
    es.addEventListener('error', () => {
      if (!debug) return
      if (debugWarnedSseErrorRef.current) return
      debugWarnedSseErrorRef.current = true
      // eslint-disable-next-line no-console
      console.warn('[topology] sse error (check /api/floor-topology/stream)')
    })

    return () => {
      cancelled = true
      clearStaleTimeout()
      es.close()
    }
  }, [])

  const value = useMemo(() => ({ topology }), [topology])

  return (
    <FloorTopologyContext.Provider value={value}>
      {children}
    </FloorTopologyContext.Provider>
  )
}

export function useFloorTopology(): FloorTopologyContextValue {
  const value = useContext(FloorTopologyContext)
  if (!value) {
    throw new Error('useFloorTopology must be used within a <FloorTopologyProvider>')
  }
  return value
}
