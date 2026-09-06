/**
 * giojs-core/src/standalone-entry.ts
 *
 * Prebuilt-registry entrypoint for `gio build standalone` bundles. The
 * generated entry statically imports every discovered app module (pages,
 * layouts, route files, gio.config, middleware) and hands them over here, so
 * boot performs no filesystem discovery, no tsx transform, and no esbuild
 * client build - the bundle runs on a bare Node install.
 */
import type { GioConfig } from './config-loader.ts';
import type {
  HandlerEntry,
  LayoutEntry,
  LayoutModule,
  PageModule,
  RouteModule,
  SpecialPages,
} from './router.ts';
import { sanitizeMiddlewareRules } from './middleware.ts';
import { registerRouteModule, type RouteFileModule, type WsHandlerFn } from './ws-router.ts';
import { installProcessGuards, startPluginRegistry, startIpcServers } from './worker-boot.ts';
import { logger } from './logger.ts';

export interface StandaloneRouteEntry {
  /** URL pattern, e.g. "/posts/:id". */
  pattern: string;
  /** Original source path, kept for logs and error messages. */
  filePath: string;
  module: PageModule;
}

export interface StandaloneLayoutEntry {
  /** URL prefix this layout covers, e.g. "/" or "/docs". */
  prefix: string;
  filePath: string;
  module: LayoutModule;
}

export interface StandaloneRouteFileEntry {
  pattern: string;
  filePath: string;
  module: RouteFileModule;
}

export interface StandaloneRegistry {
  routes: StandaloneRouteEntry[];
  layouts: StandaloneLayoutEntry[];
  routeFiles: StandaloneRouteFileEntry[];
  specialPages?: { notFound?: PageModule; error?: PageModule };
  config?: GioConfig | undefined;
  /** Raw default export of middleware.ts; sanitized here at boot. */
  middleware?: unknown;
  /** Route pattern → prebuilt hydration chunk URL. */
  clientScripts?: Record<string, string>;
}

/** Boot the worker from a prebuilt registry instead of app/ discovery. */
export async function runStandaloneServer(registry: StandaloneRegistry): Promise<void> {
  installProcessGuards();

  const pluginRegistry = await startPluginRegistry(registry.config?.plugins ?? []);

  const routes = new Map<string, RouteModule>();
  for (const entry of registry.routes) {
    routes.set(entry.pattern, {
      filePath: entry.filePath,
      urlPattern: entry.pattern,
      load: () => Promise.resolve(entry.module),
    });
  }

  const layouts = new Map<string, LayoutEntry>();
  for (const entry of registry.layouts) {
    layouts.set(entry.prefix, {
      filePath: entry.filePath,
      urlPrefix: entry.prefix,
      load: () => Promise.resolve(entry.module),
    });
  }

  const wsHandlers = new Map<string, WsHandlerFn>();
  const handlers = new Map<string, HandlerEntry>();
  for (const entry of registry.routeFiles) {
    registerRouteModule(entry.module, entry.filePath, entry.pattern, wsHandlers, handlers);
  }

  const specialPages: SpecialPages = {};
  const notFoundModule = registry.specialPages?.notFound;
  if (notFoundModule !== undefined) {
    specialPages.notFound = () => Promise.resolve(notFoundModule);
  }
  const errorModule = registry.specialPages?.error;
  if (errorModule !== undefined) {
    specialPages.error = () => Promise.resolve(errorModule);
  }

  const { rules: middlewareRules, warnings } = sanitizeMiddlewareRules(registry.middleware);
  for (const warning of warnings) {
    logger.warn(warning, { source: 'standalone registry' });
  }

  const clientScripts = new Map(Object.entries(registry.clientScripts ?? {}));

  logger.info('standalone registry loaded', {
    routes: [...routes.keys()],
    layouts: [...layouts.keys()],
    handlers: [...handlers.keys()],
    ws: [...wsHandlers.keys()],
    clientScripts: clientScripts.size,
  });

  startIpcServers({
    routes,
    layouts,
    wsHandlers,
    handlers,
    specialPages,
    clientScripts,
    middlewareRules,
    pluginRegistry,
  });
}
