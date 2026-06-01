# P6.2 Clean Machine Install Report

**Date:** 2026-05-21
**Test directory:** `C:\Users\Gio\Desktop\giojs-clean-test\test-app\`
**Platform:** Windows 11 Pro (win32-x64), Node.js v24, npm

## Install method

Packages were packed to local tarballs (`dist-test/`) and installed via `file:` references
to simulate a real `npm install` from the public registry. A fresh project was scaffolded
using `create-giojs`, then `package.json` was updated to non-monorepo form before install.

## Checklist results

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 1 | `localhost:3000` → hero page | ✅ 200 | "Self-hosted React at Vercel speed." rendered |
| 2 | `localhost:3000/about` | ✅ 200 | GioLink navigation renders as `<a>` tags |
| 3 | `localhost:3000/posts/42` | ✅ 200 | "Post #42" rendered via `getServerSideProps` |
| 4 | `localhost:3000/nonexistent` | ✅ 404 | Branded 404 response |
| 5 | `/_gio/health` | ✅ 200 | `{"status":"ok","http2":true,"tls":false}` |
| 6 | `/_gio/metrics` | ✅ 200 | Prometheus metrics with `gio_requests_total` counters |
| 7 | `/public/styles/globals.css` | ✅ 200 | CSS served from `public/` via Rust ServeDir |
| 8 | `/_gio/devtools` (dev mode) | ✅ 200 | Dashboard visible in development |
| 9 | `/_gio/devtools` (prod mode) | ✅ 404 | Not exposed in production |
| 10 | Brotli compression | ✅ | `content-encoding: br` when `Accept-Encoding: br` sent |
| 11 | GioLink navigation | ✅ | Rendered as `<a href="...">` server-side |
| 12 | Binary auto-detection | ✅ | `giojs-win32-x64` resolved via `require.resolve` |

## Windows-specific checks

| Check | Result |
|-------|--------|
| Named pipe (`\\.\pipe\giojs`) IPC | ✅ Working |
| Windows path separators in route discovery | ✅ `sep` used correctly in `filePathToUrlPattern` |
| `.exe` binary extension detection | ✅ `find-binary.js` adds `.exe` on win32 |
| PowerShell + cmd.exe invocation | ✅ `node gio.js` works from both shells |

## Bugs found and fixed

### Bug 1: `GIO_NODE_SCRIPT` not set in clean install
**File:** `packages/giojs/bin/gio.js`
**Symptom:** Rust binary defaulted to `packages/giojs-core/src/index.ts` (monorepo path),
which does not exist in a clean install.
**Fix:** Added `findNodeScript()` that resolves `giojs-core/package.json` via
`require.resolve()` and sets `GIO_NODE_SCRIPT` env var before invoking the binary.

### Bug 2: `tsx` in devDependencies
**File:** `packages/giojs-core/package.json`
**Symptom:** `tsx` would not be installed on `npm install --production` or clean installs
without devDependencies.
**Fix:** Moved `tsx` from `devDependencies` to `dependencies`.

### Bug 3: `giojs-core` was private and not a dep of `giojs`
**File:** `packages/giojs-core/package.json`, `packages/giojs/package.json`
**Symptom:** `giojs-core` could not be resolved by the `giojs` package shim.
**Fix:** Removed `"private": true` from `giojs-core`; added `"giojs-core": "0.1.0-beta.1"`
to `giojs` dependencies.

### Bug 4: CSS import in layout.tsx crashing tsx SSR
**File:** `packages/giojs-cli/templates/default/app/layout.tsx`
**Symptom:** `Unknown file extension ".css"` — tsx/esbuild cannot process CSS during SSR.
**Fix:** Removed `import '@/styles/globals.css'`; replaced with
`<link rel="stylesheet" href="/public/styles/globals.css" />` in the `<head>`.
Moved `styles/globals.css` to `public/styles/globals.css` so Rust's ServeDir serves it.

### Bug 5: Unescaped apostrophe in template page.tsx
**File:** `packages/giojs-cli/templates/default/app/page.tsx` (line 14)
**Symptom:** esbuild transform error `Expected "}" but found "s"` — the apostrophe in
`Vercel's` inside a single-quoted string terminated the string early.
**Fix:** Changed single quotes to double quotes on that string literal.

### Bug 6: `giojs-react` peer dependency too strict
**File:** `packages/giojs-react/package.json`
**Symptom:** `ERESOLVE` — peer dep required `react@^19.0.0` but the template used React 18.
**Fix:** Changed peerDependency to `^18.0.0 || ^19.0.0`; updated template to React 19.

### Bug 7: `getServerSideProps` props not extracted from `{ props: {...} }` wrapper
**File:** `packages/giojs-core/src/ssr.ts` (line 170)
**Symptom:** `Cannot read properties of undefined (reading 'title')` — the SSR renderer
assigned the full `{ props: { post } }` return value as component props instead of
extracting `.props`, so `post` was always `undefined`.
**Fix:** Added detection for the `{ props: {...} }` Next.js convention:
```typescript
const raw = result as Record<string, unknown>;
props = typeof raw['props'] === 'object' && raw['props'] !== null
  ? raw['props'] as Record<string, unknown>
  : raw;
```
Regression test added to `src/ssr.test.ts`.

### Bug 8: docs-site getting-started page incorrect
**File:** `docs-site/app/docs/getting-started/page.tsx`
**Issues:** (a) showed migration workflow (`npm install giojs`) instead of new-app flow;
(b) health check example showed wrong response shape (`nodeReady`, `uptime`, `cacheSize`
instead of actual `http2`, `tls` fields).
**Fix:** Updated to show `npm create giojs@latest my-app` flow and corrected health
response to `{"status":"ok","http2":false,"tls":false}`.

### Bug 9: `.npmignore` too aggressive for `giojs-react`
**File:** `packages/giojs-react/.npmignore`
**Symptom:** Tarball contained only `package.json` — all source files excluded.
Since `giojs-react` is a tsx-first package (no build step), source must ship.
**Fix:** Changed `.npmignore` to only exclude test files and tsconfig; kept all `src/`.

## Notes

- **Inter font:** CSS references `Inter` via `--gio-font` custom property. Font is not
  preloaded in this test (would require `giojs-font` to download from Google Fonts at startup,
  which needs network and a `fonts:` config in `gio.toml`). System-ui fallback renders correctly.
- **Orphaned Node process:** On Windows, killing `giojs-server.exe` does not always kill
  the Node child process. During testing, stale Node processes held the IPC pipe and caused
  false test results. Production deployments should use a process manager (systemd, PM2, etc.)
  that handles process tree cleanup.
- **tsx module cache:** tsx 4.22.3 caches compiled TypeScript at `%TEMP%\tsx-{username}`.
  This cache is process-lifetime only (cleared on new Node process start) but can persist
  across test iterations if Node processes are not fully killed.

## Final test counts

| Suite | Tests | Status |
|-------|-------|--------|
| Rust workspace (11 crates) | 106 | ✅ All pass |
| giojs-core (Node) | 16 | ✅ All pass (+2 new regression tests) |
| giojs-react (Node) | 7 | ✅ All pass |
| **Total** | **129** | ✅ |
