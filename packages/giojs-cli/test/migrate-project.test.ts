/**
 * giojs-cli/test/migrate-project.test.ts
 *
 * Whole-project migration on temp trees: pages/ → app/ moves, the generated
 * root layout, gio.toml creation and merging (never overwriting),
 * package.json/tsconfig.json updates, MIGRATION_REPORT.md, --dry-run
 * writing nothing, and the confirmation rules of the command line.
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigration, planMigration } from '../dist/migrate.js';
import { parseMigrateArgs, runMigrate, type MigrateIO } from '../dist/migrate-command.js';
import { pagesProject } from './fixtures/pages-project.ts';

const here = dirname(fileURLToPath(import.meta.url));

async function writeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gio-migrate-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  return root;
}

async function readTree(root: string, dir = root): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await readTree(root, abs));
    else out[relative(root, abs).replace(/\\/g, '/')] = await readFile(abs, 'utf8');
  }
  return out;
}

function fakeIO(options: { interactive?: boolean; answer?: boolean } = {}): MigrateIO & { out: string[]; err: string[]; asked: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  return {
    out,
    err,
    asked,
    log: line => out.push(line),
    error: line => err.push(line),
    confirm: async question => {
      asked.push(question);
      return options.answer ?? false;
    },
    interactive: options.interactive ?? false,
    color: false,
  };
}

test('a pages-router project migrates to app/ conventions', async () => {
  const root = await writeTree(pagesProject);
  try {
    await applyMigration(await planMigration(root));
    const tree = await readTree(root);

    // Moves: pages/ is gone, every page landed on its app/ path.
    assert.equal(existsSync(join(root, 'pages')), false);
    for (const path of [
      'app/page.tsx', 'app/about/page.tsx', 'app/blog/[slug]/page.tsx', 'app/docs/[...slug]/page.tsx',
      'app/not-found.tsx', 'app/error.tsx', 'app/api/hello/route.ts', 'app/api/users/[id]/route.ts',
      'app/layout.tsx', 'app/styles/globals.css', 'middleware.next.ts', 'gio.toml', 'MIGRATION_REPORT.md',
    ]) {
      assert.ok(tree[path] !== undefined, `${path} exists`);
    }
    assert.equal(tree['middleware.ts'], undefined);
    assert.equal(tree['styles/globals.css'], undefined);
    assert.equal(tree['public/robots.txt'], 'User-agent: *\n');

    // Relative imports follow the move; data fetching became getServerSideProps.
    const post = tree['app/blog/[slug]/page.tsx'] as string;
    assert.match(post, /from '\.\.\/\.\.\/\.\.\/components\/Layout'/);
    assert.match(post, /from '\.\.\/\.\.\/\.\.\/lib\/posts'/);
    assert.match(post, /export async function getServerSideProps\(/);
    assert.match(post, /export const revalidate = 60;/);
    assert.match(post, /return \{ props: getPost\(params\.slug\) \};/);

    const home = tree['app/page.tsx'] as string;
    assert.match(home, /^import \{ GioLink \} from '@gio\.js\/react';\nimport \{ Layout \} from '\.\.\/components\/Layout';/);
    assert.match(home, /<>\n\s+<title>Home<\/title>\n\s+<\/>/);

    // _app + _document → root layout with the document shell and the global CSS link.
    const layout = tree['app/layout.tsx'] as string;
    assert.match(layout, /<html lang="de">/);
    assert.match(layout, /<link rel="icon" href="\/favicon\.ico" \/>/);
    assert.match(layout, /<link rel="stylesheet" href="\/styles\/globals\.css" \/>/);
    assert.match(layout, /<body className="antialiased">\{children\}<\/body>/);
    assert.match(layout, /TODO\(gio-migrate\): pages\/_app\.tsx wrapped every page in <ThemeProvider>/);

    assert.match(tree['app/api/hello/route.ts'] as string, /^\/\/ TODO\(gio-migrate\): port this Next\.js API route \(was pages\/api\/hello\.ts\)/);
    assert.match(tree['middleware.next.ts'] as string, /^\/\/ TODO\(gio-migrate\): Next\.js middleware: GioJS middleware\.ts exports declarative rules/);

    // next.config.js → gio.toml (created).
    assert.match(tree['gio.toml'] as string, /\[\[redirects\]\]\nfrom = "\/old\/\*path"\nto = "\/new\/\*path"\nstatus = 308/);
    assert.match(tree['gio.toml'] as string, /\[\[images\.remote_patterns\]\]\nprotocol = "https"\nhostname = "images\.example\.com"/);

    const pkg = JSON.parse(tree['package.json'] as string) as { type: string; dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> };
    // @gio.js/react is ESM-only: without "type": "module" tsx loads app/*.tsx as
    // CommonJS and every page importing it fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
    assert.equal(pkg.type, 'module');
    assert.deepEqual(Object.keys(pkg).slice(0, 3), ['name', 'private', 'type']);
    // The migrated code imports @gio.js/core (the API-route sketch): a direct
    // dependency, so strict installs (pnpm, Yarn PnP) resolve it.
    assert.equal(pkg.dependencies['@gio.js/core'], pkg.dependencies['@gio.js/server']);
    assert.equal(pkg.dependencies['next'], undefined);
    assert.equal(pkg.devDependencies['eslint-config-next'], undefined);
    assert.match(pkg.dependencies['@gio.js/server'] ?? '', /^\^0\./);
    assert.equal(pkg.dependencies['react'], '^19.0.0');
    assert.equal(pkg.scripts['dev'], 'cross-env NODE_ENV=development giojs-server');
    assert.equal(pkg.scripts['start'], 'cross-env NODE_ENV=production giojs-server');
    assert.equal(pkg.scripts['build'], 'tsc --noEmit');

    const tsconfig = JSON.parse(tree['tsconfig.json'] as string) as { compilerOptions: Record<string, unknown>; include: string[] };
    assert.equal(tsconfig.compilerOptions['jsx'], 'react-jsx');
    assert.equal(tsconfig.compilerOptions['plugins'], undefined);
    assert.deepEqual(tsconfig.include, ['**/*.ts', '**/*.tsx', '.gio/routes.d.ts']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('MIGRATION_REPORT.md lists every TODO with a file:line that points at it', async () => {
  const root = await writeTree(pagesProject);
  try {
    await applyMigration(await planMigration(root));
    const report = await readFile(join(root, 'MIGRATION_REPORT.md'), 'utf8');
    assert.match(report, /^# GioJS migration report\n/);
    assert.match(report, /for a Next\.js pages router project/);
    assert.match(report, /\| `pages\/blog\/\[slug\]\.tsx` \| `app\/blog\/\[slug\]\/page\.tsx` \|/);
    assert.match(report, /\| `pages\/_app\.tsx` \+ `pages\/_document\.tsx` \| `app\/layout\.tsx` \|/);
    assert.match(report, /`app\/blog\/\[slug\]\/page\.tsx:8` getStaticProps → getServerSideProps \+ export const revalidate = 60/);
    assert.match(report, /- \[ \] `package\.json` - script "lint" runs `next lint`: no GioJS equivalent/);
    assert.match(report, /- \[ \] `next-env\.d\.ts` - delete it/);
    assert.match(report, /redirect \/old\/:path\* → \/new\/:path\* → \[\[redirects\]\] \/old\/\*path → \/new\/\*path \(308\)/);

    // Every file:line TODO reference lands on that TODO comment in the file.
    const refs = [...report.matchAll(/^- \[ \] `([^`]+):(\d+)` - (.*)$/gm)];
    assert.ok(refs.length >= 4);
    for (const [, file, line, message] of refs) {
      const lines = (await readFile(join(root, file as string), 'utf8')).split('\n');
      const at = lines[Number(line) - 1] ?? '';
      assert.ok(at.includes(`TODO(gio-migrate): ${message as string}`), `${file}:${line} is "${at}"`);
    }
    // And every TODO comment in the project is in the report.
    const todoCount = Object.values(await readTree(root))
      .reduce((n, text) => n + (text.match(/TODO\(gio-migrate\):/g)?.length ?? 0), 0);
    const reportTodos = (report.match(/^- \[ \] /gm) ?? []).length;
    const fileless = (report.match(/^- \[ \] `[^`:]+` - /gm) ?? []).length;
    // The report itself quotes no TODO marker; layout/route/middleware/gio.toml hold the rest.
    assert.equal(todoCount, reportTodos - fileless);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--dry-run prints the plan and diffs and writes nothing', async () => {
  const root = await writeTree(pagesProject);
  try {
    const before = await readTree(root);
    const io = fakeIO();
    assert.equal(await runMigrate([root, '--dry-run'], io), 0);
    assert.deepEqual(await readTree(root), before);
    const output = io.out.join('\n');
    assert.match(output, /→ pages\/index\.tsx → app\/page\.tsx/);
    assert.match(output, /\+ gio\.toml/);
    assert.match(output, /--- pages\/index\.tsx\n\+\+\+ app\/page\.tsx/);
    assert.match(output, /-import Link from 'next\/link';/);
    assert.match(output, /\+import \{ GioLink \} from '@gio\.js\/react';/);
    assert.match(output, /Dry run - nothing was written\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('without a terminal the migration needs --yes; a declined prompt writes nothing', async () => {
  const root = await writeTree(pagesProject);
  try {
    const before = await readTree(root);
    const headless = fakeIO();
    assert.equal(await runMigrate([root], headless), 1);
    assert.match(headless.err.join('\n'), /re-run with --yes to apply, or --dry-run to preview/);
    assert.deepEqual(await readTree(root), before);

    const declined = fakeIO({ interactive: true, answer: false });
    assert.equal(await runMigrate([root], declined), 0);
    assert.equal(declined.asked.length, 1);
    assert.deepEqual(await readTree(root), before);

    const yes = fakeIO();
    assert.equal(await runMigrate([root, '--yes'], yes), 0);
    assert.ok(existsSync(join(root, 'app', 'page.tsx')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an existing gio.toml is merged into, never overwritten', async () => {
  const existing = '[app]\nname = "kept"\n\n[server]\nhost = "127.0.0.1"\nport = 4000\n';
  const root = await writeTree({ ...pagesProject, 'gio.toml': existing });
  try {
    await applyMigration(await planMigration(root));
    const toml = await readFile(join(root, 'gio.toml'), 'utf8');
    assert.ok(toml.startsWith(existing), 'the original content is untouched');
    assert.match(toml, /\[\[redirects\]\]\nfrom = "\/old\/\*path"/);
    assert.equal(existsSync(join(root, 'gio.migrated.toml')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('when merging is unsafe the config goes to gio.migrated.toml and gio.toml stays byte-identical', async () => {
  const existing = '[images]\nremote_patterns = [{ hostname = "x.com" }]\n';
  const root = await writeTree({ ...pagesProject, 'gio.toml': existing });
  try {
    await applyMigration(await planMigration(root));
    assert.equal(await readFile(join(root, 'gio.toml'), 'utf8'), existing);
    const migrated = await readFile(join(root, 'gio.migrated.toml'), 'utf8');
    assert.match(migrated, /^# Converted from next\.config by create-giojs migrate\. Not loaded by GioJS:/);
    assert.match(migrated, /\[\[redirects\]\]/);
    const report = await readFile(join(root, 'MIGRATION_REPORT.md'), 'utf8');
    assert.match(report, /\*\*Not merged:\*\* gio\.toml sets images\.remote_patterns inline/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('moves never overwrite: a page whose app/ target exists stays put with a TODO', async () => {
  const root = await writeTree({
    'package.json': '{"name":"hybrid","dependencies":{"next":"14.0.0"}}\n',
    'tsconfig.json': '{ "compilerOptions": { "jsx": "react-jsx" } }\n',
    'pages/about.tsx': 'export default function A() { return <p>pages</p>; }\n',
    'app/about/page.tsx': 'export default function A() { return <p>app</p>; }\n',
    'app/layout.tsx': 'export default function L({ children }) { return <html><body>{children}</body></html>; }\n',
  });
  try {
    const plan = await planMigration(root);
    assert.equal(plan.router, 'both');
    assert.ok(plan.todos.some(t => t.file === 'pages/about.tsx' && /already exists/.test(t.message)));
    await applyMigration(plan);
    assert.equal(await readFile(join(root, 'app/about/page.tsx'), 'utf8'), 'export default function A() { return <p>app</p>; }\n');
    assert.ok(existsSync(join(root, 'pages/about.tsx')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an app-router project under src/app moves to app/ and keeps its structure', async () => {
  const root = await writeTree({
    'package.json': '{"name":"app-router","scripts":{"dev":"next dev"},"dependencies":{"next":"15.0.0","react":"19.0.0","react-dom":"19.0.0"}}\n',
    'tsconfig.json': '{\n  // Next.js default\n  "compilerOptions": { "jsx": "preserve", "plugins": [{ "name": "next" }] },\n  "include": ["next-env.d.ts", "**/*.tsx"]\n}\n',
    'next.config.mjs': "export default { i18n: { locales: ['en', 'de'], defaultLocale: 'en' } };\n",
    'src/app/layout.tsx': "import './globals.css';\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang=\"en\">\n      <body>{children}</body>\n    </html>\n  );\n}\n",
    'src/app/globals.css': 'body { margin: 0 }\n',
    'src/app/page.tsx': "'use client';\nimport { useRouter } from 'next/navigation';\nimport { Button } from '../components/Button';\n\nexport default function Home() {\n  const router = useRouter();\n  return <Button onClick={() => router.push('/about')} />;\n}\n",
    'src/app/(marketing)/about/page.tsx': 'export default function About() { return <p>About</p>; }\n',
    'src/app/api/health/route.ts': "export function GET() { return { ok: true }; }\n",
    'src/components/Button.tsx': 'export function Button(props: { onClick(): void }) { return <button onClick={props.onClick} />; }\n',
  });
  try {
    const plan = await planMigration(root);
    assert.equal(plan.router, 'app');
    await applyMigration(plan);
    const tree = await readTree(root);
    assert.equal(existsSync(join(root, 'src', 'app')), false);
    assert.ok(tree['src/components/Button.tsx'] !== undefined);
    assert.equal(tree['app/(marketing)/about/page.tsx'], 'export default function About() { return <p>About</p>; }\n');
    assert.equal(tree['app/api/health/route.ts'], "export function GET() { return { ok: true }; }\n");
    assert.equal(tree['app/globals.css'], 'body { margin: 0 }\n');
    assert.equal(
      tree['app/page.tsx'],
      "import { useRouter } from '@gio.js/react';\nimport { Button } from '../src/components/Button';\n\nexport default function Home() {\n  const router = useRouter();\n  return <Button onClick={() => router.push('/about')} />;\n}\n",
    );
    // The root layout links app/globals.css (served at /globals.css) instead of importing it.
    assert.match(tree['app/layout.tsx'] as string, /<html lang="en">\n\s+<head>\n\s+<meta charSet="utf-8" \/>\n\s+<meta name="viewport"[^\n]+\n\s+<link rel="stylesheet" href="\/globals\.css" \/>\n\s+<\/head>/);
    assert.doesNotMatch(tree['app/layout.tsx'] as string, /import '\.\/globals\.css'/);
    assert.match(tree['gio.toml'] as string, /\[i18n\]\nlocales = \["en", "de"\]\ndefault_locale = "en"/);
    assert.match(tree['MIGRATION_REPORT.md'] as string, /for a Next\.js app router project/);
    // tsconfig.json with comments is edited in place: comment kept, only the touched values change.
    assert.equal(
      tree['tsconfig.json'],
      '{\n  // Next.js default\n  "compilerOptions": { "jsx": "react-jsx" },\n  "include": ["**/*.tsx", ".gio/routes.d.ts"]\n}\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('app router metadata files: conventions GioJS serves stay, static files move to public/, Server Action forms post to page actions', async () => {
  const root = await writeTree({
    'package.json': '{"name":"meta","dependencies":{"next":"15.0.0","react":"19.0.0","react-dom":"19.0.0"}}\n',
    'tsconfig.json': '{ "compilerOptions": { "jsx": "preserve" } }\n',
    'app/layout.tsx': "import type { Metadata } from 'next';\n\nexport const metadata: Metadata = { title: { default: 'Meta', template: '%s | Meta' } };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang=\"en\">\n      <body>{children}</body>\n    </html>\n  );\n}\n",
    'app/sitemap.ts': "import type { MetadataRoute } from 'next';\n\nexport default function sitemap(): MetadataRoute.Sitemap {\n  return [{ url: 'https://example.com/' }];\n}\n",
    'app/robots.txt': 'User-agent: *\n',
    'app/manifest.json': '{ "name": "Meta" }\n',
    'app/favicon.ico': 'ico',
    'app/icon.png': 'png',
    'app/(site)/blog/opengraph-image.png': 'png',
    'app/(site)/blog/opengraph-image.alt.txt': 'The blog',
    'app/(site)/blog/[slug]/opengraph-image.jpg': 'jpg',
    'app/(site)/blog/[slug]/page.tsx': 'export default function Post() { return <p />; }\n',
    'app/twitter-image.tsx': "export default function Image() { return null; }\n",
    'app/docs/sitemap.ts': 'export default function sitemap() { return []; }\n',
    'app/actions.ts': "'use server';\n\nexport async function createPost(formData: FormData) {\n  await save(formData.get('title'));\n}\n\ndeclare function save(v: unknown): Promise<void>;\n",
    'app/edit/page.tsx': "import { createPost } from '@/app/actions';\n\nexport default function Edit() {\n  return <form action={createPost} />;\n}\n",
    'app/new/page.tsx': "import { createPost } from '../actions';\n\nexport default function New() {\n  return (\n    <form action={createPost}>\n      <input name=\"title\" />\n    </form>\n  );\n}\n",
  });
  try {
    const plan = await planMigration(root);
    await applyMigration(plan);
    const tree = await readTree(root);
    // GioJS serves these from public/, exactly where Next served them from app/.
    for (const file of ['robots.txt', 'manifest.json', 'favicon.ico', 'icon.png', 'blog/opengraph-image.png']) {
      assert.ok(tree[`public/${file}`] !== undefined, `public/${file}`);
      assert.equal(tree[`app/${file}`], undefined);
    }
    // No static URL for a dynamic folder's image: it stays, flagged.
    assert.equal(tree['app/(site)/blog/[slug]/opengraph-image.jpg'], 'jpg');
    assert.equal(tree['app/sitemap.ts'], "import type { MetadataRoute } from '@gio.js/core';\n\nexport default function sitemap(): MetadataRoute.Sitemap {\n  return [{ url: 'https://example.com/' }];\n}\n");
    assert.match(tree['app/layout.tsx'] as string, /^import type \{ Metadata \} from '@gio\.js\/core';\n\nexport const metadata: Metadata = /);
    assert.doesNotMatch(tree['app/layout.tsx'] as string, /TODO/);
    assert.match(tree['app/new/page.tsx'] as string, /<GioForm>\n {6}<input name="title" \/>\n {4}<\/GioForm>/);
    // Through create-next-app's @/ alias too.
    assert.match(tree['app/edit/page.tsx'] as string, /^import \{ createPost \} from '@\/app\/actions';\nimport \{ GioForm \} from '@gio\.js\/react';[\s\S]*<GioForm \/>/);
    assert.match(tree['app/actions.ts'] as string, /^\/\/ TODO\(gio-migrate\): Server Action: /);

    const todos = plan.todos.map(t => `${t.file ?? ''}: ${t.message}`);
    const has = (pattern: RegExp): void => assert.ok(todos.some(t => pattern.test(t)), `${pattern} in\n${todos.join('\n')}`);
    has(/^public\/manifest\.json: Next\.js linked the manifest from every page: add manifest: '\/manifest\.json' to the root layout's metadata export \(GioJS renders <link rel="manifest"> from it\)$/);
    has(/^public\/icon\.png: Next\.js linked this icon automatically; GioJS links it from metadata - add icons: \{ icon: '\/icon\.png' \} to the metadata export of app\/layout$/);
    has(/^public\/blog\/opengraph-image\.png: [^\n]+add openGraph: \{ images: '\/blog\/opengraph-image\.png' \} to the metadata export of app\/\(site\)\/blog\/layout \(or page\) - its alt text is in opengraph-image\.alt\.txt$/);
    has(/^app\/\(site\)\/blog\/\[slug\]\/opengraph-image\.jpg: file-based opengraph-image images are not picked up by GioJS, and this folder has no static URL/);
    has(/^app\/twitter-image\.tsx: generated twitter-image files \(ImageResponse\) are not supported/);
    has(/^app\/docs\/sitemap\.ts: only app\/sitemap\.ts at the app root is served \(at \/sitemap\.xml\)/);
    assert.ok(!todos.some(t => /^app\/sitemap\.ts|not supported - put|is not supported - serve/.test(t)), todos.join('\n'));
    assert.ok(plan.notes.some(n => /^app\/sitemap\.ts works as it is: GioJS serves it at \/sitemap\.xml, resolves relative URLs against GIO_SITE_URL/.test(n)));

    const report = tree['MIGRATION_REPORT.md'] as string;
    assert.match(report, /\n## Server Actions\n\nGioJS has no Server Actions\. A form's action becomes the page's `action` export/);
    assert.match(report, /export async function action\(req: ActionArgs\) \{\n {2}const form = await req\.formData\(\);/);
    assert.match(report, /<GioForm> \{\/\* was <form action=\{createPost\}> \*\/\}/);
    assert.match(report, /- `export const metadata`, `generateMetadata\(ctx, \{ props \}\)`, `app\/sitemap\.ts`, `app\/robots\.ts` and `app\/manifest\.ts` work like in Next\.js, except that pages link the manifest only when the metadata says so \(`manifest: '\/manifest\.webmanifest'`\)/);
    assert.doesNotMatch(report, /there are no Server Components, `'use client'` or Server Actions/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('app/manifest.ts is kept, with a TODO to link it from the root layout metadata the way Next linked it on its own', async () => {
  const manifest = "import type { MetadataRoute } from 'next';\n\nexport default function manifest(): MetadataRoute.Manifest {\n  return { name: 'Meta', start_url: '/', display: 'standalone' };\n}\n";
  const root = await writeTree({
    'package.json': '{"name":"pwa","dependencies":{"next":"15.0.0","react":"19.0.0","react-dom":"19.0.0"}}\n',
    'app/layout.tsx': "export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang=\"en\">\n      <body>{children}</body>\n    </html>\n  );\n}\n",
    'app/manifest.ts': manifest,
  });
  try {
    const plan = await planMigration(root);
    assert.equal(plan.files.find(f => f.to === 'app/manifest.ts')?.content, manifest.replace("from 'next'", "from '@gio.js/core'"));
    // GioJS serves it at /manifest.webmanifest, but renders <link rel="manifest"> from metadata only.
    assert.deepEqual(plan.todos.filter(t => t.file === 'app/manifest.ts').map(t => t.message), [
      "Next.js linked the manifest from every page: add manifest: '/manifest.webmanifest' to the root layout's metadata export (GioJS renders <link rel=\"manifest\"> from it)",
    ]);
    assert.ok(plan.notes.some(n => /^app\/manifest\.ts works as it is: GioJS serves it at \/manifest\.webmanifest/.test(n)), plan.notes.join('\n'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a project without Server Actions gets no Server Actions section in the report', async () => {
  const root = await writeTree(pagesProject);
  try {
    const plan = await planMigration(root);
    const report = plan.files.find(f => f.to === 'MIGRATION_REPORT.md')?.content as string;
    assert.doesNotMatch(report, /## Server Actions/);
    assert.match(report, /- Forms post to the page's own `export async function action\(req\)`/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a JavaScript project without tsconfig.json gets React in scope for JSX', async () => {
  const root = await writeTree({
    'package.json': '{"name":"js-app","dependencies":{"next":"14.0.0"}}\n',
    'jsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }\n',
    'pages/index.jsx': "import Link from 'next/link';\n\nexport default function Home() {\n  return <Link href=\"/about\">About</Link>;\n}\n",
    'pages/about.jsx': "import { useState } from 'react';\n\nexport default function About() {\n  const [n] = useState(0);\n  return <p>{n}</p>;\n}\n",
    'lib/util.js': 'export const add = (a, b) => a + b;\n',
  });
  try {
    const plan = await planMigration(root);
    await applyMigration(plan);
    assert.equal(
      await readFile(join(root, 'app/page.jsx'), 'utf8'),
      "import React from 'react';\nimport { GioLink } from '@gio.js/react';\n\nexport default function Home() {\n  return <GioLink href=\"/about\">About</GioLink>;\n}\n",
    );
    assert.match(await readFile(join(root, 'app/about/page.jsx'), 'utf8'), /^import React, \{ useState \} from 'react';/);
    // No JSX, nothing added.
    assert.equal(await readFile(join(root, 'lib/util.js'), 'utf8'), 'export const add = (a, b) => a + b;\n');
    assert.ok(plan.todos.some(t => t.file === 'jsconfig.json' && /path aliases/.test(t.message)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a JavaScript project: JSX .js files become .jsx, CommonJS files .cjs, and imports follow', async () => {
  const root = await writeTree({
    'package.json': '{"name":"js-app","scripts":{"dev":"next dev"},"dependencies":{"next":"14.0.0","react":"18.2.0","react-dom":"18.2.0"}}\n',
    'pages/_app.js': "import '../styles/globals.css';\nexport default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n",
    'pages/index.js': "import Link from 'next/link';\nimport { Nav } from '../components/Nav';\nimport { Card } from '../components/Card.js';\nimport { add } from '../lib/util';\nimport data from '../lib/data';\n\nexport default function Home() {\n  return <main><Nav /><Card n={add(1, 2)} /><Link href=\"/about\">{data.title}</Link></main>;\n}\n",
    'pages/about.js': 'export default function About() {\n  return <p>About</p>;\n}\n',
    'pages/api/hello.js': 'export default function handler(req, res) {\n  res.json({ ok: true });\n}\n',
    'components/Nav.js': "import { Card } from './Card';\nexport function Nav() {\n  return <nav><Card n={0} /></nav>;\n}\n",
    'components/Card.js': 'export const Card = ({ n }) => <b>{n}</b>;\n',
    'lib/util.js': 'export const add = (a, b) => a + b;\n',
    'lib/data.js': "module.exports = { title: 'Data' };\n",
    'lib/legacy.js': "import fs from 'fs';\nexport const read = () => fs.readFileSync('x');\nmodule.exports.extra = 1;\n",
    'styles/globals.css': 'body { margin: 0 }\n',
    'postcss.config.js': "module.exports = { plugins: { autoprefixer: {} } };\n",
    'tailwind.config.js': "/** @type {import('tailwindcss').Config} */\nmodule.exports = { content: ['./app/**/*.{js,jsx}'] };\n",
    'scripts/seed.js': "const path = require('path');\nconsole.log(path.join(__dirname, 'seed.json'));\n",
    'next.config.js': 'module.exports = { reactStrictMode: true };\n',
  });
  try {
    const plan = await planMigration(root);
    await applyMigration(plan);
    const tree = await readTree(root);

    // JSX in .js: GioJS compiles it only in .jsx (tsx and esbuild's js loader reject it).
    for (const [from, to] of [
      ['pages/index.js', 'app/page.jsx'], ['pages/about.js', 'app/about/page.jsx'],
      ['components/Nav.js', 'components/Nav.jsx'], ['components/Card.js', 'components/Card.jsx'],
    ]) {
      assert.ok(tree[to] !== undefined, `${to} exists`);
      assert.equal(tree[from as string], undefined, `${from} is gone`);
    }
    // The root layout generated from _app is JSX too.
    assert.ok(tree['app/layout.jsx'] !== undefined);
    assert.equal(tree['app/layout.js'], undefined);
    // Without JSX a .js file stays put; a route handler stays route.js.
    assert.equal(tree['lib/util.js'], 'export const add = (a, b) => a + b;\n');
    assert.ok(tree['app/api/hello/route.js'] !== undefined);

    // Imports keep their style: extension-less stays extension-less, `.js` becomes `.jsx`,
    // and a CommonJS module renamed to .cjs is imported by its full name.
    const home = tree['app/page.jsx'] as string;
    assert.match(home, /import \{ Nav \} from '\.\.\/components\/Nav';/);
    assert.match(home, /import \{ Card \} from '\.\.\/components\/Card\.jsx';/);
    assert.match(home, /import \{ add \} from '\.\.\/lib\/util';/);
    assert.match(home, /import data from '\.\.\/lib\/data\.cjs';/);
    assert.match(tree['components/Nav.jsx'] as string, /^import \{ Card \} from '\.\/Card';\nimport React from 'react';\n/);

    // "type": "module" makes every .js an ES module: pure CommonJS files become .cjs.
    assert.equal(JSON.parse(tree['package.json'] as string).type, 'module');
    assert.equal(tree['postcss.config.cjs'], "module.exports = { plugins: { autoprefixer: {} } };\n");
    assert.ok(tree['tailwind.config.cjs'] !== undefined);
    assert.ok(tree['scripts/seed.cjs'] !== undefined);
    assert.equal(tree['lib/data.cjs'], "module.exports = { title: 'Data' };\n");
    for (const gone of ['postcss.config.js', 'tailwind.config.js', 'scripts/seed.js', 'lib/data.js']) assert.equal(tree[gone], undefined, gone);
    // An ES module that also assigns module.exports can't be renamed: TODO.
    assert.ok(tree['lib/legacy.js'] !== undefined);
    assert.ok(plan.todos.some(t => t.file === 'lib/legacy.js' && /module\.exports\/exports, which does nothing now that package\.json has "type": "module"/.test(t.message)));
    // next.config.js is left for the user to delete, not renamed.
    assert.ok(tree['next.config.js'] !== undefined);

    const report = tree['MIGRATION_REPORT.md'] as string;
    assert.match(report, /\| `components\/Card\.js` \| `components\/Card\.jsx` \|/);
    assert.match(report, /\| `postcss\.config\.js` \| `postcss\.config\.cjs` \|/);
    assert.match(report, /renamed \.js → \.jsx: GioJS compiles JSX only in \.jsx\/\.tsx files/);
    assert.match(report, /renamed \.js → \.cjs: package\.json now has "type": "module"/);
    assert.match(report, /"type": \(none\) → "module"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a project that is already "type": "module" keeps its .js files and package type', async () => {
  const root = await writeTree({
    'package.json': '{"name":"esm-app","type":"module","dependencies":{"next":"15.0.0"}}\n',
    'tsconfig.json': '{ "compilerOptions": { "jsx": "react-jsx" } }\n',
    'app/page.tsx': 'export default function P() { return <p />; }\n',
    'eslint.config.js': "import next from 'eslint-config-next';\nexport default [next];\n",
    'lib/cjs.js': 'module.exports = 1;\n',
  });
  try {
    const plan = await planMigration(root);
    assert.ok(!plan.files.some(f => f.to.endsWith('.cjs')), 'nothing renamed to .cjs');
    const pkg = plan.files.find(f => f.to === 'package.json');
    assert.ok(pkg !== undefined && typeof pkg.content === 'string');
    assert.ok(!pkg.changes.some(c => /"type"/.test(c.message)));
    assert.equal(JSON.parse(pkg.content).type, 'module');
    // Nothing in the migrated code imports @gio.js/core, so it isn't added.
    assert.equal(JSON.parse(pkg.content).dependencies['@gio.js/core'], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a directory without Next.js is refused', async () => {
  const root = await writeTree({ 'package.json': '{"name":"plain","dependencies":{"react":"19.0.0"}}\n' });
  try {
    const io = fakeIO();
    assert.equal(await runMigrate([root, '--yes'], io), 1);
    assert.match(io.err.join('\n'), /no Next\.js project found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parseMigrateArgs reads the directory and flags', () => {
  assert.deepEqual(parseMigrateArgs(['--dry-run', 'site'], '/work'), { dir: '/work/site', dryRun: true, yes: false, help: false });
  assert.deepEqual(parseMigrateArgs(['-y'], '/work'), { dir: '/work', dryRun: false, yes: true, help: false });
  assert.deepEqual(parseMigrateArgs(['--config', 'next.config.js'], '/work'), { dir: '/work', dryRun: false, yes: false, help: false, config: '/work/next.config.js' });
  assert.deepEqual(parseMigrateArgs(['--force']), { error: 'unknown option --force' });
  assert.deepEqual(parseMigrateArgs(['a', 'b']), { error: 'unexpected argument b' });
  // pnpm, yarn and bun pass the npm-style `--` separator on.
  assert.deepEqual(parseMigrateArgs(['site', '--', '--dry-run'], '/work'), { dir: '/work/site', dryRun: true, yes: false, help: false });
});

test('create-giojs dispatches `migrate` and both bins print usage', () => {
  const dist = join(here, '..', 'dist');
  const viaCreate = execFileSync(process.execPath, [join(dist, 'index.js'), 'migrate', '--help'], { encoding: 'utf8' });
  // `pnpm create giojs -- migrate --help` reaches the bin with the `--`.
  const viaPnpm = execFileSync(process.execPath, [join(dist, 'index.js'), '--', 'migrate', '--help'], { encoding: 'utf8' });
  assert.equal(viaPnpm, viaCreate);
  assert.match(viaCreate, /^Usage: create-giojs migrate \[dir\] \[options\]/);
  assert.match(viaCreate, /npm create giojs@latest -- migrate \[dir\]/);
  // `npx gio-migrate` would fetch whatever npm package is named gio-migrate.
  assert.doesNotMatch(viaCreate, /npx gio-migrate/);
  assert.match(viaCreate, /npx -p create-giojs gio-migrate \[dir\]/);
  const viaBin = execFileSync(process.execPath, [join(dist, 'migrate-cli.js'), '--help'], { encoding: 'utf8' });
  assert.equal(viaBin, viaCreate);
  const createHelp = execFileSync(process.execPath, [join(dist, 'index.js'), '--help'], { encoding: 'utf8' });
  assert.match(createHelp, /npm create giojs@latest -- migrate \[dir\]/);
});
