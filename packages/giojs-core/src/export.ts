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
import { join, dirname, relative, resolve, isAbsolute, sep } from 'node:path';
import { discoverRoutes, discoverLayouts, discoverSpecialPages } from './router.ts';
import { renderRoute } from './ssr.ts';
import type { IPCRequest, IPCResponse } from './context.ts';

// Tells the SSR pipeline this is a static build - no client bundle to hydrate,
// so no /_next bootstrap script is injected.
process.env.GIO_EXPORT = '1';

/**
 * Catch-all params take the runtime shape ("a/b") or, for Next.js parity,
 * an array of segments (["a", "b"]). An optional catch-all may be omitted,
 * '' or [] to export the bare parent path.
 */
interface StaticPath { params: Record<string, string | string[] | undefined>; }
interface ExportResult {
  written: string[];
  skipped: { route: string; reason: string }[];
}

function isDynamic(pattern: string): boolean {
  return pattern.split('/').some(s => s.startsWith(':') || s.startsWith('*'));
}

/**
 * Fill a route pattern's :param / *rest / *rest? segments from a
 * getStaticPaths params object. Returns the URL path plus the string params
 * the render sees, or an error naming what is wrong with the entry.
 */
export function patternToPath(
  pattern: string,
  params: StaticPath['params'],
): { path: string; params: Record<string, string> } | { error: string } {
  const parts: string[] = [];
  const resolved: Record<string, string> = {};
  for (const seg of pattern.split('/').filter(Boolean)) {
    if (!seg.startsWith(':') && !seg.startsWith('*')) {
      parts.push(seg);
      continue;
    }
    const optional = seg.startsWith('*') && seg.endsWith('?');
    const name = optional ? seg.slice(1, -1) : seg.slice(1);
    const raw = params[name];
    const value = Array.isArray(raw) ? raw.join('/') : (raw ?? '');
    const valueSegments = value === '' ? [] : value.split('/');
    if (valueSegments.length === 0 && !optional) {
      return { error: `getStaticPaths entry is missing param "${name}"` };
    }
    if (seg.startsWith(':') && valueSegments.length > 1) {
      return { error: `param "${name}" is a single segment but "${value}" contains '/'` };
    }
    // Each value segment becomes a directory under out/: empty, '.' and '..'
    // segments would write outside the route (or outside out/ entirely), and
    // so would a backslash, which Windows path.join treats as a separator
    // ("a\..\..\x").
    if (valueSegments.some(s => s === '' || s === '.' || s === '..' || s.includes('\\'))) {
      return { error: `param "${name}" has an empty, relative or backslashed segment: "${value}"` };
    }
    resolved[name] = value;
    parts.push(...valueSegments);
  }
  return { path: '/' + parts.join('/'), params: resolved };
}

/**
 * Map a URL path to its output file: "/" → out/index.html, "/a/b" →
 * out/a/b/index.html. Returns null when the resolved file would land outside
 * out/ - a last line of defense behind patternToPath's segment checks.
 */
function pathToFile(outDir: string, urlPath: string): string | null {
  const clean = urlPath.replace(/^\/+|\/+$/g, '');
  const file = clean === '' ? join(outDir, 'index.html') : join(outDir, clean, 'index.html');
  const rel = relative(resolve(outDir), resolve(file));
  return rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : file;
}

function makeRequest(path: string, params: Record<string, string>): IPCRequest {
  return {
    id: 'export', method: 'GET', path, params,
    query: {}, headers: {}, body: null, bodyBase64: false,
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
      targets = [];
      for (const staticPath of result.paths) {
        const target = patternToPath(pattern, staticPath.params);
        if ('error' in target) {
          skipped.push({ route: pattern, reason: target.error });
        } else {
          targets.push(target);
        }
      }
    }

    for (const target of targets) {
      const out = await renderRoute(makeRequest(target.path, target.params), routes, layouts);

      if ('type' in out && out.type === 'sse') {
        skipped.push({ route: target.path, reason: 'streaming/SSE route - server only' });
        continue;
      }
      if ('error' in out && out.error) {
        // Outside dev the message is generic; the digest points at the
        // 'ssr render failed' log line (stderr) with the real message + stack.
        const ref = out.digest !== undefined ? ` (ref ${out.digest}, details in the error log)` : '';
        skipped.push({ route: target.path, reason: `render error: ${out.message}${ref}` });
        continue;
      }

      const res = out as IPCResponse;
      if (res.status === 200 && typeof res.body === 'string') {
        const file = pathToFile(outDir, target.path);
        if (file === null) {
          skipped.push({ route: target.path, reason: 'output path escapes the export directory' });
          continue;
        }
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, res.body, 'utf8');
        written.push(target.path);
      } else if (res.status >= 300 && res.status < 400) {
        skipped.push({ route: target.path, reason: `redirect (${res.status}) - server only` });
      } else {
        skipped.push({ route: target.path, reason: `status ${res.status}` });
      }
    }
  }

  // 404.html: static hosts (Cloudflare Pages, GitHub Pages, Netlify) serve it
  // with a real 404 status for unmatched paths. Without it, Cloudflare Pages
  // falls back to index.html - every unknown URL would 200 with the home page.
  // Renders app/not-found.* through the layout pipeline, or the built-in 404.
  // No routes are passed: a root catch-all (/*slug, /*slug?) would otherwise
  // claim the probe path and 404.html would be that page.
  const specialPages = await discoverSpecialPages(appDir);
  const notFoundOut = await renderRoute(
    makeRequest('/__gio_not_found__', {}),
    new Map(),
    layouts,
    undefined,
    undefined,
    undefined,
    { specialPages },
  );
  if ('body' in notFoundOut && typeof notFoundOut.body === 'string' && notFoundOut.body !== '') {
    await writeFile(join(outDir, '404.html'), notFoundOut.body, 'utf8');
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
