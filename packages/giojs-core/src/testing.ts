/**
 * giojs-core/src/testing.ts
 *
 * `@gio.js/core/testing`: test helpers for GioJS apps, for vitest and
 * node:test alike.
 *
 * - renderPage / callRoute run a request through the same renderRoute the
 *   worker uses (buffered, no Rust server): routes, layouts, route.ts
 *   handlers, not-found/error files and gio.config plugins are discovered
 *   once per app directory, and notFound(), redirects and error pages
 *   resolve the way the server resolves them. What lives in Rust - gio.toml
 *   and middleware.ts rules, rate limits, CSRF checks, security headers,
 *   the page cache - is not applied; createTestServer covers that.
 * - createTestServer starts the real giojs-server binary on a free port
 *   with a private cache, and close() takes down its whole process tree.
 *
 * Page modules are imported once per process: resetTestApp re-runs
 * discovery (added or removed files), but an edit to a module that was
 * already imported shows up only in a fresh test process.
 *
 * Server-only: a client bundle that reaches this module is refused by the
 * client build, like any other server-only import.
 */
import '@gio.js/core/server-only';
import { isUtf8 } from 'node:buffer';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IPCError, IPCRequest, IPCResponse } from './context.ts';
import { isValidCookieName } from './cookies.ts';
import { formatSseEvent } from './ipc.ts';
import { loadGioConfig } from './config-loader.ts';
import { NodePluginRegistry } from './plugin.ts';
import {
  assertNoRouteConflicts,
  discoverLayouts,
  discoverRouteFiles,
  discoverRoutes,
  discoverSegmentFiles,
  discoverSpecialPages,
} from './router.ts';
import { renderRoute, type RenderExtras } from './ssr.ts';
import { isGioEventStream, type GioEventStream, type SseStream } from './sse.ts';
import { discoverRouteModules } from './ws-router.ts';

// ── app discovery (renderPage / callRoute) ───────────────────────────────────

/**
 * The hydration entry every test render points at. No client bundles are
 * built in tests, but a page still renders with its envelope and bootstrap
 * script exactly like a served page - that is what `props` is read from.
 */
export const TEST_ENTRY_SCRIPT = '/_gio/testing/entry.js';

interface TestApp {
  routes: Awaited<ReturnType<typeof discoverRoutes>>;
  layouts: Awaited<ReturnType<typeof discoverLayouts>>;
  registry: NodePluginRegistry;
  clientScripts: Map<string, string>;
  extras: RenderExtras;
}

/** Discovery per resolved app directory, shared by every render in the process. */
const apps = new Map<string, Promise<TestApp>>();

/** `appDir`, else GIO_APP_DIR, else ./app - the server's own default. */
function resolveAppDir(appDir: string | undefined): string {
  return resolve(appDir ?? process.env.GIO_APP_DIR ?? join(process.cwd(), 'app'));
}

async function discoverTestApp(appDir: string): Promise<TestApp> {
  // Mirrors main.ts (minus client bundles, typed routes and the IPC
  // servers): a conflicting route fails here as it fails the worker boot.
  const [routes, layouts, routeFiles, segmentFiles, specialPages] = await Promise.all([
    discoverRoutes(appDir),
    discoverLayouts(appDir),
    discoverRouteFiles(appDir),
    discoverSegmentFiles(appDir),
    discoverSpecialPages(appDir),
  ]);
  assertNoRouteConflicts(appDir, routes, routeFiles);
  const { handlers } = await discoverRouteModules(routeFiles);
  const config = await loadGioConfig(appDir);
  // Not startPluginRegistry: that one owns the worker's SIGTERM handler.
  const registry = new NodePluginRegistry();
  for (const plugin of config.plugins ?? []) {
    registry.register(plugin);
  }
  await registry.runStartup();
  return {
    routes,
    layouts,
    registry,
    clientScripts: new Map([...routes.keys()].map(pattern => [pattern, TEST_ENTRY_SCRIPT])),
    extras: { handlers, specialPages, segmentFiles },
  };
}

function testApp(appDir: string): Promise<TestApp> {
  let app = apps.get(appDir);
  if (app === undefined) {
    app = discoverTestApp(appDir);
    apps.set(appDir, app);
    // A failed discovery (route conflict, broken gio.config) is retried by
    // the next call instead of failing every later test the same way.
    app.catch(() => {
      if (apps.get(appDir) === app) apps.delete(appDir);
    });
  }
  return app;
}

/**
 * Forget the discovered routes of `appDir` (every app when omitted) and run
 * their plugins' onShutdown hooks; the next render discovers again, so added
 * and removed files are seen. Modules already imported stay cached by the
 * module system (vi.resetModules() included): an edit to one shows up only
 * in a fresh test process.
 */
export async function resetTestApp(appDir?: string): Promise<void> {
  const dirs = appDir === undefined ? [...apps.keys()] : [resolveAppDir(appDir)];
  const pending: Promise<TestApp>[] = [];
  for (const dir of dirs) {
    const app = apps.get(dir);
    if (app === undefined) continue;
    apps.delete(dir);
    pending.push(app);
  }
  for (const app of await Promise.allSettled(pending)) {
    if (app.status === 'fulfilled') await app.value.registry.runShutdown();
  }
}

// ── requests ─────────────────────────────────────────────────────────────────

/** What a test request may carry, shared by renderPage and callRoute. */
export interface TestRequestOptions {
  /** The app/ directory. Default: GIO_APP_DIR, else `<cwd>/app`. */
  appDir?: string;
  /** Request headers (names are case-insensitive). */
  headers?: Record<string, string>;
  /** Sent as the Cookie header, after any `cookie` in `headers`. Values are sent verbatim. */
  cookies?: Record<string, string>;
  /** Query parameters; merged over any query string in the path. */
  query?: Record<string, string>;
  /** The locale the server would have detected ([i18n]); default none. */
  locale?: string;
}

export interface RenderPageOptions extends TestRequestOptions {
  method?: 'GET' | 'HEAD';
}

export interface CallRouteOptions extends TestRequestOptions {
  /** Default GET. */
  method?: string;
  /**
   * The request body. A string is sent as text/plain, URLSearchParams as a
   * form, bytes as-is (base64 across the boundary when not UTF-8, like the
   * server does), and any other value as JSON. A `content-type` in
   * `headers` always wins.
   */
  body?: string | Uint8Array | URLSearchParams | Record<string, unknown> | unknown[] | null;
}

/** The server's answer for a failed render (no error.* file rendered). */
export interface TestRenderError {
  /** The real message in development, a generic one in production. */
  message: string;
  /** The reference the error was logged under. */
  digest?: string;
  /** Development only. */
  stack?: string;
}

export interface RenderPageResult {
  status: number;
  /** The worker's response headers, lowercase; Rust adds its own on top. */
  headers: Record<string, string>;
  /** Each Set-Cookie value, in order. */
  setCookies: string[];
  /** The document the worker rendered ('' for HEAD). */
  html: string;
  /**
   * The page's hydration props, as serialized into the page: null when the
   * page did not render (redirect, 404, error) or its props are not
   * JSON-serializable (the page then renders without hydrating).
   */
  props: Record<string, unknown> | null;
  /** Whether the server would store this response in its shared page cache. */
  cacheable: boolean;
  /** Seconds the page cache keeps it (0 when not cacheable). */
  cacheMaxAge: number;
  /** Set for 3xx responses. */
  redirect?: { destination: string; permanent: boolean };
  /** Set when the render failed and no error.* file answered (status 500). */
  error?: TestRenderError;
}

export interface RouteResponse {
  status: number;
  /** Response headers, lowercase. */
  headers: Record<string, string>;
  /** Each Set-Cookie value, in order. */
  setCookies: string[];
  /**
   * Server-Sent Events responses only: the event stream exactly as the
   * client would receive it (`data: ...\n\n` frames). Cancelling it runs the
   * handler's cleanup, like a client disconnect. Null otherwise.
   */
  stream: ReadableStream<Uint8Array> | null;
  /** The body as text. For an event stream, resolves once the handler closes it. */
  text(): Promise<string>;
  /** The body parsed as JSON. */
  json<T = unknown>(): Promise<T>;
  /** The raw body bytes. */
  bytes(): Promise<Uint8Array>;
  /** Set when a page render failed and no error.* file answered. */
  error?: TestRenderError;
}

/** What renderRoute answered, before shaping it for either helper. */
type Outcome =
  | { kind: 'response'; response: IPCResponse }
  | { kind: 'error'; error: IPCError }
  | { kind: 'sse'; stream: GioEventStream };

/** Build the request the server would send the worker. */
function buildRequest(
  rawPath: string,
  method: string,
  options: TestRequestOptions,
  body: { body: string | null; bodyBase64: boolean; contentType?: string },
): IPCRequest {
  if (!rawPath.startsWith('/')) {
    throw new TypeError(`expected an absolute path such as "/posts/1", got ${JSON.stringify(rawPath)}`);
  }
  const url = new URL(rawPath, 'http://localhost');
  const query: Record<string, string> = Object.fromEntries(url.searchParams);
  Object.assign(query, options.query);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  // Every request the server forwards carries a host (HTTP/1.1 requires it).
  headers['host'] ??= 'localhost';
  if (body.contentType !== undefined) headers['content-type'] ??= body.contentType;
  const cookie = cookieHeader(options.cookies);
  if (cookie !== '') {
    headers['cookie'] = headers['cookie'] ? `${headers['cookie']}; ${cookie}` : cookie;
  }
  // Rust stamps its request id on the forwarded headers too.
  const requestId = randomUUID();
  headers['x-request-id'] = requestId;

  return {
    id: requestId,
    method,
    path: url.pathname,
    params: {},
    query,
    headers,
    body: body.body,
    bodyBase64: body.bodyBase64,
    deploymentId: 'test',
    locale: options.locale ?? '',
    ip: '127.0.0.1',
    scheme: 'http',
    host: headers['host'],
    requestId,
  };
}

function cookieHeader(cookies: Record<string, string> | undefined): string {
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(cookies ?? {})) {
    if (!isValidCookieName(name)) {
      throw new TypeError(`invalid cookie name ${JSON.stringify(name)}`);
    }
    // A separator in a value would smuggle in another cookie.
    if (/[;\r\n]/.test(value)) {
      throw new TypeError(`cookie ${name}: values must not contain ';', CR or LF`);
    }
    pairs.push(`${name}=${value}`);
  }
  return pairs.join('; ');
}

/** Encode a callRoute body the way a client plus the server would. */
function encodeBody(
  body: CallRouteOptions['body'],
): { body: string | null; bodyBase64: boolean; contentType?: string } {
  if (body === undefined || body === null) return { body: null, bodyBase64: false };
  if (typeof body === 'string') {
    return { body, bodyBase64: false, contentType: 'text/plain;charset=UTF-8' };
  }
  if (body instanceof URLSearchParams) {
    return {
      body: body.toString(),
      bodyBase64: false,
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }
  if (body instanceof Uint8Array) {
    const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    return isUtf8(bytes)
      ? { body: bytes.toString('utf8'), bodyBase64: false }
      : { body: bytes.toString('base64'), bodyBase64: true };
  }
  return { body: JSON.stringify(body), bodyBase64: false, contentType: 'application/json' };
}

async function dispatch(req: IPCRequest, appDir: string | undefined): Promise<Outcome> {
  const app = await testApp(resolveAppDir(appDir));
  const result = await renderRoute(
    req,
    app.routes,
    app.layouts,
    app.registry,
    undefined,
    app.clientScripts,
    app.extras,
  );
  if ('type' in result) {
    if (result.type === 'sse' && isGioEventStream(result.stream)) {
      return { kind: 'sse', stream: result.stream };
    }
    // Streaming renders are opted into by the IPC server only.
    throw new Error(`unexpected ${result.type} render result for ${req.path}`);
  }
  if ('error' in result) return { kind: 'error', error: result };
  return { kind: 'response', response: result };
}

/** The page Rust answers a worker error frame with in production (dev_overlay.rs). */
function errorPageHtml(status: number, digest: string): string {
  const reason = status === 404 ? 'Not Found' : 'Internal Server Error';
  const escaped = digest.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${status} ${reason}</title></head>` +
    `<body><h1>${status}</h1><p>${reason}</p><p>Error reference: <code>${escaped}</code></p></body></html>`
  );
}

function errorFields(error: IPCError): { status: number; info: TestRenderError } {
  return {
    status: error.code === 'NOT_FOUND' ? 404 : 500,
    info: {
      message: error.message,
      ...(error.digest !== undefined ? { digest: error.digest } : {}),
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    },
  };
}

/** Mirrors Rust's render_is_shareable: what the page cache would store. */
function isShareable(response: IPCResponse): boolean {
  return (
    response.cacheable &&
    response.cacheMaxAge > 0 &&
    (response.vary ?? []).length === 0 &&
    (response.setCookies ?? []).length === 0
  );
}

const ENVELOPE = /<script id="__gio_props" type="application\/json">([^<]*)<\/script>/;

/** The props of the page's hydration envelope, or null when it has none. */
function envelopeProps(html: string): Record<string, unknown> | null {
  const json = ENVELOPE.exec(html)?.[1];
  if (json === undefined) return null;
  const envelope = JSON.parse(json) as { props?: Record<string, unknown> };
  return envelope.props ?? null;
}

function redirectOf(status: number, headers: Record<string, string>): RenderPageResult['redirect'] {
  const destination = headers['location'];
  if (status < 300 || status > 399 || destination === undefined) return undefined;
  return { destination, permanent: status === 301 || status === 308 };
}

/**
 * Render the page at `path` (query string allowed) as the worker would for
 * the server: getServerSideProps runs with the given headers and cookies,
 * layouts wrap the page, and notFound(), redirects and error.* files answer
 * as they do in production. Nothing is cached between calls.
 */
export async function renderPage(
  path: string,
  options: RenderPageOptions = {},
): Promise<RenderPageResult> {
  const method = options.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    throw new TypeError(`renderPage renders GET/HEAD requests - use callRoute for ${String(method)}`);
  }
  const req = buildRequest(path, method, options, { body: null, bodyBase64: false });
  const outcome = await dispatch(req, options.appDir);
  if (outcome.kind === 'sse') {
    throw new TypeError(`${req.path} answers with an event stream - use callRoute to read it`);
  }
  if (outcome.kind === 'error') {
    const { status, info } = errorFields(outcome.error);
    return {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      setCookies: [],
      html: method === 'HEAD' ? '' : errorPageHtml(status, info.digest ?? ''),
      props: null,
      cacheable: false,
      cacheMaxAge: 0,
      error: info,
    };
  }
  const { response } = outcome;
  const body = response.bodyBase64 === true
    ? Buffer.from(response.body, 'base64').toString('utf8')
    : response.body;
  const cacheable = isShareable(response);
  const redirect = redirectOf(response.status, response.headers);
  return {
    status: response.status,
    headers: { ...response.headers },
    setCookies: [...(response.setCookies ?? [])],
    html: method === 'HEAD' ? '' : body,
    props: response.status === 200 ? envelopeProps(body) : null,
    cacheable,
    cacheMaxAge: cacheable ? response.cacheMaxAge : 0,
    ...(redirect !== undefined ? { redirect } : {}),
  };
}

/**
 * Call the route.ts handler (or page) at `path` with `options.method`
 * (default GET). The answer reads like a fetch Response: `text()`,
 * `json()`, `bytes()`, plus every Set-Cookie value in `setCookies`.
 */
export async function callRoute(
  path: string,
  options: CallRouteOptions = {},
): Promise<RouteResponse> {
  const method = (options.method ?? 'GET').toUpperCase();
  const req = buildRequest(path, method, options, encodeBody(options.body));
  const outcome = await dispatch(req, options.appDir);

  if (outcome.kind === 'sse') {
    const stream = eventStream(outcome.stream);
    const bytes = (): Promise<Uint8Array> => readAll(stream);
    // The headers ipc.ts answers an event stream with.
    return routeResponse(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    }, [], stream, bytes);
  }
  if (outcome.kind === 'error') {
    const { status, info } = errorFields(outcome.error);
    const html = Buffer.from(errorPageHtml(status, info.digest ?? ''));
    return {
      ...routeResponse(status, { 'content-type': 'text/html; charset=utf-8' }, [], null, () =>
        Promise.resolve(html)),
      error: info,
    };
  }
  const { response } = outcome;
  const raw = method === 'HEAD'
    ? Buffer.alloc(0)
    : Buffer.from(response.body, response.bodyBase64 === true ? 'base64' : 'utf8');
  return routeResponse(
    response.status,
    { ...response.headers },
    [...(response.setCookies ?? [])],
    null,
    () => Promise.resolve(raw),
  );
}

function routeResponse(
  status: number,
  headers: Record<string, string>,
  setCookies: string[],
  stream: ReadableStream<Uint8Array> | null,
  bytes: () => Promise<Uint8Array>,
): RouteResponse {
  const text = async (): Promise<string> => Buffer.from(await bytes()).toString('utf8');
  return {
    status,
    headers,
    setCookies,
    stream,
    text,
    async json<T = unknown>(): Promise<T> {
      return JSON.parse(await text()) as T;
    },
    bytes,
  };
}

/**
 * Run a GioEventStream handler against a stream that frames events like
 * the server does. A handler that throws errors the stream (the server can
 * only end it - its headers are gone); cancelling the stream runs the
 * handler's cleanup like a client disconnect, while a stream the handler
 * closed itself is done with (ipc.ts drops its cleanup then too).
 */
function eventStream(source: GioEventStream): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const sink: SseStream = {
        send(data, event, id) {
          if (!done) controller.enqueue(encoder.encode(formatSseEvent(data, event, id)));
        },
        close() {
          if (done) return;
          done = true;
          cleanup = undefined;
          controller.close();
        },
      };
      try {
        const returned = source.handler(sink);
        if (!done) cleanup = returned;
      } catch (handlerError) {
        done = true;
        controller.error(handlerError);
      }
    },
    cancel() {
      done = true;
      const pending = cleanup;
      cleanup = undefined;
      pending?.();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ── createTestServer ─────────────────────────────────────────────────────────

export interface TestServerOptions {
  /** The app/ directory; the server runs from its parent. Default: GIO_APP_DIR, else `<cwd>/app`. */
  appDir?: string;
  /**
   * Extra environment for the server (and the worker it spawns); `undefined`
   * removes an inherited variable. NODE_ENV=development gives a dev server.
   */
  env?: Record<string, string | undefined>;
  /** Listen port on 127.0.0.1. Default: a free one. */
  port?: number;
  /** The giojs-server binary. Default: GIO_SERVER_BIN, else the one @gio.js/server installed. */
  binary?: string;
  /** How long to wait for the worker to be ready, in ms (default 60000). */
  timeoutMs?: number;
}

export interface TestServer {
  /** Base URL, e.g. `http://127.0.0.1:41234` (no trailing slash). */
  url: string;
  port: number;
  /** Everything the server and its worker logged so far. */
  logs(): string;
  /** Stop the server and every process it started; safe to call twice. */
  close(): Promise<void>;
}

const EXE = process.platform === 'win32' ? '.exe' : '';
/** Logs kept per server: enough for a failure's context, never unbounded. */
const MAX_LOG_CHARS = 1024 * 1024;

/**
 * The giojs-server binary to run: an explicit path, GIO_SERVER_BIN, the
 * platform binary @gio.js/server installed (resolved from the project, so
 * its own lookup rules apply), else a workspace cargo build.
 */
function findServerBinary(projectRoot: string, explicit?: string): string {
  const pinned = explicit ?? process.env.GIO_SERVER_BIN;
  if (pinned !== undefined && pinned !== '') {
    if (!existsSync(pinned)) {
      throw new Error(
        `giojs-server binary not found at ${pinned} (${explicit !== undefined ? 'the binary option' : 'GIO_SERVER_BIN'})`,
      );
    }
    return pinned;
  }
  for (const base of [join(projectRoot, 'package.json'), import.meta.url]) {
    try {
      const require = createRequire(base);
      const finder = require('@gio.js/server/bin/find-binary.js') as { path: string };
      if (existsSync(finder.path)) return finder.path;
    } catch {
      // Not installed here, or no binary for this platform: next candidate.
    }
  }
  // The GioJS repository itself: packages/giojs-core/src → target/.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  for (const profile of ['debug', 'release']) {
    const candidate = join(repoRoot, 'target', profile, `giojs-server${EXE}`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'createTestServer needs the GioJS server binary and none was found.\n' +
      '  Install it:  npm install --save-dev @gio.js/server\n' +
      `  (it pulls in the prebuilt binary for ${process.platform}-${process.arch}),\n` +
      '  or point GIO_SERVER_BIN at a giojs-server binary.',
  );
}

/** A port that was free a moment ago (the server binds it right after). */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

/** GET /_gio/health without a keep-alive agent (it would hold the server's shutdown). */
function healthCheck(url: string): Promise<{ nodeReady?: boolean } | null> {
  return new Promise(resolveHealth => {
    const req = httpGet(`${url}/_gio/health`, { agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolveHealth(res.statusCode === 200 ? (JSON.parse(body) as { nodeReady?: boolean }) : null);
        } catch {
          resolveHealth(null);
        }
      });
    });
    req.on('error', () => resolveHealth(null));
    req.setTimeout(2_000, () => req.destroy());
  });
}

/** A started server: its process and the IPC socket that marks its workers. */
interface ServerProcess {
  child: ChildProcess;
  socketPath: string;
}

/** Servers not yet closed: the exit hooks below take them down with the process. */
const liveServers = new Set<ServerProcess>();

/**
 * Start the real GioJS server for `appDir` on 127.0.0.1 and wait until its
 * Node worker is ready. Each server gets a private page cache and IPC
 * socket, so several can run side by side; the project's gio.toml is used
 * as-is except for the listen address (GIO_HOST / GIO_PORT).
 */
export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const appDir = resolveAppDir(options.appDir);
  const projectRoot = dirname(appDir);
  const binary = findServerBinary(projectRoot, options.binary);
  const timeoutMs = options.timeoutMs ?? 60_000;
  // Retrying covers the window between probing a free port and binding it.
  const attempts = options.port === undefined ? 3 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = options.port ?? (await freePort());
    try {
      return await startServer(binary, appDir, projectRoot, port, options.env ?? {}, timeoutMs);
    } catch (startError) {
      lastError = startError;
      if (!(startError instanceof PortInUseError)) throw startError;
    }
  }
  throw lastError;
}

class PortInUseError extends Error {}

async function startServer(
  binary: string,
  appDir: string,
  projectRoot: string,
  port: number,
  extraEnv: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<TestServer> {
  const scratch = await mkdtemp(join(tmpdir(), 'gio-test-'));
  const env = serverEnv(appDir, scratch, port, extraEnv);
  const url = `http://127.0.0.1:${port}`;

  let log = '';
  const child = spawn(binary, [], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const append = (chunk: Buffer): void => {
    log += chunk.toString('utf8');
    if (log.length > MAX_LOG_CHARS) log = log.slice(-MAX_LOG_CHARS);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const server: ServerProcess = { child, socketPath: env.GIO_SOCKET_PATH ?? '' };
  liveServers.add(server);
  installExitHooks();
  let exited = false;
  const exitedPromise = new Promise<void>(resolveExit => {
    child.once('exit', () => {
      exited = true;
      resolveExit();
    });
    // Spawn failures (EACCES, ENOENT) emit 'error' and possibly no 'exit'.
    child.once('error', spawnError => {
      append(Buffer.from(`\nspawn failed: ${spawnError.message}\n`));
      exited = true;
      resolveExit();
    });
  });

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const workers = killServerTree(server);
      await exitedPromise;
      await waitUntilGone(workers);
      liveServers.delete(server);
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    })();
    return closing;
  };

  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (exited) {
      await close();
      const tail = log.split('\n').slice(-40).join('\n');
      if (/address already in use|AddrInUse|os error (98|48|10048)/i.test(log)) {
        throw new PortInUseError(`port ${port} is in use:\n${tail}`);
      }
      throw new Error(`giojs-server exited before it was ready:\n${tail}`);
    }
    const health = await healthCheck(url);
    if (health?.nodeReady === true) break;
    if (Date.now() > deadline) {
      await close();
      throw new Error(
        `giojs-server did not become ready within ${timeoutMs}ms:\n${log.split('\n').slice(-40).join('\n')}`,
      );
    }
    await new Promise(resolveTick => setTimeout(resolveTick, 100));
  }

  return { url, port, logs: () => log, close };
}

function serverEnv(
  appDir: string,
  scratch: string,
  port: number,
  extra: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const require = createRequire(import.meta.url);
  const instance = randomUUID().slice(0, 8);
  return {
    // The worker this package ships, run through its own tsx - a project
    // with neither at its root (pnpm, monorepos) still boots.
    GIO_NODE_SCRIPT: fileURLToPath(new URL('./index.ts', import.meta.url)),
    GIO_TSX_PKG: dirname(require.resolve('tsx/package.json')),
    ...env,
    GIO_APP_DIR: appDir,
    GIO_HOST: '127.0.0.1',
    GIO_PORT: String(port),
    // Private state: the project's persisted cache never answers a test,
    // and a test never fills it.
    GIO_CACHE_DIR: join(scratch, 'cache'),
    GIO_IMAGE_CACHE_DIR: join(scratch, 'images'),
    // Own sockets: the default .gio/ names are shared with a dev server
    // running in the same project, whose stale-socket sweep would unlink ours.
    GIO_SOCKET_PATH:
      process.platform === 'win32' ? `\\\\.\\pipe\\giojs-test-${instance}` : join(scratch, 'ipc.sock'),
    GIO_WS_SOCKET_PATH:
      process.platform === 'win32' ? `\\\\.\\pipe\\giojs-test-ws-${instance}` : join(scratch, 'ws.sock'),
  };
}

/** Whether the server process has not exited (its pid is still its own). */
function isRunning(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

/**
 * Kill a server and everything it started. SIGKILL right away: a graceful
 * stop drains idle keep-alive connections (every fetch() leaves one), which
 * only makes teardown slow, and a test server has nothing to keep. The
 * worker runs in its own process group (ipc.rs), so the tree is captured
 * while the server lives and every worker group is killed after - no worker
 * outlives the test run. On Windows the worker sits in the server's job
 * object; taskkill /T takes the tree. Synchronous, for the exit hook;
 * returns the worker pids it signalled.
 */
function killServerTree(server: ServerProcess): number[] {
  const { child } = server;
  // An exited server's pid may already belong to another process.
  const running = isRunning(child);
  const pid = child.pid;
  if (pid !== undefined && process.platform === 'win32') {
    if (running) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return [];
  }
  const tree = running && pid !== undefined ? descendantPids(pid) : [];
  if (running) child.kill('SIGKILL');
  // A worker orphaned by a server crash is no descendant any more - but it
  // still carries this server's socket path.
  const workers = [...new Set([...tree, ...workersOf(server)])];
  killWorkerGroups(workers);
  return workers;
}

/**
 * Resolve once every pid is gone (SIGKILL is delivered asynchronously), so
 * close() returning means the processes are dead. Bounded: a zombie nobody
 * reaps is dead too.
 */
async function waitUntilGone(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (pids.some(isAlive) && Date.now() < deadline) {
    await new Promise(resolveTick => setTimeout(resolveTick, 20));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

/** SIGKILL each pid's process group (a worker leads one: ipc.rs spawns it with process_group(0)) and the pid. */
function killWorkerGroups(pids: Iterable<number>): void {
  const ownGroup = processTable().get(process.pid)?.pgid;
  for (const pid of new Set(pids)) {
    // A pid that leads no group answers ESRCH; a pgid is never reused while
    // its group lives, so a live pid can only name its own group.
    if (pid !== ownGroup) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Not a group leader, or already gone.
      }
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Linux: every process whose environment holds this server's socket path -
 * exactly its workers, wherever they were reparented. Elsewhere the process
 * tree snapshot is all there is.
 */
function workersOf(server: ServerProcess): number[] {
  if (process.platform !== 'linux' || server.socketPath === '') return [];
  const marker = `GIO_SOCKET_PATH=${server.socketPath}`;
  const found: number[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return found;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').includes(marker)) {
        found.push(Number(name));
      }
    } catch {
      // Exited, or not ours to read.
    }
  }
  return found;
}

interface ProcessEntry {
  ppid: number;
  pgid: number;
}

/** pid → parent and group, from /proc (Linux) or ps (macOS, BSDs). */
function processTable(): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  if (process.platform === 'linux') {
    let entries: string[] = [];
    try {
      entries = readdirSync('/proc');
    } catch {
      return table;
    }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        // "pid (comm) state ppid pgrp ..." - comm may contain spaces and parens.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        table.set(Number(name), { ppid: Number(fields[1]), pgid: Number(fields[2]) });
      } catch {
        // Exited while we looked.
      }
    }
    return table;
  }
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
  for (const line of (ps.stdout ?? '').split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (pid !== undefined && ppid !== undefined && pgid !== undefined && !Number.isNaN(pgid)) {
      table.set(pid, { ppid, pgid });
    }
  }
  return table;
}

/** Every live descendant of `root`. */
function descendantPids(root: number): number[] {
  const table = processTable();
  const found: number[] = [];
  let frontier = [root];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const [pid, entry] of table) {
      if (frontier.includes(entry.ppid) && !found.includes(pid)) {
        found.push(pid);
        next.push(pid);
      }
    }
    frontier = next;
  }
  return found;
}

let exitHooksInstalled = false;

/**
 * A test run that ends without close() (a crash, Ctrl+C, a forgotten
 * afterAll) must not leave servers and workers behind. The exit hook is
 * synchronous; the signal hooks clean up and then let the signal do what it
 * would have done without us.
 */
function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.on('exit', killLiveServersSync);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const onSignal = (): void => {
      killLiveServersSync();
      process.off(signal, onSignal);
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

function killLiveServersSync(): void {
  for (const server of liveServers) killServerTree(server);
  liveServers.clear();
}
