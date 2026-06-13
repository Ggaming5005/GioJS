/**
 * docs-site/components/Sidebar.tsx
 *
 * Grouped sidebar navigation. Receives the current path so the active link is
 * marked server-side with aria-current="page". Plain anchors keep it robust
 * (full-page nav) — no client runtime needed for docs.
 */
import React from 'react';

interface NavItem {
  href: string;
  label: string;
}
interface NavGroup {
  title: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Getting Started',
    items: [
      { href: '/docs/getting-started', label: 'Introduction' },
      { href: '/docs/installation', label: 'Installation' },
      { href: '/docs/project-structure', label: 'Project Structure' },
    ],
  },
  {
    title: 'Building Your App',
    items: [
      { href: '/docs/layouts-and-pages', label: 'Layouts & Pages' },
      { href: '/docs/linking-and-navigating', label: 'Linking & Navigating' },
      { href: '/docs/fetching-data', label: 'Fetching Data' },
      { href: '/docs/caching', label: 'Caching & Revalidating' },
      { href: '/docs/error-handling', label: 'Error Handling' },
      { href: '/docs/css', label: 'CSS & Styling' },
      { href: '/docs/image-optimization', label: 'Image Optimization' },
      { href: '/docs/font-optimization', label: 'Font Optimization' },
      { href: '/docs/route-handlers', label: 'Route Handlers' },
      { href: '/docs/websockets', label: 'WebSockets' },
      { href: '/docs/i18n', label: 'Internationalization' },
    ],
  },
  {
    title: 'Architecture',
    items: [
      { href: '/docs/architecture', label: 'How GioJS Works' },
      { href: '/docs/boundary', label: 'The Rust ⇄ Node Boundary' },
      { href: '/docs/caching-layers', label: 'Caching Layers' },
    ],
  },
  {
    title: 'API Reference',
    items: [
      { href: '/docs/configuration', label: 'gio.toml Configuration' },
      { href: '/docs/cli', label: 'CLI' },
      { href: '/docs/components', label: 'Components' },
      { href: '/docs/functions', label: 'Functions' },
      { href: '/docs/file-conventions', label: 'File Conventions' },
    ],
  },
  {
    title: 'Deployment',
    items: [
      { href: '/docs/deployment', label: 'Deploying' },
      { href: '/docs/static-export', label: 'Static Export' },
      { href: '/docs/adapters', label: 'Adapters' },
      { href: '/docs/observability', label: 'Observability' },
    ],
  },
  {
    title: 'Resources',
    items: [
      { href: '/docs/migration', label: 'Migrating from Next.js' },
      { href: '/docs/benchmarks', label: 'Benchmarks' },
      { href: '/docs/examples', label: 'Examples' },
      { href: '/docs/known-issues', label: 'Known Issues' },
      { href: '/docs/contributing', label: 'Contributing' },
    ],
  },
];

interface SidebarProps {
  currentPath: string;
}

export function Sidebar({ currentPath }: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar" id="sidebar">
      <nav className="sidebar-nav" aria-label="Documentation">
        {NAV_GROUPS.map(group => (
          <div className="sidebar-group" key={group.title}>
            <div className="sidebar-group-title">{group.title}</div>
            {group.items.map(item => (
              <a
                key={item.href}
                href={item.href}
                className="sidebar-link"
                aria-current={currentPath === item.href ? 'page' : undefined}
              >
                {item.label}
              </a>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
