/**
 * docs-site/build.mjs
 *
 * Static build for the docs site: renders app/ to out/ (HTML + robots.txt +
 * sitemap.xml) using the GioJS exporter. Run via `npm run export`.
 */
import { tsImport } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

process.env.GIO_SITE_URL = process.env.GIO_SITE_URL || 'https://giojs.com';

const { exportSite } = await tsImport('../packages/giojs-core/src/export.ts', import.meta.url);
const { written, skipped } = await exportSite(join(here, 'app'), join(here, 'out'));

console.log(`[docs] exported ${written.length} page(s) → out/  (sitemap + robots.txt included)`);
if (skipped.length) {
  for (const s of skipped) console.log(`   - skipped ${s.route}: ${s.reason}`);
}
