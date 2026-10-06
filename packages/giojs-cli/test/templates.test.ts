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
