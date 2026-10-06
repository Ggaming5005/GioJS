/**
 * giojs-core/src/router.ts
 *
 * Discovers page, layout, and route files under app/, mapping them to URL
 * patterns. Each file may be authored in TypeScript or JavaScript - the
 * extension is resolved by precedence so a directory holding page.tsx and a
 * stray page.js still yields a single deterministic match.
 *
 * Folder conventions (Next.js App Router semantics): `[id]` captures one
 * segment (`:id`), `[...slug]` one or more (`*slug`), `[[...slug]]` zero or
 * more (`*slug?`); `(group)` folders organize files without adding a URL
 * segment; `_private` folders are never routable. Layouts are keyed by their
 * app-relative directory and apply by filesystem ancestry, so a layout under
 * `[id]` or `(group)` wraps exactly the pages beneath it.
 */
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTsModule } from './load-ts.ts';
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

/**
 * Response headers a getServerSideProps result may carry. An array sends one
 * Set-Cookie header per entry for `set-cookie`; any other header's array is
 * joined with ", " (RFC 9110 list syntax).
 */
export type GsspResponseHeaders = Record<string, string | string[]>;

export interface RedirectResult {
  redirect: { destination: string; permanent: boolean };
  /** Sent with the redirect - e.g. set-cookie on a login or logout hop. */
  headers?: GsspResponseHeaders;
}

/** `{ props, headers }` form of a getServerSideProps result. */
export interface PropsResult {
  props: Record<string, unknown>;
  headers?: GsspResponseHeaders;
}

export interface RouteModule {
  filePath: string;
  /** URL pattern e.g. /posts/:id */
  urlPattern: string;
  /**
   * app/-relative directory holding the page, '/'-separated and including
   * group folders ('' for app/ itself, e.g. "(shop)/posts/[id]"). Layouts
   * are associated through it, never through the URL.
   */
  dir: string;
  load: () => Promise<PageModule>;
}

/** Context handed to getServerSideProps. */
export interface GsspContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  /** Lowercased request headers. */
  headers: Record<string, string>;
  /** Cookie header parsed into name → value. */
  cookies: Record<string, string>;
  locale?: string;
  /**
   * The client's IP (proxy-aware, see `[server] trusted_proxies`). Reading
   * it makes the render personal, like reading cookies: a `revalidate`
   * page that reads it is not cached for everyone.
   */
  readonly ip?: string | undefined;
  /**
   * 'https' or 'http', as the client used it (proxy-aware). Reading it makes
   * the render personal: it varies with how each request arrived.
   */
  readonly scheme?: string | undefined;
  /**
   * The host the client addressed (proxy-aware, may include a port). It is
   * whatever the client sent unless your proxy pins it, so reading it makes
   * the render personal - a cached page printing it could be poisoned for
   * everyone. For absolute URLs on cached pages, use a configured origin.
   */
  readonly host?: string | undefined;
  /** This request's id (X-Request-Id). Reading it does not make a render personal. */
  requestId?: string;
}

export interface PageModule {
  default: React.ComponentType<Record<string, unknown>>;
  getServerSideProps?: (
    ctx: GsspContext,
  ) => Promise<PropsResult | RedirectResult | Record<string, unknown>>;
  revalidate?: number | false;
  /**
   * PPR opt-in: 'cache' streams the render, caches the pre-Suspense shell,
   * and re-renders only the holes per request. Requires `revalidate`.
   */
  shell?: 'cache';
  dynamic?: 'force-dynamic' | 'force-static' | 'auto';
  /** SSE route handler - return a GioEventStream to switch to streaming mode. */
  GET?: (req: GioRequest) => GioEventStream;
}

export interface RouteFile {
  /** file:// URL of the route.ts module. */
  filePath: string;
  urlPattern: string;
  /** app/-relative directory holding the file (see RouteModule.dir). */
  dir: string;
}

// ── route.ts method handlers ──────────────────────────────────────────────────

/**
 * A route.ts method handler returns one of:
 *  - a web-standard `Response` (status/headers/body used as-is),
 *  - a `GioEventStream` (GET only - switches the connection to SSE),
 *  - any JSON-serializable value (sent as `application/json`, status 200).
 * Handler responses are never cached or coalesced.
 */
export type RouteHandlerFn = (req: GioRequest) => unknown;

export const HANDLER_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export interface HandlerEntry {
  filePath: string;
  urlPattern: string;
  methods: Map<string, RouteHandlerFn>;
}

/** Root-level special pages: app/not-found.* and app/error.* */
export interface SpecialPages {
  notFound?: () => Promise<PageModule>;
  error?: () => Promise<PageModule>;
}

/** Discover app/not-found.* and app/error.* (component extensions only). */
export async function discoverSpecialPages(appDir: string): Promise<SpecialPages> {
  let entries;
  try {
    entries = await readdir(appDir, { withFileTypes: true });
  } catch {
    return {};
  }
  const fileNames = new Set(entries.filter(e => e.isFile()).map(e => e.name));
  const special: SpecialPages = {};
  const notFoundFile = pickByExt(fileNames, 'not-found', COMPONENT_EXTS);
  if (notFoundFile !== null) {
    const fileUrl = pathToFileURL(join(appDir, notFoundFile)).href;
    special.notFound = () => loadTsModule<PageModule>(fileUrl);
  }
  const errorFile = pickByExt(fileNames, 'error', COMPONENT_EXTS);
  if (errorFile !== null) {
    const fileUrl = pathToFileURL(join(appDir, errorFile)).href;
    special.error = () => loadTsModule<PageModule>(fileUrl);
  }
  return special;
}

export interface LayoutModule {
  // path is the current request path - allows layouts to highlight active nav links
  default: React.ComponentType<{ children: React.ReactNode; path?: string }>;
}

export interface LayoutEntry {
  filePath: string;
  /**
   * app/-relative directory holding this layout, '/'-separated: '' for the
   * root app/layout.*, otherwise e.g. "docs", "(shop)" or "posts/[id]". It
   * wraps every page whose directory is this one or nested below it.
   */
  dir: string;
  load: () => Promise<LayoutModule>;
}

/** Walk app/ recursively and collect page files, mapping them to URL patterns. */
export async function discoverRoutes(appDir: string): Promise<Map<string, RouteModule>> {
  const routes = new Map<string, RouteModule>();
  const byShape = new Map<string, RouteModule>();
  await walkAppDir(appDir, ({ abs, segments, fileNames }) => {
    const pageFile = pickByExt(fileNames, 'page', COMPONENT_EXTS);
    if (pageFile === null) return;
    const filePath = join(abs, pageFile);
    const pattern = segmentsToUrlPattern(segments, displayPath(appDir, filePath));
    const fileUrl = pathToFileURL(filePath).href;
    const route: RouteModule = {
      filePath,
      urlPattern: pattern,
      dir: segments.join('/'),
      load: () => loadTsModule<PageModule>(fileUrl),
    };
    const shape = patternShape(pattern);
    const existing = byShape.get(shape);
    if (existing !== undefined) {
      throw routeConflict(appDir, existing.filePath, existing.urlPattern, filePath, pattern);
    }
    byShape.set(shape, route);
    routes.set(pattern, route);
  });
  return routes;
}

/** Walk app/ recursively and collect layout files, keyed by app-relative directory. */
export async function discoverLayouts(appDir: string): Promise<Map<string, LayoutEntry>> {
  const layouts = new Map<string, LayoutEntry>();
  await walkAppDir(appDir, ({ abs, segments, fileNames }) => {
    const layoutFile = pickByExt(fileNames, 'layout', COMPONENT_EXTS);
    if (layoutFile === null) return;
    const filePath = join(abs, layoutFile);
    const fileUrl = pathToFileURL(filePath).href;
    const dir = segments.join('/');
    layouts.set(dir, {
      filePath,
      dir,
      load: () => loadTsModule<LayoutModule>(fileUrl),
    });
  });
  return layouts;
}

/** Walk app/ recursively and collect route files, mapping them to URL patterns. */
export async function discoverRouteFiles(appDir: string): Promise<RouteFile[]> {
  const result: RouteFile[] = [];
  const byShape = new Map<string, RouteFile>();
  await walkAppDir(appDir, ({ abs, segments, fileNames }) => {
    const routeFile = pickByExt(fileNames, 'route', HANDLER_EXTS);
    if (routeFile === null) return;
    const filePath = join(abs, routeFile);
    const urlPattern = segmentsToUrlPattern(segments, displayPath(appDir, filePath));
    const entry: RouteFile = {
      filePath: pathToFileURL(filePath).href,
      urlPattern,
      dir: segments.join('/'),
    };
    const shape = patternShape(urlPattern);
    const existing = byShape.get(shape);
    if (existing !== undefined) {
      throw routeConflict(
        appDir,
        fileURLToPath(existing.filePath),
        existing.urlPattern,
        filePath,
        urlPattern,
      );
    }
    byShape.set(shape, entry);
    result.push(entry);
  });
  return result;
}

/**
 * Reject a page and a route.ts that answer the same URLs from different
 * folders (e.g. `(a)/about/page.tsx` + `(b)/about/route.ts`). A route.ts next
 * to its page.tsx is the supported pairing - a method it does not export
 * falls through to the page - but across folders nothing says which file
 * owns the URL, so boot fails instead of guessing.
 */
export function assertNoRouteConflicts(
  appDir: string,
  routes: Map<string, RouteModule>,
  routeFiles: readonly RouteFile[],
): void {
  const pagesByShape = new Map<string, RouteModule>();
  for (const route of routes.values()) {
    pagesByShape.set(patternShape(route.urlPattern), route);
  }
  for (const routeFile of routeFiles) {
    const page = pagesByShape.get(patternShape(routeFile.urlPattern));
    if (page !== undefined && page.dir !== routeFile.dir) {
      throw routeConflict(
        appDir,
        page.filePath,
        page.urlPattern,
        fileURLToPath(routeFile.filePath),
        routeFile.urlPattern,
      );
    }
  }
}

/**
 * The layouts wrapping a page in `dir`: the layout.* of app/ and of every
 * directory from there down to `dir` itself (group folders included),
 * outermost first. Filesystem ancestry rather than URL prefixes is what
 * lets layouts under `[id]` or `(group)` folders apply exactly where they live.
 */
export function layoutsForDir(dir: string, layouts: Map<string, LayoutEntry>): LayoutEntry[] {
  const chain: LayoutEntry[] = [];
  const rootLayout = layouts.get('');
  if (rootLayout !== undefined) chain.push(rootLayout);
  if (dir === '') return chain;
  const segments = dir.split('/');
  for (let depth = 1; depth <= segments.length; depth++) {
    const layout = layouts.get(segments.slice(0, depth).join('/'));
    if (layout !== undefined) chain.push(layout);
  }
  return chain;
}

/** One directory under app/: where it is and which files it holds. */
interface AppDirectory {
  abs: string;
  /** app/-relative path segments, group folders included. */
  segments: string[];
  fileNames: Set<string>;
}

/**
 * Private `_folders` hold colocated components and helpers, never routes.
 * The rule also guarantees no app route can live under the reserved `/_gio`
 * prefix the Rust server owns.
 */
function isPrivateFolder(name: string): boolean {
  return name.startsWith('_');
}

/** `(group)` folders organize files without contributing a URL segment. */
function isGroupFolder(name: string): boolean {
  return /^\([^()]+\)$/.test(name);
}

/**
 * Visit every routable directory under app/, parents before children.
 * Entries are sorted because readdir order is filesystem-dependent and
 * discovery (down to which file a conflict error names first) must not be.
 */
async function walkAppDir(
  root: string,
  visit: (directory: AppDirectory) => void,
  abs: string = root,
  segments: string[] = [],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return; // app/ may not exist yet
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const fileNames = new Set<string>();
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!isPrivateFolder(entry.name)) subdirs.push(entry.name);
    } else if (entry.isFile()) {
      fileNames.add(entry.name);
    }
  }
  visit({ abs, segments, fileNames });
  for (const name of subdirs) {
    await walkAppDir(root, visit, join(abs, name), [...segments, name]);
  }
}

// Optional catch-all is tested before catch-all before plain dynamic. Names
// may not start with '.' or contain brackets, so "[...slug]" can never be
// read as a one-segment param named "...slug". Nor may they contain the
// pattern syntax characters '?', ':' or '*': "[...slug?]" would otherwise
// become "*slug?" and silently turn into an optional catch-all.
const OPTIONAL_CATCH_ALL_RE = /^\[\[\.\.\.([^[\]./?:*][^[\]/?:*]*)\]\]$/;
const CATCH_ALL_RE = /^\[\.\.\.([^[\]./?:*][^[\]/?:*]*)\]$/;
const DYNAMIC_RE = /^\[([^[\]./?:*][^[\]/?:*]*)\]$/;

/**
 * Convert app/-relative folder segments to a URL pattern:
 * `posts/[id]` → `/posts/:id`, `docs/[...slug]` → `/docs/*slug`,
 * `shop/[[...p]]` → `/shop/*p?`, `(marketing)/about` → `/about`.
 * Throws (naming `source`) on malformed brackets, a repeated param name, or
 * a catch-all that is not the last URL segment.
 */
function segmentsToUrlPattern(segments: readonly string[], source: string): string {
  const parts: string[] = [];
  const paramNames = new Set<string>();
  for (const name of segments) {
    if (isGroupFolder(name)) continue;
    const previous = parts[parts.length - 1];
    if (previous !== undefined && previous.startsWith('*')) {
      throw new Error(
        `${source}: catch-all segment "${previous}" must be the last segment of its route`,
      );
    }
    let part = name;
    let param: string | undefined;
    const optionalCatchAll = OPTIONAL_CATCH_ALL_RE.exec(name);
    const catchAll = CATCH_ALL_RE.exec(name);
    const dynamic = DYNAMIC_RE.exec(name);
    if (optionalCatchAll !== null) {
      param = optionalCatchAll[1];
      part = `*${param}?`;
    } else if (catchAll !== null) {
      param = catchAll[1];
      part = `*${param}`;
    } else if (dynamic !== null) {
      param = dynamic[1];
      part = `:${param}`;
    } else if (name.startsWith('[') || name.endsWith(']')) {
      throw new Error(
        `${source}: unsupported dynamic segment "${name}" - use [name], [...name] or [[...name]]`,
      );
    } else if (name.startsWith(':') || name.startsWith('*')) {
      // A literal ':x' or '*x' segment would read back as a param pattern.
      throw new Error(`${source}: folder "${name}" may not start with ':' or '*'`);
    }
    if (param !== undefined) {
      if (paramNames.has(param)) {
        throw new Error(`${source}: param "${param}" appears more than once in the route`);
      }
      paramNames.add(param);
    }
    parts.push(part);
  }
  return '/' + parts.join('/');
}

/**
 * A pattern with its param names erased. Two patterns with the same shape
 * match exactly the same URLs (`/posts/:id` vs `/posts/:slug`), so precedence
 * cannot order them - that is a conflict, not a tie to break. Catch-all
 * optionality is erased too: beside `/docs/*a`, which outranks it on every
 * deeper URL, `/docs/*b?` could only ever serve "/docs" itself.
 */
function patternShape(pattern: string): string {
  return pattern
    .split('/')
    .map(segment => {
      if (segment.startsWith(':')) return ':';
      if (segment.startsWith('*')) return '*';
      return segment;
    })
    .join('/');
}

/** Whether the last segment is an optional catch-all (`*slug?`). */
function endsInOptionalCatchAll(pattern: string): boolean {
  const last = pattern.slice(pattern.lastIndexOf('/') + 1);
  return last.startsWith('*') && last.endsWith('?');
}

/** Project-relative, '/'-separated path for messages ("app/(a)/about/page.tsx"). */
function displayPath(appDir: string, filePath: string): string {
  return relative(dirname(appDir), filePath).split(sep).join('/');
}

function routeConflict(
  appDir: string,
  firstFile: string,
  firstPattern: string,
  secondFile: string,
  secondPattern: string,
): Error {
  const files = `${displayPath(appDir, firstFile)} and ${displayPath(appDir, secondFile)}`;
  if (endsInOptionalCatchAll(firstPattern) !== endsInOptionalCatchAll(secondPattern)) {
    const [required, optional] = endsInOptionalCatchAll(secondPattern)
      ? [firstPattern, secondPattern]
      : [secondPattern, firstPattern];
    const parent = optional.slice(0, optional.lastIndexOf('/')) || '/';
    return new Error(
      `route conflict: ${files} overlap - "${required}" outranks "${optional}" on every URL ` +
        `below "${parent}", leaving the optional catch-all only "${parent}" itself; keep one ` +
        `catch-all (a page can serve "${parent}" beside a required one)`,
    );
  }
  const resolved =
    firstPattern === secondPattern
      ? `"${firstPattern}"`
      : `"${firstPattern}" and "${secondPattern}" (the same URLs under different param names)`;
  return new Error(
    `route conflict: ${files} both resolve to ${resolved} - every URL must be served by exactly one file`,
  );
}
