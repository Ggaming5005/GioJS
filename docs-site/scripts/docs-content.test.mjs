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
