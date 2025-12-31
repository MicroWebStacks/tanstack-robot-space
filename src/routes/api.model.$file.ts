import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/model/$file')({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        try {
          const { serveRobotModelFile } = await import('../server/robotModelCache')
          return await serveRobotModelFile(params.file, request)
        } catch (err) {
          return new Response(
            err instanceof Error ? err.message : 'Model not configured',
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

