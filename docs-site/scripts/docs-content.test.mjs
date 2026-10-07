/**
 * docs-site/scripts/docs-content.test.mjs
 *
 * Facts the docs state that the code decides, checked against the code so
 * they cannot drift apart: the shutdown grace the deploy recipes give the
 * server, the starter's [[fonts]], the create-giojs flags the docs show, and
 * which release the releases page presents as current.
 * Run: `npm test` in docs-site/ (no dependencies needed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = join(siteDir, '..');
const read = (...path) => readFileSync(join(repoDir, ...path), 'utf8');
const docsPage = (route) => read('docs-site', 'app', 'docs', ...route.split('/'), 'page.tsx');

/** The TOML code samples of a page (`<CodeBlock lang="toml" title="gio.toml" code={`...`} />`). */
const tomlSamples = (source) =>
  [...source.matchAll(/lang="toml"(?: title="[^"]*")? code=\{`([\s\S]*?)`\}/g)].map((m) => m[1]).join('\n');

/** Every app/**\/page.tsx of the docs site. */
function pageFiles(dir = join(siteDir, 'app')) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return pageFiles(full);
    return entry.name === 'page.tsx' ? [full] : [];
  });
}

/** `const NAME: Duration = Duration::from_secs(N)` in a Rust source file. */
function rustSeconds(file, name) {
  const m = new RegExp(`const ${name}:[^=]*=\\s*(?:std::time::)?Duration::from_secs\\((\\d+)\\)`).exec(read(file));
  assert.ok(m, `${name} not found in ${file} - update this test if it moved`);
  return Number(m[1]);
}

/** The `url`s of the [[fonts]] tables in TOML text (a gio.toml or a docs sample). */
function fontUrls(toml) {
  const urls = [];
  for (const block of toml.split(/^\s*\[\[fonts\]\]/m).slice(1)) {
    const table = block.split(/^\s*\[/m)[0];
    const url = /^\s*url\s*=\s*"([^"]*)"/m.exec(table);
    assert.ok(url, `[[fonts]] table without a url:\n${table}`);
    urls.push(url[1]);
  }
  return urls;
}

test('deploy recipes give the server at least its graceful-shutdown time', () => {
  // A stop waits for in-flight requests, then gives the workers their grace.
  const needed =
    rustSeconds('crates/giojs-server/src/main.rs', 'SHUTDOWN_DRAIN_TIMEOUT') +
    rustSeconds('crates/giojs-server/src/ipc.rs', 'WORKER_SHUTDOWN_GRACE');
  const guide = docsPage('guides/deploying');
  const settings = {
    'Docker --stop-timeout': /--stop-timeout (\d+)/g,
    'Compose stop_grace_period': /stop_grace_period: (\d+)s/g,
    'Fly.io kill_timeout': /^kill_timeout = (\d+)/gm,
    'Railway drainingSeconds': /"drainingSeconds": (\d+)/g,
    'systemd TimeoutStopSec': /TimeoutStopSec=(\d+)/g,
  };
  for (const [name, pattern] of Object.entries(settings)) {
    const values = [...guide.matchAll(pattern)].map((m) => Number(m[1]));
    assert.ok(values.length > 0, `the deploying guide does not set ${name}`);
    for (const seconds of values) {
      assert.ok(seconds >= needed, `${name} is ${seconds}s - the server needs ${needed}s to drain`);
    }
  }
});

test("the docs show the starter's real [[fonts]], and its files exist", () => {
  const starter = fontUrls(read('packages/giojs-cli/templates/default/gio.toml'));
  assert.ok(starter.length > 0, 'the starter declares no [[fonts]]');
  for (const url of starter) {
    assert.ok(!url.includes('://'), `the starter fetches ${url} over the network`);
    const file = url.replace(/^\/(public\/)?/, '');
    for (const template of ['default', 'default-js']) {
      assert.ok(
        existsSync(join(repoDir, 'packages/giojs-cli/templates', template, 'public', file)),
        `templates/${template}/public/${file} is missing`,
      );
    }
  }
  assert.deepEqual(fontUrls(tomlSamples(docsPage('project-structure'))), starter);
  assert.deepEqual(fontUrls(tomlSamples(docsPage('font-optimization'))), starter);
});

test("the environment variables guide shows the starter's .env.example", () => {
  const starter = read('packages/giojs-cli/templates/default/.env.example').trimEnd();
  assert.equal(read('packages/giojs-cli/templates/default-js/.env.example').trimEnd(), starter);
  assert.ok(docsPage('guides/environment-variables').includes(starter), 'the guide no longer matches the template');
});

test('no [[fonts]] sample in the docs downloads from a placeholder host', () => {
  // A failed download stops startup, so a copied example.com URL breaks the app.
  for (const file of pageFiles()) {
    for (const url of fontUrls(tomlSamples(readFileSync(file, 'utf8')))) {
      assert.ok(!/^https?:\/\/([\w-]+\.)*example\.(com|org|net)\//.test(url), `${file}: [[fonts]] url ${url}`);
    }
  }
});

test('every create-giojs flag the README and Installation show is in its --help', () => {
  const usage = /export const USAGE = `([\s\S]*?)`;/.exec(read('packages/giojs-cli/src/args.ts'));
  assert.ok(usage, 'USAGE not found in packages/giojs-cli/src/args.ts - update this test');
  const known = new Set(usage[1].match(/(?<![\w-])--?[a-z][\w-]*/g));

  const shown = [];
  const sources = { 'README.md': read('README.md'), installation: docsPage('installation') };
  for (const [where, text] of Object.entries(sources)) {
    // Commands: `npm create giojs@latest my-app -- --ts`, `pnpm create giojs --no-git`, ...
    for (const line of text.matchAll(/\bcreate giojs\S*([^\n#`\\<]*)/g)) {
      const words = line[1].trim().split(/\s+/).filter((w) => w !== '--');
      if (words[0] === 'migrate') continue; // the migrate subcommand has its own flags
      for (const word of words) if (/^-/.test(word)) shown.push([where, word]);
    }
    // Flags named in prose and tables (`<code>--force</code>`).
    if (where === 'installation') {
      for (const m of text.matchAll(/<code>(--?[a-z][\w-]*)/g)) shown.push([where, m[1]]);
    }
  }
  assert.ok(shown.length > 0, 'found no create-giojs flags in the docs - update this test');
  const unknown = shown.filter(([, flag]) => !known.has(flag));
  assert.deepEqual(unknown, [], 'flags create-giojs does not have');

  const cli = read('packages/giojs-cli/src/index.ts');
  for (const [where, text] of Object.entries(sources)) {
    if (/create-giojs add\b/.test(text)) {
      assert.match(cli, /['"]add['"]/, `${where} documents \`create-giojs add\`, which the CLI lacks`);
    }
  }
});

test("the releases page highlights the release tagged 'latest', which is released", () => {
  const source = read('docs-site/app/releases/page.tsx');
  const releases = [...source.matchAll(/version: '([^']+)',\s*date: '([^']+)',(?:\s*tag: '([^']+)',)?/g)].map(
    ([, version, date, tag]) => ({ version, date, tag }),
  );
  assert.ok(releases.length > 1, 'no releases parsed - update this test');
  const latest = releases.filter((r) => r.tag === 'latest');
  assert.equal(latest.length, 1, `exactly one release must be tagged 'latest': ${JSON.stringify(latest)}`);
  assert.notEqual(latest[0].date, 'Unreleased', `${latest[0].version} is tagged 'latest' but unreleased`);
  // The glow follows the tag, not the position: an unreleased entry goes first.
  assert.match(source, /function isLatest\(rel: Release\): boolean \{\s*return rel\.tag === 'latest';/);
  for (const cls of ['rel-node--latest', 'rel-card--latest']) {
    assert.match(source, new RegExp(`\\$\\{isLatest\\(rel\\) \\? ' ${cls}' : ''\\}`), cls);
  }
});

test('the component and hook reference states the defaults @gio.js/react ships', () => {
  const react = (file) => read('packages', 'giojs-react', 'src', file);
  /** `source` must contain `code`, and the docs page `route` must contain `text`. */
  const check = (source, code, route, text) => {
    assert.ok(source.includes(code), `${code} not found in @gio.js/react - update this test and the docs`);
    assert.ok(docsPage(route).includes(text), `${route} should say ${JSON.stringify(text)} (${code})`);
  };
  const link = react('Link.tsx');
  check(link, "prefetch = 'hover'", 'components/gio-link', `default: "'hover'"`);
  check(link, 'transition = false', 'components/gio-link', "default: 'false'");
  const nav = react('navigation.ts');
  check(nav, 'PREFETCH_TTL_MS = 30_000', 'components/gio-link', '30 seconds');
  check(nav, 'MAX_PREFETCH_ENTRIES = 50', 'components/gio-link', 'holds at most 50');
  const animate = react('Animate.tsx');
  check(animate, 'duration = 400', 'components/animate', "default: '400'");
  check(animate, 'delay = 0', 'components/animate', "default: '0'");
  check(animate, "when = 'visible'", 'components/animate', `default: "'visible'"`);
  check(react('animate-observer.ts'), 'threshold: 0.1', 'components/animate', 'threshold <code>0.1</code>');
  const localeLink = react('LocaleLink.tsx');
  check(localeLink, 'defaultLocale ?? settings.defaultLocale', 'components/locale-link', "default: '[i18n] default_locale'");
  check(localeLink, "typeof defaultLocale === 'string' ? defaultLocale : 'en'", 'components/locale-link', 'the default is <code>en</code>');
  check(localeLink, 'stringsIn(fromServer.__GIO_LOCALES__)', 'components/locale-link', '<code>window.__GIO_LOCALES__</code>');
  check(react('Image.tsx'), 'DEFAULT_QUALITY = 75', 'components/gio-image', '[images] quality (75)');
  const ws = react('hooks/useWebSocket.ts');
  check(ws, 'DEFAULT_MAX_QUEUED = 100', 'hooks/use-web-socket', 'keeps up to 100');
  check(ws, 'DEFAULT_INITIAL_DELAY_MS = 500', 'hooks/use-web-socket', "name: 'initialDelayMs', type: 'number', default: '500'");
  check(ws, 'DEFAULT_MAX_DELAY_MS = 30_000', 'hooks/use-web-socket', "name: 'maxDelayMs', type: 'number', default: '30000'");
  check(ws, 'DEFAULT_MIN_UPTIME_MS = 5_000', 'hooks/use-web-socket', "name: 'minUptimeMs', type: 'number', default: '5000'");
  check(ws, 'if (code >= 4000 && code < 4500) return false;', 'hooks/use-web-socket', '<code>4000</code>-<code>4499</code>');
  check(react('Form.tsx'), 'new Set([413, 429])', 'components/gio-form', 'The server&apos;s own <code>413</code> or <code>429</code>');
  check(
    read('packages', 'giojs-core', 'src', 'ssr.ts'),
    'SEE_OTHER_STATUSES: ReadonlySet<number> = new Set([301, 302, 303])',
    'components/gio-form',
    '301, 302 or 303 redirect',
  );
  check(
    read('crates', 'giojs-server', 'src', 'config.rs'),
    'fn default_max_body_bytes() -> usize {\n    2 * 1024 * 1024',
    'components/gio-form',
    '(2 MiB by default)',
  );
  check(read('crates', 'giojs-font', 'src', 'lib.rs'), 'font-display:swap', 'components/gio-font', 'font-display: swap');
});

/** `[export] const NAME = <number expression>` in a TypeScript source file, evaluated. */
function tsNumber(file, name) {
  const m = new RegExp(`const ${name}(?::[^=]*)? = ([0-9_ *]+);`).exec(read(file));
  assert.ok(m, `${name} not found in ${file} - update this test if it moved`);
  return m[1].replaceAll('_', '').split('*').reduce((product, factor) => product * Number(factor), 1);
}

test('the function reference states the limits and defaults the code uses', () => {
  const core = (name) => `packages/giojs-core/src/${name}`;
  const page = (slug) => docsPage(`functions/${slug}`);

  // redirect(): 303 unless told otherwise, and only these statuses.
  const action = read(core('action.ts'));
  assert.match(action, /const \{ status = 303, headers \}/, 'redirect() default status moved');
  const statuses = /REDIRECT_STATUSES[^=]*= new Set\(\[([^\]]*)\]\)/.exec(action)?.[1].replace(/\s/g, '');
  assert.equal(statuses, '301,302,303,307,308');
  assert.match(page('redirect'), /default: '303'/);
  assert.match(page('redirect'), /must be 301, 302, 303, 307 or 308/);

  // revalidateTag / revalidatePath: confirmation timeout, calls in flight, tag and path limits.
  const revalidate = core('revalidate.ts');
  const timeoutSeconds = tsNumber(revalidate, 'REVALIDATE_TIMEOUT_MS') / 1000;
  const inFlight = tsNumber(revalidate, 'MAX_REVALIDATIONS_IN_FLIGHT');
  for (const slug of ['revalidate-path', 'revalidate-tag']) {
    assert.match(page(slug), new RegExp(`${timeoutSeconds}\\s+seconds`), slug);
    assert.match(page(slug), new RegExp(`at\\s+most\\s+${inFlight}\\b|most\\s+${inFlight}\\s+calls`), slug);
  }
  assert.match(page('revalidate-tag'), new RegExp(`at most ${tsNumber(revalidate, 'MAX_CACHE_TAG_BYTES')} bytes`));
  assert.match(page('revalidate-tag'), new RegExp(`at most ${tsNumber(revalidate, 'MAX_CACHE_TAGS')} tags`));
  assert.match(page('revalidate-path'), new RegExp(`longer than ${tsNumber(revalidate, 'MAX_PATH_BYTES')} bytes`));

  // createSessionStorage: default lifetime and cookie name, secret length.
  assert.match(page('create-session-storage'), new RegExp(`default: '${tsNumber(core('session.ts'), 'DEFAULT_MAX_AGE')}'`));
  assert.match(read(core('session.ts')), /const DEFAULT_COOKIE_NAME = 'gio_session';/);
  assert.match(page('create-session-storage'), /default: "'gio_session'"/);
  const minSecret = tsNumber(core('cookies.ts'), 'MIN_SECRET_BYTES');
  assert.match(page('create-session-storage'), new RegExp(`at\\s+least\\s+${minSecret}\\s+bytes`));
  assert.match(page('cookies'), new RegExp(`at\\s+least\\s+${minSecret}\\s+bytes`));

  // broadcast: room name and rooms-per-socket limits.
  assert.match(page('broadcast'), new RegExp(`at\\s+most\\s+${tsNumber(core('ws-hub.ts'), 'MAX_ROOM_NAME_BYTES')}\\s+bytes`));
  assert.match(page('broadcast'), new RegExp(`up to ${tsNumber(core('ws-hub.ts'), 'MAX_ROOMS_PER_SOCKET')} rooms`));

  // createTestServer: readiness timeout.
  const readyMs = /options\.timeoutMs \?\? ([0-9_]+)/.exec(read(core('testing.ts')))?.[1].replaceAll('_', '');
  assert.ok(readyMs, 'createTestServer timeout default moved');
  assert.match(page('create-test-server'), new RegExp(`default: '${readyMs}'`));
});

test('the function reference states the server limits it quotes', () => {
  const server = (name) => `crates/giojs-server/src/${name}`;
  const page = (slug) => docsPage(`functions/${slug}`);

  // Request body errors: the [server] max_body_bytes default and the IPC message cap behind 0.
  const bodyDefault = /fn default_max_body_bytes\(\) -> usize \{\s*2 \* 1024 \* 1024\s*\}/;
  assert.match(read(server('config.rs')), bodyDefault, 'max_body_bytes default moved - update request-errors');
  assert.match(page('request-errors'), /2 MiB by\s+default/);
  assert.match(read(server('ipc.rs')), /pub const MAX_IPC_MESSAGE_SIZE: usize = 64 \* 1024 \* 1024;/);
  assert.match(read(server('ipc.rs')), /pub const MAX_BINARY_BODY_BYTES: usize = MAX_IPC_MESSAGE_SIZE \/ 4 \* 3;/);
  assert.match(page('request-errors'), /64 MiB message cap \(about 48 MiB of binary body\)/);

  // cspNonce: 24 random bytes per response (192 bits, 32 base64 characters), and where the placeholder lives.
  assert.match(read(server('security.rs')), /const NONCE_BYTES: usize = 24;/);
  assert.match(page('csp-nonce'), /192 bits \(32 base64 characters\)/);
  assert.match(read(server('config.rs')), /fn default_cache_disk_path\(\) -> String \{\s*"\.gio\/cache\/pages"/);
  assert.match(read(server('main.rs')), /load_or_create_nonce_placeholder\(\s*&cache_dir\.join\("meta"\)/);
  assert.match(page('csp-nonce'), /<code>meta\/csp-nonce-placeholder-\*<\/code>[\s\S]*<code>\.gio\/cache\/pages<\/code>/);
});

test('the file-convention pages state the router and metadata-route facts the code decides', () => {
  // app/sitemap.ts, robots.ts and manifest.ts: the default revalidate.
  const routes = read('packages/giojs-core/src/metadata-routes.ts');
  const revalidate = /export const DEFAULT_METADATA_REVALIDATE = (\d+);/.exec(routes)?.[1];
  assert.ok(revalidate, 'DEFAULT_METADATA_REVALIDATE not found - update this test');
  for (const page of ['sitemap', 'robots', 'manifest']) {
    assert.match(docsPage(`file-conventions/${page}`), new RegExp(`default: '${revalidate}'`), page);
  }
  assert.match(docsPage('file-conventions'), new RegExp(`default ${revalidate} seconds`));

  // route.ts: the method handlers a file may export.
  const methods = /HANDLER_METHODS = \[([^\]]+)\]/.exec(read('packages/giojs-core/src/router.ts'))?.[1];
  assert.ok(methods, 'HANDLER_METHODS not found - update this test');
  const routePage = docsPage('file-conventions/route');
  for (const method of methods.match(/[A-Z]+/g)) {
    assert.match(routePage, new RegExp(`name: '${method}'`), `the route.ts page lacks ${method}`);
  }

  // .env files: the candidates, highest precedence first.
  const rust = read('crates/giojs-server/src/env_files.rs');
  const candidates = /pub fn candidate_files[\s\S]*?\[([\s\S]*?)\]\n\}/.exec(rust)?.[1] ?? '';
  const order = [...candidates.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['.env.{mode}.local', '.env.local', '.env.{mode}', '.env'],
    'env_files.rs changed the .env order - update the .env files page');
  const envPage = docsPage('file-conventions/env-files');
  const shown = ['<code>.env.development.local</code>', '<code>.env.local</code></td>', '<code>.env.development</code>', '<code>.env</code></td>']
    .map((s) => envPage.indexOf(s));
  assert.ok(shown.every((at, n) => at > 0 && (n === 0 || at > shown[n - 1])), `the .env files page shows another order: ${shown}`);
});

test('the public/ and route.ts pages state the limits the server decides', () => {
  // public/: the root files' Cache-Control and the size of the root index.
  const publicFiles = read('crates/giojs-server/src/public_files.rs');
  const cacheControl = /PUBLIC_ROOT_CACHE_CONTROL: &str = "([^"]+)";/.exec(publicFiles)?.[1];
  const maxIndexed = /MAX_INDEXED_FILES: usize = ([\d_]+);/.exec(publicFiles)?.[1];
  assert.ok(cacheControl && maxIndexed, 'public_files.rs constants not found - update this test');
  const publicPage = docsPage('file-conventions/public-folder');
  assert.ok(publicPage.includes(`<code>Cache-Control: ${cacheControl}</code>`), 'public/ page: root Cache-Control');
  const indexSize = Number(maxIndexed.replace(/_/g, '')).toLocaleString('en-US');
  assert.ok(publicPage.includes(`holds up to ${indexSize} files`), 'public/ page: root index size');

  // route.ts: the default [server] max_body_bytes.
  const config = read('crates/giojs-server/src/config.rs');
  const body = /fn default_max_body_bytes\(\) -> usize \{\s*(\d+) \* 1024 \* 1024\s*\}/.exec(config)?.[1];
  assert.ok(body, 'default_max_body_bytes not found - update this test');
  assert.match(docsPage('file-conventions/route'), new RegExp(`${body} MiB by default`));

  // route.ts and page.tsx: the 405 body.
  const ssr = read('packages/giojs-core/src/ssr.ts');
  assert.match(ssr, /body: JSON\.stringify\(\{ error: 'Method Not Allowed' \}\)/, 'the 405 body changed - update the route.ts and page.tsx pages');
  for (const page of ['file-conventions/route', 'file-conventions/page']) {
    assert.ok(docsPage(page).includes(`{'{"error":"Method Not Allowed"}'}`), `${page}: 405 body`);
  }
});

test('the page-exports reference states the limits and codes the code decides', () => {
  const core = (file) => read('packages/giojs-core/src', file);
  const constant = (file, name) => {
    const m = new RegExp(`(?:export )?const ${name}(?::[^=]+)? = ([^;]+);`).exec(core(file));
    assert.ok(m, `${name} not found in packages/giojs-core/src/${file} - update this test`);
    return m[1].trim();
  };
  // tags: 64 per render, 256 bytes each, `_gio:` reserved.
  const tags = docsPage('page-exports/tags');
  assert.equal(constant('revalidate.ts', 'MAX_CACHE_TAGS'), '64');
  assert.equal(constant('revalidate.ts', 'MAX_CACHE_TAG_BYTES'), '256');
  assert.equal(constant('revalidate.ts', 'RESERVED_TAG_PREFIX'), "'_gio:'");
  assert.match(tags, /at most 256 bytes/);
  assert.match(tags, /at most 64 tags/);
  assert.match(tags, /<code>_gio:<\/code> are reserved/);
  // revalidate = false is one year; metadata routes default to 3600.
  const ssr = core('ssr.ts');
  assert.match(ssr, /pageModule\.revalidate === false\s*\?\s*31536000/);
  assert.equal(constant('metadata-routes.ts', 'DEFAULT_METADATA_REVALIDATE'), '3600');
  const revalidate = docsPage('page-exports/revalidate');
  assert.match(revalidate, /<code>31536000<\/code> seconds/);
  assert.match(revalidate, /defaults to\{' '\}\s*<code>3600<\/code>/);
  // redirect() defaults to 303; the getServerSideProps redirect object is 301/302.
  assert.match(core('action.ts'), /const \{ status = 303, headers \}/);
  assert.match(ssr, /status: result\.redirect\.permanent \? 301 : 302/);
  assert.match(docsPage('page-exports/action'), /<code>303 See Other<\/code>/);
  // route.ts methods, and the WebSocket close codes.
  assert.match(core('router.ts'), /HANDLER_METHODS = \['GET', 'POST', 'PUT', 'PATCH', 'DELETE'\] as const/);
  assert.equal(constant('ws-ipc.ts', 'WS_REJECTED_CODE'), '4401');
  assert.equal(constant('ws-ipc.ts', 'WS_NO_HANDLER_CODE'), '4404');
  const ws = docsPage('page-exports/ws-handler');
  assert.match(ws, /<code>4401<\/code> <code>unauthorized<\/code>/);
  assert.match(ws, /<code>4404<\/code> <code>no websocket handler<\/code>/);
});

test('the shell and getServerSideProps references match the PPR path and query parsing', () => {
  const ssr = read('packages/giojs-core/src/ssr.ts');
  const main = read('crates/giojs-server/src/main.rs');
  const shell = docsPage('page-exports/shell');
  // PPR streams GET renders only, so a HEAD request (curl -I) never shows a ppr X-Gio-Cache.
  assert.match(ssr, /const streamingAvailable =\s*extras\?\.streaming === true &&\s*req\.method === 'GET'/);
  assert.doesNotMatch(shell, /curl -sI/);
  // The holes fallback reloads once with this cookie.
  assert.match(main, /const PPR_BYPASS_COOKIE: &str = "__gio_ppr_bypass";/);
  assert.match(shell, /<code>__gio_ppr_bypass<\/code>/);
  // A query string becomes one value per name, the last one winning (a HashMap collect).
  assert.match(main, /fn parse_query\(query_str: &str\) -> HashMap<String, String> \{[\s\S]{0,400}?\.collect\(\)/);
  assert.match(docsPage('page-exports/get-server-side-props'), /the last one when a name repeats/);
});

// ── gio.toml reference (/docs/configuration/<section>) ──────────────────────

/**
 * Where each config struct of packages/giojs/gio.schema.json is documented:
 * its section page, the table header it has in the overview's "Full
 * reference" block, and the keys documented elsewhere (sub-tables with their
 * own header or page, camelCase aliases). `prefix` is how the page names its
 * keys (`hsts.max_age`).
 */
const CONFIG_DOCS = {
  AppConfig: { page: 'app', block: '[app]' },
  ServerConfig: { page: 'server', block: '[server]', skip: ['tls'] },
  TlsConfig: { page: 'server-tls', block: '[server.tls]' },
  SecurityConfig: { page: 'security', block: '[security]', skip: ['csrf', 'websocket'], blockSkip: ['headers'] },
  HstsPolicy: { page: 'security', block: '[security]', prefix: 'hsts.' },
  CsrfConfig: { page: 'security-csrf', block: '[security.csrf]' },
  WebSocketSecurityConfig: { page: 'security-websocket', block: '[security.websocket]' },
  CacheConfig: { page: 'cache', block: '[cache]' },
  CompressionConfig: { page: 'compression', block: '[compression]' },
  PrefetchConfig: { page: 'prefetch', block: '[prefetch]' },
  FontEntry: { page: 'fonts', block: '[[fonts]]' },
  ImageConfig: { page: 'images', block: '[images]', blockSkip: ['remote_patterns'] },
  RemotePattern: { page: 'images', block: '[[images.remote_patterns]]' },
  CssConfig: { page: 'css', block: '[css]' },
  WebsocketConfig: { page: 'websocket', block: '[websocket]' },
  RateLimitEntry: { page: 'rate-limits', block: '[[rate_limits]]' },
  RedirectRule: { page: 'redirects', block: '[[redirects]]' },
  RewriteRule: { page: 'rewrites', block: '[[rewrites]]' },
  HeaderRule: { page: 'headers', block: '[[headers]]', blockSkip: ['headers'] },
  GuardRule: { page: 'guards', block: '[[guards]]', skip: ['requireCookie', 'requireSession', 'redirectTo'] },
  I18nConfig: { page: 'i18n', block: '[i18n]' },
  MetricsConfig: { page: 'metrics', block: '[metrics]' },
  HealthConfig: { page: 'health', block: '[health]' },
  EnvConfig: { page: 'env', block: '[env]' },
  LoggingConfig: { page: 'logging', block: '[logging]' },
  RevalidateConfig: { page: 'revalidate', block: '[revalidate]' },
  DevConfig: { page: 'dev', block: '[dev]' },
};

const configSchema = () => JSON.parse(read('packages/giojs/gio.schema.json'));

/** The `ConfigKeyTable` rows of a page: key -> default literal (or undefined). */
function configKeyRows(source) {
  const rows = new Map();
  for (const m of source.matchAll(/\{ key: '([^']+)', type: '[^']*'(?:, default: '([^']*)')?/g)) {
    rows.set(m[1], m[2]);
  }
  return rows;
}

/** The overview's "Full reference" TOML block, split by table header. */
function fullReferenceTables() {
  const page = docsPage('configuration');
  const block = /<h2 id="full-reference">[\s\S]*?<CodeBlock lang="toml" code=\{`([\s\S]*?)`\}/.exec(page);
  assert.ok(block, 'the Full reference block is missing from /docs/configuration');
  const tables = new Map();
  let current = '';
  for (const line of block[1].split('\n')) {
    const header = /^(\[\[?[^\]]+\]\]?)/.exec(line);
    if (header) current = header[1];
    tables.set(current, `${tables.get(current) ?? ''}${line}\n`);
  }
  return tables;
}

test('every top-level gio.toml section has a reference page in the gio.toml nav', () => {
  const sections = [...read('crates/giojs-server/src/config.rs').matchAll(/^\s*\("([a-z0-9_]+)", (?:true|false)\),$/gm)]
    .map((m) => m[1]);
  assert.ok(sections.length > 20, `SECTIONS not found in config.rs (${sections.length}) - update this test`);
  const nav = read('docs-site/components/nav/api-gio-toml.ts');
  for (const section of sections) {
    const route = section.replace(/_/g, '-');
    assert.ok(existsSync(join(siteDir, 'app', 'docs', 'configuration', route, 'page.tsx')), `no page for [${section}]`);
    assert.ok(nav.includes(`'/docs/configuration/${route}'`), `[${section}] is not in nav/api-gio-toml.ts`);
  }
});

test('every gio.toml key is documented on its section page with the default the server uses', () => {
  const { definitions } = configSchema();
  for (const [name, doc] of Object.entries(CONFIG_DOCS)) {
    const definition = definitions[name];
    assert.ok(definition?.properties, `${name} is not in gio.schema.json - update CONFIG_DOCS`);
    const rows = configKeyRows(docsPage(`configuration/${doc.page}`));
    for (const [key, property] of Object.entries(definition.properties)) {
      if (doc.skip?.includes(key)) continue;
      const rowKey = `${doc.prefix ?? ''}${key}`;
      assert.ok(rows.has(rowKey), `/docs/configuration/${doc.page} has no row for ${rowKey} (${name})`);
      // No default, or unset by default (`csp`): the page shows none.
      if (property.default === undefined || property.default === null) continue;
      const shown = rows.get(rowKey);
      assert.ok(shown !== undefined, `/docs/configuration/${doc.page}: ${rowKey} shows no default (${JSON.stringify(property.default)})`);
      assert.deepEqual(JSON.parse(shown), property.default, `/docs/configuration/${doc.page}: default of ${rowKey}`);
    }
  }
});

test('the Full reference block names every gio.toml key under its table', () => {
  const { definitions } = configSchema();
  const tables = fullReferenceTables();
  for (const [name, doc] of Object.entries(CONFIG_DOCS)) {
    const text = tables.get(doc.block);
    assert.ok(text, `the Full reference block has no ${doc.block} table`);
    for (const key of Object.keys(definitions[name].properties)) {
      if (doc.skip?.includes(key) || doc.blockSkip?.includes(key)) continue;
      assert.match(text, new RegExp(`(^|[\\s{#,])${key}\\b`, 'm'), `${doc.block} in the Full reference block lacks ${key}`);
    }
  }
});

test('the startup warnings the gio.toml pages quote are the ones the server logs', () => {
  const source = read('crates/giojs-server/src/config_check.rs');
  const body = source.slice(source.indexOf('pub fn protections_off_warnings'), source.indexOf('fn local_font_errors'));
  // Rust string literals, `\`-newline continuations joined, placeholders as wildcards.
  const formats = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/gs)]
    .map((m) => m[1].replace(/\\\n\s*/g, '').replace(/\\"/g, '"'))
    .filter((literal) => literal.includes(': ') || literal.includes(' - '));
  const patterns = formats.map((format) => new RegExp(
    `^${format.split(/\{[^}]*\}/).map((part) => part.replace(/[.*+?^$()|[\]\\]/g, '\\$&')).join('.+?')}$`,
  ));
  let quoted = 0;
  for (const file of pageFiles(join(siteDir, 'app', 'docs', 'configuration'))) {
    const block = /<StartupWarnings rows=\{\[([\s\S]*?)\]\} \/>/.exec(readFileSync(file, 'utf8'));
    if (!block) continue;
    for (const m of block[1].matchAll(/text: (?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) {
      const text = (m[1] ?? m[2]).replace(/\\'/g, "'");
      quoted += 1;
      assert.ok(patterns.some((pattern) => pattern.test(text)), `${file}: no such warning in config_check.rs:\n${text}`);
    }
  }
  assert.ok(quoted >= 15, `only ${quoted} warnings quoted - update this test`);
});

// ── CLI reference (/docs/cli/*, /docs/create-giojs, /docs/gio-config) ──────

/** A command of `gio` (packages/giojs/bin/lib/commands.js) and its reference page. */
const CLI_PAGES = {
  dev: 'cli/dev', start: 'cli/start', build: 'cli/build', export: 'cli/export', routes: 'cli/routes',
  typegen: 'cli/typegen', doctor: 'cli/doctor', info: 'cli/info', cache: 'cli/cache-explain',
  bench: 'cli/bench', migrate: 'cli/migrate', add: 'cli/add', help: 'cli/help',
};

test('every gio command has a reference page, linked from the CLI overview', () => {
  const commands = read('packages/giojs/bin/lib/commands.js');
  const table = /const COMMANDS = \{([\s\S]*?)\n\};/.exec(commands);
  assert.ok(table, 'COMMANDS not found in commands.js - update this test');
  const names = [...table[1].matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]);
  assert.deepEqual(names.sort(), Object.keys(CLI_PAGES).sort(), 'a gio command without a docs page (CLI_PAGES)');
  const overview = docsPage('cli');
  for (const [name, route] of Object.entries(CLI_PAGES)) {
    assert.ok(existsSync(join(siteDir, 'app', 'docs', ...route.split('/'), 'page.tsx')), `gio ${name}: /docs/${route}`);
    assert.ok(overview.includes(`href="/docs/${route}"`), `the CLI overview does not link /docs/${route}`);
  }
});

test("gio bench's documented defaults are bench.mjs's", () => {
  const bench = read('packages/giojs/bin/bench.mjs');
  const page = docsPage('cli/bench');
  for (const [constant, flag] of [
    ['DEFAULT_CONNECTIONS', 'connections'],
    ['DEFAULT_DURATION_SECONDS', 'duration'],
    ['DEFAULT_WARMUP_SECONDS', 'warmup'],
  ]) {
    const value = new RegExp(`const ${constant} = (\\d+);`).exec(bench)?.[1];
    assert.ok(value, `${constant} not found in bench.mjs - update this test`);
    assert.match(page, new RegExp(`name: '--${flag} <[a-z]+>',[^}]*default: '${value}'`), `--${flag} default`);
    assert.ok(page.includes(`[--${flag} ${value}]`), `the usage line shows --${flag} ${value}`);
  }
});

test('gio build standalone: the documented targets are the ones it accepts', () => {
  const list = /const TARGETS = \[([\s\S]*?)\];/.exec(read('packages/giojs/bin/standalone.mjs'));
  assert.ok(list, 'TARGETS not found in standalone.mjs - update this test');
  const targets = [...list[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]).sort();
  const row = /name: '--target <platform>',[\s\S]*?description: <>([\s\S]*?)<\/>,/.exec(docsPage('cli/build-standalone'));
  assert.ok(row, 'the --target row is missing');
  const shown = [...row[1].matchAll(/<code>((?:linux|win32|darwin)-[\w-]+)<\/code>/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(shown)].sort(), targets);
});

test("gio doctor's documented checks are the ones it runs, in order", () => {
  const doctor = read('packages/giojs/bin/lib/doctor.js');
  const run = /function runChecks\(facts\) \{\s*return \[([\s\S]*?)\];/.exec(doctor);
  assert.ok(run, 'runChecks not found in doctor.js - update this test');
  const ids = [...run[1].matchAll(/(\w+)Check\(facts\)/g)].map(([, fn]) => {
    const id = new RegExp(`function ${fn}Check\\(facts\\) \\{[\\s\\S]*?check\\('(\\w+)'`).exec(doctor)?.[1];
    assert.ok(id, `${fn}Check has no check id`);
    return id;
  });
  const page = docsPage('cli/doctor');
  const table = page.slice(page.indexOf('id="checks"'), page.indexOf('id="output"'));
  const documented = [...table.matchAll(/<tr><td><code>(\w+)<\/code><\/td>/g)].map((m) => m[1]);
  assert.deepEqual(documented, ids);
});

test('giojs-server --check-config: every report field is documented', () => {
  const check = read('crates/giojs-server/src/config_check.rs');
  const body = check.slice(check.indexOf('fn run('), check.indexOf('fn warnings('));
  const fields = new Set([...body.matchAll(/^\s+"(\w+)": /gm)].map((m) => m[1]));
  for (const nested of ['host', 'port', 'portSource', 'tls']) fields.delete(nested);
  assert.ok(fields.size > 10, 'no report fields parsed - update this test');
  const page = docsPage('cli/giojs-server');
  const table = page.slice(page.indexOf('id="report"'), page.indexOf('id="examples"'));
  for (const field of [...fields, 'ok', 'errors']) {
    assert.ok(table.includes(`name: '${field}'`), `report field ${field} is undocumented`);
  }
});

test("giojs-server's documented shutdown time is the server's", () => {
  const drain = rustSeconds('crates/giojs-server/src/main.rs', 'SHUTDOWN_DRAIN_TIMEOUT');
  const grace = rustSeconds('crates/giojs-server/src/ipc.rs', 'WORKER_SHUTDOWN_GRACE');
  const page = docsPage('cli/giojs-server');
  assert.match(page, new RegExp(`up to ${drain}\\s+seconds to drain`));
  assert.match(page, new RegExp(`up to ${grace} seconds for each worker`));
  assert.match(page, new RegExp(`at least ${drain + grace} seconds`));
});

test('every create-giojs option in its --help is on the create-giojs page', () => {
  const usage = /export const USAGE = `([\s\S]*?)`;/.exec(read('packages/giojs-cli/src/args.ts'));
  assert.ok(usage, 'USAGE not found in packages/giojs-cli/src/args.ts - update this test');
  const page = docsPage('create-giojs');
  for (const flag of new Set(usage[1].match(/(?<![\w-])--?[a-z][\w-]*/g))) {
    assert.ok(page.includes(flag), `create-giojs ${flag} is not on /docs/create-giojs`);
  }
});

test('gio.config.ts: the documented keys are the ones validateGioConfig accepts', () => {
  const keys = /const CONFIG_KEYS: [^=]*= \[([^\]]*)\]/.exec(read('packages/giojs-core/src/gio-config.ts'));
  assert.ok(keys, 'CONFIG_KEYS not found in gio-config.ts - update this test');
  const accepted = [...keys[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const page = docsPage('gio-config');
  const table = page.slice(page.indexOf('id="keys"'), page.indexOf('id="gionodeplugin"'));
  assert.deepEqual([...table.matchAll(/name: '(\w+)'/g)].map((m) => m[1]), accepted);
});

/** Every file below `dir` (repo-relative) whose name matches `pattern`, tests and fixtures left out. */
function sourceFiles(dir, pattern) {
  return readdirSync(join(repoDir, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      const skip = ['node_modules', 'test', 'tests', 'templates', 'test-fixtures'];
      return skip.includes(entry.name) ? [] : sourceFiles(rel, pattern);
    }
    return pattern.test(entry.name) && !/\.test\./.test(entry.name) ? [rel] : [];
  });
}

test('the env-vars page names every GIO_* variable the server, worker and CLIs read', () => {
  const found = new Map();
  const note = (name, file) => found.has(name) || found.set(name, file);
  // Rust: string literals outside the test modules (env::var("X"), .env("X", ..), const X: &str = "X").
  for (const file of sourceFiles('crates/giojs-server/src', /\.rs$/)) {
    const code = read(file).split(/#\[cfg\(test\)\]/)[0];
    for (const m of code.matchAll(/"(GIO_[A-Z0-9_]*[A-Z0-9])"/g)) note(m[1], file);
  }
  // JS/TS: process.env.X, env.X, env['X'] and 'X' constants (not `error.code = 'GIO_...'`).
  for (const dir of ['packages/giojs-core/src', 'packages/giojs/bin', 'packages/giojs-cli/src']) {
    for (const file of sourceFiles(dir, /\.(ts|js|mjs|cjs)$/)) {
      const code = read(file);
      const reads = /\benv(?:\.|\[['"])(GIO_[A-Z0-9_]*[A-Z0-9])\b|(?<!\.code\s*)=\s*['"](GIO_[A-Z0-9_]*[A-Z0-9])['"]/g;
      for (const m of code.matchAll(reads)) {
        note(m[1] ?? m[2], file);
      }
    }
  }
  found.delete('GIO_PUBLIC_X'); // an example name; the GIO_PUBLIC_* family is documented
  assert.ok(found.size > 20, `found only ${found.size} variables - update this test`);
  const page = docsPage('env-vars');
  const missing = [...found].filter(([name]) => !page.includes(name)).map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(missing, [], 'document these on /docs/env-vars');
});

test('the endpoints page states the revalidation limits and the health fields the server uses', () => {
  const rs = read('crates/giojs-server/src/revalidate.rs');
  const constant = (name) => {
    const m = new RegExp(`const ${name}: [^=]+= ([^;]+);`).exec(rs);
    assert.ok(m, `${name} not found in revalidate.rs - update this test if it moved`);
    return m[1].trim();
  };
  const page = docsPage('endpoints');
  assert.equal(constant('FAILURE_LIMIT'), '10');
  assert.match(page, /After 10 failed attempts/);
  assert.equal(constant('FAILURE_WINDOW'), 'Duration::from_secs(60)');
  assert.equal(constant('MAX_BODY_BYTES'), '64 * 1024');
  assert.match(page, /at most 64 KiB/);
  assert.equal(constant('MAX_TAGS'), '64');
  assert.equal(constant('MAX_PATHS'), '64');
  assert.equal(constant('MAX_TAG_BYTES'), '256');
  // Every key of the /_gio/health body is a row of the page's field table.
  const health = /fn health_body[\s\S]*?\n}\n/.exec(read('crates/giojs-server/src/main.rs'));
  assert.ok(health, 'health_body not found in main.rs - update this test if it moved');
  const keys = new Set([...health[0].matchAll(/"([a-zA-Z]+)":/g)].map((m) => m[1]));
  assert.ok(keys.size >= 8, `found only ${keys.size} health fields`);
  for (const key of keys) {
    if (key === 'configured' || key === 'ready') continue; // inside `workers`
    assert.match(page, new RegExp(`name: '${key}'`), `/_gio/health field ${key} is not documented`);
  }
});

/** The body of `fn name` in a Rust source file, up to the next top-level `}`. */
function rustFnBody(file, name) {
  const source = read(file);
  const start = source.indexOf(`fn ${name}(`);
  assert.ok(start >= 0, `fn ${name} not found in ${file} - update this test if it moved`);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

/** The number a `fn name() -> T { N }` default returns (`2 * 1024 * 1024` is evaluated). */
function rustDefault(file, name) {
  const m = /\{\s*([\d_ *]+?)\s*\}\s*$/.exec(rustFnBody(file, name));
  assert.ok(m, `fn ${name} in ${file} does not return a plain number - update this test`);
  return m[1].split('*').reduce((product, factor) => product * Number(factor.replace(/_/g, '').trim()), 1);
}

test('the protections page names every key startup warns about', () => {
  const body = rustFnBody('crates/giojs-server/src/config_check.rs', 'protections_off_warnings');
  const keys = new Set([
    ...[...body.matchAll(/"\[[a-z.]+\] ([a-z_]+)/g)].map((m) => m[1]),
    ...[...body.matchAll(/\(\s*"([a-z_]+)",\s*images\./g)].map((m) => m[1]),
    ...[...body.matchAll(/([a-z_]+) = 0 - one client/g)].map((m) => m[1]),
  ]);
  assert.ok(keys.size >= 15, `parsed only ${[...keys].join(', ')} - update this test`);
  const page = docsPage('guides/security-switches');
  const missing = [...keys].filter((key) => !page.includes(`<code>${key}`) && !page.includes(`] ${key} = `));
  assert.deepEqual(missing, [], 'keys protections_off_warnings warns about that the page does not list');
});

test('the protections page states the server defaults', () => {
  const config = 'crates/giojs-server/src/config.rs';
  const page = docsPage('guides/security-switches');
  const stated = {
    max_body_bytes: rustDefault(config, 'default_max_body_bytes'),
    max_connections: rustDefault(config, 'default_max_connections_server'),
    tls_handshake_timeout_secs: rustDefault(config, 'default_tls_handshake_timeout_secs'),
    header_read_timeout_secs: rustDefault(config, 'default_header_read_timeout_secs'),
    request_body_timeout_secs: rustDefault(config, 'default_request_body_timeout_secs'),
    idle_timeout_secs: rustDefault(config, 'default_idle_timeout_secs'),
    http2_max_concurrent_streams: rustDefault(config, 'default_http2_max_concurrent_streams'),
    http2_keep_alive_interval_secs: rustDefault(config, 'default_http2_keep_alive_interval_secs'),
    max_concurrent: rustDefault(config, 'default_prefetch_max_concurrent'),
    max_per_second: rustDefault(config, 'default_prefetch_max_per_second'),
    swr_multiplier: rustDefault(config, 'default_cache_swr_multiplier'),
    max_remote_bytes: rustDefault(config, 'default_image_max_remote_bytes'),
  };
  for (const [key, value] of Object.entries(stated)) {
    assert.ok(
      page.includes(`<code>${key} = ${value}</code>`) || page.includes(`] ${key} = ${value}</code>`),
      `the page should state ${key} = ${value}`,
    );
  }
  assert.equal(rustDefault(config, 'default_max_connections'), 1000);
  assert.ok(page.includes('<code>[websocket] max_connections = 1000</code>'));
});

test('the i18n guide states the default detection order and the cookie name', () => {
  const body = rustFnBody('crates/giojs-server/src/config.rs', 'default_detect_from');
  const order = [...body.matchAll(/"([a-z-]+)"\.to_string\(\)/g)].map((m) => m[1]);
  assert.deepEqual(order, ['path', 'accept-language', 'cookie'], 'update the i18n guide and this test');
  const page = docsPage('i18n');
  assert.ok(page.includes(`detect_from = ${JSON.stringify(order).replace(/,/g, ', ')}   # the default order`));
  assert.match(read('crates/giojs-i18n/src/lib.rs'), /strip_prefix\("gio_locale="\)/, 'the cookie is gio_locale');
});

test('the i18n pages state how Accept-Language is read', () => {
  const lib = read('crates/giojs-i18n/src/lib.rs');
  // Highest q first, stable for ties; q=0 never chosen; the configured spelling.
  assert.match(lib, /ranges\.sort_by_key\(\|&\(_, q\)\| std::cmp::Reverse\(q\)\)/, 'q-value ordering changed - update the docs');
  assert.match(lib, /\(q > 0\)\.then_some/, 'q=0 handling changed - update the docs');
  assert.doesNotMatch(lib, /to_ascii_lowercase/, 'a detected locale is the configured string');
  assert.ok(docsPage('i18n').includes('<code>de;q=0.1, en</code> picks{\' \'}'));
  assert.ok(docsPage('configuration/i18n').includes('tried by quality value, highest first'));
  assert.ok(docsPage('hooks/use-locale').includes('tried from the highest <code>q</code> weight down'));
});

test('the streaming guide states the shutdown drain, render deadline and event buffer', () => {
  const page = docsPage('guides/streaming');
  const drain = rustSeconds('crates/giojs-server/src/main.rs', 'SHUTDOWN_DRAIN_TIMEOUT');
  assert.ok(page.includes(`up to ${drain} seconds to finish`), `the drain is ${drain}s`);
  const render = rustSeconds('crates/giojs-server/src/ipc.rs', 'DEFAULT_RENDER_TIMEOUT');
  assert.ok(page.includes(`render_timeout_secs</code> (${render} seconds)`), `the render deadline is ${render}s`);
  const buffered = /MAX_BUFFERED_FRAME_BYTES = (\d+) \* 1024 \* 1024/.exec(read('packages/giojs-core/src/ipc.ts'));
  assert.ok(buffered, 'MAX_BUFFERED_FRAME_BYTES moved - update this test');
  assert.ok(page.includes(`more than ${buffered[1]} MiB is waiting`), `events drop past ${buffered[1]} MiB`);
});

test('the redirecting guide states the redirect statuses each API accepts', () => {
  const action = read('packages/giojs-core/src/action.ts');
  assert.match(action, /new Set\(\[301, 302, 303, 307, 308\]\)/);
  assert.match(action, /const \{ status = 303, headers \}/);
  const rules = read('crates/giojs-server/src/rules.rs');
  assert.match(rules, /301 \| 302 \| 307 \| 308 =>/);
  assert.equal(rustDefault('crates/giojs-server/src/rules.rs', 'default_redirect_status'), 302);
  assert.match(docsPage('guides/redirecting'), /accept all of those but\{' '\}\s*<code>303<\/code>/);
});

test('the streaming guide states the route-body buffer and the backpressure threshold', () => {
  const page = docsPage('guides/streaming');
  assert.match(read('packages/giojs-core/src/ssr.ts'), /ROUTE_BUFFER_LIMIT_BYTES = 1024 \* 1024;/, 'update the guide and this test');
  assert.match(read('crates/giojs-server/src/ipc.rs'), /const STREAM_PAUSE_BYTES: usize = 1024 \* 1024;/, 'update the guide and this test');
  assert.ok(page.includes('at most 1 MiB crosses from the worker in one'));
  assert.ok(page.includes('once about 1 MiB is waiting'));
});

test('the protections page states the request-id and revalidation-token rules', () => {
  const page = docsPage('guides/security-switches');
  assert.match(read('crates/giojs-server/src/client_identity.rs'), /const MAX_REQUEST_ID_LEN: usize = 128;/);
  assert.ok(page.includes('must be 1 to 128 characters'));
  assert.match(read('crates/giojs-server/src/revalidate.rs'), /pub const MIN_TOKEN_BYTES: usize = 32;/);
  assert.ok(page.includes('must be at least 32 bytes'));
});

test('the caching guide states the stale window and what revalidate = false means', () => {
  const page = docsPage('caching');
  const swr = rustDefault('crates/giojs-server/src/config.rs', 'default_cache_swr_multiplier');
  // The example is revalidate = 60: a window of swr x 60 seconds, i.e. swr minutes.
  assert.ok(page.includes(`(${swr} times by default: up to ${swr} minutes for`), `swr_multiplier default ${swr}`);
  assert.match(read('packages/giojs-core/src/ssr.ts'), /\? 31536000\b/, 'revalidate = false moved - update the guide and this test');
  assert.ok(page.includes('<code>revalidate = false</code> is a one-year max age (<code>31536000</code> seconds'));
});

test('the health-check samples show a deployment id of the derived length', () => {
  const derive = rustFnBody('crates/giojs-server/src/ipc.rs', 'derive_deployment_id');
  assert.match(derive, /16 hex chars/, 'the derived id changed length - update the samples and this test');
  for (const source of [docsPage('deployment'), read('docs', 'deployment', 'README.md')]) {
    const id = /"deploymentId": "([^"]*)"/.exec(source)?.[1];
    assert.match(id ?? '', /^[0-9a-f]{16}$/, `deploymentId sample ${id}`);
  }
});
