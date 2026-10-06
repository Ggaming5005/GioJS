/**
 * giojs-core/src/client-build.test.ts
 *
 * Integration tests for the client bundle pipeline: builds a real fixture app
 * with esbuild and asserts the manifest, hashed output, hydration wiring, and
 * - critically - that getServerSideProps and its server-only imports (secrets,
 * node builtins) never reach the client bundle.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildClientBundles, demoteServerExports, type ClientManifest } from './client-build.ts';
import { discoverLayouts, discoverRoutes } from './router.ts';
import type { RouteModule, LayoutEntry, PageModule, LayoutModule } from './router.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

const PAGE_SOURCE = `
import React from 'react';
import { readSecret, SECRET_MARKER } from '../lib/secret.ts';

interface PageProps { title?: string }

export default function Page({ title }: PageProps) {
  return React.createElement('h1', null, title ?? 'untitled');
}

export async function getServerSideProps() {
  return { props: { title: readSecret() + SECRET_MARKER } };
}
`;

const SECRET_SOURCE = `
import { readFileSync } from 'node:fs';

export const SECRET_MARKER = 'GIO_TEST_SECRET_DO_NOT_BUNDLE';

export function readSecret(): string {
  return readFileSync('/etc/gio-secret', 'utf8');
}
`;

function routeFor(pattern: string, filePath: string, dir = pattern.slice(1)): RouteModule {
  return {
    filePath,
    urlPattern: pattern,
    dir,
    load: (): Promise<PageModule> => Promise.reject(new Error('not loaded in build test')),
  };
}

function layoutFor(dir: string, filePath: string): LayoutEntry {
  return {
    filePath,
    dir,
    load: (): Promise<LayoutModule> => Promise.reject(new Error('not loaded in build test')),
  };
}

describe('buildClientBundles', () => {
  let projectRoot: string;
  let manifest: ClientManifest;
  let chunksDir: string;

  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'gio-client-build-'));
    chunksDir = join(projectRoot, '.gio', 'build', 'static', 'chunks');
    await mkdir(join(projectRoot, 'app', 'docs'), { recursive: true });
    await mkdir(join(projectRoot, 'lib'), { recursive: true });
    await writeFile(join(projectRoot, 'app', 'page.tsx'), PAGE_SOURCE);
    await writeFile(
      join(projectRoot, 'app', 'docs', 'page.tsx'),
      `import React from 'react';
export default function Docs() { return React.createElement('p', null, 'docs'); }
`,
    );
    await writeFile(
      join(projectRoot, 'app', 'docs', 'layout.tsx'),
      `import React from 'react';
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return React.createElement('section', null, children);
}
`,
    );
    await writeFile(join(projectRoot, 'lib', 'secret.ts'), SECRET_SOURCE);

    const routes = new Map<string, RouteModule>([
      ['/', routeFor('/', join(projectRoot, 'app', 'page.tsx'))],
      ['/docs', routeFor('/docs', join(projectRoot, 'app', 'docs', 'page.tsx'))],
    ]);
    const layouts = new Map<string, LayoutEntry>([
      ['docs', layoutFor('docs', join(projectRoot, 'app', 'docs', 'layout.tsx'))],
    ]);

    manifest = await buildClientBundles({
      routes,
      layouts,
      projectRoot,
      dev: true,
      // The fixture lives outside any node_modules tree; resolve react and
      // react-dom from this package's own installation.
      nodePaths: [join(packageDir, 'node_modules')],
    });
  }, 60_000);

  afterAll(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('produces a hashed entry script per route', async () => {
    expect(manifest.get('/')).toMatch(/^\/_next\/static\/chunks\/route-index-[A-Z0-9]+\.js$/);
    expect(manifest.get('/docs')).toMatch(/^\/_next\/static\/chunks\/route-docs-[A-Z0-9]+\.js$/);
    const files = await readdir(chunksDir);
    for (const url of manifest.values()) {
      expect(files).toContain(url.split('/').pop());
    }
  });

  it('registers the route with the shared hydration runtime', async () => {
    const entryFile = join(chunksDir, manifest.get('/')?.split('/').pop() ?? '');
    const contents = await readFile(entryFile, 'utf8');
    expect(contents).toContain('registerRoute');
    expect(contents).toContain('"/"');
  });

  it('splits react into a shared chunk used by both entries', async () => {
    const files = await readdir(chunksDir);
    expect(files.some(f => f.startsWith('shared-'))).toBe(true);
  });

  it('strips getServerSideProps, its secret constants, and node builtins from the bundle', async () => {
    const files = await readdir(chunksDir);
    for (const file of files.filter(f => f.endsWith('.js'))) {
      const contents = await readFile(join(chunksDir, file), 'utf8');
      expect(contents, `${file} must not contain the gSSP secret`).not.toContain(
        'GIO_TEST_SECRET_DO_NOT_BUNDLE',
      );
      expect(contents, `${file} must not contain fs usage`).not.toContain('/etc/gio-secret');
    }
  });

  it('omits routes that fail to build instead of failing the whole build', async () => {
    const brokenRoot = await mkdtemp(join(tmpdir(), 'gio-client-broken-'));
    try {
      await mkdir(join(brokenRoot, 'app', 'bad'), { recursive: true });
      await writeFile(
        join(brokenRoot, 'app', 'page.tsx'),
        `import React from 'react';
export default function Ok() { return React.createElement('p', null, 'ok'); }
`,
      );
      await writeFile(
        join(brokenRoot, 'app', 'bad', 'page.tsx'),
        `import { missing } from './does-not-exist.ts';
export default missing;
`,
      );
      const routes = new Map<string, RouteModule>([
        ['/', routeFor('/', join(brokenRoot, 'app', 'page.tsx'))],
        ['/bad', routeFor('/bad', join(brokenRoot, 'app', 'bad', 'page.tsx'))],
      ]);
      const result = await buildClientBundles({
        routes,
        layouts: new Map(),
        projectRoot: brokenRoot,
        dev: true,
        nodePaths: [join(packageDir, 'node_modules')],
      });
      expect(result.get('/')).toBeDefined();
      expect(result.get('/bad')).toBeUndefined();
    } finally {
      await rm(brokenRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('buildClientBundles layout association', () => {
  let projectRoot: string;
  let entrySources: Map<string, string>;

  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'gio-client-layouts-'));
    const appDir = join(projectRoot, 'app');
    const component = (name: string, tag: string): string => `import React from 'react';
export default function ${name}({ children }: { children?: React.ReactNode }) {
  return React.createElement('${tag}', null, children);
}
`;
    const files: Record<string, string> = {
      'layout.tsx': component('Root', 'body'),
      'posts/[id]/layout.tsx': component('PostLayout', 'article'),
      'posts/[id]/page.tsx': component('Post', 'p'),
      '(shop)/layout.tsx': component('ShopLayout', 'section'),
      '(shop)/cart/page.tsx': component('Cart', 'p'),
      '(marketing)/layout.tsx': component('MarketingLayout', 'aside'),
      '(marketing)/about/page.tsx': component('About', 'p'),
    };
    for (const [rel, source] of Object.entries(files)) {
      await mkdir(dirname(join(appDir, rel)), { recursive: true });
      await writeFile(join(appDir, rel), source);
    }

    const [routes, layouts] = await Promise.all([discoverRoutes(appDir), discoverLayouts(appDir)]);
    const manifest = await buildClientBundles({
      routes,
      layouts,
      projectRoot,
      dev: true,
      nodePaths: [join(packageDir, 'node_modules')],
    });
    expect([...manifest.keys()].sort()).toEqual(['/about', '/cart', '/posts/:id']);

    // The generated entry sources show exactly which layouts each route wraps.
    entrySources = new Map();
    const entriesDir = join(projectRoot, '.gio', 'build', 'entries');
    for (const file of await readdir(entriesDir)) {
      const source = await readFile(join(entriesDir, file), 'utf8');
      const pattern = /registerRoute\(("[^"]*")/.exec(source)?.[1];
      if (pattern !== undefined) entrySources.set(JSON.parse(pattern) as string, source);
    }
  }, 60_000);

  afterAll(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('includes a layout inside a dynamic [id] folder in that route bundle', () => {
    const source = entrySources.get('/posts/:id') ?? '';
    expect(source).toContain('posts/[id]/layout.tsx');
  });

  it("includes a (group) layout only in that group's route bundles", () => {
    expect(entrySources.get('/cart')).toContain('(shop)/layout.tsx');
    expect(entrySources.get('/cart')).not.toContain('(marketing)/layout.tsx');
    expect(entrySources.get('/about')).toContain('(marketing)/layout.tsx');
    expect(entrySources.get('/about')).not.toContain('(shop)/layout.tsx');
  });

  it('keeps the root layout out of every bundle (it stays server-only HTML)', () => {
    for (const source of entrySources.values()) {
      expect(source).not.toContain('/app/layout.tsx');
    }
  });
});

describe('demoteServerExports', () => {
  it('demotes function and const forms of server exports', () => {
    expect(demoteServerExports('export async function getServerSideProps() {}')).toBe(
      'async function getServerSideProps() {}',
    );
    expect(demoteServerExports('export function getStaticPaths() {}')).toBe(
      'function getStaticPaths() {}',
    );
    expect(demoteServerExports('export const getServerSideProps = async () => ({})')).toBe(
      'const getServerSideProps = async () => ({})',
    );
  });

  it('leaves other exports untouched', () => {
    const source = 'export default function Page() {}\nexport const revalidate = 60;';
    expect(demoteServerExports(source)).toBe(source);
  });
});
