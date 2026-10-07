/**
 * giojs-core/src/worker-boot.ts
 *
 * Boot code shared by both worker entrypoints: the dev/source path
 * (main.ts, filesystem discovery via tsx) and the standalone path
 * (standalone-entry.ts, prebuilt registry). Owns process guards, plugin
 * lifecycle, and starting the two IPC servers - and imports nothing that
 * needs tsx or esbuild, so standalone bundles boot without node_modules.
 */
import { createIPCServer } from './ipc.ts';
import { createWsIpcServer } from './ws-ipc.ts';
import { NodePluginRegistry, type GioNodePlugin } from './plugin.ts';
import { logger } from './logger.ts';
import { imageConfigFromEnv, installImageConfig } from './image-config.ts';
import { parentWatchEnabled, watchParent } from './parent-watch.ts';
import type net from 'node:net';
import type {
  RouteModule,
  LayoutEntry,
  HandlerEntry,
  SpecialPages,
  SegmentFiles,
} from './router.ts';
import type { WsHandlerFn } from './ws-router.ts';
import type { WireMiddlewareRules } from './middleware.ts';
import type { MetadataRoutes } from './metadata-routes.ts';
import type { StyleManifest } from './style-manifest.ts';

/** Everything the IPC servers need, produced by discovery or by a registry. */
export interface WorkerComponents {
  routes: Map<string, RouteModule>;
  layouts: Map<string, LayoutEntry>;
  wsHandlers: Map<string, WsHandlerFn>;
  handlers: Map<string, HandlerEntry>;
  specialPages: SpecialPages;
  segmentFiles: SegmentFiles;
  /** app/sitemap.*, app/robots.*, app/manifest.* */
  metadataRoutes: MetadataRoutes;
  clientScripts: Map<string, string>;
  /** Each page's stylesheets (css-build.ts); absent when none were built. */
  stylesheets?: StyleManifest;
  middlewareRules: WireMiddlewareRules;
  pluginRegistry: NodePluginRegistry;
  /**
   * Content hash of the app's server-side sources (server-source-hash.ts),
   * computed by the builder; folded into the READY `buildHash` so a
   * server-only change gets a new deployment ID.
   */
  serverSourceHash?: string;
}

/** Upper bound on plugin shutdown hooks before the worker exits anyway. */
const SHUTDOWN_GRACE_MS = 5_000;

// Set as boot progresses, so a shutdown at any point closes what exists.
let activePluginRegistry: NodePluginRegistry | null = null;
const activeIpcServers: net.Server[] = [];
let shuttingDown = false;

/**
 * Graceful exit: stop accepting IPC connections, run plugin shutdown hooks
 * (bounded by SHUTDOWN_GRACE_MS - a hung hook must not keep an orphan
 * alive), then exit 0. Idempotent.
 */
function shutdownWorker(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const server of activeIpcServers) {
    server.close();
  }
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  const registry = activePluginRegistry;
  const hooks = registry === null ? Promise.resolve() : registry.runShutdown();
  hooks.catch((shutdownError: unknown) => {
    logger.error('plugin shutdown error', {
      error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
    });
  }).finally(() => {
    process.exit(0);
  });
}

/**
 * Last-resort guards: log structured context before the supervisor-driven
 * respawn instead of dying with a bare stack trace on stderr. Also starts the
 * parent watch (see parent-watch.ts) when the server asked for it, first
 * thing at boot: a server killed while the worker is still bundling must not
 * leave it running either.
 */
export function installProcessGuards(): void {
  if (parentWatchEnabled(process.env)) {
    watchParent({
      onParentGone(reason) {
        logger.warn('server process gone - worker shutting down', { reason });
        shutdownWorker();
      },
    });
  }
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
}

/** Register plugins, run their startup hooks, and wire SIGTERM shutdown. */
export async function startPluginRegistry(
  plugins: readonly GioNodePlugin[],
): Promise<NodePluginRegistry> {
  const pluginRegistry = new NodePluginRegistry();
  for (const plugin of plugins) {
    pluginRegistry.register(plugin);
  }
  await pluginRegistry.runStartup();
  if (!pluginRegistry.isEmpty) {
    logger.info('node plugins registered');
  }

  activePluginRegistry = pluginRegistry;
  process.on('SIGTERM', shutdownWorker);

  return pluginRegistry;
}

/** Start the HTTP IPC bridge and the WebSocket bridge that Rust connects to. */
export function startIpcServers(components: WorkerComponents): void {
  // GIO_IMAGE_CONFIG comes from Rust: the widths /_gio/image accepts.
  installImageConfig(imageConfigFromEnv(process.env));
  const httpServer = createIPCServer(
    components.routes,
    components.layouts,
    components.wsHandlers,
    components.pluginRegistry,
    components.clientScripts,
    {
      handlers: components.handlers,
      specialPages: components.specialPages,
      segmentFiles: components.segmentFiles,
      metadataRoutes: components.metadataRoutes,
      ...(components.stylesheets !== undefined ? { stylesheets: components.stylesheets } : {}),
    },
    components.middlewareRules,
    components.serverSourceHash,
  );
  activeIpcServers.push(httpServer, createWsIpcServer(components.wsHandlers));
}
