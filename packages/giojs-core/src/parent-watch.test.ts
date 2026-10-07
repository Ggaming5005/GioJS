/**
 * giojs-core/src/parent-watch.test.ts
 *
 * Orphan protection: a process watching its parent exits when the parent's
 * end of its stdin pipe closes (however the parent died), with a ppid poll
 * as the fallback, and only when GIO_EXIT_ON_STDIN_EOF=1 asks for it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parentWatchEnabled, watchParent, type WatchedStdin } from './parent-watch.ts';

const watchModule = fileURLToPath(new URL('./parent-watch.ts', import.meta.url));

/** A child process that runs the real watch on its real stdin. */
function spawnWatchingChild(env: Record<string, string>): ReturnType<typeof spawn> {
  const script = `
    import { parentWatchEnabled, watchParent } from ${JSON.stringify(watchModule)};
    if (parentWatchEnabled(process.env)) {
      watchParent({ onParentGone(reason) { console.log('gone:' + reason); process.exit(0); } });
    }
    console.log('watching');
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  });
}

function collect(child: ReturnType<typeof spawn>): { text: () => string } {
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  return { text: () => out };
}

async function until(what: string, check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('watchParent in a real child process', () => {
  it('exits promptly when the parent closes its end of the stdin pipe', async () => {
    const child = spawnWatchingChild({ GIO_EXIT_ON_STDIN_EOF: '1' });
    const output = collect(child);
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    await until('child ready', () => output.text().includes('watching'));
    const closedAt = Date.now();
    // What the OS does to a pipe whose writer died - SIGKILL included.
    child.stdin?.end();
    expect(await exited).toBe(0);
    expect(Date.now() - closedAt).toBeLessThan(2_000);
    expect(output.text()).toContain('gone:stdin-closed');
  }, 20_000);

  it('ignores stdin entirely unless GIO_EXIT_ON_STDIN_EOF=1', async () => {
    const child = spawnWatchingChild({ GIO_EXIT_ON_STDIN_EOF: '' });
    const output = collect(child);
    await until('child ready', () => output.text().includes('watching'));
    child.stdin?.end();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(child.exitCode).toBeNull();
    child.kill();
  }, 20_000);
});

class FakeStdin extends EventEmitter implements WatchedStdin {
  resumed = false;
  resume(): this {
    this.resumed = true;
    return this;
  }
}

describe('watchParent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once on end, close or error of a piped stdin', () => {
    for (const event of ['end', 'close', 'error'] as const) {
      const stdin = new FakeStdin();
      const reasons: string[] = [];
      const stop = watchParent({ stdin, initialPpid: 1, getPpid: () => 1, onParentGone: r => reasons.push(r) });
      expect(stdin.resumed).toBe(true);
      stdin.emit(event);
      stdin.emit('close');
      expect(reasons).toEqual(['stdin-closed']);
      stop();
    }
  });

  it('falls back to polling for reparenting when stdin is not a pipe', () => {
    vi.useFakeTimers();
    let ppid = 4242;
    const reasons: string[] = [];
    const stop = watchParent({
      stdin: null,
      getPpid: () => ppid,
      pollIntervalMs: 2_000,
      onParentGone: r => reasons.push(r),
    });
    vi.advanceTimersByTime(4_000);
    expect(reasons).toEqual([]);
    ppid = 1; // reparented to init: the parent is gone
    vi.advanceTimersByTime(2_000);
    expect(reasons).toEqual(['reparented']);
    vi.advanceTimersByTime(10_000);
    expect(reasons).toEqual(['reparented']);
    stop();
  });

  it('stop() ends the poll', () => {
    vi.useFakeTimers();
    let ppid = 10;
    const reasons: string[] = [];
    const stop = watchParent({ stdin: null, getPpid: () => ppid, onParentGone: r => reasons.push(r) });
    stop();
    ppid = 1;
    vi.advanceTimersByTime(10_000);
    expect(reasons).toEqual([]);
  });

  it('is enabled only by GIO_EXIT_ON_STDIN_EOF=1', () => {
    expect(parentWatchEnabled({ GIO_EXIT_ON_STDIN_EOF: '1' })).toBe(true);
    expect(parentWatchEnabled({ GIO_EXIT_ON_STDIN_EOF: '0' })).toBe(false);
    expect(parentWatchEnabled({})).toBe(false);
  });
});
