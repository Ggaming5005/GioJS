/**
 * giojs-core/src/sse.test.ts
 *
 * runEventStream: how the server (ipc.ts) and the testing kit treat what a
 * GioEventStream handler returns - a cleanup, nothing, a promise of either,
 * or something else - and when the cleanup runs.
 */
import { describe, it, expect, vi } from 'vitest';
import { GioEventStream, runEventStream, type SseRunHooks, type SseStream } from './sse.ts';

function sink(): SseStream & { sent: unknown[]; closed: number } {
  const state = {
    sent: [] as unknown[],
    closed: 0,
    send(data: unknown): void {
      state.sent.push(data);
    },
    close(): void {
      state.closed += 1;
    },
  };
  return state;
}

function hooks(): SseRunHooks & {
  onError: ReturnType<typeof vi.fn>;
  onCleanupError: ReturnType<typeof vi.fn>;
  onInvalidCleanup: ReturnType<typeof vi.fn>;
} {
  return { onError: vi.fn(), onCleanupError: vi.fn(), onInvalidCleanup: vi.fn() };
}

/** Let pending promise callbacks run. */
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('runEventStream', () => {
  it('runs a sync handler\'s cleanup once, when the client leaves', () => {
    const cleanup = vi.fn();
    const out = sink();
    const run = runEventStream(new GioEventStream(stream => {
      stream.send({ n: 1 });
      return cleanup;
    }), out, hooks());
    expect(out.sent).toEqual([{ n: 1 }]);
    expect(run.done).toBe(false);
    run.disconnect();
    run.disconnect();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(run.done).toBe(true);
  });

  it('awaits an async handler: the resolved function is the cleanup', async () => {
    const cleanup = vi.fn();
    const h = hooks();
    const run = runEventStream(new GioEventStream(async stream => {
      await tick();
      stream.send('ready');
      return cleanup;
    }), sink(), h);
    await tick();
    await tick();
    run.disconnect();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(h.onInvalidCleanup).not.toHaveBeenCalled();
    expect(h.onCleanupError).not.toHaveBeenCalled();
  });

  it('runs the cleanup of an async handler the client left before it resolved', async () => {
    const cleanup = vi.fn();
    let resolve!: () => void;
    const started = new Promise<void>(r => (resolve = r));
    const run = runEventStream(new GioEventStream(async () => {
      await started;
      return cleanup;
    }), sink(), hooks());
    run.disconnect();
    expect(cleanup).not.toHaveBeenCalled();
    expect(run.done).toBe(false);
    resolve();
    await tick();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(run.done).toBe(true);
  });

  it('accepts a handler that returns nothing, sync or async', async () => {
    const h = hooks();
    runEventStream(new GioEventStream(() => undefined), sink(), h).disconnect();
    const run = runEventStream(new GioEventStream(async () => undefined), sink(), h);
    await tick();
    run.disconnect();
    expect(h.onInvalidCleanup).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('reports a result that is not a function, and ignores it', async () => {
    const h = hooks();
    const handler = (async () => 42) as unknown as () => void;
    const run = runEventStream(new GioEventStream(handler), sink(), h);
    await tick();
    expect(h.onInvalidCleanup).toHaveBeenCalledWith(42);
    expect(() => run.disconnect()).not.toThrow();
  });

  it('reports a sync throw or an async rejection as a handler error', async () => {
    const h = hooks();
    const run = runEventStream(new GioEventStream(() => {
      throw new Error('sync');
    }), sink(), h);
    expect(run.done).toBe(true);
    runEventStream(new GioEventStream(async () => {
      throw new Error('async');
    }), sink(), h);
    await tick();
    expect(h.onError.mock.calls.map(([e]) => (e as Error).message)).toEqual(['sync', 'async']);
  });

  it('does not report a rejection that comes after the client left', async () => {
    const h = hooks();
    let reject!: (e: Error) => void;
    const run = runEventStream(new GioEventStream(() => new Promise<void>((_, r) => (reject = r))), sink(), h);
    run.disconnect();
    reject(new Error('aborted'));
    await tick();
    expect(h.onError).not.toHaveBeenCalled();
    expect(run.done).toBe(true);
  });

  it('forgets the cleanup of a stream the handler closed, sync or async', async () => {
    const cleanup = vi.fn();
    const out = sink();
    const sync = runEventStream(new GioEventStream(stream => {
      stream.close();
      return cleanup;
    }), out, hooks());
    expect(out.closed).toBe(1);
    expect(sync.done).toBe(true);
    sync.disconnect();
    const run = runEventStream(new GioEventStream(async stream => {
      await tick();
      stream.close();
      return cleanup;
    }), out, hooks());
    await tick();
    await tick();
    run.disconnect();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('reports a cleanup that throws instead of throwing', async () => {
    const h = hooks();
    const run = runEventStream(new GioEventStream(() => () => {
      throw new Error('cleanup');
    }), sink(), h);
    expect(() => run.disconnect()).not.toThrow();
    let resolve!: () => void;
    const late = runEventStream(new GioEventStream(async () => {
      await new Promise<void>(r => (resolve = r));
      return () => {
        throw new Error('late cleanup');
      };
    }), sink(), h);
    late.disconnect();
    resolve();
    await tick();
    expect(h.onCleanupError.mock.calls.map(([e]) => (e as Error).message)).toEqual(['cleanup', 'late cleanup']);
  });
});
