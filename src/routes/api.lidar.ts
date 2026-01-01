import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/lidar')({
  server: {
    handlers: {
      GET: async () => {
        const { getLidarScanSnapshot } = await import('../server/lidarHub')
        return Response.json(
          { scan: getLidarScanSnapshot() },
          {
            headers: {
              'Cache-Control': 'no-store',
            },
          },
        )
      },
    },
  },
})
