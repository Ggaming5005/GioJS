/**
 * giojs-core/src/router.test.ts
 *
 * Discovery must find pages, layouts, and route handlers authored in either
 * TypeScript or JavaScript, and resolve a single deterministic file when more
 * than one extension is present in a directory. Folder conventions: [id],
 * [...slug], [[...slug]], (group) and _private folders; layouts associate by
 * filesystem ancestry; two files answering the same URLs fail discovery.
 * not-found/error/loading files are found per folder and selected nearest
 * first by the same ancestry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverRoutes,
  discoverLayouts,
  discoverRouteFiles,
  assertNoRouteConflicts,
  layoutsForDir,
  discoverSegmentFiles,
  nearestSegmentFiles,
  segmentChainForDir,
  ancestorDirs,
} from './router.ts';

let projectRoot: string;
let appDir: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'giojs-router-'));
  appDir = join(projectRoot, 'app');
  await mkdir(appDir);
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
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
    expect(layouts.has('')).toBe(true);
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

describe('export const revalidate at discovery', () => {
  const page = (value: string): string =>
    `export const revalidate${value};\nexport default function P() { return null; }\n`;

  // These used to fail only when the page was requested (a bare 500 before
  // that); a literal is read from the source, so boot refuses them.
  for (const [value, shown] of [
    [' = -5', '-5'],
    [' = 1.5', '1.5'],
    [" = '60'", '"60"'],
    [' = NaN', 'NaN'],
    [': number = .5', '0.5'],
    [' = true', 'boolean'],
  ]) {
    it(`refuses revalidate${value} naming the file`, async () => {
      await touch('blog/page.tsx', page(value ?? ''));
      await expect(discoverRoutes(appDir)).rejects.toThrow(
        `app/blog/page.tsx: export const revalidate must be a whole number of seconds (0 or more) or false - got ${shown}`,
      );
    });
  }

  it('accepts valid literals, and leaves expressions to the render-time check', async () => {
    await touch('a/page.tsx', page(' = 60 // one minute'));
    await touch('b/page.tsx', page(' = false'));
    await touch('c/page.tsx', page(' = 1_000'));
    await touch('d/page.tsx', page(' = 60 * -1'));
    await touch('e/page.tsx', page(' = ONE_HOUR'));
    await touch('f/page.tsx', "// export const revalidate = -1;\nexport default function P() { return null; }\n");
    const routes = await discoverRoutes(appDir);
    expect([...routes.keys()].sort()).toEqual(['/a', '/b', '/c', '/d', '/e', '/f']);
  });

  it('reads the export from code only - not from comments, strings or template literals', async () => {
    const rest = 'export default function P() { return null; }\n';
    await touch('a/page.tsx', `/*\nexport const revalidate = -1;\n*/\nexport const revalidate = 60;\n${rest}`);
    await touch('b/page.tsx', `const code = \`\nexport const revalidate = '60';\n\`;\n${rest}`);
    await touch('c/page.tsx', `const code = \`\${'x'}\nexport const revalidate = -1;\n\${\`\nexport const revalidate = 1.5;\n\`}\`;\n${rest}`);
    await touch('d/page.tsx', `const s = "it's \\"quoted\\"";\nconst re = /'/g;\nconst t = \`\nexport const revalidate = NaN;\n\`;\n${rest}`);
    const routes = await discoverRoutes(appDir);
    expect([...routes.keys()].sort()).toEqual(['/a', '/b', '/c', '/d']);
  });

  it('still refuses a real export that follows a comment or a code sample', async () => {
    await touch(
      'blog/page.tsx',
      `/* export const revalidate = 60; */\nconst code = \`\nexport const revalidate = 60;\n\`;\nexport const revalidate = '60';\nexport default function P() { return null; }\n`,
    );
    await expect(discoverRoutes(appDir)).rejects.toThrow(
      'app/blog/page.tsx: export const revalidate must be a whole number of seconds (0 or more) or false - got "60"',
    );
  });
});

describe('dynamic segment conventions', () => {
  it('maps [id], [...slug] and [[...slug]] to one-segment, catch-all and optional catch-all params', async () => {
    await touch('posts/[id]/page.tsx');
    await touch('docs/[...slug]/page.tsx');
    await touch('shop/[[...path]]/page.tsx');
    const routes = await discoverRoutes(appDir);
    expect([...routes.keys()].sort()).toEqual(['/docs/*slug', '/posts/:id', '/shop/*path?']);
  });

  it('applies the same conventions to route.ts handlers', async () => {
    await touch('api/files/[...key]/route.ts', 'export function GET() {}');
    await touch('api/search/[[...terms]]/route.ts', 'export function GET() {}');
    const routeFiles = await discoverRouteFiles(appDir);
    expect(routeFiles.map(r => r.urlPattern).sort()).toEqual([
      '/api/files/*key',
      '/api/search/*terms?',
    ]);
  });

  it('rejects a catch-all that is not the last segment', async () => {
    await touch('docs/[...slug]/edit/page.tsx');
    await expect(discoverRoutes(appDir)).rejects.toThrow(
      'app/docs/[...slug]/edit/page.tsx: catch-all segment "*slug" must be the last',
    );
  });

  it('rejects malformed bracket segments instead of treating them as literals', async () => {
    await touch('posts/[[id]]/page.tsx');
    await expect(discoverRoutes(appDir)).rejects.toThrow('unsupported dynamic segment "[[id]]"');
  });

  // ':' is not a legal filename character on Windows.
  it.skipIf(process.platform === 'win32')('rejects literal folders that would read back as param patterns', async () => {
    await touch(':id/page.tsx');
    await expect(discoverRoutes(appDir)).rejects.toThrow(`folder ":id" may not start with ':' or '*'`);
  });

  // '?', ':' and '*' are not legal filename characters on Windows.
  it.skipIf(process.platform === 'win32')('rejects param names containing pattern syntax', async () => {
    // "[...slug?]" would otherwise read back as an optional catch-all named
    // "slug", and "[id?]" as a param literally named "id?".
    for (const folder of ['[...slug?]', '[[...slug?]]', '[id?]', '[a:b]', '[*x]']) {
      await rm(appDir, { recursive: true, force: true });
      await touch(`a/${folder}/page.tsx`);
      await expect(discoverRoutes(appDir)).rejects.toThrow(`unsupported dynamic segment "${folder}"`);
    }
    await rm(appDir, { recursive: true, force: true });
    await touch('api/[...key?]/route.ts', 'export function GET() {}');
    await expect(discoverRouteFiles(appDir)).rejects.toThrow('unsupported dynamic segment "[...key?]"');
  });

  it('rejects a param name used twice in one route', async () => {
    await touch('[id]/items/[id]/page.tsx');
    await expect(discoverRoutes(appDir)).rejects.toThrow('param "id" appears more than once');
  });
});

describe('route groups and private folders', () => {
  it('omits (group) folders from page, handler and nested patterns', async () => {
    await touch('(marketing)/about/page.tsx');
    await touch('(marketing)/(promo)/sale/page.tsx');
    await touch('(shop)/page.tsx');
    await touch('(api)/api/ping/route.ts', 'export function GET() {}');
    const routes = await discoverRoutes(appDir);
    expect([...routes.keys()].sort()).toEqual(['/', '/about', '/sale']);
    expect(routes.get('/about')?.dir).toBe('(marketing)/about');
    const routeFiles = await discoverRouteFiles(appDir);
    expect(routeFiles.map(r => r.urlPattern)).toEqual(['/api/ping']);
  });

  it('never routes _private folders or anything nested under them', async () => {
    await touch('_components/page.tsx');
    await touch('_gio/health/page.tsx');
    await touch('blog/_drafts/post/page.tsx');
    await touch('_internal/route.ts', 'export function GET() {}');
    await touch('_shared/layout.tsx');
    await touch('blog/page.tsx');
    const routes = await discoverRoutes(appDir);
    expect([...routes.keys()]).toEqual(['/blog']);
    expect(await discoverRouteFiles(appDir)).toEqual([]);
    expect([...(await discoverLayouts(appDir)).keys()]).toEqual([]);
  });

  it('keys layouts by their app-relative directory, groups and brackets included', async () => {
    await touch('layout.tsx');
    await touch('(shop)/layout.tsx');
    await touch('posts/[id]/layout.tsx');
    const layouts = await discoverLayouts(appDir);
    expect([...layouts.keys()].sort()).toEqual(['', '(shop)', 'posts/[id]']);
  });
});

describe('route conflicts', () => {
  it('fails when two pages in different groups resolve to the same URL, naming both files', async () => {
    await touch('(a)/about/page.tsx');
    await touch('(b)/about/page.tsx');
    await expect(discoverRoutes(appDir)).rejects.toThrow(
      'route conflict: app/(a)/about/page.tsx and app/(b)/about/page.tsx both resolve to "/about"',
    );
  });

  it('fails when a group page collides with a top-level page', async () => {
    await touch('page.tsx');
    await touch('(home)/page.tsx');
    await expect(discoverRoutes(appDir)).rejects.toThrow('both resolve to "/"');
  });

  it('fails when two dynamic pages differ only in param name', async () => {
    await touch('posts/[id]/page.tsx');
    await touch('(x)/posts/[slug]/page.tsx');
    await expect(discoverRoutes(appDir)).rejects.toThrow(
      '"/posts/:slug" and "/posts/:id" (the same URLs under different param names)',
    );
  });

  it('fails when two route.ts files resolve to the same URL', async () => {
    await touch('(v1)/api/route.ts', 'export function GET() {}');
    await touch('(v2)/api/route.ts', 'export function GET() {}');
    await expect(discoverRouteFiles(appDir)).rejects.toThrow(
      'app/(v1)/api/route.ts and app/(v2)/api/route.ts both resolve to "/api"',
    );
  });

  it('fails when a page and a route.ts in different folders resolve to the same URL', async () => {
    await touch('(a)/about/page.tsx');
    await touch('(b)/about/route.ts', 'export function POST() {}');
    const routes = await discoverRoutes(appDir);
    const routeFiles = await discoverRouteFiles(appDir);
    expect(() => assertNoRouteConflicts(appDir, routes, routeFiles)).toThrow(
      'app/(a)/about/page.tsx and app/(b)/about/route.ts both resolve to "/about"',
    );
  });

  it('fails when a catch-all and an optional catch-all share a parent', async () => {
    await touch('docs/[...a]/page.tsx');
    await touch('docs/[[...b]]/page.tsx');
    await expect(discoverRoutes(appDir)).rejects.toThrow(
      'route conflict: app/docs/[...a]/page.tsx and app/docs/[[...b]]/page.tsx overlap - ' +
        '"/docs/*a" outranks "/docs/*b?" on every URL below "/docs", leaving the optional ' +
        'catch-all only "/docs" itself',
    );
  });

  it('applies the catch-all / optional catch-all rule to route.ts files and across file types', async () => {
    await touch('(v1)/[[...rest]]/route.ts', 'export function GET() {}');
    await touch('(v2)/[...all]/route.ts', 'export function GET() {}');
    await expect(discoverRouteFiles(appDir)).rejects.toThrow(
      'app/(v1)/[[...rest]]/route.ts and app/(v2)/[...all]/route.ts overlap - "/*all" outranks ' +
        '"/*rest?" on every URL below "/"',
    );

    await rm(appDir, { recursive: true, force: true });
    await touch('docs/[[...b]]/page.tsx');
    await touch('(api)/docs/[...a]/route.ts', 'export function GET() {}');
    const routes = await discoverRoutes(appDir);
    const routeFiles = await discoverRouteFiles(appDir);
    expect(() => assertNoRouteConflicts(appDir, routes, routeFiles)).toThrow(
      'app/docs/[[...b]]/page.tsx and app/(api)/docs/[...a]/route.ts overlap - "/docs/*a" outranks "/docs/*b?"',
    );
  });

  it('allows a route.ts next to its page.tsx (GET-less methods fall through to the page)', async () => {
    await touch('contact/page.tsx');
    await touch('contact/route.ts', 'export function POST() {}');
    const routes = await discoverRoutes(appDir);
    const routeFiles = await discoverRouteFiles(appDir);
    expect(() => assertNoRouteConflicts(appDir, routes, routeFiles)).not.toThrow();
  });

  it('allows a static page beside an optional catch-all that also matches it', async () => {
    await touch('shop/page.tsx');
    await touch('shop/[[...path]]/page.tsx');
    const routes = await discoverRoutes(appDir);
    expect([...routes.keys()].sort()).toEqual(['/shop', '/shop/*path?']);
  });
});

describe('layoutsForDir', () => {
  it('returns the ancestor layouts outermost first, through group and dynamic folders', async () => {
    await touch('layout.tsx');
    await touch('(shop)/layout.tsx');
    await touch('(shop)/products/[id]/layout.tsx');
    await touch('(marketing)/layout.tsx');
    await touch('(shop)/products/[id]/page.tsx');
    await touch('(marketing)/about/page.tsx');
    const layouts = await discoverLayouts(appDir);
    const routes = await discoverRoutes(appDir);

    const product = routes.get('/products/:id');
    expect(product?.dir).toBe('(shop)/products/[id]');
    expect(layoutsForDir(product?.dir ?? '', layouts).map(l => l.dir)).toEqual([
      '',
      '(shop)',
      '(shop)/products/[id]',
    ]);
    // A sibling group's layout never applies.
    expect(layoutsForDir(routes.get('/about')?.dir ?? '', layouts).map(l => l.dir)).toEqual([
      '',
      '(marketing)',
    ]);
  });

  it('returns only the root layout for app/ itself, and nothing without one', async () => {
    await touch('layout.tsx');
    await touch('docs/layout.tsx');
    const layouts = await discoverLayouts(appDir);
    expect(layoutsForDir('', layouts).map(l => l.dir)).toEqual(['']);
    expect(layoutsForDir('docs/guide', new Map())).toEqual([]);
  });
});

describe('segment files (not-found, error, loading)', () => {
  it('discovers each kind per folder, groups and dynamic folders included, private never', async () => {
    await touch('not-found.tsx');
    await touch('error.tsx');
    await touch('(shop)/error.jsx');
    await touch('(shop)/products/[id]/not-found.tsx');
    await touch('(shop)/products/[id]/loading.js');
    await touch('docs/[...slug]/loading.tsx');
    await touch('_internal/error.tsx');
    await touch('posts/page.tsx');
    await touch('posts/loading.ts'); // .ts is not a component extension
    const files = await discoverSegmentFiles(appDir);
    expect([...files.notFound.keys()].sort()).toEqual(['', '(shop)/products/[id]']);
    expect([...files.error.keys()].sort()).toEqual(['', '(shop)']);
    expect([...files.loading.keys()].sort()).toEqual(['(shop)/products/[id]', 'docs/[...slug]']);
    const productLoading = files.loading.get('(shop)/products/[id]');
    expect(productLoading?.kind).toBe('loading');
    expect(productLoading?.filePath).toBe(join(appDir, '(shop)', 'products', '[id]', 'loading.js'));
  });

  it('prefers .tsx over .jsx over .js in one folder', async () => {
    await touch('loading.js');
    await touch('loading.tsx');
    const files = await discoverSegmentFiles(appDir);
    expect(files.loading.get('')?.filePath).toBe(join(appDir, 'loading.tsx'));
  });

  it('lists the ancestors of a folder outermost first', () => {
    expect(ancestorDirs('')).toEqual(['']);
    expect(ancestorDirs('(shop)/products/[id]')).toEqual([
      '',
      '(shop)',
      '(shop)/products',
      '(shop)/products/[id]',
    ]);
  });

  it('selects the nearest file at or above a folder, across group and dynamic folders', async () => {
    await touch('not-found.tsx');
    await touch('(shop)/not-found.tsx');
    await touch('(shop)/products/[id]/not-found.tsx');
    await touch('(marketing)/about/page.tsx');
    const files = await discoverSegmentFiles(appDir);
    const nearest = (dir: string): string[] =>
      nearestSegmentFiles(dir, files.notFound).map(f => f.dir);
    expect(nearest('(shop)/products/[id]/reviews')).toEqual([
      '(shop)/products/[id]',
      '(shop)',
      '',
    ]);
    expect(nearest('(shop)/products')).toEqual(['(shop)', '']);
    // A sibling group's file never applies.
    expect(nearest('(marketing)/about')).toEqual(['']);
  });

  it("builds a page's hydrated chain: layouts below app/, error and loading files at any level", async () => {
    await touch('layout.tsx');
    await touch('error.tsx');
    await touch('loading.tsx');
    await touch('(shop)/layout.tsx');
    await touch('(shop)/products/[id]/layout.tsx');
    await touch('(shop)/products/[id]/error.tsx');
    await touch('(shop)/products/[id]/loading.tsx');
    await touch('(shop)/products/[id]/not-found.tsx');
    await touch('(shop)/products/[id]/page.tsx');
    const [layouts, files] = await Promise.all([discoverLayouts(appDir), discoverSegmentFiles(appDir)]);
    const chain = segmentChainForDir('(shop)/products/[id]', layouts, files);
    expect(
      chain.map(level => ({
        dir: level.dir,
        layout: level.layout !== undefined,
        error: level.error !== undefined,
        loading: level.loading !== undefined,
        params: level.params,
      })),
    ).toEqual([
      // The root layout stays server-only HTML outside the boundary.
      { dir: '', layout: false, error: true, loading: true, params: [] },
      { dir: '(shop)', layout: true, error: false, loading: false, params: [] },
      // (shop)/products holds nothing and is left out.
      { dir: '(shop)/products/[id]', layout: true, error: true, loading: true, params: ['id'] },
    ]);
  });

  it('names every dynamic segment from app/ down to each level, catch-alls included', async () => {
    await touch('teams/[team]/layout.tsx');
    await touch('teams/[team]/docs/[[...path]]/error.tsx');
    await touch('teams/[team]/docs/[[...path]]/page.tsx');
    await touch('files/[...rest]/loading.tsx');
    await touch('files/[...rest]/page.tsx');
    const [layouts, files] = await Promise.all([discoverLayouts(appDir), discoverSegmentFiles(appDir)]);
    expect(segmentChainForDir('teams/[team]/docs/[[...path]]', layouts, files).map(l => l.params)).toEqual([
      ['team'],
      ['team', 'path'],
    ]);
    expect(segmentChainForDir('files/[...rest]', layouts, files).map(l => l.params)).toEqual([['rest']]);
  });
});
