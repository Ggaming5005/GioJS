/**
 * giojs-cli/test/templates.test.ts
 *
 * Both create-giojs modes (server app and static site) scaffold from the
 * same templates, so a starter page has to work - and its copy has to be
 * true - in both: on the server any post id renders on demand, while
 * `gio export` writes only the ids getStaticPaths lists.
 *   node --test test/templates.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFontEntries } from '../dist/static-variant.js';

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

for (const [template, file] of [['default', 'page.tsx'], ['default-js', 'page.jsx']] as const) {
  test(`${template}: the post page exports in static mode and its copy holds in both modes`, async () => {
    const source = await readFile(join(templatesDir, template, 'app', 'posts', '[id]', file), 'utf8');
    // Static export needs the list of ids; the server ignores it.
    assert.match(source, /export const getStaticPaths\b/);
    // The visible copy explains both: on-demand rendering on the server, and
    // only the getStaticPaths ids after an export.
    assert.match(source, /<code>getServerSideProps<\/code> renders any ID on demand/);
    assert.match(source, /<code>gio export<\/code>/);
    assert.match(source, /<code>getStaticPaths<\/code>/);
  });
}

for (const [template, file] of [['default', 'layout.tsx'], ['default-js', 'layout.jsx']] as const) {
  test(`${template}: the root layout declares its title and description as metadata`, async () => {
    const source = await readFile(join(templatesDir, template, 'app', file), 'utf8');
    assert.match(source, /export const metadata(?:: Metadata)? = \{/);
    assert.match(source, /title: \{ default: "\{\{PROJECT_NAME\}\}", template: "%s \| \{\{PROJECT_NAME\}\}" \}/);
    // Hand-written, a description would sit next to every page's metadata
    // one (only titles are deduplicated), and a <title> is superseded anyway.
    assert.doesNotMatch(source, /<title>/);
    assert.doesNotMatch(source, /name="description"/);
  });
}

for (const [template, ext] of [['default', 'tsx'], ['default-js', 'jsx']] as const) {
  test(`${template}: global CSS is imported by the root layout, fonts are self-hosted`, async () => {
    const dir = join(templatesDir, template);
    const layout = await readFile(join(dir, 'app', `layout.${ext}`), 'utf8');
    assert.match(layout, /^import '\.\/globals\.css';$/m);
    // Imported CSS is linked by the framework; fonts come from [[fonts]].
    assert.doesNotMatch(layout, /rel="stylesheet"/);
    assert.doesNotMatch(layout, /fonts\.googleapis|fonts\.gstatic/);
    await assert.rejects(readFile(join(dir, 'public', 'styles', 'globals.css')));

    const fonts = parseFontEntries(await readFile(join(dir, 'gio.toml'), 'utf8'));
    assert.ok(fonts.length > 0);
    for (const font of fonts) {
      // A public/ file, copied by the server at startup - no network needed.
      assert.match(font.url, /^\/public\/fonts\/[\w-]+\.woff2$/);
      const bytes = await readFile(join(dir, font.url.slice(1)));
      assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', `${font.url} is not WOFF2`);
    }
    const css = await readFile(join(dir, 'app', 'globals.css'), 'utf8');
    for (const family of new Set(fonts.map(font => font.family))) {
      assert.ok(css.includes(`'${family}'`), `globals.css does not use ${family}`);
    }
  });

  test(`${template}: pages set their own metadata`, async () => {
    const dir = join(templatesDir, template, 'app');
    assert.match(
      await readFile(join(dir, 'about', `page.${ext}`), 'utf8'),
      /export const metadata(?:: Metadata)? = \{\n {2}title: 'Project structure'/,
    );
    assert.match(await readFile(join(dir, 'posts', '[id]', `page.${ext}`), 'utf8'), /export const generateMetadata\b/);
  });
}

test('the TS and JS templates hold the same files', async () => {
  const list = async (dir: string, prefix = ''): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) out.push(...await list(join(dir, entry.name), `${rel}/`));
      else out.push(rel.replace(/\.tsx$/, '.jsx').replace(/^tsconfig\.json$/, 'jsconfig.json'));
    }
    return out.sort();
  };
  assert.deepEqual(await list(join(templatesDir, 'default')), await list(join(templatesDir, 'default-js')));
  for (const file of ['gio.toml', '_gitignore', '.env.example', join('app', 'globals.css')]) {
    assert.equal(
      await readFile(join(templatesDir, 'default', file), 'utf8'),
      await readFile(join(templatesDir, 'default-js', file), 'utf8'),
      file,
    );
  }
});
