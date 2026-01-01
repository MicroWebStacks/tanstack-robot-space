export const DEFAULT_GRPC_ADDR = '127.0.0.1:50051'
export const DEFAULT_GRPC_RECONNECT_MS = 2000
export const DEFAULT_BRIDGE_STALE_MS = 7000

export const VOLTAGE_MIN_V = 9
export const VOLTAGE_MAX_V = 13

export const DRIVER_TARGET_HZ = 10
export const ODOM_TARGET_HZ = 10
export const LIDAR_TARGET_HZ = 10
export const SLAM_TARGET_HZ = 50

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
