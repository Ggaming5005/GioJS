/**
 * giojs-core/src/metadata-routes.test.ts
 *
 * app/sitemap.ts, app/robots.ts and app/manifest.ts: serialization (XML
 * escaping, robots directive injection), discovery at the app root, route
 * conflicts, and the worker's answers (content types, cache fields, errors).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  escapeXml,
  metadataRouteMaxAge,
  renderMetadataRoute,
  serializeManifest,
  serializeRobots,
  serializeSitemap,
  type MetadataRoute,
  type MetadataRouteEntry,
  type MetadataRouteModule,
} from './metadata-routes.ts';
import { assertNoMetadataRouteConflicts, discoverMetadataRoutes, type RouteModule } from './router.ts';
import { renderRoute } from './ssr.ts';
import type { IPCRequest } from './context.ts';

function makeRequest(path: string, method = 'GET'): IPCRequest {
  return {
    id: 'mr',
    method,
    path,
    params: {},
    query: {},
    headers: {},
    body: null,
    bodyBase64: false,
    deploymentId: 'test',
    locale: 'en',
  };
}

function entry(kind: MetadataRouteEntry['kind'], mod: MetadataRouteModule): MetadataRouteEntry {
  return { kind, filePath: `/app/${kind}.ts`, load: async () => mod };
}

describe('serializeSitemap', () => {
  it('writes a sitemaps.org urlset with every field', () => {
    const xml = serializeSitemap(
      [
        {
          url: 'https://example.com/',
          lastModified: new Date('2026-01-02T03:04:05Z'),
          changeFrequency: 'weekly',
          priority: 1,
          alternates: { languages: { de: 'https://example.com/de' } },
        },
        { url: '/about', lastModified: '2026-02-01' },
      ],
      'https://example.com',
    );
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
        '<url>',
        '<loc>https://example.com/</loc>',
        '<xhtml:link rel="alternate" hreflang="de" href="https://example.com/de"/>',
        '<lastmod>2026-01-02T03:04:05.000Z</lastmod>',
        '<changefreq>weekly</changefreq>',
        '<priority>1</priority>',
        '</url>',
        '<url>',
        '<loc>https://example.com/about</loc>',
        '<lastmod>2026-02-01</lastmod>',
        '</url>',
        '</urlset>',
        '',
      ].join('\n'),
    );
  });

  it('escapes XML and drops characters XML cannot carry', () => {
    const xml = serializeSitemap([{ url: 'https://example.com/?a=1&b=<2>"\'\u0000\u0007' }], undefined);
    expect(xml).toContain('<loc>https://example.com/?a=1&amp;b=&lt;2&gt;&quot;&apos;</loc>');
    expect(xml).not.toContain('xmlns:xhtml');
    expect(escapeXml('ok 🌍 \uD800 end')).toBe('ok 🌍  end');
  });

  it('keeps relative URLs (and reports them) when no site URL is known', () => {
    const warn = vi.fn();
    const sitemap: MetadataRoute.Sitemap = [{ url: '/x' }];
    expect(serializeSitemap(sitemap, undefined, warn)).toContain('<loc>/x</loc>');
    expect(warn).toHaveBeenCalledWith('/x');
  });

  it('rejects invalid entries, naming them', () => {
    expect(() => serializeSitemap({}, undefined)).toThrow(/array/);
    expect(() => serializeSitemap([{}], undefined)).toThrow(/entry 0 has no url/);
    expect(() => serializeSitemap([{ url: '/a', priority: 2 }], undefined)).toThrow(/priority/);
    expect(() =>
      serializeSitemap([{ url: '/a', changeFrequency: 'sometimes' as never }], undefined),
    ).toThrow(/changeFrequency/);
    expect(() => serializeSitemap([{ url: '/a', lastModified: new Date('nope') }], undefined)).toThrow(
      /invalid Date/,
    );
  });
});

describe('serializeRobots', () => {
  it('writes rule groups, then host and sitemaps', () => {
    const text = serializeRobots(
      {
        rules: [
          { userAgent: '*', allow: '/', disallow: ['/admin', '/api'] },
          { userAgent: ['GPTBot', 'CCBot'], disallow: '/', crawlDelay: 10 },
        ],
        host: 'example.com',
        sitemap: '/sitemap.xml',
      },
      'https://example.com',
    );
    expect(text).toBe(
      [
        'User-Agent: *',
        'Allow: /',
        'Disallow: /admin',
        'Disallow: /api',
        '',
        'User-Agent: GPTBot',
        'User-Agent: CCBot',
        'Disallow: /',
        'Crawl-delay: 10',
        '',
        'Host: example.com',
        'Sitemap: https://example.com/sitemap.xml',
        '',
      ].join('\n'),
    );
  });

  it('defaults the user agent to *', () => {
    const robots: MetadataRoute.Robots = { rules: { disallow: '/private' } };
    expect(serializeRobots(robots, undefined)).toBe(
      'User-Agent: *\nDisallow: /private\n',
    );
  });

  it('refuses values that would smuggle in extra directives', () => {
    expect(() => serializeRobots({ rules: { disallow: '/x\nAllow: /secret' } }, undefined)).toThrow(
      /single line/,
    );
    expect(() => serializeRobots({ rules: { userAgent: '*\r\nDisallow: /' } }, undefined)).toThrow(
      /single line/,
    );
    expect(() => serializeRobots({ rules: {}, sitemap: 'https://e.com/a\nHost: evil' }, undefined)).toThrow(
      /single line/,
    );
    expect(() => serializeRobots('User-agent: *', undefined)).toThrow(/rules/);
    expect(() => serializeRobots({ rules: { crawlDelay: -1 } }, undefined)).toThrow(/crawlDelay/);
  });
});

describe('serializeManifest', () => {
  it('serializes an object and rejects anything else', () => {
    expect(JSON.parse(serializeManifest({ name: 'Acme', start_url: '/' }))).toEqual({
      name: 'Acme',
      start_url: '/',
    });
    expect(() => serializeManifest([1])).toThrow(/object/);
  });
});

describe('revalidate', () => {
  it('defaults to an hour; false caches for a year; 0 or junk disables caching', () => {
    expect(metadataRouteMaxAge(undefined)).toBe(3600);
    expect(metadataRouteMaxAge(false)).toBe(31536000);
    expect(metadataRouteMaxAge(60)).toBe(60);
    expect(metadataRouteMaxAge(0)).toBe(0);
    expect(metadataRouteMaxAge(-5)).toBe(0);
    expect(metadataRouteMaxAge('60')).toBe(0);
  });
});

describe('renderMetadataRoute', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('answers sitemap/robots/manifest with their content types, cacheable by default', async () => {
    vi.stubEnv('GIO_SITE_URL', 'https://example.com');
    const sitemap = await renderMetadataRoute(
      makeRequest('/sitemap.xml'),
      entry('sitemap', { default: async () => [{ url: '/' }] }),
    );
    expect(sitemap).toMatchObject({
      status: 200,
      headers: { 'content-type': 'application/xml; charset=utf-8' },
      cacheable: true,
      cacheMaxAge: 3600,
    });
    expect(sitemap.body).toContain('<loc>https://example.com/</loc>');

    const robots = await renderMetadataRoute(
      makeRequest('/robots.txt', 'HEAD'),
      entry('robots', { default: { rules: { allow: '/' } }, revalidate: 0 }),
    );
    expect(robots).toMatchObject({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'User-Agent: *\nAllow: /\n',
      cacheable: false,
      cacheMaxAge: 0,
    });

    const manifest = await renderMetadataRoute(
      makeRequest('/manifest.webmanifest'),
      entry('manifest', { default: () => ({ name: 'Acme' }), revalidate: false }),
    );
    expect(manifest.headers['content-type']).toBe('application/manifest+json; charset=utf-8');
    expect(manifest.cacheMaxAge).toBe(31536000);
  });

  it('405s other methods and 500s (uncached, with a digest) when the generator throws', async () => {
    const post = await renderMetadataRoute(makeRequest('/robots.txt', 'POST'), entry('robots', {}));
    expect(post).toMatchObject({ status: 405, cacheable: false, headers: { allow: 'GET, HEAD' } });
    const failed = await renderMetadataRoute(
      makeRequest('/sitemap.xml'),
      entry('sitemap', {
        default: () => {
          throw new Error('db down');
        },
      }),
    );
    expect(failed.status).toBe(500);
    expect(failed.cacheable).toBe(false);
    expect(failed.body).toMatch(/^Internal Server Error \(ref [0-9a-f]{12}\)$/);
    expect(failed.body).not.toContain('db down');
  });

  it('renderRoute dispatches the convention paths ahead of pages', async () => {
    const routes = new Map<string, RouteModule>([
      [
        '/*slug',
        {
          filePath: '/app/[...slug]/page.tsx',
          urlPattern: '/*slug',
          dir: '[...slug]',
          load: async () => ({ default: () => null }),
        },
      ],
    ]);
    const result = await renderRoute(makeRequest('/robots.txt'), routes, new Map(), undefined, undefined, undefined, {
      metadataRoutes: { robots: entry('robots', { default: { rules: { disallow: '/' } } }) },
    });
    expect('body' in result && result.body).toBe('User-Agent: *\nDisallow: /\n');
    // Without the module, the catch-all page still gets the URL.
    const page = await renderRoute(makeRequest('/robots.txt'), routes, new Map());
    expect('headers' in page && page.headers['content-type']).toBe('text/html; charset=utf-8');
  });
});

describe('discovery', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('finds app-root sitemap/robots/manifest modules only (ts before js)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gio-metadata-routes-'));
    await writeFile(join(dir, 'sitemap.ts'), 'export default () => [{ url: "https://e.com/" }];\n');
    await writeFile(join(dir, 'sitemap.js'), 'export default [];\n');
    await writeFile(join(dir, 'robots.js'), 'export default { rules: { allow: "/" } };\nexport const revalidate = 60;\n');
    await mkdir(join(dir, 'blog'));
    await writeFile(join(dir, 'blog', 'manifest.ts'), 'export default {};\n');
    const found = await discoverMetadataRoutes(dir);
    expect(Object.keys(found).sort()).toEqual(['robots', 'sitemap']);
    expect(found.sitemap?.filePath).toBe(join(dir, 'sitemap.ts'));
    expect((await found.robots!.load()).revalidate).toBe(60);
    expect(await discoverMetadataRoutes(join(dir, 'missing'))).toEqual({});
  });

  it('rejects a page or route.ts serving the same URL', () => {
    const metadataRoutes = { robots: entry('robots', {}) };
    const page: RouteModule = {
      filePath: '/app/robots.txt/page.tsx',
      urlPattern: '/robots.txt',
      dir: 'robots.txt',
      load: async () => ({ default: () => null }),
    };
    expect(() =>
      assertNoMetadataRouteConflicts('/app', new Map([['/robots.txt', page]]), [], metadataRoutes),
    ).toThrow(/route conflict: .*robots\.ts and .*robots\.txt\/page\.tsx both serve "\/robots\.txt"/);
    const routeFile = {
      filePath: pathToFileURL('/app/robots.txt/route.ts').href,
      urlPattern: '/robots.txt',
      dir: 'robots.txt',
    };
    expect(() => assertNoMetadataRouteConflicts('/app', new Map(), [routeFile], metadataRoutes)).toThrow(
      /route conflict/,
    );
    expect(() => assertNoMetadataRouteConflicts('/app', new Map(), [], metadataRoutes)).not.toThrow();
  });
});
