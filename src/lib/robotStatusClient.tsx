import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { RobotStatus } from './robotStatus'
import { DEFAULT_STATUS_STALE_MS } from './robotStatus'

type RobotStatusContextValue = {
  status: RobotStatus | null
}

const RobotStatusContext = createContext<RobotStatusContextValue | null>(null)

export function RobotStatusProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<RobotStatus | null>(null)
  const staleTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false

    const clearStaleTimeout = () => {
      if (staleTimeoutRef.current == null) return
      window.clearTimeout(staleTimeoutRef.current)
      staleTimeoutRef.current = null
    }

    const applyStatus = (next: RobotStatus | null) => {
      if (cancelled) return

      clearStaleTimeout()
      setStatus(next)

      if (!next) return
      staleTimeoutRef.current = window.setTimeout(() => {
        setStatus(null)
      }, DEFAULT_STATUS_STALE_MS)
    }

    fetch('/api/status')
      .then((res) => res.json() as Promise<{ status: RobotStatus | null }>)
      .then((data) => applyStatus(data.status ?? null))
      .catch(() => {})

    const es = new EventSource('/api/status/stream')

    const onStatus = (event: MessageEvent<string>) => {
      try {
        applyStatus(JSON.parse(event.data) as RobotStatus)
      } catch {
        // ignore malformed frames
      }
    }

    const onClear = () => applyStatus(null)

    es.addEventListener('status', onStatus as EventListener)
    es.addEventListener('clear', onClear)

    return () => {
      cancelled = true
      clearStaleTimeout()
      es.close()
    }
  }, [])

  const value = useMemo(() => ({ status }), [status])

  return (
    <RobotStatusContext.Provider value={value}>
      {children}
    </RobotStatusContext.Provider>
  )
}

export function useRobotStatus(): RobotStatusContextValue {
  const value = useContext(RobotStatusContext)
  if (!value) {
    throw new Error('useRobotStatus must be used within a <RobotStatusProvider>')
  }
  return value
}

