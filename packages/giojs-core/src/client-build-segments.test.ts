/**
 * giojs-core/src/client-build-segments.test.ts
 *
 * Hydration entries carry each route's error.* and loading.* files - the
 * nearest ones by folder ancestry, through group and dynamic folders - so
 * the client tree has the boundaries the server rendered. not-found.* stays
 * server-only. An error.* that imports server-only code is rejected by the
 * guard like a page, naming the chain.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildClientBundles, clientBuildErrorFor, type ClientManifest } from './client-build.ts';
import { logger } from './logger.ts';
import { discoverLayouts, discoverRoutes, discoverSegmentFiles } from './router.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

function component(name: string, marker: string): string {
  return `import React from 'react';
export default function ${name}({ children }: { children?: React.ReactNode }) {
  return React.createElement('div', null, ${JSON.stringify(marker)}, children);
}
`;
}

describe('client entries with error.* and loading.*', () => {
  let projectRoot: string;
  let manifest: ClientManifest;
  let entrySources: Map<string, string>;
  const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'gio-client-segments-'));
    const files: Record<string, string> = {
      'app/layout.tsx': component('Root', 'ROOT_LAYOUT_MARKER'),
      'app/error.tsx': component('RootError', 'ROOT_ERROR_MARKER'),
      'app/loading.tsx': component('RootLoading', 'ROOT_LOADING_MARKER'),
      'app/not-found.tsx': component('RootNotFound', 'ROOT_NOT_FOUND_MARKER'),
      'app/(shop)/error.tsx': component('ShopError', 'SHOP_ERROR_MARKER'),
      'app/(shop)/products/[id]/layout.tsx': component('ProductLayout', 'PRODUCT_LAYOUT_MARKER'),
      'app/(shop)/products/[id]/loading.tsx': component('ProductLoading', 'PRODUCT_LOADING_MARKER'),
      'app/(shop)/products/[id]/not-found.tsx': component('ProductNotFound', 'PRODUCT_NOT_FOUND_MARKER'),
      'app/(shop)/products/[id]/page.tsx': component('Product', 'PRODUCT_PAGE'),
      'app/(marketing)/error.tsx': component('MarketingError', 'MARKETING_ERROR_MARKER'),
      'app/(marketing)/about/page.tsx': component('About', 'ABOUT_PAGE'),
      'app/blog/[...slug]/page.tsx': component('Post', 'POST_PAGE'),
      // An error.* is client code: one that pulls in server-only code costs
      // the routes below it their bundle, like a page would.
      'app/blog/error.tsx': `import React from 'react';
import { API_KEY } from '../../lib/keys.server.ts';
export default function BlogError() { return React.createElement('p', null, API_KEY); }
`,
      'lib/keys.server.ts': `export const API_KEY = 'GIO_TEST_ERROR_SECRET_DO_NOT_BUNDLE';\n`,
    };
    for (const [rel, source] of Object.entries(files)) {
      await mkdir(dirname(join(projectRoot, rel)), { recursive: true });
      await writeFile(join(projectRoot, rel), source);
    }
    const appDir = join(projectRoot, 'app');
    const [routes, layouts, segmentFiles] = await Promise.all([
      discoverRoutes(appDir),
      discoverLayouts(appDir),
      discoverSegmentFiles(appDir),
    ]);
    manifest = await buildClientBundles({
      routes,
      layouts,
      segmentFiles,
      projectRoot,
      dev: true,
      nodePaths: [join(packageDir, 'node_modules')],
    });

    entrySources = new Map();
    const entriesDir = join(projectRoot, '.gio', 'build', 'entries');
    for (const file of await readdir(entriesDir)) {
      const source = await readFile(join(entriesDir, file), 'utf8');
      const pattern = /registerRoute\(("[^"]*")/.exec(source)?.[1];
      if (pattern !== undefined) entrySources.set(JSON.parse(pattern) as string, source);
    }
  }, 60_000);

  afterAll(async () => {
    errorLog.mockRestore();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('imports the error.* and loading.* files of every ancestor folder, outermost first', () => {
    const source = entrySources.get('/products/:id') ?? '';
    const order = [
      '/app/error.tsx',
      '/app/loading.tsx',
      '/app/(shop)/error.tsx',
      '/app/(shop)/products/[id]/layout.tsx',
      '/app/(shop)/products/[id]/loading.tsx',
    ].map(file => source.indexOf(file));
    expect(order.every(index => index !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(source).toContain('buildSegmentTree');
  });

  it('names the dynamic segments each level lives under, as the server render does', () => {
    const source = entrySources.get('/products/:id') ?? '';
    // Only the [id] folder's level: its subtree remounts when the id changes.
    expect(source.match(/params: \[[^\]]*\]/g)).toEqual(['params: ["id"]']);
  });

  it("never includes a sibling group's files, not-found.* or the root layout", () => {
    const product = entrySources.get('/products/:id') ?? '';
    expect(product).not.toContain('(marketing)');
    expect(product).not.toContain('not-found');
    expect(product).not.toContain('/app/layout.tsx');
    const about = entrySources.get('/about') ?? '';
    expect(about).toContain('/app/(marketing)/error.tsx');
    expect(about).not.toContain('(shop)');
  });

  it('bundles the boundary components for the browser', async () => {
    const url = manifest.get('/products/:id');
    expect(url).toBeDefined();
    const chunksDir = join(projectRoot, '.gio', 'build', 'static', 'chunks');
    const chunks = await Promise.all(
      (await readdir(chunksDir))
        .filter(f => f.endsWith('.js'))
        .map(f => readFile(join(chunksDir, f), 'utf8')),
    );
    const all = chunks.join('\n');
    for (const marker of ['ROOT_ERROR_MARKER', 'SHOP_ERROR_MARKER', 'PRODUCT_LOADING_MARKER']) {
      expect(all).toContain(marker);
    }
    expect(all).not.toContain('NOT_FOUND_MARKER');
    expect(all).not.toContain('ROOT_LAYOUT_MARKER');
  });

  it('rejects the routes under an error.* that imports server-only code, naming the chain', async () => {
    expect(manifest.get('/blog/*slug')).toBeUndefined();
    expect(clientBuildErrorFor('/blog/*slug')).toContain('app/blog/error.tsx -> lib/keys.server.ts');
    // Upgrading apps whose error.* used to be server-only learn why it matters now.
    expect(clientBuildErrorFor('/blog/*slug')).toContain(
      'app/blog/error.tsx is a client error/loading boundary for every page below its folder',
    );
    expect(manifest.get('/products/:id')).toBeDefined();
    expect(manifest.get('/about')).toBeDefined();
  });
});
