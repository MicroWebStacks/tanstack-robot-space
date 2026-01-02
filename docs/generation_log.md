# 2026-01-02
## Add occupancy map stream + viewer overlay
Added `/api/map` + `/api/map/stream` backed by server-side gRPC `StreamMap`, with staleness clearing and a Three.js overlay plane rendered from the PNG occupancy grid.

