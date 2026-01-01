# TanStack Robot Space

Robot dashboard UI built with TanStack Start (Nitro) and a server-side gRPC client.

The gRPC server is a ROS node running within this project workspace https://github.com/Roblibs/rovi_ros_ws

Dashboard Gauges use svg for metrics status. Robot real time rendering (Rviz like) uses Threejs and three/fiber for threejs in react integration.

![screenshot](./docs/screenshot.png)

## Quickstart

Prereqs:
- Node `>= 22.12`
- `pnpm`
- `UiBridge` gRPC server listening on `0.0.0.0:50051` (client connects to `127.0.0.1:50051` by default)

Run:

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`.

## Architecture

The browser never connects to gRPC directly. Nitro (Node) subscribes to the gRPC stream and re-exposes it as:
- `GET /api/status` — JSON snapshot (or `null` if no fresh data)
- `GET /api/status/stream` — SSE stream (`event: status` / `event: clear`)

```mermaid
flowchart TD
  GRPC[gRPC UiBridge<br/>0.0.0.0:50051] -->|GetStatus stream| HUB[Nitro server<br/>src/server/robotStatusHub.ts]
  HUB -->|"GET /api/status (JSON)"| UI[React UI<br/>src/routes/index.tsx]
  HUB -->|"GET /api/status/stream (SSE)"| UI
```

```mermaid
sequenceDiagram
  participant UI as Browser UI
  participant API as Nitro API routes
  participant GRPC as UiBridge (gRPC)

  API->>GRPC: GetStatus({})
  GRPC-->>API: StatusUpdate (stream)

  UI->>API: GET /api/status
  API-->>UI: { status: RobotStatus | null }

  UI->>API: GET /api/status/stream
  API-->>UI: event: status (RobotStatus JSON)
  API-->>UI: event: clear (no data)
```

## Staleness policy (no “made up” values)

- Until the first `StatusUpdate` arrives, the UI shows `--`.
- Values are never carried forward if the stream stops updating: after a staleness timeout, the server emits `clear` and the UI switches back to `--`.
- If a field is missing in a snapshot (ex: `voltage_v` not present), the UI shows `--` for that field.

## Configuration

Environment variables (optional):
- `UI_GATEWAY_GRPC_ADDR` (default: `0.0.0.0:50051`)
- `UI_GATEWAY_GRPC_RECONNECT_MS` (default: `2000`)
- `UI_GATEWAY_STATUS_STALE_MS` (default: `7000`)
- `UI_GATEWAY_SSE_RETRY_MS` (default: `2000`)

Debug logging (optional):
- `DEBUG_MODEL` — enables model/meta/file route info logs
- `DEBUG_STATUS` — enables status stream info logs
- `DEBUG_POSE` — enables pose/state stream info logs

Viewer debug (optional):
- `VITE_THREE_AXES_DEBUG` — shows world + robot axes helpers in the 3D view

Notes:
- Errors are always logged to stderr; `DEBUG_*` flags only control info/verbose logs.

Proto:
- `proto/ui_gateway.proto` (copied into this repo for now)
