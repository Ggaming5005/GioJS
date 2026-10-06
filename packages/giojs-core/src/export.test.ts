/**
 * giojs-core/src/export.test.ts
 *
 * Static export contract: every export emits a 404.html (static hosts like
 * Cloudflare Pages otherwise fall back to index.html for unknown paths, so
 * every bad URL would 200 with the home page). The built-in 404 is the
 * default; an app/not-found.* overrides it. public/ lands at the site root
 * and under /public/, as the server serves it.
 *
 * Fixtures live under this package so page files can resolve `react`.
 */
import { mkdir, readFile, rm, writeFile, access, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { exportSite, isRootServable } from './export.ts';

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
