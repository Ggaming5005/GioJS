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
  check(react('LocaleLink.tsx'), "defaultLocale = 'en'", 'components/locale-link', `default: "'en'"`);
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
