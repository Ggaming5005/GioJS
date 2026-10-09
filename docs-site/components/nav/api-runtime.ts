/**
 * docs-site/components/nav/api-runtime.ts
 *
 * API Reference: Runtime - environment variables (/docs/env-vars), the
 * /_gio endpoints (/docs/endpoints), the headers GioJS sets and reads
 * (/docs/headers) and the TypeScript types (/docs/typescript).
 */
import type { NavGroup } from './types.ts';

export const runtimeReferenceGroups: NavGroup[] = [
  {
    title: 'Runtime',
    items: [
      { href: '/docs/env-vars', label: 'Environment Variables' },
      { href: '/docs/endpoints', label: 'Endpoints' },
      { href: '/docs/headers', label: 'Headers' },
      { href: '/docs/typescript', label: 'TypeScript' },
    ],
  },
];
