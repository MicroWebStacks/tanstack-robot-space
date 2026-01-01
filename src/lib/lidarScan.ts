export type LidarScan = {
  timestampUnixMs: number
  seq: string
  frameId: string
  angleMin: number
  angleIncrement: number
  rangeMin: number
  rangeMax: number
  /** Range data in meters. Invalid readings are Inf or outside [rangeMin, rangeMax]. */
  ranges: number[]
}
