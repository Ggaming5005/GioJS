# {{PROJECT_NAME}} — GioJS app (agent notes)

This is a GioJS project: a Rust server owns HTTP, routing, caching,
compression, static files, and image optimization; a persistent Node worker
renders React. Full docs: https://giojs.com/llms.txt

## Conventions that differ from Next.js

- File routing lives in `app/`: `page.tsx` (pages), `layout.tsx` (nested
  layouts), `route.ts` (API handlers exporting GET/POST/PUT/PATCH/DELETE),
  `not-found.tsx`, `error.tsx`. Dynamic segments: `[id]`; catch-all: `[...slug]`.
- Data fetching is `export async function getServerSideProps(ctx)` returning
  `{ props }` (optionally `{ props, headers }` or a redirect). There are NO
  React Server Components, no `use client`/`use server`, no server actions.
- Never fetch inside a component render; never use `useEffect` for data that
  belongs in `getServerSideProps`.
- Caching: `export const revalidate = <seconds>` on a page enables ISR in the
  Rust cache (`false` = cache forever). Caching happens in Rust, never in Node.
- Components come from `@gio.js/react`: `<GioLink>` (client nav + prefetch),
  `<GioImage>` (points at the built-in `/_gio/image` optimizer — never add
  `sharp` or `next/image`). Route-handler types come from `@gio.js/core`
  (`GioRequest`, `GioEventStream` for SSE).
- WebSockets: export `wsHandler(socket)` from a `route.ts`.
- Config is `gio.toml` (server, TLS, images.remote_patterns, rate_limits,
  fonts, i18n, websocket, metrics). There is no `[cache]`/redirects/rewrites
  section.

## Commands

- `npm run dev` — dev server with watch mode + browser reload
- `npm start` — production server (no separate build step; routes and client
  bundles are built at startup)
- Health: `GET /_gio/health` · Dev dashboard: `/_gio/devtools` (dev only)
