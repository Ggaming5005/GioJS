/**
 * giojs-core/src/route-table.test.ts
 *
 * collectRouteTable (`gio routes` / `gio typegen`) must report every URL the
 * boot would serve - pages with their layouts and nearest segment files,
 * route.ts methods, WebSocket handlers, metadata routes - with params,
 * static-before-dynamic ordering, the boot's typed-route patterns, and the
 * boot's conflict errors. A route.ts that fails to import is listed with
 * its error instead of disappearing.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectRouteTable, routeParams } from './route-table.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(packageDir, '.route-table-test-fixture');

async function writeApp(name: string, files: Record<string, string>): Promise<string> {
  const appDir = join(fixtureRoot, name, 'app');
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(appDir, file)), { recursive: true });
    await writeFile(join(appDir, file), content);
  }
  return appDir;
}

const PAGE = 'export default function Page() { return null; }';

describe('routeParams', () => {
  it('reads :param, *catchAll and *optional? segments', () => {
    expect(routeParams('/')).toEqual([]);
    expect(routeParams('/u/:id/files/*path')).toEqual([
      { name: 'id', catchAll: false, optional: false },
      { name: 'path', catchAll: true, optional: false },
    ]);
    expect(routeParams('/shop/*rest?')).toEqual([{ name: 'rest', catchAll: true, optional: true }]);
  });
});

describe('collectRouteTable', () => {
  let appDir: string;

  beforeAll(async () => {
    appDir = await writeApp('full', {
      'layout.tsx': PAGE,
      'page.tsx': PAGE,
      'not-found.tsx': PAGE,
      'error.tsx': PAGE,
      'posts/layout.tsx': PAGE,
      'posts/loading.tsx': PAGE,
      'posts/[id]/page.tsx': PAGE,
      'posts/new/page.tsx': PAGE,
      '(marketing)/about/page.tsx': PAGE,
      'docs/[[...slug]]/page.tsx': PAGE,
      '_components/page.tsx': PAGE,
      'api/hello/route.ts': 'export function GET() { return {}; }\nexport function POST() { return {}; }',
      'chat/[room]/route.ts': 'export function wsHandler() {}',
      'live/route.ts': 'export function wsHandler() {}\nexport function GET() { return {}; }',
      'broken/route.ts': 'throw new Error("db unavailable");',
      'sitemap.ts': 'export default function sitemap() { return []; }',
    });
  });

  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('lists pages with layouts and the nearest segment files', async () => {
    const { routes } = await collectRouteTable(appDir);
    const post = routes.find(r => r.pattern === '/posts/:id');
    expect(post).toEqual({
      pattern: '/posts/:id',
      kind: 'page',
      methods: ['GET'],
      file: 'app/posts/[id]/page.tsx',
      params: [{ name: 'id', catchAll: false, optional: false }],
      layouts: ['app/layout.tsx', 'app/posts/layout.tsx'],
      loading: 'app/posts/loading.tsx',
      error: 'app/error.tsx',
      notFound: 'app/not-found.tsx',
    });
    const about = routes.find(r => r.pattern === '/about');
    expect(about?.file).toBe('app/(marketing)/about/page.tsx');
    expect(about?.layouts).toEqual(['app/layout.tsx']);
    expect(about?.loading).toBeNull();
    expect(routes.find(r => r.pattern === '/docs/*slug?')?.params).toEqual([
      { name: 'slug', catchAll: true, optional: true },
    ]);
    expect(routes.some(r => r.file.includes('_components'))).toBe(false);
  });

  it('lists route.ts methods, WebSocket handlers and metadata routes', async () => {
    const { routes } = await collectRouteTable(appDir);
    const byPattern = (pattern: string) => routes.filter(r => r.pattern === pattern);
    expect(byPattern('/api/hello')).toMatchObject([
      { kind: 'route', methods: ['GET', 'POST'], file: 'app/api/hello/route.ts', layouts: [] },
    ]);
    expect(byPattern('/chat/:room')).toMatchObject([{ kind: 'websocket', methods: [] }]);
    expect(byPattern('/live').map(r => r.kind)).toEqual(['route', 'websocket']);
    expect(byPattern('/sitemap.xml')).toMatchObject([
      { kind: 'metadata', methods: ['GET'], file: 'app/sitemap.ts' },
    ]);
  });

  it('keeps a route.ts that fails to import, with its error', async () => {
    const { routes } = await collectRouteTable(appDir);
    const broken = routes.find(r => r.pattern === '/broken');
    expect(broken?.kind).toBe('route');
    expect(broken?.methods).toEqual([]);
    expect(broken?.loadError).toContain('db unavailable');
  });

  it('orders static segments before dynamic ones', async () => {
    const { routes } = await collectRouteTable(appDir);
    const patterns = routes.map(r => r.pattern);
    expect(patterns[0]).toBe('/');
    expect(patterns.indexOf('/posts/new')).toBeLessThan(patterns.indexOf('/posts/:id'));
  });

  it('types pages and HTTP handlers, like the boot', async () => {
    const { typedPatterns } = await collectRouteTable(appDir);
    expect([...typedPatterns].sort()).toEqual(
      ['/', '/about', '/api/hello', '/broken', '/docs/*slug?', '/live', '/posts/:id', '/posts/new'].sort(),
    );
  });

  it('types a route.ts that needs runtime env the same with and without it', async () => {
    // The auth starter's logout route: createSessionStorage() at module
    // level throws in production without GIO_SESSION_SECRET (CI's typegen).
    const envApp = await writeApp('env', {
      'page.tsx': PAGE,
      'logout/route.ts':
        'if (!process.env.ROUTE_TABLE_TEST_SECRET) throw new Error("ROUTE_TABLE_TEST_SECRET is not set");\n' +
        'export function POST() { return {}; }',
    });
    const without = await collectRouteTable(envApp);
    expect(without.routes.find(r => r.pattern === '/logout')?.loadError).toContain('not set');
    process.env.ROUTE_TABLE_TEST_SECRET = 'x';
    try {
      const withEnv = await collectRouteTable(envApp);
      expect([...new Set(without.typedPatterns)].sort()).toEqual([...new Set(withEnv.typedPatterns)].sort());
      expect(withEnv.typedPatterns).toContain('/logout');
    } finally {
      delete process.env.ROUTE_TABLE_TEST_SECRET;
    }
  });

  it('refuses the conflicts the boot refuses', async () => {
    const conflicted = await writeApp('conflict', {
      '(a)/about/page.tsx': PAGE,
      '(b)/about/route.ts': 'export function GET() { return {}; }',
    });
    await expect(collectRouteTable(conflicted)).rejects.toThrow(/route conflict/);
  });

  it('returns an empty table when app/ does not exist', async () => {
    const table = await collectRouteTable(join(fixtureRoot, 'missing', 'app'));
    expect(table).toEqual({ routes: [], typedPatterns: [] });
  });
});
