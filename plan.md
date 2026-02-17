# StreamFloorTopology (Floor Topology) — Implementation Plan

## Goal
Add support for the new gRPC stream `StreamFloorTopology(FloorTopologyRequest) -> stream FloorTopologyUpdate` end-to-end:
- Nitro server subscribes to gRPC and exposes `GET /api/floor-topology` + `GET /api/floor-topology/stream` (SSE).
- Browser consumes JSON/SSE only (no direct gRPC) and renders the topology in the 3D viewer in a style similar to the current LiDAR overlay.

## Confirmed requirements / assumptions (from your answers)
- **Multiplicity:** proto now sends a snapshot list: `FloorTopologyUpdate.polylines[]` (each is a `FloorPolyline`).
- **Frames:** topology polylines are **robot-relative**; `FloorPolyline.frame_id` is the coordinate frame the points are expressed in (typically `base_footprint` for `/floor/topology` from `rovi_floor`).
- **Default render mode:** UI **parents/attaches polylines to the robot** (no TF lookups needed).
- **Geometry:** honor `points[].z` (3D), and **line-only** visualization.
- **Performance:** point count “does not matter” (so we can keep implementation simple; still avoid obvious per-frame waste).
- **Contract enforcement:** hard fail if `FloorPolyline.frame_id` is not `base_footprint` (to avoid silently wrong transforms).

## Proposed API + UI contract (mirrors existing LiDAR/Map patterns)
- **Snapshot:** `GET /api/floor-topology` → `{ topology: FloorTopology | null }`
- **SSE:** `GET /api/floor-topology/stream`
  - `event: topology` with JSON payload (`FloorTopology`)
  - `event: clear` when stale/disconnected (client resets to `null` / shows nothing)
  - keep-alive `: ping` frames every ~15s

*(If you prefer the SSE event name to be `polyline` instead of `topology`, I’ll match that—just confirm.)*

## Data types to add (client-safe, JSON)
Add `src/lib/floorTopology.ts`:
- `FloorPolyline = { ns: string; id: number; frameId: string; points: {x:number;y:number;z:number}[]; closed: boolean }`
- `FloorTopology = { timestampUnixMs: number; seq: string; polylines: FloorPolyline[] }`

## Server-side steps (Nitro / Node, gRPC → in-memory → REST/SSE)
1. **Hub:** create `src/server/floorTopologyHub.ts` modeled after `src/server/lidarHub.ts`:
   - load proto via `@grpc/proto-loader`, connect to `UiBridge` at `UI_GATEWAY_GRPC_ADDR`
   - start stream `client.StreamFloorTopology({})`
   - normalize/validate incoming `FloorTopologyUpdate` into `FloorTopology`
   - store `latestTopology` and notify subscribers
   - staleness timer using `BRIDGE_STALE_MS` (or a dedicated `BRIDGE_STALE_TOPOLOGY_MS` if you want)
   - reconnect loop using `UI_GATEWAY_GRPC_RECONNECT_MS`
   - optional logging behind `DEBUG_TOPOLOGY` (name TBD)
2. **Routes:**
   - `src/routes/api.floor-topology.ts` → returns snapshot JSON (no-store)
   - `src/routes/api.floor-topology.stream.ts` → SSE stream (retry hint via `UI_GATEWAY_SSE_RETRY_MS`)

## Client-side steps (React hook/provider, SSE consumer)
1. Add `src/lib/floorTopologyClient.tsx` modeled after `src/lib/lidarClient.tsx`:
   - fetch initial snapshot
   - open `EventSource('/api/floor-topology/stream')`
   - handle `topology` (JSON parse) and `clear`/`error`
   - apply an extra client-side stale timeout (like LiDAR) for belt-and-suspenders
2. Wire provider into the model route tree:
   - wrap `ModelViewerCanvas` in `FloorTopologyProvider` inside `src/components/ModelViewerHost.tsx`

## 3D viewer steps (rendering “similar to LiDAR”)
1. Extend `src/components/ModelViewerCanvas.tsx`:
   - `const { topology } = useFloorTopology()`
   - Convert `topology.polylines[]` into arrays for `<Line points={...} />`.
2. **Default transform strategy (robot-attached):**
   - Render polylines inside the same robot `<group position={modelPos} rotation={modelRot}>` so they move with the robot pose.
   - No pose-history sync needed in this mode.
   - Hard fail if `polyline.frameId` is not `base_footprint` (since we’re not doing TF lookups between robot frames).
3. **Primitives:**
   - Use `<Line points={...} />` only (no point cloud rendering).
4. **Closed loops:**
   - If `closed`, add a final segment from last → first (or pass a points array with repeated first point).
   - Optional: visually distinguish closed vs open (only if you want; otherwise same style).

## Minimal UI affordances (small “support in UI”)
Pick one (based on preference):
- A) Always-on overlay in the 3D viewer, or
- B) Add a small toggle button in the viewer overlay (near Fullscreen) to show/hide “Topology”.

## Validation checklist (how I’d verify)
- With bridge running: topology appears and updates in `/model`.
- On disconnect/staleness: server emits `clear`, UI clears overlay (no stale carry-forward).
- No browser-side gRPC; only `fetch` + `EventSource`.
- Rendering matches coordinate expectations (frame issues obvious via quick log-on-change like LiDAR’s frame log).

## Files I expect to touch
- `src/server/floorTopologyHub.ts` (new)
- `src/routes/api.floor-topology.ts` (new)
- `src/routes/api.floor-topology.stream.ts` (new)
- `src/lib/floorTopology.ts` (new)
- `src/lib/floorTopologyClient.tsx` (new)
- `src/components/ModelViewerHost.tsx` (wrap provider)
- `src/components/ModelViewerCanvas.tsx` (render overlay)

## Notes / risks
- If `FloorPolyline.frame_id` is not `base_footprint` (or whatever you consider the canonical robot overlay frame), we either need static extrinsics (URDF-like, similar to LiDAR) or true TF lookup support; initial plan assumes no TF lookups.
