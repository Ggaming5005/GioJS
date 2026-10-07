/**
 * giojs-core/src/ssr.ts
 *
 * Renders matched routes to HTML. Applies layout.tsx wrappers outermost-first,
 * detects getServerSideProps redirect returns, and maps revalidate semantics to
 * the cache fields Rust reads (revalidate=false → one-year TTL, not 0).
 * Also handles GET() exports that return GioEventStream (SSE routes).
 *
 * POSTs to a page run its `action` export (action.ts): the action's answer
 * is sent as is (Response, redirect), or the page re-renders with its data
 * as the `actionData` prop - never cached. Other mutations get a 405. A
 * redirect answering a GioForm submission travels in a header instead of a
 * 3xx (asFormRedirect), so the client router - not fetch - follows it.
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
  RouteHandlerFn,
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
  RouteLoadError,
  segmentChainForDir,
} from './router.ts';
import { GioEventStream, isGioEventStream } from './sse.ts';
import type { NodePluginRegistry } from './plugin.ts';
import { logger } from './logger.ts';
import { clientBuildErrorFor } from './client-build-errors.ts';
import { createErrorDigest, describeError, isDevMode } from './mode.ts';
import { isNotFoundError } from './not-found.ts';
import {
  buildSegmentTree,
  withStylesheets,
  type SegmentLevel,
  type GioErrorProps,
} from './segment-tree.ts';
import { segmentStylesheetKey, type StyleManifest } from './style-manifest.ts';
import { cspNonce, nonceAttr } from './csp.ts';
import {
  isJsonContentType,
  isMalformedBodyError,
  isUnsupportedMediaTypeError,
  parseFormData,
  UnsupportedMediaTypeError,
} from './request-body.ts';
import {
  actionOutcome,
  isActionRedirect,
  type ActionOutcome,
  type ActionRedirect,
  type PageAction,
} from './action.ts';
import { parseCookies } from './cookies.ts';
import { installedImageConfig, type ImageRenderConfig } from './image-config.ts';
import { searchFromQuery, withNavigation, type GioNavigationState } from './navigation-context.ts';
import {
  dedupeHeadTitles,
  dedupeHeadTitlesStream,
  metadataTagsHtml,
  metadataToTags,
  resolveMetadata,
  segmentMetadata,
  titleHtml,
  type Metadata,
  type MetadataExtras,
  type MetadataModule,
} from './metadata.ts';
import { withMetadata, type MetadataTag } from './metadata-tags.ts';
import {
  metadataRouteKindForPath,
  renderMetadataRoute,
  type MetadataRoutes,
} from './metadata-routes.ts';
import { sanitizeCacheTags } from './revalidate.ts';

export interface SseRouteResult {
  type: 'sse';
  stream: GioEventStream;
}

/**
 * A route.ts Response whose body streams (protocol v3 chunk frames): the
 * head goes out first, then `prelude` - the bytes read while deciding to
 * stream - then the rest of the body as it is produced.
 */
export interface RouteStreamResult {
  type: 'route-stream';
  head: IPCResponse;
  prelude: Uint8Array[];
  /** The unread remainder; null when the prelude is the whole body. */
  rest: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    /** A read already in flight when the read-ahead stopped waiting. */
    pending: Promise<ReadableStreamReadResult<Uint8Array>> | null;
  } | null;
}

/**
 * Read-ahead budget for route.ts Response bodies: a body that is complete
 * within this many bytes, and without waiting on a later macrotask (a
 * string, a Buffer, JSON), crosses as one buffered response. Anything
 * longer - or still being produced - streams.
 */
export const ROUTE_BUFFER_LIMIT_BYTES = 1024 * 1024;

/**
 * Which route.ts Response bodies may stream: all of them (live IPC), only
 * event streams (onResponse plugins installed - they need buffered bodies,
 * but an event stream cannot be buffered), or none (static export).
 */
export type RouteBodyStreaming = 'all' | 'event-stream' | 'none';

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
   * 'mark' only: asked at the shell boundary with the shell's text (prefix
   * included). False withholds the shell_end frame, so Rust stores nothing:
   * React reported an error by then (a boundary it client-rendered may be
   * part of the shell bytes), or the shell holds Suspense content rendered
   * from this request's credentials.
   */
  keepShell?: (shell: string) => boolean;
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
   * forever. Any error React reported fails the render instead, and a
   * failed render is answered with the error itself, never an error.* page.
   */
  staticExport?: boolean;
  /**
   * Called with the request routing goes by: after plugin onRequest hooks
   * (which may rewrite its path) ran, right before matching. Not called
   * when a hook answers the request itself. The IPC server resolves Rust's
   * metrics `route` label from it.
   */
  onRouted?: (req: IPCRequest) => void;
  /** app/sitemap.*, app/robots.*, app/manifest.* (metadata-routes.ts). */
  metadataRoutes?: MetadataRoutes;
  /**
   * Each page's stylesheets (css-build.ts), rendered inside #__gio as React
   * stylesheet resources - hoisted into <head> - exactly as the client
   * entry renders them.
   */
  stylesheets?: StyleManifest;
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

/** Match a URL path against pattern-keyed entries (pages, handlers, wsHandlers). */
export function matchIn<T>(
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
 * precedence as renderRoute: an app metadata route (app/sitemap.* etc.,
 * labelled by its fixed path) first, then the more specific of the page and
 * route.ts matches, equal patterns being one folder's pair.
 */
export function resolveRoutePattern(
  path: string,
  routes: Map<string, RouteModule>,
  handlers?: Map<string, HandlerEntry>,
  metadataRoutes?: MetadataRoutes,
): string | null {
  const metadataKind = metadataRouteKindForPath(path);
  if (metadataKind !== null && metadataRoutes?.[metadataKind] !== undefined) return path;
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
    formData(): Promise<FormData> {
      return parseFormData(req.body, req.bodyBase64, req.headers['content-type']);
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
 * A view of `headers` that calls `onRead` whenever one of the `tracked`
 * names (lowercase) is read or probed, or the headers are enumerated at all.
 * Writes go through to `headers`.
 */
function trackHeaderReads(
  headers: Record<string, string>,
  tracked: ReadonlySet<string>,
  onRead: () => void,
): Record<string, string> {
  const isTracked = (key: string | symbol): boolean =>
    typeof key === 'string' && tracked.has(key.toLowerCase());
  return new Proxy(headers, {
    get(target, key, receiver) {
      if (isTracked(key)) onRead();
      return Reflect.get(target, key, receiver) as unknown;
    },
    has(target, key) {
      if (isTracked(key)) onRead();
      return Reflect.has(target, key);
    },
    getOwnPropertyDescriptor(target, key) {
      if (isTracked(key)) onRead();
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    // Every enumeration (spread, Object.keys, JSON.stringify, for...in,
    // getOwnPropertyNames) lists the keys first, and the list alone tells
    // whether credentials were sent - a read with or without them.
    ownKeys(target) {
      onRead();
      return Reflect.ownKeys(target);
    },
  });
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
  const headers = trackHeaderReads({ ...req.headers }, tracked, () => {
    read = true;
  });
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
 * Whether an onRequest hook pointed the request somewhere else: another
 * path, query or locale. Rust caches the render under the URL as requested.
 */
function pluginRewrote(before: IPCRequest, after: IPCRequest): boolean {
  if (before.path !== after.path || before.locale !== after.locale) return true;
  const beforeKeys = Object.keys(before.query);
  const afterKeys = Object.keys(after.query);
  return (
    beforeKeys.length !== afterKeys.length ||
    afterKeys.some(key => !Object.hasOwn(before.query, key) || before.query[key] !== after.query[key])
  );
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

/** DOCUMENT_PREFIX with the page's metadata tags (static HTML) in its <head>. */
function documentPrefix(metadataTags: readonly MetadataTag[]): string {
  const headTags = metadataTagsHtml(metadataTags);
  return headTags === '' ? DOCUMENT_PREFIX : DOCUMENT_PREFIX.replace('</head>', `${headTags}</head>`);
}

/** Closing document shell; its inline script carries the CSP nonce. */
function documentSuffix(): string {
  return `<script${nonceAttr()}>${OBSERVER_SCRIPT_BODY}</script></body></html>`;
}

function wrapWithDocument(inner: string, metadataTags: readonly MetadataTag[] = []): string {
  return `${documentPrefix(metadataTags)}${inner}${documentSuffix()}`;
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
  /** Route info: the client runtime provides the same navigation context. */
  params?: Record<string, string>;
  search?: string;
  locale?: string;
  /** The page's head tags, rendered at the same tree position on the client. */
  metadata?: MetadataTag[];
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
): Promise<IPCOutbound | SseRouteResult | StreamRenderResult | RouteStreamResult> {
  const result = await answerRoute(req, routes, layouts, registry, signal, clientScripts, extras);
  return isFormSubmission(req) ? asFormRedirect(result) : result;
}

/** renderRoute's answer before a GioForm submission's redirect is reshaped. */
async function answerRoute(
  req: IPCRequest,
  routes: Map<string, RouteModule>,
  layouts: Map<string, LayoutEntry>,
  registry: NodePluginRegistry | undefined,
  signal: AbortSignal | undefined,
  clientScripts: Map<string, string> | undefined,
  extras: RenderExtras | undefined,
): Promise<IPCOutbound | SseRouteResult | StreamRenderResult | RouteStreamResult> {
  const credentialHeaders = new Set([
    ...CREDENTIAL_HEADERS,
    ...CLIENT_ADDRESS_HEADERS,
    ...REQUEST_ORIGIN_HEADERS,
  ]);
  // An onRequest hook that read credentials and then rewrote the path,
  // query or locale picked this render per visitor - yet Rust stores it
  // under the URL as requested, for everyone.
  let pluginRewroteForVisitor = false;
  if (registry !== undefined && !registry.isEmpty) {
    // Snapshot first: plugins may mutate req.headers in place.
    const incomingHeaders = { ...req.headers };
    const incoming = req;
    let credentialsReadByPlugin = false;
    let trackingPlugin = true;
    const trackedHeaders = trackHeaderReads(req.headers, credentialHeaders, () => {
      if (trackingPlugin) credentialsReadByPlugin = true;
    });
    const intercepted = await registry.interceptRequest({ ...req, headers: trackedHeaders });
    trackingPlugin = false;
    if (isPluginResponse(intercepted)) {
      return intercepted;
    }
    // The tracking view stays with the plugins: framework reads are not theirs.
    req =
      intercepted.headers === trackedHeaders ? { ...intercepted, headers: req.headers } : intercepted;
    for (const name of pluginDerivedHeaders(incomingHeaders, req.headers)) {
      credentialHeaders.add(name);
    }
    pluginRewroteForVisitor = credentialsReadByPlugin && pluginRewrote(incoming, req);
  }

  extras?.onRouted?.(req);

  // ── app/sitemap.*, app/robots.*, app/manifest.* ───────────────────────────
  // Exact paths no page or route.ts can also claim (discovery rejects that).
  const metadataKind = metadataRouteKindForPath(req.path);
  const metadataRoute =
    metadataKind !== null ? extras?.metadataRoutes?.[metadataKind] : undefined;
  if (metadataRoute !== undefined) {
    let result = await renderMetadataRoute(req, metadataRoute);
    if (pluginRewroteForVisitor && result.cacheable) {
      warnPersonalRender(req.path, req.path, 'onRequest plugin');
      result = { ...result, cacheable: false, cacheMaxAge: 0 };
    }
    return registry !== undefined && !registry.isEmpty
      ? registry.interceptResponse(req, result)
      : result;
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
  // Set when a same-folder route.ts passes a method it does not export on to
  // the page: a 405 from the page names both files' methods.
  let siblingAllow: string[] = [];
  if (handlerMatch !== null && handlerVsPage <= 0) {
    // HEAD is served by the GET handler (body discarded by the client).
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    // A route.ts that failed to import answers every method (OPTIONS too)
    // with its 500 - it never lists methods it may not export in a 405.
    const loadError = handlerMatch.entry.loadError;
    const handler: RouteHandlerFn | undefined =
      loadError !== undefined
        ? () => {
            throw loadError;
          }
        : handlerMatch.entry.methods.get(method);
    if (handler !== undefined) {
      const bodyStreaming: RouteBodyStreaming =
        extras?.streaming !== true || process.env.GIO_EXPORT === '1'
          ? 'none'
          : registry !== undefined && registry.hasResponseInterceptors
            ? 'event-stream'
            : 'all';
      const result = await runRouteHandler(req, handler, handlerMatch.params, bodyStreaming);
      if (!isStreamingHandlerResult(result) && registry !== undefined && !registry.isEmpty) {
        return registry.interceptResponse(req, result);
      }
      return result;
    }
    // The route.ts owns this URL; only a sibling page (same pattern) may still
    // render a GET, or run its action for a POST, the route.ts does not
    // export - and answer anything else with a 405 that lists what the page
    // serves too. Without one, it is the route.ts's 405.
    if (handlerVsPage !== 0) {
      return methodNotAllowed(req, [...handlerMatch.entry.methods.keys()]);
    }
    siblingAllow = [...handlerMatch.entry.methods.keys()];
  }

  if (!match) {
    // Unmatched URLs belong to no folder: only app/not-found.* applies.
    return renderNotFound(req, {}, '', layouts, extras, signal);
  }

  // The headers of an action that ran and asked for a re-render (a session
  // cookie it committed): whatever answers in the end carries them - the
  // page, or the redirect, not-found or error page that replaces it.
  let actionHeaders: IpcHeaders | null = null;
  try {
    const pageModule = await match.module.load();

    // Pages answer GET/HEAD, and POST when they export an action, which runs
    // first - only a data result re-renders the page. Other mutations belong
    // to route.ts handlers.
    let action: RenderOutcome | null = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const pageAction = pageModule.action;
      if (req.method !== 'POST' || typeof pageAction !== 'function') {
        const allow = typeof pageAction === 'function' ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD'];
        return methodNotAllowed(req, [...allow, ...siblingAllow]);
      }
      const outcome = await runPageAction(req, pageAction, match.params);
      if (outcome.kind !== 'render') {
        if (registry !== undefined && !registry.isEmpty) {
          return registry.interceptResponse(req, outcome.response);
        }
        return outcome.response;
      }
      action = outcome;
      if (outcome.headers !== undefined) actionHeaders = flattenResponseHeaders(outcome.headers);
    }

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
    let gsspTags: unknown = undefined;
    let credentialsRead = (): boolean => false;
    if (pageModule.getServerSideProps) {
      const gssp = makeGsspContext(req, match.params, credentialHeaders);
      credentialsRead = gssp.credentialsRead;
      if (action !== null) gssp.ctx.actionData = action.data;
      const result = await pageModule.getServerSideProps(gssp.ctx);
      // redirect() from @gio.js/core, as in an action (a thrown one is
      // answered by the catch below).
      if (isActionRedirect(result)) {
        return withActionHeaders(redirectResponse(req, result), actionHeaders);
      }
      if (isRedirect(result)) {
        const extra = isHeaderRecord(result.headers)
          ? flattenResponseHeaders(result.headers)
          : { headers: {}, setCookies: [] };
        return withActionHeaders(
          {
            id: req.id,
            status: result.redirect.permanent ? 301 : 302,
            headers: { ...extra.headers, location: result.redirect.destination },
            body: '',
            cacheable: false,
            cacheMaxAge: 0,
            ...setCookiesField(extra.setCookies),
          },
          actionHeaders,
        );
      }
      if (isNotFoundResult(result)) {
        return withActionHeaders(
          await renderNotFound(req, match.params, match.module.dir, layouts, extras, signal),
          actionHeaders,
        );
      }
      if (!isRecord(result)) {
        throw new Error(
          `getServerSideProps for route "${match.module.urlPattern}" must return an object - ` +
            `{ props: {...} }, flat props, { redirect: {...} } or { notFound: true } - but returned ` +
            `${result === null ? 'null' : typeof result}`,
        );
      }
      // Support both { props: {...} } (Next.js convention) and flat { key: value }.
      // Response headers ({ props, headers }) and cache tags ({ props, tags })
      // are honored only alongside a props key, so flat objects that happen
      // to contain `headers` or `tags` still work.
      const nested = result['props'];
      if (isRecord(nested)) {
        props = nested;
        gsspTags = result['tags'];
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
    if (action !== null) {
      // getServerSideProps may have shaped the prop itself from ctx.actionData.
      if (!('actionData' in props)) props = { ...props, actionData: action.data };
      if (actionHeaders !== null) {
        gsspHeaders = {
          headers: { ...actionHeaders.headers, ...(gsspHeaders?.headers ?? {}) },
          setCookies: [...actionHeaders.setCookies, ...(gsspHeaders?.setCookies ?? [])],
        };
      }
    }

    // Head metadata (root layout → nested layouts → page), resolved before
    // the render so the tags are in the shell's <head>. generateMetadata gets
    // a context of its own, tracked like gSSP's but judged on its own: its
    // output lands in the head, which is part of a PPR shell too. Whether it
    // took the page's props is tracked as well: they carry whatever gSSP
    // read, credentials included.
    let metadataContext: ReturnType<typeof makeGsspContext> | undefined;
    let metadataUsedProps = false;
    const metadataTags = await resolveMetadataTags(
      layoutsForDir(match.module.dir, layouts),
      pageModule,
      () => (metadataContext ??= makeGsspContext(req, match.params, credentialHeaders)).ctx,
      () => {
        metadataUsedProps = true;
        return props;
      },
      match.module.urlPattern,
    );

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
    const loadingBoundaries = levels.filter(level => level.loading).length;

    const pattern = match.module.urlPattern;
    const navigation = navigationStateFor(req, pattern, match.params);
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
            params: navigation.params,
            search: navigation.search,
            locale: navigation.locale,
            ...(metadataTags.length > 0 ? { metadata: metadataTags } : {}),
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

    // An action's re-render answers one POST: never cached, and never stored
    // as the page's entry (Rust stores no non-GET response either).
    let cacheable = action === null && pageModule.revalidate !== undefined;
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
    // Rust stores them with the cached page (plus its path) for
    // revalidateTag() / revalidatePath() and POST /_gio/revalidate. Only
    // read for a render Rust will store: an uncached page's `tags` export
    // is its own business, not worth a warning.
    const cacheTagsField = (): { cacheTags?: string[] } => {
      const cacheTags = sanitizeCacheTags(
        [
          { source: 'export const tags', value: pageModule.tags },
          { source: 'getServerSideProps tags', value: gsspTags },
        ],
        match.module.urlPattern,
      );
      return cacheTags.length > 0 ? { cacheTags } : {};
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
    // Metadata that read credentials is personal even under PPR: it sits in
    // the <head>, i.e. inside the shell Rust would cache for everyone. So is
    // metadata built from the props of a gSSP that read them - PPR lets gSSP
    // read credentials because its props stream after the shell, but a
    // title made from them lands in it. (Without PPR, such a gSSP makes the
    // render personal below anyway.)
    const pprCandidate = pageModule.shell === 'cache' && streamingAvailable;
    const personalMetadata =
      metadataContext?.credentialsRead() === true
        ? 'generateMetadata'
        : pprCandidate && metadataUsedProps && credentialsRead()
          ? 'generateMetadata props'
          : null;
    // Neither the whole render nor a PPR shell may be stored for a URL a
    // plugin rewrote per visitor.
    const personalBefore: PersonalReadSource | null =
      personalMetadata ?? (pluginRewroteForVisitor ? 'onRequest plugin' : null);
    if (shareable && personalBefore !== null) {
      warnPersonalRender(pattern, req.path, personalBefore);
      cacheable = false;
      cacheMaxAge = 0;
      shareable = false;
    }
    const skipShell = req.skipShell === true;
    if (skipShell && pageCookies.setCookies !== undefined) {
      logger.warn(
        'getServerSideProps set cookies during a PPR holes render - the cached shell already sent its headers, so they are dropped',
        { path: req.path },
      );
    }
    if (pageModule.shell === 'cache' && !shareable && !skipShell && action === null) {
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
    // Whether the holes really stayed out of the shell is only known at the
    // shell boundary: keepShell below checks it.
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

    // Without a root layout no <head> exists in the tree to hoist into: the
    // tags go into the document prefix, and stay in the tree unrendered.
    let element: React.ReactNode = React.createElement(
      React.Fragment,
      null,
      React.createElement(
        'div',
        { id: '__gio' },
        // The client renders this same nesting: the runtime's withMetadata()
        // around the route entry's withStylesheets() (client-build.ts).
        withMetadata(
          withStylesheets(inner, extras?.stylesheets?.routes.get(pattern) ?? []),
          metadataTags,
          { render: rootLayoutEntry !== undefined },
        ),
      ),
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
    // Around the whole document: the hooks work in the server-only root
    // layout too, and the hydrated tree gets the same values from the envelope.
    element = withNavigation(navigation, element);

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

    // A root layout that hand-writes a <title> next to a metadata title
    // would put two in the head; the metadata one supersedes it.
    const keepTitle = rootLayoutEntry !== undefined ? metadataTitleHtml(metadataTags) : null;

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
          ...(storeShell ? { pprShell: true, ...cacheTagsField() } : {}),
          ...pageCookies,
        },
        stream:
          keepTitle !== null
            ? dedupeHeadTitlesStream(stream, keepTitle, () => warnDuplicateTitle(pattern))
            : stream,
        prefix: rootLayoutEntry !== undefined ? '' : documentPrefix(metadataTags),
        suffix: rootLayoutEntry !== undefined ? '' : documentSuffix(),
        ...(skipShell
          ? { shellBoundary: 'discard' as const }
          : pprShell
            ? { shellBoundary: 'mark' as const }
            : {}),
        // An error React reports between now and the shell boundary (work
        // it picks up before the first read) can still land in the shell.
        // So can a hole rendered from a credential-reading gSSP's props: one
        // that never suspended, or resolved before the boundary.
        ...(storeShell
          ? {
              keepShell: (shell: string) => {
                if (reported.length > 0) return false;
                if (!credentialsRead() || !shellHoldsRenderedHoles(shell, loadingBoundaries)) {
                  return true;
                }
                warnPersonalRender(pattern, req.path, 'ppr shell');
                return false;
              },
            }
          : {}),
        ...(deferEnvelope && envelopeJson !== null
          ? { envelope: envelopeScript(envelopeJson) }
          : {}),
      };
    }

    await stream.allReady;
    const html = withoutDuplicateTitles(await streamToString(stream), keepTitle, pattern);
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
    const body = rootLayoutEntry !== undefined ? html : wrapWithDocument(html, metadataTags);

    const ssrResponse: IPCOutbound = {
      id: req.id,
      status: action?.status ?? 200,
      headers: responseHeaders,
      body,
      cacheable,
      cacheMaxAge,
      ...(cacheable && cacheMaxAge > 0 ? cacheTagsField() : {}),
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
    // A redirect() thrown from getServerSideProps (or a helper it calls,
    // the way an action may throw one) is an answer, not a failure.
    if (isActionRedirect(err)) {
      return withActionHeaders(redirectResponse(req, err), actionHeaders);
    }
    if (isNotFoundError(err)) {
      return withActionHeaders(
        await renderNotFound(req, match.params, match.module.dir, layouts, extras, signal),
        actionHeaders,
      );
    }
    // Production responses carry only a generic message and the digest; the
    // details live in this log line under the same digest.
    const digest = reportedFailure?.digest ?? createErrorDigest();
    logger.error('ssr render failed', { path: req.path, digest, ...describeError(err) });
    const dev = isDevMode();
    const message = dev ? (err instanceof Error ? err.message : String(err)) : GENERIC_ERROR_MESSAGE;
    // The nearest error.* at or above the page's folder. One whose own
    // folder's layout is what threw fails to render again, so the walk
    // moves on up - an error.* never catches its own layout. A static
    // export reports the failure (with its digest) instead of writing an
    // error page in place of the page.
    const errorProps: GioErrorProps = { error: { message, digest } };
    const errorPage = await renderNearestSegmentPage(
      req,
      match.params,
      layouts,
      extras?.staticExport === true ? [] : segmentPageCandidates(match.module.dir, 'error', extras),
      errorProps,
      500,
      signal,
    );
    if (errorPage !== null) return withActionHeaders(errorPage, actionHeaders);
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

/**
 * What the navigation hooks see for this request. `pathname` is the routed
 * path Rust sent - after locale-prefix stripping and rewrites - the same one
 * the envelope carries.
 */
function navigationStateFor(
  req: IPCRequest,
  pattern: string,
  params: Record<string, string>,
): GioNavigationState {
  return { pathname: req.path, params, search: searchFromQuery(req.query), locale: req.locale, pattern };
}

/** The `#__gio_props` element as raw HTML (the deferred PPR envelope). */
function envelopeScript(envelopeJson: string): string {
  return `<script id="__gio_props" type="application/json">${envelopeJson}</script>`;
}

/**
 * What read credentials: gSSP, generateMetadata, generateMetadata via gSSP's
 * props, a credential-reading gSSP whose props rendered into a PPR shell, or
 * an onRequest plugin that rewrote the request after reading them.
 */
type PersonalReadSource =
  | 'getServerSideProps'
  | 'generateMetadata'
  | 'generateMetadata props'
  | 'ppr shell'
  | 'onRequest plugin';

/**
 * Whether a PPR shell holds Suspense content React already rendered from the
 * page: no pending boundary at all (`<!--$?-->` - the whole page flushed with
 * the shell), a hole segment that resolved before the shell boundary
 * (`id="S:..."`, completed by a `$RC` script), or more boundaries completed
 * inline (`<!--$-->`, they never suspended) than the route's loading.*
 * boundaries. Those wrap the whole page, so they complete inline whenever
 * the page renders without suspending - the PPR contract covers what the page
 * renders outside its holes - while a page's own hole that completed inline
 * always adds one more. A gSSP that read credentials hands its props to that
 * content, so it is this visitor's, not a fallback everyone may get. A false
 * positive only costs the shell its cache entry.
 */
function shellHoldsRenderedHoles(shell: string, loadingBoundaries: number): boolean {
  return (
    !shell.includes('<!--$?-->') ||
    /\sid="S:[0-9a-f]+"/.test(shell) ||
    shell.split('<!--$-->').length - 1 > loadingBoundaries
  );
}

/**
 * Explain once per route why a page exporting `revalidate` is not cached.
 * Each later render of the route stays uncacheable, just silently.
 */
function warnPersonalRender(
  pattern: string,
  path: string,
  source: PersonalReadSource = 'getServerSideProps',
): void {
  const key = `${source} ${pattern}`;
  if (warnedDynamicRoutes.has(key)) return;
  warnedDynamicRoutes.add(key);
  const credentials =
    'request credentials (ctx.cookies, ctx.ip, ctx.host, ctx.scheme, the cookie/authorization, ' +
    'a client-address or a host header, or a header an onRequest plugin set)';
  if (source === 'ppr shell') {
    logger.warn(
      `getServerSideProps read ${credentials} and the PPR shell holds content the page rendered ` +
        'from it - a Suspense hole that did not suspend (or resolved before the shell was sent), ' +
        'or a page with no pending hole at all - so this shell is not cached. Make the ' +
        'personalized holes suspend (use() a per-request promise), or remove `revalidate`',
      { route: pattern, path },
    );
    return;
  }
  if (source === 'onRequest plugin') {
    logger.warn(
      'an onRequest plugin read request credentials (the cookie/authorization, a client-address or ' +
        "a host header) and rewrote the request's path, query or locale - " +
        'the render answers a URL other than the one Rust caches it under, so it is not cached ' +
        'even though the page exports revalidate. Redirect instead of rewriting, or decide from ' +
        'non-credential headers',
      { route: pattern, path },
    );
    return;
  }
  logger.warn(
    source === 'generateMetadata props'
      ? `generateMetadata used the props of a getServerSideProps that read ${credentials} - ` +
          'the metadata is personalized and part of the <head>, i.e. of the PPR shell, so the ' +
          "shell is not cached even though the page exports revalidate + shell = 'cache'. " +
          'Derive metadata from ctx.params/ctx.query (not from the personalized props), or ' +
          'remove `revalidate`'
      : `${source} read ${credentials} - this render is personalized, so it is not cached even ` +
          'though the page exports revalidate. ' +
          (source === 'generateMetadata'
            ? 'Metadata is part of the <head> (and of a PPR shell): derive it from params/query ' +
              'only, or remove `revalidate`'
            : "Remove `revalidate`, or keep `revalidate` + `shell = 'cache'` and render the " +
              'personalized parts inside <Suspense> holes'),
    { route: pattern, path },
  );
}

// ── head metadata ─────────────────────────────────────────────────────────────

/** Routes already warned about a duplicate <title> (dev, once per route). */
const warnedDuplicateTitles = new Set<string>();

/**
 * Routes already warned about a metadata URL staying relative. Keyed by
 * route, not URL: generateMetadata can build URLs from request input
 * (`'/search?q=' + ctx.query.q`), and a per-URL set would grow - and log -
 * once per distinct request.
 */
const warnedRelativeMetadataRoutes = new Set<string>();

/**
 * Resolve the head tags for a page (or special page) rendered inside
 * `layoutEntries` (outermost first). `ctx` is created on first use - only a
 * generateMetadata export touches it - and `props` (the page's
 * generateMetadata `{ props }`) is read only when that function reads it.
 * `staticOnly` uses the `metadata` exports alone, never calling
 * generateMetadata. `route` names the route in warnings.
 */
async function resolveMetadataTags(
  layoutEntries: readonly LayoutEntry[],
  pageModule: MetadataModule,
  ctx: () => GsspContext,
  props: () => Record<string, unknown>,
  route: string,
  staticOnly = false,
): Promise<MetadataTag[]> {
  const layoutModules = await Promise.all(layoutEntries.map(entry => entry.load()));
  const modules: MetadataModule[] = [...layoutModules, pageModule].map(mod =>
    staticOnly ? { metadata: mod.metadata } : mod,
  );
  const pageExtras: MetadataExtras = {
    get props() {
      return props();
    },
  };
  const segments: Array<Metadata | undefined> = await Promise.all(
    modules.map((mod, index) =>
      segmentMetadata(mod, ctx, index === modules.length - 1 ? pageExtras : {}),
    ),
  );
  return metadataToTags(resolveMetadata(segments, process.env.GIO_SITE_URL), url => {
    if (warnedRelativeMetadataRoutes.has(route)) return;
    warnedRelativeMetadataRoutes.add(route);
    logger.warn(
      'metadata URL is relative and no metadataBase or GIO_SITE_URL is set - Open Graph, ' +
        'Twitter and canonical URLs must be absolute for crawlers',
      { route, url },
    );
  });
}

/**
 * A special page's head tags. Metadata never decides whether a 404/500 page
 * can render: when resolution fails - a generateMetadata that throws, often
 * the very failure the error page is answering (the CMS is down) - the
 * static `metadata` exports are used alone, and failing that no tags at all.
 */
async function resolveSpecialPageMetadataTags(
  req: IPCRequest,
  params: Record<string, string>,
  layoutEntries: readonly LayoutEntry[],
  pageModule: MetadataModule,
  props: Record<string, unknown>,
  route: string,
  status: number,
): Promise<MetadataTag[]> {
  // Never cached, so the context's credential tracking has nothing to decide.
  const ctx = (): GsspContext => makeGsspContext(req, params, new Set()).ctx;
  try {
    return await resolveMetadataTags(layoutEntries, pageModule, ctx, () => props, route);
  } catch (metadataError) {
    const fields = { path: req.path, status, route, ...describeError(metadataError) };
    const message = 'special page metadata failed - rendering it with the static metadata only';
    // notFound() from a layout's generateMetadata is what brought us to
    // its segment's not-found page in the first place.
    if (isNotFoundError(metadataError)) logger.debug(message, fields);
    else logger.error(message, fields);
  }
  try {
    return await resolveMetadataTags(layoutEntries, pageModule, ctx, () => props, route, true);
  } catch {
    return [];
  }
}

/** The <title> HTML React renders for the metadata title, or null without one. */
function metadataTitleHtml(tags: readonly MetadataTag[]): string | null {
  const title = tags.find(tag => tag.tag === 'title');
  return title !== undefined && title.tag === 'title' ? titleHtml(title.text) : null;
}

function warnDuplicateTitle(pattern: string): void {
  if (!isDevMode() || warnedDuplicateTitles.has(pattern)) return;
  warnedDuplicateTitles.add(pattern);
  logger.warn(
    'a layout or page renders its own <title> next to a metadata title - the server HTML ' +
      '(what crawlers and link previews read) keeps only the metadata title, while React mounts ' +
      'a <title> a page or nested layout renders again once the page hydrates. Set the title ' +
      'through `export const metadata = { title }` or generateMetadata instead',
    { route: pattern },
  );
}

/** Buffered counterpart of dedupeHeadTitlesStream. */
function withoutDuplicateTitles(html: string, keepTitle: string | null, pattern: string): string {
  if (keepTitle === null) return html;
  const result = dedupeHeadTitles(html, keepTitle);
  if (result.dropped > 0) warnDuplicateTitle(pattern);
  return result.html;
}

// ── route.ts handler dispatch ─────────────────────────────────────────────────

/** SSE and streamed bodies bypass onResponse plugins: there is no body to hand them. */
function isStreamingHandlerResult(
  value: IPCResponse | SseRouteResult | RouteStreamResult,
): value is SseRouteResult | RouteStreamResult {
  return 'type' in value && (value.type === 'sse' || value.type === 'route-stream');
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

const MACROTASK: unique symbol = Symbol('macrotask');

function nextMacrotask(): Promise<typeof MACROTASK> {
  return new Promise(resolve => setImmediate(() => resolve(MACROTASK)));
}

/**
 * A body chunk as bytes. Strings are accepted (UTF-8) - enqueueing text into
 * a ReadableStream is the common way to write an event stream by hand.
 */
export function routeChunkBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new TypeError('route.ts Response body chunks must be Uint8Array or string');
}

interface ReadAhead {
  complete: boolean;
  chunks: Uint8Array[];
  reader: ReadableStreamDefaultReader<Uint8Array>;
  pending: Promise<ReadableStreamReadResult<Uint8Array>> | null;
}

/**
 * Read a body until it ends, exceeds ROUTE_BUFFER_LIMIT_BYTES, or makes the
 * reader wait past a macrotask tick (already-available bytes settle in
 * microtasks; a producer still working does not). A read still in flight is
 * handed on so no chunk is lost.
 */
async function readAhead(body: ReadableStream<Uint8Array>): Promise<ReadAhead> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size <= ROUTE_BUFFER_LIMIT_BYTES) {
    const pending = reader.read();
    const raced = await Promise.race([pending, nextMacrotask()]);
    if (raced === MACROTASK) return { complete: false, chunks, reader, pending };
    if (raced.done) return { complete: true, chunks, reader, pending: null };
    const bytes = routeChunkBytes(raced.value);
    chunks.push(bytes);
    size += bytes.byteLength;
  }
  return { complete: false, chunks, reader, pending: null };
}

function bufferedBody(raw: Buffer): Pick<IPCResponse, 'body' | 'bodyBase64'> {
  // Non-UTF-8 bodies cross base64-encoded like request bodies do; a text
  // decode would lossily transcode binary payloads to U+FFFD.
  return isUtf8(raw) ? { body: raw.toString('utf8') } : { body: raw.toString('base64'), bodyBase64: true };
}

/**
 * Convert a route.ts web Response. Small, complete bodies stay buffered;
 * bodies still being produced (a ReadableStream feeding an LLM token stream,
 * an event stream, a large download) stream as chunk frames. An event-stream
 * body always streams - Rust never buffers it - even when it is complete.
 */
async function routeResponseToIpc(
  req: IPCRequest,
  res: Response,
  bodyStreaming: RouteBodyStreaming,
): Promise<IPCResponse | RouteStreamResult> {
  const base = { id: req.id, status: res.status, cacheable: false, cacheMaxAge: 0, routeHandler: true };
  const { headers, setCookies } = webHeadersToIpc(res.headers);
  headers['content-type'] ??= 'text/plain; charset=utf-8';
  const cookies = setCookiesField(setCookies);
  const eventStream = headers['content-type'].toLowerCase().startsWith('text/event-stream');
  const mayStream = bodyStreaming === 'all' || (bodyStreaming === 'event-stream' && eventStream);
  if (!mayStream) {
    return { ...base, headers, ...bufferedBody(Buffer.from(await res.arrayBuffer())), ...cookies };
  }
  if (res.body === null) {
    // A buffered empty event stream is exactly what a GioEventStream head
    // looks like to Rust, which would then wait for sse_chunk frames.
    if (!eventStream || req.method === 'HEAD') return { ...base, headers, body: '', ...cookies };
    return {
      type: 'route-stream',
      head: { ...base, headers, body: '', streaming: true, routeStream: true, ...cookies },
      prelude: [],
      rest: null,
    };
  }

  const ahead = await readAhead(res.body);
  if (ahead.complete && (!eventStream || req.method === 'HEAD')) {
    return { ...base, headers, ...bufferedBody(Buffer.concat(ahead.chunks)), ...cookies };
  }
  if (req.method === 'HEAD') {
    // The client discards a HEAD body: stop the producer instead of
    // streaming it nowhere.
    ahead.reader.cancel().catch(() => undefined);
    return { ...base, headers, body: '', ...cookies };
  }
  return {
    type: 'route-stream',
    head: { ...base, headers, body: '', streaming: true, routeStream: true, ...cookies },
    prelude: ahead.chunks,
    rest: ahead.complete ? null : { reader: ahead.reader, pending: ahead.pending },
  };
}

/**
 * Invoke a route.ts method handler. The result contract:
 * `GioEventStream` → SSE; web `Response` → converted (its body streamed
 * when it is still being produced, see routeResponseToIpc); null/undefined
 * → 204; anything else → JSON 200; notFound() → JSON 404. Handler responses
 * are never cacheable, and are flagged `routeHandler` so Rust leaves their
 * Cache-Control to the app.
 */
async function runRouteHandler(
  req: IPCRequest,
  handler: (gioReq: GioRequest) => unknown,
  params: Record<string, string>,
  bodyStreaming: RouteBodyStreaming = 'none',
): Promise<IPCResponse | SseRouteResult | RouteStreamResult> {
  const base = { id: req.id, cacheable: false, cacheMaxAge: 0, routeHandler: true };
  try {
    const result = await handler(makeGioRequest(req, params));

    if (isGioEventStream(result)) {
      return { type: 'sse', stream: result };
    }
    if (result instanceof Response) {
      return await routeResponseToIpc(req, result, bodyStreaming);
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
    const clientError = requestBodyErrorResponse(err);
    if (clientError !== null) return { ...base, ...clientError };
    const digest = createErrorDigest();
    // A route.ts that threw while it was imported (ws-router.ts): the log
    // names the file, and dev shows the import error in the response too.
    const loadFailure = err instanceof RouteLoadError ? err : null;
    logger.error(loadFailure !== null ? 'route file failed to load' : 'route handler failed', {
      path: req.path,
      method: req.method,
      digest,
      ...(loadFailure !== null ? { filePath: loadFailure.file } : {}),
      ...describeError(loadFailure !== null ? loadFailure.cause : err),
    });
    const message = loadFailure !== null && isDevMode() ? loadFailure.message : GENERIC_ERROR_MESSAGE;
    return {
      ...base,
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: message, digest }),
    };
  }
}

/**
 * A web Response as a never-cached IPC response (route.ts handlers, and a
 * page action answering with its own Response). Flagged `routeHandler`: the
 * app owns its Cache-Control.
 */
async function webResponseToIpc(req: IPCRequest, result: Response): Promise<IPCResponse> {
  const base = { id: req.id, cacheable: false, cacheMaxAge: 0, routeHandler: true };
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

/**
 * The answer to a body the request declared wrongly (json() on a form,
 * formData() on JSON: 415) or that does not parse (400) - a client error,
 * so nothing is logged or hidden. Null for any other error.
 */
function requestBodyErrorResponse(
  err: unknown,
): Pick<IPCResponse, 'status' | 'headers' | 'body'> | null {
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (isUnsupportedMediaTypeError(err)) {
    return {
      status: 415,
      headers,
      body: JSON.stringify({ error: 'Unsupported Media Type', message: err.message }),
    };
  }
  if (isMalformedBodyError(err)) {
    return { status: 400, headers, body: JSON.stringify({ error: 'Bad Request', message: err.message }) };
  }
  return null;
}

// ── page actions ──────────────────────────────────────────────────────────────

type RenderOutcome = Extract<ActionOutcome, { kind: 'render' }>;

/**
 * Run a page's action for a POST: either the page re-renders with its data,
 * or `response` is the whole answer (the action's Response or redirect, or
 * the 415/400 of a body error). A thrown redirect() answers like a returned
 * one. A thrown notFound() and every other error propagate to renderRoute's
 * catch, so the nearest not-found.* / error.* page answers, as for a failed
 * render. Nothing here is ever cached.
 */
async function runPageAction(
  req: IPCRequest,
  action: PageAction,
  params: Record<string, string>,
): Promise<RenderOutcome | { kind: 'answer'; response: IPCResponse }> {
  const base = { id: req.id, cacheable: false, cacheMaxAge: 0 };
  let result: unknown;
  try {
    result = await action(makeGioRequest(req, params));
  } catch (err) {
    const clientError = requestBodyErrorResponse(err);
    if (clientError !== null) return { kind: 'answer', response: { ...base, ...clientError } };
    if (!isActionRedirect(err)) throw err;
    result = err;
  }
  const outcome = actionOutcome(result);
  if (outcome.kind === 'response') {
    return { kind: 'answer', response: await webResponseToIpc(req, outcome.response) };
  }
  const headers = outcome.kind === 'render' ? outcome.headers : outcome.redirect.headers;
  if (headers !== undefined && !isHeaderRecord(headers)) {
    throw new TypeError('action headers must map header names to strings or string arrays');
  }
  if (outcome.kind === 'render') return outcome;
  return { kind: 'answer', response: redirectResponse(req, outcome.redirect) };
}

/**
 * The answer to a redirect() - from an action, or from getServerSideProps -
 * with the headers it was given. Never cached.
 */
function redirectResponse(req: IPCRequest, redirect: ActionRedirect): IPCResponse {
  const extra = isHeaderRecord(redirect.headers)
    ? flattenResponseHeaders(redirect.headers)
    : { headers: {}, setCookies: [] };
  return {
    id: req.id,
    status: redirect.status,
    headers: { ...extra.headers, location: redirect.location },
    body: '',
    cacheable: false,
    cacheMaxAge: 0,
    ...setCookiesField(extra.setCookies),
  };
}

/**
 * `response` with the headers of the action that ran before it merged in:
 * the response's own win a clash, cookies add up. Unchanged without any.
 */
function withActionHeaders(response: IPCResponse, action: IpcHeaders | null): IPCResponse {
  if (action === null) return response;
  return {
    ...response,
    headers: { ...action.headers, ...response.headers },
    ...setCookiesField([...action.setCookies, ...(response.setCookies ?? [])]),
  };
}

// ── GioForm redirects ─────────────────────────────────────────────────────────

/** The request header GioForm marks its submissions with (giojs-react navigation.ts). */
const FORM_SUBMISSION_HEADER = 'x-gio-form';
/** Where the redirect answering a GioForm submission names its target. */
const FORM_REDIRECT_HEADER = 'x-gio-redirect';
/** Redirects a browser follows with a GET; a 307/308 repeats the POST, which fetch does itself. */
const SEE_OTHER_STATUSES: ReadonlySet<number> = new Set([301, 302, 303]);

function isFormSubmission(req: IPCRequest): boolean {
  return req.method === 'POST' && req.headers[FORM_SUBMISSION_HEADER] === '1';
}

/**
 * A redirect answering a GioForm submission - from an action, its page's
 * getServerSideProps, a route.ts handler or a plugin - becomes a 204 naming
 * the target in x-gio-redirect, its cookies and other headers kept. fetch
 * would follow a 3xx itself, and one leading off-site (a payment page, a
 * sign-in) fails the CORS check after the action has already run. Told
 * where to go, the client router fetches a same-origin target and hands any
 * other to the browser. A POST answer is never stored, here or in a cache.
 */
function asFormRedirect(
  result: IPCOutbound | SseRouteResult | StreamRenderResult | RouteStreamResult,
): IPCOutbound | SseRouteResult | StreamRenderResult | RouteStreamResult {
  if (!('status' in result) || !SEE_OTHER_STATUSES.has(result.status)) return result;
  const headers: Record<string, string> = {};
  let location: string | undefined;
  for (const [name, value] of Object.entries(result.headers)) {
    const lower = name.toLowerCase();
    if (lower === 'location') location = value;
    // The redirect's body (if any) is not sent.
    else if (lower !== 'content-type' && lower !== 'content-length') headers[name] = value;
  }
  if (location === undefined) return result;
  headers[FORM_REDIRECT_HEADER] = location;
  const answer: IPCResponse = { ...result, status: 204, headers, body: '' };
  delete answer.bodyBase64;
  return answer;
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
      ...(level.params.length > 0 ? { params: level.params } : {}),
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
  /** Its stylesheets (root layout's included), from RenderExtras.stylesheets. */
  stylesheets: readonly string[];
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
  const stylesheets = (fileDir: string): readonly string[] =>
    extras?.stylesheets?.segmentPages.get(segmentStylesheetKey(kind, fileDir)) ?? [];
  const candidates: SegmentPageCandidate[] =
    files !== undefined
      ? nearestSegmentFiles(dir, files).map(file => ({
          dir: file.dir,
          load: file.load,
          stylesheets: stylesheets(file.dir),
        }))
      : [];
  const rootFallback = extras?.specialPages?.[kind];
  if (rootFallback !== undefined && !candidates.some(c => c.dir === '')) {
    candidates.push({ dir: '', load: rootFallback, stylesheets: stylesheets('') });
  }
  return candidates;
}

/**
 * 404 for a page in `dir`: the nearest not-found.* at or above it, inside
 * the layouts of that file's folder, else the built-in page. Never cached:
 * a 404 can depend on anything getServerSideProps read (credentials
 * included), and a cached 404 would also outlive the content appearing.
 * `params` are the matched route's (none for an unmatched URL).
 */
async function renderNotFound(
  req: IPCRequest,
  params: Record<string, string>,
  dir: string,
  layouts: Map<string, LayoutEntry>,
  extras: RenderExtras | undefined,
  signal: AbortSignal | undefined,
): Promise<IPCResponse> {
  const page = await renderNearestSegmentPage(
    req,
    params,
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
  params: Record<string, string>,
  layouts: Map<string, LayoutEntry>,
  candidates: readonly SegmentPageCandidate[],
  props: object,
  status: number,
  signal?: AbortSignal,
): Promise<IPCResponse | null> {
  for (const candidate of candidates) {
    const page = await renderSpecialPage(req, params, layouts, candidate, props, status, signal);
    if (page !== null) return page;
  }
  return null;
}

/**
 * Render a special page (404/500) through the normal layout pipeline,
 * server-only (no hydration envelope). Returns null when its render fails -
 * callers try the next candidate, then the built-in plain response.
 * `params` are those of the route that failed or was not found: its
 * layouts' generateMetadata reads them as on the page itself.
 */
async function renderSpecialPage(
  req: IPCRequest,
  params: Record<string, string>,
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

    // The same head metadata a page gets (see resolveSpecialPageMetadataTags
    // for what happens when it fails). Warnings name the file, never the
    // request path: every unmatched URL renders the same not-found page.
    const fileName = status === 404 ? 'not-found' : 'error';
    const route = candidate.dir === '' ? `/${fileName}` : `/${candidate.dir}/${fileName}`;
    const metadataTags = await resolveSpecialPageMetadataTags(
      req,
      params,
      applicableLayouts,
      pageModule as MetadataModule,
      props as Record<string, unknown>,
      route,
      status,
    );

    let inner: React.ReactNode = React.createElement(
      pageModule.default,
      props as Record<string, unknown>,
    );
    for (const layoutEntry of [...innerLayouts].reverse()) {
      const layoutMod = await layoutEntry.load();
      inner = React.createElement(layoutMod.default, { children: inner, path: req.path });
    }
    let element: React.ReactNode = React.createElement(
      'div',
      { id: '__gio' },
      withMetadata(withStylesheets(inner, candidate.stylesheets), metadataTags, {
        render: rootLayoutEntry !== undefined,
      }),
    );
    if (rootLayoutEntry !== undefined) {
      const rootLayoutMod = await rootLayoutEntry.load();
      element = React.createElement(rootLayoutMod.default, {
        children: element,
        path: req.path,
      });
    }
    // Not a route match, so no pattern. The params are those of the route
    // that failed or was not found ({} for an unmatched URL) - the same ones
    // its layouts' generateMetadata read above.
    element = withNavigation(navigationStateFor(req, '', params), element);

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
    const keepTitle = rootLayoutEntry !== undefined ? metadataTitleHtml(metadataTags) : null;
    const html = withoutDuplicateTitles(await streamToString(stream), keepTitle, route);
    return {
      id: req.id,
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: rootLayoutEntry !== undefined ? html : wrapWithDocument(html, metadataTags),
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
