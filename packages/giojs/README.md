# @gio.js/server

The [**GioJS**](https://giojs.com) server — a Rust-powered React framework. The performance-critical hot path (HTTP/2, compression, image optimization, ISR caching, static files) runs in compiled Rust; Node renders your React.

> **Self-hosted React at Vercel speed.** The same performance profile as a managed cloud — on any server you own. No CDN tax.

## Get started

Don't install this directly — scaffold a project:

```bash
npm create giojs@latest
```

It installs `@gio.js/server` (this package — the binary + Node bridge), `@gio.js/react`, and the right prebuilt platform binary automatically.

```bash
npm run dev      # development server
gio export       # pre-render to static HTML in out/
```

## What's inside

- **Rust** — HTTP/2 & TLS, routing, brotli/gzip, image optimization (`/_gio/image`), the ISR page cache, static files, middleware, Prometheus metrics.
- **Node** — React SSR via `renderToReadableStream`, `getServerSideProps`, nested layouts, route handlers, WebSockets.

A request only reaches Node when it's a dynamic render that missed the cache — everything else is served entirely from Rust.

## Links

- 🌐 Website & docs — **https://giojs.com**
- 🚀 Scaffolder — [`create-giojs`](https://www.npmjs.com/package/create-giojs)
- 🐙 GitHub — https://github.com/Ggaming5005/GioJS

MIT © GioJS
