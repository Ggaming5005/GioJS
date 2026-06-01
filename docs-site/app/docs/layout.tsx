/**
 * docs-site/app/docs/layout.tsx
 *
 * Docs section layout — sticky sidebar + main content area.
 * Receives path from giojs-core so Sidebar can mark the active link.
 */
import React from 'react';
import { Sidebar } from '../../components/Sidebar.tsx';
import { MobileNav } from '../../components/MobileNav.tsx';

interface DocsLayoutProps {
  children: React.ReactNode;
  path?: string;
}

export default function DocsLayout({ children, path = '/' }: DocsLayoutProps): React.JSX.Element {
  return (
    <div className="docs-layout">
      <MobileNav />
      <Sidebar currentPath={path} />
      <main className="docs-main">
        {children}
      </main>
    </div>
  );
}
