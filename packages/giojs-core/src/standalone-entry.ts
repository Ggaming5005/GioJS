/**
 * giojs-core/src/standalone-entry.ts
 *
 * Prebuilt-registry entrypoint for `gio build standalone` bundles. The
 * generated entry bundles every discovered app module (pages, layouts,
 * not-found/error/loading files, route files, sitemap/robots/manifest
 * modules, gio.config, middleware) and hands them over here, so boot
 * performs no filesystem discovery, no tsx transform, and no esbuild client
 * build - the bundle runs on a bare Node install.
 *
 * Per-route modules arrive as loaders and are evaluated when the source path
 * evaluates them: route files at boot, the rest on first use. A route file
 * that throws while it is imported answers 500 (registerFailedRouteModule),
 * a page that does renders the error page - the worker still starts.
 * gio.config and middleware.ts load at boot, after the process guards: one
 * that throws stops the worker, and the server prints its error.
 */
import { validateGioConfig, type GioConfig } from './gio-config.ts';
import type {
  HandlerEntry,
  LayoutEntry,
  LayoutModule,
  PageModule,
  RouteModule,
  SegmentFileKind,
  SegmentFileModule,
  SpecialPages,
} from './router.ts';
import { emptySegmentFiles } from './router.ts';
import type { MetadataRouteKind, MetadataRouteModule, MetadataRoutes } from './metadata-routes.ts';
import { styleManifestFromJson, type StyleManifestJson } from './style-manifest.ts';
import { middlewareRulesOrThrow } from './middleware.ts';
import {
  registerFailedRouteModule,
  registerRouteModule,
  type RouteFileModule,
  type WsHandlerFn,
} from './ws-router.ts';
import { installProcessGuards, startPluginRegistry, startIpcServers } from './worker-boot.ts';
import { logger } from './logger.ts';

export interface StandaloneRouteEntry {
  /** URL pattern, e.g. "/posts/:id". */
  pattern: string;
  /** app/-relative directory of the page; selects its layouts (RouteModule.dir). */
  dir: string;
  /** Original source path, kept for logs and error messages. */
  filePath: string;
  load: () => Promise<PageModule>;
}

export interface StandaloneLayoutEntry {
  /** app/-relative directory holding the layout, '' for the root (LayoutEntry.dir). */
  dir: string;
  filePath: string;
  load: () => Promise<LayoutModule>;
}

export interface StandaloneSegmentFileEntry {
  kind: SegmentFileKind;
  /** app/-relative directory holding the file, '' for app/ itself (SegmentFileEntry.dir). */
  dir: string;
  filePath: string;
  load: () => Promise<SegmentFileModule>;
}

export interface StandaloneMetadataRouteEntry {
  kind: MetadataRouteKind;
  filePath: string;
  load: () => Promise<MetadataRouteModule>;
}

export interface StandaloneRouteFileEntry {
  pattern: string;
  filePath: string;
  load: () => Promise<RouteFileModule>;
}

export interface StandaloneRegistry {
  routes: StandaloneRouteEntry[];
  layouts: StandaloneLayoutEntry[];
  routeFiles: StandaloneRouteFileEntry[];
  specialPages?: { notFound?: () => Promise<PageModule>; error?: () => Promise<PageModule> };
  /** Per-folder not-found.*, error.* and loading.* files. */
  segmentFiles?: StandaloneSegmentFileEntry[];
  /** app/sitemap.*, app/robots.*, app/manifest.* */
  metadataRoutes?: StandaloneMetadataRouteEntry[];
  /** gio.config's module, loaded at boot. */
  config?: () => Promise<{ default?: unknown }>;
  /** middleware.ts's module, loaded and validated at boot. */
  middleware?: () => Promise<{ default?: unknown }>;
  /** Route pattern → prebuilt hydration chunk URL. */
  clientScripts?: Record<string, string>;
  /** Prebuilt stylesheet URLs per page. */
  stylesheets?: StyleManifestJson;
}

/** The module `load` imports (none without a loader), or an error naming `source`. */
async function loadBootModule(
  load: (() => Promise<{ default?: unknown }>) | undefined,
  source: string,
): Promise<{ default?: unknown } | undefined> {
  if (load === undefined) return undefined;
  try {
    return await load();
  } catch (loadError) {
    const reason = loadError instanceof Error ? loadError.message : String(loadError);
    throw new Error(`${source} failed to load: ${reason}`, { cause: loadError });
  }
}

/** Boot the worker from a prebuilt registry instead of app/ discovery. */
export async function runStandaloneServer(registry: StandaloneRegistry): Promise<void> {
  installProcessGuards();

  const configModule = await loadBootModule(registry.config, 'gio.config (standalone build)');
  const config: GioConfig = validateGioConfig(configModule?.default);
  const pluginRegistry = await startPluginRegistry(config.plugins ?? []);

  const routes = new Map<string, RouteModule>();
  for (const entry of registry.routes) {
    routes.set(entry.pattern, {
      filePath: entry.filePath,
      urlPattern: entry.pattern,
      dir: entry.dir,
      load: entry.load,
    });
  }

  const layouts = new Map<string, LayoutEntry>();
  for (const entry of registry.layouts) {
    layouts.set(entry.dir, {
      filePath: entry.filePath,
      dir: entry.dir,
      load: entry.load,
    });
  }

  const wsHandlers = new Map<string, WsHandlerFn>();
  const handlers = new Map<string, HandlerEntry>();
  // Loaded at boot like discoverRouteModules does, in registry order.
  for (const entry of registry.routeFiles) {
    let mod: RouteFileModule;
    try {
      mod = await entry.load();
    } catch (loadError) {
      registerFailedRouteModule(loadError, entry.filePath, entry.pattern, wsHandlers, handlers);
      continue;
    }
    registerRouteModule(mod, entry.filePath, entry.pattern, wsHandlers, handlers);
  }

  const specialPages: SpecialPages = {};
  const notFoundLoad = registry.specialPages?.notFound;
  if (notFoundLoad !== undefined) specialPages.notFound = notFoundLoad;
  const errorLoad = registry.specialPages?.error;
  if (errorLoad !== undefined) specialPages.error = errorLoad;

  const segmentFiles = emptySegmentFiles();
  const segmentMapKey = { 'not-found': 'notFound', error: 'error', loading: 'loading' } as const;
  for (const entry of registry.segmentFiles ?? []) {
    segmentFiles[segmentMapKey[entry.kind]].set(entry.dir, {
      kind: entry.kind,
      filePath: entry.filePath,
      dir: entry.dir,
      load: entry.load,
    });
  }

  const metadataRoutes: MetadataRoutes = {};
  for (const entry of registry.metadataRoutes ?? []) {
    metadataRoutes[entry.kind] = {
      kind: entry.kind,
      filePath: entry.filePath,
      load: entry.load,
    };
  }

  // A file that throws, has no default export or holds a rule that cannot
  // be enforced stops the worker, as from source (middleware-loader.ts).
  const middlewareSource = 'middleware.ts (standalone build)';
  const middlewareModule = await loadBootModule(registry.middleware, middlewareSource);
  if (middlewareModule !== undefined && !('default' in middlewareModule)) {
    throw new Error(`${middlewareSource} has no default export - export default defineMiddleware({ ... })`);
  }
  const middlewareRules = middlewareRulesOrThrow(middlewareModule?.default, middlewareSource);

  const clientScripts = new Map(Object.entries(registry.clientScripts ?? {}));
  const stylesheets = styleManifestFromJson(registry.stylesheets);

  logger.info('standalone registry loaded', {
    routes: [...routes.keys()],
    layouts: [...layouts.keys()],
    handlers: [...handlers.keys()],
    ws: [...wsHandlers.keys()],
    metadataRoutes: Object.keys(metadataRoutes),
    clientScripts: clientScripts.size,
  });

  startIpcServers({
    routes,
    layouts,
    wsHandlers,
    handlers,
    specialPages,
    segmentFiles,
    metadataRoutes,
    clientScripts,
    stylesheets,
    middlewareRules,
    pluginRegistry,
  });
}
