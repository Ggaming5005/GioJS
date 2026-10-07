/**
 * docs-site/components/nav/api-functions.ts
 *
 * API Reference: Functions (/docs/functions/<kebab>), index page first.
 * Three groups: server functions from @gio.js/core (with the index), client
 * functions from @gio.js/react, and the testing kit (@gio.js/core/testing
 * and /vitest).
 */
import type { NavGroup } from './types.ts';

export const functionsGroups: NavGroup[] = [
  {
    title: 'Functions',
    items: [
      { href: '/docs/functions', label: 'Overview' },
      { href: '/docs/functions/redirect', label: 'redirect' },
      { href: '/docs/functions/not-found', label: 'notFound' },
      { href: '/docs/functions/revalidate-path', label: 'revalidatePath' },
      { href: '/docs/functions/revalidate-tag', label: 'revalidateTag' },
      { href: '/docs/functions/create-session-storage', label: 'createSessionStorage' },
      { href: '/docs/functions/cookies', label: 'Cookie helpers' },
      { href: '/docs/functions/csp-nonce', label: 'cspNonce' },
      { href: '/docs/functions/gio-event-stream', label: 'GioEventStream' },
      { href: '/docs/functions/broadcast', label: 'broadcast' },
      { href: '/docs/functions/request-errors', label: 'Request body errors' },
      { href: '/docs/functions/define-middleware', label: 'defineMiddleware' },
      { href: '/docs/functions/define-config', label: 'defineConfig' },
      { href: '/docs/functions/server-only', label: 'server-only' },
    ],
  },
  {
    title: 'Client Functions',
    items: [
      { href: '/docs/functions/navigate', label: 'navigate' },
      { href: '/docs/functions/href', label: 'href' },
      { href: '/docs/functions/deployment-helpers', label: 'Deployment helpers' },
    ],
  },
  {
    title: 'Testing Functions',
    items: [
      { href: '/docs/functions/render-page', label: 'renderPage' },
      { href: '/docs/functions/call-route', label: 'callRoute' },
      { href: '/docs/functions/create-test-server', label: 'createTestServer' },
      { href: '/docs/functions/reset-test-app', label: 'resetTestApp' },
      { href: '/docs/functions/gio-vitest', label: 'gioVitest' },
    ],
  },
];
