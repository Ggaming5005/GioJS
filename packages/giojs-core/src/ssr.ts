/**
 * giojs-core/src/ssr.ts
 *
 * Renders matched routes to HTML. Applies layout.tsx wrappers outermost-first,
 * detects getServerSideProps redirect returns, and maps revalidate semantics to
 * the cache fields Rust reads (revalidate=false → one-year TTL, not 0).
 * Also handles GET() exports that return GioEventStream (SSE routes).
 */
import React from 'react';
import { renderToReadableStream } from 'react-dom/server';
import type { IPCRequest, IPCOutbound, IPCResponse, GioRequest } from './context.ts';
import type {
  RouteModule,
  LayoutEntry,
  RedirectResult,
  HandlerEntry,
  GsspContext,
  SpecialPages,
  PageModule,
} from './router.ts';
import { GioEventStream, isGioEventStream } from './sse.ts';
import type { NodePluginRegistry } from './plugin.ts';
import { logger } from './logger.ts';

export interface SseRouteResult {
  type: 'sse';
  stream: GioEventStream;
}

/** Optional render inputs beyond pages/layouts. */
export interface RenderExtras {
  /** route.ts method handlers (API routes + SSE). */
  handlers?: Map<string, HandlerEntry>;
  /** app/not-found.* and app/error.* */
  specialPages?: SpecialPages;
}

const DEV = process.env.NODE_ENV !== 'production';

/** Match a URL path against pattern-keyed entries (mirrors the Rust trie logic). */
function matchIn<T>(
  path: string,
  entries: Map<string, T>,
): { entry: T; pattern: string; params: Record<string, string> } | null {
  // Exact match first
  const exact = entries.get(path);
  if (exact !== undefined) return { entry: exact, pattern: path, params: {} };

  // Among all matching patterns, pick the most specific one. This makes the
  // result independent of Map insertion order and mirrors the Rust trie's
  // precedence: literal > dynamic (:param) > catch-all (*rest), left to right.
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

/** Parse a Cookie header into name → value (first occurrence wins). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined || header === '') return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== '' && cookies[name] === undefined) {
      cookies[name] = part.slice(eq + 1).trim();
    }
  }
  return cookies;
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
      if (req.body === null) throw new Error('request has no body');
      if (req.bodyBase64) throw new Error('request body is binary (base64) — decode it manually');
      return JSON.parse(req.body) as T;
    },
    locale: req.locale,
  };
}

/** Rank a single segment: literal (2) > dynamic (1) > catch-all (0). */
function segmentRank(seg: string | undefined): number {
  if (seg === undefined) return -1;
  if (seg.startsWith('*')) return 0;
  if (seg.startsWith(':')) return 1;
  return 2;
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
  // Same shape: more concrete segments (longer) wins.
  return bSegs.length - aSegs.length;
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const patParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);

  const params: Record<string, string> = {};
  let pi = 0;

  for (let i = 0; i < patParts.length; i++) {
    const seg = patParts[i];

    if (seg === undefined) return null;

    if (seg.startsWith('*')) {
      params[seg.slice(1)] = pathParts.slice(pi).join('/');
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
const OBSERVER_SCRIPT = `<script>(function(){var o=new IntersectionObserver(function(e){e.forEach(function(e){if(e.isIntersecting){e.target.dataset.gioAnimateState='entered';o.unobserve(e.target);}});},{threshold:0.1});document.querySelectorAll('[data-gio-animate]').forEach(function(el){o.observe(el);});})();</script>`;

/**
 * Default 404 document, served when no `app/not-found.*` exists. Also written
 * to `out/404.html` on static export, so every deployed site returns a real
 * 404 for unknown paths by default (add app/not-found.* to customize it).
 */
export const BUILTIN_404_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>404 — Page not found</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0a09;color:#e7e5e4;font-family:system-ui,-apple-system,sans-serif}main{text-align:center;padding:2rem}p.code{font-family:ui-monospace,monospace;font-size:.8rem;letter-spacing:.2em;opacity:.55;margin:0 0 .6rem}h1{font-size:2rem;margin:0 0 .6rem;font-weight:650}p.hint{opacity:.7;margin:0 0 1.5rem}a{color:#0b0a09;background:#e7e5e4;text-decoration:none;padding:.55rem 1.1rem;border-radius:999px;font-weight:600;font-size:.9rem}</style></head><body><main><p class="code">HTTP 404</p><h1>Page not found</h1><p class="hint">This page doesn't exist or was moved.</p><a href="/">Go home</a></main></body></html>`;

function wrapWithDocument(inner: string): string {
  // The #__gio boundary and bootstrap module scripts are rendered by React
  // (they must exist identically in the client element tree), so this shell
  // only supplies the document skeleton a missing root layout would provide.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${inner}${OBSERVER_SCRIPT}</body></html>`;
}

/**
 * Serialize the hydration envelope for the `#__gio_props` JSON script.
 * `<` is escaped so props containing `</script>` (or `<!--`) can never
 * terminate the script element early — the classic serialization XSS.
 * Returns null when props are not JSON-serializable; the page then renders
 * server-only instead of hydrating with wrong data.
 */
export function serializeEnvelope(envelope: {
  props: Record<string, unknown>;
  path: string;
  pattern: string;
  entry: string;
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

/** Returns layouts sorted outermost-first (root "/" first, then by prefix length). */
function findApplicableLayouts(path: string, layouts: Map<string, LayoutEntry>): LayoutEntry[] {
  return [...layouts.values()]
    .filter(l => {
      if (l.urlPrefix === '/') return true;
      return path === l.urlPrefix || path.startsWith(l.urlPrefix + '/');
    })
    .sort((a, b) => a.urlPrefix.length - b.urlPrefix.length);
}

function isRedirect(result: unknown): result is RedirectResult {
  return typeof result === 'object' && result !== null && 'redirect' in result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(v => typeof v === 'string');
}

function isIPCResponse(value: IPCOutbound): value is IPCResponse {
  return 'status' in value;
}

/** Plugins are user code — verify the shape at runtime, not just via types. */
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
): Promise<IPCOutbound | SseRouteResult> {
  if (registry !== undefined && !registry.isEmpty) {
    const intercepted = await registry.interceptRequest(req);
    if (isPluginResponse(intercepted)) {
      return intercepted;
    }
    req = intercepted;
  }

  // ── route.ts method handlers (API routes + SSE) ───────────────────────────
  const handlerMatch =
    extras?.handlers !== undefined ? matchIn(req.path, extras.handlers) : null;
  if (handlerMatch !== null) {
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
    // A handler file owns this path for its exported methods; a GET without a
    // GET handler may still be a page render. Anything else is a 405.
    const pageExists = matchRoute(req.path, routes) !== null;
    if (!((req.method === 'GET' || req.method === 'HEAD') && pageExists)) {
      return methodNotAllowed(req, [...handlerMatch.entry.methods.keys()]);
    }
  }

  const match = matchRoute(req.path, routes);

  if (!match) {
    const notFound = await renderSpecialPage(req, layouts, extras?.specialPages?.notFound, {}, 404, signal);
    return notFound ?? {
      id: req.id,
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: BUILTIN_404_HTML,
      cacheable: false,
      cacheMaxAge: 0,
    };
  }

  // Pages only answer GET/HEAD; mutations belong to route.ts handlers.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return methodNotAllowed(req, ['GET', 'HEAD']);
  }

  try {
    const pageModule = await match.module.load();

    // Legacy SSE shape — a page module exporting GET(req) → GioEventStream.
    // route.ts handlers are the supported home for SSE; this stays for
    // back-compat.
    if (pageModule.GET !== undefined) {
      const result = pageModule.GET(makeGioRequest(req, match.params));
      if (isGioEventStream(result)) {
        return { type: 'sse', stream: result };
      }
    }

    const Component = pageModule.default;

    let props: Record<string, unknown> = {};
    let gsspHeaders: Record<string, string> | null = null;
    if (pageModule.getServerSideProps) {
      const ctx: GsspContext = {
        method: req.method,
        path: req.path,
        params: match.params,
        query: req.query,
        headers: req.headers,
        cookies: parseCookies(req.headers['cookie']),
        ...(req.locale !== '' ? { locale: req.locale } : {}),
      };
      const result = await pageModule.getServerSideProps(ctx);
      if (isRedirect(result)) {
        return {
          id: req.id,
          status: result.redirect.permanent ? 301 : 302,
          headers: { location: result.redirect.destination },
          body: '',
          cacheable: false,
          cacheMaxAge: 0,
        };
      }
      // Support both { props: {...} } (Next.js convention) and flat { key: value }.
      // Response headers ({ props, headers }) are honored only alongside a
      // props key, so flat objects that happen to contain `headers` still work.
      const nested = result['props'];
      if (isRecord(nested)) {
        props = nested;
        const returnedHeaders = result['headers'];
        if (isStringRecord(returnedHeaders) && Object.keys(returnedHeaders).length > 0) {
          gsspHeaders = returnedHeaders;
        }
      } else {
        props = result;
      }
    } else {
      props = { params: match.params, searchParams: req.query };
    }

    // Build the hydration boundary: page wrapped by non-root layouts inside
    // <div id="__gio">, with the envelope script as a sibling. The client
    // bundle hydrates exactly this div; the root layout (and everything Rust
    // injects into the document later) stays server-only HTML, so post-render
    // head/body injection can never cause a hydration mismatch.
    const applicableLayouts = findApplicableLayouts(req.path, layouts);
    const rootLayoutEntry = applicableLayouts.find(l => l.urlPrefix === '/');
    const innerLayouts = applicableLayouts.filter(l => l.urlPrefix !== '/');

    let inner: React.ReactNode = React.createElement(Component, props);
    for (const layoutEntry of [...innerLayouts].reverse()) {
      const layoutMod = await layoutEntry.load();
      const Layout = layoutMod.default;
      inner = React.createElement(Layout, { children: inner, path: req.path });
    }

    const pattern = match.module.urlPattern;
    const entryScript =
      process.env.GIO_EXPORT === '1' ? undefined : clientScripts?.get(pattern);
    const envelopeJson =
      entryScript !== undefined
        ? serializeEnvelope({ props, path: req.path, pattern, entry: entryScript })
        : null;
    if (entryScript !== undefined && envelopeJson === null) {
      logger.warn('props are not JSON-serializable — page will render without hydration', {
        path: req.path,
      });
    }

    let element: React.ReactNode = React.createElement(
      React.Fragment,
      null,
      React.createElement('div', { id: '__gio' }, inner),
      envelopeJson !== null
        ? React.createElement('script', {
            id: '__gio_props',
            type: 'application/json',
            dangerouslySetInnerHTML: { __html: envelopeJson },
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

    const stream = await renderToReadableStream(element, {
      bootstrapModules: envelopeJson !== null && entryScript !== undefined ? [entryScript] : [],
      // Cancelled requests (client disconnect / Rust timeout) abort the React
      // render instead of finishing output nobody will read.
      ...(signal !== undefined ? { signal } : {}),
      onError(streamError) {
        logger.error('ssr stream error', {
          path: req.path,
          error: streamError instanceof Error ? streamError.message : String(streamError),
        });
      },
    });

    await stream.allReady;
    const html = await streamToString(stream);

    // Root layout provides <html>/<body>, so skip the document wrapper.
    const body = rootLayoutEntry !== undefined ? html : wrapWithDocument(html);

    let cacheable = pageModule.revalidate !== undefined;
    if (gsspHeaders !== null && cacheable) {
      // Response headers from gSSP are per-request (set-cookie above all);
      // caching them would replay one user's headers to everyone.
      logger.warn('getServerSideProps returned headers — page made uncacheable', {
        path: req.path,
      });
      cacheable = false;
    }

    const ssrResponse: IPCOutbound = {
      id: req.id,
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...(gsspHeaders ?? {}) },
      body,
      cacheable,
      // revalidate=false means "cache forever"; false??0 would coerce to 0 so check explicitly.
      cacheMaxAge: !cacheable
        ? 0
        : pageModule.revalidate === false
          ? 31536000
          : (pageModule.revalidate ?? 0),
    };

    if (registry !== undefined && !registry.isEmpty && isIPCResponse(ssrResponse)) {
      return registry.interceptResponse(req, ssrResponse);
    }
    return ssrResponse;
  } catch (err) {
    logger.error('ssr render failed', {
      path: req.path,
      error: err instanceof Error ? err.message : String(err),
    });
    const errorPage = await renderSpecialPage(
      req,
      layouts,
      extras?.specialPages?.error,
      { error: { message: err instanceof Error ? err.message : String(err) } },
      500,
      signal,
    );
    if (errorPage !== null) return errorPage;
    return {
      id: req.id,
      error: true,
      code: 'RENDER_ERROR',
      message: err instanceof Error ? err.message : String(err),
      ...(DEV && err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
    };
  }
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
 * anything else → JSON 200. Handler responses are never cacheable.
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
      const headers: Record<string, string> = {};
      result.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      headers['content-type'] ??= 'text/plain; charset=utf-8';
      return { ...base, status: result.status, headers, body: await result.text() };
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
    logger.error('route handler failed', {
      path: req.path,
      method: req.method,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ...base,
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Internal Server Error' }),
    };
  }
}

// ── special pages (app/not-found.*, app/error.*) ──────────────────────────────

/**
 * Render a special page (404/500) through the normal layout pipeline,
 * server-only (no hydration envelope). Returns null when the page is absent
 * or its render fails — callers fall back to the built-in plain response.
 */
async function renderSpecialPage(
  req: IPCRequest,
  layouts: Map<string, LayoutEntry>,
  load: (() => Promise<PageModule>) | undefined,
  props: Record<string, unknown>,
  status: number,
  signal?: AbortSignal,
): Promise<IPCResponse | null> {
  if (load === undefined) return null;
  try {
    const pageModule = await load();
    const applicableLayouts = findApplicableLayouts(req.path, layouts);
    const rootLayoutEntry = applicableLayouts.find(l => l.urlPrefix === '/');
    const innerLayouts = applicableLayouts.filter(l => l.urlPrefix !== '/');

    let inner: React.ReactNode = React.createElement(pageModule.default, props);
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
    logger.error('special page render failed — falling back to built-in response', {
      path: req.path,
      status,
      error: specialError instanceof Error ? specialError.message : String(specialError),
    });
    return null;
  }
}
