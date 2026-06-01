/**
 * giojs-auth-example/src/index.ts
 *
 * Skeleton auth plugin: protects /admin/* routes by checking for a
 * "session=valid" cookie. Returns 403 Forbidden if the cookie is absent.
 * Intended as a reference implementation for the GioNodePlugin interface.
 */
import type { GioNodePlugin } from '../../giojs-core/src/plugin.ts';
import type { IPCRequest, IPCResponse } from '../../giojs-core/src/context.ts';

function forbidden(id: string): IPCResponse {
  return {
    id,
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: 'Forbidden',
    cacheable: false,
    cacheMaxAge: 0,
  };
}

export const authPlugin: GioNodePlugin = {
  name: 'giojs-auth-example',
  version: '0.1.0',

  async onRequest(req: IPCRequest): Promise<IPCRequest | IPCResponse> {
    if (!req.path.startsWith('/admin')) return req;
    const cookie = req.headers['cookie'] ?? '';
    if (cookie.includes('session=valid')) return req;
    return forbidden(req.id);
  },
};
