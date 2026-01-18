export const DEFAULT_GRPC_ADDR = '127.0.0.1:50051'
export const DEFAULT_GRPC_RECONNECT_MS = 2000
export const DEFAULT_BRIDGE_STALE_MS = 7000

export type UiTime = {
  sec: number
  nanosec: number
}

export type UiStatusFieldMeta = {
  id: string
  label?: string
  unit: string
  min: number | null
  max: number | null
  target: number | null
}

export type UiStatusSnapshot = {
  stamp: UiTime
  seq: string
  wallTimeUnixMs: number | null
  fields: UiStatusFieldMeta[]
  /** Map of id -> value; missing/stale values are null. */
  values: Record<string, number | null>
  currentLaunchRef: string | null
  stack: string | null
  fixedFrame: string | null
}

export type UiStatusUpdate = Omit<UiStatusSnapshot, 'fields'>
