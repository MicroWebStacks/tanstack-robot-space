import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/status')({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { fetchUiStatusSnapshot } = await import('../server/uiStatusBridge')
          const status = await fetchUiStatusSnapshot()
          return Response.json(
            { status },
            {
              headers: {
                'Cache-Control': 'no-store',
              },
            },
          )
        } catch (err) {
          return Response.json(
            {
              status: null,
              error:
                err instanceof Error
                  ? err.message
                  : 'Failed to fetch status snapshot',
            },
            {
              status: 503,
              headers: {
                'Cache-Control': 'no-store',
              },
            },
          )
        }
      },
    },
  },
})
