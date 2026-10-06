/**
 * giojs-core/src/export-cli.ts
 *
 * Entry point for `gio export`. Renders the app to static HTML under out/.
 * APP_DIR comes from GIO_APP_DIR (default ./app); output from GIO_OUT_DIR
 * (default ./out). The export never starts the Rust server, so it loads the
 * project's .env files itself (same precedence rules) before rendering.
 */
import { dirname, join } from 'node:path';
import { exportSite } from './export.ts';
import { loadEnvFiles } from './env-files.ts';

const appDir = process.env.GIO_APP_DIR ?? join(process.cwd(), 'app');
const outDir = process.env.GIO_OUT_DIR ?? join(process.cwd(), 'out');

try {
  const env = loadEnvFiles(dirname(appDir));
  if (env.files.length > 0) console.log(`[giojs] loaded env: ${env.files.join(', ')}`);
  if (env.ignoredNodeEnv) console.log('[giojs] NODE_ENV in .env files is ignored');
} catch (envError) {
  console.error(`[giojs] ${envError instanceof Error ? envError.message : String(envError)}`);
  process.exit(1);
}

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
