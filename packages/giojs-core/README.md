# @gio.js/core

Internal Node runtime for [**GioJS**](https://giojs.com) — the React SSR bridge that the Rust server talks to over IPC. It also powers `gio export` (static export).

> **You probably don't want to install this directly.** Scaffold an app instead:
>
> ```bash
> npm create giojs@latest
> ```
>
> `@gio.js/core` is a dependency of [`@gio.js/server`](https://www.npmjs.com/package/@gio.js/server).

## What it does

- Discovers `page` / `layout` / `route` files (`.tsx` / `.jsx` / `.js`) under `app/`.
- Renders routes to HTML via `renderToReadableStream`, running `getServerSideProps`.
- Bridges to the Rust server over a length-prefixed IPC protocol.
- Pre-renders to static HTML (`gio export`), generating `robots.txt` + `sitemap.xml`.

## Links

- 🌐 Website & docs — **https://giojs.com**
- 🐙 GitHub — https://github.com/Ggaming5005/GioJS

MIT © GioJS
