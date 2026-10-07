/**
 * giojs-cli/test/migrate-render.test.ts
 *
 * Migrated projects must run, not just read right: each one is migrated on
 * a temp tree and its pages are rendered through @gio.js/core/testing's
 * renderPage (the worker's own render path) under the tsx loader the GioJS
 * server starts its worker with. The project gets a node_modules that
 * resolves @gio.js/react with its published `exports` (ESM-only, mapped to
 * the workspace sources since dist/ is a build output), so module-format
 * mistakes fail here the way they fail on the real server: a missing
 * "type": "module" (ERR_PACKAGE_PATH_NOT_EXPORTED) or JSX left in a .js file
 * ("The JSX syntax extension is not currently enabled").
 *   npm test   (needs the workspace install: pnpm install)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { applyMigration, planMigration } from '../dist/migrate.js';
import { pagesProject } from './fixtures/pages-project.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const coreDir = join(repoRoot, 'packages', 'giojs-core');
const reactDir = join(repoRoot, 'packages', 'giojs-react');
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

interface Rendered {
  status: number;
  html: string;
  error?: string;
  redirect?: { destination: string; permanent: boolean };
  cacheable: boolean;
}

async function writeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gio-migrate-render-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  return root;
}

/** What `npm install` gives a migrated project: react, @gio.js/core and an ESM-only @gio.js/react. */
async function installGioPackages(root: string): Promise<void> {
  const modules = join(root, 'node_modules');
  await mkdir(join(modules, '@gio.js', 'react'), { recursive: true });
  for (const dep of ['react', 'react-dom']) await symlink(join(coreDir, 'node_modules', dep), join(modules, dep), linkType);
  await symlink(coreDir, join(modules, '@gio.js', 'core'), linkType);
  const published = JSON.parse(await readFile(join(reactDir, 'package.json'), 'utf8')) as Record<string, unknown>;
  const toSource = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(/^\.\/dist\/(.*?)(\.d\.ts|\.js)$/, './src/$1.ts');
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toSource(v)]));
    return value;
  };
  const shim = { name: published['name'], type: published['type'], main: toSource(published['main']), exports: toSource(published['exports']) };
  await writeFile(join(modules, '@gio.js', 'react', 'package.json'), JSON.stringify(shim, null, 2));
  await symlink(join(reactDir, 'src'), join(modules, '@gio.js', 'react', 'src'), linkType);
}

async function render(root: string, paths: string[]): Promise<Record<string, Rendered>> {
  const tsx = createRequire(join(coreDir, 'package.json')).resolve('tsx');
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--import', pathToFileURL(tsx).href,
      join(here, 'fixtures', 'render-migrated.mjs'),
      pathToFileURL(join(coreDir, 'src', 'testing.ts')).href,
      join(root, 'app'),
      ...paths,
    ],
    { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'development' }, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as Record<string, Rendered>;
}

async function migrateAndRender(files: Record<string, string>, paths: string[]): Promise<Record<string, Rendered>> {
  const root = await writeTree(files);
  try {
    await applyMigration(await planMigration(root));
    await installGioPackages(root);
    return await render(root, paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertOk(results: Record<string, Rendered>, path: string): string {
  const page = results[path];
  assert.ok(page !== undefined, `${path} rendered`);
  assert.equal(page.status, 200, `${path}: ${page.error ?? `status ${page.status}`}`);
  return page.html;
}

test('a migrated TypeScript pages project renders, including pages that import @gio.js/react', async () => {
  const results = await migrateAndRender(pagesProject, ['/', '/about', '/blog/hello', '/docs/a/b', '/missing']);
  const home = assertOk(results, '/');
  assert.match(home, /<title>Home<\/title>/);
  assert.match(home, /<a [^>]*href="\/about"/);
  assert.match(home, /<link rel="stylesheet" href="\/styles\/globals\.css"\/>/);
  assertOk(results, '/about');
  assertOk(results, '/blog/hello');
  assert.equal(results['/blog/hello']?.cacheable, true, 'getStaticProps + revalidate → cached');
  assertOk(results, '/docs/a/b');
  assert.equal(results['/missing']?.status, 404);
  assert.match(results['/missing']?.html ?? '', /Not found/);
});

test('a migrated JavaScript app-router project renders: JSX moved to .jsx, CommonJS to .cjs', async () => {
  const results = await migrateAndRender({
    'package.json': '{"name":"js-app","dependencies":{"next":"14.2.3","react":"18.2.0","react-dom":"18.2.0"}}\n',
    'jsconfig.json': '{ "compilerOptions": { "baseUrl": "." } }\n',
    'postcss.config.js': 'module.exports = { plugins: {} };\n',
    'src/app/layout.js': "export const metadata = { title: { default: 'JS app', template: '%s | JS app' }, applicationName: 'JS app' };\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang=\"en\">\n      <body>{children}</body>\n    </html>\n  );\n}\n",
    'src/app/search/page.js': "export async function generateMetadata({ params, searchParams }, parent) {\n  const { q } = await searchParams;\n  return { title: `Search: ${q}`, description: `${Object.keys(await params).length} params` };\n}\n\nexport default function Search() {\n  return <p>search</p>;\n}\n",
    'src/app/old/page.js': "import { permanentRedirect } from 'next/navigation';\n\nexport async function getServerSideProps() {\n  permanentRedirect('/');\n}\n\nexport default function Old() {\n  return null;\n}\n",
    'src/app/sitemap.js': "export default function sitemap() {\n  return [{ url: 'https://example.com/', changeFrequency: 'daily' }];\n}\n",
    'src/app/robots.txt': 'User-agent: *\n',
    'src/app/page.js': "import Link from 'next/link';\nimport { Hello } from '../components/Hello';\nimport site from '../lib/site';\n\nexport default function Home() {\n  return (\n    <main>\n      <Hello name={site.name} />\n      <Link href=\"/blog/a/b\">Blog</Link>\n    </main>\n  );\n}\n",
    'src/app/blog/[...slug]/page.js': "export default function Post({ params }) {\n  return <p>slug={String(params.slug)}</p>;\n}\n",
    'src/components/Hello.js': "'use client';\nimport { usePathname } from 'next/navigation';\n\nexport function Hello({ name }) {\n  return <b>hello {name} at {usePathname()}</b>;\n}\n",
    'src/lib/site.js': "module.exports = { name: 'GioJS' };\n",
  }, ['/', '/blog/a/b', '/search?q=gio', '/old', '/sitemap.xml']);
  const home = assertOk(results, '/');
  assert.match(home, /<b>hello (<!-- -->)?GioJS(<!-- -->)? at (<!-- -->)?\/<\/b>/);
  assert.match(home, /<a [^>]*href="\/blog\/a\/b"/);
  // The kept metadata export renders; the field GioJS lacks is flagged, not rendered.
  assert.match(home, /<title>JS app<\/title>/);
  assert.doesNotMatch(home, /application-name/);
  assert.match(assertOk(results, '/blog/a/b'), /slug=(<!-- -->)?a\/b/);
  // generateMetadata({ params, query: searchParams }) - converted from Next's signature.
  const search = assertOk(results, '/search?q=gio');
  assert.match(search, /<title>Search: gio \| JS app<\/title>/);
  assert.match(search, /<meta name="description" content="0 params"\/>/);
  // permanentRedirect() → throw redirect(url, 308) from getServerSideProps.
  assert.equal(results['/old']?.status, 308);
  assert.deepEqual(results['/old']?.redirect, { destination: '/', permanent: true });
  // app/sitemap.js is served as it was written.
  assert.match(assertOk(results, '/sitemap.xml'), /<url>\n<loc>https:\/\/example\.com\/<\/loc>\n<changefreq>daily<\/changefreq>\n<\/url>/);
});
