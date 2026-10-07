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
 * The `.css` import hooks (css-hooks.ts) register right after tsx's.
 */
import { fileURLToPath } from 'node:url';
import { logger } from './logger.ts';
import { registerCssHooks } from './css-hooks.ts';

let hooksReady: Promise<void> | null = null;

function ensureTransformHooks(): Promise<void> {
  if (hooksReady === null) {
    hooksReady = import('tsx/esm/api')
      .then(({ register }) => {
        register();
        // Last registered runs first: .css never reaches tsx's hooks.
        registerCssHooks();
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

/**
 * vitest's module runner takes a file: URL without percent-decoding it, so
 * app/posts/[id]/page.tsx (`%5Bid%5D`) - or any path with a space - "does
 * not exist" there; it resolves plain paths. Node's own loader keeps the
 * URL (a Windows drive path is no valid import specifier).
 */
function importSpecifier(fileUrl: string): string {
  return process.env.VITEST !== undefined && fileUrl.startsWith('file:')
    ? fileURLToPath(fileUrl)
    : fileUrl;
}

export async function loadTsModule<T>(fileUrl: string): Promise<T> {
  await ensureTransformHooks();
  return import(importSpecifier(fileUrl)) as Promise<T>;
}
