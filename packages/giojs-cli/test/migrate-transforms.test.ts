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
  // router.query in effect deps must keep its identity between renders (useMemo), not loop.
  { name: 'router-effect', ext: 'tsx', options: { filePath: 'components/Post.tsx', role: 'source' } },
  // [...slug] params are a '/'-joined string in GioJS: every place that reads them gets a TODO.
  { name: 'catch-all', ext: 'tsx', options: { filePath: 'app/docs/[...slug]/page.tsx', role: 'pages-page', originalPath: 'pages/docs/[...slug].tsx' } },
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
  // metadata/generateMetadata are kept: unsupported fields named, the Next signature converted.
  { name: 'metadata', ext: 'tsx', options: { filePath: 'app/blog/[slug]/page.tsx', role: 'app-page' } },
  { name: 'next-cache', ext: 'ts', options: { filePath: 'lib/posts.ts', role: 'source' } },
  // next/navigation redirect() throws; @gio.js/core's is thrown - or returned straight from getServerSideProps / a page action.
  { name: 'redirect', ext: 'tsx', options: { filePath: 'app/dashboard/page.tsx', role: 'pages-page', originalPath: 'pages/dashboard.tsx' } },
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
  assert.match(output, /^\/\/ TODO\(gio-migrate\): Server Action: GioJS has no Server Actions - a form's action becomes the page's export async function action\(req\)/);
  assert.match(output, /posted by <GioForm> from @gio\.js\/react; a non-form call becomes a route\.ts handler/);
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

test('router.query becomes a memoized value, so effects that depend on it run once per navigation', () => {
  const source = [
    "import { useEffect, useState } from 'react';",
    "import { useRouter } from 'next/router';",
    'export default function Post() {',
    '  const router = useRouter();',
    '  const [data, setData] = useState(null);',
    '  useEffect(() => {',
    '    if (!router.isReady) return;',
    "    fetch('/api/' + router.query.id).then(r => r.json()).then(setData);",
    '  }, [router.isReady, router.query]);',
    '  return <pre>{JSON.stringify(data)}</pre>;',
    '}',
    '',
  ].join('\n');
  const { output } = transformSource(source, { filePath: 'components/Post.tsx', role: 'source' });
  assert.match(output, /^import \{ useEffect, useState, useMemo \} from 'react';/);
  assert.match(output, /const searchParams = useSearchParams\(\);\n {2}const params = useParams\(\);\n {2}const routerQuery = useMemo\(\(\) => \(\{ \.\.\.Object\.fromEntries\(searchParams\), \.\.\.params \}\), \[searchParams, params\]\);/);
  assert.match(output, /\}, \[true, routerQuery\]\);/);
  // Never a fresh object literal built in the render body.
  assert.doesNotMatch(output, /routerQuery = \{/);
});

test('generated hook bindings never shadow names the file already uses', () => {
  const source = "import { useRouter } from 'next/router';\nexport function A({ params, searchParams }: { params: string; searchParams: string }) {\n  const { query } = useRouter();\n  return <p>{params}{searchParams}{query.q}</p>;\n}\n";
  const { output } = transformSource(source, { filePath: 'a.tsx', role: 'source' });
  assert.match(output, /const routerSearchParams = useSearchParams\(\);\n {2}const routeParams = useParams\(\);\n {2}const query = useMemo\(\(\) => \(\{ \.\.\.Object\.fromEntries\(routerSearchParams\), \.\.\.routeParams \}\), \[routerSearchParams, routeParams\]\);/);
});

test('an optional catch-all flags useParams() with the empty-segment fallback', () => {
  const source = "'use client';\nimport { useParams } from 'next/navigation';\n\nexport default function Blog() {\n  const { slug } = useParams();\n  return <p>{(slug ?? []).join(' / ')}</p>;\n}\n";
  const { output, todos } = transformSource(source, { filePath: 'app/blog/[[...slug]]/page.jsx', role: 'app-page' });
  assert.deepEqual(todos.map(t => t.message), [
    "catch-all route: the \"slug\" param is a '/'-joined string in GioJS ('a/b'), not an array as in Next.js - use slug ? slug.split('/') : [] where the code expects the array",
  ]);
  assert.match(output, /\/\/ TODO\(gio-migrate\): catch-all route: [^\n]+\n {2}const \{ slug \} = useParams\(\);/);
  // The default export takes no props: nothing to flag there.
  assert.match(output, /\n\nexport default function Blog\(\) \{/);
});

test('catch-all route handlers get one file-level TODO, and a second run does not repeat it', () => {
  const source = 'export default function handler(req, res) {\n  res.json({ path: req.query.path.join("/") });\n}\n';
  const options = { filePath: 'app/api/files/[...path]/route.js', role: 'pages-api' as const, originalPath: 'pages/api/files/[...path].js' };
  const once = transformSource(source, options).output;
  assert.match(once, /^\/\/ TODO\(gio-migrate\): catch-all route: the "path" param is a '\/'-joined string in GioJS \('a\/b'\), not an array as in Next\.js - use path\.split\('\/'\)/);
  const twice = transformSource(once, { ...options, role: 'app-route' }).output;
  assert.equal(twice, once);
});

test('a file outside a catch-all route gets no catch-all TODO', () => {
  const source = "import { useParams } from 'next/navigation';\nexport default function P({ params }) {\n  return <p>{useParams().id}{params.id}</p>;\n}\n";
  const { todos } = transformSource(source, { filePath: 'app/posts/[id]/page.jsx', role: 'app-page' });
  assert.deepEqual(todos, []);
});

test('metadata and generateMetadata GioJS renders as they are stay untouched, without a TODO', () => {
  const source = [
    "export const metadata = { title: { default: 'Posts', template: '%s | Site' }, description: 'All \"posts\"', openGraph: { title: 'x', images: [{ url: '/og.png', width: 1200 }] }, twitter: { card: 'summary' }, robots: { index: false, googleBot: { index: false } }, icons: { url: '/i.png', sizes: '32x32' }, other: { 'x-y': '1' } };",
    'export async function generateMetadata({ params }) {',
    '  return { title: params.id, alternates: { canonical: `/posts/${params.id}` } };',
    '}',
    'export default function P() { return <p />; }',
    '',
  ].join('\n');
  const { output, todos, changes } = transformSource(source, { filePath: 'app/posts/page.jsx', role: 'app-page' });
  assert.equal(output, source);
  assert.deepEqual(todos, []);
  assert.deepEqual(changes.map(c => c.message.replace(/:.*/, '')), ['metadata export kept', 'generateMetadata kept']);
  // A metadata value that isn't an object literal can't be checked: no TODO either.
  assert.deepEqual(transformSource('export const metadata = buildMetadata();\n', { filePath: 'app/page.tsx', role: 'app-page' }).todos, []);
  // Outside a page or layout an export named metadata is just a value.
  assert.deepEqual(transformSource("export const metadata = { generator: 'x' };\n", { filePath: 'lib/seo.ts', role: 'source' }).todos, []);
});

test('generateMetadata reading the parent metadata gets a TODO; props.searchParams becomes props.query', () => {
  const source = [
    "import type { Metadata, ResolvingMetadata } from 'next';",
    'export async function generateMetadata(props: { searchParams: { q: string } }, parent: ResolvingMetadata): Promise<Metadata> {',
    '  const images = (await parent).openGraph?.images ?? [];',
    '  return { title: props.searchParams.q, openGraph: { images } };',
    '}',
    '',
  ].join('\n');
  const { output, todos } = transformSource(source, { filePath: 'app/search/page.tsx', role: 'app-page' });
  assert.match(output, /^\/\/ TODO\(gio-migrate\): types from 'next' \(ResolvingMetadata\) don't exist in GioJS[^\n]+\nimport type \{ ResolvingMetadata \} from 'next';\nimport type \{ MetadataContext, Metadata \} from '@gio\.js\/core';\n/);
  assert.match(output, /export async function generateMetadata\(props: MetadataContext, parent: ResolvingMetadata\): Promise<Metadata> \{/);
  assert.match(output, /title: props\.query\.q/);
  assert.deepEqual(todos.map(t => t.message.slice(0, 60)), [
    "types from 'next' (ResolvingMetadata) don't exist in GioJS: ",
    "generateMetadata's second argument is { props } in GioJS (wh",
  ]);
  assert.match(todos[1]?.message ?? '', /share values like openGraph\.images through a variable instead of reading parent$/);
});

test('a route handler redirect() becomes a Response; nested deeper it gets a TODO', () => {
  const source = [
    "import { redirect } from 'next/navigation';",
    'export async function GET(req) {',
    "  if (!req.cookies.session) redirect('/login');",
    "  if (req.query.old) return redirect('/new');",
    "  const go = () => redirect('/x');",
    '  return { ok: true };',
    '}',
    '',
  ].join('\n');
  const { output, todos } = transformSource(source, { filePath: 'app/api/me/route.js', role: 'app-route' });
  assert.match(output, /^import \{ redirect \} from '@gio\.js\/core';\n/);
  assert.match(output, /if \(!req\.cookies\.session\) return new Response\(null, \{ status: 307, headers: \{ location: '\/login' \} \}\);/);
  assert.match(output, /if \(req\.query\.old\) return new Response\(null, \{ status: 307, headers: \{ location: '\/new' \} \}\);/);
  // A thrown redirect would reach GioJS as a failing handler: flagged.
  assert.match(output, /\n {2}\/\/ TODO\(gio-migrate\): redirect\(\) in a route handler: [^\n]+\n {2}const go = \(\) => \{ throw redirect\('\/x'\); \};/);
  assert.equal(todos.length, 1);
});

test('the next/navigation change note names the module each import moved to', () => {
  const source = "import { usePathname, notFound, permanentRedirect } from 'next/navigation';\nexport function a() { if (!usePathname()) notFound(); permanentRedirect('/b'); }\n";
  const { changes } = transformSource(source, { filePath: 'lib/a.ts', role: 'source' });
  assert.equal(changes[0]?.message, 'next/navigation → @gio.js/react: usePathname; @gio.js/core: notFound, permanentRedirect → redirect');
});

test("dynamic = 'force-static' becomes revalidate = false on a page only: GioJS reads revalidate from pages", () => {
  const source = "export const dynamic = 'force-static';\nexport default function X({ children }) { return children; }\n";
  const page = transformSource(source, { filePath: 'app/blog/page.jsx', role: 'app-page' });
  assert.match(page.output, /^export const revalidate = false;\n/);
  assert.deepEqual(page.todos, []);
  for (const filePath of ['app/blog/layout.jsx', 'app/layout.jsx']) {
    const layout = transformSource(source, { filePath, role: filePath === 'app/layout.jsx' ? 'app-root-layout' : 'app-page' });
    assert.match(layout.output, /\nexport const dynamic = 'force-static';\n/, filePath);
    assert.deepEqual(layout.todos.map(t => t.message), [
      "dynamic = 'force-static' on a layout: GioJS reads revalidate from pages only and ignores the dynamic export - add export const revalidate = false to each page under this layout (it caches the page in Rust until the next deploy), then remove this export",
    ], filePath);
  }
  const loading = transformSource(source, { filePath: 'app/blog/loading.jsx', role: 'app-page' });
  assert.match(loading.todos[0]?.message ?? '', /^dynamic = 'force-static': GioJS ignores the dynamic export/);
});

test('revalidatePath() flags a route pattern in literal text only, not an indexed expression', () => {
  const source = [
    "import { revalidatePath } from 'next/cache';",
    'export async function purge(paths: string[], slug: string) {',
    '  revalidatePath(paths[0]);',
    '  revalidatePath(map[slug]);',
    '  revalidatePath(`/posts/${slug}`);',
    "  revalidatePath('/posts/[id]');",
    '  revalidatePath(`/[locale]/posts/${slug}`);',
    '}',
    'declare const map: Record<string, string>;',
    '',
  ].join('\n');
  const { output, todos } = transformSource(source, { filePath: 'lib/purge.ts', role: 'source' });
  // The statement under each TODO.
  assert.deepEqual(todos.map(t => output.split('\n')[t.line]?.trim()), ["revalidatePath('/posts/[id]');", 'revalidatePath(`/[locale]/posts/${slug}`);']);
  assert.match(todos[0]?.message ?? '', /^revalidatePath\(\) purges a real path in GioJS/);
});

test('app/sitemap.ts keeps its shape; generateSitemaps and media entries get TODOs', () => {
  const source = [
    "import type { MetadataRoute } from 'next';",
    'export async function generateSitemaps() { return [{ id: 0 }]; }',
    'export default function sitemap(): MetadataRoute.Sitemap {',
    "  return [{ url: 'https://example.com', lastModified: new Date(), images: ['https://example.com/a.png'] }];",
    '}',
    '',
  ].join('\n');
  const { output, todos } = transformSource(source, { filePath: 'app/sitemap.ts', role: 'app-metadata-route' });
  assert.match(output, /^import type \{ MetadataRoute \} from '@gio\.js\/core';\n/);
  assert.match(output, /export default function sitemap\(\): MetadataRoute\.Sitemap \{/);
  assert.deepEqual(todos.map(t => t.message), [
    'generateSitemaps (several sitemaps) is not supported: GioJS serves one /sitemap.xml from the default export - return every entry from it',
    'sitemap images: GioJS writes url, lastModified, changeFrequency, priority and alternates.languages - images are left out of /sitemap.xml',
  ]);
  const robots = "import type { MetadataRoute } from 'next';\nexport default function robots(): MetadataRoute.Robots {\n  return { rules: { userAgent: '*', allow: '/' }, sitemap: 'https://example.com/sitemap.xml' };\n}\n";
  const migrated = transformSource(robots, { filePath: 'app/robots.ts', role: 'app-metadata-route' });
  assert.equal(migrated.output, robots.replace("from 'next'", "from '@gio.js/core'"));
  assert.deepEqual(migrated.todos, []);
});

test('Server Action forms become <GioForm>; client form actions and string URLs stay', () => {
  const source = [
    "'use client';",
    "import { useActionState } from 'react';",
    "import { useFormStatus } from 'react-dom';",
    "import { createPost, deletePost } from './actions';",
    '',
    'function Submit() {',
    '  const { pending } = useFormStatus();',
    '  return <button disabled={pending}>Save</button>;',
    '}',
    '',
    'export function Editor({ id }: { id: string }) {',
    '  const [state, formAction] = useActionState(createPost, null);',
    '  const local = (data: FormData) => console.log(data);',
    '  return (',
    '    <>',
    '      <form action={formAction} method="post"><Submit /></form>',
    '      <form action={deletePost.bind(null, id)}><button formAction={deletePost}>x</button></form>',
    '      <form action={local} />',
    '      <form action="/api/search" />',
    '    </>',
    '  );',
    '}',
    '',
  ].join('\n');
  const { output, todos } = transformSource(source, {
    filePath: 'components/Editor.tsx',
    role: 'source',
    serverActionModule: spec => spec === './actions',
  });
  assert.match(output, /^import \{ useActionState \} from 'react';\n\/\/ TODO\(gio-migrate\): useFormStatus\(\) tracks React form actions only/);
  assert.match(output, /import \{ GioForm \} from '@gio\.js\/react';/);
  assert.match(output, /<GioForm><Submit \/><\/GioForm>/);
  // A function formAction would make React submit to a javascript: URL: the button names the action instead.
  assert.match(output, /<GioForm><button name="intent" value="deletePost">x<\/button><\/GioForm>/);
  assert.match(output, /<form action=\{local\} \/>\n {6}<form action="\/api\/search" \/>/);
  assert.deepEqual(todos.map(t => t.message.slice(0, 50)), [
    'useFormStatus() tracks React form actions only: in',
    'useActionState() with a Server Action: a page acti',
    '<form action={formAction}> became <GioForm>, which',
    '<form action={deletePost.bind(null, id)}> became <',
    'formAction={deletePost} (Server Action) became nam',
  ]);
  assert.match(todos[3]?.message ?? '', /the values \.bind\(\) passed become hidden <input name> fields/);
});

test('a <form> whose Server Actions are its buttons\' formAction becomes <GioForm>; each button names its action', () => {
  const source = [
    "import { createPost, deletePost } from './actions';",
    '',
    'export default function Page({ id }: { id: string }) {',
    '  return (',
    '    <form method="get">',
    '      <input name="title" />',
    '      <button formAction={createPost}>Create</button>',
    '      <button formAction={deletePost.bind(null, id)}>Delete</button>',
    '      <button name="op" value="archive" formAction={createPost}>Archive</button>',
    '    </form>',
    '  );',
    '}',
    '',
    'export function Remove() {',
    '  return <button formAction={deletePost}>Remove</button>;',
    '}',
    '',
  ].join('\n');
  const options: TransformOptions = { filePath: 'app/posts/page.tsx', role: 'app-page', serverActionModule: spec => spec === './actions' };
  const { output, todos } = transformSource(source, options);
  assert.equal(transformSource(output, options).output, output, 'a second run changes nothing');
  // Without its formAction the plain <form> would submit as a GET and the page action would never run.
  assert.match(output, /\n {4}<GioForm>\n {6}<input name="title" \/>\n {6}<button name="intent" value="createPost">Create<\/button>\n {6}<button name="intent" value="deletePost">Delete<\/button>\n {6}<button name="op" value="archive">Archive<\/button>\n {4}<\/GioForm>\n/);
  assert.match(output, /return <button name="intent" value="deletePost">Remove<\/button>;/);
  assert.doesNotMatch(output.replace(/^ *\/\/ TODO.*\n/gm, ''), /formAction|<form/);
  assert.match(output, /^import \{ createPost, deletePost \} from '\.\/actions';\nimport \{ GioForm \} from '@gio\.js\/react';\n/);
  assert.deepEqual(todos.map(t => t.message), [
    "<form> with Server Action buttons became <GioForm>, which posts to the page it is on: move each button's action into that page's export async function action(req)",
    'formAction={createPost} (Server Action) became name="intent" value="createPost": move createPost into the page\'s action and branch on (await req.formData()).get(\'intent\')',
    'formAction={deletePost.bind(null, id)} (Server Action) became name="intent" value="deletePost": move deletePost into the page\'s action and branch on (await req.formData()).get(\'intent\') (the values .bind() passed become hidden <input name> fields)',
    'formAction={createPost} (Server Action) was removed: move createPost into the page\'s action and branch on the button\'s name/value in (await req.formData())',
    'formAction={deletePost} (Server Action) became name="intent" value="deletePost": move deletePost into the page\'s action and branch on (await req.formData()).get(\'intent\') - and render the button inside a <GioForm>, which posts to the page it is on',
  ]);
});

test("'use cache' is removed with a TODO about page caching", () => {
  const source = "export async function getPosts() {\n  'use cache';\n  return [];\n}\n";
  const { output, todos } = transformSource(source, { filePath: 'lib/posts.ts', role: 'source' });
  assert.equal(output, `// TODO(gio-migrate): ${todos[0]?.message}\nexport async function getPosts() {\n  return [];\n}\n`);
  assert.match(todos[0]?.message ?? '', /^'use cache' has no GioJS equivalent, so this code now runs on every call - GioJS caches whole pages in Rust instead: export const revalidate = N/);
});
