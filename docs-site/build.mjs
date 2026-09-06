/**
 * docs-site/build.mjs
 *
 * Static build for the docs site: renders app/ to out/ (HTML + robots.txt +
 * sitemap.xml + llms.txt/llms-full.txt) using the GioJS exporter.
 * Run via `npm run export`.
 */
import { tsImport } from 'tsx/esm/api';
import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

process.env.GIO_SITE_URL = process.env.GIO_SITE_URL || 'https://giojs.com';

// Cache-bust globals.css: its URL is unhashed, so a stale copy would linger in
// the CDN/browser across deploys. A content hash in the query string makes each
// changed build a fresh URL. layout.tsx reads this via process.env.
const cssBytes = await readFile(join(here, 'public', 'globals.css'));
process.env.GIO_ASSET_VERSION = createHash('sha256').update(cssBytes).digest('hex').slice(0, 8);

const { exportSite } = await tsImport('../packages/giojs-core/src/export.ts', import.meta.url);
const { written, skipped } = await exportSite(join(here, 'app'), join(here, 'out'));

// Favicon set + manifest are requested at the site root (not under /public/),
// so copy them there. (public/ itself is already exported to out/public/.)
const ROOT_ASSETS = [
  'favicon.ico', 'favicon-16x16.png', 'favicon-32x32.png',
  'apple-touch-icon.png', 'android-chrome-192x192.png',
  'android-chrome-512x512.png', 'site.webmanifest',
];
for (const f of ROOT_ASSETS) {
  await cp(join(here, 'public', f), join(here, 'out', f)).catch(() => {});
}

await writeLlmsTxt(join(here, 'out'), process.env.GIO_SITE_URL);

console.log(`[docs] exported ${written.length} page(s) → out/  (favicon + sitemap + robots.txt + llms.txt included)`);
if (skipped.length) {
  for (const s of skipped) console.log(`   - skipped ${s.route}: ${s.reason}`);
}

/**
 * llms.txt (index) + llms-full.txt (full text dump) at the site root, per
 * https://llmstxt.org - lets coding agents consume the docs without scraping.
 * Content is derived from the exported HTML so it always matches the site.
 */
async function writeLlmsTxt(outDir, siteUrl) {
  const pages = [];
  for (const htmlPath of await findHtmlFiles(outDir)) {
    const rel = relative(outDir, htmlPath).split(sep).join('/');
    if (rel === '404.html') continue;
    const route = rel === 'index.html'
      ? '/'
      : '/' + rel.replace(/\/index\.html$/, '').replace(/\.html$/, '');
    const html = await readFile(htmlPath, 'utf8');
    const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1]
      ?? /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
    // Site-wide <title> is generic; the page's first heading names it better.
    const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(main)?.[1]?.replace(/<[^>]+>/g, ' ');
    const title = decodeEntities(
      (heading ?? /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? route).replace(/\s+/g, ' ').trim(),
    );
    pages.push({ route, title, text: htmlToText(main) });
  }
  pages.sort((a, b) =>
    (a.route === '/' ? -1 : b.route === '/' ? 1 : a.route.localeCompare(b.route)));

  const index = [
    '# GioJS',
    '',
    '> GioJS is a Rust-powered React framework: the Rust layer owns HTTP, routing,',
    '> caching, compression, static assets, and image optimization; a persistent',
    '> Node worker renders React (SSR) over an authenticated IPC channel.',
    '',
    '## Docs',
    '',
    ...pages.map((p) => `- [${p.title}](${siteUrl}${p.route}): ${p.route}`),
    '',
    `Full documentation text: ${siteUrl}/llms-full.txt`,
    '',
  ].join('\n');

  const full = pages
    .map((p) => `# ${p.title}\nURL: ${siteUrl}${p.route}\n\n${p.text}`)
    .join('\n\n---\n\n');

  await writeFile(join(outDir, 'llms.txt'), index, 'utf8');
  await writeFile(join(outDir, 'llms-full.txt'), full + '\n', 'utf8');
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

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|svg|nav)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\`\`\`\n${code.replace(/<[^>]+>/g, '')}\n\`\`\`\n`)
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
        (_, level, text) => `\n${'#'.repeat(Number(level))} ${text.replace(/<[^>]+>/g, '')}\n`)
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<(?:p|div|section|article|tr|table|ul|ol|br)[^>]*\/?>/gi, '\n')
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => `\`${code.replace(/<[^>]+>/g, '')}\``)
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
