import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/state')({
  server: {
    handlers: {
      GET: async () => {
        const { getRobotStateSnapshot } = await import('../server/robotStateHub')
        return Response.json(
          { state: getRobotStateSnapshot() },
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
