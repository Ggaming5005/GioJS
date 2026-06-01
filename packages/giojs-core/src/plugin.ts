/**
 * giojs-core/src/plugin.ts
 *
 * GioNodePlugin interface and NodePluginRegistry for request/response interception.
 * Plugins run in registration order; onRequest can short-circuit SSR by returning
 * an IPCResponse directly. Plugin errors yield a 500 and never crash the process.
 */
import type { IPCRequest, IPCResponse } from './context.ts';

export interface GioNodePlugin {
  name: string;
  version: string;
  onRequest?: (req: IPCRequest) => Promise<IPCRequest | IPCResponse>;
  onResponse?: (req: IPCRequest, res: IPCResponse) => Promise<IPCResponse>;
  onStartup?: () => Promise<void>;
  onShutdown?: () => Promise<void>;
}

function isIPCResponse(value: IPCRequest | IPCResponse): value is IPCResponse {
  return 'status' in value;
}

function internalError(id: string, pluginName: string): IPCResponse {
  return {
    id,
    status: 500,
    headers: { 'content-type': 'text/plain' },
    body: `Internal Server Error (plugin: ${pluginName})`,
    cacheable: false,
    cacheMaxAge: 0,
  };
}

export class NodePluginRegistry {
  private readonly plugins: GioNodePlugin[] = [];

  register(plugin: GioNodePlugin): void {
    this.plugins.push(plugin);
  }

  get isEmpty(): boolean {
    return this.plugins.length === 0;
  }

  async runStartup(): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.onStartup?.();
    }
  }

  async runShutdown(): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) {
      await plugin.onShutdown?.();
    }
  }

  async interceptRequest(req: IPCRequest): Promise<IPCRequest | IPCResponse> {
    let current: IPCRequest | IPCResponse = req;
    for (const plugin of this.plugins) {
      if (isIPCResponse(current)) break;
      if (plugin.onRequest !== undefined) {
        try {
          current = await plugin.onRequest(current as IPCRequest);
        } catch (err) {
          console.error(`[plugin:${plugin.name}] onRequest error`, err);
          return internalError(req.id, plugin.name);
        }
      }
    }
    return current;
  }

  async interceptResponse(req: IPCRequest, res: IPCResponse): Promise<IPCResponse> {
    let current = res;
    for (const plugin of this.plugins) {
      if (plugin.onResponse !== undefined) {
        try {
          current = await plugin.onResponse(req, current);
        } catch (err) {
          console.error(`[plugin:${plugin.name}] onResponse error`, err);
        }
      }
    }
    return current;
  }
}
