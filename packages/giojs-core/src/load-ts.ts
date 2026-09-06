/**
 * giojs-core/src/load-ts.ts
 *
 * Single entry point for loading project TypeScript modules (pages, layouts,
 * route handlers, gio.config, middleware). Per-call tsImport spawns a fresh
 * scoped loader registration each time, and Node 20.20's module-hooks
 * backport hangs on the second registration (CI workers froze in route
 * discovery). Instead: register tsx's transform hooks at most once, then use
 * plain dynamic import() - under the tsx CLI (how Rust spawns the worker)
 * the hooks are already global and the extra registration is a no-op pass.
 */
import { register } from 'tsx/esm/api';
import { logger } from './logger.ts';

let hooksEnsured = false;

function ensureTransformHooks(): void {
  if (hooksEnsured) return;
  hooksEnsured = true;
  try {
    register();
  } catch (registerError) {
    // Environments with their own TS pipeline (vitest) may refuse a second
    // loader; their pipeline transforms our imports instead.
    logger.warn('tsx hook registration failed - relying on host transform', {
      error: registerError instanceof Error ? registerError.message : String(registerError),
    });
  }
}

export function loadTsModule<T>(fileUrl: string): Promise<T> {
  ensureTransformHooks();
  return import(fileUrl) as Promise<T>;
}
