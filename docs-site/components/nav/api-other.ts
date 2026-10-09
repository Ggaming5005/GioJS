/**
 * docs-site/components/nav/api-other.ts
 *
 * API Reference: the rest - gio.config.ts, the CLI (/docs/cli and
 * /docs/cli/<command>), create-giojs, environment variables, endpoints and
 * headers, TypeScript.
 */
import type { NavGroup } from './types.ts';

export const otherReferenceGroups: NavGroup[] = [
  {
    title: 'gio.config.ts',
    items: [
      { href: '/docs/gio-config', label: 'Overview' },
    ],
  },
  {
    title: 'CLI',
    items: [
      { href: '/docs/cli', label: 'Overview' },
      { href: '/docs/cli/dev', label: 'gio dev' },
      { href: '/docs/cli/start', label: 'gio start' },
      { href: '/docs/cli/build', label: 'gio build' },
      { href: '/docs/cli/build-standalone', label: 'gio build standalone' },
      { href: '/docs/cli/export', label: 'gio export' },
      { href: '/docs/cli/routes', label: 'gio routes' },
      { href: '/docs/cli/typegen', label: 'gio typegen' },
      { href: '/docs/cli/doctor', label: 'gio doctor' },
      { href: '/docs/cli/info', label: 'gio info' },
      { href: '/docs/cli/cache-explain', label: 'gio cache explain' },
      { href: '/docs/cli/bench', label: 'gio bench' },
      { href: '/docs/cli/migrate', label: 'gio migrate' },
      { href: '/docs/cli/add', label: 'gio add' },
      { href: '/docs/cli/help', label: 'gio help' },
      { href: '/docs/cli/giojs-server', label: 'giojs-server' },
    ],
  },
  {
    title: 'create-giojs',
    items: [
      { href: '/docs/create-giojs', label: 'Overview' },
    ],
  },
];
