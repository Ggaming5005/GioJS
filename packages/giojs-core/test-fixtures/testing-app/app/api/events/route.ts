import { GioEventStream, type GioRequest, type SseStream } from '@gio.js/core';

// ?count=N events, then the handler closes the stream; ?open keeps it open
// until the client goes away (the cleanup records that it ran). ?async runs
// the same as an async handler: its cleanup is what its promise resolves to.
// ?throwCleanup makes the cleanup throw.
export function GET(req: GioRequest): GioEventStream {
  const count = Number(req.query['count'] ?? '2');
  const start = (stream: SseStream) => {
    for (let i = 1; i <= count; i++) stream.send({ n: i }, 'tick', String(i));
    if (req.query['open'] === undefined) stream.close();
    return () => {
      if (req.query['throwCleanup'] !== undefined) throw new Error('cleanup failed');
      (globalThis as Record<string, unknown>)['__testingKitSseCleanups'] =
        Number((globalThis as Record<string, unknown>)['__testingKitSseCleanups'] ?? 0) + 1;
    };
  };
  if (req.query['async'] === undefined) return new GioEventStream(start);
  return new GioEventStream(async stream => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return start(stream);
  });
}
