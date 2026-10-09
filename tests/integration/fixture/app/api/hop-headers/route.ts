import type { GioRequest } from '../../../../../../packages/giojs-core/src/context.ts';

// A handler that sets connection-specific headers itself, buffered or as an
// event stream (?stream=1). The server owns keep-alive: neither may reach
// the client, and the server's own Keep-Alive hint must win.
export function GET(req: GioRequest): Response {
  const headers = new Headers({
    connection: 'keep-alive',
    'keep-alive': 'timeout=99',
    'x-app': 'kept',
  });
  if (req.query['stream'] === '1') {
    headers.set('content-type', 'text/event-stream');
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: hop\n\n'));
        controller.close();
      },
    });
    return new Response(body, { headers });
  }
  headers.set('content-type', 'text/plain');
  return new Response('hop', { headers });
}
