/**
 * giojs-core/src/standalone-entry.ts
 *
 * Prebuilt-registry entrypoint for `gio build standalone` bundles. The
 * generated entry statically imports every discovered app module (pages,
 * layouts, not-found/error/loading files, route files, sitemap/robots/
 * manifest modules, gio.config, middleware) and hands them over here, so
 * boot performs no filesystem discovery, no tsx transform, and no esbuild
 * client build - the bundle runs on a bare Node install.
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
import { sanitizeMiddlewareRules } from './middleware.ts';
import { registerRouteModule, type RouteFileModule, type WsHandlerFn } from './ws-router.ts';
import { installProcessGuards, startPluginRegistry, startIpcServers } from './worker-boot.ts';
import { logger } from './logger.ts';

export interface StandaloneRouteEntry {
  /** URL pattern, e.g. "/posts/:id". */
  pattern: string;
  /** app/-relative directory of the page; selects its layouts (RouteModule.dir). */
  dir: string;
  /** Original source path, kept for logs and error messages. */
  filePath: string;
  module: PageModule;
}

export interface StandaloneLayoutEntry {
  /** app/-relative directory holding the layout, '' for the root (LayoutEntry.dir). */
  dir: string;
  filePath: string;
  module: LayoutModule;
}

export interface StandaloneSegmentFileEntry {
  kind: SegmentFileKind;
  /** app/-relative directory holding the file, '' for app/ itself (SegmentFileEntry.dir). */
  dir: string;
  filePath: string;
  module: SegmentFileModule;
}

export interface StandaloneMetadataRouteEntry {
  kind: MetadataRouteKind;
  filePath: string;
  module: MetadataRouteModule;
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
  /** Per-folder not-found.*, error.* and loading.* files. */
  segmentFiles?: StandaloneSegmentFileEntry[];
  /** app/sitemap.*, app/robots.*, app/manifest.* */
  metadataRoutes?: StandaloneMetadataRouteEntry[];
  config?: GioConfig | undefined;
  /** Raw default export of middleware.ts; sanitized here at boot. */
  middleware?: unknown;
  /** Route pattern → prebuilt hydration chunk URL. */
  clientScripts?: Record<string, string>;
  /** Prebuilt stylesheet URLs per page. */
  stylesheets?: StyleManifestJson;
}

/** Boot the worker from a prebuilt registry instead of app/ discovery. */
export async function runStandaloneServer(registry: StandaloneRegistry): Promise<void> {
  installProcessGuards();

  const pluginRegistry = await startPluginRegistry(validateGioConfig(registry.config).plugins ?? []);

  const routes = new Map<string, RouteModule>();
  for (const entry of registry.routes) {
    routes.set(entry.pattern, {
      filePath: entry.filePath,
      urlPattern: entry.pattern,
      dir: entry.dir,
      load: () => Promise.resolve(entry.module),
    });
  }

  const layouts = new Map<string, LayoutEntry>();
  for (const entry of registry.layouts) {
    layouts.set(entry.dir, {
      filePath: entry.filePath,
      dir: entry.dir,
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

  const segmentFiles = emptySegmentFiles();
  const segmentMapKey = { 'not-found': 'notFound', error: 'error', loading: 'loading' } as const;
  for (const entry of registry.segmentFiles ?? []) {
    segmentFiles[segmentMapKey[entry.kind]].set(entry.dir, {
      kind: entry.kind,
      filePath: entry.filePath,
      dir: entry.dir,
      load: () => Promise.resolve(entry.module),
    });
  }

  const metadataRoutes: MetadataRoutes = {};
  for (const entry of registry.metadataRoutes ?? []) {
    metadataRoutes[entry.kind] = {
      kind: entry.kind,
      filePath: entry.filePath,
      load: () => Promise.resolve(entry.module),
    };
  }

  const { rules: middlewareRules, warnings } = sanitizeMiddlewareRules(registry.middleware);
  for (const warning of warnings) {
    logger.warn(warning, { source: 'standalone registry' });
  }

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
