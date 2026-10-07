/**
 * docs-site/scripts/export.test.mjs
 *
 * Tests on the exported site in out/ - what readers and crawlers actually
 * get: every search result lands on an id that exists, exact API names
 * rank first in the real index, every docs page's share card names that
 * page, and the server HTML carries no empty chrome. Skipped until
 * `npm run export` has run (CI exports before it tests).
 * Run: `npm test` in docs-site/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeEntities } from '../lib/text.mjs';
import { createSearch } from '../lib/search.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const indexFile = join(outDir, 'search-index.json');
const skip = existsSync(indexFile) ? false : 'out/ not built - run `npm run export` first';

const index = skip ? null : JSON.parse(readFileSync(indexFile, 'utf8'));
const htmlCache = new Map();
/** The exported HTML of `route`. */
function pageHtml(route) {
  if (!htmlCache.has(route)) {
    htmlCache.set(route, readFileSync(join(outDir, ...route.slice(1).split('/'), 'index.html'), 'utf8'));
  }
  return htmlCache.get(route);
}
const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => decodeEntities(m[1])));
/** `<meta {key}="{name}" content="...">` of a page's head, decoded. */
function metaContent(html, key, name) {
  const tag = new RegExp(`<meta ${key}="${name.replace(/[.:]/g, '\\$&')}" content="([^"]*)"`).exec(html);
  return tag === null ? undefined : decodeEntities(tag[1]);
}
const docsRoutes = () => index.pages.map((page) => page.u).filter((u) => u.startsWith('/docs'));

test('every search result anchor is an id on its page, /releases included', { skip }, () => {
  const missing = [];
  for (const section of index.sections) {
    if (section.a === '') continue;
    const route = index.pages[section.p].u;
    if (!ids(pageHtml(route)).has(section.a)) missing.push(`${route}#${section.a}`);
  }
  assert.deepEqual(missing, []);
  assert.ok(index.sections.some((s) => index.pages[s.p].u === '/releases' && s.a !== ''));
});

test('exact API names lead with the API reference in the real index', { skip }, () => {
  const search = createSearch(index);
  for (const name of ['useRouter', 'usePathname', 'redirect', 'revalidatePath', 'GioLink', 'broadcast']) {
    const first = search.search(name).pages[0];
    assert.ok(first !== undefined, `${name}: no result`);
    assert.equal(first.section, 'API Reference', `${name}: first result is ${first.url}`);
  }
});

test('a docs page\'s share card carries its own title and description', { skip }, () => {
  for (const route of docsRoutes()) {
    const html = pageHtml(route);
    const title = decodeEntities(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '');
    const description = metaContent(html, 'name', 'description');
    assert.ok(title.endsWith(' | GioJS Docs'), `${route}: <title>${title}</title>`);
    assert.equal(metaContent(html, 'property', 'og:title'), title, route);
    assert.equal(metaContent(html, 'property', 'og:description'), description, route);
    // No site-wide strings left for X to prefer over the page's.
    assert.equal(metaContent(html, 'name', 'twitter:title'), undefined, route);
    assert.equal(metaContent(html, 'name', 'twitter:description'), undefined, route);
  }
});

test('the server HTML has no empty "On this page" rail, and PmTabs ids pair up', { skip }, () => {
  for (const route of docsRoutes()) {
    const html = pageHtml(route);
    // The rail fills in after hydration; before it (or without JS) its column is empty.
    assert.doesNotMatch(html, /class="toc-rail"/, route);
    const present = ids(html);
    for (const [, attr, id] of html.matchAll(/\s(aria-controls|aria-labelledby)="([^"]+)"/g)) {
      if (attr === 'aria-controls' && id === 'sidebar') continue;
      assert.ok(present.has(decodeEntities(id)), `${route}: ${attr}="${id}" names no element`);
    }
  }
});
