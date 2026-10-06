# {{PROJECT_NAME}} — GioJS app (agent notes)

This is a GioJS project: a Rust server owns HTTP, routing, caching,
compression, static files, and image optimization; a persistent Node worker
renders React. Full docs: https://giojs.com/llms.txt

## Conventions that differ from Next.js

- File routing lives in `app/`: `page.jsx` (pages), `layout.jsx` (nested
  layouts), `route.js` (API handlers exporting GET/POST/PUT/PATCH/DELETE),
  `not-found.jsx`, `error.jsx`. Dynamic segments: `[id]`; catch-all: `[...slug]`
  (one or more segments); optional catch-all: `[[...slug]]` (also matches the
  parent URL). Catch-all params are one string with `/` separators (`"a/b"`).
  `(group)` folders add no URL segment; `_folders` are private (never routed).
  Layouts apply by folder ancestry, so a `(group)/layout.jsx` wraps only that
  group.
- Data fetching is `export async function getServerSideProps(ctx)` returning
  `{ props }` (optionally `{ props, headers }` or a redirect). There are NO
  React Server Components, no `use client`/`use server`, no server actions.
- Never fetch inside a component render; never use `useEffect` for data that
  belongs in `getServerSideProps`.
- Caching: `export const revalidate = <seconds>` on a page enables ISR in the
  Rust cache (`false` = cache forever). Caching happens in Rust, never in Node.
  Reading `ctx.cookies` or `ctx.ip` (or the cookie/authorization header) in
  `getServerSideProps` makes that render per-user and uncached; personalize
  inside `<Suspense>` holes with `export const shell = 'cache'` instead.
- Client identity: `req.ip` / `ctx.ip` is the visitor's IP - never parse
  `x-forwarded-for` yourself; behind a reverse proxy set
  `[server] trusted_proxies` in `gio.toml`. `req.requestId` / `ctx.requestId`
  is the `X-Request-Id` response header, also on that request's log lines.
- `app/error.tsx` gets `{ error: { message, digest } }`; in production the
  message is always generic - log lookups go by `digest`.
- Components come from `@gio.js/react`: `<GioLink>` (client nav + prefetch),
  `<GioImage>` (points at the built-in `/_gio/image` optimizer — never add
  `sharp` or `next/image`). Route-handler types come from `@gio.js/core`
  (`GioRequest`, `GioEventStream` for SSE).
- WebSockets: export `wsHandler(socket)` from a `route.js`.
- Config is `gio.toml` (server, TLS, images.remote_patterns, rate_limits,
  fonts, i18n, websocket, metrics). There is no `[cache]`/redirects/rewrites
  section.
- Env: `.env.{mode}.local`, `.env.local`, `.env.{mode}`, `.env` load at server
  start (first wins; real env vars always win; restart after editing). Only
  `GIO_PUBLIC_*` variables reach client code (not `NEXT_PUBLIC_*`); any other
  `process.env.X` is `undefined` in the browser.
- Server-only modules: `import '@gio.js/core/server-only'` or name the file
  `*.server.js`. Using one from getServerSideProps/route handlers is fine;
  importing it from client code rejects that route's bundle (page renders but
  never hydrates).

## Commands

- `npm run dev` — dev server with watch mode + browser reload
- `npm start` — production server (no separate build step; routes and client
  bundles are built at startup)
- Health: `GET /_gio/health` · Dev dashboard: `/_gio/devtools` (dev only;
  answers localhost hosts only, add LAN IPs/hostnames to `[dev] allowed_hosts`)
