import { GioEventStream } from '../../../../../../packages/giojs-core/src/sse.ts';
import type { GioRequest } from '../../../../../../packages/giojs-core/src/context.ts';

// An async GioEventStream handler: it awaits before it starts, and its
// cleanup is what its promise resolves to. The server must run that cleanup
// when the client goes away. `?state=1` reports how many cleanups ran.
const counters = globalThis as { __fixtureAsyncSseCleanups?: number };

export function GET(req: GioRequest): GioEventStream | Response {
  if (req.query['state'] === '1') {
    return Response.json({ cleanups: counters.__fixtureAsyncSseCleanups ?? 0 });
  }
  return new GioEventStream(async (stream) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    stream.send({ ready: true });
    const timer = setInterval(() => stream.send({ tick: true }), 100);
    return () => {
      clearInterval(timer);
      counters.__fixtureAsyncSseCleanups = (counters.__fixtureAsyncSseCleanups ?? 0) + 1;
    };
  });
}
