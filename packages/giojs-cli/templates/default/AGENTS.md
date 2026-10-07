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
  `{ props }` (optionally `{ props, headers }`, `{ props, tags }`, a redirect,
  or `{ notFound: true }`). There are NO
  React Server Components, no `use client`/`use server`, no server actions -
  forms post to a page `action` export instead (below).
- Types for all of this come from `@gio.js/core` (`import type`), never
  restated inline: `GetServerSideProps<Props, '/posts/:id'>` (types
  `ctx.params` and the result variants), `PageProps<'/posts/:id'>` (a page
  WITHOUT gSSP gets `{ params, searchParams }`; a page with gSSP gets exactly
  its props - `InferPageProps<typeof getServerSideProps>` or the Props type),
  `LayoutProps`, `ErrorPageProps`, `NotFoundPageProps`, `Metadata`,
  `GetStaticPaths<'/posts/:id'>`, `ActionArgs<'/posts/:id'>` and
  `WithActionData`, `RouteHandler<'/api/items/:id'>` / `GioRequest<...>` for
  route.ts. Route patterns are checked against the generated
  `.gio/routes.d.ts` (a typo fails `tsc`); a params shape (`{ id: string }`)
  works too.
- Forms/mutations: a page may `export async function action(req)`; POSTs to
  the page's own URL run it (`await req.formData()`, plus params/cookies/
  `getSession(req)` like route handlers). Return `redirect('/next')` (303,
  from `@gio.js/core`) after a change, `{ status: 422, data: { errors } }` to
  re-render the page with the `actionData` prop (also `ctx.actionData` in
  getServerSideProps), or a `Response`. Action answers are never cached;
  PUT/PATCH/DELETE on pages get 405 (use `route.ts`). Render forms with
  `<GioForm>` from `@gio.js/react` - a real `<form method="post">` that works
  without JavaScript and soft-navigates when hydrated; `useGioFormState()`
  gives `{ pending, lastResult }`. Uploads need
  `encType="multipart/form-data"` and stay under `[server] max_body_bytes`.
- Never fetch inside a component render; never use `useEffect` for data that
  belongs in `getServerSideProps`.
- Caching: `export const revalidate = <seconds>` on a page enables ISR in the
  Rust cache (`false` = cache forever). Caching happens in Rust, never in Node.
  Reading `ctx.cookies`, `ctx.ip`, `ctx.host` or `ctx.scheme` (or the
  cookie/authorization/host header) in `getServerSideProps` makes that render
  per-user and uncached; personalize inside `<Suspense>` holes with
  `export const shell = 'cache'` instead. Build absolute URLs on cached pages
  from a configured origin (env var), not `ctx.host`.
- Head tags: `export const metadata = { title, description, openGraph, ... }`
  or `export async function generateMetadata(ctx, { props })` (same `ctx` as
  getServerSideProps - credential reads make the page uncached; `props` are
  the page's gSSP props) in `page.tsx` and `layout.tsx`. Merged root layout →
  page, leaf wins per field; a layout sets `title: { default, template:
  '%s | Site' }`. Relative URLs resolve against `metadataBase` or
  `GIO_SITE_URL`. Don't render `<title>` or a description `<meta>` yourself in
  layouts or pages once you use metadata (the metadata title replaces any
  `<title>`; other tags are not deduplicated). Under `shell = 'cache'`,
  metadata built from the props of a gSSP that read cookies costs the shell
  its cache - use `ctx.params` there. `app/sitemap.ts`, `app/robots.ts` and
  `app/manifest.ts` serve `/sitemap.xml`, `/robots.txt` and
  `/manifest.webmanifest` (a `public/` file of the same name wins). JSON-LD:
  `<JsonLd data={...} />` from `@gio.js/react`.
- On-demand revalidation: tag cached pages (`export const tags = ['posts']`,
  or `tags` returned from `getServerSideProps`) and, after a write, call
  `await revalidateTag('posts')` / `await revalidatePath('/blog')` from
  `@gio.js/core` in the route handler - the next request renders fresh. CMS
  webhooks use `POST /_gio/revalidate` (needs `GIO_REVALIDATE_TOKEN`).
- Client identity: `req.ip` / `ctx.ip` is the visitor's IP - never parse
  `x-forwarded-for` yourself; behind a reverse proxy set
  `[server] trusted_proxies` in `gio.toml`. `req.host` is client-supplied -
  never a security check. `req.requestId` / `ctx.requestId` is the
  `X-Request-Id` response header, also on that request's log lines.
- `error.tsx` gets `{ error: { message, digest }, reset }`; in production the
  message is always generic - log lookups go by `digest`. It is also a client
  error boundary (shipped in the page bundles - no server-only imports), and
  `reset` exists only for errors caught in the browser; a caught error clears
  on the next navigation (a query-only one too).
- Components come from `@gio.js/react`: `<GioLink>` (client nav + prefetch;
  `replace`, `scroll={false}`), router hooks `usePathname()`, `useParams()`,
  `useSearchParams()` (read-only), `useLocale()` and `useRouter()` (`push`,
  `replace`, `back`, `forward`, `refresh`, `prefetch`) - SSR-safe, also in the
  root layout, which soft navigation never re-renders (URL-dependent UI goes
  below it, e.g. in a `(group)/layout`),
  `<GioImage>` (srcset from the gio.toml `[images]` allowed_widths, served by
  the built-in `/_gio/image` optimizer; `sizes`, `priority` to preload,
  `unoptimized` for a plain `src` — never add `sharp` or `next/image`). Route-handler types come from `@gio.js/core`
  (`GioRequest`, `GioEventStream` for SSE). A `Response` with a
  `ReadableStream` body streams to the client (LLM tokens, downloads, a
  hand-written `text/event-stream`); its `cancel()` runs on disconnect.
- CSS: `import './globals.css'` in `app/layout.tsx` for global styles, and
  `import styles from './card.module.css'` (default import,
  `className={styles.card}`) for CSS Modules - from any page, layout or
  component. Each route's CSS is bundled into hashed files and linked in
  `<head>` automatically: never add a `<link>` for an imported file. CSS
  an npm package ships is imported explicitly (`import 'pkg/styles.css'`).
  Tailwind: run the Tailwind CLI and import its generated `.css` file.
  CSS import types come from the generated `.gio/css-modules.d.ts`
  (referenced by `.gio/routes.d.ts`) - never add your own
  `declare module '*.module.css'`: it clashes with the generated one.
- WebSockets: export `wsHandler(socket)` from a `route.ts` (dynamic segments
  arrive in `socket.params`; `socket.cookies`/`headers`/`ip` authenticate it -
  return `false` to reject with close code 4401). Rooms: `socket.join(room)`,
  and `broadcast(room, data)` from `@gio.js/core` in any handler. Client:
  `useWebSocket(url)` from `@gio.js/react` reconnects with backoff.
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
  fonts, i18n, websocket, metrics, logging, security). There is no `[cache]`/redirects/rewrites
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
- Tests use `@gio.js/core/testing` (vitest or node:test; never import it
  from app code): `renderPage(path, { cookies, query, headers })` returns
  `{ status, html, props, setCookies, redirect, cacheable }` and
  `callRoute(path, { method, body })` a fetch-like response - both run
  in-process with the .env files loaded, without gio.toml/middleware.ts
  rules or [i18n] detection (pass the unprefixed path plus `locale`).
  `createTestServer()` starts the real server on a free port (`url`,
  `close()` in afterAll).
  Under vitest, mirror tsconfig `paths` as `resolve.alias`, and add
  `gioVitest()` from `@gio.js/core/vitest` to `plugins` so CSS Modules get
  the server's class names (vitest names them its own way).

## Commands

- `npm run dev` — dev server with watch mode + browser reload
- `npm start` — production server (no separate build step; routes and client
  bundles are built at startup)
- Health: `GET /_gio/health` · Dev dashboard: `/_gio/devtools` (dev only;
  answers localhost hosts only, add LAN IPs/hostnames to `[dev] allowed_hosts`)
