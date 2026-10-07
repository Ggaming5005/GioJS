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
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

for (const [template, file] of [['default', 'page.tsx'], ['default-js', 'page.jsx']] as const) {
  test(`${template}: the post page exports in static mode and its copy holds in both modes`, async () => {
    const source = await readFile(join(templatesDir, template, 'app', 'posts', '[id]', file), 'utf8');
    // Static export needs the list of ids; the server ignores it.
    assert.match(source, /export function getStaticPaths\(/);
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
    assert.match(source, /export const metadata = \{/);
    assert.match(source, /title: \{ default: "\{\{PROJECT_NAME\}\}", template: "%s \| \{\{PROJECT_NAME\}\}" \}/);
    // Hand-written, a description would sit next to every page's metadata
    // one (only titles are deduplicated), and a <title> is superseded anyway.
    assert.doesNotMatch(source, /<title>/);
    assert.doesNotMatch(source, /name="description"/);
  });
}
