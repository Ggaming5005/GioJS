/**
 * giojs-core/src/sse.ts
 *
 * GioEventStream - declare a Server-Sent Events route.
 * Rust detects the text/event-stream content-type in the initial IpcResponse
 * and switches to streaming mode, forwarding sse_chunk messages to the client.
 */

export interface SseStream {
  send(data: unknown, event?: string, id?: string): void;
  close(): void;
}

export type SseCleanupFn = () => void;

export class GioEventStream {
  /**
   * Brand for cross-instance detection: route files are loaded in their own
   * tsx module namespace, so their GioEventStream class is a different
   * object and `instanceof` fails across the boundary. Check the brand.
   */
  public readonly __gioSse = true;

  constructor(
    public readonly handler: (stream: SseStream) => SseCleanupFn,
  ) {}
}

/** Cross-module-instance GioEventStream detection (see `__gioSse`). */
export function isGioEventStream(value: unknown): value is GioEventStream {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __gioSse?: unknown }).__gioSse === true &&
    typeof (value as { handler?: unknown }).handler === 'function'
  );
}
