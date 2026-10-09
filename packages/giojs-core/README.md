# @gio.js/core

Internal Node runtime for [**GioJS**](https://giojs.com) - the React SSR bridge that the Rust server talks to over IPC. It also powers `gio export` (static export).

> **Start from a scaffold** - it lists `@gio.js/core` next to
> [`@gio.js/server`](https://www.npmjs.com/package/@gio.js/server) (which also depends on it):
>
> ```bash
> npm create giojs@latest
> ```
>
> App code imports its helpers and types from it - `redirect`, `notFound`, sessions, cookies,
> and `GetServerSideProps`, `PageProps`, `LayoutProps`, `GioRequest`, `RouteHandler`, ... - so
> list it as a direct dependency (strict installs like pnpm resolve nothing else).

## What it does

- Discovers `page` / `layout` / `route` files (`.tsx` / `.jsx` / `.js`) under `app/`.
- Renders routes to HTML via `renderToReadableStream`, running `getServerSideProps`.
- Bridges to the Rust server over a length-prefixed IPC protocol.
- Pre-renders to static HTML (`gio export`) that hydrates from client bundles written alongside it, generating `robots.txt` + `sitemap.xml`.
- Types for app code: one per file convention (`GetServerSideProps<Props, '/posts/:id'>`, `PageProps`, `LayoutProps`, `ErrorPageProps`, `RouteHandler`, ...), with params typed from the generated `.gio/routes.d.ts` - see https://giojs.com/docs/functions.
- Test helpers for apps: `@gio.js/core/testing` (`renderPage`, `callRoute`, `createTestServer`), plus `@gio.js/core/vitest` (`gioVitest()`, CSS Module class names as the server renders them) - see https://giojs.com/docs/testing.

## Links

- 🌐 Website & docs - **https://giojs.com**
- 🐙 GitHub - https://github.com/Ggaming5005/GioJS

MIT © GioJS
