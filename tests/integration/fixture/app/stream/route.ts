import { GioEventStream } from '../../../../../packages/giojs-core/src/sse.ts';

export function GET(): GioEventStream {
  return new GioEventStream((stream) => {
    stream.send({ tick: 1 });
    const interval = setInterval(() => stream.send({ tick: 2 }), 200);
    return () => clearInterval(interval);
  });
}
