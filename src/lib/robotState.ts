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
  poseOdom: Pose3D
  poseMap?: Pose3D
  wheelAnglesRad: Record<string, number>
}
