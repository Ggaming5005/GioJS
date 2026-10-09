// A web-standard event stream: a ReadableStream body, no GioEventStream.
// The first event is written immediately and the second only after a
// pause, so a client sees the first one while the stream is still open.
export function GET(): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: first\n\n'));
      timer = setTimeout(() => {
        controller.enqueue(encoder.encode('data: second\n\n'));
        controller.close();
      }, 400);
    },
    cancel() {
      clearTimeout(timer);
    },
  });
  const headers = new Headers({ 'content-type': 'text/event-stream' });
  headers.append('set-cookie', 'stream_a=1; Path=/');
  headers.append('set-cookie', 'stream_b=2; Path=/; HttpOnly');
  return new Response(body, { headers });
}
