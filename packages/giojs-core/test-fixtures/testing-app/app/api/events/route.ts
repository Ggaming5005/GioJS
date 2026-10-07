import { GioEventStream, type GioRequest } from '@gio.js/core';

// ?count=N events, then the handler closes the stream; ?open keeps it open
// until the client goes away (the cleanup records that it ran).
export function GET(req: GioRequest): GioEventStream {
  const count = Number(req.query['count'] ?? '2');
  return new GioEventStream(stream => {
    for (let i = 1; i <= count; i++) stream.send({ n: i }, 'tick', String(i));
    if (req.query['open'] === undefined) stream.close();
    return () => {
      (globalThis as Record<string, unknown>)['__testingKitSseCleanups'] =
        Number((globalThis as Record<string, unknown>)['__testingKitSseCleanups'] ?? 0) + 1;
    };
  });
}
