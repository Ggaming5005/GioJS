# Changelog

All notable changes to this project will be documented in this file.

## 0.1.0-beta.5 (2026-07-26)

### Added

- **Dev watch mode.** In development (`NODE_ENV=development`) the Rust server
  watches `app/`, `gio.toml`, and `gio.config.*` (via `notify`, dev-only):
  on change it clears the page cache (memory + disk), re-transforms CSS,
  restarts the Node worker through the supervisor (fresh module cache, route
  discovery, and client bundles), and broadcasts `reload` on the devtools SSE
  stream - the dev overlay listens and reloads open browser tabs. Measured
  edit-to-browser round trip: ~1.5 s. Events under `.gio/` and
  `node_modules` are ignored so build outputs can't retrigger the loop.
- **API routes.** `route.ts` files now export HTTP method handlers
  (`GET`/`POST`/`PUT`/`PATCH`/`DELETE`) receiving a `GioRequest` (`params`,
  `query`, lowercased `headers`, parsed `cookies`, `body`/`bodyBase64`, and a
  `json()` helper) and returning a web-standard `Response`, a
  `GioEventStream` (SSE), `null`/`undefined` (204), or any JSON value
  (`application/json` 200). Unexported methods get 405 + `Allow`; pages only
  answer GET/HEAD; handler errors return a JSON 500 without leaking details.
  This also makes SSE-over-route.ts actually work - route files were
  previously only mined for `wsHandler`, so their `GET` stream handlers were
  unreachable (and cross-namespace `instanceof` would have dropped them
  anyway; `GioEventStream` detection is now brand-based).
- **`getServerSideProps` gets the full request.** The context now carries
  `method`, `path`, `headers`, and parsed `cookies` - cookie-based auth no
  longer requires the plugin workaround. Returning `{ props, headers }`
  merges response headers (e.g. `set-cookie`), and any page doing so is
  forced uncacheable so per-request headers can never be cached and replayed
  to other visitors.
- **`app/not-found.*` and `app/error.*` are real.** Unmatched paths render
  the custom 404 and throwing renders the custom 500 (props
  `{ error: { message } }`), both through the layout pipeline with graceful
  fallback to the built-ins. These conventions were scaffolded by
  `create-giojs` but silently ignored; the template's `error.tsx` now matches
  the server-rendered contract and the unimplemented `loading.*` convention
  is no longer scaffolded.

- **Client-side hydration exists.** Pages are now interactive: the Node
  worker builds per-route client bundles with esbuild at startup (ESM + code
  splitting, content-hashed names under `.gio/build/static/chunks/`, served
  immutable at `/_next/static/chunks/`), and each page loads its entry via
  React `bootstrapModules`. SSR renders a `<div id="__gio">` hydration
  boundary around the page and its non-root layouts, with props serialized in
  a sibling `<script id="__gio_props" type="application/json">` (`<` escaped,
  so `</script>` in props can never break out - verified by test). The client
  runtime hydrates exactly that boundary, so everything Rust injects after
  render (critical CSS, fonts, deployment script, `lang`, dev overlay) stays
  outside React's diff - zero hydration-mismatch surface by construction. The
  root layout remains a server-rendered shell: its `<GioLink>`s degrade to
  normal anchors. Soft navigation now swaps the envelope with the content and
  re-mounts via the shared runtime, dynamically importing the target route's
  chunk when needed. The stale `/_next/static/chunks/main.js` reference that
  404'd on every page is gone.
- **Server code is stripped from client bundles.** `getServerSideProps` /
  `getStaticPaths` are demoted from exports before bundling and project
  modules are tree-shaken as side-effect free, so gSSP-only imports (db
  clients, secrets, `node:*` builtins) stay out of the browser bundle - a
  regression test builds a fixture whose gSSP reads a secret via `node:fs`
  and asserts neither reaches any emitted chunk. Remaining `node:*` imports
  are stubbed so a stray server import degrades that route to server-only
  rendering (logged) instead of failing the build; a route that fails to
  bundle never takes down SSR or the other routes' bundles.

### Release integrity

- **All published versions are in lockstep, enforced.** `scripts/sync-versions.mjs`
  stamps one release version onto every `@gio.js/*` package, the wrapper's
  platform-binary pins, and the CLI templates' dependency ranges;
  `--check` mode gates both CI and the release workflow, so a beta-N wrapper
  resolving beta-M binaries (the state this repo shipped in) can't recur.
  Combined with the enforced IPC protocol version, mismatches now fail loudly
  at publish time and at handshake time.
- **Alpine/musl support.** New `@gio.js/server-linux-x64-musl` platform
  package built from `x86_64-unknown-linux-musl` in the release workflow;
  the linux packages carry `libc` fields and `find-binary.js` detects musl at
  runtime via `process.report`, so `npm install` in an Alpine container picks
  the right binary instead of failing with a loader error. npm publishes now
  carry `--provenance`, and every platform package declares its `repository`
  so provenance verification passes.
- **No more OpenSSL.** `reqwest` now uses rustls only
  (`default-features = false`), removing the transitive `native-tls` and
  `openssl-sys` dependency. This unblocks the musl build (OpenSSL has no musl
  target) and satisfies the workspace's no-OpenSSL rule.
- **A real integration harness** (`tests/integration/run.mjs`, no framework,
  plain node) spawns the actual Rust binary + Node worker against a fixture
  app and verifies end-to-end: SSR with hydration boundary + served chunks,
  UTF-8 and binary POST body forwarding, concurrent users with different
  cookies never sharing a render, cache hits on cacheable routes,
  kill-the-worker-mid-flight recovery (respawn + fresh pid), and
  orphan-free server shutdown. A new CI workflow runs it on Linux and
  Windows alongside cargo test/clippy and the Node suites. Writing it
  immediately caught a real bug: projects with a `gio.config.ts` crashed the
  worker on Windows (raw path handed to the ESM loader) - fixed via
  `pathToFileURL` in the config loader.

### Security

- **Coalesced renders are no longer shared across users.** Concurrent cache
  misses for one URL previously received the first caller's render even when
  the page was uncacheable - leaking cookie-personalized HTML between users
  and collapsing concurrent POSTs into a single execution. Renders are now
  shared only when the page is cacheable, the coalesce key includes a hash of
  the caller's `cookie`/`authorization` headers, and non-GET/HEAD requests
  bypass coalescing and caching entirely so mutations execute once per
  request. IPC failures return a shared error to all waiters instead of
  triggering a follower re-render stampede, and SSE routes no longer render
  twice per connection (the leader keeps its stream instead of discarding it
  and re-rendering).
- **Request bodies are forwarded to Node.** Non-GET/HEAD requests now carry
  their body over IPC (UTF-8; `413` past `server.max_body_bytes`, default
  2 MB; `415` for non-UTF-8 until the protocol grows a binary body field), so
  plugins and future API routes can read POST payloads.
- **The IPC handshake is authenticated and pipe names are per-instance.**
  Windows pipe names now carry a per-process random suffix (no more
  collisions between GioJS instances on one machine), and both IPC channels
  exchange proofs derived from a per-instance secret - Node proves
  `sha256(token:ready)`, Rust proves `sha256(token:ack)` (WS channel:
  `ws_auth` with `sha256(token:ws)`) - so a foreign local process can neither
  impersonate the SSR worker nor drive it.
- **Image optimizer:** remote fetches no longer follow redirects (an allowlisted
  host could 302 to internal addresses), stream with a size cap
  (`images.max_remote_bytes`, default 20 MB), and reuse one shared HTTP client.
- **Rate limiting:** header-keyed buckets (`key_header`) are now scoped per
  client IP with a per-IP distinct-key cap - rotating an API-key header no
  longer mints unlimited fresh buckets.
- **IPC:** both the HTTP and WS IPC pipes enforce a 64 MB frame cap on both
  sides of the boundary instead of allocating from wire-provided lengths; Unix
  sockets are created with 0600 permissions before the ready handshake, and the
  WS socket moved from `/tmp/giojs-ws.sock` to `.gio/ws.sock`.
- Devtools request log escapes interpolated values (dev-mode XSS via request
  path); `/_gio/metrics` bearer token compared in constant time.

### Performance

- **Responses are now composed at cache-put time:** critical CSS extraction,
  font preloads, and the deployment-id script are baked into the cached entry
  once (off the async thread via `spawn_blocking`) instead of being recomputed
  on every cache hit. Old disk entries fall back to per-request injection.
- Metrics label maps are bounded (512 keys, overflow aggregates to `_other`);
  the image disk cache gained oldest-first eviction under
  `images.disk_max_bytes` (default 512 MB) and rejects `q` outside 1–100.

### Changed

- **IPC protocol revised to v1 (enforced).** One batched wire revision while
  there are no external users: `bodyBase64` on requests (binary bodies now
  cross base64-encoded instead of being rejected with 415), `vary` and
  `cacheTags` on responses (non-empty `vary` makes a response uncacheable and
  unshared until vary-keyed caching lands; tags are persisted with cache
  entries for the future revalidation endpoint), a `cancel` control frame
  (client disconnects and timeouts now abort the React render via
  `AbortController` instead of finishing output nobody reads), a reserved
  `chunk` frame type for future streaming SSR, and an `IPC_PROTOCOL_VERSION`
  echoed in READY that Rust *enforces* - a mismatched binary/worker pair now
  fails the handshake with an explicit error instead of drifting silently.

### Fixed

- **The Node worker is now supervised: a crash is a blip, not an outage.**
  Previously the server reconnected to the socket but never restarted the
  process - if the worker died, every dynamic request failed until a manual
  restart. The supervisor now owns the child: on exit it drains in-flight
  requests with 503, respawns the worker, re-runs the authenticated
  handshake, and refreshes the route manifest - forever, with capped backoff
  (measured recovery from `taskkill /F` on the worker: ~300 ms). Requests
  queued for a dead connection fail fast with 503 instead of waiting out the
  30 s timeout.
- **Hard-killing the server no longer orphans the Node worker.** The worker
  is spawned with `kill_on_drop` and, on Windows, assigned to a Job Object
  with KILL_ON_JOB_CLOSE, so the whole worker tree (tsx wrapper + runtime
  child) dies with the server - the stale-pipe orphan documented in the
  clean-install report is gone. Startup also replaces the fixed 800 ms boot
  sleep with a connect-retry loop on both platforms.
- **WebSockets survive worker restarts - and now actually work.** The WS IPC
  bridge previously died permanently on its first socket error; it now
  reconnects with capped backoff, closing browser sockets on disconnect so
  clients re-register against the fresh worker. This also fixes a framing
  bug where every Rust→Node WS frame was double-length-prefixed and dropped
  by Node as non-JSON (browser WS events never reached user handlers).
- A malformed `gio.toml` now fails startup loudly with the parse error instead
  of silently running on full defaults (TLS off, no rate limits).
- WebSocket binary frames survive the Node bridge intact (base64 envelope with
  `isBinary`; previously mangled by lossy UTF-8 conversion). `GioSocket.send`
  and message handlers accept `Buffer`.
- WS IPC messages are validated on receipt (mirroring the HTTP IPC path); a
  throwing user SSE/route handler no longer kills the Node worker; route files
  that fail to load are logged instead of silently skipped.
- `GioLink` no longer hijacks ctrl/cmd/middle-clicks, `target="_blank"`, or
  `download` links; failed client navigations fall back to full page loads; the
  back/forward buttons restore content via a `popstate` handler.
- `examples/basic-app` workspace dependency names corrected to `@gio.js/*`.

### Internal

- TypeScript strictness raised across the workspace (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitReturns`, `noUnusedLocals`,
  `noUnusedParameters`); all `any` removed from the render path; structured
  JSON logging replaces `console.*` in the Node runtime; `index.ts` is now a
  logic-free entrypoint; new test suites for IPC framing/validation (18) and
  WS IPC (21) - core suite now 57 tests.

## 0.1.0-beta.3 (2026-06-02)

- **Static export** now auto-generates `robots.txt` and a full `sitemap.xml`
  (absolute URLs from `GIO_SITE_URL`) - every static build is SEO-ready.
- **Fix:** exported pages no longer reference a `/_next/static/chunks/main.js`
  bootstrap script (it 404'd on static hosts and tripped strict MIME checks).
  `@gio.js/core` and `@gio.js/server` only.

## 0.1.0-beta.2 (2026-06-02)

- **Static export** - `gio export` pre-renders the app to `out/` as plain HTML,
  deployable free to any static host. `getServerSideProps` runs at build time;
  dynamic routes export via a new `getStaticPaths()`; server-only routes (route
  handlers, SSE, WebSockets, ISR) are skipped with a warning.
- **`create-giojs`** adds a **Server app / Static site** picker (`--static` /
  `--server`); static projects build with `gio export` and ship no server.

## 0.1.0-beta.1 (2026-05-31)

First public beta on npm. Published under the **`@gio.js/*`** scope -
`@gio.js/server` (the binary + Node bridge, formerly the unscoped `giojs` name,
which was already taken), `@gio.js/core`, `@gio.js/react`, and the five
`@gio.js/server-<platform>` binary packages - plus the unscoped `create-giojs`.
Scaffold a project with `npm create giojs@latest`.

### JavaScript / JSX support

- Route, layout, and config discovery now resolve `.jsx` and `.js` files in
  addition to `.tsx`/`.ts`. When several extensions coexist in one directory the
  match is deterministic (`.tsx` → `.jsx` → `.js` for components; `.ts` → `.js`
  for `route` handlers).
- `gio.config.js` is now loaded as an alternative to `gio.config.ts`.

### CLI (`create-giojs`)

- Interactive arrow-key language picker (TypeScript / JavaScript) - zero
  dependencies, raw-mode TTY, falls back to the default on non-interactive stdin.
- New flags: `--ts`/`--js`, `--install`/`--no-install`, `-y`/`--yes`.
- Ships a `default-js` template (`.jsx` + `jsconfig.json`, no TypeScript toolchain).

### Default template

- New "engineering editorial" starter (not a marketing page): warm-ink theme with
  an ember accent, Fraunces display × JetBrains Mono, a blueprint dot-grid + grain
  backdrop, and a one-shot staggered load animation. The hero centers a faux-editor
  card showing the `app/page` file you're about to edit.
- Ember GioJS logo mark, used in the nav and as the favicon.
- All styling lives in CSS classes in `public/styles/globals.css`; removed the dead
  duplicate stylesheet and the unused example UI components.
- Status pages (404/500/loading) are now actually styled (the previous classes
  referenced an `error-pages.css` that was never linked into the served HTML).

### Framework foundation (Phases 1–5)

Covers Phase 1 through Phase 5 of the GioJS roadmap.

### HTTP Server

- Axum + Hyper HTTP/1.1 and HTTP/2 server with optional TLS via rustls
- Brotli and gzip compression via tower-http (responses ≥ 1 KB only)
- Static file serving from `public/` and `/_next/static/` with immutable cache headers
- Health endpoint at `/_gio/health`
- Prometheus metrics endpoint at `/_gio/metrics`

### Routing & Middleware

- O(k) radix trie router (giojs-router crate)
- Version skew detection middleware (x-deployment-id header)
- Token bucket rate limiting per IP, route, or API key (giojs-ratelimit crate)
- i18n routing with URL prefix, cookie, and Accept-Language detection (giojs-i18n crate)
- Prefetch budget manager preventing speculative-prefetch abuse (giojs-prefetch crate)

### Caching

- ISR page cache with memory (LRU) and disk tiers (giojs-cache crate)
- Stale-while-revalidate semantics with configurable multiplier
- Deployment-ID–aware cache invalidation on redeploy

### Image & Asset Processing

- Image optimization endpoint at `/_gio/image` supporting AVIF, WebP, JPEG, PNG (giojs-image crate)
- Width allowlist, quality control, and remote pattern allowlist
- Remote image proxying with validation

### Font Delivery

- Automatic font download and WOFF2 self-hosting (giojs-font crate)
- Correct `preload` and `<link rel="stylesheet">` headers injected into HTML

### CSS

- CSS module hashing and minification via lightningcss (giojs-css crate)
- Critical CSS extraction per route
- CSS transforms applied at startup, served from in-memory cache

### WebSockets (P5.1)

- Full-duplex WebSocket connections via dedicated IPC pipe (giojs-ws)
- Route-based `wsHandler` exports in `route.ts` files
- Connection registry with `send`, `broadcast`, `close`, and `on()` hooks
- WebSocket and HTTP IPC are fully independent - no head-of-line blocking

### i18n Routing (P5.2)

- Three-tier locale detection: URL prefix → cookie → Accept-Language header
- Locale prefix stripped from path before Node SSR
- Detected locale forwarded as `req.locale`
- Zero-cost passthrough when i18n is not configured

### Developer Dashboard (P5.3)

- Browser-based observability dashboard at `/_gio/devtools` (dev mode only; 404 in prod)
- Six live panels: request log, route manifest, cache stats, memory sparkline, IPC latency histogram, connection counts
- Self-contained HTML generated in Rust - no React, no external requests
- Real-time updates via Server-Sent Events

### Plugin API (P5.4)

- `GioPlugin` Rust trait for adding Tower middleware and axum routes without touching core
- `GioNodePlugin` TypeScript interface for `onRequest`/`onResponse` SSR interception
- `gio.config.ts` for typed plugin configuration (optional - no error if absent)
- Plugin errors yield 500; Node process never crashes due to a plugin fault
- Reference auth plugin skeleton (`packages/giojs-auth-example`)

### React SSR (Node layer)

- `renderToReadableStream` with layout nesting, `getServerSideProps`, and redirect support
- SSE routes via `GioEventStream` (exported `GET()` handler)
- File-based routing discovery at startup (`app/` directory convention)

### Developer Experience

- `create-giojs` CLI scaffolding tool (`npm create giojs@latest`)
- Next.js migration assistant (`gio-migrate`)
- Dev overlay for SSR errors (dev mode only)
- `/_gio/devtools` dashboard (dev mode only)

### Known Issues

See [docs/known-issues.md](docs/known-issues.md).
