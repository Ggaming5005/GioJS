/**
 * docs-site/scripts/check-links.test.mjs
 *
 * Tests for the link checker, on throwaway site trees and on the real one.
 * Run: `npm test` in docs-site/ (no dependencies needed on Node 22.18+,
 * which loads the nav's TypeScript itself; older Node uses tsx).
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

test('the docs site has no dead links, orphans or nav links to pending pages', async () => {
  const { errors } = await checkLinks();
  assert.deepEqual(errors, []);
});

test('a nav entry for a pending page is an error, not a warning', async (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page('<h1>Intro</h1>'),
    ...nav('/docs/intro', '/docs/guides/soon'),
  });
  const { errors, warnings } = await checkLinks({ ...site, pending });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /components\/nav\/area\.ts:3: \/docs\/guides\/soon - pending page/);
  assert.deepEqual(warnings, []);
});

test('a page body may forward-reference a pending page (warning only)', async (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page('<a href="/docs/guides/soon">Soon</a>'),
    ...nav('/docs/intro'),
  });
  const { errors, warnings } = await checkLinks({ ...site, pending });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /app\/docs\/intro\/page\.tsx:1: \/docs\/guides\/soon - pending page/);
});

test('repository markdown may not link a pending page', async (t) => {
  const site = fixture(t, {
    'README.md': 'See [soon](https://giojs.com/docs/guides/soon).\n',
    'docs-site/app/docs/intro/page.tsx': page('<h1>Intro</h1>'),
    ...nav('/docs/intro'),
  });
  const { errors } = await checkLinks({ ...site, pending });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /^README\.md:1: \/docs\/guides\/soon - pending page/);
});

test('a pending page that landed: stale PENDING warns, a missing nav entry errors', async (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page('<a href="/docs/guides/soon">Soon</a>'),
    'docs-site/app/docs/guides/soon/page.tsx': page('<h1>Soon</h1>'),
    ...nav('/docs/intro'),
  });
  const { errors, warnings } = await checkLinks({ ...site, pending });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /\/docs\/guides\/soon is not in the docs nav/);
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /\/docs\/guides\/soon exists now - remove it from PENDING/);
});

test('dead links, missing anchors and orphan pages are errors; code samples are skipped', async (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page(
      '<h2 id="setup">Setup</h2><a href="/docs/nope">x</a><a href="#setup">ok</a>' +
        '<a href="/docs/intro#missing">y</a><CodeBlock code={`<a href="/docs/sample">`} />',
    ),
    'docs-site/app/docs/orphan/page.tsx': page('<h1>Orphan</h1>'),
    ...nav('/docs/intro'),
  });
  const { errors } = await checkLinks({ ...site, pending });
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.ok(errors.some((e) => /\/docs\/nope - no such page/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /page \/docs\/intro has no id="missing"/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /\/docs\/orphan is not in the docs nav/.test(e)));
});

test('a page listed twice in the nav is an error', async (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page('<h1>Intro</h1>'),
    ...nav('/docs/intro', '/docs/intro'),
  });
  const { errors } = await checkLinks({ ...site, pending });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /area\.ts:3: \/docs\/intro is already in the nav \(components\/nav\/area\.ts:2\)/);
});

test('a nav file index.ts does not import is an error, and its pages count as missing', async (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page('<h1>Intro</h1>'),
    'docs-site/app/docs/extra/page.tsx': page('<h1>Extra</h1>'),
    ...nav('/docs/intro'),
    'docs-site/components/nav/forgotten.ts': "export const forgottenGroups = [{ items: [{ href: '/docs/extra', label: 'x' }] }];\n",
  });
  const { errors } = await checkLinks({ ...site, pending });
  assert.equal(errors.length, 2, errors.join('\n'));
  assert.ok(errors.some((e) => /nav\/forgotten\.ts: nav file not imported by components\/nav\/index\.ts/.test(e)));
  assert.ok(errors.some((e) => /\/docs\/extra is not in the docs nav/.test(e)));
});

test('a group a nav file exports but index.ts never spreads into NAV is not "in the nav"', async (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page('<h1>Intro</h1>'),
    'docs-site/app/docs/hooks/use-thing/page.tsx': page('<h1>useThing</h1>'),
    ...nav('/docs/intro'),
    // The file is imported, and its second export names the page - but
    // only areaGroups reaches NAV, so the sidebar and pager never show it.
    'docs-site/components/nav/area.ts':
      "export const areaGroups = [{ items: [{ href: '/docs/intro', label: 'x' }] }];\n" +
      "export const hooksGroups = [{ title: 'Hooks', items: [\n  { href: '/docs/hooks/use-thing', label: 'useThing' },\n] }];\n",
  });
  const { errors } = await checkLinks({ ...site, pending });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /nav\/area\.ts:3: \/docs\/hooks\/use-thing is listed here but never reaches NAV/);
});

test('a group spread into NAV twice is an error', async (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page('<h1>Intro</h1>'),
    ...nav('/docs/intro'),
    'docs-site/components/nav/index.ts':
      "import { areaGroups } from './area.ts';\n" +
      "export const NAV = [{ title: 'A', description: '', groups: [...areaGroups, ...areaGroups] }];\n",
  });
  const { errors } = await checkLinks({ ...site, pending });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /\/docs\/intro is in NAV twice/);
});

test('a nav that does not load is an error', async (t) => {
  const site = fixture(t, {
    'docs-site/app/docs/intro/page.tsx': page('<h1>Intro</h1>'),
    ...nav('/docs/intro'),
    'docs-site/components/nav/index.ts':
      "import { areaGroups } from './area.ts';\nexport const NAV = areaGroups.oops.x;\n",
  });
  const { errors } = await checkLinks({ ...site, pending });
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /components\/nav\/index\.ts: cannot load the nav/);
});
