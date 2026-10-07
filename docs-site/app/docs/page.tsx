/**
 * docs-site/app/docs/page.tsx
 *
 * /docs - the documentation home: a search box (it opens the search
 * dialog) and a card per top-level section of the nav, listing where each
 * starts. Everything here is derived from components/nav/.
 */
import React from 'react';
import type { Metadata } from '@gio.js/core';
import { NAV, firstPageOf } from '../../components/nav/index.ts';

export const metadata: Metadata = {
  title: 'Documentation',
  description:
    'GioJS documentation: getting started, guides, the full API reference (components, hooks, ' +
    'functions, file conventions, gio.toml, CLI) and architecture.',
};

export const revalidate = false;

/** The pages a section card lists: its first few, across its groups. */
function highlights(section: (typeof NAV)[number], count = 5): { href: string; label: string }[] {
  return section.groups
    .flatMap((group) =>
      group.items.map((item) => ({
        href: item.href,
        label: item.label === 'Overview' && group.title !== undefined ? group.title : item.label,
      })))
    .filter((item, i, all) => all.findIndex((other) => other.label === item.label) === i)
    .slice(0, count);
}

export default function DocsHome(): React.JSX.Element {
  return (
    <>
      <h1>GioJS Documentation</h1>
      <p className="page-subtitle">
        GioJS is a React framework whose server is written in Rust: routing, caching, compression,
        images and security run in a compiled binary, and a Node worker renders your React.
        Start with the learning path, look something up in the API reference, or search.
      </p>

      <button type="button" className="docs-home-search needs-js" data-docs-search="">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span>Search the docs - pages, APIs, gio.toml keys…</span>
        <kbd>/</kbd>
      </button>

      <div className="docs-home-grid">
        {NAV.map((section) => {
          const first = firstPageOf(section);
          return (
            <section className="docs-home-card" key={section.title}>
              <h2 id={section.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}>
                {first !== undefined ? <a href={first.href}>{section.title}</a> : section.title}
              </h2>
              <p>{section.description}</p>
              <ul>
                {highlights(section).map((item) => (
                  <li key={item.href}><a href={item.href}>{item.label}</a></li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
