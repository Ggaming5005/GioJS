/**
 * docs-site/components/nav/api-file-conventions.ts
 *
 * API Reference: File Conventions (/docs/file-conventions/<kebab>), index
 * page first. Route files in reading order (page, the files that wrap it,
 * route.ts), then folders, metadata files, styles and the project root.
 */
import type { NavGroup } from './types.ts';

export const fileConventionsGroups: NavGroup[] = [
  {
    title: 'File Conventions',
    items: [
      { href: '/docs/file-conventions', label: 'Overview' },
      { href: '/docs/file-conventions/page', label: 'page.tsx' },
      { href: '/docs/file-conventions/layout', label: 'layout.tsx' },
      { href: '/docs/file-conventions/loading', label: 'loading.tsx' },
      { href: '/docs/file-conventions/error', label: 'error.tsx' },
      { href: '/docs/file-conventions/not-found', label: 'not-found.tsx' },
      { href: '/docs/file-conventions/route', label: 'route.ts' },
      { href: '/docs/file-conventions/dynamic-routes', label: 'Dynamic Routes' },
      { href: '/docs/file-conventions/route-groups', label: 'Route Groups' },
      { href: '/docs/file-conventions/private-folders', label: 'Private Folders' },
      { href: '/docs/file-conventions/sitemap', label: 'sitemap.ts' },
      { href: '/docs/file-conventions/robots', label: 'robots.ts' },
      { href: '/docs/file-conventions/manifest', label: 'manifest.ts' },
      { href: '/docs/file-conventions/css', label: 'CSS files' },
      { href: '/docs/file-conventions/public-folder', label: 'public/' },
      { href: '/docs/file-conventions/middleware', label: 'middleware.ts' },
      { href: '/docs/file-conventions/env-files', label: '.env files' },
      { href: '/docs/file-conventions/gio-config', label: 'gio.config.ts' },
      { href: '/docs/file-conventions/gio-toml', label: 'gio.toml' },
      { href: '/docs/file-conventions/gio-directory', label: '.gio/' },
    ],
  },
];
