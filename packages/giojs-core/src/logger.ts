/**
 * giojs-core/src/logger.ts
 *
 * Minimal structured logger. Emits one JSON line per event to stderr so
 * stdout stays clean for CLI output. Level is filtered via GIO_LOG_LEVEL
 * (debug | info | warn | error, default info).
 *
 * Lines emitted while handling a request carry its `requestId` (the
 * response's X-Request-Id, also on the Rust server's log lines), so an
 * operator can follow one request through both processes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Fields stamped on every line logged inside `withRequestLogContext`. */
export interface RequestLogContext {
  requestId: string;
}

// AsyncLocalStorage follows the request through awaits, timers and React's
// render scheduling, so concurrent requests on the one worker never see each
// other's id - and work outliving its request (an SSE handler's interval)
// keeps the id of the request that started it.
const requestContext = new AsyncLocalStorage<RequestLogContext>();

/**
 * Run `fn` with `context` attached to every log line it emits, directly or
 * from anything it schedules. Without a context (no request id - static
 * export, older servers) `fn` just runs.
 */
export function withRequestLogContext<T>(context: RequestLogContext | undefined, fn: () => T): T {
  return context === undefined ? fn() : requestContext.run(context, fn);
}

function activeLevel(): LogLevel {
  const raw = process.env['GIO_LOG_LEVEL'];
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) {
    return;
  }
  const context = requestContext.getStore();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(context !== undefined ? { requestId: context.requestId } : {}),
    ...fields,
  });
  process.stderr.write(line + '\n');
}

export const logger = {
  debug(message: string, fields?: Record<string, unknown>): void {
    emit('debug', message, fields);
  },
  info(message: string, fields?: Record<string, unknown>): void {
    emit('info', message, fields);
  },
  warn(message: string, fields?: Record<string, unknown>): void {
    emit('warn', message, fields);
  },
  error(message: string, fields?: Record<string, unknown>): void {
    emit('error', message, fields);
  },
};
