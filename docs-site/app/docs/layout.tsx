/**
 * docs-site/app/docs/layout.tsx
 *
 * Docs chrome — sticky header + grouped sidebar + readable content column.
 * Receives `path` from giojs-core so the Sidebar can mark the active link.
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
    <>
      <header className="docs-header">
        <a className="docs-brand" href="/docs/getting-started">
          <img className="docs-brand__mark" src="/public/giojs-logo.svg" alt="" width={26} height={26} />
          GioJS
          <span className="docs-brand__tag">docs</span>
        </a>
        <div className="docs-header__right">
          <a className="docs-header__link" href="/docs/getting-started">Get Started</a>
          <a className="docs-header__link" href="/releases">Releases</a>
          <a className="docs-header__link" href="https://github.com/Ggaming5005/GioJS">GitHub ↗</a>
        </div>
      </header>

      <MobileNav />

      <div className="docs-body">
        <Sidebar currentPath={path} />
        <main className="docs-main">
          <article className="docs-prose">{children}</article>
        </main>
      </div>
    </>
  );
}
