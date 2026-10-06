# {{PROJECT_NAME}} — GioJS app (agent notes)

This is a GioJS project: a Rust server owns HTTP, routing, caching,
compression, static files, and image optimization; a persistent Node worker
renders React. Full docs: https://giojs.com/llms.txt

## Conventions that differ from Next.js

- File routing lives in `app/`: `page.tsx` (pages), `layout.tsx` (nested
  layouts), `route.ts` (API handlers exporting GET/POST/PUT/PATCH/DELETE),
  `not-found.tsx`, `error.tsx`. Dynamic segments: `[id]`; catch-all: `[...slug]`
  (one or more segments); optional catch-all: `[[...slug]]` (also matches the
  parent URL). Catch-all params are one string with `/` separators (`"a/b"`).
  `(group)` folders add no URL segment; `_folders` are private (never routed).
  Layouts apply by folder ancestry, so a `(group)/layout.tsx` wraps only that
  group.
- Data fetching is `export async function getServerSideProps(ctx)` returning
  `{ props }` (optionally `{ props, headers }` or a redirect). There are NO
  React Server Components, no `use client`/`use server`, no server actions.
- Never fetch inside a component render; never use `useEffect` for data that
  belongs in `getServerSideProps`.
- Caching: `export const revalidate = <seconds>` on a page enables ISR in the
  Rust cache (`false` = cache forever). Caching happens in Rust, never in Node.
  Reading `ctx.cookies` (or the cookie/authorization header) in
  `getServerSideProps` makes that render per-user and uncached; personalize
  inside `<Suspense>` holes with `export const shell = 'cache'` instead.
- `app/error.tsx` gets `{ error: { message, digest } }`; in production the
  message is always generic - log lookups go by `digest`.
- Components come from `@gio.js/react`: `<GioLink>` (client nav + prefetch),
  `<GioImage>` (points at the built-in `/_gio/image` optimizer — never add
  `sharp` or `next/image`). Route-handler types come from `@gio.js/core`
  (`GioRequest`, `GioEventStream` for SSE).
- WebSockets: export `wsHandler(socket)` from a `route.ts`.
- Security runs in Rust: default headers (nosniff, `X-Frame-Options:
  SAMEORIGIN`, referrer policy) on every response, and cross-site
  POST/PUT/PATCH/DELETE or WebSocket upgrades get 403 (CSRF) - endpoints other
  sites call (webhooks) go in `[security.csrf] exempt`. `req.json()` requires
  `Content-Type: application/json` (otherwise 415). For a CSP put
  `'nonce-{nonce}'` in `[security] csp`; your own inline scripts then need
  `nonce={cspNonce()}` (from `@gio.js/core`).
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

## Commands

- `npm run dev` — dev server with watch mode + browser reload
- `npm start` — production server (no separate build step; routes and client
  bundles are built at startup)
- Health: `GET /_gio/health` · Dev dashboard: `/_gio/devtools` (dev only;
  answers localhost hosts only, add LAN IPs/hostnames to `[dev] allowed_hosts`)
