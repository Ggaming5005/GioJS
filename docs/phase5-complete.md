# Phase 5 — Complete

## P5.1 — WebSockets

GioJS now supports full-duplex WebSocket connections through the same Rust/Node boundary that handles HTTP. Rust accepts and manages the WebSocket upgrade via axum's built-in `WebSocketUpgrade` extractor, then proxies messages over a dedicated named pipe (`giojs-ws`) to a Node worker that runs user-defined `wsHandler` exports. The registry tracks connections by ID and route, exposing `send`, `broadcast`, `close`, and `on('message')` / `on('close')` hooks to application code. The `giojs-ws` pipe is separate from the main IPC pipe so WebSocket and HTTP rendering never block each other.

## P5.2 — i18n Routing

Locale detection and routing is handled entirely in Rust via the new `giojs-i18n` crate, so the IPC round-trip is only paid when a locale match is confirmed. The crate reads a `[i18n]` section from `gio.toml` (locales list, default locale, detection order), runs a three-tier detection strategy — URL prefix, then cookie, then `Accept-Language` header — and strips the locale prefix from the path before the request reaches the Node SSR worker. Detected locale is forwarded to Node as `req.locale`. 98 tests passed at the end of this phase, including 7 new i18n-specific unit tests covering each detection path and edge cases (empty config passthrough, root path normalization, unknown prefixes).

## P5.3 — DevTools Dashboard

A browser-based observability dashboard is served at `/_gio/devtools` in development mode and returns 404 in production (routes are simply not registered). The dashboard is generated entirely in Rust as a self-contained HTML page with inline CSS and JavaScript — no React, no Node, no external requests. Six panels update in real time via Server-Sent Events: a live request log (ring buffer, last 100 entries, newest first), route manifest with render-mode badges (static / ISR / dynamic / WS), cache statistics, an SVG memory sparkline (10-second samples), an IPC latency histogram (SVG bar chart from Prometheus-style cumulative buckets), and active connection counts (HTTP / WebSocket / SSE). The Node READY message was extended to include the full route manifest so the dashboard is populated before any requests arrive.

## P5.4 — Plugin / Adapter API

GioJS now has a stable extension interface for third-party packages. The Rust surface (`giojs-plugin` crate) defines a `GioPlugin` trait with `name`, `version`, `middleware`, `routes`, `on_startup`, and `on_shutdown` hooks; a `PluginRegistry` manages lifecycle ordering (startup in registration order, shutdown in reverse) and applies middleware and routes to the final `Router<()>` after `with_state()`. The Node surface (`GioNodePlugin` interface in `giojs-core`) adds `onRequest` and `onResponse` intercept hooks: `onRequest` can short-circuit SSR by returning an `IPCResponse` directly, while `onResponse` post-processes the rendered output. Plugins are declared in a new optional `gio.config.ts` file at the project root, loaded via `tsImport()`. Plugin errors are caught and yield a 500 response — the Node process never crashes due to a plugin fault. A reference auth plugin (`packages/giojs-auth-example`) and a runnable demo (`examples/auth-demo`) prove the API end-to-end: routes under `/admin/*` return 403 without a valid session cookie and 200 with one.
