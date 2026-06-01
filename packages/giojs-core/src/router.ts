/**
 * giojs-core/src/router.ts
 *
 * Discovers page, layout, and route files under app/, mapping them to URL
 * patterns. Each file may be authored in TypeScript or JavaScript — the
 * extension is resolved by precedence so a directory holding page.tsx and a
 * stray page.js still yields a single deterministic match. Layout discovery
 * mirrors page discovery but keys entries by URL prefix so ssr.ts can apply
 * them outermost-first.
 */
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import type { GioRequest } from './context.ts';
import type { GioEventStream } from './sse.ts';

// JSX-bearing files (page, layout) may be .tsx/.jsx/.js; pure handlers
// (route) may be .ts/.js. Order is precedence when several coexist.
const COMPONENT_EXTS = ['tsx', 'jsx', 'js'] as const;
const HANDLER_EXTS = ['ts', 'js'] as const;

/** Pick `${base}.${ext}` from `names` by extension precedence, or null. */
function pickByExt(
  names: ReadonlySet<string>,
  base: string,
  exts: readonly string[],
): string | null {
  for (const ext of exts) {
    const candidate = `${base}.${ext}`;
    if (names.has(candidate)) return candidate;
  }
  return null;
}

export interface RedirectResult {
  redirect: { destination: string; permanent: boolean };
}

export interface RouteModule {
  filePath: string;
  /** URL pattern e.g. /posts/:id */
  urlPattern: string;
  load: () => Promise<PageModule>;
}

export interface PageModule {
  default: React.ComponentType<any>;
  getServerSideProps?: (ctx: {
    params: Record<string, string>;
    query: Record<string, string>;
    locale?: string;
  }) => Promise<Record<string, unknown> | RedirectResult>;
  revalidate?: number | false;
  dynamic?: 'force-dynamic' | 'force-static' | 'auto';
  /** SSE route handler — return a GioEventStream to switch to streaming mode. */
  GET?: (req: GioRequest) => GioEventStream;
}

export interface RouteFile {
  filePath: string;
  urlPattern: string;
}

export interface LayoutModule {
  // path is the current request path — allows layouts to highlight active nav links
  default: React.ComponentType<{ children: React.ReactNode; path?: string }>;
}

export interface LayoutEntry {
  filePath: string;
  /** URL prefix this layout covers, e.g. "/" or "/docs" */
  urlPrefix: string;
  load: () => Promise<LayoutModule>;
}

/** Walk app/ recursively and collect page files, mapping them to URL patterns. */
export async function discoverRoutes(appDir: string): Promise<Map<string, RouteModule>> {
  const routes = new Map<string, RouteModule>();
  await walkPages(appDir, appDir, routes);
  return routes;
}

/** Walk app/ recursively and collect layout files, keyed by URL prefix. */
export async function discoverLayouts(appDir: string): Promise<Map<string, LayoutEntry>> {
  const layouts = new Map<string, LayoutEntry>();
  await walkLayouts(appDir, appDir, layouts);
  return layouts;
}

async function walkPages(
  root: string,
  dir: string,
  routes: Map<string, RouteModule>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // app/ may not exist yet
  }

  const fileNames = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await walkPages(root, join(dir, entry.name), routes);
    } else if (entry.isFile()) {
      fileNames.add(entry.name);
    }
  }

  const pageFile = pickByExt(fileNames, 'page', COMPONENT_EXTS);
  if (pageFile) {
    const rel = relative(root, dir); // e.g. "posts/[id]"
    const pattern = filePathToUrlPattern(rel);
    const fileUrl = pathToFileURL(join(dir, pageFile)).href;
    routes.set(pattern, {
      filePath: join(dir, pageFile),
      urlPattern: pattern,
      load: () => tsImport(fileUrl, import.meta.url) as Promise<PageModule>,
    });
  }
}

async function walkLayouts(
  root: string,
  dir: string,
  layouts: Map<string, LayoutEntry>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const fileNames = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await walkLayouts(root, join(dir, entry.name), layouts);
    } else if (entry.isFile()) {
      fileNames.add(entry.name);
    }
  }

  const layoutFile = pickByExt(fileNames, 'layout', COMPONENT_EXTS);
  if (layoutFile) {
    const rel = relative(root, dir);
    const urlPrefix = filePathToUrlPattern(rel);
    const fileUrl = pathToFileURL(join(dir, layoutFile)).href;
    layouts.set(urlPrefix, {
      filePath: join(dir, layoutFile),
      urlPrefix,
      load: () => tsImport(fileUrl, import.meta.url) as Promise<LayoutModule>,
    });
  }
}

/** Walk app/ recursively and collect route files, mapping them to URL patterns. */
export async function discoverRouteFiles(appDir: string): Promise<RouteFile[]> {
  const result: RouteFile[] = [];
  await walkRouteFiles(appDir, appDir, result);
  return result;
}

async function walkRouteFiles(
  root: string,
  dir: string,
  result: RouteFile[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const fileNames = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await walkRouteFiles(root, join(dir, entry.name), result);
    } else if (entry.isFile()) {
      fileNames.add(entry.name);
    }
  }

  const routeFile = pickByExt(fileNames, 'route', HANDLER_EXTS);
  if (routeFile) {
    const rel = relative(root, dir);
    const urlPattern = filePathToUrlPattern(rel);
    const fileUrl = pathToFileURL(join(dir, routeFile)).href;
    result.push({ filePath: fileUrl, urlPattern });
  }
}

/** Convert a filesystem segment like "posts/[id]" to "/posts/:id". */
function filePathToUrlPattern(rel: string): string {
  if (!rel || rel === '.') return '/';
  const parts = rel.split(sep).map(segment => {
    // [id] → :id
    const dynamic = segment.match(/^\[(.+?)\]$/);
    if (dynamic) return `:${dynamic[1]}`;
    // [[...slug]] → *slug (optional catch-all)
    const optCatchAll = segment.match(/^\[\[\.\.\.(.+?)\]\]$/);
    if (optCatchAll) return `*${optCatchAll[1]}`;
    // [...slug] → *slug (catch-all)
    const catchAll = segment.match(/^\[\.\.\.(.+?)\]$/);
    if (catchAll) return `*${catchAll[1]}`;
    return segment;
  });
  return '/' + parts.join('/');
}
