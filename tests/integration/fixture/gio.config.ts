/**
 * tests/integration/fixture/gio.config.ts
 *
 * Test plugin giving the integration harness observable endpoints:
 *   /echo   - echoes method + forwarded body (proves body forwarding)
 *   /whoami - echoes the caller's cookie, uncacheable (proves render isolation)
 */
import type { GioConfig } from '../../../packages/giojs-core/src/config-loader.ts';
import type { IPCRequest, IPCResponse } from '../../../packages/giojs-core/src/context.ts';

function text(id: string, body: string): IPCResponse {
  return {
    id,
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body,
    cacheable: false,
    cacheMaxAge: 0,
  };
}

export default {
  plugins: [
    {
      name: 'integration-hooks',
      version: '0.0.0',
      async onRequest(req: IPCRequest): Promise<IPCRequest | IPCResponse> {
        if (req.path === '/echo') {
          return text(
            req.id,
            `method=${req.method} base64=${req.bodyBase64} body=${req.body ?? ''}`,
          );
        }
        if (req.path === '/whoami') {
          return text(req.id, `cookie=${req.headers['cookie'] ?? 'none'}`);
        }
        return req;
      },
    },
  ],
} satisfies GioConfig;
