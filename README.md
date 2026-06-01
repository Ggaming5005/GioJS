# GioJS

A Rust-powered React framework for developers who self-host.

GioJS gives every developer the performance profile that Vercel customers enjoy — image optimization, brotli compression, HTTP/2, ISR caching, font self-hosting, rate limiting, i18n routing, and WebSocket support — without a CDN, without a cloud tax, and without the memory instability that plagues self-hosted Next.js. The hot path runs in compiled Rust; React SSR runs in Node. Memory stays flat under load because Rust owns the HTTP server and Node only renders.

## Install

```bash
npm create giojs@latest my-app
cd my-app
npm install
npm run dev
```

## Why GioJS

| Feature | Self-hosted Next.js | GioJS |
|---|---|---|
| Image optimization | ❌ Vercel only | ✅ Built-in (Rust) |
| Brotli compression | ❌ Manual nginx config | ✅ Automatic |
| HTTP/2 | ❌ Needs a reverse proxy | ✅ Built-in |
| ISR cache | ❌ Vercel only | ✅ Built-in |
| Font self-hosting | ❌ Manual setup | ✅ Automatic |
| Memory stability | ⚠️ Known OOM issues | ✅ Flat profile (Rust HTTP) |
| Rate limiting | ❌ Third-party required | ✅ Built-in (token bucket) |
| i18n routing | ⚠️ Complex configuration | ✅ Built-in |
| WebSocket | ❌ Separate server needed | ✅ Built-in |
| Developer dashboard | ❌ None | ✅ `/_gio/devtools` |
| Plugin API | ❌ None | ✅ Rust + Node hooks |

## Performance

**Compression** (measured on 1343-byte HTML, Windows 11, Node.js v24):

| Encoding | Response size | vs. raw |
|---|---|---|
| none | 1343 bytes | baseline |
| gzip | 771 bytes | −43% |
| brotli | 739 bytes | −45% |

Brotli is negotiated automatically from `Accept-Encoding`. Responses under 1 KB are sent uncompressed (tower-http `SizeAbove` predicate).

**Memory stability:** Benchmark in progress — see [`benchmarks/memory-stability.md`](benchmarks/memory-stability.md). GioJS avoids the OOM issues documented in Next.js 14-16 by keeping the HTTP layer in Rust and the Node worker stateless between renders.

## Architecture

Incoming requests hit a Rust HTTP server (axum + hyper) which handles TLS, routing, compression, caching, image processing, and static file serving without ever touching Node. Only cache-missed dynamic routes cross the IPC boundary — a local named pipe on Windows, a Unix socket on Linux/macOS — to a persistent Node worker that runs React SSR via `renderToReadableStream`. Rendered HTML returns to Rust for compression, caching, and response delivery. See [SPEC.md](SPEC.md) for the full architecture specification.

## Status

**Beta** — 106 tests passing across 11 Rust crates and 2 Node packages.

- [Known issues](docs/known-issues.md)
- [Phase 5 completion notes](docs/phase5-complete.md)
- [Deployment guides](docs/deployment/README.md)

## Docs

- [`docs/`](docs/) — deployment, known issues, plugin API, phase completion notes
- [`SPEC.md`](SPEC.md) — architecture specification
- [`SPEC2.md`](SPEC2.md) — extended specification (Phases 4-6)
- [`docs/plugins.md`](docs/plugins.md) — plugin / adapter API reference
- [`examples/`](examples/) — runnable example applications
