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
