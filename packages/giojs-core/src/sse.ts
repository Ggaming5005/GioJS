/**
 * giojs-core/src/sse.ts
 *
 * GioEventStream — declare a Server-Sent Events route.
 * Rust detects the text/event-stream content-type in the initial IpcResponse
 * and switches to streaming mode, forwarding sse_chunk messages to the client.
 */

export interface SseStream {
  send(data: unknown, event?: string, id?: string): void;
  close(): void;
}

export type SseCleanupFn = () => void;

export class GioEventStream {
  constructor(
    public readonly handler: (stream: SseStream) => SseCleanupFn,
  ) {}
}
