import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/model/meta')({
  server: {
    handlers: {
      GET: async () => {
        const { getRobotModelMeta } = await import('../server/robotModelCache')
        const { meta, filename } = await getRobotModelMeta()

        return Response.json(
          {
            meta,
            filename,
            url: `/api/model/${filename}`,
          },
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

