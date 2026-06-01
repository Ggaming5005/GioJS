# Changelog

All notable changes to this project will be documented in this file.

## 0.1.0-beta.1 (2026-05-31)

First public beta on npm. Published under the **`@gio.js/*`** scope —
`@gio.js/server` (the binary + Node bridge, formerly the unscoped `giojs` name,
which was already taken), `@gio.js/core`, `@gio.js/react`, and the five
`@gio.js/server-<platform>` binary packages — plus the unscoped `create-giojs`.
Scaffold a project with `npm create giojs@latest`.

### JavaScript / JSX support

- Route, layout, and config discovery now resolve `.jsx` and `.js` files in
  addition to `.tsx`/`.ts`. When several extensions coexist in one directory the
  match is deterministic (`.tsx` → `.jsx` → `.js` for components; `.ts` → `.js`
  for `route` handlers).
- `gio.config.js` is now loaded as an alternative to `gio.config.ts`.

### CLI (`create-giojs`)

- Interactive arrow-key language picker (TypeScript / JavaScript) — zero
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
- WebSocket and HTTP IPC are fully independent — no head-of-line blocking

### i18n Routing (P5.2)

- Three-tier locale detection: URL prefix → cookie → Accept-Language header
- Locale prefix stripped from path before Node SSR
- Detected locale forwarded as `req.locale`
- Zero-cost passthrough when i18n is not configured

### Developer Dashboard (P5.3)

- Browser-based observability dashboard at `/_gio/devtools` (dev mode only; 404 in prod)
- Six live panels: request log, route manifest, cache stats, memory sparkline, IPC latency histogram, connection counts
- Self-contained HTML generated in Rust — no React, no external requests
- Real-time updates via Server-Sent Events

### Plugin API (P5.4)

- `GioPlugin` Rust trait for adding Tower middleware and axum routes without touching core
- `GioNodePlugin` TypeScript interface for `onRequest`/`onResponse` SSR interception
- `gio.config.ts` for typed plugin configuration (optional — no error if absent)
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
