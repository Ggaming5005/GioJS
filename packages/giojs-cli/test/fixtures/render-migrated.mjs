/**
 * Renders pages of a migrated project through @gio.js/core/testing's
 * renderPage - the worker's own render path - and prints the results as
 * JSON. Spawned by migrate-render.test.ts under `node --import tsx` (the
 * loader the GioJS server starts its worker with), with the project root
 * as cwd, so module formats resolve exactly as they do when served.
 *
 *   node --import tsx render-migrated.mjs <testing.ts URL> <appDir> <path>...
 */
const [testingUrl, appDir, ...paths] = process.argv.slice(2);
const { renderPage, resetTestApp } = await import(testingUrl);
const results = {};
for (const path of paths) {
  const page = await renderPage(path, { appDir });
  results[path] = {
    status: page.status,
    html: page.html,
    ...(page.error !== undefined ? { error: page.error.message } : {}),
    ...(page.redirect !== undefined ? { redirect: page.redirect } : {}),
    cacheable: page.cacheable,
  };
}
await resetTestApp();
process.stdout.write(JSON.stringify(results));
