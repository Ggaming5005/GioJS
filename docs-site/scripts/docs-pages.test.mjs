/**
 * docs-site/scripts/docs-pages.test.mjs
 *
 * The page template every docs page follows (docs-site/AGENTS.md), checked
 * on the page sources: metadata with a title and description, static
 * rendering, an explicit unique id on every h2/h3, and no hand-written
 * eyebrow or pager (the layout derives both from the nav). Pages missing
 * from the nav are check-links' job (check-links.test.mjs). The build checks
 * the rendered ids too (build.mjs, lib/text.mjs idProblems), which covers
 * ids computed from data.
 * Run: `npm test` in docs-site/ (no dependencies needed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withoutTemplates } from './check-links.mjs';
import { idProblems } from '../lib/text.mjs';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(siteDir, 'app', 'docs');

/** Every page.tsx under app/docs/, as `{ route, source, code }` (code: templates blanked). */
function docsPages() {
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return entry.name === 'page.tsx' ? [full] : [];
  });
  return files(docsDir).map((file) => {
    const source = readFileSync(file, 'utf8');
    const rel = relative(docsDir, dirname(file)).split(sep).join('/');
    return { route: rel === '' ? '/docs' : `/docs/${rel}`, source, code: withoutTemplates(source) };
  });
}

/**
 * Ids the docs chrome renders on every page (app/docs/layout.tsx and the
 * components it uses): a heading may not take one of them.
 */
function chromeIds() {
  const files = [
    join(docsDir, 'layout.tsx'),
    ...readdirSync(join(siteDir, 'components')).filter((name) => name.endsWith('.tsx'))
      .map((name) => join(siteDir, 'components', name)),
  ];
  return new Set(files.flatMap((file) =>
    [...withoutTemplates(readFileSync(file, 'utf8')).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])));
}

const pages = docsPages();

test('the docs pages are found', () => {
  assert.ok(pages.length > 40, `only ${pages.length} pages under app/docs/`);
});

test('every docs page exports metadata with a title and a description', () => {
  for (const { route, code } of pages) {
    const block = /^export const metadata(?::\s*Metadata)?\s*=\s*\{([\s\S]*?)^\};/m.exec(code);
    assert.ok(block, `${route}: no \`export const metadata = { title, description }\``);
    // The strings themselves are in the original source; `code` only blanks templates.
    assert.match(block[1], /^\s+title:\s*['"]/m, `${route}: metadata has no title string`);
    assert.match(block[1], /^\s+description:\s*(?:\n\s*)?['"]/m, `${route}: metadata has no description string`);
  }
});

test('every docs page renders statically (revalidate = false)', () => {
  for (const { route, code } of pages) {
    assert.match(code, /^export const revalidate = false;$/m, `${route}: no \`export const revalidate = false\``);
  }
});

test('every h2 and h3 has an explicit, unique kebab-case id', () => {
  const reserved = chromeIds();
  for (const { route, code } of pages) {
    const seen = new Set();
    for (const [tag, level, attrs] of code.matchAll(/<h([23])\b([^>]*)>/g)) {
      const literal = /\bid="([^"]*)"/.exec(attrs)?.[1];
      // An id computed from data (`id={ex.id}`) is checked in the build (idProblems).
      if (literal === undefined) {
        assert.match(attrs, /\bid=\{/, `${route}: ${tag} has no id - give it id="kebab-case"`);
        continue;
      }
      assert.match(literal, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${route}: h${level} id="${literal}" is not kebab-case`);
      assert.ok(!reserved.has(literal), `${route}: id="${literal}" is taken by the docs chrome`);
    }
    for (const [, id] of code.matchAll(/\bid="([^"]*)"/g)) {
      assert.ok(!seen.has(id), `${route}: id="${id}" appears twice`);
      seen.add(id);
    }
  }
});

test('no page writes its own eyebrow or pager', () => {
  for (const { route, code } of pages) {
    assert.doesNotMatch(code, /className="docs-(?:eyebrow|pager)"/, `${route}: the layout renders breadcrumbs and the pager`);
  }
});

test('code samples go through CodeBlock or PmTabs', () => {
  for (const { route, code } of pages) {
    assert.doesNotMatch(code, /<pre\b/, `${route}: a bare <pre> - use <CodeBlock lang="..." code={...} />`);
  }
});

test('idProblems: headings without ids and repeated ids', () => {
  const page = (body) =>
    `<html><body><nav id="sidebar"></nav><article class="docs-prose"><h1>T</h1>${body}</article></body></html>`;
  assert.deepEqual(idProblems(page('<h2 id="a">A</h2><h3 id="b">B</h3>')), []);
  assert.deepEqual(idProblems(page('<h2>Setup <code>x</code></h2>')), ['<h2> without an id: "Setup x"']);
  assert.deepEqual(idProblems(page('<h2 id="a">A</h2><h3 id="a">A</h3>')), ['id="a" is used more than once']);
  assert.deepEqual(idProblems(page('<h2 id="sidebar">Sidebar</h2>')), ['id="sidebar" is used more than once']);
  // Ids in serialized props (a script) are not elements.
  assert.deepEqual(idProblems(page('<h2 id="a">A</h2><script>{"x":"<p id=\\"a\\">"}</script>')), []);
});
