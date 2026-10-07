/**
 * tests/integration/fixture/gio.config.ts
 *
 * Test plugin giving the integration harness observable endpoints:
 *   /echo   - echoes method + forwarded body (proves body forwarding)
 *   /whoami - echoes the caller's cookie, uncacheable (proves render isolation)
 *   /plugin-cookies - a cookie in both the headers map and setCookies plus a
 *                     second one (proves Rust neither duplicates nor drops)
 *   /rule-cookies - two cookies a middleware.ts header rule adds a third to
 *   /plugin-cookies-null - setCookies: null (must not stall the request)
 *   /plugin-malformed-frame - a non-string header value: the response frame
 *                     fails to parse in Rust (must 500 at once, not time out)
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
        if (req.path === '/plugin-cookies') {
          const res = text(req.id, 'cookies');
          res.headers['set-cookie'] = 'a=1; Path=/';
          res.setCookies = ['a=1; Path=/', 'b=2; Path=/'];
          return res;
        }
        if (req.path === '/rule-cookies') {
          const res = text(req.id, 'rule cookies');
          res.setCookies = ['session=r1; Path=/; HttpOnly', 'csrf=r2; Path=/'];
          return res;
        }
        if (req.path === '/plugin-cookies-null') {
          // A plugin "clearing" cookies with null must not fail the frame.
          return { ...text(req.id, 'no cookies'), setCookies: null as unknown as string[] };
        }
        if (req.path === '/plugin-malformed-frame') {
          const res = text(req.id, 'malformed');
          res.headers['x-count'] = 5 as unknown as string;
          return res;
        }
        return req;
      },
    },
  ],
} satisfies GioConfig;
