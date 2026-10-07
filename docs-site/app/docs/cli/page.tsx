import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">API Reference</div>
      <h1>CLI</h1>
      <p className="page-subtitle">
        The <code>gio</code> command runs, inspects and packages GioJS apps. It ships with{' '}
        <code>@gio.js/server</code>; <code>create-giojs</code> scaffolds new ones.
      </p>

      <h2 id="commands">Commands</h2>
      <table>
        <thead>
          <tr><th>Command</th><th>What it does</th></tr>
        </thead>
        <tbody>
          <tr><td><a href="#dev"><code>gio dev</code></a></td><td>Start the development server: file watcher, error overlay, live reload</td></tr>
          <tr><td><a href="#start"><code>gio start</code></a></td><td>Start the production server</td></tr>
          <tr><td><a href="#build"><code>gio build</code></a></td><td>Explain deploys; <code>gio build standalone</code> packages a self-contained deploy directory</td></tr>
          <tr><td><a href="#export"><code>gio export</code></a></td><td>Render the app to static HTML in <code>out/</code></td></tr>
          <tr><td><a href="#routes"><code>gio routes</code></a></td><td>List every route the app serves</td></tr>
          <tr><td><a href="#typegen"><code>gio typegen</code></a></td><td>Write <code>.gio/routes.d.ts</code> without starting the server</td></tr>
          <tr><td><a href="#doctor"><code>gio doctor</code></a></td><td>Check the environment and project, with a fix for each problem</td></tr>
          <tr><td><a href="#info"><code>gio info</code></a></td><td>Print versions and environment details for bug reports</td></tr>
          <tr><td><a href="#cache-explain"><code>gio cache explain</code></a></td><td>Explain how the cache served a URL</td></tr>
          <tr><td><a href="#bench"><code>gio bench</code></a></td><td>Load-test a running server</td></tr>
          <tr><td><a href="#migrate"><code>gio migrate</code></a></td><td>Migrate a Next.js app (runs <code>create-giojs migrate</code>)</td></tr>
          <tr><td><a href="#add"><code>gio add</code></a></td><td>Add a feature to the app (runs <code>create-giojs add</code>)</td></tr>
          <tr><td><code>gio help [command]</code></td><td>The command list, or one command&apos;s options</td></tr>
        </tbody>
      </table>
      <CodeBlock lang="bash" code={`gio --help             # the command list
gio help dev           # one command's options (same as: gio dev --help)
gio --version          # CLI, server binary and @gio.js/core versions (-v)`} />
      <p>
        A mistyped command or option is an error with a suggestion (
        <code>gio strat</code> → <em>did you mean <code>gio start</code>?</em>), never a
        silently started server. <code>gio</code> with no command prints the help and exits
        with code 2.
      </p>

      <h3 id="exit-codes">Exit codes</h3>
      <table>
        <thead>
          <tr><th>Code</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td><code>0</code></td><td>Success</td></tr>
          <tr><td><code>1</code></td><td>The command failed: the server exited with an error (its own exit code is passed through), <code>gio doctor</code> found an error, no server binary, a route conflict, an unreachable server</td></tr>
          <tr><td><code>2</code></td><td>Usage error: unknown command or option, missing or malformed argument</td></tr>
        </tbody>
      </table>

      <h2 id="dev">gio dev</h2>
      <CodeBlock lang="bash" code={`gio dev [--port <port>] [--host <ip>] [--open]

  -p, --port <port>   port to listen on (sets GIO_PORT)
  -H, --host <ip>     address to bind (sets GIO_HOST); "localhost" means 127.0.0.1,
                      IPv6 as :: or [::] (every interface), ::1
      --open          open the app in a browser once it is ready`} />
      <p>
        Starts the server with <code>NODE_ENV=development</code>. Once{' '}
        <code>/_gio/health</code> reports the Node worker ready, it prints where the app is:
      </p>
      <CodeBlock lang="text" code={`  GioJS 0.1.0 (dev)
  - Local:    http://localhost:3000
  - Network:  http://192.168.1.20:3000`} />
      <p>
        The listen address is resolved exactly as the server resolves it:{' '}
        <code>--port</code> / <code>--host</code> (passed as <code>GIO_PORT</code> /{' '}
        <code>GIO_HOST</code>), then <code>PORT</code>, then <code>gio.toml</code>&apos;s{' '}
        <code>[server]</code> table - including values from <code>.env</code> files - then{' '}
        <code>0.0.0.0:3000</code> (see{' '}
        <a href="/docs/configuration#listen-address">Listen address</a>). The host must be an
        IP address: <code>0.0.0.0</code> for every interface, <code>127.0.0.1</code> for this
        machine only, and for IPv6 <code>::</code> / <code>::1</code> (with or without
        brackets - <code>GIO_HOST</code> receives them bracketed, as the server expects).
      </p>
      <h3>Dev mode file watching</h3>
      <p>In dev mode the server watches the whole project, not just app/ - edits to components/, lib/, src/, hooks/, gio.toml, middleware.ts, or tsconfig.json clear the page cache, re-transform app CSS, restart the Node worker, and reload open browser tabs. Edits under public/ refresh which files are served at the site root and reload the browser without a worker restart.</p>
      <ul>
        <li>Any change under app/ triggers a restart, as pages may read any file there. Elsewhere only source-like files do (<code>.ts .tsx .js .jsx .mjs .cjs .mts .cts .json .css .toml</code>), plus directories created, deleted, or moved in or out, so databases, logs, and uploads your app writes into the project never restart the worker that wrote them.</li>
        <li>Never watched: node_modules/ (at any depth), hidden directories such as .git/ and .gio/ (the worker&apos;s own build output), and the top-level build output directories out/, dist/, build/, target/, standalone/, and coverage/. Editor scratch files (<code>~</code> backups, <code>.swp</code>/<code>.swx</code>, <code>4913</code>, <code>.#</code> locks) are ignored.</li>
        <li>Ignored directories are kept out of the watch registration itself, so a large node_modules/ does not use up Linux inotify watches. If a project is big enough to hit the limit anyway, the server logs which directory went unwatched; raise <code>fs.inotify.max_user_watches</code>.</li>
      </ul>

      <h2 id="start">gio start</h2>
      <CodeBlock lang="bash" code={`gio start [--port <port>] [--host <ip>] [--open]

PORT=8080 gio start          # hosting platforms that assign the port`} />
      <p>
        Starts the server with <code>NODE_ENV=production</code>, whatever{' '}
        <code>NODE_ENV</code> the shell has. Same options and ready banner as{' '}
        <code>gio dev</code>. There is no build step before it: routes and client bundles are
        built at startup, pages render on demand and are cached in Rust.
      </p>
      <p>
        Both commands stay in the foreground until the server exits and exit with its code.
        Ctrl+C and <code>SIGTERM</code> shut the server down gracefully; if the{' '}
        <code>gio</code> process itself is killed outright, the server notices (its stdin
        pipe closes) and shuts down instead of lingering on the port.
      </p>

      <h2 id="build">gio build</h2>
      <CodeBlock lang="bash" code={`gio build                                          # explains: normal deploys have no build step
gio build standalone [--out <dir>] [--target <platform>]`} />
      <p>
        <code>gio build standalone</code> packages the app into one directory - the Rust
        binary, the whole Node side bundled into <code>worker.js</code>, prebuilt chunks,{' '}
        <code>public/</code> and <code>gio.toml</code> - that runs anywhere Node is installed
        with <code>node run.mjs</code>. See <a href="/docs/standalone">Standalone Deploys</a>.
      </p>

      <h2 id="export">gio export</h2>
      <CodeBlock lang="bash" code={`gio export       # → out/`} />
      <p>
        Renders every page to static HTML with the client chunks that hydrate it, for static
        hosts. Never starts the Rust server, so it needs no platform binary.{' '}
        <code>GIO_APP_DIR</code> and <code>GIO_OUT_DIR</code> override the input and output
        directories. See <a href="/docs/static-export">Static Export</a>.
      </p>

      <h2 id="routes">gio routes</h2>
      <CodeBlock lang="bash" code={`gio routes [--json]`} />
      <p>
        Lists every URL the app serves, discovered exactly as the server discovers them at
        startup (the same conflict errors included), without starting it:
      </p>
      <CodeBlock lang="text" code={`Route              Type            File                          Wrapped by
/                  page            app/page.tsx                  layout app/  not-found app/
/api/notes         route GET,POST  app/api/notes/route.ts
/posts/:id         page            app/posts/[id]/page.tsx       layout app/ > app/posts/  loading app/posts/
/robots.txt        metadata        app/robots.ts
/ws/rooms/:room    websocket       app/ws/rooms/[room]/route.ts

5 routes, 2 dynamic   (:param one segment, *param catch-all, *param? optional catch-all)`} />
      <ul>
        <li><strong>page</strong> rows show the layouts that wrap the page, outermost first, and the nearest <code>loading</code>, <code>error</code> and <code>not-found</code> files.</li>
        <li><strong>route</strong> rows are <code>route.ts</code> HTTP handlers with the methods they export; a <code>route.ts</code> exporting <code>wsHandler</code> also gets a <strong>websocket</strong> row.</li>
        <li><strong>metadata</strong> rows are <code>app/sitemap.ts</code>, <code>app/robots.ts</code> and <code>app/manifest.ts</code>.</li>
      </ul>
      <p>
        <code>route.ts</code> files are imported to read their exports, as at startup, after
        the project&apos;s <code>.env</code> files load; page modules are not. A{' '}
        <code>route.ts</code> that fails to import is listed with its error. With{' '}
        <code>--json</code> the output is <code>{'{ routes: [...] }'}</code>, each entry
        carrying <code>pattern</code>, <code>kind</code>, <code>methods</code>,{' '}
        <code>file</code>, <code>params</code> (<code>name</code>, <code>catchAll</code>,{' '}
        <code>optional</code>), <code>layouts</code>, <code>loading</code>,{' '}
        <code>error</code> and <code>notFound</code>.
      </p>

      <h2 id="typegen">gio typegen</h2>
      <CodeBlock lang="bash" code={`gio typegen && tsc --noEmit`} />
      <p>
        Writes <code>.gio/routes.d.ts</code> and <code>.gio/css-modules.d.ts</code> - the
        declarations behind <code>href(&apos;/posts/:id&apos;, {'{ id }'})</code>,{' '}
        <code>PageProps</code>, <code>GsspContext</code> and CSS Module imports. The server
        regenerates them at every start; run <code>gio typegen</code> in CI before{' '}
        <code>tsc</code>, or after adding a route with no server running. A{' '}
        <code>route.ts</code> that fails to import (say it needs{' '}
        <code>GIO_SESSION_SECRET</code>, which CI does not set) is still typed, so CI and
        your machine get the same declarations. Files are only rewritten when their
        content changes. Your <code>tsconfig.json</code> must list{' '}
        <code>&quot;.gio/routes.d.ts&quot;</code> in <code>include</code> (TypeScript&apos;s
        wildcards skip dot-folders).
      </p>
      <p>
        <code>gio routes</code> and <code>gio typegen</code> exit 1 when there is no{' '}
        <code>app/</code> directory (run them from the project root, or set{' '}
        <code>GIO_APP_DIR</code>), so a CI step in the wrong directory fails instead of
        writing <code>.gio/</code> somewhere else.
      </p>

      <h2 id="doctor">gio doctor</h2>
      <CodeBlock lang="bash" code={`gio doctor [--dev | --prod] [--json]`} />
      <p>
        Checks what most often breaks a GioJS app, and prints a fix for every problem. Exits 1
        when a check fails; warnings and hints do not.
      </p>
      <p>
        The configuration checked is the one <code>NODE_ENV</code> selects, as for the server:
        development (<code>.env.development*</code>, the ephemeral dev session secret) when{' '}
        <code>NODE_ENV=development</code>, production (what <code>gio start</code> runs)
        otherwise. The output says which one it checked. <code>--dev</code> and{' '}
        <code>--prod</code> choose it explicitly. When production is only assumed because{' '}
        <code>NODE_ENV</code> is unset, a missing <code>GIO_SESSION_SECRET</code> is a warning,
        not an error: <code>gio dev</code> runs the project fine. Use <code>--prod</code> in a
        deploy pipeline to make it fail.
      </p>
      <table>
        <thead>
          <tr><th>Check</th><th>Fails when</th></tr>
        </thead>
        <tbody>
          <tr><td>Node.js</td><td>Older than GioJS needs (20), or outside your <code>package.json</code> <code>engines</code> (warning)</td></tr>
          <tr><td>Server binary</td><td>No platform binary is installed - names the package for this platform and how to install it</td></tr>
          <tr><td>Versions</td><td><code>@gio.js/server</code>, its platform binary, <code>@gio.js/core</code> and <code>@gio.js/react</code> are not the same version</td></tr>
          <tr><td>App directory</td><td>There is no <code>app/</code> (run from the project root, or set <code>GIO_APP_DIR</code>)</td></tr>
          <tr><td>gio.toml</td><td>The server would refuse to start with it - validated by the server binary itself (<a href="#check-config"><code>--check-config</code></a>); rules it would skip are warnings</td></tr>
          <tr><td>tsconfig</td><td><code>tsconfig.json</code> / <code>jsconfig.json</code> does not include <code>.gio/routes.d.ts</code> (warning)</td></tr>
          <tr><td>Session secret</td><td><code>require_session</code> guards (gio.toml or <code>middleware.ts</code>) exist but <code>GIO_SESSION_SECRET</code> is unset in production (a warning when production is only assumed), or the secret is invalid</td></tr>
          <tr><td>Port</td><td>The port the server would bind is already in use (warning)</td></tr>
          <tr><td>Proxy</td><td>Deploy files (Dockerfile, fly.toml, ...) or rate limits suggest a reverse proxy but <code>[server] trusted_proxies</code> is empty (hint)</td></tr>
          <tr><td>Cache directory</td><td>The page cache directory is not writable</td></tr>
        </tbody>
      </table>
      <p>
        <code>--json</code> prints <code>{'{ ok, mode, environment, checks }'}</code> - attach
        it to bug reports.
      </p>

      <h2 id="info">gio info</h2>
      <CodeBlock lang="bash" code={`gio info [--json]`} />
      <p>
        Prints the OS, Node.js and package manager versions, the server binary in use and the
        installed <code>@gio.js/*</code> versions - the environment half of{' '}
        <code>gio doctor</code>, without the checks.
      </p>

      <h2 id="cache-explain">gio cache explain</h2>
      <CodeBlock lang="bash" code={`gio cache explain <url-or-path> [--base <url>]

$ gio cache explain /posts/1
GET http://127.0.0.1:3000/posts/1
  status       200
  x-gio-cache  hit; ttl=42
  → Served from the Rust page cache without touching Node. ...`} />
      <p>
        Requests the URL and decodes its <code>X-Gio-Cache</code> header (see{' '}
        <a href="/docs/caching-layers">Caching Layers</a>). A path is requested from the local
        server at the address it listens on - <code>GIO_PORT</code> / <code>PORT</code>,{' '}
        <code>.env</code> files, <code>gio.toml</code> - or from <code>--base</code>.
      </p>

      <h2 id="bench">gio bench</h2>
      <CodeBlock lang="bash" code={`gio bench <url-or-path> [--connections 32] [--duration 10] [--warmup 2]
gio bench --suite /,/posts/1 [--base <url>]`} />
      <p>
        A zero-dependency load generator. Paths and <code>--suite</code> default to the local
        server, like <code>gio cache explain</code>. See{' '}
        <a href="/docs/benchmarks">Benchmarks</a>.
      </p>

      <h2 id="migrate">gio migrate</h2>
      <CodeBlock lang="bash" code={`gio migrate ./my-next-app
#   --dry-run      show the plan and a diff, write nothing
#   -y / --yes     apply without the confirmation prompt
#   --config <f>   only convert next.config to gio.toml`} />
      <p>
        Migrates a Next.js project (pages or app router) in place and writes{' '}
        <code>MIGRATION_REPORT.md</code> - see the{' '}
        <a href="/docs/migration">Migration Guide</a>. It runs{' '}
        <code>create-giojs migrate</code>: the installed <code>create-giojs</code>, otherwise{' '}
        <code>create-giojs@&lt;your gio version&gt;</code> through your package manager (
        <code>npx</code>, <code>pnpm dlx</code>, <code>bunx</code>), so both stay on the same
        release. <code>npm create giojs@latest -- migrate ./my-next-app</code> does the same.
      </p>
      <p>
        Older <code>create-giojs</code> releases treat any argument they do not know as the
        name of a new project and scaffold it, so <code>gio</code> never runs one to find out
        what it supports. It reads the subcommands from <code>create-giojs</code>&apos;s{' '}
        <code>package.json</code> instead (each one is exported as{' '}
        <code>create-giojs/&lt;name&gt;</code>): from disk for an installed copy, from the
        registry (<code>npm view</code>, which downloads and runs nothing) before{' '}
        <code>npx</code>. A release without the subcommand is reported, with the version to
        install, and never run.
      </p>

      <h2 id="add">gio add</h2>
      <CodeBlock lang="bash" code={`gio add <feature...> [--dry-run] [--force]
gio add tailwind auth  # add two starter features
gio add --help         # the features this create-giojs offers`} />
      <p>
        Adds <a href="/docs/starter-features">starter features</a> (<code>tailwind</code>,{' '}
        <code>api</code>, <code>auth</code>, <code>db</code>, <code>docker</code>,{' '}
        <code>ci</code>) to the current app by running <code>create-giojs add</code>, resolved
        and checked like <code>gio migrate</code>. Its options are those of{' '}
        <a href="#create-giojs-add"><code>create-giojs add</code></a>.
      </p>

      <h2 id="environment">Environment variables</h2>
      <table>
        <thead>
          <tr><th>Variable</th><th>Used by</th><th>Effect</th></tr>
        </thead>
        <tbody>
          <tr><td><code>GIO_SERVER_BIN</code></td><td>all server commands, <code>gio doctor</code></td><td>Use this <code>giojs-server</code> binary instead of the installed platform package (a source build, a custom target)</td></tr>
          <tr><td><code>GIO_APP_DIR</code></td><td>all</td><td>The <code>app/</code> directory; the project root is its parent</td></tr>
          <tr><td><code>GIO_PORT</code> / <code>PORT</code> / <code>GIO_HOST</code></td><td><code>dev</code>, <code>start</code>, <code>cache explain</code>, <code>bench</code>, <code>doctor</code></td><td>The listen address (<code>--port</code> / <code>--host</code> set the <code>GIO_*</code> ones)</td></tr>
          <tr><td><code>NODE_ENV</code></td><td><code>export</code>, <code>routes</code>, <code>typegen</code>, <code>doctor</code></td><td><code>development</code> selects the <code>.env.development*</code> files; <code>gio dev</code> / <code>gio start</code> set it themselves</td></tr>
        </tbody>
      </table>
      <p>
        All server settings, <code>GIO_SESSION_SECRET</code> included, are listed under{' '}
        <a href="/docs/configuration">Configuration</a>.
      </p>

      <h2 id="missing-binary">When the server binary is missing</h2>
      <p>
        The Rust server ships as an optional dependency picked by OS and CPU (
        <code>@gio.js/server-linux-x64</code>, <code>-linux-x64-musl</code>,{' '}
        <code>-darwin-arm64</code>, <code>-darwin-x64</code>, <code>-win32-x64</code>). When it
        is missing, every command that needs it says which package to install, for example:
      </p>
      <CodeBlock lang="bash" code={`npm install --save-optional @gio.js/server-linux-x64@<your @gio.js/server version>`} />
      <p>
        It is usually missing because optional dependencies were skipped (
        <code>--no-optional</code>, <code>--omit=optional</code>, <code>omit=optional</code> in{' '}
        <code>.npmrc</code>), the lockfile was written on another OS and left this platform out
        (delete <code>node_modules</code> and the lockfile, then install again), or{' '}
        <code>node_modules</code> was copied from another machine. Linux on ARM64 has no
        prebuilt binary yet: build one with <code>cargo build --release -p giojs-server</code>{' '}
        and point <code>GIO_SERVER_BIN</code> at it, or run the app in a linux-x64 container.
      </p>

      <h2 id="giojs-server">giojs-server</h2>
      <p>
        The <code>giojs-server</code> bin starts the server with no command parsing: it keeps
        the caller&apos;s <code>NODE_ENV</code> and passes its arguments to the binary, as
        projects scaffolded before <code>gio dev</code> / <code>gio start</code> use it (
        <code>cross-env NODE_ENV=development giojs-server</code>).
      </p>
      <h3 id="check-config">giojs-server --check-config</h3>
      <CodeBlock lang="bash" code={`giojs-server --check-config
{"ok":true,"mode":"production","configFile":"gio.toml","envFiles":[".env"],
 "listen":{"host":"0.0.0.0","port":3000,"portSource":"default","tls":false},
 "errors":[],"warnings":[],"sessionGuards":1,"sessionSecret":"valid",...}`} />
      <p>
        Loads the <code>.env</code> files and <code>gio.toml</code> exactly as startup does,
        prints a JSON report and exits - <code>0</code> when the server would start,{' '}
        <code>1</code> with the startup errors in <code>errors</code> - without binding a port
        or starting the worker. It runs the same validation as startup:{' '}
        <code>gio.toml</code> itself, the page cache directory&apos;s placement, <code>[security]</code> (headers,
        CSP, CSRF origins and exemptions), the revalidation token (<code>[revalidate]
        token</code> or <code>GIO_REVALIDATE_TOKEN</code>), the local <code>[[fonts]]</code>{' '}
        files (each must be a readable file under <code>public/</code>) and the TLS
        certificate and key.
        Useful as a CI step; <code>gio doctor</code>, <code>gio dev</code> and{' '}
        <code>gio start</code> use it. Secrets are reported only as <code>unset</code> /{' '}
        <code>valid</code> / <code>invalid</code>, and a <code>gio.toml</code> syntax error is
        reported by line and column, without quoting the line.
      </p>

      <h2 id="create-giojs">create-giojs</h2>
      <p>
        Scaffolds a new project. On a terminal it asks for whatever the flags leave open;
        without one (CI, piped input) or with <code>--yes</code> nothing is asked and every
        unanswered option takes its default.
      </p>
      <CodeBlock lang="bash" code={`npm create giojs@latest [directory] -- [options]

  [directory]          where the app goes ('.' = the current directory); the npm
                       package name is derived from its name
  --ts, --typescript   TypeScript (default)
  --js, --javascript   JavaScript
  --server             server app: SSR, ISR caching, images, route handlers (default)
  --static             static site: npm run build exports plain HTML to out/
  --pm <name>          package manager: npm, pnpm, yarn or bun
                       (default: the one running create-giojs)
  --install            install dependencies (default)
  --no-install         skip installing dependencies
  --git                create a git repository with an initial commit (default)
  --no-git             skip git init
  -f, --force          scaffold into a directory that is not empty
  -y, --yes            accept the defaults for everything not given
  -h, --help           show this help
  -v, --version        print the create-giojs version

Starter features (any combination; asked for when none is given):
  --tailwind --api --auth --db --docker --ci
  --features a,b,c     the same, as a list`} />
      <p>
        An unknown option is an error (exit code <code>2</code>) with a suggestion (
        <code>--statc</code> → <em>did you mean <code>--static</code>?</em>), never ignored. A
        directory that is not empty is refused, with a list of what is in it, unless{' '}
        <code>--force</code>; <code>.git</code>, <code>README.md</code>, <code>LICENSE</code>{' '}
        and editor files do not count. pnpm, yarn and bun pass the npm-style <code>--</code>{' '}
        separator on, and it is skipped. Ctrl+C at a question exits with code{' '}
        <code>130</code> and nothing written.
      </p>
      <p>
        Without feature flags the prompt asks which{' '}
        <a href="/docs/starter-features">starter features</a> to add (none without a
        terminal). A static site takes <code>--tailwind</code> and <code>--ci</code>; the
        others need the server, and asking for them is a usage error before anything is
        written. The features&apos; generated commands (Dockerfile, CI workflow, next steps)
        use the package manager the app is installed with.
      </p>

      <h3 id="create-giojs-add">create-giojs add</h3>
      <p>
        Adds starter features to an existing project (<code>gio add</code> runs it). A file
        you changed is never overwritten: a feature that is already set up keeps your edits,
        so running it again is safe, and a file in the way of a new feature stops the run
        before anything is written, with a diff. The package manager comes from the
        project&apos;s lockfile.
      </p>
      <CodeBlock lang="bash" code={`npx create-giojs add tailwind auth
#   --dry-run      show what would change, write nothing
#   -f, --force    overwrite files and scripts that differ from the feature's
#   --cwd <dir>    the project directory (default: the current one)
npx create-giojs add --tailwind --features auth,db   # create's feature flags work too`} />
      <p>
        Its parser is as strict as <code>create-giojs</code>&apos;s: an unknown option or
        feature is a usage error (exit code <code>2</code>) with a suggestion (
        <code>tailwnd</code> → <em>did you mean <code>tailwind</code>?</em>), and so is no
        feature at all. A run that is refused - a conflict, a server feature for a static
        site, no project in the directory - exits with code <code>1</code> and writes
        nothing.
      </p>
    </>
  );
}
