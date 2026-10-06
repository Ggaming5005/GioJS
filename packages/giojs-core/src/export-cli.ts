/**
 * giojs-core/src/export-cli.ts
 *
 * Entry point for `gio export`. Renders the app to static HTML under out/.
 * APP_DIR comes from GIO_APP_DIR (default ./app); output from GIO_OUT_DIR
 * (default ./out). The export never starts the Rust server, so it loads the
 * project's .env files itself (same precedence rules) before rendering.
 */
import { dirname, join } from 'node:path';
import { loadEnvFiles } from './env-files.ts';

// Same mode rule as the Rust server: dev iff NODE_ENV=development. It must
// hold before React loads (hence the dynamic import of export.ts below) -
// React picks its build from NODE_ENV once, and the dev build writes a failed
// Suspense boundary's error message and stack into the HTML of a publicly
// hosted page. It must also hold before the .env files are chosen.
if (process.env.NODE_ENV !== 'development') process.env.NODE_ENV = 'production';

const appDir = process.env.GIO_APP_DIR ?? join(process.cwd(), 'app');
const outDir = process.env.GIO_OUT_DIR ?? join(process.cwd(), 'out');

try {
  const env = loadEnvFiles(dirname(appDir));
  if (env.files.length > 0) console.log(`[giojs] loaded env: ${env.files.join(', ')}`);
  if (env.skipped.length > 0) {
    console.log(`[giojs] skipped env candidates that are not files: ${env.skipped.join(', ')}`);
  }
  if (env.ignoredNodeEnv) console.log('[giojs] NODE_ENV in .env files is ignored');
} catch (envError) {
  console.error(`[giojs] ${envError instanceof Error ? envError.message : String(envError)}`);
  process.exit(1);
}

const { exportSite } = await import('./export.ts');

console.log(`[giojs] static export: ${appDir} → ${outDir}`);

const { written, skipped } = await exportSite(appDir, outDir);

console.log(`\n[giojs] rendered ${written.length} page(s):`);
for (const w of written.sort()) console.log(`   ✓ ${w === '/' ? '/ (index)' : w}`);

if (skipped.length > 0) {
  console.log(`\n[giojs] skipped ${skipped.length}:`);
  for (const s of skipped) console.log(`   - ${s.route}  -  ${s.reason}`);
}

console.log(`\n[giojs] ✔ static export complete → ${outDir}`);
console.log('[giojs]   deploy the out/ folder to any static host (Cloudflare Pages, GitHub Pages, …)');
