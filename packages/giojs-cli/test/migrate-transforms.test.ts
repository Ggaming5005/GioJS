/**
 * giojs-cli/test/migrate-transforms.test.ts
 *
 * Code transforms of the Next.js migration: each fixture in
 * test/fixtures/transforms/<name>.input.* must transform to
 * <name>.expected.*, byte for byte. After an intentional transform change,
 * regenerate the expected files with UPDATE_FIXTURES=1 npm test and review
 * the diff. Runs against dist/ (npm test builds first):
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSource, type TransformOptions } from '../dist/migrate-transforms.js';
import { scanTodos, unifiedDiff } from '../dist/migrate-edits.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures', 'transforms');

const cases: Array<{ name: string; ext: string; options: TransformOptions }> = [
  { name: 'link-image', ext: 'tsx', options: { filePath: 'components/Nav.tsx', role: 'source' } },
  { name: 'router', ext: 'tsx', options: { filePath: 'components/Search.tsx', role: 'source' } },
  { name: 'head-script-dynamic', ext: 'jsx', options: { filePath: 'app/dashboard/page.jsx', role: 'app-page' } },
  { name: 'data-fetching', ext: 'tsx', options: { filePath: 'app/posts/[id]/page.tsx', role: 'pages-page' } },
  { name: 'api', ext: 'ts', options: { filePath: 'app/api/hello/route.ts', role: 'pages-api', originalPath: 'pages/api/hello.ts' } },
  { name: 'route-handler', ext: 'ts', options: { filePath: 'app/api/items/[id]/route.ts', role: 'app-route' } },
  {
    name: 'root-layout',
    ext: 'tsx',
    options: { filePath: 'app/layout.tsx', role: 'app-root-layout', cssUrl: spec => (spec === './globals.css' ? '/globals.css' : undefined) },
  },
  { name: 'server-action', ext: 'tsx', options: { filePath: 'app/posts/[slug]/page.tsx', role: 'app-page' } },
];

for (const { name, ext, options } of cases) {
  test(`fixture ${name}: input transforms to the expected output`, async () => {
    const input = await readFile(join(fixtures, `${name}.input.${ext}`), 'utf8');
    const expectedPath = join(fixtures, `${name}.expected.${ext}`);
    const result = transformSource(input, options);
    assert.equal(result.skipped, undefined);
    if (process.env['UPDATE_FIXTURES'] === '1' || !existsSync(expectedPath)) {
      await writeFile(expectedPath, result.output);
    }
    assert.equal(result.output, await readFile(expectedPath, 'utf8'));
    // The report lists exactly the TODO comments in the output, at their lines.
    assert.deepEqual(result.todos, scanTodos(result.output));
    for (const todo of result.todos) {
      assert.match(result.output.split('\n')[todo.line - 1] ?? '', /TODO\(gio-migrate\)/);
    }
  });

  test(`fixture ${name}: transforming the output again changes nothing`, async () => {
    const once = transformSource(await readFile(join(fixtures, `${name}.input.${ext}`), 'utf8'), options).output;
    const twice = transformSource(once, { ...options, role: options.role === 'pages-api' ? 'app-route' : options.role });
    if (options.role !== 'pages-api') assert.equal(twice.output, once);
  });
}

test('the legacy tests/fixtures Next.js page migrates without TODOs beyond next/font', async () => {
  const source = await readFile(join(here, '..', '..', '..', 'tests', 'fixtures', 'nextjs-page.tsx'), 'utf8');
  const { output, todos, fonts } = transformSource(source, { filePath: 'components/PostCard.tsx', role: 'source' });
  assert.match(output, /^﻿?import \{ GioLink, GioImage, useRouter \} from '@gio\.js\/react';/);
  assert.doesNotMatch(output, /from 'next|use client/);
  assert.match(output, /<GioImage\n\s+src=\{post\.imageUrl\}/);
  assert.match(output, /<GioLink href="\/" prefetch=\{false\}>/);
  assert.deepEqual(todos.map(t => t.message.slice(0, 9)), ['next/font']);
  assert.deepEqual(fonts.map(f => [f.family, f.weights]), [['Inter', ['400']]]);
});

test('JSX text, strings and comments that mention Next APIs are left alone', () => {
  const source = [
    "import Link from 'next/link';",
    '',
    'export function A() {',
    "  // <Link> and next/router in a comment",
    '  const s = "<Link href> in a string";',
    "  return <p>Don't <Link href=\"/x\">click</Link> {'<Link>'} here</p>;",
    '}',
    '',
  ].join('\n');
  const { output } = transformSource(source, { filePath: 'a.tsx', role: 'source' });
  assert.equal(output, [
    "import { GioLink } from '@gio.js/react';",
    '',
    'export function A() {',
    "  // <Link> and next/router in a comment",
    '  const s = "<Link href> in a string";',
    "  return <p>Don't <GioLink href=\"/x\">click</GioLink> {'<Link>'} here</p>;",
    '}',
    '',
  ].join('\n'));
});

test('imports merge into an existing @gio.js/react import and keep its quote style', () => {
  const source = 'import { useLocale } from "@gio.js/react";\nimport Image from "next/image";\n\nexport const I = () => <Image src="/a.png" alt="" width={1} height={1} />;\n';
  const { output } = transformSource(source, { filePath: 'i.tsx', role: 'source' });
  assert.equal(output, 'import { useLocale, GioImage } from "@gio.js/react";\n\nexport const I = () => <GioImage src="/a.png" alt="" width={1} height={1} />;\n');
});

test('a file without Next.js code is returned unchanged', () => {
  const source = "import React from 'react';\nexport default function A() { return <div>ok</div>; }\n";
  const result = transformSource(source, { filePath: 'components/A.tsx', role: 'source' });
  assert.equal(result.output, source);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.todos, []);
});

test('a file that does not parse is left untouched and reported', () => {
  const source = "import Link from 'next/link';\nexport default function A() { return <Link href='/'>x</Lnk>; }\n";
  const result = transformSource(source, { filePath: 'a.tsx', role: 'source' });
  assert.equal(result.output, source);
  assert.match(result.skipped ?? '', /could not parse \(line 2\)/);
});

test('relative imports follow moved files and server-only maps to @gio.js/core', () => {
  const source = "import 'server-only';\nimport { db } from '../lib/db';\nexport { x } from './x';\nconst m = await import('../lib/m');\n";
  const { output, changes } = transformSource(source, {
    filePath: 'app/blog/page.tsx',
    role: 'source',
    rewriteSpecifier: spec => (spec.startsWith('../') ? `../${spec}` : undefined),
  });
  assert.equal(output, "import '@gio.js/core/server-only';\nimport { db } from '../../lib/db';\nexport { x } from './x';\nconst m = await import('../../lib/m');\n");
  assert.equal(changes.length, 3);
});

test('JavaScript files never get type imports', () => {
  const source = "import { NextResponse, NextRequest } from 'next/server';\nexport function GET(req) { return NextResponse.json({}); }\n";
  const { output } = transformSource(source, { filePath: 'app/api/route.js', role: 'app-route' });
  assert.equal(output, 'export function GET(req) { return Response.json({}); }\n');
});

test("'use server' at the top of a file becomes a file-level TODO", () => {
  const source = "'use server';\n\nexport async function save(data: FormData) {\n  return data.get('x');\n}\n";
  const { output, todos, changes } = transformSource(source, { filePath: 'app/actions.ts', role: 'source' });
  assert.match(output, /^\/\/ TODO\(gio-migrate\): Server Actions have no GioJS equivalent/);
  assert.doesNotMatch(output, /'use server'/);
  assert.equal(todos[0]?.line, 1);
  assert.equal(changes[0]?.line, 2);
});

test('next/dynamic calls it cannot convert keep the import and get a TODO', () => {
  const source = "import dynamic from 'next/dynamic';\nconst loader = () => import('./X');\nconst X = dynamic(loader);\n";
  const { output, todos } = transformSource(source, { filePath: 'a.tsx', role: 'source' });
  assert.match(output, /^import dynamic from 'next\/dynamic';/);
  assert.match(todos[0]?.message ?? '', /React\.lazy/);
});

test('getStaticProps without revalidate caches forever (revalidate = false)', () => {
  const source = "export async function getStaticProps() {\n  return { props: { a: 1 } };\n}\nexport default function P({ a }: { a: number }) { return <p>{a}</p>; }\n";
  const { output } = transformSource(source, { filePath: 'app/page.tsx', role: 'pages-page' });
  assert.match(output, /export async function getServerSideProps\(\) \{/);
  assert.match(output, /\/\/ Cached in Rust after the first render\.\nexport const revalidate = false;/);
});

test('getStaticProps with an arrow expression body is converted too', () => {
  const source = 'export const getStaticProps = async () => ({ props: {}, revalidate: 30 });\n';
  const { output } = transformSource(source, { filePath: 'app/page.tsx', role: 'pages-page' });
  assert.match(output, /^export const getServerSideProps = async \(\) => \(\{ props: \{\} \}\);/);
  assert.match(output, /export const revalidate = 30;/);
});

test('nested Next APIs that would need overlapping edits leave the file untouched', () => {
  const source = "import Link from 'next/link';\nimport { useRouter } from 'next/router';\nexport function A() {\n  const router = useRouter();\n  return <Link href=\"/x\" as={router.asPath}>x</Link>;\n}\n";
  const result = transformSource(source, { filePath: 'a.tsx', role: 'source' });
  assert.equal(result.output, source);
  assert.match(result.skipped ?? '', /too intertwined to rewrite automatically/);
});

test('an unused next/link import is dropped without importing GioLink', () => {
  const source = "import Link from 'next/link';\nexport const x = 1;\n";
  assert.equal(transformSource(source, { filePath: 'a.ts', role: 'source' }).output, 'export const x = 1;\n');
});

test('unifiedDiff prints standard hunks for --dry-run', () => {
  const before = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join('\n');
  const after = before.replace('l2', 'two').replace('\nl11', '');
  assert.equal(unifiedDiff(before, after, 'a/x', 'b/x'), [
    '--- a/x', '+++ b/x',
    '@@ -1,5 +1,5 @@', ' l1', '-l2', '+two', ' l3', ' l4', ' l5',
    '@@ -8,5 +8,4 @@', ' l8', ' l9', ' l10', '-l11', ' l12',
  ].join('\n'));
  assert.equal(unifiedDiff('', 'new\n', '/dev/null', 'x'), '--- /dev/null\n+++ x\n@@ -0,0 +1,2 @@\n+new\n+');
});

test('getStaticProps outside a pages/ page is left alone', () => {
  const source = 'export async function getStaticProps() { return { props: {} }; }\n';
  assert.equal(transformSource(source, { filePath: 'lib/x.ts', role: 'source' }).output, source);
});
