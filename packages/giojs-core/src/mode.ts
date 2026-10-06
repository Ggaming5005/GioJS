/**
 * giojs-core/src/mode.ts
 *
 * Runtime mode and error references. The Rust server decides the mode (dev
 * iff NODE_ENV=development) and sets NODE_ENV explicitly on the worker it
 * spawns; every Node-side check uses the same rule so the two halves can
 * never disagree - an unset or 'test' NODE_ENV is production, never dev.
 */
import { randomBytes } from 'node:crypto';

/** Dev mode iff NODE_ENV is exactly 'development' (mirrors the Rust rule). */
export function isDevMode(): boolean {
  return process.env.NODE_ENV === 'development';
}

/**
 * Short random reference for a server error. Production responses carry
 * only this; the real message and stack are logged next to it so an
 * operator can find the failure a user reports.
 */
export function createErrorDigest(): string {
  return randomBytes(6).toString('hex');
}

/** Message + stack of a thrown value, for server-side logs only. */
export function describeError(err: unknown): { error: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined ? { error: err.message, stack: err.stack } : { error: err.message };
  }
  return { error: String(err) };
}
