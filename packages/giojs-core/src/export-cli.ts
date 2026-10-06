/**
 * giojs-core/src/export-cli.ts
 *
 * Entry point for `gio export`. Renders the app to static HTML under out/.
 * APP_DIR comes from GIO_APP_DIR (default ./app); output from GIO_OUT_DIR
 * (default ./out).
 */
import { join } from 'node:path';

// Same mode rule as the Rust server: dev iff NODE_ENV=development. It must
// hold before React loads (hence the dynamic import below) - React picks its
// build from NODE_ENV once, and the dev build writes a failed Suspense
// boundary's error message and stack into the HTML of a publicly hosted page.
if (process.env.NODE_ENV !== 'development') process.env.NODE_ENV = 'production';
const { exportSite } = await import('./export.ts');

const appDir = process.env.GIO_APP_DIR ?? join(process.cwd(), 'app');
const outDir = process.env.GIO_OUT_DIR ?? join(process.cwd(), 'out');

console.log(`[giojs] static export: ${appDir} → ${outDir}`);

const { written, skipped } = await exportSite(appDir, outDir);

console.log(`\n[giojs] rendered ${written.length} page(s):`);
for (const w of written.sort()) console.log(`   ✓ ${w === '/' ? '/ (index)' : w}`);

if (skipped.length > 0) {
  console.log(`\n[giojs] skipped ${skipped.length} (server-only):`);
  for (const s of skipped) console.log(`   - ${s.route}  -  ${s.reason}`);
}

console.log(`\n[giojs] ✔ static export complete → ${outDir}`);
console.log('[giojs]   deploy the out/ folder to any static host (Cloudflare Pages, GitHub Pages, …)');
