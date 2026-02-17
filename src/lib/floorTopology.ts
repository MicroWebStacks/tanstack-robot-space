export type Point3 = {
  x: number
  y: number
  z: number
}

export type FloorPolyline = {
  ns: string
  id: number
  frameId: string
  points: Point3[]
  closed: boolean
}

export type FloorTopology = {
  timestampUnixMs: number
  seq: string
  polylines: FloorPolyline[]
}

