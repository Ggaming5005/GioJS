/**
 * giojs-core/src/middleware-loader.ts
 *
 * Loads middleware.{ts,js} from the project root (sibling of app/) via
 * tsImport, mirroring config-loader.ts. A missing file yields empty rules; a
 * file that fails to load or exports a malformed shape is warned about and
 * ignored - middleware problems must never kill the worker.
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { sanitizeMiddlewareRules, type MiddlewareRules } from './middleware.ts';
import { logger } from './logger.ts';

const MIDDLEWARE_NAMES = ['middleware.ts', 'middleware.js'] as const;

export async function loadMiddlewareRules(projectRoot: string): Promise<MiddlewareRules> {
  for (const name of MIDDLEWARE_NAMES) {
    const middlewarePath = join(projectRoot, name);
    try {
      await access(middlewarePath);
    } catch {
      continue; // not this extension - try the next
    }
    let mod: { default?: unknown };
    try {
      mod = (await tsImport(pathToFileURL(middlewarePath).href, import.meta.url)) as {
        default?: unknown;
      };
    } catch (loadError) {
      logger.warn('middleware file failed to load - rules ignored', {
        path: middlewarePath,
        error: loadError instanceof Error ? loadError.message : String(loadError),
      });
      return {};
    }
    const { rules, warnings } = sanitizeMiddlewareRules(mod.default);
    for (const warning of warnings) {
      logger.warn(warning, { path: middlewarePath });
    }
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
