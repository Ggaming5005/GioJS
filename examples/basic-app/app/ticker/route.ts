import { GioEventStream, type GioRequest } from '@gio.js/core';

export function GET(_req: GioRequest): GioEventStream {
  return new GioEventStream((stream) => {
    const interval = setInterval(() => {
      stream.send({ time: Date.now() });
    }, 1000);
    return () => clearInterval(interval);
  });
}
