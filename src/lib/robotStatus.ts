export const DEFAULT_GRPC_ADDR = '0.0.0.0:50051'
export const DEFAULT_GRPC_RECONNECT_MS = 2000
export const DEFAULT_STATUS_STALE_MS = 7000

export const VOLTAGE_MIN_V = 9
export const VOLTAGE_MAX_V = 13

export const DRIVER_TARGET_HZ = 20
export const SLAM_TARGET_HZ = 30

export type RobotRateSample = {
  hz: number
  targetHz?: number
}

export type RobotStatus = {
  timestampUnixMs: number
  seq: string
  cpuPercent: number
  voltageV?: number
  rates: Record<string, RobotRateSample>
}
