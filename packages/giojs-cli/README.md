# create-giojs

Scaffold a new [**GioJS**](https://giojs.com) app - the Rust-powered React framework.

```bash
npm create giojs@latest
```

You'll be asked a few questions (with an arrow-key picker):

- **Project name** - the directory; the npm package name is derived from it (sanitized if needed)
- **Language** - TypeScript or JavaScript
- **Type** - **Server app** (full SSR, ISR caching, image optimization, route handlers) or **Static site** (`gio export` → plain HTML, deploy free to any static host)
- **Add features** - optional starter features (Tailwind, an API route, auth, a database, Docker, CI; see below)
- **Install dependencies** - with the package manager you ran it with (npm, pnpm, yarn or bun)

It then runs `git init` with an initial commit (unless the directory is already inside a git repository), and prints the next steps:

```bash
cd my-app
npm run dev
```

## Options

```bash
npm create giojs@latest my-app -- --ts --server
#   [directory]          where the app goes ('.' = current directory)
#   --ts / --js          language
#   --server / --static  build target
#   --pm <name>          npm, pnpm, yarn or bun (default: detected)
#   --no-install         skip dependency install
#   --no-git             skip git init + initial commit
#   -f, --force          scaffold into a non-empty directory
#   -y, --yes            accept defaults
#   --tailwind --api --auth --db --docker --ci   starter features
#   --features tailwind,auth,db                  the same, as a list
#   -h, --help / -v, --version
```

Without a terminal (CI, piped input) nothing is asked: unanswered options take their defaults (and no starter features). A non-empty target directory is refused unless `--force` (whose initial commit then holds only the files the scaffold created - what was already there stays untracked, even a file such as `.env.development` that a starter feature added lines to); unknown flags are an error with a did-you-mean hint; Ctrl+C at a prompt exits without writing anything.

## Starter features

Pick them in the "Add features" prompt, pass the flags above, or add them to an existing app later (`gio add` runs the same command):

```bash
npx create-giojs add tailwind auth
#   --dry-run    show what would change, write nothing
#   -f, --force  overwrite files you changed (otherwise: keep or refuse, see below)
#   --cwd <dir>  the project directory
npx create-giojs add --tailwind --features auth,db   # create's feature flags work too
```

- **tailwind** - Tailwind CSS v4 via its CLI; `npm run dev` runs the watcher next to the server
- **api** - a JSON `route.ts` (GET/POST, validation, status codes) and a `<GioForm>` page action
- **auth** - cookie sessions, login/logout, a `/dashboard` guarded in Rust, demo credentials from `.env.development`
- **db** - SQLite + Drizzle ORM on Node's built-in `node:sqlite` (Node 22.16+), migrations and a seeded table
- **docker** - a multi-stage Dockerfile built with `gio build standalone`, non-root, with a health check; plus compose
- **ci** - a GitHub Actions workflow: install, typecheck, test, build

A static site (`--static`) takes **tailwind** and **ci**; the others need the server, and asking for them is an error before anything is written. The generated commands (Dockerfile, CI workflow, next steps) use the package manager the app is installed with: `--pm`, or the one that ran `create`; for `add`, the project's lockfile.

Like `create`, `add` treats an unknown option or feature as a usage error (exit code 2, with a did-you-mean hint). It never overwrites a file you changed. A feature that is already set up keeps your edits to its files, so running it again (alone or next to a new feature) is safe; a file of yours in the way of a new feature is a conflict that stops the run before anything is written, with a diff. Details: https://giojs.com/docs/starter-features

## Migrating from Next.js

```bash
npm create giojs@latest -- migrate [dir]
#   --dry-run   show the plan and a diff of every change, write nothing
#   -y, --yes   apply without the confirmation prompt
```

Moves `pages/` to `app/`, rewrites `next/*` imports (`next/link`, `next/image`, `next/router`, `next/head`, ...), converts `next.config` redirects/rewrites/headers/images/i18n to `gio.toml` (never overwriting an existing one), updates `package.json` (GioJS packages, `"type": "module"`), renames `.js` files with JSX to `.jsx`, and writes `MIGRATION_REPORT.md` with every change and TODO. The `gio-migrate` bin runs the same command. Details: https://giojs.com/docs/migration

## What you get

A small app built on the framework's own features: file-based routing (pages in an `app/(site)/` route group whose hydrated `layout.tsx` renders the navigation, a dynamic `posts/[id]` route with `getServerSideProps` and `getStaticPaths`), the metadata API for titles and descriptions, global CSS imported from `app/layout.tsx`, fonts self-hosted from `public/fonts/` via `[[fonts]]` in `gio.toml`, typed props from `@gio.js/core`, the `@gio.js/react` components, plus `.gitignore`, `.env.example` and an `AGENTS.md` for coding agents.

## Links

- 🌐 Website & docs - **https://giojs.com**
- 📦 Framework - [`@gio.js/server`](https://www.npmjs.com/package/@gio.js/server)
- 🐙 GitHub - https://github.com/Ggaming5005/GioJS

MIT © GioJS
