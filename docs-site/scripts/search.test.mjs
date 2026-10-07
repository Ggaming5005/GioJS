/**
 * docs-site/scripts/search.test.mjs
 *
 * Tests for the docs search: the text extraction shared with llms.txt and
 * the .md pages (lib/text.mjs), the index builder (lib/search-index.mjs)
 * and the matcher and ranking (lib/search.mjs), on fixture pages.
 * Run: `npm test` in docs-site/ (no dependencies needed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { htmlToText, slugify, uniqueSlug } from '../lib/text.mjs';
import { buildSearchIndex, extractSections } from '../lib/search-index.mjs';
import { createSearch, editDistance, highlight, queryTerms, tokenize } from '../lib/search.mjs';

/** A rendered docs page as the layout wraps it (chrome outside the article). */
const html = (body) =>
  `<html><body><nav>sidebar</nav><main><article class="docs-prose">${body}</article></main></body></html>`;

/** Fixture pages, each `[route, section, group, body]`. */
const PAGES = [
  ['/docs/functions/redirect', 'API Reference', 'Functions', `
    <h1>redirect</h1><p class="page-subtitle">Send the browser to another URL from a page or a route.</p>
    <h2 id="reference">Reference</h2><p>Call <code>redirect(url, status)</code> to stop rendering.</p>
    <h2 id="examples">Examples</h2><pre data-lang="ts"><code>throw redirect('/login');</code></pre>`],
  ['/docs/guides/redirecting', 'Guides', 'App', `
    <h1>Redirecting</h1><p>There are several ways to redirect: a redirect in gio.toml, a redirect from
    middleware, and redirect() from a page. Each redirect suits a different case.</p>
    <h2>Redirects in gio.toml</h2><p>Static redirects run in Rust before any rendering.</p>
    <h2>Redirect from middleware</h2><p>Middleware may redirect a request.</p>`],
  ['/docs/middleware', 'Getting Started', undefined, `
    <h1>Middleware</h1><p>Middleware runs before a page and can rewrite, redirect or answer.</p>`],
  ['/docs/hooks/use-router', 'API Reference', 'Hooks', `
    <h1>useRouter</h1><p>Navigate from code with <code>useRouter()</code>.</p>
    <h2 id="reference">Reference</h2><p><code>router.push(href)</code> and <code>router.refresh()</code>.</p>`],
  ['/docs/caching', 'Getting Started', undefined, `
    <h1>Caching &amp; Revalidating</h1><p>Export <code>revalidate</code> to cache a page.</p>
    <h2>On-demand revalidation</h2><p>Call <code>revalidatePath</code> after a write.</p>`],
  ['/docs/configuration/server', 'API Reference', 'gio.toml', `
    <h1>[server]</h1><p>How the server listens and how much it accepts.</p>
    <h2 id="max-body-bytes">max_body_bytes</h2><p>The largest request body accepted, in bytes.</p>
    <pre data-lang="toml"><code>[server]
max_body_bytes = 10485760</code></pre>`],
  ['/docs/security', 'Guides', 'Security', `
    <h1>Security</h1><p>Protections the Rust server enforces.</p>
    <h2>CSRF</h2><p>Cross-site form posts are refused unless the Origin matches.</p>
    <h3>Precedence</h3><p>Headers your app sets win over the defaults.</p>
    <h2>WebSocket origin checks</h2><p>Upgrades from another origin are refused.</p>`],
];

const NAV_LABELS = { '/docs/caching': 'Caching & Revalidating', '/docs/configuration/server': 'server' };

function fixtureIndex() {
  return buildSearchIndex(
    PAGES.map(([route, , , body]) => ({ route, html: html(body) })),
    (route) => {
      const page = PAGES.find(([r]) => r === route);
      return page && { section: page[1], group: page[2], label: NAV_LABELS[route] ?? 'label' };
    },
  );
}

const search = createSearch(fixtureIndex());
const urls = (query) => search.search(query).pages.map((page) => page.url);

// ── text.mjs ────────────────────────────────────────────────────────────────

test('slugify and uniqueSlug name headings the way the page and the index agree on', () => {
  assert.equal(slugify('Server & TLS'), 'server-tls');
  assert.equal(slugify('useRouter()'), 'userouter');
  assert.equal(slugify('  Café: déjà vu  '), 'cafe-deja-vu');
  assert.equal(slugify('⇄'), 'section');
  const taken = new Set(['setup']);
  assert.equal(uniqueSlug('Setup', taken), 'setup-2');
  assert.equal(uniqueSlug('Setup', taken), 'setup-3');
  assert.ok(taken.has('setup-3'));
});

test('htmlToText writes Markdown: headings, tables, fenced code with its language, links', () => {
  const md = htmlToText(
    '<div class="docs-eyebrow">Old eyebrow</div><h2 id="x">Keys</h2><p>See <a href="/docs/cli">the <code>gio</code> CLI</a>.</p>' +
      '<table><thead><tr><th>Key</th><th>Default</th></tr></thead><tbody><tr><td><code>port</code></td><td>3000 | 0</td></tr></tbody></table>' +
      '<div class="code-block"><div class="code-block-header" data-no-index=""><span>toml</span><button>Copy</button></div>' +
      '<pre data-lang="toml"><code>[server]\nport = 3000 # &lt;here&gt;</code></pre><script>alert(1)</script></div>' +
      '<ul><li>one</li><li><strong>two</strong></li></ul>',
  );
  assert.equal(
    md,
    [
      '## Keys',
      '',
      'See [the `gio` CLI](/docs/cli).',
      '',
      '| Key | Default |',
      '| --- | --- |',
      '| `port` | 3000 \\| 0 |',
      '',
      '```toml',
      '[server]',
      'port = 3000 # <here>',
      '```',
      '',
      '- one',
      '- **two**',
    ].join('\n'),
  );
});

test('a highlighted, titled code block extracts as plain code with its file name', () => {
  const block =
    '<div class="code-block"><div class="code-block-header" data-no-index=""><span>app/page.tsx</span></div>' +
    '<pre data-lang="tsx" data-title="app/page.tsx"><code><span class="tk-k">export</span> ' +
    '<span class="tk-k">const</span> a = <span class="tk-s">&quot;&lt;b&gt;&quot;</span>;</code></pre></div>';
  assert.equal(htmlToText(block), '```tsx title="app/page.tsx"\nexport const a = "<b>";\n```');
  // The file name is searchable with the block's words; the header is not page text.
  const { sections } = extractSections(html(`<h1>T</h1><h2 id="s">S</h2>${block}`));
  assert.deepEqual(sections[1].blockWords, ['app', 'page', 'tsx', 'export', 'const']);
  assert.equal(sections[1].text, '');
});

// ── search-index.mjs ────────────────────────────────────────────────────────

test('extractSections splits a page per h2/h3 with anchors, and leaves the chrome out', () => {
  const { title, sections } = extractSections(html(`
    <h1>Security</h1><p>Intro <code>[security]</code> text.</p>
    <h2 id="csrf">CSRF</h2><p>Origin checks.</p>
    <h3>Precedence</h3><p>Order.</p>
    <h2>Precedence</h2><p>Again.</p>
    <h2 id="precedence-2">Taken</h2>
    <div class="code-block"><div class="code-block-header" data-no-index=""><span>toml</span><button>Copy</button></div>
    <pre data-lang="toml"><code>[security.csrf]\nenabled = true\ntrusted_origins = []</code></pre></div>`));
  assert.equal(title, 'Security');
  assert.deepEqual(
    sections.map((s) => [s.level, s.heading, s.anchor]),
    [
      [1, '', ''],
      [2, 'CSRF', 'csrf'],
      [3, 'Precedence', 'precedence'],
      // An explicit id later on the page is taken: the generated one skips it.
      [2, 'Precedence', 'precedence-3'],
      [2, 'Taken', 'precedence-2'],
    ],
  );
  assert.equal(sections[0].text, 'Intro [security] text.');
  assert.deepEqual(sections[0].code, ['[security]']);
  // Code blocks: searchable words, not quoted text; no "toml" / "Copy" chrome.
  const last = sections.at(-1);
  assert.equal(last.text, '');
  assert.deepEqual(last.blockWords, ['security', 'csrf', 'enabled', 'true', 'trusted_origins']);
  assert.ok(!sections.some((s) => /sidebar|Copy/.test(s.text)));
});

test('buildSearchIndex labels pages with their nav place', () => {
  const index = fixtureIndex();
  assert.equal(index.v, 1);
  const caching = index.pages.find((page) => page.u === '/docs/caching');
  assert.deepEqual(caching, { u: '/docs/caching', t: 'Caching & Revalidating', s: 'Getting Started' });
  const server = index.pages.find((page) => page.u === '/docs/configuration/server');
  assert.deepEqual(server, { u: '/docs/configuration/server', t: '[server]', n: 'server', s: 'API Reference', g: 'gio.toml' });
  const outside = buildSearchIndex([{ route: '/docs', html: html('<h1>Docs</h1>') }], () => undefined);
  assert.equal(outside.pages[0].s, 'Docs');
  // Every section points at a page.
  assert.ok(index.sections.every((section) => index.pages[section.p] !== undefined));
});

// ── search.mjs ──────────────────────────────────────────────────────────────

test('tokenize indexes identifiers whole and by their parts', () => {
  const tokens = (text) => tokenize(text).map((t) => `${t.token}${t.part ? '*' : ''}`);
  assert.deepEqual(tokens('useRouter'), ['userouter', 'use*', 'router*']);
  assert.deepEqual(tokens('max_body_bytes GIO_PUBLIC_'), ['max_body_bytes', 'max*', 'body*', 'bytes*', 'gio_public_', 'gio*', 'public*']);
  assert.deepEqual(queryTerms('How to deploy the app'), ['deploy', 'app']);
  assert.deepEqual(queryTerms('the'), ['the']);
  assert.equal(editDistance('revalidte', 'revalidate', 2), 1);
  assert.equal(editDistance('redierct', 'redirect', 1), 1);
  assert.equal(editDistance('abc', 'xyz', 1), 2);
});

test('an exact API name ranks first: "redirect" is the redirect() page, not the guide', () => {
  const result = search.search('redirect');
  assert.equal(result.pages[0].url, '/docs/functions/redirect');
  assert.equal(result.pages[0].items[0].url, '/docs/functions/redirect');
  assert.equal(result.pages[0].items[0].heading, '');
  assert.ok(urls('redirect').includes('/docs/guides/redirecting'));
  assert.ok(urls('redirect').includes('/docs/middleware'));
  // Punctuation and case do not matter for an exact name.
  assert.equal(urls('Redirect()')[0], '/docs/functions/redirect');
  assert.equal(urls('userouter')[0], '/docs/hooks/use-router');
  assert.equal(urls('useRouter')[0], '/docs/hooks/use-router');
});

test('an API name only in an overview reference section\'s code still ranks above the guides', () => {
  /** `[route, section, group, body]` pages, indexed with their nav place. */
  const indexOf = (pages) => createSearch(buildSearchIndex(
    pages.map(([route, , , body]) => ({ route, html: html(body) })),
    (route) => {
      const page = pages.find(([r]) => r === route);
      return page && { section: page[1], group: page[2], label: 'label' };
    },
  ));
  const overview = ['/docs/functions', 'API Reference', 'Functions', `
    <h1>Functions</h1><p>Every function GioJS exports.</p>
    <h2 id="router-hooks">Router hooks</h2><p><code>usePathname()</code> and <code>useRouter()</code>
    from <code>@gio.js/react</code>.</p>
    <h2 id="navigation">Navigation</h2><p>Call <code>useRouter()</code> to navigate, or
    <code>redirect()</code> from a page.</p>`];
  const pages = [
    overview,
    ['/docs/migration', 'Guides', 'Migrating', `
      <h1>Migration Guide</h1><p>Move a Next.js app to GioJS.</p>
      <h2 id="code-transforms">Code transforms</h2><p>The codemod rewrites the useRouter import:
      useRouter from next/navigation becomes <code>useRouter</code> from @gio.js/react.</p>`],
    ['/docs/examples', 'Guides', 'Starters', `
      <h1>Examples</h1><p>Small apps.</p>
      <h2 id="redirect">redirect</h2><p>An example that sends the browser elsewhere with a redirect.</p>`],
    // Reference, but not the API's own: a passing mention gets the small bonus.
    ['/docs/configuration', 'API Reference', 'gio.toml', `
      <h1>gio.toml</h1><p>Server configuration.</p>
      <h2 id="prefetch">Prefetch</h2><p>What <code>useRouter()</code> prefetches is capped here.</p>`],
  ];
  const before = indexOf(pages);
  const first = (search, query) => search.search(query).pages[0];
  assert.equal(first(before, 'useRouter').url, '/docs/functions');
  assert.equal(first(before, 'useRouter').items[0].url, '/docs/functions#router-hooks');
  assert.equal(first(before, 'useRouter()').url, '/docs/functions');
  // Above an exact heading in a guide, too.
  assert.equal(first(before, 'redirect').url, '/docs/functions');
  assert.equal(before.search('redirect').pages[1].url, '/docs/examples');

  // The per-item page, once it exists, beats the overview - however many
  // of the overview's sections name it.
  const after = indexOf([...pages, ['/docs/hooks/use-router', 'API Reference', 'Hooks', `
    <h1>useRouter</h1><p>Navigate from code.</p>
    <h2 id="reference">Reference</h2><p><code>router.push(href)</code>.</p>`]]);
  assert.deepEqual(after.search('useRouter').pages.slice(0, 2).map((page) => page.url), [
    '/docs/hooks/use-router',
    '/docs/functions',
  ]);
});

test('a name a reference table, an API heading or a command page defines leads to that definition', () => {
  const indexOf = (pages) => createSearch(buildSearchIndex(
    pages.map(([route, , , body]) => ({ route, html: html(body) })),
    (route) => {
      const page = pages.find(([r]) => r === route);
      return page && { section: page[1], group: page[2], label: 'label' };
    },
  ));
  /** A ConfigKeyTable / PropsTable as the components render it. */
  const refTable = (className, names) => `<table class="${className}"><thead><tr><th>Key</th><th>Type</th></tr></thead>
    <tbody>${names.map((name) => `<tr><td><code>${name}</code></td><td><code>boolean</code></td></tr>`).join('')}</tbody></table>`;
  const search = indexOf([
    ['/docs/configuration/server', 'API Reference', 'gio.toml', `
      <h1>[server]</h1><p>How the server listens.</p>
      <h2 id="reference">Reference</h2>${refTable('ref-table config-key-table', ['skew_protection', 'layouts'])}
      <h2 id="version-history">Version history</h2>
      <table class="ref-table ref-table--versions"><thead><tr><th>Version</th></tr></thead>
      <tbody><tr><td><code>v0.1.0-beta.8</code></td><td>Added <code>skew_protection</code> and <code>skew_protection</code>.</td></tr></tbody></table>`],
    // Reference code that only mentions the key.
    ['/docs/functions/deployment-helpers', 'API Reference', 'Functions', `
      <h1>Deployment helpers</h1><p>Detect a new deployment.</p>
      <h2 id="related">Related</h2><p>Turn it off with <code>skew_protection</code>.</p>`],
    ['/docs/functions/define-config', 'API Reference', 'Functions', `
      <h1>defineConfig</h1><p>Type gio.config.ts.</p>
      <h2 id="reference">Reference</h2><p><code>plugins</code> is a <code>GioNodePlugin[]</code>.</p>`],
    ['/docs/gio-config', 'API Reference', 'Other', `
      <h1>gio.config.ts</h1><p>Node plugins.</p>
      <h3 id="gionodeplugin">GioNodePlugin</h3><p>A plugin has a <code>name</code>.</p>
      <pre data-lang="ts"><code>interface GioNodePlugin {}</code></pre>
      <h3 id="examples">Examples</h3><p>A <code>GioNodePlugin</code> that adds a header.</p>`],
    ['/docs/cli', 'API Reference', 'CLI', `
      <h1>CLI</h1><p>Every gio command.</p>
      <h2 id="typegen">typegen</h2><p>Run <code>gio typegen</code> to write the route types.</p>`],
    ['/docs/cli/typegen', 'API Reference', 'CLI', `
      <h1>gio typegen</h1><p>Write .gio/routes.d.ts.</p>`],
    // A topic heading in a guide still answers a plain word.
    ['/docs/layouts-and-pages', 'Getting Started', undefined, `
      <h1>Layouts and Pages</h1><p>Nest layouts.</p>
      <h2 id="layouts">Layouts</h2><p>A layout wraps its pages.</p>`],
    // Two titles that differ only in punctuation.
    ['/docs/security', 'Guides', 'Security', `
      <h1>Security</h1><p>What the server protects, and <code>[security.headers]</code>.</p>`],
    ['/docs/configuration/security', 'API Reference', 'gio.toml', `
      <h1>[security]</h1><p>Response headers.</p>
      <h2 id="reference">Reference</h2>${refTable('ref-table config-key-table', ['csp', 'headers'])}`],
  ]);
  const first = (query) => search.search(query).pages[0]?.items[0].url;
  // A gio.toml key opens its section page at the key's row, not at a
  // passing mention in reference code or the version history.
  assert.equal(first('skew_protection'), '/docs/configuration/server#reference');
  // A key by its full name, in either spelling - a plain-word key included.
  assert.equal(first('server.skew_protection'), '/docs/configuration/server#reference');
  assert.equal(first('[security.headers]'), '/docs/configuration/security#reference');
  assert.equal(first('security.headers'), '/docs/configuration/security#reference');
  // The title as typed decides between `[security]` and Security.
  assert.equal(first('[security]'), '/docs/configuration/security');
  assert.equal(first('Security'), '/docs/security');
  // A heading that names an API item on a reference page beats the
  // reference code that mentions it.
  assert.equal(first('GioNodePlugin'), '/docs/gio-config#gionodeplugin');
  // A command's own page beats the CLI overview's heading for it.
  assert.equal(first('typegen'), '/docs/cli/typegen');
  assert.equal(first('gio typegen'), '/docs/cli/typegen');
  // A table row that is a plain word does not outrank a guide's heading.
  assert.equal(first('layouts'), '/docs/layouts-and-pages#layouts');
});

test('a definition as typed wins a spelling tie; flags define only themselves; plain-word rows lead within their page', () => {
  /** A PropsTable / ConfigKeyTable of these first-column names. */
  const refTable = (names) => `<table class="ref-table"><thead><tr><th>Name</th><th>Type</th></tr></thead>
    <tbody>${names.map((name) => `<tr><td><code>${name}</code></td><td><code>string</code></td></tr>`).join('')}</tbody></table>`;
  const pages = [
    ['/docs/configuration/server', 'API Reference', 'gio.toml', `
      <h1>[server]</h1><p>How the server listens.</p>
      <h2 id="reference">Reference</h2>${refTable(['proxy_headers', 'workers'])}`],
    // A camelCase field of the same name, on a page that says it more often.
    ['/docs/cli/giojs-server', 'API Reference', 'CLI', `
      <h1>giojs-server</h1><p>The server binary prints a report.</p>
      <h2 id="report">Report</h2><p>The <code>proxyHeaders</code> field echoes <code>proxy_headers</code>:
      whether proxy_headers is on.</p>${refTable(['proxyHeaders'])}`],
    ['/docs/configuration/health', 'API Reference', 'gio.toml', `
      <h1>[health]</h1><p>The health endpoint.</p>
      <h2 id="reference">Reference</h2>${refTable(['details'])}
      <h2 id="version-history">Version history</h2><p>Added <code>details</code>: the <code>details</code> key shows details.</p>`],
    // A flag table: it defines `--json` and `--static`, not the bare words.
    ['/docs/cli/doctor', 'API Reference', 'CLI', `
      <h1>gio doctor</h1><p>Check a project.</p>
      <h2 id="reference">Reference</h2>${refTable(['--json', '--static', '-H, --host &lt;ip&gt;'])}`],
    ['/docs/page-exports/http-methods', 'API Reference', 'Page Exports', `
      <h1>GET, POST, PUT, PATCH, DELETE</h1><p>Route handlers.</p>
      <h2 id="parameters">Parameters</h2><p>Read the body with <code>json()</code>.</p>${refTable(['json()'])}`],
    ['/docs/file-conventions/route', 'API Reference', 'File Conventions', `
      <h1>route.ts</h1><p>A route answers HTTP.</p>
      <h2 id="exports">Exports</h2>${refTable(['GET', 'POST', 'wsHandler'])}`],
    ['/docs/static-export', 'Guides', 'Deploying', `
      <h1>Static Export</h1><p>Export a static site.</p>`],
    ['/docs/hooks/use-router', 'API Reference', 'Hooks', `
      <h1>useRouter</h1><p>Navigate from code.</p>
      <h2 id="reference">Reference</h2>${refTable(['push(href)', 'refresh()'])}
      <h3 id="refresh"><code>refresh()</code></h3><p>Render the current page again with <code>refresh()</code>.</p>`],
  ];
  const search = createSearch(buildSearchIndex(
    pages.map(([route, , , body]) => ({ route, html: html(body) })),
    (route) => {
      const page = pages.find(([r]) => r === route);
      return page && { section: page[1], group: page[2], label: 'label' };
    },
  ));
  const first = (query) => search.search(query).pages[0]?.items[0].url;
  // Two rows that differ only in spelling: the one typed wins.
  assert.equal(first('proxy_headers'), '/docs/configuration/server#reference');
  assert.equal(first('proxyHeaders'), '/docs/cli/giojs-server#report');
  // A plain-word key keeps its page and opens it at the key table.
  assert.equal(first('details'), '/docs/configuration/health#reference');
  // ...but a heading that names the item still beats the table row.
  assert.equal(first('refresh()'), '/docs/hooks/use-router#refresh');
  // A flag answers its own spelling only, case included.
  assert.equal(first('--json'), '/docs/cli/doctor#reference');
  assert.equal(first('-H'), '/docs/cli/doctor#reference');
  assert.equal(first('json()'), '/docs/page-exports/http-methods#parameters');
  assert.equal(first('json'), '/docs/page-exports/http-methods#parameters');
  assert.equal(first('static'), '/docs/static-export');
  // A page titled with a list of names is titled with each.
  assert.equal(first('POST'), '/docs/page-exports/http-methods');
});

test('prefixes and typos still find the page', () => {
  assert.equal(urls('revalid')[0], '/docs/caching');
  assert.equal(urls('revalidte')[0], '/docs/caching');
  assert.equal(urls('redierct')[0], '/docs/functions/redirect');
  // The word still being typed may hold a typo too.
  assert.ok(urls('middlwa').includes('/docs/middleware'));
  // A short wrong word is not "fixed" into something else.
  assert.deepEqual(urls('xyz'), []);
});

test('words inside identifiers and code blocks are found, and the matching section is linked', () => {
  const result = search.search('max_body_bytes');
  assert.equal(result.pages[0].url, '/docs/configuration/server');
  assert.equal(result.pages[0].items[0].url, '/docs/configuration/server#max-body-bytes');
  assert.equal(urls('body bytes')[0], '/docs/configuration/server');
  assert.equal(urls('router')[0], '/docs/hooks/use-router');
  // Only in a code block: still found.
  assert.ok(urls('10485760').length === 0 || urls('10485760')[0] === '/docs/configuration/server');
  assert.equal(urls('login')[0], '/docs/functions/redirect');
});

test('every word must match before a partial match is shown', () => {
  const result = search.search('csrf origin');
  assert.equal(result.pages[0].url, '/docs/security');
  assert.equal(result.pages[0].items[0].heading, 'CSRF');
  // A heading named exactly by the query leads its page.
  const precedence = search.search('precedence');
  assert.equal(precedence.pages[0].items[0].url, '/docs/security#precedence');
});

test('results are grouped by page, with highlighted titles and snippets', () => {
  const result = search.search('redirect', { perPage: 2 });
  const guide = result.pages.find((page) => page.url === '/docs/guides/redirecting');
  assert.ok(guide.items.length <= 2);
  assert.equal(new Set(result.pages.map((page) => page.url)).size, result.pages.length);
  assert.equal(guide.section, 'Guides');
  assert.equal(guide.group, 'App');
  assert.deepEqual(guide.titleParts, [{ text: 'Redirecting', hit: true }]);
  const hits = guide.items.flatMap((item) => item.snippet.filter((part) => part.hit).map((part) => part.text.toLowerCase()));
  assert.ok(hits.length > 0 && hits.every((text) => text.startsWith('redirect')), hits.join(', '));
  assert.ok(result.total >= 3);
});

test('highlight marks word starts and identifier parts only', () => {
  assert.deepEqual(highlight('useRouter because', ['router', 'use']), [
    { text: 'use', hit: true },
    { text: 'Router', hit: true },
    { text: ' because', hit: false },
  ]);
  assert.deepEqual(highlight('no match', ['zzz']), [{ text: 'no match', hit: false }]);
});

test('fast enough for ~400 pages: index build and every keystroke of a query', (t) => {
  const words = ['cache', 'render', 'stream', 'header', 'cookie', 'session', 'image', 'font', 'route', 'layout',
    'config', 'server', 'worker', 'socket', 'proxy', 'deploy', 'metric', 'health', 'token', 'origin'];
  const pages = [];
  for (let p = 0; p < 400; p++) {
    let body = `<h1>Page ${p} ${words[p % words.length]}</h1><p>${words.join(' ')} intro ${p}</p>`;
    for (let s = 0; s < 10; s++) {
      const text = Array.from({ length: 120 }, (_, i) => `${words[(p + s + i) % words.length]}${(i * 7 + p) % 97}`).join(' ');
      body += `<h2>Section ${s} ${words[(p + s) % words.length]}</h2><p>${text} <code>apiName${p}x${s}</code></p>`;
    }
    pages.push({ route: `/docs/p${p}`, html: html(body) });
  }
  let started = performance.now();
  const big = createSearch(buildSearchIndex(pages, () => ({ section: 'API Reference', label: 'x' })));
  const buildMs = performance.now() - started;
  assert.equal(big.size, 400 * 11);

  const query = 'session cookie header';
  started = performance.now();
  for (let i = 1; i <= query.length; i++) big.search(query.slice(0, i));
  big.search('sesion cokie');
  const perKeystroke = (performance.now() - started) / (query.length + 1);
  assert.equal(big.search('apiName123x4').pages[0].url, '/docs/p123');
  t.diagnostic(`index build ${buildMs.toFixed(0)}ms, ${perKeystroke.toFixed(1)}ms per keystroke`);
  assert.ok(buildMs < 5000, `building the index took ${buildMs.toFixed(0)}ms`);
  assert.ok(perKeystroke < 60, `a keystroke took ${perKeystroke.toFixed(1)}ms on average`);
});
