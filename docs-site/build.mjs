/**
 * docs-site/build.mjs
 *
 * Static build for the docs site: renders app/ to out/ (HTML + robots.txt +
 * sitemap.xml) using the GioJS exporter. Run via `npm run export`.
 */
import { tsImport } from 'tsx/esm/api';
import { cp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

console.log(`[docs] exported ${written.length} page(s) → out/  (favicon + sitemap + robots.txt included)`);
if (skipped.length) {
  for (const s of skipped) console.log(`   - skipped ${s.route}: ${s.reason}`);
}
