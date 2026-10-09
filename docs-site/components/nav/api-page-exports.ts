/**
 * docs-site/components/nav/api-page-exports.ts
 *
 * API Reference: Page Exports (/docs/page-exports and
 * /docs/page-exports/<kebab>) - the module exports the framework reads from
 * a page, layout or route.ts. Page exports in the order a page file usually
 * declares them, then the route.ts exports.
 */
import type { NavGroup } from './types.ts';

export const pageExportsGroups: NavGroup[] = [
  {
    title: 'Page Exports',
    items: [
      { href: '/docs/page-exports', label: 'Overview' },
      { href: '/docs/page-exports/get-server-side-props', label: 'getServerSideProps' },
      { href: '/docs/page-exports/action', label: 'action' },
      { href: '/docs/page-exports/metadata', label: 'metadata' },
      { href: '/docs/page-exports/generate-metadata', label: 'generateMetadata' },
      { href: '/docs/page-exports/revalidate', label: 'revalidate' },
      { href: '/docs/page-exports/tags', label: 'tags' },
      { href: '/docs/page-exports/shell', label: 'shell' },
      { href: '/docs/page-exports/get-static-paths', label: 'getStaticPaths' },
      { href: '/docs/page-exports/http-methods', label: 'GET, POST, PUT, PATCH, DELETE' },
      { href: '/docs/page-exports/ws-handler', label: 'wsHandler' },
    ],
  },
];
