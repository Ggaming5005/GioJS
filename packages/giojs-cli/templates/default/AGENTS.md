# {{PROJECT_NAME}} — GioJS app (agent notes)

This is a GioJS project: a Rust server owns HTTP, routing, caching,
compression, static files, and image optimization; a persistent Node worker
renders React. Full docs: https://giojs.com/llms.txt

## Conventions that differ from Next.js

- File routing lives in `app/`: `page.tsx` (pages), `layout.tsx` (nested
  layouts), `route.ts` (API handlers exporting GET/POST/PUT/PATCH/DELETE),
  `not-found.tsx`, `error.tsx`, `loading.tsx`. Dynamic segments: `[id]`;
  catch-all: `[...slug]` (one or more segments); optional catch-all:
  `[[...slug]]` (also matches the parent URL). Catch-all params are one string
  with `/` separators (`"a/b"`).
  `(group)` folders add no URL segment; `_folders` are private (never routed).
  Layouts apply by folder ancestry, so a `(group)/layout.tsx` wraps only that
  group.
- `not-found.tsx`, `error.tsx` and `loading.tsx` work in any folder; the
  nearest one at or above a page wins. `notFound()` from `@gio.js/core` (or
  `{ notFound: true }` from getServerSideProps) answers 404 with the nearest
  `not-found.tsx`. `error.tsx` renders inside its folder's layout and never
  catches that layout's own errors. `loading.tsx` is a `<Suspense>` fallback
  for content that suspends while rendering - it does not cover
  getServerSideProps, which runs before rendering.
- Data fetching is `export async function getServerSideProps(ctx)` returning
  `{ props }` (optionally `{ props, headers }`, a redirect, or
  `{ notFound: true }`). There are NO
  React Server Components, no `use client`/`use server`, no server actions.
- Never fetch inside a component render; never use `useEffect` for data that
  belongs in `getServerSideProps`.
- Caching: `export const revalidate = <seconds>` on a page enables ISR in the
  Rust cache (`false` = cache forever). Caching happens in Rust, never in Node.
  Reading `ctx.cookies`, `ctx.ip`, `ctx.host` or `ctx.scheme` (or the
  cookie/authorization/host header) in `getServerSideProps` makes that render
  per-user and uncached; personalize inside `<Suspense>` holes with
  `export const shell = 'cache'` instead. Build absolute URLs on cached pages
  from a configured origin (env var), not `ctx.host`.
- Client identity: `req.ip` / `ctx.ip` is the visitor's IP - never parse
  `x-forwarded-for` yourself; behind a reverse proxy set
  `[server] trusted_proxies` in `gio.toml`. `req.host` is client-supplied -
  never a security check. `req.requestId` / `ctx.requestId` is the
  `X-Request-Id` response header, also on that request's log lines.
- `error.tsx` gets `{ error: { message, digest }, reset }`; in production the
  message is always generic - log lookups go by `digest`. It is also a client
  error boundary (shipped in the page bundles - no server-only imports), and
  `reset` exists only for errors caught in the browser.
- Components come from `@gio.js/react`: `<GioLink>` (client nav + prefetch),
  `<GioImage>` (srcset from the gio.toml `[images]` allowed_widths, served by
  the built-in `/_gio/image` optimizer; `sizes`, `priority` to preload,
  `unoptimized` for a plain `src` — never add `sharp` or `next/image`). Route-handler types come from `@gio.js/core`
  (`GioRequest`, `GioEventStream` for SSE).
- WebSockets: export `wsHandler(socket)` from a `route.ts`.
- Security runs in Rust: default headers (nosniff, `X-Frame-Options:
  SAMEORIGIN`, referrer policy) on every response, and cross-site
  POST/PUT/PATCH/DELETE or WebSocket upgrades get 403 (CSRF) - endpoints other
  sites post to on purpose (OAuth/OIDC form_post or SAML callbacks, 3-D Secure
  returns, webhooks sending an Origin) go in `[security.csrf] exempt`.
  `[security.csrf] enabled = false` keeps the WebSocket check
  (`[security.websocket] check_origin`). `req.json()` requires
  `Content-Type: application/json` (otherwise 415). For a CSP put
  `'nonce-{nonce}'` in `[security] csp`; your own inline scripts then need
  `nonce={cspNonce()}` (from `@gio.js/core`). Keep `style-src 'self'
  'unsafe-inline'` with no nonce: `style` props and the `<Animate>` / `<Link>`
  transition styles carry none.
- Auth: `createSessionStorage()` from `@gio.js/core` (in a `lib/session.server.ts`)
  gives encrypted cookie sessions (`getSession(ctx|req)`, `commitSession`,
  `destroySession`; secret from `GIO_SESSION_SECRET`, required in
  production). Protect paths with `[[guards]] require_session = true` in
  gio.toml (verified in Rust). Build other cookies with `serializeCookie`,
  never by string concatenation.
- Config is `gio.toml` (server, TLS, images.remote_patterns, rate_limits,
  fonts, i18n, websocket, metrics, security). There is no `[cache]`/redirects/rewrites
  section.
- Env: `.env.{mode}.local`, `.env.local`, `.env.{mode}`, `.env` load at server
  start (first wins; real env vars always win; restart after editing). Only
  `GIO_PUBLIC_*` variables reach client code (not `NEXT_PUBLIC_*`); any other
  `process.env.X` is `undefined` in the browser.
- Server-only modules: `import '@gio.js/core/server-only'` or name the file
  `*.server.ts`. Using one from getServerSideProps/route handlers is fine;
  importing it from client code rejects that route's bundle (page renders but
  never hydrates).
- Static export (`gio export` → `out/`): dynamic routes need
  `export function getStaticPaths()` listing their params; pages still
  hydrate (client JS ships under `out/_next/`), `GIO_PUBLIC_*` values are
  frozen at export time, and `<GioImage>` renders plain `src` (no optimizer
  on a static host).

## Commands

- `npm run dev` — dev server with watch mode + browser reload
- `npm start` — production server (no separate build step; routes and client
  bundles are built at startup)
- Health: `GET /_gio/health` · Dev dashboard: `/_gio/devtools` (dev only;
  answers localhost hosts only, add LAN IPs/hostnames to `[dev] allowed_hosts`)
