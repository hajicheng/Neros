import type { NextRequest } from 'next/server'

import type { StreamEvent } from '@/shared/types'

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
const encoder = new TextEncoder()

export function broadcastEvent(event: StreamEvent): void {
  for (const controller of clients) sendEvent(controller, event)
}

export function streamResponse(req: NextRequest): Response {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    if (streamController) clients.delete(streamController)
    streamController = null
  }

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller
      clients.add(controller)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'connected' })}\n\n`))
      heartbeat = setInterval(() => {
        sendEvent(controller, { type: 'heartbeat', conversationId: '', timestamp: Date.now() })
      }, 25000)
      req.signal.addEventListener('abort', () => {
        cleanup()
        controller.close()
      })
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}

function sendEvent(controller: ReadableStreamDefaultController<Uint8Array>, event: StreamEvent): void {
  try {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
  } catch {
    clients.delete(controller)
  }
}
