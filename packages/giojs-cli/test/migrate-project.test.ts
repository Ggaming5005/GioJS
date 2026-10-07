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

    const pkg = JSON.parse(tree['package.json'] as string) as { dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> };
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
});

test('create-giojs dispatches `migrate` and both bins print usage', () => {
  const dist = join(here, '..', 'dist');
  const viaCreate = execFileSync(process.execPath, [join(dist, 'index.js'), 'migrate', '--help'], { encoding: 'utf8' });
  assert.match(viaCreate, /^Usage: create-giojs migrate \[dir\] \[options\]/);
  assert.match(viaCreate, /npm create giojs@latest -- migrate \[dir\]/);
  const viaBin = execFileSync(process.execPath, [join(dist, 'migrate-cli.js'), '--help'], { encoding: 'utf8' });
  assert.equal(viaBin, viaCreate);
  const createHelp = execFileSync(process.execPath, [join(dist, 'index.js'), '--help'], { encoding: 'utf8' });
  assert.match(createHelp, /npm create giojs@latest -- migrate \[dir\]/);
});
