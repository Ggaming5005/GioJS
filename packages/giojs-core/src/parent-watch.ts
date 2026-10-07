/**
 * giojs-core/src/parent-watch.ts
 *
 * Orphan protection for processes whose parent can die without warning (a
 * SIGKILLed or OOM-killed server, a crash, a container runtime that kills
 * only PID 1). Signals never reach the child then, so it watches its parent
 * instead:
 *
 * - stdin: the parent spawns the child with a piped stdin it holds open and
 *   never writes. However the parent dies, the OS closes its end of the pipe
 *   and the child reads EOF - immediately, on every platform.
 * - ppid: a fallback poll for launch modes where stdin is not a pipe. On
 *   Unix an orphan is reparented (to init or a subreaper), so a changed
 *   `process.ppid` means the parent is gone.
 *
 * Opt-in via GIO_EXIT_ON_STDIN_EOF=1 (the Rust server sets it on the worker
 * it spawns): a worker started any other way - tests, `gio export`, a manual
 * run - must not exit just because its stdin is closed or empty.
 */
import fs from 'node:fs';

/** Env flag that turns the watch on. */
export const EXIT_ON_STDIN_EOF_ENV = 'GIO_EXIT_ON_STDIN_EOF';

/** How often the ppid fallback checks for reparenting. */
export const PARENT_POLL_INTERVAL_MS = 2_000;

export function parentWatchEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[EXIT_ON_STDIN_EOF_ENV] === '1';
}

/** The stdin surface the watch needs (testable without a real fd 0). */
export interface WatchedStdin {
  on(event: 'end' | 'close' | 'error', listener: () => void): unknown;
  resume(): unknown;
}

export interface ParentWatchOptions {
  /** Called once, with why the parent is considered gone. */
  onParentGone: (reason: 'stdin-closed' | 'reparented') => void;
  /** Defaults to process.stdin when fd 0 is a pipe; null skips the stdin watch. */
  stdin?: WatchedStdin | null;
  /** Defaults to process.ppid as read now. */
  initialPpid?: number;
  getPpid?: () => number;
  pollIntervalMs?: number;
}

/**
 * True when fd 0 is a pipe or socket. Anything else - /dev/null, a file, a
 * terminal - either reads EOF at once or never, and says nothing about the
 * parent.
 */
export function stdinIsPipe(): boolean {
  try {
    const stat = fs.fstatSync(0);
    return stat.isFIFO() || stat.isSocket();
  } catch {
    return false;
  }
}

/** Start watching; returns a function that stops the watch. */
export function watchParent(options: ParentWatchOptions): () => void {
  let fired = false;
  const fire = (reason: 'stdin-closed' | 'reparented'): void => {
    if (fired) return;
    fired = true;
    stop();
    options.onParentGone(reason);
  };

  const stdin = options.stdin === undefined ? (stdinIsPipe() ? process.stdin : null) : options.stdin;
  if (stdin !== null) {
    stdin.on('end', () => fire('stdin-closed'));
    stdin.on('close', () => fire('stdin-closed'));
    // A read error on the pipe means the same thing: the other end is gone.
    stdin.on('error', () => fire('stdin-closed'));
    // Flowing mode with no 'data' listener: anything written is discarded,
    // and 'end' fires at EOF.
    stdin.resume();
  }

  const getPpid = options.getPpid ?? ((): number => process.ppid);
  const initialPpid = options.initialPpid ?? getPpid();
  const timer = setInterval(() => {
    if (getPpid() !== initialPpid) fire('reparented');
  }, options.pollIntervalMs ?? PARENT_POLL_INTERVAL_MS);
  // The poll alone must never keep a process alive.
  timer.unref();

  function stop(): void {
    clearInterval(timer);
  }
  return stop;
}
