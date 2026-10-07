/**
 * giojs-core/src/ws-router.ts
 *
 * Loads route.ts files found by discoverRouteFiles() (once each) and
 * extracts both kinds of exports: `wsHandler` for the WebSocket bridge, and
 * HTTP method handlers (GET/POST/PUT/PATCH/DELETE) for API routes and SSE.
 */
import { loadTsModule } from './load-ts.ts';
import type { WsHandler } from './context.ts';
import { HANDLER_METHODS } from './router.ts';
import type { HandlerEntry, RouteFile, RouteHandlerFn } from './router.ts';
import { matchIn } from './ssr.ts';
import { logger } from './logger.ts';

export type WsHandlerFn = WsHandler;

/**
 * Find the wsHandler for a connection path with the rules pages and route.ts
 * handlers use (exact static match first, then the most specific of
 * :param / *catchAll / *optional? patterns; route groups are already gone
 * from the patterns), so app/chat/[room]/route.ts answers /chat/lobby.
 */
export function matchWsHandler(
  path: string,
  wsHandlers: Map<string, WsHandlerFn>,
): { handler: WsHandlerFn; pattern: string; params: Record<string, string> } | null {
  const match = matchIn(path, wsHandlers);
  return match === null ? null : { handler: match.entry, pattern: match.pattern, params: match.params };
}

export interface RouteFileModule {
  wsHandler?: WsHandlerFn;
  [method: string]: unknown;
}

export interface RouteModules {
  wsHandlers: Map<string, WsHandlerFn>;
  handlers: Map<string, HandlerEntry>;
}

/**
 * Register a loaded route.ts module's exports: `wsHandler` into `wsHandlers`,
 * HTTP method handlers into `handlers`. Shared by filesystem discovery and
 * the standalone prebuilt registry.
 */
export function registerRouteModule(
  mod: RouteFileModule,
  filePath: string,
  urlPattern: string,
  wsHandlers: Map<string, WsHandlerFn>,
  handlers: Map<string, HandlerEntry>,
): void {
  if (typeof mod.wsHandler === 'function') {
    wsHandlers.set(urlPattern, mod.wsHandler);
  }
  const methods = new Map<string, RouteHandlerFn>();
  for (const method of HANDLER_METHODS) {
    if (typeof mod[method] === 'function') {
      methods.set(method, mod[method] as RouteHandlerFn);
    }
  }
  if (methods.size > 0) {
    handlers.set(urlPattern, { filePath, urlPattern, methods });
  }
}

export async function discoverRouteModules(routeFiles: RouteFile[]): Promise<RouteModules> {
  const wsHandlers = new Map<string, WsHandlerFn>();
  const handlers = new Map<string, HandlerEntry>();

  await Promise.all(
    routeFiles.map(async ({ filePath, urlPattern }) => {
      try {
        const mod = await loadTsModule<RouteFileModule>(filePath);
        registerRouteModule(mod, filePath, urlPattern, wsHandlers, handlers);
      } catch (loadError) {
        logger.warn('route file failed to load, skipping its handlers', {
          filePath,
          urlPattern,
          error: loadError instanceof Error ? loadError.message : String(loadError),
        });
      }
    }),
  );

  return { wsHandlers, handlers };
}

/** Back-compat wrapper: wsHandler discovery only. */
export async function discoverWsHandlers(
  routeFiles: RouteFile[],
): Promise<Map<string, WsHandlerFn>> {
  return (await discoverRouteModules(routeFiles)).wsHandlers;
}
