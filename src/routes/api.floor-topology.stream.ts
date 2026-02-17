import { createFileRoute } from '@tanstack/react-router'

import { DEFAULT_GRPC_RECONNECT_MS } from '../lib/robotStatus'

function sseEvent(event: string, data?: unknown) {
  let payload = `event: ${event}\n`

  if (data !== undefined) {
    const body = typeof data === 'string' ? data : JSON.stringify(data)
    for (const line of body.split('\n')) {
      payload += `data: ${line}\n`
    }
  }

  payload += '\n'
  return payload
}

export const Route = createFileRoute('/api/floor-topology/stream')({
  server: {
    handlers: {
      GET: async () => {
        const retryMs =
          Number(
            process.env.UI_GATEWAY_SSE_RETRY_MS ??
              process.env.UI_GATEWAY_GRPC_RECONNECT_MS,
          ) || DEFAULT_GRPC_RECONNECT_MS

        const debug =
          (process.env.DEBUG_TOPOLOGY ?? '').trim().toLowerCase() === '1' ||
          (process.env.DEBUG_TOPOLOGY ?? '').trim().toLowerCase() === 'true'

        const encoder = new TextEncoder()

        const { subscribeFloorTopology } = await import('../server/floorTopologyHub')

        let keepAliveTimer: NodeJS.Timeout | null = null
        let unsubscribe: (() => void) | null = null

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`retry: ${retryMs}\n\n`))

            if (debug) process.stdout.write('[topology] http sse open\n')

            unsubscribe = subscribeFloorTopology((topology) => {
              try {
                if (debug) {
                  const summary = topology
                    ? `seq=${topology.seq} polylines=${topology.polylines.length}`
                    : 'clear'
                  process.stdout.write(`[topology] http sse send ${summary}\n`)
                }
                controller.enqueue(
                  encoder.encode(
                    topology
                      ? sseEvent('topology', topology)
                      : sseEvent('clear'),
                  ),
                )
              } catch {
                // Connection likely closed; cancel() will run cleanup.
              }
            })

            keepAliveTimer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(': ping\n\n'))
              } catch {
                // Connection likely closed; cancel() will run cleanup.
              }
            }, 15_000)
          },

          cancel() {
            if (keepAliveTimer) {
              clearInterval(keepAliveTimer)
              keepAliveTimer = null
            }
            if (unsubscribe) {
              unsubscribe()
              unsubscribe = null
            }
            if (debug) process.stdout.write('[topology] http sse close\n')
          },
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        })
      },
    },
  },
})
