/**
 * docs-site/components/nav/architecture.ts
 *
 * Architecture: how GioJS is built, how fast it is, and where it stops.
 */
import type { NavGroup } from './types.ts';

export const architectureGroups: NavGroup[] = [
  {
    items: [
      { href: '/docs/architecture', label: 'How GioJS Works' },
      { href: '/docs/boundary', label: 'The Rust ⇄ Node Boundary' },
      { href: '/docs/caching-layers', label: 'Caching Layers' },
      { href: '/docs/benchmarks', label: 'Benchmarks' },
      { href: '/docs/known-issues', label: 'Known Limitations' },
      { href: '/docs/contributing', label: 'Contributing' },
    ],
  },
];
