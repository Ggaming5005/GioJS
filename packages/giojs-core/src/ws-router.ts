/**
 * giojs-core/src/ws-router.ts
 *
 * Loads route.ts files found by discoverRouteFiles() (once each) and
 * extracts both kinds of exports: `wsHandler` for the WebSocket bridge, and
 * HTTP method handlers (GET/POST/PUT/PATCH/DELETE) for API routes and SSE.
 */
import { tsImport } from 'tsx/esm/api';
import type { GioSocket } from './context.ts';
import { HANDLER_METHODS } from './router.ts';
import type { HandlerEntry, RouteFile, RouteHandlerFn } from './router.ts';
import { logger } from './logger.ts';

export type WsHandlerFn = (socket: GioSocket) => void;

interface RouteFileModule {
  wsHandler?: WsHandlerFn;
  [method: string]: unknown;
}

export interface RouteModules {
  wsHandlers: Map<string, WsHandlerFn>;
  handlers: Map<string, HandlerEntry>;
}

export async function discoverRouteModules(routeFiles: RouteFile[]): Promise<RouteModules> {
  const wsHandlers = new Map<string, WsHandlerFn>();
  const handlers = new Map<string, HandlerEntry>();

  await Promise.all(
    routeFiles.map(async ({ filePath, urlPattern }) => {
      try {
        const mod = await tsImport(filePath, import.meta.url) as RouteFileModule;
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
