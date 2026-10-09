/**
 * tests/integration/hydrate-page.mjs
 *
 * Hydrates a page served by the running fixture server with its real client
 * bundle, the way a browser would: jsdom parses the complete streamed HTML
 * (running React's inline scripts, so streamed Suspense content is in place),
 * then the page's bootstrap module is imported from the server - chunk URLs
 * are fetched over HTTP by a module load hook. Reports, for every
 * `output[data-field]` the page renders, the useId values the server put on
 * the field (`server`: its input's id and aria-describedby) and the ones the
 * browser computed once mounted (`client`: the output's text), plus every
 * console.error (hydration warnings) and uncaught error.
 *
 * Run by run.mjs in a child process (it installs DOM globals and a module
 * loader hook):
 *   node tests/integration/hydrate-page.mjs <baseUrl> <path>
 * Prints one JSON report line; run.mjs asserts on it.
 */
import { createRequire, register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [baseUrl, path] = process.argv.slice(2);
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { JSDOM } = createRequire(join(repoRoot, 'packages', 'giojs-react', 'package.json'))('jsdom');

// Chunks import each other relatively from their http: URL; Node only loads
// file: modules itself, so fetch these.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(specifier, context, next) {
         const parent = context.parentURL ?? '';
         if (specifier.startsWith('http:')) return { url: specifier, shortCircuit: true };
         if (parent.startsWith('http:')) return { url: new URL(specifier, parent).href, shortCircuit: true };
         return next(specifier, context);
       }
       export async function load(url, context, next) {
         if (!url.startsWith('http:')) return next(url, context);
         const res = await fetch(url);
         if (!res.ok) throw new Error(url + ' answered ' + res.status);
         return { format: 'module', source: await res.text(), shortCircuit: true };
       }`,
    ),
);

const report = { errors: [], status: 0, fields: [], revealed: false, treeAttribute: null };
const finish = (code = 0) => {
  console.log(JSON.stringify(report));
  process.exit(code);
};

const res = await fetch(baseUrl + path);
report.status = res.status;
const html = await res.text();
const dom = new JSDOM(html, { url: baseUrl + path, pretendToBeVisual: true, runScripts: 'dangerously' });
const { window } = dom;

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
window.console.error = console.error;
globalThis.reportError = (err) => report.errors.push(`reportError: ${err?.stack ?? err}`);
window.reportError = globalThis.reportError;
window.addEventListener('error', (e) => report.errors.push(`window error: ${e.message}`));
process.on('unhandledRejection', (err) => report.errors.push(`unhandled rejection: ${err?.stack ?? err}`));

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

const outputs = () => [...document.querySelectorAll('#__gio output[data-field]')];
// The server's ids, as streamed: React's inline scripts move the late
// content into place (on an animation frame), before anything hydrates.
const fallbackGone = () => !document.body.textContent.includes('USE_ID_FALLBACK');
await until('the streamed Suspense content to be revealed', fallbackGone);
const server = new Map(
  outputs().map((output) => {
    const input = document.querySelector(`#__gio input[name="${output.dataset.field}"]`);
    return [output.dataset.field, `${input?.id ?? ''} ${input?.getAttribute('aria-describedby') ?? ''}`];
  }),
);
report.revealed = fallbackGone();
report.treeAttribute = document.getElementById('__gio')?.getAttribute('data-gio-tree') ?? null;

const bootstrap = document.querySelector('script[type="module"][src^="/_next/"]')?.getAttribute('src');
if (!bootstrap) {
  report.errors.push('no bootstrap module script in the page');
  finish(1);
}
try {
  await import(new URL(bootstrap, baseUrl).href);
} catch (err) {
  report.errors.push(`bootstrap module failed to load: ${err?.stack ?? err}`);
  finish(1);
}
await until('every field to mount', () => outputs().length > 0 && outputs().every((o) => o.textContent !== ''));
report.fields = outputs().map((output) => ({
  name: output.dataset.field,
  server: server.get(output.dataset.field) ?? null,
  client: output.textContent,
}));
finish(0);
