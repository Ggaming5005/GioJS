/**
 * giojs-core/src/main.ts
 *
 * Server bootstrap for the source path: loads gio.config, registers node
 * plugins, discovers routes/layouts/WS handlers under app/, builds the
 * route stylesheets and client bundles, then hands the components to
 * worker-boot.ts to start both IPC servers (HTTP bridge + WebSocket bridge)
 * that Rust connects to.
 *
 * In a worker pool only the first worker builds (and writes the generated
 * route types); the others load its build manifest (build-manifest.ts).
 */
import { dirname, join } from 'node:path';
import {
  discoverRoutes,
  discoverLayouts,
  discoverRouteFiles,
  discoverSpecialPages,
  discoverSegmentFiles,
  discoverMetadataRoutes,
  assertNoRouteConflicts,
  assertNoMetadataRouteConflicts,
} from './router.ts';
import { buildClientBundles } from './client-build.ts';
import { buildRouteStylesheets } from './css-build.ts';
import { BUILD_ID_ENV, loadClientBuild, reuseBuildRequested } from './build-manifest.ts';
import { discoverRouteModules } from './ws-router.ts';
import { loadGioConfig } from './config-loader.ts';
import { loadMiddlewareRules } from './middleware-loader.ts';
import { writeRouteTypes } from './typed-routes.ts';
import { installProcessGuards, startPluginRegistry, startIpcServers } from './worker-boot.ts';
import { logger } from './logger.ts';
import { isDevMode } from './mode.ts';

export async function runServer(): Promise<void> {
  installProcessGuards();

  const appDir = process.env.GIO_APP_DIR
    ? process.env.GIO_APP_DIR
    : join(process.cwd(), 'app');

  const gioConfig = await loadGioConfig(appDir);
  const nodePluginRegistry = await startPluginRegistry(gioConfig.plugins ?? []);

  logger.info('discovering routes', { appDir });
  const [routes, layouts, routeFiles, segmentFiles, metadataRoutes] = await Promise.all([
    discoverRoutes(appDir),
    discoverLayouts(appDir),
    discoverRouteFiles(appDir),
    discoverSegmentFiles(appDir),
    discoverMetadataRoutes(appDir),
  ]);
  assertNoRouteConflicts(appDir, routes, routeFiles);
  assertNoMetadataRouteConflicts(appDir, routes, routeFiles, metadataRoutes);
  logger.info('routes discovered', { count: routes.size, patterns: [...routes.keys()] });
  logger.info('layouts discovered', {
    count: layouts.size,
    dirs: [...layouts.keys()].map(dir => (dir === '' ? '.' : dir)),
  });
  if (Object.keys(metadataRoutes).length > 0) {
    logger.info('metadata routes discovered', { kinds: Object.keys(metadataRoutes) });
  }

  const { wsHandlers, handlers } = await discoverRouteModules(routeFiles);
  logger.info('route handlers discovered', {
    ws: [...wsHandlers.keys()],
    http: [...handlers.keys()],
  });

  // The builder's job, like the bundles: in a pool every worker would
  // write the same file at once.
  const reuseBuild = reuseBuildRequested(process.env);
  if (!reuseBuild) {
    // Best-effort: typed routes improve DX but must never block boot.
    try {
      const wrote = await writeRouteTypes(dirname(appDir), [...routes.keys(), ...handlers.keys()]);
      if (wrote) {
        logger.info('route types written', { path: '.gio/routes.d.ts' });
      }
    } catch (typeGenError: unknown) {
      logger.warn('route type generation failed', {
        error: typeGenError instanceof Error ? typeGenError.message : String(typeGenError),
      });
    }
  }

  const specialPages = await discoverSpecialPages(appDir);

  // Declarative rules from middleware.ts at the project root; delivered to
  // Rust in the READY frame and enforced there, before routing.
  const middlewareRules = await loadMiddlewareRules(dirname(appDir));

  const projectRoot = dirname(appDir);
  const { clientScripts, stylesheets } = await loadClientBuild({
    projectRoot,
    reuse: reuseBuild,
    buildId: process.env[BUILD_ID_ENV],
    // Stylesheets first: each hydration entry renders its route's links.
    // Both builds run before accepting requests and never throw - a route
    // whose CSS fails renders without it, one whose bundle fails renders
    // server-only.
    async build() {
      const stylesheets = await buildRouteStylesheets({
        routes,
        layouts,
        segmentFiles,
        projectRoot,
        dev: isDevMode(),
      });
      const clientScripts = await buildClientBundles({
        routes,
        layouts,
        segmentFiles,
        projectRoot,
        dev: isDevMode(),
        stylesheets: stylesheets.routes,
      });
      return { clientScripts, stylesheets };
    },
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
    pluginRegistry: nodePluginRegistry,
  });
}
