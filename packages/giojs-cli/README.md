# create-giojs

Scaffold a new [**GioJS**](https://giojs.com) app — the Rust-powered React framework.

```bash
npm create giojs@latest
```

You'll be asked a couple of questions (with an arrow-key picker):

- **Language** — TypeScript or JavaScript
- **Type** — **Server app** (full SSR, ISR caching, image optimization, route handlers) or **Static site** (`gio export` → plain HTML, deploy free to any static host)

Then:

```bash
cd my-app
npm run dev
```

## Non-interactive

```bash
npm create giojs@latest my-app -- --ts --server
#   --js / --ts          language
#   --static / --server  build target
#   --no-install         skip dependency install
#   -y, --yes            accept defaults
```

## What you get

A minimal app using file-based routing (`app/page.tsx`, `layout.tsx`, dynamic `[id]` routes), `getServerSideProps` for server data, and the `@gio.js/react` components (`GioLink`, `GioImage`).

## Links

- 🌐 Website & docs — **https://giojs.com**
- 📦 Framework — [`@gio.js/server`](https://www.npmjs.com/package/@gio.js/server)
- 🐙 GitHub — https://github.com/Ggaming5005/GioJS

MIT © GioJS
