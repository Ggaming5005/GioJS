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
      { href: '/docs/components/gio-link', label: 'GioLink' },
      { href: '/docs/components/gio-image', label: 'GioImage' },
      { href: '/docs/components/gio-form', label: 'GioForm' },
      { href: '/docs/components/gio-font', label: 'GioFont' },
      { href: '/docs/components/json-ld', label: 'JsonLd' },
      { href: '/docs/components/animate', label: 'Animate' },
      { href: '/docs/components/locale-link', label: 'LocaleLink' },
    ],
  },
  // Hooks belong in this array, not in a second export: index.ts spreads
  // componentsGroups alone.
  {
    title: 'Hooks',
    items: [
      { href: '/docs/hooks', label: 'Overview' },
      { href: '/docs/hooks/use-pathname', label: 'usePathname' },
      { href: '/docs/hooks/use-params', label: 'useParams' },
      { href: '/docs/hooks/use-search-params', label: 'useSearchParams' },
      { href: '/docs/hooks/use-router', label: 'useRouter' },
      { href: '/docs/hooks/use-locale', label: 'useLocale' },
      { href: '/docs/hooks/use-gio-form-state', label: 'useGioFormState' },
      { href: '/docs/hooks/use-web-socket', label: 'useWebSocket' },
    ],
  },
];
