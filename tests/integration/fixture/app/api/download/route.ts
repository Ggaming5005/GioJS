import type { GioRequest } from '../../../../../../packages/giojs-core/src/context.ts';

// A large binary download produced piece by piece: 3 MiB of a deterministic
// byte pattern (mostly invalid UTF-8) in 64 KiB pieces, one per macrotask.
// The harness regenerates the pattern and compares digests.
//
// `?endless=1` never ends and counts the bytes it produced, which
// `?state=1` reports: a client that stops reading must stop the producer
// (backpressure), not let the server buffer without bound.
//
// `?slow=1` paces the same finite download at one piece per 30ms (~1.5s in
// all), so it is still in flight when the server is told to stop.
const TOTAL = 3 * 1024 * 1024;
const PIECE = 64 * 1024;
const counters = globalThis as { __fixtureEndlessBytes?: number };

function piece(offset: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const n = offset + i;
    bytes[i] = (n * 31 + (n >> 8)) & 0xff;
  }
  return bytes;
}

export function GET(req: GioRequest): Response {
  if (req.query['state'] === '1') {
    return Response.json({ produced: counters.__fixtureEndlessBytes ?? 0 });
  }
  const endless = req.query['endless'] === '1';
  const pieceDelayMs = req.query['slow'] === '1' ? 30 : 0;
  if (endless) counters.__fixtureEndlessBytes = 0;
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) =>
        pieceDelayMs > 0 ? setTimeout(resolve, pieceDelayMs) : setImmediate(resolve),
      );
      const length = endless ? PIECE : Math.min(PIECE, TOTAL - offset);
      controller.enqueue(piece(offset, length));
      offset += length;
      if (endless) counters.__fixtureEndlessBytes = offset;
      else if (offset >= TOTAL) controller.close();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'application/octet-stream', 'x-download-bytes': String(TOTAL) },
  });
}
