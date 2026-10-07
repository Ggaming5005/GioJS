/**
 * docs-site/components/nav/guides.ts
 *
 * Guides: task-oriented pages, grouped by what you are doing.
 */
import type { NavGroup } from './types.ts';

export const guidesGroups: NavGroup[] = [
  {
    title: 'App',
    items: [
      { href: '/docs/guides/environment-variables', label: 'Environment Variables' },
      { href: '/docs/authentication', label: 'Authentication' },
      { href: '/docs/guides/authentication-example', label: 'Authentication Example' },
      { href: '/docs/guides/database', label: 'Database' },
      { href: '/docs/i18n', label: 'Internationalization' },
      { href: '/docs/testing', label: 'Testing' },
      { href: '/docs/static-export', label: 'Static Export' },
      { href: '/docs/websockets', label: 'WebSockets' },
    ],
  },
  {
    title: 'Security',
    items: [
      { href: '/docs/security', label: 'Security' },
    ],
  },
  {
    title: 'Starters',
    items: [
      { href: '/docs/starter-features', label: 'Starter Features' },
      { href: '/docs/guides/tailwind', label: 'Tailwind CSS' },
      { href: '/docs/examples', label: 'Examples' },
    ],
  },
  {
    title: 'Deploying',
    items: [
      { href: '/docs/deployment', label: 'Proxies, Sizing & Scaling' },
      { href: '/docs/standalone', label: 'Standalone Deploys' },
      { href: '/docs/guides/docker', label: 'Docker' },
      { href: '/docs/guides/production-checklist', label: 'Production Checklist' },
      { href: '/docs/observability', label: 'Observability' },
      { href: '/docs/adapters', label: 'Adapters' },
    ],
  },
  {
    title: 'Migrating',
    items: [
      { href: '/docs/migration', label: 'Migrating from Next.js' },
    ],
  },
];
