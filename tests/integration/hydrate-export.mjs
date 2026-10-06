/**
 * tests/integration/hydrate-export.mjs
 *
 * Runs a `gio export`ed site's real client bundle the way a browser on a
 * static host would: jsdom loads out/<start>/index.html, the page's bootstrap
 * module is imported from out/_next/static/chunks, and fetch() answers from
 * the out/ file layout (404.html with status 404 for anything else). Then:
 *
 *   1. the page hydrates: its `button[data-probe]` reads `mounted=true`
 *      (set by an effect) and a click reaches its handler (`clicks=1`);
 *   2. clicking the GioLink `a[href=<nav>]` soft-navigates: the target page
 *      is fetched from out/, swapped in, its route chunk imported, and the
 *      new route mounted and interactive the same way.
 *
 * Run by run.mjs in a child process (it installs DOM globals and a module
 * resolve hook):
 *   node tests/integration/hydrate-export.mjs <outDir> <startPath> <navPath>
 * Prints one JSON report line; run.mjs asserts on it.
 */
import { createRequire, register } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [outDir, startPath, navPath] = process.argv.slice(2);
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { JSDOM } = createRequire(join(repoRoot, 'packages', 'giojs-react', 'package.json'))('jsdom');
const ORIGIN = 'http://static.test';

// Chunks import each other relatively, but soft navigation imports the next
// route's entry by its site URL (/_next/static/chunks/...): serve it from out/.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `const out = ${JSON.stringify(pathToFileURL(outDir).href)};
       export async function resolve(specifier, context, next) {
         if (specifier.startsWith('/_next/')) return next(out + specifier, context);
         return next(specifier, context);
       }`,
    ),
);

/** The file a static host serves for `path` (export writes <path>/index.html). */
function fileFor(path) {
  const parts = path.split('?')[0].split('/').filter(Boolean);
  const file = join(outDir, ...parts, 'index.html');
  return existsSync(file) ? file : null;
}

const report = { errors: [], fetched: [], start: {}, nav: {} };
const finish = (code = 0) => {
  console.log(JSON.stringify(report));
  process.exit(code);
};

const startFile = fileFor(startPath);
if (startFile === null) {
  report.errors.push(`no exported page for ${startPath}`);
  finish(1);
}
const dom = new JSDOM(await readFile(startFile, 'utf8'), {
  url: ORIGIN + startPath,
  pretendToBeVisual: true,
});
const { window } = dom;

// Browser globals the bundle reads. Node's own Event/EventTarget cannot be
// dispatched on jsdom nodes, so the DOM's versions win for those.
for (const key of Object.getOwnPropertyNames(window)) {
  if (!(key in globalThis)) {
    try {
      globalThis[key] = window[key];
    } catch {
      // read-only slot
    }
  }
}
for (const key of ['window', 'document', 'navigator', 'location', 'history', 'Event', 'CustomEvent', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}

const origError = console.error;
console.error = (...args) => {
  report.errors.push(args.map(String).join(' '));
  origError(...args);
};
globalThis.reportError = (err) => report.errors.push(`reportError: ${err?.stack ?? err}`);
window.reportError = globalThis.reportError;
window.addEventListener('error', (e) => report.errors.push(`window error: ${e.message}`));
process.on('unhandledRejection', (err) => report.errors.push(`unhandled rejection: ${err?.stack ?? err}`));

const fetchImpl = async (href) => {
  const path = new URL(String(href), window.location.href).pathname;
  report.fetched.push(path);
  const file = fileFor(path);
  if (file === null) {
    return new Response(await readFile(join(outDir, '404.html'), 'utf8'), { status: 404 });
  }
  return new Response(await readFile(file, 'utf8'), {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
};
globalThis.fetch = fetchImpl;
window.fetch = fetchImpl;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(20);
  }
  report.errors.push(`timed out waiting for ${what}`);
  return false;
}

const probe = () => document.querySelector('#__gio button[data-probe]');
const probeText = () => probe()?.textContent ?? null;
const click = (el) =>
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));

async function exercise(target) {
  await until(`${window.location.pathname} to mount`, () => /mounted=true/.test(probeText() ?? ''));
  target.mounted = probeText();
  const button = probe();
  if (button !== null) click(button);
  await until(`${window.location.pathname} click handler`, () => /clicks=1/.test(probeText() ?? ''));
  target.afterClick = probeText();
}

// The bootstrap <script type="module"> the exported HTML references.
const bootstrap = document.querySelector('script[type="module"][src^="/_next/"]')?.getAttribute('src');
if (!bootstrap) {
  report.errors.push('no bootstrap module script in the exported page');
  finish(1);
}
report.start.bootstrap = bootstrap;
try {
  await import(pathToFileURL(join(outDir, ...bootstrap.split('/').filter(Boolean))).href);
} catch (err) {
  report.errors.push(`bootstrap module failed to load: ${err?.stack ?? err}`);
  finish(1);
}
await exercise(report.start);
report.start.content = document.getElementById('__gio')?.textContent ?? null;

const link = document.querySelector(`#__gio a[href="${navPath}"]`);
if (link === null) {
  report.errors.push(`no link to ${navPath} on ${startPath}`);
  finish(1);
}
click(link);
await until(`soft navigation to ${navPath}`, () => window.location.pathname === navPath);
report.nav.pathname = window.location.pathname;
await exercise(report.nav);
report.nav.content = document.getElementById('__gio')?.textContent ?? null;
report.nav.envelopePath = JSON.parse(document.getElementById('__gio_props')?.textContent ?? '{}').path ?? null;
finish(0);
