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
    title: 'CLI',
    items: [
      { href: '/docs/cli', label: 'Overview' },
    ],
  },
];
