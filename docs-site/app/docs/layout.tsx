/**
 * docs-site/app/docs/layout.tsx
 *
 * Docs chrome - sticky header (search, theme, links), the sidebar, and the
 * page column: breadcrumbs and "Copy page" above the content, the edit
 * link and the prev/next pager below it, and the "On this page" outline
 * in a right-hand rail (inline above the content on narrow screens).
 * Receives `path` from giojs-core; everything positional (active link,
 * breadcrumbs, pager, default title) derives from it and the nav data
 * (components/nav/), so pages hold only their content.
 *
 * This layout hydrates and ships in every route's bundle: keep it light.
 * The search engine and index load on first use (DocsSearch).
 */
import React from 'react';
import type { Metadata, MetadataContext } from '@gio.js/core';
import { Sidebar } from '../../components/Sidebar.tsx';
import { MobileNav } from '../../components/MobileNav.tsx';
import { DocsSearch } from '../../components/DocsSearch.tsx';
import { ThemeToggle } from '../../components/ThemeToggle.tsx';
import { OnThisPage } from '../../components/OnThisPage.tsx';
import { CopyPageButton } from '../../components/CopyPageButton.tsx';
import { Breadcrumbs, PageFooter } from '../../components/PageNav.tsx';
import { locatePage, pageName } from '../../components/nav/index.ts';
import { SITE_OPEN_GRAPH } from '../../components/site-metadata.ts';

interface DocsLayoutProps {
  children: React.ReactNode;
  path?: string;
}

/**
 * Per-page head defaults: the nav name as the title (templated by the root
 * layout, '%s | GioJS Docs'; a page's own `metadata.title` wins), and the
 * page's canonical URL.
 */
export function generateMetadata(ctx: MetadataContext): Metadata {
  const location = locatePage(ctx.path);
  const title = location === undefined ? undefined : pageName(location);
  return {
    ...(title !== undefined ? { title } : {}),
    alternates: { canonical: ctx.path },
    openGraph: { ...SITE_OPEN_GRAPH, url: ctx.path, ...(title !== undefined ? { title: `${title} | GioJS Docs` } : {}) },
  };
}

export default function DocsLayout({ children, path = '/' }: DocsLayoutProps): React.JSX.Element {
  return (
    <>
      <header className="docs-header">
        <button
          id="mobile-nav-toggle"
          className="docs-menu-btn"
          aria-label="Open navigation"
          aria-expanded="false"
          aria-controls="sidebar"
          type="button"
        >
          <span className="docs-menu-btn__bars" aria-hidden="true" />
        </button>
        <a className="docs-brand" href="/docs">
          <img className="docs-brand__mark" src="/public/giojs-logo.svg" alt="" width={26} height={26} />
          GioJS
          <span className="docs-brand__tag">docs</span>
        </a>
        <div className="docs-header__search">
          <DocsSearch />
        </div>
        <div className="docs-header__right">
          <a className="docs-header__link" href="/releases">Releases</a>
          <a className="docs-header__link" href="https://github.com/Ggaming5005/GioJS">GitHub ↗</a>
          <ThemeToggle />
        </div>
      </header>

      <MobileNav />

      <div className="docs-body">
        <Sidebar currentPath={path} />
        <main className="docs-main">
          <div className="docs-page">
            <div className="docs-column">
              <div className="docs-topbar">
                <Breadcrumbs path={path} />
                <CopyPageButton path={path} />
              </div>
              <OnThisPage variant="inline" path={path} />
              <article className="docs-prose">{children}</article>
              <PageFooter path={path} />
            </div>
            <aside className="docs-rail">
              <OnThisPage variant="rail" path={path} />
            </aside>
          </div>
        </main>
      </div>
    </>
  );
}
