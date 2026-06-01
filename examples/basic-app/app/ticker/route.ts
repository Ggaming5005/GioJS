import { GioEventStream } from '../../../packages/giojs-core/src/sse.ts';
import type { GioRequest } from '../../../packages/giojs-core/src/context.ts';

export function GET(_req: GioRequest): GioEventStream {
  return new GioEventStream((stream) => {
    const interval = setInterval(() => {
      stream.send({ time: Date.now() });
    }, 1000);
    return () => clearInterval(interval);
  });
}
