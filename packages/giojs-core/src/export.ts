/**
 * giojs-core/src/export.ts
 *
 * Static site export. Reuses the live SSR pipeline (discoverRoutes + renderRoute)
 * to pre-render every static route to out/<path>/index.html, runs
 * getServerSideProps at build time, expands dynamic routes via an exported
 * getStaticPaths(), and copies public/ into the output - at the site root and
 * under /public/*, as the server serves it. Server-only routes (route
 * handlers, SSE, WebSockets) and pages that call notFound() are skipped with
 * a warning.
 *
 * Exported pages hydrate like served ones: the client bundles are built in
 * production mode into out/_next/static/chunks/ (the URLs the pages
 * reference) and every page carries the same envelope + bootstrap module the
 * server renders, so GioLink soft navigation works on any static host.
 * GIO_PUBLIC_* values are frozen at export time. A route whose bundle fails
 * (or is rejected for importing server-only code) exports as HTML only, as
 * the server would serve it, and is reported.
 *
 * app/sitemap.*, app/robots.* and app/manifest.* are written as
 * sitemap.xml, robots.txt and manifest.webmanifest; a public/ file of the
 * same name wins, as it does on the server. Without app/ modules, robots.txt
 * (and sitemap.xml when GIO_SITE_URL is set) are generated.
 */
import { mkdir, writeFile, cp, access, lstat, readdir } from 'node:fs/promises';
import { join, dirname, relative, resolve, isAbsolute, sep } from 'node:path';
import {
  discoverRoutes,
  discoverLayouts,
  discoverSpecialPages,
  discoverSegmentFiles,
  discoverMetadataRoutes,
} from './router.ts';
import { generateMetadataRoute, METADATA_ROUTE_PATHS } from './metadata-routes.ts';
import { renderRoute, type RenderExtras } from './ssr.ts';
import { buildClientBundles, clientBuildErrorFor } from './client-build.ts';
import { imageConfigFromEnv, installImageConfig } from './image-config.ts';
import type { IPCRequest, IPCResponse } from './context.ts';

// Tells the SSR pipeline this is a static build: no streaming, no dev
// overlay hand-off, and no image optimizer (<GioImage> renders plain src).
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
  /** Written pages that ship without client JS, and why. */
  unhydrated: { route: string; reason: string }[];
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

/**
 * The request a page is exported for. `locale` is '' - what the Rust server
 * sends for an app without i18n (the export has no locale routing): it
 * reaches useLocale() and <LocaleLink> through the navigation context, so a
 * made-up 'en' would prefix their hrefs with a locale no exported page has.
 */
function makeRequest(path: string, params: Record<string, string>): IPCRequest {
  return {
    id: 'export', method: 'GET', path, params,
    query: {}, headers: {}, body: null, bodyBase64: false,
    deploymentId: 'static', locale: '',
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
  const [routes, layouts, segmentFiles] = await Promise.all([
    discoverRoutes(appDir),
    discoverLayouts(appDir),
    discoverSegmentFiles(appDir),
  ]);
  // Pages render inside their loading.* and error.* boundaries, as served.
  // A failure is reported (with its digest) rather than exported as an
  // error page - one inside a Suspense boundary included, since an exported
  // page never hydrates to recover from it - and notFound() pages are
  // skipped: nothing is written.
  const pageExtras: RenderExtras = {
    segmentFiles: { ...segmentFiles, error: new Map() },
    staticExport: true,
  };

  const written: string[] = [];
  const skipped: { route: string; reason: string }[] = [];
  const unhydrated: { route: string; reason: string }[] = [];
  // Output files this export generated (pages, 404.html, client chunks) -
  // public/ never overwrites them.
  const renderedFiles = new Set<string>();

  // Up front: 404.html, robots.txt and the chunks are written even when no
  // page is.
  await mkdir(outDir, { recursive: true });
  installImageConfig(imageConfigFromEnv(process.env));

  // Never throws: a route whose bundle fails is simply absent and renders
  // without hydration.
  const clientScripts = await buildClientBundles({
    routes,
    layouts,
    projectRoot: dirname(resolve(appDir)),
    dev: false,
    staticExportDir: outDir,
  });
  const chunksDir = join(outDir, '_next', 'static', 'chunks');
  for (const chunk of await readdir(chunksDir).catch(() => [] as string[])) {
    renderedFiles.add(resolve(chunksDir, chunk));
  }

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
      const out = await renderRoute(
        makeRequest(target.path, target.params),
        routes,
        layouts,
        undefined,
        undefined,
        clientScripts,
        pageExtras,
      );

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
        renderedFiles.add(resolve(file));
        written.push(target.path);
        if (!res.body.includes('<script id="__gio_props"')) {
          unhydrated.push({
            route: target.path,
            reason: clientScripts.has(pattern)
              ? 'props are not JSON-serializable'
              : (clientBuildErrorFor(pattern) ?? 'client bundle failed to build'),
          });
        }
      } else if (res.status >= 300 && res.status < 400) {
        skipped.push({ route: target.path, reason: `redirect (${res.status}) - server only` });
      } else if (res.status === 404) {
        skipped.push({ route: target.path, reason: 'notFound() - nothing written' });
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
    { specialPages, segmentFiles },
  );
  if ('body' in notFoundOut && typeof notFoundOut.body === 'string' && notFoundOut.body !== '') {
    // out/ does not exist yet when no page was written.
    await mkdir(outDir, { recursive: true });
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

  // app/sitemap.*, app/robots.*, app/manifest.*: their output, unless
  // public/ ships the same file (copied above) - public/ wins on the
  // server too, which serves it before the worker sees the request.
  const siteUrl = process.env.GIO_SITE_URL?.replace(/\/+$/, '');
  const metadataRoutes = await discoverMetadataRoutes(appDir);
  for (const entry of Object.values(metadataRoutes)) {
    const url = METADATA_ROUTE_PATHS[entry.kind];
    const fileName = url.slice(1);
    if (await isRegularFile(join(publicDir, fileName))) {
      skipped.push({
        route: url,
        reason: `public/${fileName} shadows app/${entry.kind} - the public file is exported, as the server serves it`,
      });
      continue;
    }
    try {
      const { body } = await generateMetadataRoute(entry, siteUrl);
      await writeFile(join(outDir, fileName), body, 'utf8');
    } catch (err) {
      skipped.push({
        route: url,
        reason: `app/${entry.kind} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Otherwise robots.txt + sitemap.xml for discoverability, unless public/
  // ships its own (now at the root). The sitemap needs absolute URLs, so
  // it's emitted only when GIO_SITE_URL is set.
  if (metadataRoutes.robots === undefined && !(await isRegularFile(join(publicDir, 'robots.txt')))) {
    const robots = ['User-agent: *', 'Allow: /'];
    if (siteUrl) robots.push(`Sitemap: ${siteUrl}/sitemap.xml`);
    await writeFile(join(outDir, 'robots.txt'), robots.join('\n') + '\n', 'utf8');
  }

  if (
    siteUrl &&
    metadataRoutes.sitemap === undefined &&
    !(await isRegularFile(join(publicDir, 'sitemap.xml')))
  ) {
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

  return { written, skipped, unhydrated };
}
