/**
 * tests/integration/fixture/middleware.ts
 *
 * Declarative rules delivered to Rust over the READY frame: a redirect, a
 * rewrite, an auth guard, and a response header the integration tests assert
 * are enforced by the Rust HTTP layer before any Node code runs.
 */
import { defineMiddleware } from '../../../packages/giojs-core/src/middleware.ts';

export default defineMiddleware({
  redirects: [{ from: '/old-home', to: '/' }],
  rewrites: [{ from: '/alias', to: '/cached' }],
  guards: [{ path: '/admin', requireCookie: 'session', redirectTo: '/' }],
  headers: [{ path: '/cached', headers: { 'x-fixture-header': 'from-middleware' } }],
});
