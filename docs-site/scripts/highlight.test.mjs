/**
 * docs-site/scripts/highlight.test.mjs
 *
 * Tests for the code-block helpers: the syntax highlighter (lib/highlight.mjs)
 * per language and on every code sample of the site, and the package-manager
 * conversion PmTabs shows (lib/package-managers.mjs).
 * Run: `npm test` in docs-site/ (no dependencies needed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { highlight, languageOf, tokenize } from '../lib/highlight.mjs';
import { pmCommands } from '../lib/package-managers.mjs';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The classed tokens of `code` as 'class:text', plain text left out. */
const marked = (code, lang) => tokenize(code, lang).filter(([cls]) => cls !== '').map(([cls, text]) => `${cls}:${text}`);

/** Every `<CodeBlock lang="..." code={`...`}>` and `<PmTabs command={`...`}>` sample of the site. */
function samples() {
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
  const found = [];
  for (const file of files(join(siteDir, 'app'))) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/<CodeBlock lang="([\w-]+)"(?: title="[^"]*")? code=\{`((?:\\[\s\S]|[^`\\])*)`\}/g)) {
      // The template literal's own escapes, as the page renders them.
      found.push({ file, lang: m[1], code: m[2].replace(/\\([`\\$])/g, '$1') });
    }
    for (const m of source.matchAll(/<PmTabs command=\{`((?:\\[\s\S]|[^`\\])*)`\}/g)) {
      found.push({ file, lang: 'bash', code: m[1] });
    }
  }
  return found;
}

test('ts: keywords, types, strings, numbers, functions, comments', () => {
  assert.deepEqual(
    marked("import type { Metadata } from '@gio.js/core';\nexport const n: number = load(0x1F); // why", 'ts'),
    [
      'tk-k:import', 'tk-k:type', 'tk-t:Metadata', 'tk-k:from', "tk-s:'@gio.js/core'",
      'tk-k:export', 'tk-k:const', 'tk-t:number', 'tk-f:load', 'tk-n:0x1F', 'tk-c:// why',
    ],
  );
  // `type` as a property name is not a keyword; a generic call is still a call.
  assert.deepEqual(marked("({ type: 'website' }); useState<string>(`a ${b}`)", 'ts'),
    ["tk-s:'website'", 'tk-f:useState', 'tk-t:string', 'tk-s:`a ${b}`']);
  assert.equal(languageOf('typescript'), 'ts');
});

test('tsx: tags, attributes and children text', () => {
  assert.deepEqual(
    marked('return <GioLink href="/x" prefetch={false}>Go if {a < b}</GioLink>;', 'tsx'),
    ['tk-k:return', 'tk-t:GioLink', 'tk-a:href', 'tk-s:"/x"', 'tk-a:prefetch', 'tk-l:false', 'tk-t:GioLink'],
  );
  // Fragments and nested elements return to code afterwards.
  assert.deepEqual(marked('const a = <><p>x</p></>; if (a) {}', 'tsx'), ['tk-k:const', 'tk-t:p', 'tk-t:p', 'tk-k:if']);
  // A comparison and a generic are not tags.
  assert.deepEqual(marked('if (a<b) f<T>(x)', 'tsx'), ['tk-k:if', 'tk-f:f', 'tk-t:T']);
});

test('js and jsx: no TypeScript types', () => {
  assert.deepEqual(marked('const string = 1;', 'js'), ['tk-k:const', 'tk-n:1']);
  assert.deepEqual(marked('const string = 1;', 'ts'), ['tk-k:const', 'tk-t:string', 'tk-n:1']);
  assert.deepEqual(marked('<a href="/x">x</a>', 'jsx'), ['tk-t:a', 'tk-a:href', 'tk-s:"/x"', 'tk-t:a']);
});

test('json: keys, strings, literals, numbers', () => {
  assert.deepEqual(marked('{ "a": [1, -2.5e3, true, null], "b": "c" }', 'json'),
    ['tk-a:"a"', 'tk-n:1', 'tk-n:-2.5e3', 'tk-l:true', 'tk-l:null', 'tk-a:"b"', 'tk-s:"c"']);
});

test('toml: tables, keys, values, comments', () => {
  assert.deepEqual(
    marked('[server]\nport = 3000 # c\n"a.b" = "v"\nhsts = { max_age = 63072000, preload = true }\n[[fonts]]', 'toml'),
    [
      'tk-h:[server]', 'tk-a:port', 'tk-n:3000', 'tk-c:# c', 'tk-a:"a.b"', 'tk-s:"v"',
      'tk-a:hsts', 'tk-a:max_age', 'tk-n:63072000', 'tk-a:preload', 'tk-l:true', 'tk-h:[[fonts]]',
    ],
  );
  // A multi-line string is one token; a `[` inside a value is not a table.
  assert.deepEqual(marked('csp = """\na [b]\n"""\nx = [1]', 'toml'),
    ['tk-a:csp', 'tk-s:"""\na [b]\n"""', 'tk-a:x', 'tk-n:1']);
});

test('bash: commands, flags, variables, strings, comments', () => {
  assert.deepEqual(
    marked('# hi\nGIO_PORT=4000 npx gio dev --port 3000 | grep "ok $HOME" && cd a#b\nif [ -f x ]; then echo ${#x}; fi', 'bash'),
    [
      'tk-c:# hi', 'tk-v:GIO_PORT', 'tk-a:--port', 'tk-f:grep', 'tk-s:"ok $HOME"', 'tk-f:cd',
      'tk-k:if', 'tk-a:-f', 'tk-k:then', 'tk-f:echo', 'tk-v:${#x}', 'tk-k:fi',
    ],
  );
  assert.deepEqual(marked('npm install x', 'sh'), ['tk-f:npm']);
});

test('diff: file headers, hunks, added and removed lines', () => {
  assert.deepEqual(
    marked('--- a/gio.toml\n+++ b/gio.toml\n@@ -1,2 +1,2 @@\n same\n-old = 1\n+new = 2', 'diff'),
    ['tk-m:--- a/gio.toml', 'tk-m:+++ b/gio.toml', 'tk-h:@@ -1,2 +1,2 @@', 'tk-del:-old = 1', 'tk-ins:+new = 2'],
  );
});

test('rust: attributes, lifetimes, chars, raw strings, macros', () => {
  assert.deepEqual(
    marked("#[derive(Debug)]\npub fn run<'a>(s: &'a str) -> Result<u32> { let c = 'x'; println!(r#\"r\"#); Ok(42u32) }", 'rust'),
    [
      'tk-m:#[derive(Debug)]', 'tk-k:pub', 'tk-k:fn', 'tk-f:run', "tk-v:'a", "tk-v:'a", 'tk-t:str',
      'tk-t:Result', 'tk-t:u32', 'tk-k:let', "tk-s:'x'", 'tk-m:println!', 'tk-s:r#"r"#', 'tk-l:Ok', 'tk-n:42u32',
    ],
  );
});

test('unknown languages are plain text; output is escaped and deterministic', () => {
  assert.equal(languageOf('yaml'), undefined);
  assert.deepEqual(tokenize('a: <b>', 'yaml'), [['', 'a: <b>']]);
  assert.equal(highlight('a: <b> & c', 'text'), 'a: &lt;b&gt; &amp; c');
  assert.equal(
    highlight('const a = "<b>";', 'ts'),
    '<span class="tk-k">const</span> a = <span class="tk-s">"&lt;b&gt;"</span>;',
  );
  assert.equal(highlight('x', 'ts'), highlight('x', 'ts'));
});

test('every code sample on the site tokenizes back to its exact text', () => {
  const all = samples();
  assert.ok(all.length > 200, `only ${all.length} samples found - did the CodeBlock markup change?`);
  for (const { file, lang, code } of all) {
    const tokens = tokenize(code, lang);
    assert.equal(tokens.map(([, text]) => text).join(''), code, `${file}: ${lang} sample changed by the tokenizer`);
    // Highlighting twice gives the same markup: server and client agree.
    assert.equal(highlight(code, lang), highlight(code, lang));
  }
});

test('the highlighter keeps up with the largest sample', () => {
  const largest = samples().reduce((a, b) => (b.code.length > a.code.length ? b : a));
  const start = performance.now();
  for (let i = 0; i < 5; i++) highlight(largest.code, largest.lang);
  const perRun = (performance.now() - start) / 5;
  // It runs again in the browser while the page hydrates.
  assert.ok(perRun < 50, `${largest.code.length} chars of ${largest.lang} took ${perRun.toFixed(1)} ms`);
});

test('PmTabs: npm commands as pnpm, yarn and bun', () => {
  const cases = [
    ['npm install', ['pnpm install', 'yarn', 'bun install']],
    ['npm install -D @gio.js/core typescript',
      ['pnpm add -D @gio.js/core typescript', 'yarn add -D @gio.js/core typescript', 'bun add -d @gio.js/core typescript']],
    ['npm i -g giojs', ['pnpm add -g giojs', 'yarn global add giojs', 'bun add -g giojs']],
    ['npm run build -- --verbose', ['pnpm build --verbose', 'yarn build --verbose', 'bun run build --verbose']],
    ['npm run deploy', ['pnpm run deploy', 'yarn run deploy', 'bun run deploy']],
    ['npm test', ['pnpm test', 'yarn test', 'bun run test']],
    ['npm create giojs@latest my-app -- --auth',
      ['pnpm create giojs my-app --auth', 'yarn create giojs my-app --auth', 'bun create giojs my-app --auth']],
    ['npx gio dev', ['pnpm exec gio dev', 'yarn gio dev', 'bunx gio dev']],
    ['npx create-giojs add db', ['pnpm dlx create-giojs add db', 'yarn dlx create-giojs add db', 'bunx create-giojs add db']],
    // Not npm, or not understood: kept as written.
    ['cd my-app', ['cd my-app', 'cd my-app', 'cd my-app']],
    ['npm audit', ['npm audit', 'npm audit', 'npm audit']],
  ];
  for (const [npm, [pnpm, yarn, bun]] of cases) {
    assert.deepEqual(pmCommands(npm), { npm, pnpm, yarn, bun }, npm);
  }
  // Line by line, comments kept in their column.
  assert.equal(
    pmCommands('npm create giojs@latest my-app -- --db   # a new app\nnpx create-giojs add db                  # an existing app').pnpm,
    'pnpm create giojs my-app --db            # a new app\npnpm dlx create-giojs add db             # an existing app',
  );
});
