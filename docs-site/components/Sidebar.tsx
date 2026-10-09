/**
 * docs-site/components/Sidebar.tsx
 *
 * The docs sidebar, rendered from the nav data (components/nav/): the four
 * top-level sections, each with its collapsible groups. Groups are
 * <details> elements, so they open and close without JavaScript; the one
 * holding the current page renders open, and its link is marked
 * aria-current="page" server-side. Plain anchors (full-page navigation).
 * Once hydrated, the active link is scrolled into view inside the sidebar.
 */
import React, { useEffect } from 'react';
import { NAV, type NavItem } from './nav/index.ts';

interface SidebarProps {
  currentPath: string;
}

function NavLink({ item, currentPath }: { item: NavItem; currentPath: string }): React.JSX.Element {
  return (
    <li>
      <a
        href={item.href}
        className="sidebar-link"
        aria-current={currentPath === item.href ? 'page' : undefined}
      >
        {item.label}
      </a>
    </li>
  );
}

export function Sidebar({ currentPath }: SidebarProps): React.JSX.Element {
  useEffect(() => {
    // Bring the current page's link into view within the sidebar's own
    // scroll box - never scroll the page itself.
    const sidebar = document.getElementById('sidebar');
    const active = sidebar?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!sidebar || !active) return;
    const box = sidebar.getBoundingClientRect();
    const link = active.getBoundingClientRect();
    if (link.top < box.top || link.bottom > box.bottom) {
      sidebar.scrollTop += link.top - box.top - box.height / 3;
    }
  }, [currentPath]);

  return (
    <aside className="sidebar" id="sidebar">
      {/* Shown only in the mobile drawer (hidden on desktop via CSS). */}
      <div className="sidebar-drawer-head">
        <span className="sidebar-drawer-title">Documentation</span>
      </div>
      <nav className="sidebar-nav" aria-label="Documentation">
        {NAV.map((section) => (
          <div className="sidebar-section" key={section.title}>
            <div className="sidebar-section-title">{section.title}</div>
            {section.groups.map((group, i) => {
              const links = (
                <ul className="sidebar-list">
                  {group.items.map((item) => <NavLink key={item.href} item={item} currentPath={currentPath} />)}
                </ul>
              );
              if (group.title === undefined) return <React.Fragment key={i}>{links}</React.Fragment>;
              const active = group.items.some((item) => item.href === currentPath);
              return (
                <details className="sidebar-group" key={group.title} open={active}>
                  <summary className="sidebar-group-title">{group.title}</summary>
                  {links}
                </details>
              );
            })}
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
