import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/model/$file')({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { serveRobotModelFile } = await import('../server/robotModelCache')
        return await serveRobotModelFile(params.file, request)
      },
    },
  },
})

