/**
 * giojs-core/src/export.test.ts
 *
 * Static export contract: every export emits a 404.html (static hosts like
 * Cloudflare Pages otherwise fall back to index.html for unknown paths, so
 * every bad URL would 200 with the home page). The built-in 404 is the
 * default; an app/not-found.* overrides it. `gio export` runs in production
 * mode (React's production build) unless NODE_ENV=development, like the
 * server, so exported HTML never carries error messages or stacks.
 *
 * Fixtures live under this package so page files can resolve `react`.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { exportSite } from './export.ts';

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
