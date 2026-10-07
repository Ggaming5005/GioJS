# Known Limitations

What GioJS does not do yet, or does differently from Next.js, and what to use
instead. The rendered version with links lives at
https://giojs.com/docs/known-issues (source:
`docs-site/app/docs/known-issues/page.tsx`) - keep the two in sync.

Bugs belong in [GitHub issues](https://github.com/Ggaming5005/GioJS/issues);
fixed bugs and per-version changes are in [CHANGELOG.md](../CHANGELOG.md) and
on https://giojs.com/releases.

## Rendering model

- **No React Server Components.** No `'use client'` / `'use server'` split and
  no async components: every page and nested layout is server-rendered and
  hydrated. Load data in `getServerSideProps` (stripped from client bundles
  together with everything only it imports); its returned props ship with the
  page, so never return secrets.
- **No Server Actions.** Mutations are page actions
  (`export async function action`) posted by forms or `<GioForm>`, or
  `route.ts` handlers called with `fetch()`.
- **The root layout never hydrates.** `app/layout.tsx` is server-only HTML:
  providers, state and handlers go in a nested layout or the pages; links in
  it are plain anchors. Inline scripts there need `cspNonce()` under a CSP.
- **No data cache.** Caching is per page in the Rust server (`revalidate`,
  tags, `revalidatePath` / `revalidateTag`); there is no `fetch()` cache,
  `unstable_cache` or `'use cache'`.
- **No hot module replacement.** A dev edit restarts the worker and reloads
  open tabs (~1.5 s); client state is lost. No React Fast Refresh.
- **Node only.** No edge runtime; everything runs in a Node 20+ worker.

## Routing and middleware

- `app/` is the only router (`pages/` apps: use `create-giojs migrate`).
- Not supported: `template` files, parallel routes (`@slot`), intercepting
  routes.
- Middleware is declarative: `middleware.ts` / `gio.toml` rules (redirects,
  rewrites, headers, guards) run in Rust; no JavaScript runs there per
  request. Per-request logic goes in `getServerSideProps`, a route handler, or
  a Node plugin's `onRequest` hook.
- i18n detects the locale (path, cookie, `Accept-Language`); translations are
  up to your library. No domain-based locales.

## Metadata and images

- No generated Open Graph images (`opengraph-image.tsx`); use a file in
  `public/` or a `route.ts` that returns an image.
- No file-based icons (`app/icon.png`), no `viewport` export, one sitemap
  only (no `generateSitemaps`).

## Running several instances

No shared backend (Redis or otherwise) yet:

- The page cache is per instance; `revalidateTag` / `revalidatePath` purge
  only the calling instance - call `POST /_gio/revalidate` on every instance.
- `[[rate_limits]]` buckets are in memory per instance (N instances allow N
  times the rate).
- WebSocket rooms are per server.
- Sessions are unaffected (encrypted cookies; share `GIO_SESSION_SECRET`).

## Static export

`gio export` produces HTML plus hydration, with no server behind it. Not
available in an export: route handlers, SSE, WebSockets, page actions,
per-request `getServerSideProps` (it runs once at export time), its
redirects, `notFound()` pages, dynamic routes without `getStaticPaths`,
caching/revalidation, `gio.toml` / `middleware.ts` rules, sessions, rate
limits, security headers, CSP nonces, CSRF checks, and image optimization
(`GioImage` renders its plain `src`).

## Content-Security-Policy

- Nonces need the GioJS server; `cspNonce()` is `undefined` in an export.
- `style-src` needs `'unsafe-inline'` (React `style` props and view-transition
  styles cannot carry a nonce).
- While a CSP uses `{nonce}`, a route handler response with its own
  `Content-Encoding` is refused with a 500.

## Platforms and packaging

- Prebuilt binaries: Linux x64 (glibc, musl), macOS x64/arm64, Windows x64.
  **Linux arm64 is not published yet**: build with
  `cargo build --release -p giojs-server` and pass it to
  `gio build standalone` via `GIO_STANDALONE_SERVER_BIN`, or build
  `linux/amd64` images. No Windows on ARM or FreeBSD binary.
- Standalone builds freeze the framework version and `GIO_PUBLIC_*` values;
  rebuild to change either.

## Requests and sessions

- Request bodies are buffered in memory: `[server] max_body_bytes` (2 MiB
  default), and roughly 48 MiB at most whatever the setting. Upload large
  files straight to object storage.
- Sessions are cookie-only: at most ~4 KB, and no server-side store to revoke
  a single session early.
