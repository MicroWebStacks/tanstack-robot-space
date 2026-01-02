import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import type { RobotState } from './robotState'

type RobotStateContextValue = {
  state: RobotState | null
}

const RobotStateContext = createContext<RobotStateContextValue | null>(null)

export function RobotStateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RobotState | null>(null)

  useEffect(() => {
    let cancelled = false

    const applyState = (next: RobotState | null) => {
      if (cancelled) return
      setState(next)
    }

    fetch('/api/state')
      .then((res) => res.json() as Promise<{ state: RobotState | null }>)
      .then((data) => applyState(data.state ?? null))
      .catch(() => {})

    const es = new EventSource('/api/state/stream')

    const onState = (event: MessageEvent<string>) => {
      try {
        applyState(JSON.parse(event.data) as RobotState)
      } catch {
        // ignore malformed frames
      }
    }

    const onClear = () => applyState(null)

    es.addEventListener('state', onState as EventListener)
    es.addEventListener('clear', onClear)
    es.addEventListener('error', onClear)

    return () => {
      cancelled = true
      es.close()
    }
  }, [])

  const value = useMemo(() => ({ state }), [state])

  return (
    <RobotStateContext.Provider value={value}>
      {children}
    </RobotStateContext.Provider>
  )
}

export function useRobotState(): RobotStateContextValue {
  const value = useContext(RobotStateContext)
  if (!value) {
    throw new Error('useRobotState must be used within a <RobotStateProvider>')
  }
  return value
}
