/**
 * giojs-core/src/logger.ts
 *
 * Minimal structured logger. Emits one JSON line per event to stderr so
 * stdout stays clean for CLI output. Level is filtered via GIO_LOG_LEVEL
 * (debug | info | warn | error, default info).
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

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
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
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
