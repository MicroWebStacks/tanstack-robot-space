import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import type { OccupancyMap } from './occupancyMap'

type OccupancyMapContextValue = {
  map: OccupancyMap | null
}

const OccupancyMapContext = createContext<OccupancyMapContextValue | null>(null)

export function OccupancyMapProvider({ children }: { children: React.ReactNode }) {
  const [map, setMap] = useState<OccupancyMap | null>(null)

  useEffect(() => {
    let cancelled = false

    const applyMap = (next: OccupancyMap | null) => {
      if (cancelled) return
      setMap(next)
    }

    fetch('/api/map')
      .then((res) => res.json() as Promise<{ map: OccupancyMap | null }>)
      .then((data) => applyMap(data.map ?? null))
      .catch(() => {})

    const es = new EventSource('/api/map/stream')

    const onMap = (event: MessageEvent<string>) => {
      try {
        applyMap(JSON.parse(event.data) as OccupancyMap)
      } catch {
        // ignore malformed frames
      }
    }

    const onClear = () => applyMap(null)

    es.addEventListener('map', onMap as EventListener)
    es.addEventListener('clear', onClear)
    es.addEventListener('error', onClear)

    return () => {
      cancelled = true
      es.close()
    }
  }, [])

  const value = useMemo(() => ({ map }), [map])

  return (
    <OccupancyMapContext.Provider value={value}>
      {children}
    </OccupancyMapContext.Provider>
  )
}

export function useOccupancyMap(): OccupancyMapContextValue {
  const value = useContext(OccupancyMapContext)
  if (!value) {
    throw new Error('useOccupancyMap must be used within a <OccupancyMapProvider>')
  }
  return value
}

