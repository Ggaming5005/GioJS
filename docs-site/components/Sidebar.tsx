/**
 * docs-site/components/Sidebar.tsx
 *
 * Sticky sidebar navigation. Receives the current path as a prop so the
 * active link can be marked server-side with aria-current="page".
 */
import React from 'react';
import { GioLink } from 'giojs/react';

interface NavItem {
  href: string;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/docs/getting-started', label: 'Getting Started' },
  { href: '/docs/migration', label: 'Migration Guide' },
  { href: '/docs/configuration', label: 'Configuration' },
  { href: '/docs/deployment', label: 'Deployment' },
  { href: '/docs/benchmarks', label: 'Benchmarks' },
  { href: '/docs/api', label: 'API Reference' },
  { href: '/docs/examples', label: 'Examples' },
  { href: '/docs/known-issues', label: 'Known Issues' },
];

interface SidebarProps {
  currentPath: string;
}

export function Sidebar({ currentPath }: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        Gio<span>JS</span>
      </div>
      <nav className="sidebar-nav" aria-label="Documentation">
        <div className="sidebar-section">Documentation</div>
        {NAV_ITEMS.map(item => (
          <GioLink
            key={item.href}
            href={item.href}
            className="sidebar-link"
            aria-current={currentPath === item.href ? 'page' : undefined}
          >
            {item.label}
          </GioLink>
        ))}
      </nav>
    </aside>
  );
}
