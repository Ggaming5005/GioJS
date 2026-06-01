/**
 * giojs-core/src/ws-router.ts
 *
 * Discovers wsHandler exports from route.ts files found by discoverRouteFiles().
 * Called after discoverRouteFiles() so file URLs are known.
 */
import { tsImport } from 'tsx/esm/api';
import type { GioSocket } from './context.ts';
import type { RouteFile } from './router.ts';

export type WsHandlerFn = (socket: GioSocket) => void;

interface RouteFileModule {
  wsHandler?: WsHandlerFn;
}

export async function discoverWsHandlers(
  routeFiles: RouteFile[],
): Promise<Map<string, WsHandlerFn>> {
  const wsHandlers = new Map<string, WsHandlerFn>();

  await Promise.all(
    routeFiles.map(async ({ filePath, urlPattern }) => {
      try {
        const mod = await tsImport(filePath, import.meta.url) as RouteFileModule;
        if (typeof mod.wsHandler === 'function') {
          wsHandlers.set(urlPattern, mod.wsHandler);
        }
      } catch {
        // Module without wsHandler or load error — skip silently
      }
    }),
  );

  return wsHandlers;
}
