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

export const Route = createFileRoute('/api/state/stream')({
  server: {
    handlers: {
      GET: async () => {
        const retryMs =
          Number(
            process.env.UI_GATEWAY_SSE_RETRY_MS ??
              process.env.UI_GATEWAY_GRPC_RECONNECT_MS,
          ) || DEFAULT_GRPC_RECONNECT_MS

        const encoder = new TextEncoder()

        const { subscribeRobotState } = await import('../server/robotStateHub')

        let keepAliveTimer: NodeJS.Timeout | null = null
        let unsubscribe: (() => void) | null = null

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`retry: ${retryMs}\n\n`))

            unsubscribe = subscribeRobotState((state) => {
              try {
                controller.enqueue(
                  encoder.encode(
                    state ? sseEvent('state', state) : sseEvent('clear'),
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
            if (keepAliveTimer) clearInterval(keepAliveTimer)
            keepAliveTimer = null
            unsubscribe?.()
            unsubscribe = null
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
