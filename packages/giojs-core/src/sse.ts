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

/**
 * What a GioEventStream runs once the headers are sent. It may return a
 * cleanup function (run when the client disconnects), nothing, or a promise
 * of either - an async handler's cleanup is what its promise resolves to.
 */
export type SseHandler = (
  stream: SseStream,
) => SseCleanupFn | void | Promise<SseCleanupFn | void>;

export class GioEventStream {
  /**
   * Brand for cross-instance detection: route files are loaded in their own
   * tsx module namespace, so their GioEventStream class is a different
   * object and `instanceof` fails across the boundary. Check the brand.
   */
  public readonly __gioSse = true;

  constructor(public readonly handler: SseHandler) {}
}

/** A running GioEventStream handler (see runEventStream). */
export interface SseRun {
  /**
   * The client went away: run the cleanup - now, or once an async handler
   * resolves to it. At most once.
   */
  disconnect(): void;
  /** The handler closed the stream, failed, or the client left: nothing is pending. */
  readonly done: boolean;
}

/** How runEventStream reports what goes wrong in user code. */
export interface SseRunHooks {
  /**
   * The handler threw or its promise rejected: the stream must end (its
   * headers are already sent). Not called once the client has left.
   */
  onError(error: unknown): void;
  /** The cleanup function threw. */
  onCleanupError(error: unknown): void;
  /** The handler returned (or resolved to) something that is not a function - ignored. */
  onInvalidCleanup(value: unknown): void;
}

/**
 * Run `source`'s handler against `sink` - for the IPC server (ipc.ts) and
 * the testing kit alike, so both treat the handler's result the same way:
 * a function is the cleanup, `undefined`/`null` means none, a promise is
 * awaited first (a client that leaves before it resolves still gets the
 * cleanup run), and anything else is reported and ignored. A stream the
 * handler closes itself is done with: its cleanup never runs. Never throws.
 */
export function runEventStream(source: GioEventStream, sink: SseStream, hooks: SseRunHooks): SseRun {
  // running: the handler has not settled; open: its cleanup waits for the
  // client to leave; left: the client left while it was running; done.
  let state: 'running' | 'open' | 'left' | 'done' = 'running';
  let cleanup: SseCleanupFn | undefined;
  const runCleanup = (fn: SseCleanupFn | undefined): void => {
    try {
      fn?.();
    } catch (error) {
      hooks.onCleanupError(error);
    }
  };
  const settle = (returned: unknown): void => {
    let fn: SseCleanupFn | undefined;
    if (typeof returned === 'function') fn = returned as SseCleanupFn;
    else if (returned !== undefined && returned !== null) hooks.onInvalidCleanup(returned);
    if (state === 'running') {
      state = 'open';
      cleanup = fn;
    } else if (state === 'left') {
      state = 'done';
      runCleanup(fn);
    }
  };
  const fail = (error: unknown): void => {
    const report = state === 'running';
    state = 'done';
    cleanup = undefined;
    if (report) hooks.onError(error);
  };
  const run: SseRun = {
    disconnect(): void {
      if (state === 'running') {
        state = 'left';
      } else if (state === 'open') {
        state = 'done';
        const fn = cleanup;
        cleanup = undefined;
        runCleanup(fn);
      }
    },
    get done(): boolean {
      return state === 'done';
    },
  };
  const stream: SseStream = {
    send: (data, event, id) => sink.send(data, event, id),
    close(): void {
      // Closed by the handler: its cleanup is forgotten, as documented.
      state = 'done';
      cleanup = undefined;
      sink.close();
    },
  };
  let returned: unknown;
  try {
    returned = source.handler(stream);
  } catch (error) {
    fail(error);
    return run;
  }
  if (isPromiseLike(returned)) {
    returned.then(settle, fail);
  } else {
    settle(returned);
  }
  return run;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
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
