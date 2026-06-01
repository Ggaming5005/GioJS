# Known Issues

Bugs discovered during P3.7 dogfooding (building `docs-site/` on GioJS).
All three were fixed before the docs site shipped — per the project rule:
**"Any workaround is a bug to fix first."**

---

## CORE-001 — layout.tsx files not discovered or applied

**Status:** Fixed in P3.7

**Symptom:**  
Pages rendered without any layout wrapper. The root `app/layout.tsx` providing `<html>` was
invisible to giojs-core. `wrapWithDocument` added a duplicate `<html>` shell around the
rendered content, producing malformed HTML.

**Root cause:**  
`router.ts:walk()` only collected files named `page.tsx`. `layout.tsx` was never matched.

**Fix:**  
- `packages/giojs-core/src/router.ts`: Added `LayoutEntry` interface, `discoverLayouts()`
  function, and `walkLayouts()` helper that mirrors `walkPages()` but collects `layout.tsx`
  files keyed by URL prefix (e.g., `/` for `app/layout.tsx`, `/docs` for `app/docs/layout.tsx`).
- `packages/giojs-core/src/ssr.ts`: Added `findApplicableLayouts()` that returns layouts
  sorted outermost-first. Layouts are applied in reverse order (innermost-first) around the
  page element. `wrapWithDocument` is skipped when a root layout exists at key `"/"`.
- `packages/giojs-core/src/ipc.ts` and `index.ts`: Threaded `layouts` through
  `createIPCServer()` and `renderRoute()`.
- Layout components receive a `path?: string` prop so they can highlight active nav links
  server-side.

---

## CORE-002 — `revalidate = false` produces `cacheMaxAge = 0`

**Status:** Fixed in P3.7

**Symptom:**  
Pages with `export const revalidate = false` (meaning "cache forever") were never cached by
the Rust layer. Static docs pages were re-rendered on every request.

**Root cause:**  
In `ssr.ts` line 124:
```typescript
cacheMaxAge: pageModule.revalidate ?? 0,
```
JavaScript's `??` (nullish coalescing) only checks for `null` and `undefined`, not falsy values.
`false ?? 0` evaluates to `false` (the left-hand side is returned because it is not
`null`/`undefined`). `false` is coerced to `0` during JSON serialization. The Rust cache layer
requires `cache_max_age > 0` to store an entry, so all `revalidate = false` pages fell through
as uncacheable.

**Fix:**  
Updated `packages/giojs-core/src/router.ts`:
```typescript
revalidate?: number | false;  // was: number | undefined
```

Updated `packages/giojs-core/src/ssr.ts` line 124:
```typescript
cacheMaxAge: pageModule.revalidate === false ? 31536000 : (pageModule.revalidate ?? 0),
```
`31536000` seconds (one year) is the standard "cache indefinitely" sentinel used by CDNs
and HTTP caches.

---

## CORE-003 — No server-side redirect support in `getServerSideProps`

**Status:** Fixed in P3.7

**Symptom:**  
`getServerSideProps` could only return a props object (`Record<string, unknown>`). There was no
mechanism to return a HTTP redirect response. The docs site root (`/`) needed to redirect to
`/docs/getting-started` but had no supported way to do so.

**Root cause:**  
The `PageModule.getServerSideProps` return type was `Promise<Record<string, unknown>>`.
`ssr.ts` passed the result directly as React component props with no redirect check.

**Fix:**  
Added to `packages/giojs-core/src/router.ts`:
```typescript
export interface RedirectResult {
  redirect: { destination: string; permanent: boolean };
}
```

Updated the `getServerSideProps` return type:
```typescript
getServerSideProps?: (ctx: ...) => Promise<Record<string, unknown> | RedirectResult>;
```

Added to `packages/giojs-core/src/ssr.ts`:
```typescript
function isRedirect(result: unknown): result is RedirectResult {
  return typeof result === 'object' && result !== null && 'redirect' in result;
}
```
`renderRoute` now checks `isRedirect(result)` after calling `getServerSideProps` and returns
an `IPCResponse` with status 301 (permanent) or 302 (temporary) and a `location` header.

---

## Pre-publish audit — 10 issues fixed (2026-05-26)

The following issues were identified and fixed before the first public release.

### PUB-001 — giojs-react missing `files` field and dist configuration

**Files:** `packages/giojs-react/package.json`, `packages/giojs-react/tsconfig.build.json`

**Problem:** `package.json` had no `files` field, causing `npm publish` to include the entire directory (including `node_modules`). `main` pointed to `./src/index.ts`, which cannot be resolved by consumers. No build script existed.

**Fix:** Added `"files": ["dist/", "package.json"]`, set `main`/`types`/`exports` to `dist/`, added `"build": "tsc -p tsconfig.build.json"` script, and created `tsconfig.build.json` that overrides `noEmit: false` and `allowImportingTsExtensions: false` for emit.

---

### PUB-002 — giojs-core missing `files` field

**File:** `packages/giojs-core/package.json`

**Problem:** No `files` field caused `npm publish` to include `node_modules` in the tarball.

**Fix:** Added `"files": ["src/", "package.json"]`.

---

### PUB-003 — IPC writer/reader tasks silently die on socket error (no reconnect)

**File:** `crates/giojs-server/src/ipc.rs`

**Problem:** The writer and reader background tasks would `break` on the first I/O error, permanently killing all IPC communication without notifying in-flight requests or attempting reconnection.

**Fix:** Replaced the two separate tasks with an `ipc_supervisor` that uses `select!` over a `run_reader_loop` sub-task and the writer loop. On any error: drains all in-flight pending requests with 503 responses via `drain_pending_with_503`, then reconnects with exponential backoff (100ms → 10s, max 10 attempts) via `try_reconnect`.

---

### PUB-004 — `useWebSocket` crashes during SSR

**File:** `packages/giojs-react/src/hooks/useWebSocket.ts`

**Problem:** `useState<number>(WebSocket.CONNECTING)` runs during server-side rendering where there is no global `WebSocket`, causing a `ReferenceError` at render time.

**Fix:** Changed to `useState<number>(-1)` as a safe sentinel value that does not reference any browser global.

---

### PUB-005 — `/_gio/metrics` endpoint unauthenticated

**Files:** `crates/giojs-server/src/config.rs`, `crates/giojs-server/src/main.rs`

**Problem:** The Prometheus metrics endpoint was publicly accessible with no authentication, exposing internal counters, cache state, memory usage, and rate-limit patterns.

**Fix:** Added `[metrics]` section to `gio.toml` config (`MetricsConfig` struct with `enabled`, `token`, `ip_allowlist` fields). `metrics_handler` now checks IP allowlist and/or Bearer token before serving. A startup `warn!` is emitted in production when neither guard is configured.

---

### PUB-006 — Bootstrap script paths interpolated unescaped into HTML attributes

**File:** `packages/giojs-core/src/ssr.ts`

**Problem:** `wrapWithDocument` built `<script src="${s}">` with unescaped path strings. A path containing `"` or `>` would break the HTML attribute or inject arbitrary markup.

**Fix:** Added `escapeHtmlAttr()` and applied it to each bootstrap script path before interpolating into the `src` attribute.

---

### PUB-007 — IPC socket in `/tmp` with world-accessible permissions

**Files:** `packages/giojs-core/src/ipc.ts`, `crates/giojs-server/src/ipc.rs`

**Problem:** The Unix domain socket defaulted to `/tmp/giojs.sock`. The `/tmp` directory is world-readable on most Linux systems, allowing any local process to connect to the IPC socket and inject arbitrary IPC frames.

**Fix:** Changed default socket path to `.gio/ipc.sock` (project-local, not world-accessible). On the Node side, `fs.mkdirSync('.gio', { recursive: true })` is called before binding, and `fs.chmodSync(PIPE_PATH, 0o600)` is called after the socket is created. On the Rust side, the same `.gio/ipc.sock` default is used.

---

### PUB-008 — Prometheus label values not escaped

**File:** `crates/giojs-server/src/metrics.rs`

**Problem:** URL paths and rate-limit rule patterns were interpolated directly into Prometheus text-format label values. A path containing `"`, `\`, or `\n` would produce invalid output that breaks scrapers.

**Fix:** Added `escape_label_value()` which escapes `"` → `\"`, `\` → `\\`, and `\n` → `\n`. Applied to all user-controlled label values in `format_prometheus`.

---

### PUB-009 — `prefetchCache` in `GioLink` grows without bound

**File:** `packages/giojs-react/src/Link.tsx`

**Problem:** The module-level `prefetchCache: Map<string, string>` had no size limit. A long-running SPA session visiting many unique URLs would accumulate unbounded memory.

**Fix:** Added `MAX_PREFETCH_CACHE = 50` cap and `setPrefetchCache()` helper that evicts the oldest entry (insertion-order eviction via `Map` iteration) before inserting when at capacity.

---

### PUB-010 — Integer overflow when encoding large IPC frames

**File:** `crates/giojs-server/src/ipc.rs`

**Problem:** `write_frame` cast `payload.len() as u32` without checking for overflow. A payload larger than 4 GiB would silently truncate the length prefix, causing the remote end to read garbage.

**Fix:** Added an explicit check `if payload.len() > u32::MAX as usize` that returns an error before any write is attempted.
