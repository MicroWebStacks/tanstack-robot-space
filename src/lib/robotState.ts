export type Pose3D = {
  frameId: string
  x: number
  y: number
  z: number
  qx: number
  qy: number
  qz: number
  qw: number
  /** Yaw about +Z (ROS convention), radians */
  yawZ: number
}

export type RobotState = {
  timestampUnixMs: number
  seq: string
  /** Authoritative pose chosen by the bridge (frame in Pose3D.frameId). */
  pose: Pose3D
  wheelAnglesRad: Record<string, number>
}
