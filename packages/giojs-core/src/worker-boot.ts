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
import type { RouteModule, LayoutEntry, HandlerEntry, SpecialPages } from './router.ts';
import type { WsHandlerFn } from './ws-router.ts';
import type { MiddlewareRules } from './middleware.ts';

/** Everything the IPC servers need, produced by discovery or by a registry. */
export interface WorkerComponents {
  routes: Map<string, RouteModule>;
  layouts: Map<string, LayoutEntry>;
  wsHandlers: Map<string, WsHandlerFn>;
  handlers: Map<string, HandlerEntry>;
  specialPages: SpecialPages;
  clientScripts: Map<string, string>;
  middlewareRules: MiddlewareRules;
  pluginRegistry: NodePluginRegistry;
}

/**
 * Last-resort guards: log structured context before the supervisor-driven
 * respawn instead of dying with a bare stack trace on stderr.
 */
export function installProcessGuards(): void {
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

  process.on('SIGTERM', () => {
    pluginRegistry.runShutdown().catch((shutdownError: unknown) => {
      logger.error('plugin shutdown error', {
        error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
      });
    }).finally(() => {
      process.exit(0);
    });
  });

  return pluginRegistry;
}

/** Start the HTTP IPC bridge and the WebSocket bridge that Rust connects to. */
export function startIpcServers(components: WorkerComponents): void {
  createIPCServer(
    components.routes,
    components.layouts,
    components.wsHandlers,
    components.pluginRegistry,
    components.clientScripts,
    { handlers: components.handlers, specialPages: components.specialPages },
    components.middlewareRules,
  );
  createWsIpcServer(components.wsHandlers);
}
