/**
 * docs-site/build.mjs
 *
 * Static build for the docs site: renders app/ to out/ (HTML + robots.txt +
 * sitemap.xml) using the GioJS exporter, then derives from the exported
 * HTML: llms.txt/llms-full.txt, a Markdown copy of every page (`/docs/x` →
 * `/docs/x.md`, what "Copy page as Markdown" fetches) and the search index
 * (`/search-index.json`, split per h2/h3 section - lib/search-index.mjs).
 * Fails when a page in the search index has a heading without an id or an
 * id used twice.
 * Run via `npm run export`.
 */
import { tsImport } from 'tsx/esm/api';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { articleHtml, decodeEntities, htmlToText, idProblems } from './lib/text.mjs';
import { buildSearchIndex } from './lib/search-index.mjs';

const here = dirname(fileURLToPath(import.meta.url));

process.env.GIO_SITE_URL = process.env.GIO_SITE_URL || 'https://giojs.com';
// Production mode like `gio export` (dev iff NODE_ENV=development), set before
// the exporter loads React: its dev build writes error stacks into the HTML.
if (process.env.NODE_ENV !== 'development') process.env.NODE_ENV = 'production';

// Cache-bust globals.css: its URL is unhashed, so a stale copy would linger in
// the CDN/browser across deploys. A content hash in the query string makes each
// changed build a fresh URL. layout.tsx reads this via process.env.
const cssBytes = await readFile(join(here, 'public', 'globals.css'));
process.env.GIO_ASSET_VERSION = createHash('sha256').update(cssBytes).digest('hex').slice(0, 8);

const { exportSite } = await tsImport('../packages/giojs-core/src/export.ts', import.meta.url);
const { searchPlace } = await tsImport('./components/nav/index.ts', import.meta.url);
const outDir = join(here, 'out');
const { written, skipped, unhydrated } = await exportSite(join(here, 'app'), outDir);

// The exporter copies public/ to the site root as well as out/public/, so the
// favicon set and manifest already sit where browsers request them.

const pages = await readPages(outDir);
// The landing page is marketing, not documentation: llms.txt lists it, the
// .md copies and the search index leave it out.
const docsPages = pages.filter((page) => page.route !== '/');
// Every heading the search index lists carries its own id (search results
// and shared links land on it), and no id repeats on a page: fail the build
// otherwise. That covers /releases too, which has no docs layout to give a
// heading its id in the browser (OnThisPage).
const idErrors = docsPages
  .flatMap((page) => idProblems(page.html).map((problem) => `${page.route}: ${problem}`));
if (idErrors.length > 0) {
  for (const error of idErrors) console.error(`[docs] error: ${error}`);
  console.error('[docs] give every h2/h3 a unique id="kebab-case" (docs-site/AGENTS.md)');
  process.exit(1);
}
await writeLlmsTxt(outDir, pages, process.env.GIO_SITE_URL);
await writeMarkdownPages(outDir, docsPages, process.env.GIO_SITE_URL);
const index = buildSearchIndex(docsPages, searchPlace);
await writeFile(join(outDir, 'search-index.json'), JSON.stringify(index), 'utf8');

console.log(
  `[docs] exported ${written.length} page(s) → out/  (favicon + sitemap + robots.txt + llms.txt + ` +
    `.md pages + search index of ${index.sections.length} sections included)`,
);
// app/search-index.json/route.ts is the development stand-in for the file
// written above; the exporter skips route handlers by design.
for (const s of skipped.filter((s) => s.route !== '/search-index.json')) {
  console.log(`   - skipped ${s.route}: ${s.reason}`);
}
// The docs chrome (search, theme, table of contents) needs the client bundle.
for (const u of unhydrated) console.log(`   - ${u.route} ships without client JS: ${u.reason}`);

/** Every exported page but the 404, landing page first: `{ route, html, title }`. */
async function readPages(outDir) {
  const pages = [];
  for (const htmlPath of await findHtmlFiles(outDir)) {
    const rel = relative(outDir, htmlPath).split(sep).join('/');
    if (rel === '404.html') continue;
    const route = rel === 'index.html'
      ? '/'
      : '/' + rel.replace(/\/index\.html$/, '').replace(/\.html$/, '');
    const html = await readFile(htmlPath, 'utf8');
    // The page's first heading names it better than the templated <title>.
    const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(articleHtml(html))?.[1]?.replace(/<[^>]+>/g, ' ');
    const title = decodeEntities(
      (heading ?? /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? route).replace(/\s+/g, ' ').trim(),
    );
    pages.push({ route, html, title });
  }
  return pages.sort((a, b) =>
    (a.route === '/' ? -1 : b.route === '/' ? 1 : a.route.localeCompare(b.route)));
}

/**
 * llms.txt (index) + llms-full.txt (full text dump) at the site root, per
 * https://llmstxt.org - lets coding agents consume the docs without scraping.
 * Content is derived from the exported HTML so it always matches the site.
 */
async function writeLlmsTxt(outDir, pages, siteUrl) {
  const index = [
    '# GioJS',
    '',
    '> GioJS is a Rust-powered React framework: the Rust layer owns HTTP, routing,',
    '> caching, compression, static assets, and image optimization; a persistent',
    '> Node worker renders React (SSR) over an authenticated IPC channel.',
    '',
    '## Docs',
    '',
    // Docs pages link their Markdown copy (writeMarkdownPages).
    ...pages.map((p) => `- [${p.title}](${siteUrl}${p.route === '/' ? '' : `${p.route}.md`}): ${p.route}`),
    '',
    `Full documentation text: ${siteUrl}/llms-full.txt`,
    '',
  ].join('\n');

  const full = pages
    .map((p) => `# ${p.title}\nURL: ${siteUrl}${p.route}\n\n${pageText(p)}`)
    .join('\n\n---\n\n');

  await writeFile(join(outDir, 'llms.txt'), index, 'utf8');
  await writeFile(join(outDir, 'llms-full.txt'), full + '\n', 'utf8');
}

/** The page's article as Markdown-ish text, without the h1 (callers print the title). */
function pageText(page) {
  return htmlToText(articleHtml(page.html).replace(/<h1[^>]*>[\s\S]*?<\/h1>/, ''));
}

/**
 * `/docs/x` → out/docs/x.md: the page as Markdown, for "Copy page as
 * Markdown" and for agents that want one page rather than llms-full.txt.
 */
async function writeMarkdownPages(outDir, pages, siteUrl) {
  for (const page of pages) {
    const md = `# ${page.title}\n\nSource: ${siteUrl}${page.route}\n\n${pageText(page)}\n`;
    await writeFile(join(outDir, ...`${page.route.slice(1)}.md`.split('/')), md, 'utf8');
  }
}

async function findHtmlFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'public' && entry.name !== '_next') {
      found.push(...await findHtmlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      found.push(full);
    }
  }
  return found;
}
