/**
 * docs-site/components/PageNav.tsx
 *
 * Where a docs page sits, derived from the nav (components/nav/) so pages
 * never write it by hand: breadcrumbs (section › group › page) above the
 * content, and the previous/next pager in reading order below it, with
 * the "Edit this page on GitHub" link. Server-rendered plain links.
 */
import React from 'react';
import { locatePage, pageName } from './nav/index.ts';

const EDIT_BASE = 'https://github.com/Ggaming5005/GioJS/edit/main/docs-site/app';

/** The page.tsx that renders `path`, as a GitHub edit URL. */
export function editUrl(path: string): string {
  return `${EDIT_BASE}${path === '/' ? '' : path}/page.tsx`;
}

export function Breadcrumbs({ path }: { path: string }): React.JSX.Element | null {
  const location = locatePage(path);
  if (location === undefined) return null;
  const trail = [location.section.title];
  if (location.group?.title !== undefined) trail.push(location.group.title);
  const name = pageName(location);
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        <li><a href="/docs">Docs</a></li>
        {trail.map((crumb) => <li key={crumb}>{crumb}</li>)}
        {name !== trail[trail.length - 1] && <li aria-current="page">{name}</li>}
      </ol>
    </nav>
  );
}

export function PageFooter({ path }: { path: string }): React.JSX.Element {
  const location = locatePage(path);
  const prev = location?.prev;
  const next = location?.next;
  return (
    <footer className="page-footer">
      <a className="page-footer__edit" href={editUrl(path)}>
        Edit this page on GitHub
      </a>
      {(prev !== undefined || next !== undefined) && (
        <nav className="docs-pager" aria-label="Previous and next page">
          {prev !== undefined ? (
            <a className="prev" href={prev.href} rel="prev">
              <span className="dir">Previous</span>
              <span className="label">← {prev.label}</span>
            </a>
          ) : <span />}
          {next !== undefined && (
            <a className="next" href={next.href} rel="next">
              <span className="dir">Next</span>
              <span className="label">{next.label} →</span>
            </a>
          )}
        </nav>
      )}
    </footer>
  );
}
