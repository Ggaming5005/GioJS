# create-giojs

Scaffold a new [**GioJS**](https://giojs.com) app - the Rust-powered React framework.

```bash
npm create giojs@latest
```

You'll be asked a couple of questions (with an arrow-key picker):

- **Language** - TypeScript or JavaScript
- **Type** - **Server app** (full SSR, ISR caching, image optimization, route handlers) or **Static site** (`gio export` → plain HTML, deploy free to any static host)

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
#   --tailwind --api --auth --db --docker --ci   starter features
#   --features tailwind,auth,db                  the same, as a list
```

## Starter features

Pick them in the "Add features" prompt, pass the flags above, or add them to an existing app later:

```bash
npx create-giojs add tailwind auth
#   --dry-run   show what would change, write nothing
#   --force     overwrite files you changed (otherwise: refuse, with a diff)
#   --cwd <dir> the project directory
```

- **tailwind** - Tailwind CSS v4 via its CLI; `npm run dev` runs the watcher next to the server
- **api** - a JSON `route.ts` (GET/POST, validation, status codes) and a `<GioForm>` page action
- **auth** - cookie sessions, login/logout, a `/dashboard` guarded in Rust, demo credentials from `.env.development`
- **db** - SQLite + Drizzle ORM on Node's built-in `node:sqlite` (Node 22.16+), migrations and a seeded table
- **docker** - a multi-stage Dockerfile built with `gio build standalone`, non-root, with a health check; plus compose
- **ci** - a GitHub Actions workflow: install, typecheck, test, build

`add` never overwrites a file you changed - a conflict stops the run before anything is written - and running it again changes nothing. Details: https://giojs.com/docs/starter-features

## Migrating from Next.js

```bash
npm create giojs@latest -- migrate [dir]
#   --dry-run   show the plan and a diff of every change, write nothing
#   -y, --yes   apply without the confirmation prompt
```

Moves `pages/` to `app/`, rewrites `next/*` imports (`next/link`, `next/image`, `next/router`, `next/head`, ...), converts `next.config` redirects/rewrites/headers/images/i18n to `gio.toml` (never overwriting an existing one), updates `package.json` (GioJS packages, `"type": "module"`), renames `.js` files with JSX to `.jsx`, and writes `MIGRATION_REPORT.md` with every change and TODO. The `gio-migrate` bin runs the same command. Details: https://giojs.com/docs/migration

## What you get

A minimal app using file-based routing (`app/page.tsx`, `layout.tsx`, dynamic `[id]` routes), `getServerSideProps` for server data, and the `@gio.js/react` components (`GioLink`, `GioImage`).

## Links

- 🌐 Website & docs - **https://giojs.com**
- 📦 Framework - [`@gio.js/server`](https://www.npmjs.com/package/@gio.js/server)
- 🐙 GitHub - https://github.com/Ggaming5005/GioJS

MIT © GioJS
