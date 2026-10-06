/**
 * tests/integration/fixture/middleware.ts
 *
 * Declarative rules delivered to Rust over the READY frame: a redirect, a
 * rewrite, auth guards (one on a top-level dynamic segment), and response
 * headers (one site-wide) the integration tests assert are enforced by the
 * Rust HTTP layer before any Node code runs.
 */
import { defineMiddleware } from '../../../packages/giojs-core/src/middleware.ts';

export default defineMiddleware({
  redirects: [{ from: '/old-home', to: '/' }],
  rewrites: [{ from: '/alias', to: '/cached' }],
  guards: [
    { path: '/admin', requireCookie: 'session', redirectTo: '/' },
    { path: '/:org/settings', requireCookie: 'session', redirectTo: '/' },
  ],
  headers: [
    { path: '/cached', headers: { 'x-fixture-header': 'from-middleware' } },
    { path: '/*rest', headers: { 'x-fixture-sitewide': 'on' } },
    // Rule cookies join the response's own cookies instead of replacing them.
    { path: '/rule-cookies', headers: { 'set-cookie': 'consent=1; Path=/' } },
  ],
});
