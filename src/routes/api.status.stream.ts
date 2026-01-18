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

export const Route = createFileRoute('/api/status/stream')({
  server: {
    handlers: {
      GET: async () => {
        let normalizeUiStatusUpdate: typeof import('../server/uiStatusBridge').normalizeUiStatusUpdate
        let openUiStatusStream: typeof import('../server/uiStatusBridge').openUiStatusStream

        try {
          ;({ normalizeUiStatusUpdate, openUiStatusStream } = await import(
            '../server/uiStatusBridge'
          ))
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Failed to initialize status stream'
          return new Response(message, {
            status: 503,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          })
        }

        const retryMs =
          Number(
            process.env.UI_GATEWAY_SSE_RETRY_MS ??
              process.env.UI_GATEWAY_GRPC_RECONNECT_MS,
          ) || DEFAULT_GRPC_RECONNECT_MS

        const encoder = new TextEncoder()

        let call: ReturnType<typeof openUiStatusStream>['call']
        let close: ReturnType<typeof openUiStatusStream>['close']
        let selectedIds: ReturnType<typeof openUiStatusStream>['selectedIds']

        try {
          ;({ call, close, selectedIds } = openUiStatusStream())
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Failed to open status stream'
          return new Response(message, {
            status: 503,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          })
        }

        let keepAliveTimer: NodeJS.Timeout | null = null
        let cancelled = false

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`retry: ${retryMs}\n\n`))

            call.on('data', (raw) => {
              try {
                const update = normalizeUiStatusUpdate(raw, selectedIds)
                controller.enqueue(
                  encoder.encode(
                    sseEvent('status', update),
                  ),
                )
              } catch {
                // Connection likely closed; cancel() will run cleanup.
              }
            })

            const onDisconnect = () => {
              if (cancelled) return
              if (keepAliveTimer) clearInterval(keepAliveTimer)
              keepAliveTimer = null
              close()
              try {
                controller.enqueue(encoder.encode(sseEvent('clear')))
              } catch {
                // ignore
              }
              try {
                controller.close()
              } catch {
                // ignore
              }
            }

            call.on('error', onDisconnect)
            call.on('end', onDisconnect)

            keepAliveTimer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(': ping\n\n'))
              } catch {
                // Connection likely closed; cancel() will run cleanup.
              }
            }, 15_000)
          },

          cancel() {
            cancelled = true
            if (keepAliveTimer) clearInterval(keepAliveTimer)
            keepAliveTimer = null
            close()
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
