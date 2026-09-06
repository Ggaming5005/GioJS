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
 * tsx itself is imported lazily so standalone bundles (which never call
 * loadTsModule) can mark it external and run without node_modules.
 */
import { logger } from './logger.ts';

let hooksReady: Promise<void> | null = null;

function ensureTransformHooks(): Promise<void> {
  if (hooksReady === null) {
    hooksReady = import('tsx/esm/api')
      .then(({ register }) => {
        register();
      })
      .catch((registerError: unknown) => {
        // Environments with their own TS pipeline (vitest) may refuse a second
        // loader; their pipeline transforms our imports instead.
        logger.warn('tsx hook registration failed - relying on host transform', {
          error: registerError instanceof Error ? registerError.message : String(registerError),
        });
      });
  }
  return hooksReady;
}

export async function loadTsModule<T>(fileUrl: string): Promise<T> {
  await ensureTransformHooks();
  return import(fileUrl) as Promise<T>;
}
