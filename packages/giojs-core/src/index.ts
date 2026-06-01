import { join } from 'node:path';
import { discoverRoutes, discoverLayouts, discoverRouteFiles } from './router.ts';
import { createIPCServer } from './ipc.ts';
import { discoverWsHandlers } from './ws-router.ts';
import { createWsIpcServer } from './ws-ipc.ts';
import { loadGioConfig } from './config-loader.ts';
import { NodePluginRegistry } from './plugin.ts';

const APP_DIR = process.env.GIO_APP_DIR
  ? process.env.GIO_APP_DIR
  : join(process.cwd(), 'app');

const gioConfig = await loadGioConfig(APP_DIR);
const nodePluginRegistry = new NodePluginRegistry();
for (const plugin of gioConfig.plugins ?? []) {
  nodePluginRegistry.register(plugin);
}
await nodePluginRegistry.runStartup();
if (!nodePluginRegistry.isEmpty) {
  console.log('[giojs-core] node plugins registered');
}

process.on('SIGTERM', () => {
  nodePluginRegistry.runShutdown().catch(err => {
    console.error('[giojs-core] plugin shutdown error', err);
  }).finally(() => {
    process.exit(0);
  });
});

console.log(`[giojs-core] discovering routes in ${APP_DIR}`);
const [routes, layouts, routeFiles] = await Promise.all([
  discoverRoutes(APP_DIR),
  discoverLayouts(APP_DIR),
  discoverRouteFiles(APP_DIR),
]);
console.log(`[giojs-core] found ${routes.size} route(s):`, [...routes.keys()]);
console.log(`[giojs-core] found ${layouts.size} layout(s):`, [...layouts.keys()]);

const wsHandlers = await discoverWsHandlers(routeFiles);
console.log(`[giojs-core] found ${wsHandlers.size} WS handler(s):`, [...wsHandlers.keys()]);

createIPCServer(routes, layouts, wsHandlers, nodePluginRegistry);
createWsIpcServer(wsHandlers);
