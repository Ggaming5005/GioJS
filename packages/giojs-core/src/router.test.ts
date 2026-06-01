/**
 * giojs-core/src/router.test.ts
 *
 * Discovery must find pages, layouts, and route handlers authored in either
 * TypeScript or JavaScript, and resolve a single deterministic file when more
 * than one extension is present in a directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverRoutes, discoverLayouts, discoverRouteFiles } from './router.ts';

let appDir: string;

beforeEach(async () => {
  appDir = await mkdtemp(join(tmpdir(), 'giojs-router-'));
});

afterEach(async () => {
  await rm(appDir, { recursive: true, force: true });
});

async function touch(relPath: string, body = 'export default function P() { return null; }'): Promise<void> {
  const full = join(appDir, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, body, 'utf8');
}

describe('route discovery across extensions', () => {
  it('discovers a page.jsx file', async () => {
    await touch('page.jsx');
    const routes = await discoverRoutes(appDir);
    expect(routes.has('/')).toBe(true);
  });

  it('discovers a page.js file', async () => {
    await touch('about/page.js');
    const routes = await discoverRoutes(appDir);
    expect(routes.has('/about')).toBe(true);
  });

  it('discovers a layout.jsx file', async () => {
    await touch('layout.jsx');
    const layouts = await discoverLayouts(appDir);
    expect(layouts.has('/')).toBe(true);
  });

  it('discovers a route.js handler file', async () => {
    await touch('stream/route.js', 'export function GET() {}');
    const routeFiles = await discoverRouteFiles(appDir);
    expect(routeFiles.some(r => r.urlPattern === '/stream')).toBe(true);
  });

  it('prefers .tsx over .jsx when both exist in one directory', async () => {
    await touch('page.tsx');
    await touch('page.jsx');
    const routes = await discoverRoutes(appDir);
    const root = routes.get('/');
    expect(root?.filePath.endsWith('page.tsx')).toBe(true);
  });

  it('maps dynamic .jsx segments to params', async () => {
    await touch('posts/[id]/page.jsx');
    const routes = await discoverRoutes(appDir);
    expect(routes.has('/posts/:id')).toBe(true);
  });
});
