/**
 * docs-site/components/nav/api-gio-toml.ts
 *
 * API Reference: gio.toml (/docs/configuration, with its full reference,
 * and /docs/configuration/<section>), index page first.
 */
import type { NavGroup } from './types.ts';

export const gioTomlGroups: NavGroup[] = [
  {
    title: 'gio.toml',
    items: [
      { href: '/docs/configuration', label: 'Overview' },
      { href: '/docs/configuration/app', label: '[app]' },
      { href: '/docs/configuration/server', label: '[server]' },
      { href: '/docs/configuration/server-tls', label: '[server.tls]' },
      { href: '/docs/configuration/security', label: '[security]' },
      { href: '/docs/configuration/security-csrf', label: '[security.csrf]' },
      { href: '/docs/configuration/security-websocket', label: '[security.websocket]' },
      { href: '/docs/configuration/cache', label: '[cache]' },
      { href: '/docs/configuration/compression', label: '[compression]' },
      { href: '/docs/configuration/prefetch', label: '[prefetch]' },
      { href: '/docs/configuration/images', label: '[images]' },
      { href: '/docs/configuration/fonts', label: '[[fonts]]' },
      { href: '/docs/configuration/css', label: '[css]' },
      { href: '/docs/configuration/websocket', label: '[websocket]' },
      { href: '/docs/configuration/rate-limits', label: '[[rate_limits]]' },
      { href: '/docs/configuration/redirects', label: '[[redirects]]' },
      { href: '/docs/configuration/rewrites', label: '[[rewrites]]' },
      { href: '/docs/configuration/headers', label: '[[headers]]' },
      { href: '/docs/configuration/guards', label: '[[guards]]' },
      { href: '/docs/configuration/i18n', label: '[i18n]' },
      { href: '/docs/configuration/metrics', label: '[metrics]' },
      { href: '/docs/configuration/health', label: '[health]' },
      { href: '/docs/configuration/revalidate', label: '[revalidate]' },
      { href: '/docs/configuration/logging', label: '[logging]' },
      { href: '/docs/configuration/env', label: '[env]' },
      { href: '/docs/configuration/dev', label: '[dev]' },
    ],
  },
];
