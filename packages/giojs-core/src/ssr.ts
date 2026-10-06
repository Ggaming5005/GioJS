/**
 * giojs-core/src/ssr.ts
 *
 * Renders matched routes to HTML. Applies layout.tsx wrappers outermost-first,
 * detects getServerSideProps redirect returns, and maps revalidate semantics to
 * the cache fields Rust reads (revalidate=false → one-year TTL, not 0).
 * Also handles GET() exports that return GioEventStream (SSE routes).
 *
 * Failures pick the nearest per-folder file: notFound() (or a
 * `{ notFound: true }` result) answers 404 with the nearest not-found.*, a
 * throw answers 500 with the nearest error.* - each inside the layouts of
 * its own folder. The same error.* and loading.* files are client error and
 * Suspense boundaries in the hydrated tree (segment-tree.ts).
 *
 * PPR (`export const shell = 'cache'` + `revalidate`): the render streams with
 * a shell_end frame at the pre-Suspense boundary so Rust can cache the shell;
 * skipShell requests re-render the whole page (gSSP reruns with the
 * requester's cookies) but forward only the post-shell hole chunks. The PPR
 * contract: the SHELL portion must render identically for every visitor (same
 * tree structure and bytes for the shared request) - the holes are the only
 * personalized part. The hydration envelope carries per-request props, so on
 * these renders it streams right after the shell instead of inside it.
 */
import { isUtf8 } from 'node:buffer';
import React from 'react';
import { renderToReadableStream } from 'react-dom/server';
import type { IPCRequest, IPCOutbound, IPCResponse, GioRequest } from './context.ts';
import type {
  RouteModule,
  LayoutEntry,
  RedirectResult,
  HandlerEntry,
  GsspContext,
  GsspResponseHeaders,
  SpecialPages,
  SegmentFiles,
  NotFoundResult,
} from './router.ts';
import {
  emptySegmentFiles,
  layoutsForDir,
  nearestSegmentFiles,
  segmentChainForDir,
} from './router.ts';
import { GioEventStream, isGioEventStream } from './sse.ts';
import type { NodePluginRegistry } from './plugin.ts';
import { logger } from './logger.ts';
import { clientBuildErrorFor } from './client-build-errors.ts';
import { createErrorDigest, describeError, isDevMode } from './mode.ts';
import { isNotFoundError } from './not-found.ts';
import { buildSegmentTree, type SegmentLevel, type GioErrorProps } from './segment-tree.ts';
import { cspNonce, nonceAttr } from './csp.ts';
import {
  isJsonContentType,
  isUnsupportedMediaTypeError,
  UnsupportedMediaTypeError,
} from './request-body.ts';
import { parseCookies } from './cookies.ts';
import { installedImageConfig, type ImageRenderConfig } from './image-config.ts';

export interface SseRouteResult {
  type: 'sse';
  stream: GioEventStream;
}

/**
 * Streaming render (protocol v3): the head response goes out immediately
 * after React's shell is ready; the caller pumps `stream` as chunk frames.
 * `prefix`/`suffix` carry the document shell when no root layout provides one.
 */
export interface StreamRenderResult {
  type: 'stream';
  head: IPCResponse;
  stream: ReadableStream<Uint8Array>;
  prefix: string;
  suffix: string;
  /**
   * PPR shell handling: 'mark' emits a shell_end frame at the shell boundary
   * (Rust caches everything before it), 'discard' drops everything before the
   * boundary and forwards only the hole chunks (skipShell renders).
   */
  shellBoundary?: 'mark' | 'discard';
  /**
   * PPR renders only: the hydration envelope script, written right after the
   * shell boundary instead of inside the shell. Its props come from this
   * request's getServerSideProps (cookies included), so it must never become
   * part of the shell Rust caches and replays to every visitor.
   */
  envelope?: string;
  /**
   * 'mark' only: asked at the shell boundary. False withholds the shell_end
   * frame, so Rust stores nothing - React reported an error by then, and a
   * boundary it client-rendered may be part of the shell bytes.
   */
  keepShell?: () => boolean;
}

/** Optional render inputs beyond pages/layouts. */
export interface RenderExtras {
  /** route.ts method handlers (API routes + SSE). */
  handlers?: Map<string, HandlerEntry>;
  /** app/not-found.* and app/error.* */
  specialPages?: SpecialPages;
  /**
   * Per-folder not-found.*, error.* and loading.* (app/'s own included). The
   * root files here win over `specialPages`, which only fills in when
   * app/ has no entry.
   */
  segmentFiles?: SegmentFiles;
  /**
   * Allow streaming (chunked) responses for non-shareable page renders.
   * Only the IPC server sets this - static export keeps the buffered path.
   */
  streaming?: boolean;
  /**
   * Static export: the page is written as HTML that never hydrates, so a
   * Suspense boundary React handed to the browser would show its fallback
   * forever. Any error React reported fails the render instead.
   */
  staticExport?: boolean;
}

/** What production responses say instead of the real error message. */
const GENERIC_ERROR_MESSAGE = 'Internal Server Error';

/**
 * Request headers that identify the visitor - the same set Rust folds into
 * the coalesce key and strips from shared SWR refreshes. Other headers
 * (accept-language, user-agent, ...) only pick a variant of public content
 * and stay readable without making a render personal.
 */
const CREDENTIAL_HEADERS: readonly string[] = ['cookie', 'authorization'];

/**
 * Raw client-address headers - the material `ctx.ip` is derived from.
 * Reading them is as personal as reading `ctx.ip` (which is the trustworthy
 * way to get the address; any client can send these).
 */
const CLIENT_ADDRESS_HEADERS: readonly string[] = ['x-forwarded-for', 'forwarded', 'x-real-ip'];

/**
 * Raw headers naming the site the client asked for - the material
 * `ctx.host` / `ctx.scheme` are derived from. The host is whatever the
 * client sent unless a proxy pins it, so a cached page that printed it
 * could be poisoned for everyone; reading these is as personal as reading
 * `ctx.host`.
 */
const REQUEST_ORIGIN_HEADERS: readonly string[] = ['host', 'x-forwarded-host', 'x-forwarded-proto'];

/** Routes already warned about credential reads (one warning per route). */
const warnedDynamicRoutes = new Set<string>();

/**
 * Whether build diagnostics may be written into page HTML for the error
 * overlay. Uses Rust's dev-mode rule (main.rs), which also decides whether
 * the overlay is injected at all: only NODE_ENV=development. An unset
 * NODE_ENV - a plain `giojs-server` start - is production there, and the
 * diagnostics (import chains, esbuild errors with file paths) must not reach
 * public responses. Read per render so tests can switch it.
 */
function devOverlayHandOff(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.GIO_EXPORT !== '1';
}

/** Match a URL path against pattern-keyed entries. */
function matchIn<T>(
  path: string,
  entries: Map<string, T>,
): { entry: T; pattern: string; params: Record<string, string> } | null {
  // Exact match first - static patterns only, so a request for the literal
  // path "/posts/:id" never resolves to the dynamic route without params.
  const exact = entries.get(path);
  if (exact !== undefined && !/[:*]/.test(path)) {
    return { entry: exact, pattern: path, params: {} };
  }

  // Among all matching patterns, pick the most specific one, so the result
  // is independent of Map insertion order. Precedence is compared segment by
  // segment, left to right: literal > :param > *catchAll > *optional?.
  let best: { entry: T; pattern: string; params: Record<string, string> } | null = null;
  for (const [pattern, entry] of entries) {
    const params = matchPattern(pattern, path);
    if (params === null) continue;
    if (best === null || compareSpecificity(pattern, best.pattern) < 0) {
      best = { entry, pattern, params };
    }
  }
  return best;
}

function matchRoute(
  path: string,
  routes: Map<string, RouteModule>,
): { module: RouteModule; params: Record<string, string> } | null {
  const match = matchIn(path, routes);
  return match === null ? null : { module: match.entry, params: match.params };
}

/**
 * The route pattern that owns `path` (e.g. "/posts/:id"), or null when none
 * matches - the IPC `route` field Rust labels its metrics with. Same
 * precedence as renderRoute: the more specific of the page and route.ts
 * matches, equal patterns being one folder's pair.
 */
export function resolveRoutePattern(
  path: string,
  routes: Map<string, RouteModule>,
  handlers?: Map<string, HandlerEntry>,
): string | null {
  const page = matchIn(path, routes);
  const handler = handlers !== undefined ? matchIn(path, handlers) : null;
  if (handler !== null && (page === null || compareSpecificity(handler.pattern, page.pattern) <= 0)) {
    return handler.pattern;
  }
  return page?.pattern ?? null;
}

/** Build the request object handed to route.ts handlers. */
function makeGioRequest(req: IPCRequest, params: Record<string, string>): GioRequest {
  return {
    method: req.method,
    path: req.path,
    params,
    query: req.query,
    headers: req.headers,
    cookies: parseCookies(req.headers['cookie']),
    body: req.body,
    bodyBase64: req.bodyBase64,
    json<T = unknown>(): T {
      const contentType = req.headers['content-type'];
      if (!isJsonContentType(contentType)) throw new UnsupportedMediaTypeError(contentType);
      if (req.body === null) throw new Error('request has no body');
      if (req.bodyBase64) throw new Error('request body is binary (base64) - decode it manually');
      return JSON.parse(req.body) as T;
    },
    locale: req.locale,
    ...clientFields(req),
  };
}

/** The request's optional client identity fields, only those Rust sent. */
function clientFields(req: IPCRequest): Pick<GioRequest, 'ip' | 'scheme' | 'host' | 'requestId'> {
  return {
    ...(req.ip !== undefined ? { ip: req.ip } : {}),
    ...(req.scheme !== undefined ? { scheme: req.scheme } : {}),
    ...(req.host !== undefined ? { host: req.host } : {}),
    ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
  };
}

/**
 * Build the getServerSideProps context with Next.js-style dynamic detection:
 * touching `ctx.cookies`, `ctx.ip`, `ctx.host` or `ctx.scheme`, reading or
 * probing one of the `tracked` headers (lowercase names) on `ctx.headers`,
 * or enumerating the headers at all, marks the render as personalized.
 * Detection is per access, not per value - an absent cookie read still
 * decides the output (the anonymous variant), so it counts too. Only
 * `ctx.requestId` does not: a request id is for logs and never shapes a
 * page. Only the user-facing context is instrumented; framework code reads
 * `req.headers` directly and never trips it.
 *
 * `ctx.headers` is a Proxy, so structuredClone/postMessage reject it; a copy
 * (`{ ...ctx.headers }`) is a plain object - and counts as a read.
 */
function makeGsspContext(
  req: IPCRequest,
  params: Record<string, string>,
  tracked: ReadonlySet<string>,
): { ctx: GsspContext; credentialsRead: () => boolean } {
  let read = false;
  const isTracked = (key: string | symbol): boolean =>
    typeof key === 'string' && tracked.has(key.toLowerCase());
  const headers = new Proxy(
    { ...req.headers },
    {
      get(target, key, receiver) {
        if (isTracked(key)) read = true;
        return Reflect.get(target, key, receiver) as unknown;
      },
      has(target, key) {
        if (isTracked(key)) read = true;
        return Reflect.has(target, key);
      },
      getOwnPropertyDescriptor(target, key) {
        if (isTracked(key)) read = true;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      // Every enumeration (spread, Object.keys, JSON.stringify, for...in,
      // getOwnPropertyNames) lists the keys first, and the list alone tells
      // whether credentials were sent - a read with or without them.
      ownKeys(target) {
        read = true;
        return Reflect.ownKeys(target);
      },
    },
  );
  let cookies: Record<string, string> | undefined;
  const ctx: GsspContext = {
    method: req.method,
    path: req.path,
    params,
    query: req.query,
    headers,
    get cookies() {
      read = true;
      cookies ??= parseCookies(req.headers['cookie']);
      return cookies;
    },
    // A page that varies by visitor IP (geo, allowlists) is as personal as
    // one that varies by cookie: caching it would serve one visitor's
    // variant to everyone.
    get ip() {
      read = true;
      return req.ip;
    },
    // The host is whatever the client sent (unless a proxy pins it), and
    // the scheme is how this request arrived: a cached page that printed
    // either - an absolute link, a canonical URL - would serve one
    // request's value to everyone, an attacker's `Host: evil.example`
    // included.
    get scheme() {
      read = true;
      return req.scheme;
    },
    get host() {
      read = true;
      return req.host;
    },
    ...(req.locale !== '' ? { locale: req.locale } : {}),
    ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
  };
  return { ctx, credentialsRead: () => read };
}

/**
 * Headers an onRequest plugin added, changed or removed, as lowercase names
 * (the tracked set is matched case-insensitively; plugins may write
 * `X-User-Id`). They are derived per request (typically from the session
 * cookie - an auth plugin setting x-user-id), so reading them is as personal
 * as reading the cookie itself.
 */
function pluginDerivedHeaders(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter(name => before[name] !== after[name])
    .map(name => name.toLowerCase());
}

/**
 * Rank one pattern segment: literal (4) > dynamic (3) > catch-all (2) >
 * end of pattern (1) > optional catch-all (0). The pattern ending can only
 * tie with an optional catch-all that matched nothing (any other segment
 * needs a path segment there), and then the shorter pattern - `/shop` over
 * `/shop/*p?` for "/shop" - is the more specific one.
 */
function segmentRank(seg: string | undefined): number {
  if (seg === undefined) return 1;
  if (seg.startsWith('*')) return seg.endsWith('?') ? 0 : 2;
  if (seg.startsWith(':')) return 3;
  return 4;
}

/** Returns < 0 if `a` is more specific than `b`, > 0 if less, 0 if equal. */
function compareSpecificity(a: string, b: string): number {
  const aSegs = a.split('/').filter(Boolean);
  const bSegs = b.split('/').filter(Boolean);
  const len = Math.max(aSegs.length, bSegs.length);
  for (let i = 0; i < len; i++) {
    const diff = segmentRank(bSegs[i]) - segmentRank(aSegs[i]);
    if (diff !== 0) return diff;
  }
  // Same shape: discovery rejects two such routes, so this is a true tie.
  return 0;
}

/**
 * Match `path` against `pattern`. Catch-all values keep their slashes
 * ("a/b"); an optional catch-all that matches no segments yields ''.
 */
function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const patParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);

  const params: Record<string, string> = {};
  let pi = 0;

  for (let i = 0; i < patParts.length; i++) {
    const seg = patParts[i];

    if (seg === undefined) return null;

    if (seg.startsWith('*')) {
      const optional = seg.endsWith('?');
      // A required catch-all needs at least one segment: /docs/*slug never
      // answers "/docs" itself.
      if (!optional && pi >= pathParts.length) return null;
      params[optional ? seg.slice(1, -1) : seg.slice(1)] = pathParts.slice(pi).join('/');
      return params;
    }

    if (pi >= pathParts.length) return null;

    if (seg.startsWith(':')) {
      params[seg.slice(1)] = pathParts[pi] ?? '';
    } else if (seg !== pathParts[pi]) {
      return null;
    }
    pi++;
  }

  return pi === pathParts.length ? params : null;
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Inline observer handles the no-root-layout case where useEffect never runs.
const OBSERVER_SCRIPT_BODY = `(function(){var o=new IntersectionObserver(function(e){e.forEach(function(e){if(e.isIntersecting){e.target.dataset.gioAnimateState='entered';o.unobserve(e.target);}});},{threshold:0.1});document.querySelectorAll('[data-gio-animate]').forEach(function(el){o.observe(el);});})();`;

/**
 * Default 404 document, served when no `app/not-found.*` exists. Also written
 * to `out/404.html` on static export, so every deployed site returns a real
 * 404 for unknown paths by default (add app/not-found.* to customize it).
 */
export const BUILTIN_404_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>404 - Page not found</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0a09;color:#e7e5e4;font-family:system-ui,-apple-system,sans-serif}main{text-align:center;padding:2rem}p.code{font-family:ui-monospace,monospace;font-size:.8rem;letter-spacing:.2em;opacity:.55;margin:0 0 .6rem}h1{font-size:2rem;margin:0 0 .6rem;font-weight:650}p.hint{opacity:.7;margin:0 0 1.5rem}a{color:#0b0a09;background:#e7e5e4;text-decoration:none;padding:.55rem 1.1rem;border-radius:999px;font-weight:600;font-size:.9rem}</style></head><body><main><p class="code">HTTP 404</p><h1>Page not found</h1><p class="hint">This page doesn't exist or was moved.</p><a href="/">Go home</a></main></body></html>`;

// The #__gio boundary and bootstrap module scripts are rendered by React
// (they must exist identically in the client element tree), so this shell
// only supplies the document skeleton a missing root layout would provide.
const DOCUMENT_PREFIX = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>';

/** Closing document shell; its inline script carries the CSP nonce. */
function documentSuffix(): string {
  return `<script${nonceAttr()}>${OBSERVER_SCRIPT_BODY}</script></body></html>`;
}

function wrapWithDocument(inner: string): string {
  return `${DOCUMENT_PREFIX}${inner}${documentSuffix()}`;
}

/**
 * The CSP nonce as React props / render options: React stamps it on its
 * bootstrap module scripts and its streaming runtime scripts (Suspense
 * reveals), and we pass it to every inline script we create.
 */
function nonceOption(): { nonce?: string } {
  const nonce = cspNonce();
  return nonce !== undefined ? { nonce } : {};
}

/** The built-in 404 document, its inline style nonced like our scripts. */
function builtin404Html(): string {
  return BUILTIN_404_HTML.replace('<style>', `<style${nonceAttr()}>`);
}

/**
 * Inline script handing `message` to the dev overlay, which picks up
 * `window.__GIO_SSR_ERROR__` when it loads. Escaped like the envelope so
 * the message can never close the script element.
 */
export function devOverlayErrorScript(message: string): string {
  const payload = JSON.stringify({ message, stack: '' })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `window.__GIO_SSR_ERROR__=${payload};`;
}

/**
 * Serialize the hydration envelope for the `#__gio_props` JSON script.
 * `<` is escaped so props containing `</script>` (or `<!--`) can never
 * terminate the script element early - the classic serialization XSS.
 * Returns null when props are not JSON-serializable; the page then renders
 * server-only instead of hydrating with wrong data.
 */
export function serializeEnvelope(envelope: {
  props: Record<string, unknown>;
  path: string;
  pattern: string;
  entry: string;
  /** The `<GioImage>` config the server rendered with, for identical srcsets. */
  images?: ImageRenderConfig;
}): string | null {
  try {
    return JSON.stringify(envelope)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  } catch {
    return null;
  }
}

function isRedirect(result: unknown): result is RedirectResult {
  return typeof result === 'object' && result !== null && 'redirect' in result;
}

/** `{ notFound: true }` - strictly `true`, so flat props holding a notFound value still render. */
function isNotFoundResult(result: unknown): result is NotFoundResult {
  return isRecord(result) && result['notFound'] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** gSSP header values: a string, or a string array for repeated headers. */
function isHeaderRecord(value: unknown): value is GsspResponseHeaders {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    v => typeof v === 'string' || (Array.isArray(v) && v.every(item => typeof item === 'string')),
  );
}

/** Response headers split for the IPC frame (see IPCResponse.setCookies). */
export interface IpcHeaders {
  headers: Record<string, string>;
  setCookies: string[];
}

/**
 * Flatten user-supplied response headers for the single-valued IPC map.
 * Every set-cookie value travels separately in `setCookies` - cookies are
 * not comma-joinable (Expires dates contain commas) - while other repeated
 * headers are joined with ", " as RFC 9110 permits for list-valued fields.
 */
export function flattenResponseHeaders(input: GsspResponseHeaders): IpcHeaders {
  const headers: Record<string, string> = {};
  const setCookies: string[] = [];
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    const values = Array.isArray(value) ? value : [value];
    if (name === 'set-cookie') {
      setCookies.push(...values);
      continue;
    }
    if (values.length === 0) continue;
    const joined = values.join(', ');
    const existing = headers[name];
    headers[name] = existing === undefined ? joined : `${existing}, ${joined}`;
  }
  return { headers, setCookies };
}

/**
 * Convert a web Response's headers. Headers already joins repeated fields
 * with ", " - except set-cookie, which forEach yields once per cookie (so a
 * map keeps only the last); getSetCookie() returns each cookie intact.
 */
export function webHeadersToIpc(source: Headers): IpcHeaders {
  const headers: Record<string, string> = {};
  source.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower !== 'set-cookie') headers[lower] = value;
  });
  return { headers, setCookies: source.getSetCookie() };
}

/** Spread into an IPC response: omits the field when there are no cookies. */
function setCookiesField(setCookies: string[]): { setCookies?: string[] } {
  return setCookies.length > 0 ? { setCookies } : {};
}

function isIPCResponse(value: IPCOutbound): value is IPCResponse {
  return 'status' in value;
}

/** Plugins are user code - verify the shape at runtime, not just via types. */
function isPluginResponse(value: IPCRequest | IPCResponse): value is IPCResponse {
  return isRecord(value) && typeof value['status'] === 'number' && typeof value['body'] === 'string';
}

export async function renderRoute(
  req: IPCRequest,
  routes: Map<string, RouteModule>,
  layouts: Map<string, LayoutEntry>,
  registry?: NodePluginRegistry,
  signal?: AbortSignal,
  /** Route pattern → hydration entry script URL from the client build. */
  clientScripts?: Map<string, string>,
  extras?: RenderExtras,
): Promise<IPCOutbound | SseRouteResult | StreamRenderResult> {
  const credentialHeaders = new Set([
    ...CREDENTIAL_HEADERS,
    ...CLIENT_ADDRESS_HEADERS,
    ...REQUEST_ORIGIN_HEADERS,
  ]);
  if (registry !== undefined && !registry.isEmpty) {
    // Snapshot first: plugins may mutate req.headers in place.
    const incomingHeaders = { ...req.headers };
    const intercepted = await registry.interceptRequest(req);
    if (isPluginResponse(intercepted)) {
      return intercepted;
    }
    req = intercepted;
    for (const name of pluginDerivedHeaders(incomingHeaders, req.headers)) {
      credentialHeaders.add(name);
    }
  }

  const match = matchRoute(req.path, routes);

  // ── route.ts method handlers (API routes + SSE) ───────────────────────────
  // Pages and route.ts files share one precedence rule: the more specific
  // pattern owns the URL, so app/blog/about/page.tsx is never shadowed by
  // app/blog/[slug]/route.ts or a catch-all route.ts above it. Equal
  // patterns are the same-folder pairing (discovery rejects any other): the
  // route.ts serves the methods it exports and GET/HEAD fall through to the
  // page.
  const handlerMatch =
    extras?.handlers !== undefined ? matchIn(req.path, extras.handlers) : null;
  const handlerVsPage =
    handlerMatch === null || match === null
      ? -1
      : compareSpecificity(handlerMatch.pattern, match.module.urlPattern);
  if (handlerMatch !== null && handlerVsPage <= 0) {
    // HEAD is served by the GET handler (body discarded by the client).
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const handler = handlerMatch.entry.methods.get(method);
    if (handler !== undefined) {
      const result = await runRouteHandler(req, handler, handlerMatch.params);
      if (!isSseHandlerResult(result) && registry !== undefined && !registry.isEmpty) {
        return registry.interceptResponse(req, result);
      }
      return result;
    }
    // The route.ts owns this URL; only a sibling page (same pattern) may still
    // render a GET it does not export. Anything else is a 405.
    const siblingPage = handlerVsPage === 0;
    if (!((req.method === 'GET' || req.method === 'HEAD') && siblingPage)) {
      return methodNotAllowed(req, [...handlerMatch.entry.methods.keys()]);
    }
  }

  if (!match) {
    // Unmatched URLs belong to no folder: only app/not-found.* applies.
    return renderNotFound(req, '', layouts, extras, signal);
  }

  // Pages only answer GET/HEAD; mutations belong to route.ts handlers.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return methodNotAllowed(req, ['GET', 'HEAD']);
  }

  try {
    const pageModule = await match.module.load();

    // Legacy SSE shape - a component-less page module exporting GET(req) →
    // GioEventStream. route.ts handlers are the supported home for SSE; this
    // stays for back-compat. Pages that DO have a component never get their
    // GET invoked - calling it per render would execute its side effects
    // (db writes, counters) once per page view and discard the result.
    if (pageModule.default === undefined && pageModule.GET !== undefined) {
      const result = pageModule.GET(makeGioRequest(req, match.params));
      if (isGioEventStream(result)) {
        return { type: 'sse', stream: result };
      }
    }

    const Component = pageModule.default;

    let props: Record<string, unknown> = {};
    let gsspHeaders: IpcHeaders | null = null;
    let credentialsRead = (): boolean => false;
    if (pageModule.getServerSideProps) {
      const gssp = makeGsspContext(req, match.params, credentialHeaders);
      credentialsRead = gssp.credentialsRead;
      const result = await pageModule.getServerSideProps(gssp.ctx);
      if (isRedirect(result)) {
        const extra = isHeaderRecord(result.headers)
          ? flattenResponseHeaders(result.headers)
          : { headers: {}, setCookies: [] };
        return {
          id: req.id,
          status: result.redirect.permanent ? 301 : 302,
          headers: { ...extra.headers, location: result.redirect.destination },
          body: '',
          cacheable: false,
          cacheMaxAge: 0,
          ...setCookiesField(extra.setCookies),
        };
      }
      if (isNotFoundResult(result)) {
        return renderNotFound(req, match.module.dir, layouts, extras, signal);
      }
      if (!isRecord(result)) {
        throw new Error(
          `getServerSideProps for route "${match.module.urlPattern}" must return an object - ` +
            `{ props: {...} }, flat props, { redirect: {...} } or { notFound: true } - but returned ` +
            `${result === null ? 'null' : typeof result}`,
        );
      }
      // Support both { props: {...} } (Next.js convention) and flat { key: value }.
      // Response headers ({ props, headers }) are honored only alongside a
      // props key, so flat objects that happen to contain `headers` still work.
      const nested = result['props'];
      if (isRecord(nested)) {
        props = nested;
        const returnedHeaders = result['headers'];
        if (isHeaderRecord(returnedHeaders)) {
          // Checked after flattening: `{ 'set-cookie': [] }` (cookies set
          // only sometimes) sends nothing, so it must not cost the page its
          // cacheability.
          const flat = flattenResponseHeaders(returnedHeaders);
          if (Object.keys(flat.headers).length > 0 || flat.setCookies.length > 0) {
            gsspHeaders = flat;
          }
        }
      } else {
        props = result;
      }
    } else {
      props = { params: match.params, searchParams: req.query };
    }

    // Build the hydration boundary: page wrapped by the non-root layouts and
    // the error/loading boundaries of its folders (segment-tree.ts) inside
    // <div id="__gio">, with the envelope script as a sibling. The client
    // bundle hydrates exactly this div; the root layout (and everything Rust
    // injects into the document later) stays server-only HTML, so post-render
    // head/body injection can never cause a hydration mismatch.
    const rootLayoutEntry = layouts.get('');
    // Errors React reports while rendering (onError), and the loading.*
    // boundaries that may have caught one of them (see abortedLoadingBoundary).
    const reported: ReportedFailure[] = [];
    const probes: ProbeState[] = [];
    const levels = await loadSegmentLevels(
      match.module.dir,
      layouts,
      extras?.segmentFiles,
      probes,
      reported,
    );
    const inner = buildSegmentTree(React.createElement(Component, props), req.path, levels);

    const pattern = match.module.urlPattern;
    // Installed before rendering: <GioImage> reads it during the render.
    const images = installedImageConfig();
    // Static export passes the manifest of its own build (export.ts).
    const entryScript = clientScripts?.get(pattern);
    const envelopeJson =
      entryScript !== undefined
        ? serializeEnvelope({
            props,
            path: req.path,
            pattern,
            entry: entryScript,
            images,
          })
        : null;
    if (entryScript !== undefined && envelopeJson === null) {
      logger.warn('props are not JSON-serializable - page will render without hydration', {
        path: req.path,
      });
    }
    // Dev: a route whose client bundle was rejected says so in the error
    // overlay - otherwise the only symptom is a page that never hydrates.
    const clientBuildError =
      entryScript === undefined && devOverlayHandOff() ? clientBuildErrorFor(pattern) : undefined;

    let cacheable = pageModule.revalidate !== undefined;
    if (gsspHeaders !== null && cacheable) {
      // Response headers from gSSP are per-request (set-cookie above all);
      // caching them would replay one user's headers to everyone.
      logger.warn('getServerSideProps returned headers - page made uncacheable', {
        path: req.path,
      });
      cacheable = false;
    }
    // revalidate=false means "cache forever"; false??0 would coerce to 0 so check explicitly.
    let cacheMaxAge = !cacheable
      ? 0
      : pageModule.revalidate === false
        ? 31536000
        : (pageModule.revalidate ?? 0);
    const responseHeaders = {
      'content-type': 'text/html; charset=utf-8',
      ...(gsspHeaders?.headers ?? {}),
    };
    const pageCookies = setCookiesField(gsspHeaders?.setCookies ?? []);

    // Streaming applies only to non-shareable renders (mirrors Rust's
    // render_is_shareable; page renders never set vary): shareable pages stay
    // buffered so they land in the shared cache, everything rendered
    // per-request streams for TTFB. HEAD stays buffered, and onResponse
    // plugins need the full body.
    //
    // PPR (`export const shell = 'cache'`) is the exception: a SHAREABLE page
    // streams so Rust can cache its pre-Suspense shell (shell_end marks the
    // boundary). The shell must be shareable - a page that fails the
    // shareability test falls back to plain streaming. skipShell requests
    // (Rust re-rendering only the holes for a shell cache hit) always stream.
    let shareable = cacheable && cacheMaxAge > 0;
    const streamingAvailable =
      extras?.streaming === true &&
      req.method === 'GET' &&
      process.env.GIO_EXPORT !== '1' &&
      (registry === undefined || !registry.hasResponseInterceptors);
    const skipShell = req.skipShell === true;
    if (skipShell && pageCookies.setCookies !== undefined) {
      logger.warn(
        'getServerSideProps set cookies during a PPR holes render - the cached shell already sent its headers, so they are dropped',
        { path: req.path },
      );
    }
    if (pageModule.shell === 'cache' && !shareable && !skipShell) {
      logger.warn(
        "shell='cache' requires a shareable render (revalidate set, no per-request headers) - falling back",
        { path: req.path },
      );
    }
    const pprShell = pageModule.shell === 'cache' && shareable && streamingAvailable;

    // A render that read request credentials is personal: caching it under
    // the shared key would serve the first visitor's page to everyone. PPR
    // keeps its cache - Rust stores only the shell, which the PPR contract
    // keeps visitor-independent, and the per-request props stream after it.
    const makePersonal = (): void => {
      warnPersonalRender(pattern, req.path);
      cacheable = false;
      cacheMaxAge = 0;
      shareable = false;
    };
    if (shareable && !pprShell && credentialsRead()) {
      makePersonal();
    }
    const shouldStream = streamingAvailable && (!shareable || pprShell || skipShell);
    // With a shell boundary, the envelope must stream after it (pumped by
    // ipc.ts) - inside the shell it would be cached with this request's props.
    const deferEnvelope = shouldStream && (pprShell || skipShell);

    let element: React.ReactNode = React.createElement(
      React.Fragment,
      null,
      React.createElement('div', { id: '__gio' }, inner),
      envelopeJson !== null && !deferEnvelope
        ? React.createElement('script', {
            id: '__gio_props',
            type: 'application/json',
            dangerouslySetInnerHTML: { __html: envelopeJson },
          })
        : null,
      clientBuildError !== undefined
        ? React.createElement('script', {
            ...nonceOption(),
            dangerouslySetInnerHTML: { __html: devOverlayErrorScript(clientBuildError) },
          })
        : null,
    );
    if (rootLayoutEntry !== undefined) {
      const rootLayoutMod = await rootLayoutEntry.load();
      element = React.createElement(rootLayoutMod.default, {
        children: element,
        path: req.path,
      });
    }

    // Resolves once React's shell is ready; Suspense content streams later.
    const stream = await renderToReadableStream(element, {
      bootstrapModules: envelopeJson !== null && entryScript !== undefined ? [entryScript] : [],
      ...nonceOption(),
      // Cancelled requests (client disconnect / Rust timeout) abort the React
      // render instead of finishing output nobody will read.
      ...(signal !== undefined ? { signal } : {}),
      onError(streamError) {
        // The returned digest is what React puts in the HTML in place of the
        // message (production builds); the log line carries the details.
        const digest = createErrorDigest();
        reported.push(new ReportedFailure(streamError, digest));
        if (isNotFoundError(streamError)) {
          logger.debug('notFound() during render', { path: req.path });
        } else {
          logger.error('ssr stream error', { path: req.path, digest, ...describeError(streamError) });
        }
        return digest;
      },
    });

    // React recovered from an error inside a Suspense boundary (the browser
    // renders that part instead). Fine for this visitor; cached, everyone
    // would get the fallback until the next revalidation.
    const makeUncacheableAfterRecovery = (): void => {
      if (!cacheable) return;
      logger.warn('render recovered from an error in a Suspense boundary - not cached', {
        path: req.path,
      });
      cacheable = false;
      cacheMaxAge = 0;
      shareable = false;
    };

    // The loading.* boundaries are judged as the shell completes, on both
    // paths: everything React rendered before the shell was ready has
    // reported by now. A boundary entered later sits below content that had
    // already suspended - without its loading.* file the error would not
    // have failed the shell either - so a buffered render answers exactly
    // what the same render streamed would have.
    const abortedBoundary = abortedLoadingBoundary(reported, probes);

    if (shouldStream) {
      // A holes-only render cannot change the answer: Rust already sent the
      // cached shell.
      if (!skipShell) {
        const failure = notFoundFailure(reported) ?? abortedBoundary;
        if (failure !== null) {
          await stream.cancel().catch(() => undefined);
          throw failure;
        }
        // A boundary React already client-rendered is part of the shell (the
        // only part of a streamed render Rust stores).
        if (pprShell && reported.length > 0) makeUncacheableAfterRecovery();
      }
      // Nothing to store when the render stopped being cacheable.
      const storeShell = pprShell && !skipShell && cacheable;
      // A skipShell response must never be cached: its body is holes-only.
      return {
        type: 'stream',
        head: {
          id: req.id,
          status: 200,
          headers: responseHeaders,
          body: '',
          cacheable: skipShell ? false : cacheable,
          cacheMaxAge: skipShell ? 0 : cacheMaxAge,
          streaming: true,
          ...(storeShell ? { pprShell: true } : {}),
          ...pageCookies,
        },
        stream,
        prefix: rootLayoutEntry !== undefined ? '' : DOCUMENT_PREFIX,
        suffix: rootLayoutEntry !== undefined ? '' : documentSuffix(),
        ...(skipShell
          ? { shellBoundary: 'discard' as const }
          : pprShell
            ? { shellBoundary: 'mark' as const }
            : {}),
        // An error React reports between now and the shell boundary (work
        // it picks up before the first read) can still land in the shell.
        ...(storeShell ? { keepShell: () => reported.length === 0 } : {}),
        ...(deferEnvelope && envelopeJson !== null
          ? { envelope: envelopeScript(envelopeJson) }
          : {}),
      };
    }

    await stream.allReady;
    const html = await streamToString(stream);
    // notFound() anywhere still answers 404: nothing has been sent yet.
    const failure = notFoundFailure(reported) ?? abortedBoundary;
    if (failure !== null) throw failure;
    const recovered = reported[0];
    if (recovered !== undefined) {
      // An exported page never hydrates: the browser would never render the
      // boundary React gave up on, and its fallback would stay forever.
      if (extras?.staticExport === true) throw recovered;
      makeUncacheableAfterRecovery();
    }
    // Props can carry ctx.headers into the render itself; catch reads that
    // happened while rendering, before the response is offered to the cache.
    if (shareable && credentialsRead()) {
      makePersonal();
    }

    // Root layout provides <html>/<body>, so skip the document wrapper.
    const body = rootLayoutEntry !== undefined ? html : wrapWithDocument(html);

    const ssrResponse: IPCOutbound = {
      id: req.id,
      status: 200,
      headers: responseHeaders,
      body,
      cacheable,
      cacheMaxAge,
      ...pageCookies,
    };

    if (registry !== undefined && !registry.isEmpty && isIPCResponse(ssrResponse)) {
      return registry.interceptResponse(req, ssrResponse);
    }
    return ssrResponse;
  } catch (thrown) {
    // A failure React caught (and onError logged) keeps its digest.
    const reportedFailure = thrown instanceof ReportedFailure ? thrown : null;
    const err: unknown = reportedFailure !== null ? reportedFailure.error : thrown;
    if (isNotFoundError(err)) {
      return renderNotFound(req, match.module.dir, layouts, extras, signal);
    }
    // Production responses carry only a generic message and the digest; the
    // details live in this log line under the same digest.
    const digest = reportedFailure?.digest ?? createErrorDigest();
    logger.error('ssr render failed', { path: req.path, digest, ...describeError(err) });
    const dev = isDevMode();
    const message = dev ? (err instanceof Error ? err.message : String(err)) : GENERIC_ERROR_MESSAGE;
    // The nearest error.* at or above the page's folder. One whose own
    // folder's layout is what threw fails to render again, so the walk
    // moves on up - an error.* never catches its own layout.
    const errorProps: GioErrorProps = { error: { message, digest } };
    const errorPage = await renderNearestSegmentPage(
      req,
      layouts,
      segmentPageCandidates(match.module.dir, 'error', extras),
      errorProps,
      500,
      signal,
    );
    if (errorPage !== null) return errorPage;
    return {
      id: req.id,
      error: true,
      code: 'RENDER_ERROR',
      message,
      digest,
      ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
      ...(dev && err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
    };
  }
}

/** The `#__gio_props` element as raw HTML (the deferred PPR envelope). */
function envelopeScript(envelopeJson: string): string {
  return `<script id="__gio_props" type="application/json">${envelopeJson}</script>`;
}

/**
 * Explain once per route why a page exporting `revalidate` is not cached.
 * Each later render of the route stays uncacheable, just silently.
 */
function warnPersonalRender(pattern: string, path: string): void {
  if (warnedDynamicRoutes.has(pattern)) return;
  warnedDynamicRoutes.add(pattern);
  logger.warn(
    'getServerSideProps read request credentials (ctx.cookies, ctx.ip, ctx.host, ctx.scheme, ' +
      'the cookie/authorization, a client-address or a host header, or a header an onRequest ' +
      'plugin set) - this render is personalized, so it is not cached even though the page ' +
      "exports revalidate. Remove `revalidate`, or keep `revalidate` + `shell = 'cache'` " +
      'and render the personalized parts inside <Suspense> holes',
    { route: pattern, path },
  );
}

// ── route.ts handler dispatch ─────────────────────────────────────────────────

function isSseHandlerResult(value: IPCResponse | SseRouteResult): value is SseRouteResult {
  return 'type' in value && value.type === 'sse';
}

function methodNotAllowed(req: IPCRequest, allowed: string[]): IPCResponse {
  const allow = [...new Set([...allowed, allowed.includes('GET') ? 'HEAD' : ''])]
    .filter(m => m !== '')
    .join(', ');
  return {
    id: req.id,
    status: 405,
    headers: { 'content-type': 'application/json; charset=utf-8', allow },
    body: JSON.stringify({ error: 'Method Not Allowed' }),
    cacheable: false,
    cacheMaxAge: 0,
  };
}

/**
 * Invoke a route.ts method handler. The result contract:
 * `GioEventStream` → SSE; web `Response` → converted; null/undefined → 204;
 * anything else → JSON 200; notFound() → JSON 404. Handler responses are
 * never cacheable.
 */
async function runRouteHandler(
  req: IPCRequest,
  handler: (gioReq: GioRequest) => unknown,
  params: Record<string, string>,
): Promise<IPCResponse | SseRouteResult> {
  const base = { id: req.id, cacheable: false, cacheMaxAge: 0 };
  try {
    const result = await handler(makeGioRequest(req, params));

    if (isGioEventStream(result)) {
      return { type: 'sse', stream: result };
    }
    if (result instanceof Response) {
      const { headers, setCookies } = webHeadersToIpc(result.headers);
      headers['content-type'] ??= 'text/plain; charset=utf-8';
      const cookies = setCookiesField(setCookies);
      // text() would lossily transcode binary payloads (images, pdfs) to
      // U+FFFD; non-UTF-8 bodies cross base64-encoded like request bodies do.
      const raw = Buffer.from(await result.arrayBuffer());
      if (isUtf8(raw)) {
        return { ...base, status: result.status, headers, body: raw.toString('utf8'), ...cookies };
      }
      return {
        ...base,
        status: result.status,
        headers,
        body: raw.toString('base64'),
        bodyBase64: true,
        ...cookies,
      };
    }
    if (result === undefined || result === null) {
      return { ...base, status: 204, headers: {}, body: '' };
    }
    return {
      ...base,
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    if (isNotFoundError(err)) {
      return {
        ...base,
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'Not Found' }),
      };
    }
    // A client error, not a handler failure: nothing to log or hide.
    if (isUnsupportedMediaTypeError(err)) {
      return {
        ...base,
        status: 415,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ error: 'Unsupported Media Type', message: err.message }),
      };
    }
    const digest = createErrorDigest();
    logger.error('route handler failed', {
      path: req.path,
      method: req.method,
      digest,
      ...describeError(err),
    });
    return {
      ...base,
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: GENERIC_ERROR_MESSAGE, digest }),
    };
  }
}

// ── segment boundaries (loading.*, error.*, not-found.*) ──────────────────────

/** An error React reported through onError, with the digest it was logged under. */
class ReportedFailure {
  constructor(
    readonly error: unknown,
    readonly digest: string,
  ) {}
}

/** What a loading.* boundary's probe saw during the render (segment-tree.ts). */
interface ProbeState {
  entered: boolean;
  exited: boolean;
  /** How many errors had been reported when the boundary's content started. */
  reportedBefore: number;
  /** How many had been reported once React moved past the boundary; null until then. */
  reportedAfter: number | null;
}

/**
 * Load the layouts, error.* and loading.* components of the page folder's
 * chain (segmentChainForDir - the same chain the client entry imports),
 * attaching a probe to every loading boundary.
 */
async function loadSegmentLevels(
  dir: string,
  layouts: Map<string, LayoutEntry>,
  segmentFiles: SegmentFiles | undefined,
  probes: ProbeState[],
  reported: readonly ReportedFailure[],
): Promise<SegmentLevel[]> {
  const chain = segmentChainForDir(dir, layouts, segmentFiles ?? emptySegmentFiles());
  const levels: SegmentLevel[] = [];
  for (const level of chain) {
    const [layoutMod, errorMod, loadingMod] = await Promise.all([
      level.layout?.load(),
      level.error?.load(),
      level.loading?.load(),
    ]);
    const segmentLevel: SegmentLevel = {
      layout: layoutMod?.default ?? null,
      error: (errorMod?.default as React.ComponentType<GioErrorProps> | undefined) ?? null,
      loading: loadingMod?.default ?? null,
    };
    if (loadingMod !== undefined) {
      const state: ProbeState = {
        entered: false,
        exited: false,
        reportedBefore: 0,
        reportedAfter: null,
      };
      probes.push(state);
      segmentLevel.probe = {
        enter: () => {
          if (state.entered) return;
          state.entered = true;
          state.reportedBefore = reported.length;
        },
        exit: () => {
          state.exited = true;
        },
        after: () => {
          state.reportedAfter ??= reported.length;
        },
      };
    }
    levels.push(segmentLevel);
  }
  return levels;
}

/*
 * Failures answered like a failed shell although a Suspense boundary caught
 * them - while nothing has been sent yet:
 * - notFound() anywhere: the answer can still be a 404;
 * - an error a loading.* boundary caught before its content suspended:
 *   without the loading.* file it would have failed the shell, and adding
 *   one must not turn that 500 into a 200.
 * Errors in the app's own Suspense boundaries (and anything thrown after a
 * loading.* boundary's content suspended) keep React's client-rendering
 * fallback.
 */

/** The first notFound() call React reported, if any. */
function notFoundFailure(reported: readonly ReportedFailure[]): ReportedFailure | null {
  return reported.find(r => isNotFoundError(r.error)) ?? null;
}

/** The error that aborted a loading.* boundary's content before it suspended, if any. */
function abortedLoadingBoundary(
  reported: readonly ReportedFailure[],
  probes: readonly ProbeState[],
): ReportedFailure | null {
  const failed = probes.find(p => p.entered && !p.exited);
  if (failed === undefined) return null;
  // React reports the error that aborts a boundary just before it moves on
  // to the boundary's next sibling. Earlier reports since the content
  // started came from Suspense boundaries inside it that recovered.
  if (failed.reportedAfter !== null && failed.reportedAfter > failed.reportedBefore) {
    return reported[failed.reportedAfter - 1] ?? null;
  }
  return reported[failed.reportedBefore] ?? reported[0] ?? null;
}

interface SegmentPageCandidate {
  /** app/-relative folder of the file: selects the layouts it renders in. */
  dir: string;
  load: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>;
}

/**
 * The not-found.* or error.* files that may answer for a page in `dir`,
 * nearest first. app/'s own comes from `segmentFiles`, or from
 * `specialPages` for callers that only discovered the root files.
 */
function segmentPageCandidates(
  dir: string,
  kind: 'notFound' | 'error',
  extras: RenderExtras | undefined,
): SegmentPageCandidate[] {
  const files = extras?.segmentFiles?.[kind];
  const candidates: SegmentPageCandidate[] =
    files !== undefined ? nearestSegmentFiles(dir, files) : [];
  const rootFallback = extras?.specialPages?.[kind];
  if (rootFallback !== undefined && !candidates.some(c => c.dir === '')) {
    candidates.push({ dir: '', load: rootFallback });
  }
  return candidates;
}

/**
 * 404 for a page in `dir`: the nearest not-found.* at or above it, inside
 * the layouts of that file's folder, else the built-in page. Never cached:
 * a 404 can depend on anything getServerSideProps read (credentials
 * included), and a cached 404 would also outlive the content appearing.
 */
async function renderNotFound(
  req: IPCRequest,
  dir: string,
  layouts: Map<string, LayoutEntry>,
  extras: RenderExtras | undefined,
  signal: AbortSignal | undefined,
): Promise<IPCResponse> {
  const page = await renderNearestSegmentPage(
    req,
    layouts,
    segmentPageCandidates(dir, 'notFound', extras),
    {},
    404,
    signal,
  );
  return page ?? {
    id: req.id,
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: builtin404Html(),
    cacheable: false,
    cacheMaxAge: 0,
  };
}

/**
 * Render the first candidate that renders: one whose own layouts fail (or
 * call notFound()) gives way to the next one up, the way a React error
 * boundary passes on what it cannot handle. Null when none renders.
 */
async function renderNearestSegmentPage(
  req: IPCRequest,
  layouts: Map<string, LayoutEntry>,
  candidates: readonly SegmentPageCandidate[],
  props: object,
  status: number,
  signal?: AbortSignal,
): Promise<IPCResponse | null> {
  for (const candidate of candidates) {
    const page = await renderSpecialPage(req, layouts, candidate, props, status, signal);
    if (page !== null) return page;
  }
  return null;
}

/**
 * Render a special page (404/500) through the normal layout pipeline,
 * server-only (no hydration envelope). Returns null when its render fails -
 * callers try the next candidate, then the built-in plain response.
 */
async function renderSpecialPage(
  req: IPCRequest,
  layouts: Map<string, LayoutEntry>,
  candidate: SegmentPageCandidate,
  props: object,
  status: number,
  signal?: AbortSignal,
): Promise<IPCResponse | null> {
  try {
    const pageModule = await candidate.load();
    // Layouts follow the special page's own filesystem ancestry, the same rule
    // as for pages - never the layouts of whatever URL failed or was missing.
    const applicableLayouts = layoutsForDir(candidate.dir, layouts);
    const rootLayoutEntry = applicableLayouts.find(l => l.dir === '');
    const innerLayouts = applicableLayouts.filter(l => l.dir !== '');

    let inner: React.ReactNode = React.createElement(
      pageModule.default,
      props as Record<string, unknown>,
    );
    for (const layoutEntry of [...innerLayouts].reverse()) {
      const layoutMod = await layoutEntry.load();
      inner = React.createElement(layoutMod.default, { children: inner, path: req.path });
    }
    let element: React.ReactNode = React.createElement('div', { id: '__gio' }, inner);
    if (rootLayoutEntry !== undefined) {
      const rootLayoutMod = await rootLayoutEntry.load();
      element = React.createElement(rootLayoutMod.default, {
        children: element,
        path: req.path,
      });
    }

    const stream = await renderToReadableStream(element, {
      bootstrapModules: [],
      ...nonceOption(),
      ...(signal !== undefined ? { signal } : {}),
      onError(streamError) {
        logger.error('special page stream error', {
          path: req.path,
          status,
          error: streamError instanceof Error ? streamError.message : String(streamError),
        });
      },
    });
    await stream.allReady;
    const html = await streamToString(stream);
    return {
      id: req.id,
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: rootLayoutEntry !== undefined ? html : wrapWithDocument(html),
      cacheable: false,
      cacheMaxAge: 0,
    };
  } catch (specialError) {
    logger.error('special page render failed - falling back', {
      path: req.path,
      status,
      dir: candidate.dir === '' ? '.' : candidate.dir,
      error: specialError instanceof Error ? specialError.message : String(specialError),
    });
    return null;
  }
}
