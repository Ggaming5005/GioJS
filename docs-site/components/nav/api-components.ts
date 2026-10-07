/**
 * docs-site/components/nav/api-components.ts
 *
 * API Reference: Components (/docs/components/<kebab>) and Hooks
 * (/docs/hooks and /docs/hooks/<kebab>). Each group lists its index page
 * first.
 */
import type { NavGroup } from './types.ts';

export const componentsGroups: NavGroup[] = [
  {
    title: 'Components',
    items: [
      { href: '/docs/components', label: 'Overview' },
    ],
  },
  // Hooks belong in this array, not in a second export: index.ts spreads
  // componentsGroups alone. Empty until /docs/hooks lands (not rendered).
  {
    title: 'Hooks',
    items: [],
  },
];
