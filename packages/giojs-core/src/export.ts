/**
 * giojs-core/src/export.ts
 *
 * Static site export. Reuses the live SSR pipeline (discoverRoutes + renderRoute)
 * to pre-render every static route to out/<path>/index.html, runs
 * getServerSideProps at build time, expands dynamic routes via an exported
 * getStaticPaths(), and copies public/ into the output. Server-only routes
 * (route handlers, SSE, WebSockets) are skipped with a warning.
 */
import { mkdir, writeFile, cp, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { discoverRoutes, discoverLayouts } from './router.ts';
import { renderRoute } from './ssr.ts';
import type { IPCRequest, IPCResponse } from './context.ts';

// Tells the SSR pipeline this is a static build — no client bundle to hydrate,
// so no /_next bootstrap script is injected.
process.env.GIO_EXPORT = '1';

interface StaticPath { params: Record<string, string>; }
interface ExportResult {
  written: string[];
  skipped: { route: string; reason: string }[];
}

function isDynamic(pattern: string): boolean {
  return pattern.split('/').some(s => s.startsWith(':') || s.startsWith('*'));
}

/** Fill a route pattern's :param / *rest segments from a params object. */
function patternToPath(pattern: string, params: Record<string, string>): string {
  const parts = pattern.split('/').filter(Boolean).map(seg => {
    if (seg.startsWith(':')) return params[seg.slice(1)] ?? '';
    if (seg.startsWith('*')) return params[seg.slice(1)] ?? '';
    return seg;
  });
  return '/' + parts.join('/');
}

/** Map a URL path to its output file: "/" → out/index.html, "/a/b" → out/a/b/index.html. */
function pathToFile(outDir: string, urlPath: string): string {
  const clean = urlPath.replace(/^\/+|\/+$/g, '');
  return clean === '' ? join(outDir, 'index.html') : join(outDir, clean, 'index.html');
}

function makeRequest(path: string, params: Record<string, string>): IPCRequest {
  return {
    id: 'export', method: 'GET', path, params,
    query: {}, headers: {}, body: null,
    deploymentId: 'static', locale: 'en',
  };
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export async function exportSite(appDir: string, outDir: string): Promise<ExportResult> {
  const [routes, layouts] = await Promise.all([
    discoverRoutes(appDir),
    discoverLayouts(appDir),
  ]);

  const written: string[] = [];
  const skipped: { route: string; reason: string }[] = [];

  for (const [pattern, mod] of routes) {
    let targets: { path: string; params: Record<string, string> }[];

    if (!isDynamic(pattern)) {
      targets = [{ path: pattern, params: {} }];
    } else {
      const page = await mod.load() as { getStaticPaths?: () => Promise<{ paths: StaticPath[] }> | { paths: StaticPath[] } };
      if (typeof page.getStaticPaths !== 'function') {
        skipped.push({ route: pattern, reason: 'dynamic route without getStaticPaths()' });
        continue;
      }
      const result = await page.getStaticPaths();
      targets = result.paths.map(p => ({ path: patternToPath(pattern, p.params), params: p.params }));
    }

    for (const target of targets) {
      const out = await renderRoute(makeRequest(target.path, target.params), routes, layouts);

      if ('type' in out && out.type === 'sse') {
        skipped.push({ route: target.path, reason: 'streaming/SSE route — server only' });
        continue;
      }
      if ('error' in out && out.error) {
        skipped.push({ route: target.path, reason: `render error: ${out.message}` });
        continue;
      }

      const res = out as IPCResponse;
      if (res.status === 200 && typeof res.body === 'string') {
        const file = pathToFile(outDir, target.path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, res.body, 'utf8');
        written.push(target.path);
      } else if (res.status >= 300 && res.status < 400) {
        skipped.push({ route: target.path, reason: `redirect (${res.status}) — server only` });
      } else {
        skipped.push({ route: target.path, reason: `status ${res.status}` });
      }
    }
  }

  // Copy public/ (sibling of app/) into the output, served at /public/*.
  const publicDir = join(appDir, '..', 'public');
  if (await exists(publicDir)) {
    await cp(publicDir, join(outDir, 'public'), { recursive: true });
  }

  // robots.txt + sitemap.xml for discoverability. The sitemap needs absolute
  // URLs, so it's emitted only when GIO_SITE_URL is set.
  const siteUrl = process.env.GIO_SITE_URL?.replace(/\/+$/, '');
  const robots = ['User-agent: *', 'Allow: /'];
  if (siteUrl) robots.push(`Sitemap: ${siteUrl}/sitemap.xml`);
  await writeFile(join(outDir, 'robots.txt'), robots.join('\n') + '\n', 'utf8');

  if (siteUrl) {
    const urls = written
      .slice()
      .sort()
      .map(p => `  <url><loc>${siteUrl}${p === '/' ? '/' : p}</loc></url>`)
      .join('\n');
    const sitemap =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls + '\n</urlset>\n';
    await writeFile(join(outDir, 'sitemap.xml'), sitemap, 'utf8');
  }

  return { written, skipped };
}
