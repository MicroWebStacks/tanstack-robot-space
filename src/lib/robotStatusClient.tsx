import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { UiStatusFieldMeta, UiStatusSnapshot, UiStatusUpdate } from './robotStatus'

type RobotStatusContextValue = {
  status: UiStatusSnapshot | null
}

const RobotStatusContext = createContext<RobotStatusContextValue | null>(null)

export function RobotStatusProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<UiStatusSnapshot | null>(null)
  const cachedFieldsRef = useRef<UiStatusFieldMeta[] | null>(null)

  useEffect(() => {
    let cancelled = false
    let es: EventSource | null = null

    const applySnapshot = (next: UiStatusSnapshot | null) => {
      if (cancelled) return
      setStatus(next)
      if (next?.fields?.length) cachedFieldsRef.current = next.fields
    }

    const start = async () => {
      try {
        const res = await fetch('/api/status', { cache: 'no-store' })
        const data = (await res.json()) as { status: UiStatusSnapshot | null }
        applySnapshot(data.status ?? null)
      } catch {
        applySnapshot(null)
      }

      if (cancelled) return

      es = new EventSource('/api/status/stream')

      const onStatus = (event: MessageEvent<string>) => {
        try {
          const update = JSON.parse(event.data) as UiStatusUpdate
          const fields = cachedFieldsRef.current
          setStatus((prev) => {
            if (cancelled) return prev
            if (prev?.fields?.length) return { ...update, fields: prev.fields }
            if (fields?.length) return { ...update, fields }
            const fallbackFields: UiStatusFieldMeta[] = Object.keys(update.values ?? {}).map(
              (id) => ({
                id,
                unit: '',
                min: null,
                max: null,
                target: null,
              }),
            )
            return { ...update, fields: fallbackFields }
          })
        } catch {
          // ignore malformed frames
        }
      }

      const onClear = () => applySnapshot(null)

      es.addEventListener('status', onStatus as EventListener)
      es.addEventListener('clear', onClear)
    }

    start().catch(() => {})

    return () => {
      cancelled = true
      es?.close()
      es = null
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
