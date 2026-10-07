/**
 * docs-site/components/Sidebar.tsx
 *
 * Grouped sidebar navigation. Receives the current path so the active link is
 * marked server-side with aria-current="page". Plain anchors keep it robust
 * (full-page nav) - no client runtime needed for docs.
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
      { href: '/docs/guides/environment-variables', label: 'Environment Variables' },
      { href: '/docs/examples', label: 'Examples' },
    ],
  },
  {
    title: 'Routing',
    items: [
      { href: '/docs/layouts-and-pages', label: 'Layouts & Pages' },
      { href: '/docs/linking-and-navigating', label: 'Linking & Navigating' },
      { href: '/docs/error-handling', label: 'Error Handling' },
      { href: '/docs/route-handlers', label: 'Route Handlers' },
      { href: '/docs/middleware', label: 'Middleware' },
      { href: '/docs/i18n', label: 'Internationalization' },
    ],
  },
  {
    title: 'Data',
    items: [
      { href: '/docs/fetching-data', label: 'Fetching Data' },
      { href: '/docs/forms', label: 'Forms & Mutations' },
    ],
  },
  {
    title: 'Rendering & Caching',
    items: [
      { href: '/docs/caching', label: 'Caching & Revalidating' },
      { href: '/docs/caching-layers', label: 'Caching Layers' },
      { href: '/docs/metadata', label: 'Metadata & SEO' },
      { href: '/docs/static-export', label: 'Static Export' },
    ],
  },
  {
    title: 'Styling & Assets',
    items: [
      { href: '/docs/css', label: 'CSS & Styling' },
      { href: '/docs/image-optimization', label: 'Image Optimization' },
      { href: '/docs/font-optimization', label: 'Font Optimization' },
    ],
  },
  {
    title: 'Security & Auth',
    items: [
      { href: '/docs/security', label: 'Security' },
      { href: '/docs/authentication', label: 'Authentication & Sessions' },
    ],
  },
  {
    title: 'Realtime',
    items: [
      { href: '/docs/websockets', label: 'WebSockets' },
    ],
  },
  {
    title: 'Deployment & Operations',
    items: [
      { href: '/docs/guides/deploying', label: 'Deploying' },
      { href: '/docs/guides/production-checklist', label: 'Production Checklist' },
      { href: '/docs/deployment', label: 'Proxies, Sizing & Scaling' },
      { href: '/docs/standalone', label: 'Standalone Deploys' },
      { href: '/docs/adapters', label: 'Adapters' },
      { href: '/docs/observability', label: 'Observability' },
    ],
  },
  {
    title: 'Testing',
    items: [
      { href: '/docs/testing', label: 'Testing' },
    ],
  },
  {
    title: 'Reference',
    items: [
      { href: '/docs/configuration', label: 'gio.toml Configuration' },
      { href: '/docs/cli', label: 'CLI' },
      { href: '/docs/components', label: 'Components' },
      { href: '/docs/functions', label: 'Functions' },
      { href: '/docs/file-conventions', label: 'File Conventions' },
      { href: '/docs/architecture', label: 'How GioJS Works' },
      { href: '/docs/boundary', label: 'The Rust ⇄ Node Boundary' },
    ],
  },
  {
    title: 'Migration',
    items: [
      { href: '/docs/migration', label: 'Migrating from Next.js' },
    ],
  },
  {
    title: 'Resources',
    items: [
      { href: '/docs/known-issues', label: 'Known Limitations' },
      { href: '/docs/benchmarks', label: 'Benchmarks' },
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
      {/* Shown only in the mobile drawer (hidden on desktop via CSS). */}
      <div className="sidebar-drawer-head">
        <span className="sidebar-drawer-title">Documentation</span>
      </div>
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
        {/* Drawer footer — surfaces the links dropped from the mobile header. */}
        <div className="sidebar-drawer-foot">
          <a href="/releases" className="sidebar-link">Releases</a>
          <a href="https://github.com/Ggaming5005/GioJS" className="sidebar-link">GitHub ↗</a>
        </div>
      </nav>
    </aside>
  );
}
