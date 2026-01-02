import type { Pose3D } from './robotState'

export type OccupancyMap = {
  timestampUnixMs: number
  seq: string
  frameId: string
  resolutionMPerPx: number
  width: number
  height: number
  origin: Pose3D
  /** Base64-encoded grayscale PNG (0=occupied, 255=free, 127=unknown). */
  pngBase64: string
}

