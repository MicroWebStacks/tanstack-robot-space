# Reference

## API Endpoints

| Endpoint | Method | Format | Summary |
|---|---:|---|---|
| `/api/status` | GET | JSON | Returns a status snapshot (`status`) via server-side gRPC `GetStatus`. |
| `/api/status/stream` | GET | SSE | Streams status updates via server-side gRPC `StreamStatus` (`event: status`, `event: clear`). |
| `/api/state` | GET | JSON | Returns latest robot pose + wheel joint angles (`state`) from `StreamRobotState`. |
| `/api/state/stream` | GET | SSE | Streams robot state updates (`event: state`, `event: clear`). |
| `/api/lidar` | GET | JSON | Returns latest lidar scan (`scan`) from `StreamLidar`. |
| `/api/lidar/stream` | GET | SSE | Streams lidar scans (`event: scan`, `event: clear`). |
| `/api/map` | GET | JSON | Returns latest occupancy map (`map`) from `StreamMap`. |
| `/api/map/stream` | GET | SSE | Streams occupancy map updates (`event: map`, `event: clear`). |
| `/api/floor-topology` | GET | JSON | Returns latest floor topology (`topology`) from `StreamFloorTopology`. |
| `/api/floor-topology/stream` | GET | SSE | Streams floor topology updates (`event: topology`, `event: clear`). |
| `/api/model/meta` | GET | JSON | Returns local model metadata + resolved URL (`url`) for the GLB. |
| `/api/model/:file` | GET | Binary | Serves the GLB (`model/gltf-binary`), supports HTTP range requests. |

Notes:
- SSE streams send `retry: <ms>` and periodic `: ping` comments to keep connections alive.
- On staleness or disconnect, streams emit `event: clear`; the UI reverts to “no data”.

## Environment Variables

| Variable | Default | Used In | Purpose |
|---|---|---|---|
| `UI_GATEWAY_GRPC_ADDR` | `127.0.0.1:50051` | `src/server/*` hubs | gRPC UiBridge address. |
| `UI_GATEWAY_GRPC_RECONNECT_MS` | `2000` | `src/server/lidarHub.ts`, `src/server/robotStateHub.ts`, `src/server/mapHub.ts` | Base reconnect delay (early attempts). |
| `UI_GATEWAY_GRPC_DEADLINE_MS` | `2000` | `src/server/uiStatusBridge.ts` | Deadline for `GetStatus` snapshot call. |
| `BRIDGE_STALE_MS` | `7000` | `src/server/lidarHub.ts`, `src/server/floorTopologyHub.ts` | Stale timeout for streams (server clears to null). |
| `BRIDGE_STALE_MAP_MS` | `BRIDGE_STALE_MS` | `src/server/mapHub.ts` | Stale timeout for map stream (server clears to null). |
| `BRIDGE_STALE_TOPOLOGY_MS` | `BRIDGE_STALE_MS` | `src/server/floorTopologyHub.ts` | Stale timeout for floor topology stream (server clears to null). |
| `UI_GATEWAY_SSE_RETRY_MS` | `UI_GATEWAY_GRPC_RECONNECT_MS` | `src/routes/api.*.stream.ts` | SSE reconnect hint (`retry:` line) sent to browsers. |
| `MODEL_META` | (required) | `src/server/robotModelCache.ts` | Absolute path to `*.meta.json` for local model loading. |
| `DEBUG_STATUS` | (off) | `src/server/uiStatusBridge.ts` | Enables status stream logs. |
| `DEBUG_POSE` | (off) | `src/server/robotStateHub.ts` | Enables robot state stream logs. |
| `DEBUG_LIDAR` | (off) | `src/server/lidarHub.ts` | Enables lidar stream logs. |
| `DEBUG_MAP` | (off) | `src/server/mapHub.ts` | Enables map stream logs. |
| `DEBUG_TOPOLOGY` | (off) | `src/server/floorTopologyHub.ts`, `src/routes/api.floor-topology*.ts` | Enables floor topology hub + SSE route logs. |
| `DEBUG_MODEL` | (off) | `src/server/robotModelCache.ts` | Enables model route logs. |
| `UI_WEB_CONFIG` / `UI_WEB_CONFIG_PATH` / `UI_CONFIG` / `UI_CONFIG_PATH` | `config/ui.yaml` | `src/server/uiStatusConfig.ts` | Path to UI YAML config (dashboard status fields + labels). |
| `VITE_THREE_AXES_DEBUG` | (off) | `src/components/ModelViewerCanvas.tsx` | Shows axes helpers in the 3D view. |
| `VITE_DEBUG_AXES` | (off) | `src/components/ModelViewerCanvas.tsx` | Back-compat alias for `VITE_THREE_AXES_DEBUG`. |
| `VITE_LIDAR_TS_OFFSET_MS` | `0` | `src/components/ModelViewerCanvas.tsx` | Timestamp offset used to align lidar timestamp with pose history. |

## Code “Tweak Points”

## UI Config (ui.yaml)

The dashboard field list and labels come from `config/ui.yaml` (or `UI_WEB_CONFIG` / `UI_CONFIG` env overrides).

Required shape:

```yaml
status:
  fields:
    - id: cpu
      label: CPU
      decimals: 0
```

Notes:
- `decimals` is optional; when omitted it defaults to `0` (deterministic formatting; no heuristics).

| Location | Setting | Purpose |
|---|---|---|
| `src/components/ModelViewerCanvas.tsx` | `CAMERA_DISTANCE`, `CAMERA_DIR` | Default camera position and viewing direction. |
| `src/components/ModelViewerCanvas.tsx` | Ground plane `planeGeometry args={[10,10]}` + material `color="#666"` | Base floor size and color. |
| `src/components/ModelViewerCanvas.tsx` | `gridHelper args={[10,10,'#94a3b8','#64748b']}` + `position={[0,0,0.001]}` | Grid appearance and z-offset (helps avoid z-fighting). |
| `src/components/ModelViewerCanvas.tsx` | `LASER_OFFSET`, `LASER_RPY` | Fixed transform from base to laser frame for lidar rendering. |
| `src/components/ModelViewerCanvas.tsx` | `LIDAR_*` constants | Lidar point size/colors/line break threshold/wall opacity. |
| `src/components/ModelViewerCanvas.tsx` | `MAP_Z_OFFSET` + shader uniforms (`uOpacity`, `uUnknownAlpha`, `uUnknownBand`, colors) | Map overlay height and occupancy-to-color/alpha mapping. |
| `src/routes/index.tsx` | Gauge sizing (`size`, `strokeWidth`) + background gradient | Dashboard visual tuning. |
