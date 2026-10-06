/**
 * giojs-core/src/export.test.ts
 *
 * Static export contract: every export emits a 404.html (static hosts like
 * Cloudflare Pages otherwise fall back to index.html for unknown paths, so
 * every bad URL would 200 with the home page). The built-in 404 is the
 * default; an app/not-found.* overrides it. public/ lands at the site root
 * and under /public/, as the server serves it. `gio export` runs in
 * production mode (React's production build) unless NODE_ENV=development,
 * like the server, so exported HTML never carries error messages or stacks.
 *
 * Fixtures live under this package so page files can resolve `react`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile, access, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { exportSite, isRootServable, patternToPath } from './export.ts';

// Vite's import() does not percent-decode file URLs, so bracket folders
// ([...slug] → %5B...slug%5D) would not resolve under vitest - Node's own
// loader decodes them. Load fixture pages by path instead.
vi.mock('./load-ts.ts', async () => {
  const { fileURLToPath: toPath } = await import('node:url');
  return {
    loadTsModule: (fileUrl: string): Promise<unknown> => import(/* @vite-ignore */ toPath(fileUrl)),
  };
});

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(packageDir, '.export-test-fixture');

const PAGE = `import React from 'react';
export default function Home() { return React.createElement('h1', null, 'EXPORT_HOME'); }
`;

const NOT_FOUND = `import React from 'react';
export default function NotFound() { return React.createElement('h1', null, 'EXPORT_CUSTOM_404'); }
`;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('exportSite 404.html', () => {
  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('always emits 404.html - built-in page by default', async () => {
    const appDir = join(fixtureRoot, 'default', 'app');
    const outDir = join(fixtureRoot, 'default', 'out');
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, 'page.tsx'), PAGE);

    const { written } = await exportSite(appDir, outDir);
    expect(written).toContain('/');
    expect(await exists(join(outDir, '404.html'))).toBe(true);
    const html = await readFile(join(outDir, '404.html'), 'utf8');
    expect(html).toContain('HTTP 404');
    expect(html).toContain('Page not found');
  });

  it('app/not-found.tsx overrides the default 404 page', async () => {
    const appDir = join(fixtureRoot, 'custom', 'app');
    const outDir = join(fixtureRoot, 'custom', 'out');
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, 'page.tsx'), PAGE);
    await writeFile(join(appDir, 'not-found.tsx'), NOT_FOUND);

    await exportSite(appDir, outDir);
    const html = await readFile(join(outDir, '404.html'), 'utf8');
    expect(html).toContain('EXPORT_CUSTOM_404');
    expect(html).not.toContain('HTTP 404');
  });

  it('is never claimed by a root optional catch-all page', async () => {
    const appDir = join(fixtureRoot, 'root-catch-all', 'app');
    const outDir = join(fixtureRoot, 'root-catch-all', 'out');
    await mkdir(join(appDir, '[[...all]]'), { recursive: true });
    await writeFile(
      join(appDir, '[[...all]]', 'page.tsx'),
      PARAMS_PAGE('all', 'export function getStaticPaths() { return { paths: [{ params: {} }] }; }'),
    );

    const { written } = await exportSite(appDir, outDir);
    expect(written).toEqual(['/']);
    const html = await readFile(join(outDir, '404.html'), 'utf8');
    expect(html).toContain('HTTP 404');
    expect(html).not.toContain('PARAM all=');
  });
});

// Prints one param so the exported HTML shows what the page received.
function PARAMS_PAGE(name: string, staticPaths = ''): string {
  return `import React from 'react';
export default function Page({ params }) {
  return React.createElement('p', null, 'PARAM ${name}=[' + params['${name}'] + ']');
}
${staticPaths}`;
}

describe('exportSite catch-all routes', () => {
  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('expands getStaticPaths for catch-all and optional catch-all routes', async () => {
    const appDir = join(fixtureRoot, 'catch-all', 'app');
    const outDir = join(fixtureRoot, 'catch-all', 'out');
    await mkdir(join(appDir, 'docs', '[...slug]'), { recursive: true });
    await mkdir(join(appDir, 'shop', '[[...path]]'), { recursive: true });
    await writeFile(
      join(appDir, 'docs', '[...slug]', 'page.tsx'),
      PARAMS_PAGE(
        'slug',
        `export function getStaticPaths() {
  return { paths: [{ params: { slug: 'intro' } }, { params: { slug: 'guides/setup' } }, { params: { slug: ['api', 'ref'] } }] };
}`,
      ),
    );
    await writeFile(
      join(appDir, 'shop', '[[...path]]', 'page.tsx'),
      PARAMS_PAGE(
        'path',
        `export function getStaticPaths() {
  return { paths: [{ params: {} }, { params: { path: 'shoes/red' } }] };
}`,
      ),
    );

    const { written, skipped } = await exportSite(appDir, outDir);
    expect(skipped).toEqual([]);
    expect([...written].sort()).toEqual([
      '/docs/api/ref',
      '/docs/guides/setup',
      '/docs/intro',
      '/shop',
      '/shop/shoes/red',
    ]);
    const nested = await readFile(join(outDir, 'docs', 'guides', 'setup', 'index.html'), 'utf8');
    expect(nested).toContain('PARAM slug=[guides/setup]');
    const arrayForm = await readFile(join(outDir, 'docs', 'api', 'ref', 'index.html'), 'utf8');
    expect(arrayForm).toContain('PARAM slug=[api/ref]');
    const bare = await readFile(join(outDir, 'shop', 'index.html'), 'utf8');
    expect(bare).toContain('PARAM path=[]');
  });

  it('skips getStaticPaths entries that are missing params or escape the route', async () => {
    const appDir = join(fixtureRoot, 'catch-all-bad', 'app');
    const outDir = join(fixtureRoot, 'catch-all-bad', 'out');
    await mkdir(join(appDir, 'docs', '[...slug]'), { recursive: true });
    await writeFile(
      join(appDir, 'docs', '[...slug]', 'page.tsx'),
      PARAMS_PAGE(
        'slug',
        `export function getStaticPaths() {
  return { paths: [{ params: {} }, { params: { slug: '../../escape' } }, { params: { slug: 'ok' } }] };
}`,
      ),
    );

    const { written, skipped } = await exportSite(appDir, outDir);
    expect(written).toEqual(['/docs/ok']);
    expect(skipped.map(s => s.reason)).toEqual([
      'getStaticPaths entry is missing param "slug"',
      'param "slug" has an empty, relative or backslashed segment: "../../escape"',
    ]);
    expect(await exists(join(fixtureRoot, 'catch-all-bad', 'escape'))).toBe(false);
  });
});

describe('patternToPath', () => {
  it('fills :param, *catchAll and *optional? segments', () => {
    expect(patternToPath('/posts/:id', { id: '7' })).toEqual({ path: '/posts/7', params: { id: '7' } });
    expect(patternToPath('/docs/*slug', { slug: 'a/b' })).toEqual({
      path: '/docs/a/b',
      params: { slug: 'a/b' },
    });
    expect(patternToPath('/shop/*p?', {})).toEqual({ path: '/shop', params: { p: '' } });
    expect(patternToPath('/shop/*p?', { p: [] })).toEqual({ path: '/shop', params: { p: '' } });
    expect(patternToPath('/*p?', { p: '' })).toEqual({ path: '/', params: { p: '' } });
  });

  it('rejects a multi-segment value for a one-segment param', () => {
    expect(patternToPath('/posts/:id', { id: 'a/b' })).toEqual({
      error: 'param "id" is a single segment but "a/b" contains \'/\'',
    });
  });

  // On Windows path.join treats '\' as a separator and resolves the '..'
  // parts, so these would write outside out/.
  it('rejects values whose segments contain a backslash', () => {
    expect(patternToPath('/docs/*slug', { slug: 'a\\..\\..\\x' })).toEqual({
      error: 'param "slug" has an empty, relative or backslashed segment: "a\\..\\..\\x"',
    });
    expect(patternToPath('/posts/:id', { id: '..\\..' })).toEqual({
      error: 'param "id" has an empty, relative or backslashed segment: "..\\.."',
    });
    expect(patternToPath('/shop/*p?', { p: ['ok', 'a\\b'] })).toEqual({
      error: 'param "p" has an empty, relative or backslashed segment: "ok/a\\b"',
    });
  });
});

const THROWS = `import React from 'react';
export default function Broken() { throw new Error('EXPORT_RENDER_SECRET'); }
`;

// A Suspense child that throws: React client-renders the boundary and, in
// its development build only, writes the message and stack into the HTML.
const SUSPENSE_THROWS = `import React from 'react';
function Leaky() { throw new Error('SECRET_DB_URL=postgres://u:p@db'); }
export default function Page() {
  return React.createElement('main', null,
    React.createElement('p', null, 'NODE_ENV=' + process.env.NODE_ENV),
    React.createElement(React.Suspense, { fallback: React.createElement('i', null, 'loading') },
      React.createElement(Leaky)));
}
`;

const giojsBin = join(packageDir, '..', 'giojs', 'bin', 'gio.js');
const tsxCli = join(packageDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const exportCli = join(packageDir, 'src', 'export-cli.ts');

/** Run an export entry point in a child process with NODE_ENV unset. */
function runExport(args: string[], appDir: string, outDir: string): Promise<{ code: number | null; output: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIO_APP_DIR: appDir, GIO_OUT_DIR: outDir };
  delete env['NODE_ENV'];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: dirname(appDir), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

describe('gio export .env loading', () => {
  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('loads the project .env files (production precedence) without overriding the environment', async () => {
    const projectDir = join(fixtureRoot, 'env');
    const appDir = join(projectDir, 'app');
    const outDir = join(projectDir, 'out');
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, 'page.tsx'),
      `import React from 'react';
export default function Home(props: { a: string; b: string }) {
  return React.createElement('p', null, \`A=\${props.a};B=\${props.b}\`);
}
export async function getServerSideProps() {
  return { props: { a: process.env.GIO_EXPORT_TEST_A, b: process.env.GIO_EXPORT_TEST_B } };
}
`,
    );
    await writeFile(join(projectDir, '.env'), 'GIO_EXPORT_TEST_A=from-env\nGIO_EXPORT_TEST_B=from-env\n');
    await writeFile(join(projectDir, '.env.production'), 'GIO_EXPORT_TEST_A=from-env-production\n');
    await writeFile(join(projectDir, '.env.development'), 'GIO_EXPORT_TEST_A=from-env-development\n');

    const result = spawnSync(
      process.execPath,
      [join(packageDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(packageDir, 'src', 'export-cli.ts')],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'production',
          GIO_APP_DIR: appDir,
          GIO_OUT_DIR: outDir,
          GIO_EXPORT_TEST_B: 'from-process',
        },
        timeout: 60_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('loaded env: .env.production, .env');
    const html = await readFile(join(outDir, 'index.html'), 'utf8');
    expect(html).toContain('A=from-env-production;B=from-process');
  }, 60_000);
});

describe('exportSite errors', () => {
  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('reports a failed render with the digest of its logged details', async () => {
    const appDir = join(fixtureRoot, 'throws', 'app');
    const outDir = join(fixtureRoot, 'throws', 'out');
    await mkdir(join(appDir, 'broken'), { recursive: true });
    await writeFile(join(appDir, 'page.tsx'), PAGE);
    await writeFile(join(appDir, 'broken', 'page.tsx'), THROWS);

    const { written, skipped } = await exportSite(appDir, outDir);
    expect(written).toEqual(['/']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.route).toBe('/broken');
    expect(skipped[0]?.reason).toMatch(/^render error: Internal Server Error \(ref [0-9a-f]{12}, details in the error log\)$/);
  });

  for (const [launcher, args] of [
    ['gio export', [giojsBin, 'export']],
    ['export-cli.ts', [tsxCli, exportCli]],
  ] as const) {
    it(`${launcher} with NODE_ENV unset renders with React's production build`, async () => {
      const name = launcher.replace(/\W+/g, '-');
      const appDir = join(fixtureRoot, name, 'app');
      const outDir = join(fixtureRoot, name, 'out');
      await mkdir(appDir, { recursive: true });
      await writeFile(join(appDir, 'page.tsx'), SUSPENSE_THROWS);

      const { code, output } = await runExport([...args], appDir, outDir);
      expect(code, output).toBe(0);
      const html = await readFile(join(outDir, 'index.html'), 'utf8');
      expect(html).toContain('NODE_ENV=production');
      // The failed boundary carries only React's digest - no message, no stack.
      expect(html).toContain('data-dgst');
      expect(html).not.toContain('SECRET_DB_URL');
      expect(html).not.toContain('data-msg');
      expect(html).not.toContain('data-stck');
    }, 30_000);
  }
});

describe('exportSite public/', () => {
  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  async function put(root: string, rel: string, contents: string): Promise<void> {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), contents);
  }

  it('copies public/ to the site root as well as /public/, with the server rules', async () => {
    const base = join(fixtureRoot, 'public-root');
    const appDir = join(base, 'app');
    const outDir = join(base, 'out');
    const publicDir = join(base, 'public');
    await put(appDir, 'page.tsx', PAGE);
    await put(appDir, 'about/page.tsx', PAGE);
    await put(publicDir, 'robots.txt', 'User-agent: *\nDisallow: /private\n');
    await put(publicDir, 'favicon.ico', 'ICO');
    await put(publicDir, 'images/logo.svg', '<svg/>');
    await put(publicDir, '.well-known/security.txt', 'Contact: mailto:security@example.com\n');
    await put(publicDir, '.well-known/.hidden', 'no');
    await put(publicDir, '.env', 'SECRET=1');
    await put(publicDir, 'nested/.DS_Store', 'no');
    await put(publicDir, '_gio/health', 'fake');
    await put(publicDir, 'index.html', 'PUBLIC_INDEX');
    await put(publicDir, 'about/photo.png', 'PNG');
    if (process.platform !== 'win32') {
      await symlink(join(publicDir, 'favicon.ico'), join(publicDir, 'linked.ico'));
    }

    const { written, skipped } = await exportSite(appDir, outDir);
    expect(written).toEqual(expect.arrayContaining(['/', '/about']));

    // The user's robots.txt wins over the generated one.
    expect(await readFile(join(outDir, 'robots.txt'), 'utf8')).toBe('User-agent: *\nDisallow: /private\n');
    expect(await readFile(join(outDir, 'favicon.ico'), 'utf8')).toBe('ICO');
    expect(await exists(join(outDir, 'images', 'logo.svg'))).toBe(true);
    expect(await exists(join(outDir, '.well-known', 'security.txt'))).toBe(true);
    expect(await exists(join(outDir, 'about', 'photo.png'))).toBe(true);
    // /public/* keeps working.
    expect(await readFile(join(outDir, 'public', 'favicon.ico'), 'utf8')).toBe('ICO');

    for (const hidden of ['.env', 'nested/.DS_Store', '.well-known/.hidden', '_gio/health', 'linked.ico']) {
      expect(await exists(join(outDir, hidden)), hidden).toBe(false);
    }

    // A rendered page keeps its output file; the collision is reported.
    expect(await readFile(join(outDir, 'index.html'), 'utf8')).toContain('EXPORT_HOME');
    expect(skipped.map(s => s.route)).toContain('/index.html');
  });

  it('generates robots.txt when public/ has none', async () => {
    const base = join(fixtureRoot, 'public-no-robots');
    const appDir = join(base, 'app');
    const outDir = join(base, 'out');
    await put(appDir, 'page.tsx', PAGE);
    await put(join(base, 'public'), 'favicon.ico', 'ICO');

    await exportSite(appDir, outDir);
    expect(await readFile(join(outDir, 'robots.txt'), 'utf8')).toMatch(/^User-agent: \*\nAllow: \/\n/);
    expect(await readFile(join(outDir, 'favicon.ico'), 'utf8')).toBe('ICO');
  });

  it('isRootServable mirrors the server index', () => {
    expect(isRootServable('robots.txt')).toBe(true);
    expect(isRootServable('images/logo.svg')).toBe(true);
    expect(isRootServable('.well-known/security.txt')).toBe(true);
    expect(isRootServable('nested/_gio/ok.txt')).toBe(true);
    expect(isRootServable('.env')).toBe(false);
    expect(isRootServable('.git/config')).toBe(false);
    expect(isRootServable('nested/.DS_Store')).toBe(false);
    expect(isRootServable('.well-known/.hidden')).toBe(false);
    expect(isRootServable('nested/.well-known/x')).toBe(false);
    expect(isRootServable('_gio/health')).toBe(false);
  });
});
