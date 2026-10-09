/**
 * giojs-core/src/middleware-loader.ts
 *
 * Loads middleware.{ts,js} from the project root (sibling of app/) via
 * tsImport, mirroring config-loader.ts. A missing file yields empty rules.
 * A file that fails to load, has no default export or holds a rule that
 * cannot be enforced throws, which stops the worker at boot: the rules -
 * guards above all - must never be dropped while the app keeps serving
 * (production refuses to start, dev waits for the file to be fixed).
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTsModule } from './load-ts.ts';
import { middlewareRulesOrThrow, type WireMiddlewareRules } from './middleware.ts';
import { logger } from './logger.ts';

const MIDDLEWARE_NAMES = ['middleware.ts', 'middleware.js'] as const;

export async function loadMiddlewareRules(projectRoot: string): Promise<WireMiddlewareRules> {
  for (const name of MIDDLEWARE_NAMES) {
    const middlewarePath = join(projectRoot, name);
    try {
      await access(middlewarePath);
    } catch {
      continue; // not this extension - try the next
    }
    let mod: { default?: unknown };
    try {
      mod = await loadTsModule<{ default?: unknown }>(pathToFileURL(middlewarePath).href);
    } catch (loadError) {
      const reason = loadError instanceof Error ? loadError.message : String(loadError);
      throw new Error(`${middlewarePath} failed to load: ${reason}`, { cause: loadError });
    }
    if (!('default' in mod)) {
      throw new Error(
        `${middlewarePath} has no default export - export default defineMiddleware({ ... })`,
      );
    }
    const rules = middlewareRulesOrThrow(mod.default, middlewarePath);
    logger.info('middleware rules loaded', {
      path: middlewarePath,
      redirects: rules.redirects?.length ?? 0,
      rewrites: rules.rewrites?.length ?? 0,
      headers: rules.headers?.length ?? 0,
      guards: rules.guards?.length ?? 0,
    });
    return rules;
  }
  return {};
}
