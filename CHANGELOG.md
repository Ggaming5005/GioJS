# Changelog

All notable changes to this project will be documented in this file.

## 0.1.0-beta.8 (unreleased)

This release is about running GioJS in production. The server decides the
runtime mode, error details and personalized pages no longer reach other
visitors, connections are bounded, and security headers, CSRF and WebSocket
origin checks are on by default, with encrypted sessions that guards verify in
Rust. It also adds the everyday app features beta.7 lacked - catch-all routes,
per-folder error, loading and not-found files, page actions and forms,
on-demand revalidation, metadata, CSS imports and CSS Modules, router hooks, a
worker pool and a testing kit - plus a real `gio` CLI and a scaffolder whose
starter uses all of it. Several defaults changed: read the upgrade notes
first.

### Upgrade notes (breaking changes)

- **The server decides the runtime mode.** The Node worker now runs in the
  server's mode: `development` only when the server starts with
  `NODE_ENV=development`, `production` otherwise. An unset `NODE_ENV` used to
  run a development worker (dev bundles, sourcemaps, error stacks) behind a
  production server. `npm start` needs no change; to develop, set
  `NODE_ENV=development` (`npm run dev`, or the new `gio dev`). New starters'
  `start` script is `cross-env NODE_ENV=production giojs-server`, with
  `cross-env` a regular dependency. `gio export` follows the same rule.
- **`.env` files are loaded.** At startup the server reads
  `.env.{mode}.local`, `.env.local`, `.env.{mode}` and `.env` from the project
  root (Next.js precedence; variables already in the environment win), and
  passes them to the worker. Check what committed `.env` files would now
  apply. `NODE_ENV` in a `.env` file is ignored, and a file that cannot be
  parsed stops startup.
- **`gio.toml` is strict.** An unknown section or key anywhere stops startup
  with the file, line and closest valid key
  (`gio.toml:5: unknown key [image] - did you mean [images]?`). Keys that
  never did anything are rejected with what to do instead: `[cache] memory_mb`
  (use `memory_max_entries`), `[cache.redis]` (no Redis backend yet),
  `[css] engine` and `[prefetch] strategy` (set per `<GioLink prefetch>`).
  Tables for other tools must be named `[x-...]`. A malformed
  `[metrics] ip_allowlist` entry stops startup like a malformed
  `trusted_proxies` one (it used to match nobody, so every scrape got `403`).
  `giojs-server --check-config` lists every problem in one run, in line
  order: each unknown key and section, each invalid value, each rule that
  cannot be enforced and each `[i18n]` mistake. A rule table, or the
  `[i18n]` locales, holding a misspelled or invalid key is checked once that
  key is fixed, and a required key whose value is invalid (`path = 3`) ends
  the list there.
- **`gio.config.ts` is validated at boot:** unknown keys and plugins without a
  `name` are errors.
- **The server binary refuses arguments it does not take.** `giojs-server`
  (and a standalone build's `run.mjs`) takes `--check-config` alone; any other
  argument, such as `--version` or `--port 4000`, exits with 2 and starts
  nothing. It used to be ignored, and the server started. Configure the
  server with `gio.toml` and environment variables (`GIO_PORT`), and use
  `gio --version` for versions.
- **Broken rules stop startup.** A `[[guards]]` entry with a misspelled key,
  no requirement or an invalid path now fails startup instead of being skipped
  with a warning, and so does a `[[redirects]]`, `[[rewrites]]` or
  `[[headers]]` rule that cannot be compiled (a relative pattern, a
  catch-all that is not last, an unknown capture, a bad status or header). A
  redirect or rewrite `to` or a guard's `redirect_to` must be a path on this
  site: `//evil.com` and `/\evil.com`, which a browser reads as another
  site, are refused.
- **`middleware.ts` is strict and fails closed.** A file that throws while
  it loads, has no default export, or holds a rule that cannot be enforced
  (an invalid pattern, a malformed field, an unknown key, a guard without a
  requirement, a target that leaves the site) stops the worker at boot with
  every problem listed: in
  production the server exits 1 with the error, in development it waits
  for the fix (and a later breakage answers `503` until the next save). It
  used to drop the rules - every rule, guards included, for a file that
  threw - with a warning while the app served. The integration fixture's
  deliberately malformed guard is gone with it.
- **`[i18n]` is checked.** An unknown `detect_from` value (with the closest
  valid one), a `default_locale` that is not one of a non-empty `locales`,
  and an empty or duplicate locale stop startup; they used to be ignored.
- **The page cache directory** (`[cache] disk_path` or `GIO_CACHE_DIR`) may no
  longer be, contain or sit inside `app/` or `public/`.
- **`0` lifts a limit everywhere in `gio.toml`,** as it already did in
  `[server]`. `[websocket] max_connections = 0` closed every socket with 1013,
  `[websocket] ping_interval_secs = 0` crashed every WebSocket connection, and
  `[images] max_remote_bytes = 0` rejected every remote image. Each now means
  unlimited (no pings, for `ping_interval_secs`); to refuse WebSockets, set
  `[websocket] enabled = false`. The `[prefetch]` keys, which no earlier
  release read, follow the same rule from the start: `max_concurrent` or
  `max_per_second = 0` lifts that budget, and `[prefetch] enabled = false`
  turns prefetching off.
- **CSRF protection is on.** Cross-site `POST`/`PUT`/`PATCH`/`DELETE` requests
  (judged by `Sec-Fetch-Site`, or `Origin` against the request's host) get
  `403` in Rust before Node runs. Requests without browser headers (curl,
  server-to-server webhooks) pass. Add endpoints other sites post to on
  purpose - OAuth/OIDC `response_mode=form_post` callbacks (Sign in with
  Apple, Entra ID), SAML ACS endpoints, 3-D Secure returns - to
  `[security.csrf] exempt`, and your other origins to `trusted_origins`.
  Behind nginx keep `proxy_set_header Host $host`, or set `trusted_proxies` so
  `X-Forwarded-Host` counts.
- **Cross-origin WebSocket upgrades get `403`.** Allow an origin with
  `[security.csrf] trusted_origins`, or turn the check off with
  `[security.websocket] check_origin = false`.
- **Security headers by default.** Every response carries
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` and
  `Referrer-Policy: strict-origin-when-cross-origin` (plus HSTS when
  `[server.tls]` is on), and `X-Powered-By` is removed. A site embedded in
  frames on other origins must override `x-frame-options` in
  `[security.headers]` (`""` removes it) or with a `[[headers]]` rule.
- **`req.json()` requires a JSON content type.** In route handlers it throws
  `UnsupportedMediaTypeError` - a `415` unless caught - for a body not sent as
  `application/json` or `application/*+json`. Make `fetch()` callers send
  `Content-Type`. An empty, non-UTF-8 or unparseable JSON body throws
  `MalformedBodyError` - a `400` unless caught - instead of a `SyntaxError`
  or a plain `Error` (a `500`); a `catch` testing `err instanceof SyntaxError`
  should test `isMalformedBodyError(err)`.
- **Personalized renders are no longer cached.** A page that exports
  `revalidate` but whose `getServerSideProps` reads `ctx.cookies`, the
  `cookie` or `authorization` header, `ctx.ip`, `ctx.host` or `ctx.scheme` (or
  the raw client-address and host headers), or headers an `onRequest` plugin
  changed, renders per request and is never stored, and neither is any
  response that sets a cookie or a render an `onRequest` plugin rewrote (path,
  query or locale) after reading those headers. Pages that read cookies used
  to be cached and served to everyone. A warning names each route: drop
  `revalidate`, or cache the shell with `shell = 'cache'` and personalize
  inside Suspense holes that suspend.
- **Production errors show only a digest.** A failed render answers a generic
  page with a short error reference, and the message and stack are logged
  under the same digest. `error.tsx` now receives
  `{ error: { message, digest } }`, where `message` is `Internal Server Error`
  in production. Route-handler `500`s carry the digest.
- **`error.tsx` runs in the browser too.** It is now a client error boundary
  bundled into every page below its folder, so it must be browser-safe: one
  that imports server-only code leaves those pages without hydration, and the
  build error names the file.
- **App Router folder rules.** `(group)` folders no longer appear in URLs, and
  `_private` folders are never routed - move routes out of `_`-prefixed
  folders. `[...slug]` matches one or more segments and `[[...slug]]` zero or
  more; the param is one `/`-joined string (`'a/b'`, or `''` for an optional
  catch-all that matched nothing). Layouts come from the folder tree, so
  layouts inside dynamic folders and route groups now apply. Two files that
  answer the same URLs fail startup, naming both.
- **`public/` is served at the site root** (`/favicon.ico`, `/robots.txt`,
  `/.well-known/...`), ahead of Node: a public file wins over a page with the
  same path. `public/` now defaults to the directory next to `app/`
  (`GIO_PUBLIC_DIR` overrides it), and CSS Module files under `app/` are no
  longer served by path.
- **`/_gio/` is reserved.** Paths under it that are not built-in endpoints
  answer `404` from Rust and never reach the app; the dev-only
  `/_gio/devtools*` endpoints `404` in production.
- **Request paths are canonical.** Rules and rate limits match the path with
  repeated and trailing slashes collapsed and escapes of unreserved characters
  decoded, and the app sees those escapes decoded too. Paths with `.`/`..`
  segments or a `%` that does not start a valid escape get `400`.
- **`*rest` matches zero segments.** In guards, redirects, rewrites and header
  rules (`gio.toml` and `middleware.ts`), `/admin/*rest` now also matches
  `/admin`, and `/old/*rest -> /new/*rest` sends `/old` to `/new`. A
  `[[rate_limits]]` path like `/api/*` also covers `/api`. Header rules now
  also apply to redirect and guard responses, and match the requested path
  rather than a rewritten one.
- **Cookies in plugins and header rules.** Cookies a page or route handler
  sets reach an `onResponse` plugin in `res.setCookies`, not
  `res.headers['set-cookie']` - set `setCookies: []` to strip them. A
  `set-cookie` header rule adds its cookie next to the response's own instead
  of replacing them.
- **Idle HTTP/1.1 keep-alive connections close after 10 seconds**
  (`header_read_timeout_secs`); before, they were never closed. Proxies that
  pool upstream connections longer (nginx `keepalive`, ingress-nginx and AWS
  ALB default to 60 s) can answer with intermittent `502`s: keep the proxy's
  upstream idle timeout below 10 s, or raise `header_read_timeout_secs` and
  `idle_timeout_secs` above it.
- **Dev endpoints answer only local hosts.** `/_gio/devtools*` (dashboard,
  error-overlay codeframes, open-in-editor) refuse other `Host` values and
  cross-site requests, and accept a localhost `Host` only on a connection from
  the same machine. If you open the dev server from a VM, a container host
  (including `localhost` through a container port mapping), another device or
  a tunnel, add that host to `[dev] allowed_hosts`.
- **Pages send `Cache-Control`.** Cached pages now carry
  `public, max-age=0, s-maxage=<revalidate>, stale-while-revalidate=...`, so a
  CDN in front of GioJS caches them for `s-maxage`, and an on-demand purge
  does not reach it. Override it with a `[[headers]]` rule or from the app
  where that is not wanted.
- **Bare `gio` no longer starts a server.** It prints the help and exits with
  code 2, and an unknown command or option is an error with a did-you-mean.
  Use `gio start` (production) or `gio dev`. The `giojs-server` bin is
  unchanged.
- **WebSocket changes.** `useWebSocket` reconnects by default, with backoff
  (pass `reconnect: false` for the old behavior). On the server, a path with
  no `wsHandler` closes with `4404`, and an async `wsHandler` now decides the
  connection: the socket gets broadcasts only once the handler resolves (to
  anything but `false`), and a rejected promise closes it with `1011`. A
  handler that awaits for the socket's whole lifetime should return once its
  listeners are set up.
- **`gio export` ships hydration.** Exported pages include client bundles
  (`out/_next/static/chunks/`) and their `getServerSideProps` props as JSON,
  as served pages always did - never return secrets from it. `public/` is also
  copied to the root of `out/`, and the generated `robots.txt` and
  `sitemap.xml` yield to files in `public/`.
- **Typed routes use a global registry.** `.gio/routes.d.ts` now fills
  `GioJS.RegisteredRoutes`, which `href()`, `useParams()` and the
  `@gio.js/core` types read. Routes added by hand to `@gio.js/react`'s
  `GioRegisteredRoutes` still type `href()`; move them to
  `declare global { namespace GioJS { interface RegisteredRoutes { ... } } }`
  so the core types see them.
- **`create-giojs` is stricter.** Unknown flags are an error, a non-empty
  target directory needs `--force`, and the new app gets `git init` and a
  first commit (`--no-git` skips it).
- **Building the server from source needs Rust 1.89** or newer (`rust-version`
  in `Cargo.toml`, checked in CI).
- **`/_gio/metrics` answers only this machine by default.** A `[metrics]`
  section with neither a `token` nor an `ip_allowlist` used to serve every
  client, with a startup warning; it now answers loopback clients only (the
  client after `trusted_proxies` resolution) and `403` to everyone else. Set a
  `token` or an `ip_allowlist` for your scraper, or
  `ip_allowlist = ["0.0.0.0/0", "::/0"]` to keep it open (startup warns).
  Behind a reverse proxy on the same machine, list it in
  `[server] trusted_proxies`: otherwise every client it forwards connects from
  `127.0.0.1`. Such requests get a `403` when they carry `X-Forwarded-For`,
  `Forwarded` or `X-Real-IP`, but a proxy that sends none of those makes every
  client look local, and the endpoint answers them.
- **`[server] max_body_bytes = 0` means no limit of its own.** It used to
  answer `413` to every request with a body. Bodies are now bounded only by
  the worker's 64 MiB message cap (about 48 MiB of binary body), and startup
  warns.
- **`[dev] allowed_hosts = ["*"]` answers any host.** The entry used to be
  dropped as invalid; it now opens the dev endpoints and error details to
  every `Host` from every machine, with a startup warning. open-in-editor
  still needs a same-origin request.

### Security

- **No cross-visitor cache leaks.** Renders that read cookies, credentials,
  the client's IP, host or scheme, or headers a plugin changed, renders an
  `onRequest` plugin rewrote (path, query or locale) after reading
  credentials, and responses that set cookies, are never cached or shared
  between concurrent requests, whatever `revalidate` says. A spoofed `Host`
  can no longer poison the cache. With PPR, the hydration props now stream
  after the shell boundary, and a shell holding Suspense content rendered
  from a credential-reading `getServerSideProps` (a hole that did not
  suspend, or resolved before the shell was sent) is not stored. Rendering
  those props outside a Suspense hole still breaks the PPR contract.
- **The `/_gio` namespace is closed.** `/_gio/settings` could render
  `app/[org]/settings` with `org = "_gio"` without running its guard; unknown
  `/_gio/` paths now `404` in Rust.
- **Rules cannot be sidestepped by spelling.** Rate limits, guards, redirects,
  rewrites and header rules match the canonical path, so `/api/login/`,
  `//api/login`, `/api//login` and `/api/%6Cogin` no longer slip past a rule
  for `/api/login`. A raw `\` in a path gets `400` (a redirect target built
  from it would send browsers to another host), as does an escaped `%2F` or
  `%5C` under `/public/`; a root-served public file never answers such a
  spelling, so `/members%2Freport.txt` cannot reach `public/members/report.txt`
  past the rules for `/members/*`.
- **Guards cover the image optimizer.** A local `/_gio/image` `src` is held to
  the guards of the file's root and `/public/...` URLs: a visitor the guard
  would turn away gets `403`, and an admitted one gets the image as
  `private, no-cache` instead of `public, immutable`.
- **No error details in production responses**, including `gio export` output
  and streamed Suspense errors (which render `data-dgst` instead of a
  message). The real error is logged under the digest.
- **Bounded rate limiter.** At most 100k buckets (refilled buckets are dropped
  first, then the least recently seen), IPv6 clients are limited per /64, and
  long windows (5 per hour) are no longer reset after 5 idle minutes.
- **Connection limits.** New `[server]` settings bound open connections and
  slow clients: `max_connections` (10000, a server-wide cap, not a per-client
  one), `tls_handshake_timeout_secs` (10),
  `header_read_timeout_secs` (10, the slowloris guard),
  `request_body_timeout_secs` (30; slow uploads get `408`),
  `idle_timeout_secs` (60), `http2_max_concurrent_streams` (250) and HTTP/2
  keep-alive pings (`http2_keep_alive_interval_secs` /
  `http2_keep_alive_timeout_secs`, 20/20). `0` disables one. Streaming SSR,
  SSE and WebSockets are never cut, and HTTP/1.1 responses carry
  `Keep-Alive: timeout=N`.
- **Dev server lockdown.** `/_gio/devtools*` endpoints answer only localhost
  names, loopback IPs, a specific `[server] host` and `[dev] allowed_hosts`,
  which blocks DNS-rebinding source reads. Cross-site requests are refused,
  and open-in-editor takes same-origin `POST` only, so a website can no longer
  launch your editor. Codeframes and open-in-editor resolve symlinks before
  checking the project root, so a source-named symlink cannot expose `.env`.
  Dev error pages served to other hosts leave out the message and stack.
  Localhost names and loopback IPs count only on a loopback connection, so a
  LAN client cannot get in by sending `Host: localhost` to the starter's
  `0.0.0.0` bind; it must name the bind address or an `allowed_hosts` entry,
  and listing one opens the endpoints to everyone who can reach the port.
- **Default security headers** on every response: pages, cache hits, route
  handlers, static and public files, redirects, errors and `/_gio` endpoints.
  Behind a TLS-terminating proxy, `[security] hsts = true` (or a table or raw
  string) turns HSTS on. `[security.headers]` overrides a default, removes it
  with `""`, or adds opt-in headers such as Permissions-Policy, COOP and CORP.
  Headers the app or a `[[headers]]` rule sets always win.
- **Content-Security-Policy with per-response nonces.** `[security] csp` and
  `csp_report_only` accept `{nonce}`. Every response gets a fresh 192-bit
  nonce, which every framework inline script carries: the hydration bootstrap,
  React's Suspense scripts, the deployment script, critical CSS and the dev
  overlay. Cache hits and PPR shells are covered too: the worker renders a
  secret placeholder that Rust replaces at serve time, so stored markup never
  holds a valid nonce. `cspNonce()` from `@gio.js/core` gives your own inline
  scripts the nonce. Keep `style-src 'self' 'unsafe-inline'`, since `style`
  props carry no nonce.
- **CSRF protection** for `POST`/`PUT`/`PATCH`/`DELETE`, on by default and
  enforced in Rust before the body is read (see the upgrade notes); configure
  it with `[security.csrf] trusted_origins` and `exempt`.
- **WebSocket origin check** against cross-site WebSocket hijacking, with its
  own switch, `[security.websocket] check_origin`, so it stays on when CSRF
  protection is disabled.
- **Trusted proxies.** `[server] trusted_proxies` (IPs and CIDRs; default:
  trust nobody) decides whose `X-Forwarded-For`, `X-Forwarded-Proto` and
  `X-Forwarded-Host` count (`proxy_headers = "forwarded"` reads RFC 7239
  `Forwarded` instead). The client address is walked right to left past
  trusted hops, so nothing a client writes is ever read. Rate limits, prefetch
  budgets, the `[metrics] ip_allowlist` (which now accepts CIDRs) and logs use
  the resolved client. An incoming `X-Request-Id` is kept only from a trusted
  proxy (`accept_request_id = false` always generates one).
- **Encrypted cookie sessions.** `createSessionStorage()` from `@gio.js/core`
  keeps session data in the cookie, encrypted with AES-256-GCM and signed,
  with `getSession(ctx | req)`, `commitSession(session)` and
  `destroySession()`. Secrets come from `GIO_SESSION_SECRET`: each at least 32
  bytes, comma-separated to rotate (the first signs, all verify). Production
  refuses to create a session storage without one; development generates an
  ephemeral secret. Expired or tampered cookies read as an empty session.
- **Guards that verify sessions.** `[[guards]] require_session = true`
  (`requireSession: true` in `middleware.ts`) checks the session's signature
  and expiry in Rust before any Node code runs; without a valid secret it
  denies every request. `require_cookie` guards still only check that the
  cookie exists.
- **Cookie helpers.** `serializeCookie` has secure defaults (HttpOnly,
  SameSite=Lax, Secure in production) and throws on values that could inject
  headers or attributes. Also new: `parseCookies`, and `signValue` /
  `unsignValue` (HMAC-SHA256, constant-time comparison, key rotation).
- The reference auth plugin (`packages/giojs-auth-example`) trusted any cookie
  containing `session=valid`. It is now `createAuthPlugin({ sessions })` on
  real sessions, and `examples/auth-demo` is a complete login, guard and
  logout flow.
- **Server code stays out of the browser.** `getServerSideProps` and
  `getStaticPaths`, and every module or package only they import (with
  `import` or `import()`), are tree-shaken from client bundles in every export
  form, including `export ... from` and `export *`. Importing
  `@gio.js/core/server-only` (or `server-only`), or naming a file
  `*.server.ts`, marks a module server-only: a route whose client bundle
  pulls one in is rejected with the import chain. Only `GIO_PUBLIC_*`
  variables reach client code.
- **Supply chain.** Release binaries are built from a committed `Cargo.lock`
  with `--locked`. GitHub Actions are pinned to commit SHAs and the `cross`
  install to an exact revision. `cargo-deny` checks advisories, licenses and
  sources on every PR, and a vulnerable or unsound crate blocks a release;
  production npm dependencies go through `pnpm audit`, and both audits also
  run weekly. Dependabot opens weekly update PRs. `SECURITY.md` explains how
  to report a vulnerability privately.

### Routing

- **Catch-alls, groups and private folders.** `[...slug]`, `[[...slug]]`,
  `(group)` folders and `_private` folders follow the App Router conventions
  (see the upgrade notes).
- **Layouts follow the folder tree.** A page gets the `layout.tsx` of every
  folder from `app/` down to its own, including inside dynamic folders and
  route groups, and the client bundle wraps the same layouts the server
  rendered.
- **Deterministic matching.** Precedence is static > `[id]` > `[...slug]` >
  `[[...slug]]`, compared segment by segment from the left, for `page.tsx` and
  `route.ts` alike: a catch-all `route.ts` never shadows the pages below it.
  Conflicting files fail startup naming both, and param names containing `?`,
  `:` or `*` are rejected.
- **Per-folder `not-found.tsx`, `error.tsx` and `loading.tsx`.** All three
  work in any folder of `app/`. The nearest one at or above a page applies and
  renders inside its own folder's layouts, nested layout > error boundary >
  Suspense as in the App Router; an `error.tsx` never catches its own folder's
  layout.
- **`notFound()`** from `@gio.js/core`, or `{ notFound: true }` from
  `getServerSideProps`, answers `404` with the nearest `not-found.tsx`. It
  works in `getServerSideProps`, during render, and in `route.ts` handlers (as
  a JSON 404). 404s are never cached.
- **`error.tsx` is a client error boundary.** After hydration a render error
  replaces only that segment, and the component gets `{ error, reset }`.
  Server-side failures still answer `500` with the nearest `error.tsx`.
- **`loading.tsx`** wraps its folder in `<Suspense>`, so a streamed page sends
  the loading UI first. A page that throws or calls `notFound()` before it
  suspends still gets its `500`/`404`; after it has suspended, errors fall
  back to React's client-side recovery, so the answer is a `200`. With
  `shell = 'cache'` the boundary is the edge of the PPR shell.
- Typed routes: an optional catch-all is `*slug?`, and `href('/shop/*path?')`
  returns `/shop`.
- `getStaticPaths` works for catch-all and optional catch-all routes, with
  strings or segment arrays. Invalid entries are skipped with a reason,
  nothing is written outside `out/`, and a root catch-all no longer replaces
  `404.html`.
- **A `route.ts` that throws while it is imported answers `500`.** It used to
  be skipped with a warning, so its URL answered `404` (or a same-folder page
  took it over). Every method, `OPTIONS` included, now answers the JSON `500`
  with a `digest`, and a WebSocket connection to it is closed with `1011`
  (reason `internal error (digest ...)`) instead of the `4404` of a path with
  no `wsHandler`; the log names the file and the error once at startup and per
  request or connection under the digest, development shows the error in the
  response, and `gio routes` still marks it `(failed to load)` and says the
  server answers `500` for it (it used to say the server skips it). A
  module-scope `createSessionStorage()` without `GIO_SESSION_SECRET` in
  production, or a required-variable check in `lib/env.server.ts`, is such a
  throw.

### Data, forms and mutations

- **Page actions.** `export async function action(req)` in a page handles a
  `POST` to its URL. `req` is the route-handler request plus
  `await req.formData()` (urlencoded and multipart, files as `File` objects).
  Return `redirect(url)` from `@gio.js/core` (`303` by default, for
  Post/Redirect/Get), `{ status: 422, data }` or plain data to re-render the
  page with an `actionData` prop (also `ctx.actionData`), or a web `Response`.
  Action answers and re-renders are never cached.
- **`<GioForm>`** from `@gio.js/react`: a real `<form method="post">` that
  works without JavaScript. Once hydrated it submits with `fetch` and shows
  the redirect target or the re-rendered page through the client router, so
  layouts and typed input survive. It provides `useGioFormState()`
  (`{ pending, lastResult }`), `onSuccess`, `onError`, `resetOnSuccess`,
  `reloadDocument`, a double-submit guard and `aria-busy`, never sends a
  submission twice once the action may have run, and follows redirects to
  other sites. It submits natively again only answers the server marks as
  refused before the action ran (`x-gio-refused: unread` on its rate-limit
  `429` and `max_body_bytes` `413`), never a `413` or `429` the action or a
  `route.ts` returned itself.
- `redirect()` also works in `getServerSideProps` and `route.ts` handlers,
  returned or thrown, with a relative URL sent as written
  (`Response.redirect('/path')` throws: the web standard wants an absolute
  URL). Only the value `redirect()` returns is a redirect: a handler that
  returns parsed JSON with the same keys answers JSON. Every `redirect()`
  answer (and the `{ redirect }` form of `getServerSideProps`) carries
  `Cache-Control: private, no-cache` unless its headers set one, so a shared
  cache never stores a per-user `301`/`308`. Headers an action returns with
  its data are sent even when `getServerSideProps` then redirects or calls
  `notFound()`. Typed contract:
  `ActionArgs<Params>`,
  `ActionResult`, `ActionData<typeof action>` and
  `WithActionData<typeof action, Props>`.
- Route handlers get `req.formData()` too. A body sent as something other than
  a form is a `415`, and a malformed one a `400` (`MalformedBodyError`)
  instead of a `500` - for `req.json()` as well.
- **Several cookies per response.** Each `Set-Cookie` of a route-handler
  `Response` (`headers.append('Set-Cookie', ...)`) is sent as its own header,
  byte for byte; before, only the last one arrived. `getServerSideProps`
  accepts `headers: { 'set-cookie': [...] }`, redirects may carry `headers`
  (clearing cookies on logout), and Node plugins can add cookies through
  `setCookies`.
- **Request context.** `req.ip`, `req.scheme`, `req.host` and `req.requestId`
  in route handlers, and the same fields on the `getServerSideProps` context.
- **`.env` files** with Next.js precedence for the server, `gio export` and
  `gio build standalone`. Only file names are logged; a parse error names the
  file and line.
- **`GIO_PUBLIC_*` variables** set at build time are inlined into client
  bundles, and `process.env` in the browser holds only those. Any other
  `process.env.X` is `undefined` there instead of throwing
  `process is not defined`. Standalone builds and exports freeze the values.

### Rendering, caching and revalidation

- **On-demand revalidation.** Tag pages with `export const tags = ['posts']`,
  or per render with `return { props, tags: ['post:42'] }`, then call
  `await revalidateTag('post:42')` or
  `await revalidatePath('/blog', { type: 'prefix' })` from `@gio.js/core`.
  Purges cover memory and disk, PPR shells included, and resolve
  `{ ok, purged }` once the server has confirmed them (a timeout gives
  `ok: false` and a warning, not an exception). A render already running when
  a purge lands is served but not stored, so it cannot undo the purge.
- **`POST /_gio/revalidate`** for CMS webhooks and scripts:
  `{ "tags"?: [...], "paths"?: [...], "prefix"?: bool }` with
  `Authorization: Bearer <token>`. It exists only when `GIO_REVALIDATE_TOKEN`
  or `[revalidate] token` (at least 32 bytes) is set; the token is compared in
  constant time, and 10 failed attempts in a minute get `429`.
- **HTTP caching for pages.** Cached pages send
  `Cache-Control: public, max-age=0, s-maxage=..., stale-while-revalidate=...`
  and a weak `ETag` (one tag covers the page's gzip, br and uncompressed
  bytes), and a matching `If-None-Match` gets a `304` that keeps the page's
  `Vary`. Personal, streamed, PPR, error and guarded pages,
  requests with an `Authorization` header and header-negotiated locales get
  `private, no-cache`. A `Cache-Control` set by the app or a header rule
  always wins.
- Renders that recovered from an error inside a Suspense boundary are not
  cached, nor is their PPR shell. A cached page whose background revalidation
  answers `404` is evicted instead of served stale.
- PPR pages hydrate as soon as their props arrive, without waiting for the
  remaining Suspense holes.
- **A per-visitor `redirect()` or `notFound()` on a PPR shell hit reaches
  the visitor.** The shell's `200` is already sent when `getServerSideProps`
  answers, so the page finishes itself: an `http(s)` or relative redirect
  that sets no cookies becomes a nonced `location.replace()` (with a
  `<meta refresh>` fallback), and anything else (a 404, an error, a redirect
  setting cookies) reloads once with a short-lived `__gio_ppr_bypass` cookie
  that skips the cached shell, so the real status, `Location` and cookies
  arrive. It used to end the body after the shell: a `200` that never
  hydrated.
- Instances that share a disk cache directory serve each other's pages instead
  of deleting them, and the page cache only ever deletes its own entry files.
- **Static exports hydrate.** `gio export` builds the client bundles, so
  exported pages are interactive and `GioLink` navigates client-side on any
  static host; images render their plain `src`. They hydrate inside the same
  `loading.tsx` and `error.tsx` boundaries as served pages. Routes whose
  bundle fails or imports server-only code are exported as HTML only and
  listed, pages that call `notFound()` are skipped, and failed pages are
  listed with their error reference.
- **The derived deployment ID covers the build.** The first worker reports a
  content hash of the client build it produced and of the app's server-side
  sources (`buildHash` in READY), so a restart after any change to the app's
  client code, CSS or `GIO_PUBLIC_*` values gets a new ID: pages persisted
  by the previous build, which link chunks and stylesheets the new one
  deleted, are dropped, and tabs still on it reload in full. Server-only code
  counts too - the root layout, `metadata`, `revalidate` and
  `getServerSideProps` exports, route handlers, `middleware.ts`,
  `gio.config.ts`, the project-local modules they import (found with an
  esbuild pass at startup, every project source file if that pass fails),
  the tsconfig and the lockfile - so persisted pages never outlive the code
  that rendered them, even with `revalidate = false`. A standalone build's
  `.gio/manifest.json` records a hash of its `worker.js` for the same
  reason. Data read at runtime (files, databases, `.env` values) is not
  covered: purge with `revalidatePath()` or `POST /_gio/revalidate`. A
  restart of the same code keeps the ID and the disk cache. Before, only `gio build standalone` output changed the ID, so after
  a `gio start` deploy cached pages served for up to ten times their
  `revalidate` with broken stylesheet and chunk links. The ID also covers
  `[images]`, the served `[[fonts]]` files and `[i18n]` (`locales` and
  `default_locale`), and a
  standalone build's `.gio/manifest.json` is now read from the project root
  instead of the working directory. A pinned `GIO_DEPLOYMENT_ID` still wins
  and should change with every deploy.

### Metadata and SEO

- **`metadata` and `generateMetadata`.** Pages and layouts export `metadata`
  (title, description, keywords, authors, openGraph, twitter, alternates,
  robots, icons, manifest, themeColor, other) or
  `async generateMetadata(ctx, { props })`. Segments merge from the root
  layout to the page, the deepest winning per field. Titles support
  `{ default, template: '%s | Site', absolute }`, and relative URLs resolve
  against `metadataBase` or `GIO_SITE_URL`. `og:title` and `og:description`
  default to the page's resolved title and description, so a layout's
  site-wide `openGraph` (images, site name) gives every page a card with its
  own title.
- The tags render into `<head>` on the server, streamed pages included, and
  are replaced on client-side navigation. Reading cookies, the IP or the host
  in `generateMetadata` makes the page uncached. A metadata title replaces a
  component-rendered `<title>` (dev warns), and not-found and error pages get
  the route's params.
- **`app/sitemap.ts`, `app/robots.ts` and `app/manifest.ts`** serve
  `/sitemap.xml`, `/robots.txt` and `/manifest.webmanifest`, cached for
  `revalidate` seconds (default 3600), in standalone builds and `gio export`
  too. A `public/` file of the same name wins, with a startup warning.
- **`<JsonLd>`** from `@gio.js/react` renders schema.org data as a
  non-executable `application/ld+json` block, escaped so its content can never
  close the element; it needs no CSP nonce.

### Styling and assets

- **CSS imports.** `import './globals.css'` works from the root layout or any
  page, layout or component. Each route's CSS is bundled into content-hashed,
  minified stylesheets under `/_next/static/css/` with immutable caching,
  linked in `<head>` (one shared root-layout stylesheet, then one per route).
  On client navigation the next route's stylesheets load before it is shown.
  `@import` is bundled, including a bare package name
  (`@import "modern-normalize";`).
- **CSS Modules.** `import styles from './card.module.css'` returns the class
  map, with the same names in SSR and the client bundle, stable across builds
  and machines; `composes` and `:global` follow esbuild's rules.
  `.gio/css-modules.d.ts` types CSS imports with no setup.
- `gio export` and `gio build standalone` ship the stylesheets and class maps,
  lifting beta.7's standalone limitation. Client and standalone bundles use
  the project's `tsconfig.json`/`jsconfig.json`, so `jsxImportSource` and
  decorators apply as in SSR. The docs have a Tailwind v4 recipe.
- **`public/` at the site root.** Dotfiles (except under `.well-known/`),
  symlinks and a top-level `public/_gio/` are never served there. Guards,
  header rules and `[[rate_limits]]` for a file's `/public/...` URL also apply
  to its root URL, and root-served files revalidate
  (`max-age=0, must-revalidate` with `Last-Modified`).
- **CSS revalidates.** App CSS served from the CSS cache (`/globals.css`) and
  `/_gio/fonts/fonts.css` are no longer cached as immutable for a year; they
  revalidate on every use (a strong `ETag` and `304`s), so CSS changes show
  right after a deploy.
- **GioImage requests only widths the optimizer accepts.** srcset candidates
  come from `[images] allowed_widths` and the default quality from
  `[images] quality`; a hardcoded list used to produce widths the optimizer
  rejected with `400`, which broke images in the starter. Fixed-size images
  get 1x/2x candidates, `sizes`/`fill` every allowed width.
- GioImage `priority` preloads the image (`<link rel="preload" as="image">`
  plus `fetchpriority=high`). The new `unoptimized` prop renders the plain
  `src`, as SVG, `data:` and `blob:` sources now always do. `/_gio/image`
  accepts `src=/public/x` as well as `/x`.
- **Local fonts.** A `[[fonts]]` `url` may be a file in `public/`
  (`/public/fonts/inter.woff2`), read at every start with no network needed
  and served under a content-hashed name. Remote font downloads now fail on an
  HTTP error status instead of saving the error page as the font.

### Client router

- **Router hooks.** `usePathname()`, `useParams()` (typed:
  `useParams<'/posts/:id'>()`), `useSearchParams()` and `useRouter()` (`push`,
  `replace`, `back`, `forward`, `refresh`, `prefetch`) from `@gio.js/react`,
  plus `navigate(href, { replace, scroll })`. They work during server
  rendering, in the root layout too, hydrate without mismatches and update on
  every soft navigation. `useLocale()` returns the request locale on the
  server, so `<LocaleLink>` renders its prefixed href in the server HTML.
- **Layouts keep their state.** Soft navigation renders the next page into the
  same React root. Shared layouts stay mounted, the page remounts when the
  path changes, a layout inside a dynamic segment mounts fresh when that
  segment's value changes, and an error an `error.tsx` caught is cleared by
  navigating away.
- **Scroll and focus.** Navigations scroll to the top or the `#hash` target
  (`scroll={false}` keeps the position), back/forward restore each page's
  scroll position, and same-page hash links only scroll. Focus moves to the
  new page's `<main>` and its title is announced to screen readers, except
  that a text field still on the page keeps focus, so search-as-you-type with
  `router.replace('?q=' + value)` works.
- `router.refresh()` re-fetches the current page and re-renders it in place,
  keeping state and scroll. `<GioLink>` gains `replace` and `scroll` props.
- Only GioJS pages render in place, your `not-found`/`error` pages included;
  JSON, a server error page or any non-2xx response (such as a static host's
  `404.html`) is a full page load. After a redirect, history records the URL
  the redirect landed on.
- Prefetched pages expire after 30 seconds (`PREFETCH_TTL_MS`) and are cleared
  by `router.refresh()` and by any same-origin non-GET `fetch()`. A failed
  prefetch (including the `429` of a spent prefetch budget) no longer turns
  the next click into a full page load.
- **Deployment skew is detected.** Navigations, prefetches, refreshes and
  `<GioForm>` posts send the deployment id the server injected into the page
  (nothing has to call `initDeploymentId()` any more), so after a deploy a
  tab still running the old build loads the new one in full instead of
  rendering its pages with old code. A prefetch that finds a new deployment
  never reloads the page: the click on the link does.
- A page without a client bundle whose `loading.tsx` or `<Suspense>` boundary
  was still pending when it streamed is loaded in full instead of being
  swapped in showing its fallback for good, and a route chunk named in a
  page's envelope is imported only after the URL parser confirms it is on
  this origin (`/\host/x.js` is another host).

### Realtime and streaming

- **WebSocket routes use page routing.** `app/chat/[room]/route.ts` answers
  `/chat/lobby`, with the segments in `socket.params`.
- **`GioSocket` knows the upgrade request:** `path`, `query`, selected
  `headers`, parsed `cookies`, `ip` and `requestId`.
  `sessions.getSession(socket)` works.
- **Connection auth.** A `wsHandler` can return `false` (or resolve to it) to
  close with `4401`, or call `socket.close(code, reason)`. Async handlers are
  supported, including one that awaits the client's first message for token
  auth: messages that arrive before the handler listens are held (up to 256
  messages or 1 MiB) and delivered in order. A socket gets no broadcasts until
  it is accepted, and a throwing handler closes with `1011`.
- **Rooms.** `socket.join(room)` / `socket.leave(room)`, plus
  `broadcast(room, data, { except })` from `@gio.js/core`, callable from any
  route handler. Rooms live in the Rust server, so a broadcast reaches sockets
  on every worker.
- **`useWebSocket` reconnects** with exponential backoff and jitter
  (`reconnect` is a boolean or
  `{ maxAttempts, initialDelayMs, maxDelayMs, minUptimeMs }`), but not after
  `1000` or `4000`-`4499` closes, `close()` or unmount. New: an optional send
  queue while disconnected, `reconnectAttempts`, `isReconnecting`,
  `reconnect()` and `onMessage` / `onOpen` / `onClose` callbacks. A message
  queued for one `url` is never sent to the next: switching rooms drops what
  was still queued for the old one.
- **Streamed route-handler bodies.** A `ReadableStream` body (LLM tokens,
  large downloads, a hand-written `text/event-stream`, streamed HTML) reaches
  the client chunk by chunk, with backpressure and no idle cutoff. When the
  client disconnects, the stream's `cancel()` runs. Small complete bodies stay
  buffered. A streamed HTML body is passed through as the handler wrote it:
  the server injects its head scripts into page streams only.
- Server shutdown and worker restarts close sockets with `1001`, and
  connections over `[websocket] max_connections` close with `1013` instead of
  being dropped.

### Operations and observability

- **Worker pool.** `[server] workers = N | "auto"` renders on several Node
  processes, so a slow render no longer holds up the others. The default stays
  1; `"auto"` is one per CPU core, at most 8. Requests go to the ready worker
  with the fewest requests in flight (open SSE streams and streaming responses
  count until they end), and streams, SSE and PPR holes stay on the worker
  that started them. A crashed worker fails only its own in-flight requests
  (`503`) and restarts while the others serve. Development always runs one
  worker.
- Client bundles are built once per pool: the first worker runs esbuild and
  the others load its manifest. Each worker gets `GIO_WORKER_INDEX` and
  `GIO_WORKER_COUNT`; a plugin's `onStartup` / `onShutdown` runs in every
  worker, so guard one-time jobs. Each WebSocket stays on one worker, and a
  restart closes only that worker's sockets.
- **No orphaned workers.** A server killed outright (SIGKILL, the OOM killer,
  a crash) no longer leaves its Node worker running: the worker exits when the
  stdin pipe the server holds closes. `gio` and a standalone `run.mjs` launch
  the server the same way, so killing a launcher also stops the server and
  frees the port.
- **Graceful shutdown** closes idle keep-alive connections at once instead of
  waiting out the 8-second drain, and gives every worker a few seconds to run
  plugin shutdown hooks. Open event streams (SSE, and route handlers
  answering `text/event-stream`) are ended cleanly when shutdown starts
  (their producers are cancelled in the worker; `EventSource` reconnects),
  so one open dashboard tab no longer holds every stop for the full drain.
  Requests, page renders and other streamed route-handler bodies (downloads,
  exports) in flight still finish; one still running when the drain times
  out has its connection reset, so the client sees the download fail
  instead of receiving a short file that looks complete.
- **JSON logs.** `[logging] format = "json"` or `GIO_LOG_FORMAT=json` makes
  the server write one JSON object per line in the worker's shape (`ts`,
  `level`, `msg`, plus `target`), with span fields such as `request_id`
  flattened in.
- **Request IDs end to end.** Every response carries `X-Request-Id`, including
  cache hits, static files, redirects and errors. Server log lines run in a
  `request{request_id=...}` span, and every worker log line for the request
  carries `"requestId"`, including the production error-digest lines, so a
  user's error reference leads to every line of that request.
- **Route-labeled metrics.** `gio_requests_total`,
  `gio_request_duration_seconds` and `gio_node_ipc_latency_seconds` carry a
  `route` label: the matched pattern (`/posts/:id`), or `static`, `internal`
  or `unmatched`. `/_gio/metrics` adds `gio_workers`, `gio_worker_ready`,
  `gio_worker_in_flight` and `gio_worker_restarts_total`, and `/_gio/health`
  reports `workers: { configured, ready }`.
- A worker response that fails to parse gets a `500` at once instead of
  waiting out the 30-second IPC timeout. A request too large for one IPC frame
  (a `max_body_bytes` raised above about 48 MiB) is answered `413`; it used to
  drop the worker's connection and fail every in-flight request.

### Configuration

- **Editor support.** `@gio.js/server` ships `gio.schema.json`, generated from
  the server's config types; new apps' `gio.toml` starts with
  `#:schema ./node_modules/@gio.js/server/gio.schema.json` for completion and
  hover docs (Even Better TOML / Taplo).
- **Listen address.** `[server] host` and `port` default to `0.0.0.0` and
  `3000`, so a partial `[server]` table works; `host` takes IPv4 or bracketed
  IPv6 (`[::]`). The `PORT` variable (Heroku, Render, Railway, Fly.io, Cloud
  Run) is honored with precedence `GIO_PORT` > `PORT` > `gio.toml` > 3000, and
  `GIO_HOST` overrides the host. The startup log says where the port came
  from.
- **Now honored:** `[compression]` (`enabled`, `min_size_bytes`,
  `prefer_brotli`), `[prefetch]` (`max_concurrent`, `max_per_second`),
  `[cache]` (`memory_max_entries`, `disk_path`, `disk_max_bytes`;
  `GIO_CACHE_DIR` still wins) and `[images] formats` (AVIF/WebP preference,
  which also limits `f=`).
- **New keys:** `[security]` (`headers`, `hsts`, `csp`, `csp_report_only`,
  `[security.csrf]`, `[security.websocket]`), `[logging]`, `[revalidate]`,
  `[dev] allowed_hosts`, and in `[server]` the connection limits, `workers`,
  `trusted_proxies`, `proxy_headers` and `accept_request_id`.
- **Feature switches, on by default.** `[prefetch] enabled = false` answers
  every prefetch `429` before it renders. `[images] enabled = false` leaves
  `/_gio/image` unrouted (404) and `<GioImage>` renders its plain `src`.
  `[cache] enabled = false` stores and serves nothing (`X-Gio-Cache: bypass`)
  while `Cache-Control` still follows `revalidate`, so a CDN can keep caching.
  `[cache]` also gets `disk_enabled` (`false`: memory only, no files), `etag`
  (`false`: no page ETags, no 304s) and `swr_multiplier` (default 10, was
  fixed; `0` never serves stale and drops `stale-while-revalidate`). A
  `[[fonts]]` entry with `preload = false` keeps its `@font-face` but drops
  its preload link.
- **Limits that were hardcoded are keys,** each with `0` = unlimited or none:
  `[server] render_timeout_secs` (30: the deadline for a worker's answer and
  for every gap in a streamed one, then 504), `[server]
  rate_limit_max_buckets` (100000), `[[rate_limits]] max_keys_per_client` (64
  `key_header` values per client, for API gateways behind one address), and
  `[images] max_source_dimension` (10000 px), `max_decode_bytes` (256 MiB)
  and `remote_timeout_secs` (30).
- **`[css] minify` reaches the worker.** Rust hands `[css]` to the worker in
  `GIO_CSS_CONFIG`, so `minify = false` also leaves the bundled route
  stylesheets unminified (it only covered path-served `app/*.css` before).
  `gio build standalone` reads the key from the project's gio.toml when it
  bakes the route stylesheets, so there a change needs a rebuild.
  `[css] enabled` covers path-served stylesheets only: imported CSS is part
  of the module graph and always bundled.
- **Loosened limits are never silent.** Lifting the image, rate-limiter,
  render or WebSocket connection limits to `0` logs one startup warning per
  key, and `--check-config` reports the same lines under `warnings`.
- **`[dev] watch_ignore`** (`["data/**", "*.db.json"]`): files the app writes
  into the project no longer restart the dev worker. The page cache's own
  writes never do.
- **Protections and features can be turned off, and stay on by default:**
  `[security] default_headers = false` drops the three built-in headers
  (`[security.headers]` entries still apply), `[server] skew_protection =
  false` ignores `x-deployment-id` (no `409` hard reloads), `[dev] devtools =
  false` unroutes `/_gio/devtools*` and strips the overlay's codeframes,
  editor links and live reload, `[dev] watch = false` runs dev without the
  watcher, and `[dev] allowed_hosts = ["*"]` answers any host.
- **`[health]`:** `enabled = false` unroutes `/_gio/health` (`404`; `gio
  dev`/`gio start` and the testing kit then treat any answer as ready), and
  `details = false` answers only `{"status":"ok","nodeReady":...}`, without
  the deployment id or the worker topology.
- **`[env] files = false`** loads no `.env` files; `GIO_ENV_FILES=0` does the
  same and `GIO_ENV_FILES=1` forces them on, whatever `gio.toml` says. The
  server, `gio export`, `gio build standalone`, the testing kit and the `gio`
  CLI's fallback reader all follow both.
- **One warning per loosened protection.** `[security.csrf] enabled = false`,
  `[security.websocket] check_origin = false`, `default_headers = false`,
  `allowed_hosts = ["*"]`, `max_body_bytes = 0` (or above what a worker
  message can carry), `max_connections = 0`, metrics open to every client, a
  `/0` in `trusted_proxies` and `skew_protection = false` each log one startup
  warning naming the key, and `--check-config` (and `gio doctor`) report the
  same text under `warnings`, along with ignored `[dev] allowed_hosts`
  entries.
- `defineConfig` and `type GioConfig` from `@gio.js/core` type
  `gio.config.ts`.
- **`giojs-server --check-config`** loads the `.env` files and `gio.toml`
  exactly as startup does, runs startup's validation (gio.toml, cache
  placement, `[security]`, the revalidation token, local `[[fonts]]` files,
  TLS) and prints a JSON
  report: the listen address, every error (each unknown key and section,
  invalid value and unenforceable rule, not just the first), warnings, and
  guard and proxy settings. It exits 1 when the server would refuse to start, never
  binds a port and never prints secrets, so it works as a CI step.
- Startup reports every configuration refusal at once and checks the TLS
  certificate and key, and fetches the `[[fonts]]`, before starting the
  worker: a missing local font file (`[[fonts]] <family>: <path> not found`)
  no longer fails startup only after the build. A `gio.toml` syntax error is
  reported as `file:line:column` with the reason, without quoting the line (it
  may hold a token).

### TypeScript

- **Types for every file convention** from `@gio.js/core`:
  `GetServerSideProps<Props, '/posts/:id'>` (types `ctx.params` and the result
  variants), `InferPageProps`, `PageProps<'/posts/:id'>`, `LayoutProps`,
  `ErrorPageProps`, `NotFoundPageProps`, `GetStaticPaths`, `RouteHandler`,
  `Metadata`, `MetadataRoute`, and route-typed `GioRequest`, `GsspContext`,
  `ActionArgs` and `GenerateMetadata`. Every exported function's parameter and
  result types are exported too, including `IPCRequest` / `IPCResponse` for
  plugins.
- **Typed params from your routes.** `.gio/routes.d.ts` fills one global
  registry that `href()`, `useParams()` and the core types read, and a route
  pattern that is not one of your routes fails `tsc`. Before the first server
  start (or `gio typegen`), params are read from the pattern itself - by the
  core types and by `href()` and `useParams()` alike, so
  `href('/posts/:id', { id })` typechecks on a fresh checkout and still
  requires `id`. `@gio.js/react` exports `RoutePattern`.
- `import type ... from '@gio.js/core'` no longer fails `tsc --noEmit` with
  TS5097: the package ships declaration files.
- Starters depend on `@gio.js/core` directly and use these types (the
  JavaScript starter through JSDoc); both starters are typechecked in CI.

### CLI

- **`gio` has real commands.** `gio --help`, `gio help <command>` and
  `gio <command> --help` show the command table and each command's options,
  and `gio --version` prints the CLI, server binary and `@gio.js/core`
  package versions (read from their `package.json`; the binary is not run). A
  mistyped command or option is a did-you-mean error. Exit codes: 0 success,
  1 failure, 2 usage error - in every command, including those that parse
  their own options (`gio bench`, `gio build standalone`, `gio migrate`,
  `gio add`). An argument a command does not take is a usage error too,
  after `--help` or `--version` as well (`gio --version --bogus`,
  `gio help dev extra`).
- **`gio dev` and `gio start`** run the server in development or production
  mode, whatever `NODE_ENV` says. `-p/--port` and `-H/--host` (IPv4 or IPv6)
  set `GIO_PORT` / `GIO_HOST`, `--open` opens a browser, and the local and
  network URLs are printed once the worker is ready.
- **Dev mode watches the whole project.** Changes in `app/`, source files in
  `components/`, `lib/`, `src/` and `hooks/`, and root config files restart
  the worker; edits under `public/` only reload the browser. `node_modules`,
  `.git`, `.gio`, build output and editor temp files are ignored. A
  `gio.toml` edit restarts the worker but does not apply the new settings:
  the server reads `gio.toml` once, at startup, so restart `gio dev`.
- **`gio routes [--json]`** lists every route without starting the server:
  pages with their layouts and loading/error/not-found files, route-handler
  methods, WebSocket handlers and metadata routes. **`gio typegen`** writes
  `.gio/routes.d.ts` without a server, for CI before `tsc`. A `route.ts` that
  fails to import there (it needs a secret CI does not have) is still typed,
  so the types match a dev machine's.
- **`gio doctor [--dev | --prod] [--json]`** checks Node.js, the platform
  binary, `@gio.js/*` versions in lockstep, `gio.toml` (validated by the
  server itself), `tsconfig.json` including `.gio/routes.d.ts`,
  `GIO_SESSION_SECRET` for `require_session` guards, a free port,
  `trusted_proxies` behind a proxy and a writable cache directory, with a fix
  for every problem. When the server cannot read the configuration, the checks
  that depend on it are reported as skipped, with the reason - and so when no
  binary of this version is installed and the CLI's lenient reader cannot read
  `gio.toml` (the `config` check names the lines).
  **`gio info [--json]`** prints versions and environment details for bug
  reports.
- **`gio migrate` and `gio add <feature>`** run the matching `create-giojs`
  commands, using the installed `create-giojs` or the same version through
  npx, pnpm dlx or bunx.
- `gio cache explain` and `gio bench` use the address the server listens on
  (`GIO_PORT` / `PORT`, `.env` files, `gio.toml`) instead of port 3000;
  `gio cache explain` also takes `--base <url>`. Both reject a target that is
  neither a path nor an `http(s)` URL as a usage error, before any request.
  `gio bench` and `gio build standalone` also take `--flag=value`.
- A missing platform binary prints which package to install for your platform
  and package manager, never a stack trace. `GIO_SERVER_BIN` points the CLI at
  a binary you built yourself.
- `gio export` lists failed routes with their error reference, and routes it
  exported without hydration.

### create-giojs and starters

- **Flags.** `npm create giojs` takes `--help`, `--version`,
  `--pm <npm|pnpm|yarn|bun>`, `--no-git`, `--force` and a positional directory
  (`.` for the current one). Unknown flags are a did-you-mean error, and the
  `--` separator pnpm, yarn and bun pass on is accepted
  (`pnpm create giojs my-app -- --js`).
- It checks the package name and offers a sanitized one (`My App` becomes
  `my-app`), refuses a non-empty directory without `--force` (listing what is
  there), installs with the package manager you ran it with, and runs
  `git init` plus an initial commit holding only the scaffolded files.
- Without a terminal nothing is asked, so scripts and CI never hang; Ctrl+C at
  a prompt exits with nothing written.
- **A starter that uses the framework.** It imports `app/globals.css` from the
  root layout, self-hosts its fonts from `public/fonts/` through `[[fonts]]`
  (no Google Fonts CDN), declares its title template and description as
  `export const metadata`, and ships `.gitignore` and `.env.example`. Its
  pages live in an `app/(site)/` route group whose layout renders the
  navigation and footer inside the hydrated tree, so the main navigation
  prefetches and soft-navigates (in the server-only root layout a `GioLink`
  is a plain link); the 404 and error pages render the same shell. A
  static-site scaffold's `npm run build` typechecks and then runs
  `gio export`, with fonts declared by `@font-face`.
- **Starter features.** `npm create giojs@latest` asks which features to add,
  or takes `--tailwind`, `--api`, `--auth`, `--db`, `--docker` and `--ci` (or
  `--features a,b,c`): Tailwind CSS v4 (CLI build, watcher in `npm run dev`),
  a JSON `route.ts` plus a `<GioForm>` page action, cookie-session login with
  a guarded `/dashboard` and a rate-limited `/login`, SQLite with Drizzle ORM
  on Node's built-in `node:sqlite` (Node 22.16+, bundles into standalone
  deploys), a non-root multi-stage Dockerfile built with
  `gio build standalone` (with compose), and a GitHub Actions workflow.
  TypeScript and JavaScript are both supported.
- **`create-giojs add <feature>`** (or `gio add`) adds the same features to an
  existing app without overwriting files you changed. A feature already set up
  keeps your edits, so running it again is safe. A file of yours in a new
  feature's way stops the run before anything is written and shows a diff
  (`--force` overwrites, `--dry-run` previews), and `gio.toml` additions merge
  into existing tables; a project without a `gio.toml` (a migrated app) gets
  one, so `auth`'s guard is never left as a manual step. Feature pages go into
  `app/(site)/`, and a page of yours serving the same URL from another folder
  is a conflict `--force` does not override. The overlay pages import `lib/`
  by relative path, so a `@/*` alias pointing at `src/` does not break them,
  and the auth dashboard checks the session itself as well.

### Testing

- **`@gio.js/core/testing`** for vitest and node:test.
  `renderPage(path, { cookies, query, headers })` renders a page in-process
  through the worker's own pipeline and returns the status, HTML, hydration
  props, every `Set-Cookie`, the redirect, whether the server would cache the
  page and its cache tags. It loads the project's `.env` files and links the
  same stylesheets the server does.
- `callRoute(path, { method, body })` calls route handlers and returns a
  fetch-like response (JSON, form and binary bodies; SSE as a raw event
  stream).
- Tests run in production mode (vitest sets `NODE_ENV=test`), where sessions
  need a secret: when neither the environment nor a `.env` file sets
  `GIO_SESSION_SECRET`, the kit sets a random one for the test process before
  it imports the app. A `createTestServer()` server does not get it.
- `createTestServer()` starts the real server on a free port with a private
  cache and waits for the worker; `close()` stops both, and a forgotten
  `close()` never keeps the run alive or leaves processes behind.
- **`gioVitest()`** from `@gio.js/core/vitest` makes CSS Module imports under
  vitest produce the server's class names.
- `GIO_HOST` / `GIO_PORT` override the listen address without editing
  `gio.toml`. A page that imports `@gio.js/core/testing` has its client bundle
  rejected.

### Migration from Next.js

- **`npm create giojs@latest -- migrate [dir]`** (also
  `npx create-giojs migrate`, `gio migrate`, or the `gio-migrate` bin of
  `create-giojs`) replaces the regex codemod and the docs' `npx gio-migrate`,
  which fetched an unrelated npm package. `--dry-run` prints the plan and a
  unified diff; a real run asks first, or needs `--yes` without a terminal.
- Code is parsed with the TypeScript compiler and edited in place. It converts
  `next/link`, `next/image`, `next/router` and `next/navigation` (to the
  `@gio.js/react` hooks), `next/head`, `next/script`, `next/dynamic`,
  `next/font` (to `[[fonts]]` hints), `getStaticProps` (to
  `getServerSideProps` plus `revalidate`) and `NextResponse`. Anything else
  gets a `// TODO(gio-migrate):` comment.
- `metadata` and `generateMetadata` are kept (the latter rewritten to
  `(ctx, { props })`), as are `app/sitemap.ts`, `app/robots.ts` and
  `app/manifest.ts`; static metadata files in `app/` move to `public/`. Server
  Action forms become `<GioForm>` posting to the page's `action`, `redirect()`
  / `permanentRedirect()` and `next/cache`'s `revalidatePath` /
  `revalidateTag` map to `@gio.js/core`, and `dynamic = 'force-static'`
  becomes `revalidate = false`.
- `pages/` projects move to `app/` (pages, 404/500, API routes, `_app` and
  `_document` into the root layout) with relative imports rewritten; `src/app`
  moves to `app/`; `.js` files with JSX become `.jsx`. A file is never moved
  onto an existing one.
- `next.config` becomes `gio.toml`: redirects, rewrites and headers (`:path*`
  to `*path`), images and i18n, with `[app] name` from `package.json`
  (`--config <file>` converts just that file, the same way). Rules GioJS would
  match differently are skipped with a TODO, and an existing `gio.toml` is
  merged into only when safe (otherwise `gio.migrated.toml`).
- `package.json` swaps `next` for `@gio.js/*` and gets `"type": "module"`
  (CommonJS `.js` configs become `.cjs`), `tsconfig.json` gets
  `"jsx": "react-jsx"`, and `MIGRATION_REPORT.md` lists every move, change and
  TODO with file and line.

### Docs

- New guides: **Environment Variables**, **Deploying** (Docker with
  `gio build standalone`, Fly.io, Railway, Render, systemd behind nginx or
  Caddy, with `trusted_proxies`, HSTS behind a proxy, `PORT` and stop timeouts
  long enough to drain) and a **Production Checklist**; new pages for
  Security, Authentication & Sessions, Forms & Mutations, Metadata & SEO and
  Testing; and a Starter Features page with guides for Tailwind,
  authentication, the database and Docker.
- The sidebar is regrouped by topic. In `docs-site/`, `npm run check-links`
  fails on dead links, missing anchors and pages left out of the sidebar, and
  `npm test` checks facts the docs state against the code.
- The docs site is rebuilt around finding things. **Search** (Ctrl+K, Cmd+K
  or `/`) covers every page section by section, ranks an exact API name
  first - an identifier-shaped gio.toml key or prop (`skew_protection`,
  `onSuccess`) opens the reference table that defines it, a bare command
  (`typegen`) its CLI page - tolerates typos and unfinished words, and runs
  in the browser with no third-party service. The sidebar has four sections (Getting
  Started, Guides, API Reference, Architecture) with collapsible groups, and
  every page gets breadcrumbs, an "On this page" outline, `#` links on its
  headings, previous/next links, "Edit this page on GitHub", "Copy page" as
  Markdown (each page is also served as `.md`), its own `<title>` and
  canonical URL, and a light/dark/system theme switch. `/docs` is a new
  index page. Code samples are syntax-highlighted (TypeScript, JSX, JSON,
  TOML, shell, diff, Rust), show the file they belong in, and install
  commands have npm, pnpm, yarn and bun tabs that remember your pick.
  `docs-site/AGENTS.md` is the guide to writing a docs page, and CI now
  typechecks, link-checks, tests and builds the site.
- "Known Issues" is now **Known Limitations**: what GioJS does not do yet and
  what to use instead.
- The README's comparison with self-hosted Next.js is corrected and expanded,
  the getting-started pages describe the new starter and `create-giojs` flags,
  and the CLI reference is rewritten.

### Fixed

- Enabling `[server.tls]` panicked at startup: rustls could not choose between
  the two compiled-in crypto providers.
- The accept loop kept a record of every finished connection until shutdown,
  and spun a core when it ran out of file descriptors.
- A route handler returning
  `new Response(stream, { headers: { 'content-type': 'text/event-stream' } })`
  hung forever.
- Client-initiated WebSocket closes were reported to browsers as `1006`.
- `gio export` crashed with ENOENT writing `404.html` when no page was
  exported, and the "Static site" starter's `/posts/1` link returned 404 after
  export.
- Slow rate limits such as 1 per hour now refill correctly.
- Over HTTP/2, where browsers send each cookie as its own `cookie` field,
  guards saw only the first cookie and `getSession` / `ctx.cookies` only the
  last: the fields are now joined into one Cookie header before anything
  reads it, and other repeated request headers reach the worker joined with
  `, ` instead of losing all but one.
- A prefetch the client cancelled (a closed tab, an HTTP/2 reset) never gave
  back its prefetch-budget slot, so a few of them made every later prefetch
  from that IP `429`.
- Each distinct WebSocket upgrade path left an entry in the server's route
  index for good, so upgrades to ever-new paths grew memory without bound.
- Under vitest, app modules in `[id]` folders or paths with spaces failed to
  load.
- `gio build standalone --out <dir>` emptied the directory without checks:
  `--out .` deleted the whole project. It now refuses the project directory,
  an ancestor of it, anything under `app/`, and a non-empty directory that is
  not a previous standalone build.
- `gio bench` and `gio build standalone` exited with `1` on a usage error (a
  bad flag or value), like a failed run; they now exit with `2`, as `gio`
  documents. `gio bench` also rejects a fractional `--connections` (it was
  rounded down), and says what a target must be instead of `Invalid URL`.
- Every production start warned that `/_gio/metrics` is unauthenticated, even
  with metrics off (no `[metrics]` section, or `enabled = false`), where the
  endpoint answers `404`. Metrics without a `token` or `ip_allowlist` now
  answer this machine only, and the warning is for an allowlist that opens
  them to everyone.
- `[security.csrf] enabled = false` turned CSRF protection off silently; it
  now logs a warning, like `[security.websocket] check_origin = false`.
- A locale detected from `Accept-Language` was the header's tag lowercased,
  not the configured locale: with `locales = ["pt-BR"]`, `Accept-Language:
  pt-BR` gave `pt-br`, so `useLocale()`, `<html lang>`, the page cache key
  and `<LocaleLink>` prefixes (`/pt-br/...`, which the path detection never
  recognized) all differed from a `/pt-BR/` URL. Detection now always
  returns the configured spelling.
- `Accept-Language` q-values were ignored: the first supported language as
  written won, so `en;q=0.1, fr` picked `en`. Languages are now tried from
  the highest q-value down (written order breaks ties), and one marked
  `q=0` ("not this one") or with a malformed q is never picked.
- Pages in a non-default locale rendered `<html lang="de" lang="en">`: the
  server added the request locale's `lang` next to the root layout's own,
  and browsers keep the first. The root layout's `lang` is now replaced.
- `<LocaleLink>` left only `en` unprefixed unless every link passed
  `defaultLocale`: with `[i18n] default_locale = "de"`, German pages linked
  to `/de/...`. Its default is now `default_locale` - the server hands
  `[i18n]` to the worker (`GIO_I18N_CONFIG`) and the hydration envelope
  carries it to the browser, so both render the same `href` - and an
  explicit `defaultLocale` still wins. It also prefixed every `href`
  blindly (`/fr/fr/x`, `/frhttps://...`): absolute and protocol-relative
  URLs, relative paths, `?query` and `#hash` hrefs and paths that already
  start with a configured locale are now left as they are. A `LocaleLink`
  outside a GioJS page tree (a React root of your own) reads the default
  locale and the locales from the deployment script, which now also sets
  `window.__GIO_LOCALES__`.
- `<Animate>` in the root layout stayed at `opacity: 0` for good: the root
  layout never hydrates, so its effect never ran, and the inline observer
  fallback was only written into pages without a root layout. Outside the
  hydrated page - the root layout, pages without a client bundle,
  `not-found` and `error` pages - the server now renders a small nonced
  inline script after each `<Animate>` that observes it (or shows it at
  once for `when="immediate"`), and the client router hands the ones in a
  server-only page it swaps in to the same observer, setting it up when no
  such script ran on the page yet, and brings along their stylesheet, which
  the previous page may not have had. The document-wide observer script is gone:
  it also touched hydrated elements before React did.
- A standalone build whose app had a module that throws while it is imported
  (a missing `GIO_SESSION_SECRET`) never started: `worker.js` evaluated every
  module at load, the worker died and the server gave up with
  `IPC connect ... failed after 60 attempts`. It now evaluates them as `gio`
  does from source - `route.ts` files at startup, pages and layouts on first
  use - so the URLs that import the module answer `500` and the rest of the
  app serves.
- The Standalone docs' systemd unit had no `KillMode=mixed`, so stopping the
  service killed the workers in the middle of requests; it now matches the
  Deploying guide's (`KillMode=mixed`, `TimeoutStopSec=30`). The Tailwind
  docs and the feature's `AGENTS.md` note say to start with `npm run dev`:
  `gio dev` alone never builds the ignored `app/tailwind.out.css`.
- `useId` values in a page differed between the server HTML and hydration:
  the server rendered the page deep inside the document (the root layout and
  the `#__gio` boundary around it), the browser hydrated it as a root of its
  own, and `useId` derives its value from the position in the tree. Every
  `htmlFor`, `aria-*` or form id built on it pointed at nothing after
  hydration - silently in production, with a hydration warning in
  development. The `#__gio` boundary now records its position
  (`data-gio-tree`) and the browser hydrates from the same one, so ids match
  inside streamed Suspense content and static exports too, and the client
  router keeps that position for every later page. One rare case remains: a
  root layout that puts `children` past React's 30-bit tree id, with slots
  in lists of 8 or more children around it or in the page, can still see an
  id differ by a `0` digit.
- A `[[rate_limits]] path` written in rule syntax (`/api/*rest`, the
  spelling every other path setting takes) was compared literally and matched
  nothing, without a warning. `path` now takes the rule pattern syntax
  (literal segments, `:param`, a trailing `*rest`); `/api/*`, `/api*` and
  exact paths keep working. A path that cannot be parsed (no leading `/`, a
  `*rest` that is not last) stops startup and `--check-config` reports it.
- A worker that could not boot (an invalid `gio.config.ts`, a route
  conflict, a `middleware.ts` that throws) was reported as
  `IPC connect to .gio/ipc-*.sock failed after 60 attempts` with a Rust
  backtrace, about 15 seconds later; the real error was a JSON line further
  up. The server now notices the worker exit at once and ends with the
  worker's own error (`the Node worker exited before it was ready (exit
  status: 1):` and the message), exit 1 and no backtrace. Dev waits for a
  file change and starts the worker again, and a dev worker that crashes
  after startup is respawned on the next save instead of after the respawn
  backoff. `createTestServer` leads its error with the same message. A
  standalone build reports a `middleware.ts` or `gio.config` that throws the
  same way (both used to be imported before the worker could report
  anything). The worker writes its error into a private directory the server
  creates, not under a predictable name in the shared temp dir.
- A page exporting an invalid `revalidate` (`-5`, `1.5`, `'60'`, `NaN`)
  answered every request with a bare `500`: the value reached the server as
  the cache lifetime and the response failed to parse. It is now a render
  error naming the file and the allowed values (a whole number of seconds,
  or `false`) - the error overlay in dev, a logged error and a `500` with a
  digest in production. A literal value (`export const revalidate = -5`) is
  refused at route discovery already: the worker does not boot, and
  `gio build standalone` fails, naming the file.
- Every startup warning for a protection `gio.toml` turns off or loosens was
  logged twice.
- With `[server.tls]` on, `[server] http2 = false` still offered `h2` in the
  TLS handshake (ALPN), and clients that picked it (browsers, curl) could not
  connect. It now offers only `http/1.1`.
- Server-sent event streams carried `Cache-Control: no-cache` twice and
  `Connection: keep-alive, keep-alive`. They now carry `Cache-Control` once
  and no `Connection` header, which is connection-specific and not allowed on
  HTTP/2.
- Connection-specific headers a page or `route.ts` set itself (`Connection`,
  `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, `TE`, `Trailer`,
  `Proxy-Connection`) were forwarded over HTTP/1.1, and an app's
  `Keep-Alive: timeout=N` replaced the server's own hint while the server
  still closed idle sockets on its own schedule. They are now dropped from
  every page, route and event-stream response; `Keep-Alive` always states
  the server's idle timeout.
- The server's own refusals - the rate-limit `429`, the deployment-skew
  `409`, a refused prefetch's `429` - were labeled `X-Gio-Cache: static`; they
  now say `bypass`, also on `/_gio/*` paths (a rate-limited `/_gio/image`).
  `static` is for files only (`public/`, `/_next/static`,
  the CSS compiled at startup), and the self-hosted fonts under
  `/_gio/fonts/` now carry it too.
- `X-RateLimit-Remaining` could be larger than `X-RateLimit-Limit`: the limit
  was the rule's `per_ip`, the remaining count included its `burst`.
  `X-RateLimit-Limit` is now the bucket's size, `per_ip + burst` (a fresh
  client of `per_ip = 3` with the default `burst = 20` sees `23` and `22`),
  and Remaining never exceeds it.
- `Sec-Purpose: prefetch;prerender` (a browser's speculation-rules prerender)
  and other parameterized `Purpose` / `Sec-Purpose` values did not count as
  prefetches. Both headers are now read as lists, and an item `prefetch`
  with or without parameters marks a prefetch.
- Responses whose body is known in full - page cache hits, small route
  handler bodies, `/_gio/health` - lost their `Content-Length` and went out
  chunked over HTTP/1.1: the compression layer hid the body's size even when
  it left the body uncompressed. They now carry one; a compressed body still
  has none.
- An `async` `GioEventStream` handler's promise was stored as its cleanup, so
  on disconnect the cleanup never ran and the worker logged a `TypeError`.
  The promise is now awaited and what it resolves to is the cleanup - run
  even when the client left first - and a rejection ends the stream like a
  throw. A handler may also return nothing: its type is the new
  `SseHandler`, `(stream) => SseCleanupFn | void | Promise<SseCleanupFn | void>`.
  A result that is not a function is logged as a warning, and a cleanup
  that throws is logged instead of failing the frame. The testing kit's
  `callRoute` streams behave the same (a throwing cleanup also rejects the
  stream's `cancel()` when it runs during it).
- A server started outside the project (`GIO_APP_DIR=/srv/app/app` from
  another directory) compiled app code with the working directory's
  tsconfig, or none: a starter layout without a React import answered `500`
  with `React is not defined`. The worker now gets the project's
  `tsconfig.json` (else `jsconfig.json`) as `TSX_TSCONFIG_PATH`, the file
  the client bundles already used; a `TSX_TSCONFIG_PATH` the environment
  sets wins. `gio export`, `gio routes` and `gio typegen` run from another
  directory do the same.
- `handleHardReload()` from `@gio.js/react` threw `window is not defined`
  when called during server rendering; like the other deployment helpers,
  it now does nothing there.

### Known limitations

- **No React Server Components** and no Server Actions: every page and nested
  layout is server-rendered and hydrated, data loads in `getServerSideProps`,
  and mutations are page actions or route handlers. The root layout never
  hydrates, so URL-dependent UI there does not update on soft navigation.
- **No generated Open Graph images** (`opengraph-image.tsx`), file-based icons
  (`app/icon.png`), `viewport` export or `generateSitemaps`.
- **No shared cache backend across instances.** There is no Redis (or other)
  backend yet, so the page cache, revalidation purges, rate limits and
  WebSocket rooms are per instance: call `POST /_gio/revalidate` on every
  instance, and expect N instances to allow N times a configured rate.
- **No linux-arm64 binary is published yet.** Build the server from source and
  hand it to `gio build standalone` with `GIO_STANDALONE_SERVER_BIN`, or
  deploy `linux/amd64` images. Windows on ARM and FreeBSD have no binary
  either.
- **Slow-read clients** that never read their response are bounded only by
  `[server] max_connections`, and long-lived SSE and streaming connections
  count toward it; there is no response write timeout or per-IP cap yet.
- During client-side navigation the current page stays until the next page's
  HTML arrives: the target's `loading.tsx` shows only if the new page suspends
  in the browser. A `notFound()` that runs in the browser (after a streamed
  page suspended) shows the nearest `error.tsx`, with status `200`.
- `ctx.query` and `req.query` hold one value per key, in no particular
  order, so a server-rendered `useSearchParams().getAll()` returns at most
  one. In a static export `useSearchParams()` is always empty: each page is
  rendered once, for no query.
- Optimized images (`/_gio/image`) and remote `[[fonts]]` are cached as
  immutable under names that ignore the source's content: replacing
  `public/hero.png` or a remote font keeps serving the old one. Give a changed
  file a new name (local fonts in `public/` are content-hashed).
- Everything in `public/`, dotfiles included, stays reachable under
  `/public/...`: never keep secrets there.
- Request bodies are buffered in memory (2 MiB by default, about 48 MiB at
  most). Sessions live in one cookie (4 KB, no server-side revocation).
- `ctx.headers` is a Proxy that `structuredClone` cannot copy; pass
  `{ ...ctx.headers }`. A `getServerSideProps` built by a module-scope call
  (`export const getServerSideProps = withAuth(...)`) is not stripped from the
  client bundle; mark the helper module server-only to turn a leak into a
  build error.
- No hot module replacement (an edit restarts the worker and reloads the
  page), no edge runtime, and no `template` files, parallel routes or
  intercepting routes.

## 0.1.0-beta.7 (2026-09-06)

### Partial prerendering (PPR)

- `export const shell = 'cache'` (next to `export const revalidate = N`) on a
  page with Suspense boundaries splits it at the pre-Suspense boundary: the
  shell is cached in Rust and served instantly, while the Suspense holes
  re-render per request - `getServerSideProps` reruns with the requester's own
  cookies - and stream into the same response behind the shell. A shared shell
  with personalized holes.
- The contract: the shell must render identically for every visitor (same tree
  structure and bytes); only Suspense content may be personalized. Pages that
  fail the shareability check (no `revalidate`, per-request headers, vary)
  fall back to plain streaming with a warning.
- Degrades gracefully: if the holes render fails or times out, the body ends
  after the shell and the Suspense fallbacks stay visible. Shell captures are
  capped at 4 MB; an aborted render never caches a torn shell.
- `X-Gio-Cache` labels PPR responses: `ppr; shell=stored` (full render, shell
  captured), `ppr; shell=hit` (cached shell + streamed holes),
  `ppr; shell=stale; age=N; revalidating` (SWR refresh in the background).

### Standalone deploys

- `gio build standalone [--out <dir>] [--target <platform>]` packages the app
  into one self-contained directory: the Rust `server(.exe)` binary, the
  entire Node side bundled to a single `worker.js` (React included - `tsx` and
  `esbuild` are build-time only and never load at runtime), a `run.mjs`
  launcher, prebuilt hydration chunks under `static/`, `public/`, and
  `gio.toml`.
- Deploy = copy the folder to any server with only Node installed and run
  `node run.mjs`. No `node_modules`, no `npm install` on the host.
- `--target` cross-builds for any installed platform package (`linux-x64`,
  `linux-x64-musl`, `linux-arm64`, `win32-x64`, `darwin-x64`,
  `darwin-arm64`); a missing package fails with the exact
  `npm i @gio.js/server-<target> --force` to run.
- Plain `gio build` prints an explanation: normal deploys have no build step.
- Known v1 limitation: app-level `.css` imports are not carried into the
  bundle - serve stylesheets from `public/` instead.

### Fixed

- `latest`-tag promotion now retries through npm registry propagation lag
  instead of silently skipping - the race that left beta.6's `latest` pointing
  at beta.5 for some packages until promoted manually.
- The scaffold's typecheck config was fixed: `moduleResolution: "Bundler"` and
  `@types/node`, so `tsc --noEmit` passes on a fresh `npm create giojs` app.

## 0.1.0-beta.6 (2026-09-06)

Emergency release: **beta.5 was broken on npm for every new user.**
`@gio.js/react@0.1.0-beta.5` was published with no `dist/` (the release
workflow never ran a build before `npm publish`) and `create-giojs@0.1.0-beta.5`
shipped without its bin targets, so `npm create giojs@latest` failed outright.

### Release integrity

- The release workflow now installs and builds `@gio.js/react` and
  `create-giojs` before publishing, and a new tarball gate
  (`scripts/check-tarballs.mjs`) refuses to publish any package whose
  `main`/`types`/`bin`/`exports` targets (or platform binary) are missing
  from the tarball - the exact failure beta.5 shipped with.
- Tag pushes now run the full test matrix (Rust tests + clippy, Node suites,
  the Rust↔Node integration harness on Linux and Windows) before anything
  is published.
- `latest` promotion covers the platform binary packages; three of them had
  been serving beta.1 binaries via `latest` since May.
- Dropped the `@gio.js/server-linux-arm64` optionalDependency - that package
  was never published (its build is deferred), so every install logged a 404.
- `@gio.js/core` no longer ships its test files.

### Security

- **Cache poisoning via background revalidation.** The stale-while-revalidate
  refresh stored responses without the shareable check the miss path enforces
  and rendered with the triggering client's `cookie`/`authorization` headers -
  a personalized page could be cached under the shared key and served to every
  visitor. Revalidation now uses the same shareable predicate and strips
  credentials.
- **Image optimizer SSRF.** The remote-source allowlist parsed URLs by string
  splitting, so `https://169.254.169.254?x=.cloudinary.com` passed a
  `**.cloudinary.com` pattern while the fetch went to the metadata IP (same
  trick with `#` and `@`). Sources are now WHATWG-parsed once, wildcard
  patterns match only real domains (IP literals need an exact entry), the
  validated URL is exactly the fetched URL, and the previously-ignored
  `remote_patterns.pathname` restriction is enforced.
- A throwing WebSocket/SSE user handler can no longer crash the whole SSR
  worker; decode limits (10k px / 256 MB) stop a tiny crafted image from
  allocating gigabytes; `/_gio/image` now honors `[[rate_limits]]` rules;
  cached responses drop `set-cookie` and hop-by-hop headers; font-family
  values are sanitized before hitting the filesystem or generated CSS.

### Fixed

- **A restart no longer throws away the disk cache.** Deployment IDs were
  time-derived, so an identical build got a fresh ID every boot and the
  persisted cache became dead weight (with dead entries still polluting the
  memory LRU). IDs are now content-derived, `GIO_DEPLOYMENT_ID` can pin one
  across pods, and mismatched entries are deleted instead of re-promoted.
- Stale revalidations are coalesced (one background render per key, not one
  per request); SSE streams are terminated instead of leaking/hanging when
  the worker respawns; version-skew detection actually fires for soft
  navigations (it required a `sec-fetch-mode` value `fetch()` can never
  send); binary `route.ts` responses cross the IPC boundary byte-for-byte
  (`bodyBase64`, protocol v2) instead of being UTF-8-mangled; `useLocale` no
  longer causes hydration mismatches; a page module's unrelated `GET` export
  no longer runs its side effects on every render; plus a batch of smaller
  fixes (IPv6 rate-limit key collisions, prefetch-budget underflow, router
  param-name aliasing, SSE header injection, soft-nav response races,
  bounded IPC write buffering, supervisor write timeout).

### Added

- `import { GioEventStream } from '@gio.js/core'` now works: the package has
  a real public entrypoint (previously its `main` booted a second server
  inside the worker and exported nothing).
- `/_gio/health` reports `deploymentId`, `nodeReady` (false during worker
  respawn), `cacheEntries`, and `uptimeSecs`.
- `<GioLink prefetch="viewport">` is implemented (IntersectionObserver).
- The docs site serves `llms.txt` + `llms-full.txt`, scaffolds include an
  `AGENTS.md`, and the entire documentation was audited against the source:
  the gio.toml reference now matches the parser exactly, and every fictional
  feature (`gio build`, Redis cache sharing, `PORT`, `[compression]`,
  `[[redirects]]`) is gone from the docs.

### Developer experience

- **Middleware rules.** Declarative redirects, rewrites, response headers,
  and cookie guards, defined in `gio.toml` (`[[redirects]]`, `[[rewrites]]`,
  `[[headers]]`, `[[guards]]`) and/or a project-root `middleware.ts`
  (`defineMiddleware` from `@gio.js/core`, delivered via the worker's READY
  frame). Patterns share the routing conventions (literals, `:param`,
  `*rest` catch-all) with named substitution into targets. Evaluated in the
  Rust HTTP layer before routing - guards, then redirects, then rewrites,
  first match wins, gio.toml before middleware.ts in each phase - so no
  request reaches Node without passing them and no request header can skip
  them. Queries are preserved verbatim; all rules are validated at load time
  (invalid entries skipped with a warning, nothing fails at request time);
  `/_gio/*` is exempt.
- **Typed routes.** The worker generates `.gio/routes.d.ts` from the
  discovered route patterns at every boot; it augments `@gio.js/react`'s
  `GioRegisteredRoutes` via declaration merging, so the new
  `href('/posts/:id', { id })` helper autocompletes patterns and typechecks
  params with zero annotations. Param values are URL-encoded per segment
  (catch-alls keep their slashes). Templates include the file in tsconfig;
  existing projects add `".gio/routes.d.ts"` to `include`.
- **Cache observability.** Every response is stamped with `X-Gio-Cache`:
  `hit; ttl=<secs>`, `stale; age=<secs>; revalidating`, `miss; stored`,
  `bypass`, or `static` (internal `/_gio` endpoints excluded). New
  `gio cache explain <url>` fetches a URL and decodes the header into a
  plain-English explanation of what the cache did and why.
- **`gio bench`.** Zero-dependency HTTP load generator (plain `node:http`,
  keep-alive): `--connections`/`--duration`/`--warmup`, single-URL or
  `--suite` table mode with `--base`, reporting req/s, p50/p90/p99/max
  latency, non-200s, errors, bytes/s, and the last response's `X-Gio-Cache`
  value so cache-hit and cache-miss runs are self-labeling. Methodology for
  honest cross-framework comparisons documented in `benchmarks/README.md`.
- **Streaming SSR.** Personalized (uncacheable) pages now stream React's
  output to the browser as it renders (IPC protocol v3 `chunk` frames):
  the shell flushes as soon as React produces it and Suspense content
  follows in the same response, instead of buffering the full document in
  the worker. Rust splices its head/body injections (fonts, deployment
  script, `lang`, dev overlay) into the stream with chunk-boundary-safe
  scanning, enforces an idle-gap timeout between chunks, and aborts the
  React render when the client disconnects. Cacheable pages keep the
  buffered path - they are cached once and served at memory speed
  afterwards. Integration-verified: first bytes of a Suspense page arrive
  in under 500 ms while the complete document takes 800 ms+.
- **Dev overlay codeframes + open-in-editor.** The dev error overlay now
  shows a codeframe (failing line ± 4 lines of context) for the topmost
  project frame of SSR and browser errors, and every `file:line` in the
  stack click-opens the file in the editor from
  `GIO_EDITOR`/`VISUAL`/`EDITOR` (default `code`; VS Code-family editors
  get `-g file:line`). Both endpoints are dev-only and path-validated to
  the project root.

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

## 0.1.0-beta.4 (2026-06-13)

Packaging and clean-install fixes following beta.3, found by testing the
published packages end-to-end: `tsx` promoted to a runtime dependency,
corrected package file lists, and template fixes.

## 0.1.0-beta.3 (2026-06-13)

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
