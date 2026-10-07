/**
 * docs-site/app/search-index.json/route.ts
 *
 * The search index in development. The static build writes
 * out/search-index.json from the exported HTML (build.mjs) and skips this
 * route handler; under `gio dev` the search dialog fetches the same URL and
 * gets this instead: every page in the nav rendered on demand and indexed
 * by the same code (lib/search-index.mjs), so search follows edits
 * without a rebuild. Pages are rendered bare (no layout), inside the
 * <article class="docs-prose"> the docs layout puts them in.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flattenNav, searchPlace } from '../../components/nav/index.ts';
import { buildSearchIndex } from '../../lib/search-index.mjs';

/** What a page renders with when nothing in the URL fills it. */
interface PageProps {
  params: Record<string, string>;
  searchParams: Record<string, string>;
}

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Served by `gio start`, pages do not change: build the index once. */
let built: string | undefined;

export async function GET(): Promise<Response> {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (built !== undefined) return new Response(built, { headers });
  const routes = ['/docs', ...flattenNav().map((entry) => entry.item.href), '/releases'];
  const pages: { route: string; html: string }[] = [];
  for (const route of routes) {
    const file = join(appDir, ...route.split('/').filter(Boolean), 'page.tsx');
    if (!existsSync(file)) continue;
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default: React.ComponentType<PageProps> };
      const page = React.createElement(mod.default, { params: {}, searchParams: {} });
      const html = renderToStaticMarkup(React.createElement('article', { className: 'docs-prose' }, page));
      pages.push({ route, html });
    } catch (error) {
      // One page that needs request data must not take search down with it.
      console.warn(`[search-index] skipped ${route}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const body = JSON.stringify(buildSearchIndex(pages, searchPlace));
  if (process.env.NODE_ENV === 'production') built = body;
  return new Response(body, { headers });
}
