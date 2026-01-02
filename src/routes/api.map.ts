import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/map')({
  server: {
    handlers: {
      GET: async () => {
        const { getOccupancyMapSnapshot } = await import('../server/mapHub')
        return Response.json(
          { map: getOccupancyMapSnapshot() },
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

