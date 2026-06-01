# Phase 4 Complete

## P4.1 — Lightning CSS Integration

A Rust-native CSS pipeline powered by the `lightningcss` crate was added as `crates/giojs-css`. At server startup, all CSS files under `app/` are discovered, transformed (minification, vendor prefix injection, modern-syntax transpilation via nesting and `:is()`), and cached in a `DashMap<String, Bytes>` keyed by URL path. The `dynamic_handler` in `giojs-server` serves pre-transformed CSS directly from this in-memory cache on `.css` requests, bypassing the IPC call entirely. Configuration lives in `gio.toml` under `[css]` with `enabled`, `minify`, and `critical_extraction` flags.

## P4.2 — Critical CSS Extraction

Building on the P4.1 CSS cache, `giojs-server` now performs inline critical CSS injection for every HTML response. The `extract_critical_snippet` function uses `giojs-css::extract_critical` to scan the rendered HTML for class names, filter the pre-transformed `/globals.css` down to only the rules those classes need, and inline the result as a `<style>` block before `</head>`. The full stylesheet is then loaded asynchronously via a `<link media="print">` swap pattern, eliminating render-blocking CSS on first paint. Critical extraction only fires on cacheable pages (non-cacheable responses skip it to avoid repeated filesystem reads on high-churn routes).

## P4.3 — View Transitions API

`<GioLink>` gained a `transition` prop (`'fade' | 'slide-left' | 'slide-up' | 'scale' | false`). When set, clicks trigger `document.startViewTransition()` (feature-detected at call time) with DOMParser-based `#__gio` node replacement instead of `document.write`, so CSS, `<html>` attributes, and the ongoing animation all survive the swap. The four preset keyframe animations plus a `prefers-reduced-motion` override are injected as a React 19 `<style href="gio-transitions" precedence="default">` element — deduplicated automatically during SSR. Navigation without `transition` still works; hover-intent prefetch, hard-reload detection, and `history.pushState` are unchanged.

## P4.4 — Animate Component

A new `<Animate>` React component wraps any child with scroll-triggered entrance animations. Six presets (`fade-up`, `fade-in`, `slide-left`, `slide-right`, `scale-in`, `blur-in`) are delivered as a self-contained `<style>` block using React 19 style hoisting — no CSS import needed. Duration and delay are CSS custom properties (`--gio-duration`, `--gio-delay`) set via the `style` prop. When `when="visible"` (default), a module-level `IntersectionObserver` singleton (initialized lazily, SSR-safe) observes the element and sets `data-gio-animate-state="entered"` on intersection. When `when="immediate"`, the state is set synchronously in a `useEffect`. For apps without a root layout, `giojs-core/src/ssr.ts` injects an inline observer bootstrap `<script>` into the SSR document shell.

## P4.5 — WebSocket + SSE Support

WebSocket connections run over a dedicated second IPC channel (`\\.\pipe\giojs-ws` / `/tmp/giojs-ws.sock`) separate from the HTTP IPC pipe, keeping long-lived connections from blocking short-lived page renders. On the Rust side, `ws_registry.rs` provides a lock-free `DashMap`-backed connection store; `ws_ipc.rs` implements the `WsIpcClient` that connects to Node's WS pipe server; `ws.rs` upgrades axum connections, assigns UUID `connId`s, and runs a `tokio::select!` loop bridging browser frames to the IPC client with a configurable ping timer. SSE uses the existing HTTP IPC pipe — Node sends `sse_chunk`/`sse_done` messages and Rust forwards them as a streaming axum body via `SseBodyStream`, a custom `Stream` impl whose `Drop` sends `sse_close` to Node so cleanup callbacks always run. App developers export `wsHandler(socket: GioSocket)` or `GET(req): GioEventStream` from `route.ts` files; the React side provides a `useWebSocket` hook that wraps the native WebSocket API with SSR safety and hooks-rule compliance.
