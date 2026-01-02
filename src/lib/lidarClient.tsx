import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { LidarScan } from './lidarScan'
import { DEFAULT_BRIDGE_STALE_MS } from './robotStatus'

type LidarScanContextValue = {
  scan: LidarScan | null
}

const LidarScanContext = createContext<LidarScanContextValue | null>(null)

export function LidarScanProvider({ children }: { children: React.ReactNode }) {
  const [scan, setScan] = useState<LidarScan | null>(null)
  const staleTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false

    const clearStaleTimeout = () => {
      if (staleTimeoutRef.current == null) return
      window.clearTimeout(staleTimeoutRef.current)
      staleTimeoutRef.current = null
    }

    const applyScan = (next: LidarScan | null) => {
      if (cancelled) return

      clearStaleTimeout()
      setScan(next)

      if (!next) return
      staleTimeoutRef.current = window.setTimeout(() => {
        setScan(null)
      }, DEFAULT_BRIDGE_STALE_MS)
    }

    fetch('/api/lidar')
      .then((res) => res.json() as Promise<{ scan: LidarScan | null }>)
      .then((data) => applyScan(data.scan ?? null))
      .catch(() => {})

    const es = new EventSource('/api/lidar/stream')

    const onScan = (event: MessageEvent<string>) => {
      try {
        applyScan(JSON.parse(event.data) as LidarScan)
      } catch {
        // ignore malformed frames
      }
    }

    const onClear = () => applyScan(null)

    es.addEventListener('scan', onScan as EventListener)
    es.addEventListener('clear', onClear)
    es.addEventListener('error', onClear)

    return () => {
      cancelled = true
      clearStaleTimeout()
      es.close()
    }
  }, [])

  const value = useMemo(() => ({ scan }), [scan])

  return (
    <LidarScanContext.Provider value={value}>
      {children}
    </LidarScanContext.Provider>
  )
}

export function useLidarScan(): LidarScanContextValue {
  const value = useContext(LidarScanContext)
  if (!value) {
    throw new Error('useLidarScan must be used within a <LidarScanProvider>')
  }
  return value
}
