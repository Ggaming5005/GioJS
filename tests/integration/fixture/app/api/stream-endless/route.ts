import type { GioRequest } from '../../../../../../packages/giojs-core/src/context.ts';

// An event stream that never ends on its own; the server must cancel it
// (ReadableStream cancel()) when the client goes away. `?state=1` reports
// how many streams were cancelled so far.
const counters = globalThis as { __fixtureStreamCancels?: number };

export function GET(req: GioRequest): Response {
  if (req.query['state'] === '1') {
    return Response.json({ cancelled: counters.__fixtureStreamCancels ?? 0 });
  }
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let n = 0;
      controller.enqueue(encoder.encode(`data: ${n}\n\n`));
      timer = setInterval(() => controller.enqueue(encoder.encode(`data: ${++n}\n\n`)), 100);
    },
    cancel() {
      clearInterval(timer);
      counters.__fixtureStreamCancels = (counters.__fixtureStreamCancels ?? 0) + 1;
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}
