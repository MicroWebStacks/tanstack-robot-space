import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/floor-topology')({
  server: {
    handlers: {
      GET: async () => {
        const { getFloorTopologySnapshot } = await import('../server/floorTopologyHub')
        const debug =
          (process.env.DEBUG_TOPOLOGY ?? '').trim().toLowerCase() === '1' ||
          (process.env.DEBUG_TOPOLOGY ?? '').trim().toLowerCase() === 'true'

        const snapshot = getFloorTopologySnapshot()
        if (debug) {
          const summary = snapshot
            ? `seq=${snapshot.seq} polylines=${snapshot.polylines.length}`
            : 'null'
          process.stdout.write(`[topology] http snapshot ${summary}\n`)
        }
        return Response.json(
          { topology: snapshot },
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
