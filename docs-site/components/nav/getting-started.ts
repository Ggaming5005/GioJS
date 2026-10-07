/**
 * docs-site/components/nav/getting-started.ts
 *
 * Getting Started: a learning path, read top to bottom. One untitled group,
 * so the pages list flat under the section heading.
 */
import type { NavGroup } from './types.ts';

export const gettingStartedGroups: NavGroup[] = [
  {
    items: [
      { href: '/docs/getting-started', label: 'Introduction' },
      { href: '/docs/installation', label: 'Installation' },
      { href: '/docs/project-structure', label: 'Project Structure' },
      { href: '/docs/layouts-and-pages', label: 'Layouts & Pages' },
      { href: '/docs/linking-and-navigating', label: 'Linking & Navigating' },
      { href: '/docs/fetching-data', label: 'Fetching Data' },
      { href: '/docs/forms', label: 'Forms & Mutations' },
      { href: '/docs/caching', label: 'Caching & Revalidating' },
      { href: '/docs/error-handling', label: 'Error Handling' },
      { href: '/docs/css', label: 'CSS & Styling' },
      { href: '/docs/image-optimization', label: 'Images' },
      { href: '/docs/font-optimization', label: 'Fonts' },
      { href: '/docs/metadata', label: 'Metadata & SEO' },
      { href: '/docs/route-handlers', label: 'Route Handlers' },
      { href: '/docs/middleware', label: 'Middleware' },
      { href: '/docs/guides/deploying', label: 'Deploying' },
      { href: '/docs/upgrading', label: 'Upgrading' },
    ],
  },
];
