/**
 * giojs-core/src/export.test.ts
 *
 * Static export contract: every export emits a 404.html (static hosts like
 * Cloudflare Pages otherwise fall back to index.html for unknown paths, so
 * every bad URL would 200 with the home page). The built-in 404 is the
 * default; an app/not-found.* overrides it.
 *
 * Fixtures live under this package so page files can resolve `react`.
 */
import { spawnSync } from 'node:child_process';
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
