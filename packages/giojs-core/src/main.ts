/**
 * giojs-core/src/main.ts
 *
 * Server bootstrap: loads gio.config, registers node plugins, discovers
 * routes/layouts/WS handlers under app/, then starts both IPC servers
 * (HTTP bridge + WebSocket bridge) that Rust connects to.
 */
import { dirname, join } from 'node:path';
import {
  discoverRoutes,
  discoverLayouts,
  discoverRouteFiles,
  discoverSpecialPages,
} from './router.ts';
import { buildClientBundles } from './client-build.ts';
import { createIPCServer } from './ipc.ts';
import { discoverRouteModules } from './ws-router.ts';
import { createWsIpcServer } from './ws-ipc.ts';
import { loadGioConfig } from './config-loader.ts';
import { loadMiddlewareRules } from './middleware-loader.ts';
import { NodePluginRegistry } from './plugin.ts';
import { writeRouteTypes } from './typed-routes.ts';
import { logger } from './logger.ts';

export async function runServer(): Promise<void> {
  // Last-resort guards: log structured context before the supervisor-driven
  // respawn instead of dying with a bare stack trace on stderr.
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught exception - worker exiting for respawn', {
      error: error.message,
      stack: error.stack ?? '',
    });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled promise rejection - worker exiting for respawn', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? (reason.stack ?? '') : '',
    });
    process.exit(1);
  });

  const appDir = process.env.GIO_APP_DIR
    ? process.env.GIO_APP_DIR
    : join(process.cwd(), 'app');

  const gioConfig = await loadGioConfig(appDir);
  const nodePluginRegistry = new NodePluginRegistry();
  for (const plugin of gioConfig.plugins ?? []) {
    nodePluginRegistry.register(plugin);
  }
  await nodePluginRegistry.runStartup();
  if (!nodePluginRegistry.isEmpty) {
    logger.info('node plugins registered');
  }

  process.on('SIGTERM', () => {
    nodePluginRegistry.runShutdown().catch((shutdownError: unknown) => {
      logger.error('plugin shutdown error', {
        error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
      });
    }).finally(() => {
      process.exit(0);
    });
  });

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

  createIPCServer(
    routes,
    layouts,
    wsHandlers,
    nodePluginRegistry,
    clientScripts,
    { handlers, specialPages },
    middlewareRules,
  );
  createWsIpcServer(wsHandlers);
}
