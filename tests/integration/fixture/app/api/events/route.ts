export function GET(): Response {
  // A complete event-stream body still streams (Rust never buffers an event
  // stream), and the streamed head must emit every cookie as its own
  // Set-Cookie header like the buffered path does.
  const headers = new Headers({ 'content-type': 'text/event-stream' });
  headers.append('set-cookie', 'sse_a=1; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT');
  headers.append('set-cookie', 'sse_b=2; Path=/; HttpOnly');
  return new Response('data: hello\n\n', { status: 200, headers });
}
