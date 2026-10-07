import type { GioRequest } from '../../../../../../packages/giojs-core/src/context.ts';

// A route handler answering HTML: its caching is still the app's business,
// so the server adds no Cache-Control default to it - buffered, or streamed
// (?stream=1: the rest of the body arrives after a pause, so the worker
// sends it as a streaming route body instead of buffering it).
export function GET(req: GioRequest): Response {
  const headers = { 'content-type': 'text/html; charset=utf-8' };
  const head = '<!doctype html><title>report</title>';
  if (req.query['stream'] !== '1') {
    return new Response(`${head}<p>INTEGRATION_FIXTURE_HTML_ROUTE</p>`, { headers });
  }
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(head));
      timer = setTimeout(() => {
        controller.enqueue(encoder.encode('<p>INTEGRATION_FIXTURE_HTML_ROUTE_STREAMED</p>'));
        controller.close();
      }, 50);
    },
    cancel() {
      clearTimeout(timer);
    },
  });
  return new Response(body, { headers });
}
