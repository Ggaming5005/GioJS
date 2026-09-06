/**
 * giojs-core/src/main.ts
 *
 * Server bootstrap for the source path: loads gio.config, registers node
 * plugins, discovers routes/layouts/WS handlers under app/, builds client
 * bundles, then hands the components to worker-boot.ts to start both IPC
 * servers (HTTP bridge + WebSocket bridge) that Rust connects to.
 */
import { dirname, join } from 'node:path';
import {
  discoverRoutes,
  discoverLayouts,
  discoverRouteFiles,
  discoverSpecialPages,
} from './router.ts';
import { buildClientBundles } from './client-build.ts';
import { discoverRouteModules } from './ws-router.ts';
import { loadGioConfig } from './config-loader.ts';
import { loadMiddlewareRules } from './middleware-loader.ts';
import { writeRouteTypes } from './typed-routes.ts';
import { installProcessGuards, startPluginRegistry, startIpcServers } from './worker-boot.ts';
import { logger } from './logger.ts';

export async function runServer(): Promise<void> {
  installProcessGuards();

  const appDir = process.env.GIO_APP_DIR
    ? process.env.GIO_APP_DIR
    : join(process.cwd(), 'app');

  const gioConfig = await loadGioConfig(appDir);
  const nodePluginRegistry = await startPluginRegistry(gioConfig.plugins ?? []);

  logger.info('discovering routes', { appDir });
  const [routes, layouts, routeFiles] = await Promise.all([
    discoverRoutes(appDir),
    discoverLayouts(appDir),
    discoverRouteFiles(appDir),
  ]);
  logger.info('routes discovered', { count: routes.size, patterns: [...routes.keys()] });
  logger.info('layouts discovered', { count: layouts.size, prefixes: [...layouts.keys()] });

  const { wsHandlers, handlers } = await discoverRouteModules(routeFiles);
  logger.info('route handlers discovered', {
    ws: [...wsHandlers.keys()],
    http: [...handlers.keys()],
  });

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

  const specialPages = await discoverSpecialPages(appDir);

  // Declarative rules from middleware.ts at the project root; delivered to
  // Rust in the READY frame and enforced there, before routing.
  const middlewareRules = await loadMiddlewareRules(dirname(appDir));

  // Bundle the hydration entries before accepting requests. buildClientBundles
  // never throws: routes whose bundle fails render server-only.
  const clientScripts = await buildClientBundles({
    routes,
    layouts,
    projectRoot: dirname(appDir),
    dev: process.env.NODE_ENV !== 'production',
  });

  startIpcServers({
    routes,
    layouts,
    wsHandlers,
    handlers,
    specialPages,
    clientScripts,
    middlewareRules,
    pluginRegistry: nodePluginRegistry,
  });
}
