import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/status')({
  server: {
    handlers: {
      GET: async () => {
        const { getRobotStatusSnapshot } = await import('../server/robotStatusHub')
        return Response.json(
          { status: getRobotStatusSnapshot() },
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

