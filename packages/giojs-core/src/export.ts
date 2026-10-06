/**
 * giojs-core/src/export.ts
 *
 * Static site export. Reuses the live SSR pipeline (discoverRoutes + renderRoute)
 * to pre-render every static route to out/<path>/index.html, runs
 * getServerSideProps at build time, expands dynamic routes via an exported
 * getStaticPaths(), and copies public/ into the output - at the site root and
 * under /public/*, as the server serves it. Server-only routes (route
 * handlers, SSE, WebSockets) are skipped with a warning.
 */
import { mkdir, writeFile, cp, access, lstat } from 'node:fs/promises';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { discoverRoutes, discoverLayouts, discoverSpecialPages } from './router.ts';
import { renderRoute } from './ssr.ts';
import type { IPCRequest, IPCResponse } from './context.ts';

// Tells the SSR pipeline this is a static build - no client bundle to hydrate,
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
    query: {}, headers: {}, body: null, bodyBase64: false,
    deploymentId: 'static', locale: 'en',
  };
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function isRegularFile(p: string): Promise<boolean> {
  try { return (await lstat(p)).isFile(); } catch { return false; }
}

/**
 * Whether a public/ entry (path relative to public/) is also served at the
 * site root - the server's rule (crates/giojs-server/src/public_files.rs):
 * no dotfiles except the top-level .well-known/, and no top-level _gio/ (the
 * server's internal namespace). Symlinks are never root-served either.
 */
export function isRootServable(relPath: string): boolean {
  return relPath
    .split(/[\\/]/)
    .filter(Boolean)
    .every((name, index) =>
      name.startsWith('.') ? index === 0 && name === '.well-known' : !(index === 0 && name === '_gio'),
    );
}

export async function exportSite(appDir: string, outDir: string): Promise<ExportResult> {
  const [routes, layouts] = await Promise.all([
    discoverRoutes(appDir),
    discoverLayouts(appDir),
  ]);

  const written: string[] = [];
  const skipped: { route: string; reason: string }[] = [];
  // Output files this export rendered (pages, 404.html) - public/ never
  // overwrites them.
  const renderedFiles = new Set<string>();

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
        skipped.push({ route: target.path, reason: 'streaming/SSE route - server only' });
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
        renderedFiles.add(resolve(file));
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
  const specialPages = await discoverSpecialPages(appDir);
  const notFoundOut = await renderRoute(
    makeRequest('/__gio_not_found__', {}),
    routes,
    layouts,
    undefined,
    undefined,
    undefined,
    { specialPages },
  );
  if ('body' in notFoundOut && typeof notFoundOut.body === 'string' && notFoundOut.body !== '') {
    await writeFile(join(outDir, '404.html'), notFoundOut.body, 'utf8');
    renderedFiles.add(resolve(outDir, '404.html'));
  }

  // Copy public/ (sibling of app/) into the output twice, as the server
  // serves it: under /public/* and at the site root, so /favicon.ico,
  // /robots.txt, and /.well-known/... work on static hosts too.
  const publicDir = join(appDir, '..', 'public');
  if (await exists(publicDir)) {
    await cp(publicDir, join(outDir, 'public'), { recursive: true });
    const outRoot = resolve(outDir);
    const renderedDirs = new Set<string>();
    for (const file of renderedFiles) {
      for (let dir = dirname(file); dir !== outRoot && dir.startsWith(outRoot); dir = dirname(dir)) {
        renderedDirs.add(dir);
      }
    }
    await cp(publicDir, outDir, {
      recursive: true,
      filter: async (src, dest) => {
        const rel = relative(publicDir, src);
        if (rel === '') return true;
        if (!isRootServable(rel)) return false;
        const stat = await lstat(src);
        if (stat.isSymbolicLink()) return false;
        const target = resolve(dest);
        if (!stat.isFile() || !(renderedFiles.has(target) || renderedDirs.has(target))) return true;
        // A file can't share an output path with a rendered page
        // (public/index.html vs app/page.tsx, public/about vs
        // app/about/page.tsx): the page keeps it, and the file stays
        // reachable under /public/.
        const url = '/' + rel.split(sep).join('/');
        skipped.push({ route: url, reason: `public/ file with the output path of a rendered page - kept the page; the file is still at /public${url}` });
        return false;
      },
    });
  }

  // robots.txt + sitemap.xml for discoverability, unless public/ ships its
  // own (now at the root). The sitemap needs absolute URLs, so it's emitted
  // only when GIO_SITE_URL is set.
  const siteUrl = process.env.GIO_SITE_URL?.replace(/\/+$/, '');
  if (!(await isRegularFile(join(publicDir, 'robots.txt')))) {
    const robots = ['User-agent: *', 'Allow: /'];
    if (siteUrl) robots.push(`Sitemap: ${siteUrl}/sitemap.xml`);
    await writeFile(join(outDir, 'robots.txt'), robots.join('\n') + '\n', 'utf8');
  }

  if (siteUrl && !(await isRegularFile(join(publicDir, 'sitemap.xml')))) {
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
