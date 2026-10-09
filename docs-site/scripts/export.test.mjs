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

test('names lead to the section that defines them in the real index', { skip }, () => {
  const search = createSearch(index);
  const expected = {
    // gio.toml keys: their section page's key table, not the version history.
    skew_protection: '/docs/configuration/server#reference',
    max_keys_per_client: '/docs/configuration/rate-limits#reference',
    swr_multiplier: '/docs/configuration/cache#reference',
    allowed_hosts: '/docs/configuration/dev#reference',
    // ...and in the spelling typed: `proxyHeaders` is a report field, `defaultLocale` a prop.
    proxy_headers: '/docs/configuration/server#reference',
    default_locale: '/docs/configuration/i18n#reference',
    proxyHeaders: '/docs/cli/giojs-server#report',
    defaultLocale: '/docs/components/locale-link#reference',
    // A plain-word key: its page at the key table, not the version history.
    details: '/docs/configuration/health#reference',
    minify: '/docs/configuration/css#reference',
    watch: '/docs/configuration/dev#reference',
    'server.idle_timeout_secs': '/docs/configuration/server#reference',
    '[security.headers]': '/docs/configuration/security#reference',
    '[[fonts]]': '/docs/configuration/fonts',
    GioNodePlugin: '/docs/gio-config#gionodeplugin',
    // A command's own page, not the CLI overview.
    typegen: '/docs/cli/typegen',
    doctor: '/docs/cli/doctor',
    'router.refresh': '/docs/hooks/use-router#refresh',
    // Page exports.
    getServerSideProps: '/docs/page-exports/get-server-side-props',
    generateMetadata: '/docs/page-exports/generate-metadata',
    getStaticPaths: '/docs/page-exports/get-static-paths',
    metadata: '/docs/page-exports/metadata',
    revalidate: '/docs/page-exports/revalidate',
    shell: '/docs/page-exports/shell',
    tags: '/docs/page-exports/tags',
    action: '/docs/page-exports/action',
    wsHandler: '/docs/page-exports/ws-handler',
    POST: '/docs/page-exports/http-methods',
    // A CLI flag row defines the flag, not the bare word.
    'json()': '/docs/page-exports/http-methods#parameters',
    json: '/docs/page-exports/http-methods#parameters',
    static: '/docs/static-export',
    '--static': '/docs/create-giojs#reference',
  };
  for (const [query, url] of Object.entries(expected)) {
    assert.equal(search.search(query).pages[0]?.items[0].url, url, query);
  }
});

test('everyday words, plurals, URLs and pasted text find the right page in the real index', { skip }, () => {
  const search = createSearch(index);
  const expected = {
    // Another inflection of the title, or the page's URL.
    upgrade: ['/docs/upgrading'],
    'upgrade guide': ['/docs/upgrading'],
    'env vars': ['/docs/env-vars'],
    cookies: ['/docs/functions/cookies'],
    sessions: ['/docs/functions/create-session-storage'],
    'rate limiting': ['/docs/configuration/rate-limits'],
    // A gio.toml section named among other words.
    'disable rate limit': ['/docs/configuration/rate-limits', '/docs/guides/security-switches'],
    'disable csrf': ['/docs/configuration/security-csrf', '/docs/guides/security-switches'],
    isr: ['/docs/page-exports/revalidate', '/docs/caching', '/docs/configuration/revalidate'],
    // A header or a path quoted in reference code is not that page's API.
    'x-frame-options': ['/docs/headers'],
    'POST /_gio/revalidate': ['/docs/endpoints'],
    // Pasted errors.
    'gio.toml:5: unknown key': ['/docs/configuration'],
    'Unexpected token in JSON': ['/docs/functions/request-errors'],
  };
  for (const [query, urls] of Object.entries(expected)) {
    const first = search.search(query).pages[0]?.url;
    assert.ok(urls.includes(first), `${query}: first result is ${first}`);
  }
  // A version history only mentions a word: never the first section to open.
  for (const query of ['rate limiting', 'skew', 'details', 'csrf', 'x-frame-options']) {
    for (const [rank, page] of search.search(query).pages.slice(0, 2).entries()) {
      assert.ok(!page.items[0].url.endsWith('#version-history'), `${query}: #${rank + 1} is ${page.items[0].url}`);
    }
  }
  // A status code is no API name: reference code quoting it gets no bonus.
  assert.ok(search.search('429').pages.every((page) => page.score < 30));
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
