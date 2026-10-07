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

/** The TOML code samples of a page (`<CodeBlock lang="toml" code={`...`} />`). */
const tomlSamples = (source) => [...source.matchAll(/lang="toml" code=\{`([\s\S]*?)`\}/g)].map((m) => m[1]).join('\n');

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
