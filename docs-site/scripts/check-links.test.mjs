/**
 * docs-site/scripts/check-links.test.mjs
 *
 * Tests for the link checker, on throwaway site trees and on the real one.
 * Run: `npm test` in docs-site/ (no dependencies needed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { checkLinks } from './check-links.mjs';

/** A throwaway repo with a docs site: `files` maps relative paths to contents. */
function fixture(t, files) {
  const repoDir = mkdtempSync(join(tmpdir(), 'gio-check-links-'));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(repoDir, ...path.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { siteDir: join(repoDir, 'docs-site'), repoDir };
}

const page = (body) => `export default function Page() { return <>${body}</>; }\n`;
/** A docs nav: index.ts aggregating one area file that lists `hrefs` (from its line 2). */
const nav = (...hrefs) => ({
  'docs-site/components/nav/index.ts':
    "import type { NavSection } from './types.ts';\nimport { areaGroups } from './area.ts';\n" +
    "export const NAV: NavSection[] = [{ title: 'Area', description: '', groups: areaGroups }];\n",
  'docs-site/components/nav/area.ts':
    `export const areaGroups = [{ items: [\n${hrefs.map((h) => `  { href: '${h}', label: 'x' },`).join('\n')}\n] }];\n`,
});
const pending = new Set(['/docs/guides/soon']);

test('the docs site has no dead links, orphans or nav links to pending pages', () => {
  const { errors } = checkLinks();
  assert.deepEqual(errors, []);
});

test('a nav entry for a pending page is an error, not a warning', (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page('<h1>Intro</h1>'),
    ...nav('/docs/intro', '/docs/guides/soon'),
  });
  const { errors, warnings } = checkLinks({ ...site, pending });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /components\/nav\/area\.ts:3: \/docs\/guides\/soon - pending page/);
  assert.deepEqual(warnings, []);
});

test('a page body may forward-reference a pending page (warning only)', (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page('<a href="/docs/guides/soon">Soon</a>'),
    ...nav('/docs/intro'),
  });
  const { errors, warnings } = checkLinks({ ...site, pending });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /app\/docs\/intro\/page\.tsx:1: \/docs\/guides\/soon - pending page/);
});

test('repository markdown may not link a pending page', (t) => {
  const site = fixture(t, {
    'README.md': 'See [soon](https://giojs.com/docs/guides/soon).\n',
    'docs-site/app/docs/intro/page.tsx': page('<h1>Intro</h1>'),
    ...nav('/docs/intro'),
  });
  const { errors } = checkLinks({ ...site, pending });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /^README\.md:1: \/docs\/guides\/soon - pending page/);
});

test('a pending page that landed: stale PENDING warns, a missing nav entry errors', (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page('<a href="/docs/guides/soon">Soon</a>'),
    'docs-site/app/docs/guides/soon/page.tsx': page('<h1>Soon</h1>'),
    ...nav('/docs/intro'),
  });
  const { errors, warnings } = checkLinks({ ...site, pending });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /\/docs\/guides\/soon is not in the docs nav/);
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /\/docs\/guides\/soon exists now - remove it from PENDING/);
});

test('dead links, missing anchors and orphan pages are errors; code samples are skipped', (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page(
      '<h2 id="setup">Setup</h2><a href="/docs/nope">x</a><a href="#setup">ok</a>' +
        '<a href="/docs/intro#missing">y</a><CodeBlock code={`<a href="/docs/sample">`} />',
    ),
    'docs-site/app/docs/orphan/page.tsx': page('<h1>Orphan</h1>'),
    ...nav('/docs/intro'),
  });
  const { errors } = checkLinks({ ...site, pending });
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.ok(errors.some((e) => /\/docs\/nope - no such page/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /page \/docs\/intro has no id="missing"/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /\/docs\/orphan is not in the docs nav/.test(e)));
});

test('a page listed twice in the nav is an error', (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page('<h1>Intro</h1>'),
    ...nav('/docs/intro', '/docs/intro'),
  });
  const { errors } = checkLinks({ ...site, pending });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /area\.ts:3: \/docs\/intro is already in the nav \(components\/nav\/area\.ts:2\)/);
});

test('a nav file index.ts does not import is an error, and its pages count as missing', (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page('<h1>Intro</h1>'),
    'docs-site/app/docs/extra/page.tsx': page('<h1>Extra</h1>'),
    ...nav('/docs/intro'),
    'docs-site/components/nav/forgotten.ts': "export const forgottenGroups = [{ items: [{ href: '/docs/extra', label: 'x' }] }];\n",
  });
  const { errors } = checkLinks({ ...site, pending });
  assert.equal(errors.length, 2, errors.join('\n'));
  assert.ok(errors.some((e) => /nav\/forgotten\.ts: nav file not imported by components\/nav\/index\.ts/.test(e)));
  assert.ok(errors.some((e) => /\/docs\/extra is not in the docs nav/.test(e)));
});
