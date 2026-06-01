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
import type { IPCRequest, IPCOutbound, IPCResponse } from './context.ts';
import type { RouteModule, LayoutEntry, RedirectResult } from './router.ts';
import { GioEventStream } from './sse.ts';
import type { NodePluginRegistry } from './plugin.ts';

export interface SseRouteResult {
  type: 'sse';
  stream: GioEventStream;
}

const DEV = process.env.NODE_ENV !== 'production';

/** Match a URL path against a route pattern (mirrors the Rust trie logic). */
function matchRoute(
  path: string,
  routes: Map<string, RouteModule>,
): { module: RouteModule; params: Record<string, string> } | null {
  // Exact match first
  if (routes.has(path)) return { module: routes.get(path)!, params: {} };

  // Among all matching patterns, pick the most specific one. This makes the
  // result independent of Map insertion order and mirrors the Rust trie's
  // precedence: literal > dynamic (:param) > catch-all (*rest), left to right.
  let best: { module: RouteModule; params: Record<string, string> } | null = null;
  let bestPattern: string | null = null;
  for (const [pattern, mod] of routes) {
    const params = matchPattern(pattern, path);
    if (params === null) continue;
    if (bestPattern === null || compareSpecificity(pattern, bestPattern) < 0) {
      best = { module: mod, params };
      bestPattern = pattern;
    }
  }
  return best;
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

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function wrapWithDocument(inner: string, bootstrapScripts: string[]): string {
  const scripts = bootstrapScripts
    .map(s => `<script src="${escapeHtmlAttr(s)}" defer></script>`)
    .join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${scripts}</head><body><div id="__gio">${inner}</div>${OBSERVER_SCRIPT}</body></html>`;
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

function isIPCResponse(value: IPCOutbound): value is IPCResponse {
  return 'status' in value;
}

export async function renderRoute(
  req: IPCRequest,
  routes: Map<string, RouteModule>,
  layouts: Map<string, LayoutEntry>,
  registry?: NodePluginRegistry,
): Promise<IPCOutbound | SseRouteResult> {
  if (registry !== undefined && !registry.isEmpty) {
    const intercepted = await registry.interceptRequest(req);
    if (isIPCResponse(intercepted as IPCOutbound)) {
      return intercepted as IPCOutbound;
    }
    req = intercepted as IPCRequest;
  }

  const match = matchRoute(req.path, routes);

  if (!match) {
    return {
      id: req.id,
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>',
      cacheable: false,
      cacheMaxAge: 0,
    };
  }

  try {
    const pageModule = await match.module.load();

    // SSE route — route.ts files export GET(req) → GioEventStream
    if (pageModule.GET !== undefined) {
      const result = pageModule.GET({
        path: req.path,
        params: match.params,
        query: req.query,
        headers: req.headers,
      });
      if (result instanceof GioEventStream) {
        return { type: 'sse', stream: result };
      }
    }

    const Component = pageModule.default;

    let props: Record<string, unknown> = {};
    if (pageModule.getServerSideProps) {
      const result = await pageModule.getServerSideProps({
        params: match.params,
        query: req.query,
        locale: req.locale,
      });
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
      // Support both { props: {...} } (Next.js convention) and flat { key: value }
      const raw = result as Record<string, unknown>;
      props = typeof raw['props'] === 'object' && raw['props'] !== null
        ? raw['props'] as Record<string, unknown>
        : raw;
    } else {
      props = { params: match.params, searchParams: req.query };
    }

    // Build element tree: start with page, wrap in layouts innermost-first.
    // findApplicableLayouts returns outermost-first, so reversing gives innermost-first
    // for wrapping so the outermost layout ends up as the actual outer element.
    let element: React.ReactNode = React.createElement(Component, props as any);
    const applicableLayouts = findApplicableLayouts(req.path, layouts);
    for (const layoutEntry of [...applicableLayouts].reverse()) {
      const layoutMod = await layoutEntry.load();
      const Layout = layoutMod.default;
      element = React.createElement(Layout, { children: element, path: req.path });
    }

    const stream = await renderToReadableStream(element, {
      bootstrapScripts: ['/_next/static/chunks/main.js'],
      onError(err) {
        console.error('[SSR error]', err);
      },
    });

    await stream.allReady;
    const html = await streamToString(stream);

    // Root layout provides <html>/<body>, so skip the document wrapper.
    const hasRootLayout = layouts.has('/');
    const body = hasRootLayout
      ? html
      : wrapWithDocument(html, ['/_next/static/chunks/main.js']);

    const ssrResponse: IPCOutbound = {
      id: req.id,
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body,
      cacheable: pageModule.revalidate !== undefined,
      // revalidate=false means "cache forever"; false??0 would coerce to 0 so check explicitly.
      cacheMaxAge: pageModule.revalidate === false ? 31536000 : (pageModule.revalidate ?? 0),
    };

    if (registry !== undefined && !registry.isEmpty && isIPCResponse(ssrResponse)) {
      return registry.interceptResponse(req, ssrResponse);
    }
    return ssrResponse;
  } catch (err) {
    console.error('[SSR fatal]', err);
    return {
      id: req.id,
      error: true,
      code: 'RENDER_ERROR',
      message: err instanceof Error ? err.message : String(err),
      stack: DEV && err instanceof Error ? err.stack : undefined,
    };
  }
}
