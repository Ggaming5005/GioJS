# create-giojs

Scaffold a new [**GioJS**](https://giojs.com) app - the Rust-powered React framework.

```bash
npm create giojs@latest
```

You'll be asked a few questions (with an arrow-key picker):

- **Project name** - the directory; the npm package name is derived from it (sanitized if needed)
- **Language** - TypeScript or JavaScript
- **Type** - **Server app** (full SSR, ISR caching, image optimization, route handlers) or **Static site** (`gio export` → plain HTML, deploy free to any static host)
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
#   -h, --help / -v, --version
```

Without a terminal (CI, piped input) nothing is asked: unanswered options take their defaults. A non-empty target directory is refused unless `--force`; unknown flags are an error with a did-you-mean hint; Ctrl+C at a prompt exits without writing anything.

## Migrating from Next.js

```bash
npm create giojs@latest -- migrate [dir]
#   --dry-run   show the plan and a diff of every change, write nothing
#   -y, --yes   apply without the confirmation prompt
```

Moves `pages/` to `app/`, rewrites `next/*` imports (`next/link`, `next/image`, `next/router`, `next/head`, ...), converts `next.config` redirects/rewrites/headers/images/i18n to `gio.toml` (never overwriting an existing one), updates `package.json` (GioJS packages, `"type": "module"`), renames `.js` files with JSX to `.jsx`, and writes `MIGRATION_REPORT.md` with every change and TODO. The `gio-migrate` bin runs the same command. Details: https://giojs.com/docs/migration

## What you get

A small app built on the framework's own features: file-based routing (`app/page.tsx`, `layout.tsx`, a dynamic `posts/[id]` route with `getServerSideProps` and `getStaticPaths`), the metadata API for titles and descriptions, global CSS imported from `app/layout.tsx`, fonts self-hosted from `public/fonts/` via `[[fonts]]` in `gio.toml`, typed props from `@gio.js/core`, the `@gio.js/react` components, plus `.gitignore`, `.env.example` and an `AGENTS.md` for coding agents.

## Links

- 🌐 Website & docs - **https://giojs.com**
- 📦 Framework - [`@gio.js/server`](https://www.npmjs.com/package/@gio.js/server)
- 🐙 GitHub - https://github.com/Ggaming5005/GioJS

MIT © GioJS
