# {{PROJECT_NAME}} — GioJS app (agent notes)

This is a GioJS project: a Rust server owns HTTP, routing, caching,
compression, static files, and image optimization; a persistent Node worker
renders React. Full docs: https://giojs.com/llms.txt

## Conventions that differ from Next.js

- File routing lives in `app/`: `page.jsx` (pages), `layout.jsx` (nested
  layouts), `route.js` (API handlers exporting GET/POST/PUT/PATCH/DELETE),
  `not-found.jsx`, `error.jsx`, `loading.jsx`. Dynamic segments: `[id]`;
  catch-all: `[...slug]` (one or more segments); optional catch-all:
  `[[...slug]]` (also matches the parent URL). Catch-all params are one string
  with `/` separators (`"a/b"`).
  `(group)` folders add no URL segment; `_folders` are private (never routed).
  Layouts apply by folder ancestry, so a `(group)/layout.jsx` wraps only that
  group.
- `not-found.jsx`, `error.jsx` and `loading.jsx` work in any folder; the
  nearest one at or above a page wins. `notFound()` from `@gio.js/core` (or
  `{ notFound: true }` from getServerSideProps) answers 404 with the nearest
  `not-found.jsx`. `error.jsx` renders inside its folder's layout and never
  catches that layout's own errors. `loading.jsx` is a `<Suspense>` fallback
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
  Reading `ctx.cookies` (or the cookie/authorization header) in
  `getServerSideProps` makes that render per-user and uncached; personalize
  inside `<Suspense>` holes with `export const shell = 'cache'` instead.
- `error.jsx` gets `{ error: { message, digest }, reset }`; in production the
  message is always generic - log lookups go by `digest`. It is also a client
  error boundary (shipped in the page bundles - no server-only imports), and
  `reset` exists only for errors caught in the browser.
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
