import type { GioRequest } from '../../../../../../packages/giojs-core/src/context.ts';

// A route handler answering HTML: its caching is still the app's business,
// so the server adds no Cache-Control default to it - buffered, or streamed
// (?stream=1: the rest of the body arrives after a pause, so the worker
// sends it as a streaming route body instead of buffering it).
// ?stream=tokens: a headless HTML fragment stream (htmx, LLM tokens) whose
// second token follows a long pause - the first must not wait for it.
export function GET(req: GioRequest): Response {
  const headers = { 'content-type': 'text/html; charset=utf-8' };
  const head = '<!doctype html><title>report</title>';
  if (req.query['stream'] === 'tokens') {
    return new Response(tokenStream(), { headers });
  }
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

function tokenStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('<p>INTEGRATION_FIXTURE_TOKEN_0</p>'));
      timer = setTimeout(() => {
        controller.enqueue(encoder.encode('<p>INTEGRATION_FIXTURE_TOKEN_1</p>'));
        controller.close();
      }, 1500);
    },
    cancel() {
      clearTimeout(timer);
    },
  });
}
