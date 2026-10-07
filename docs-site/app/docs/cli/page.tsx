import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../components/PmTabs.tsx';

export const metadata: Metadata = {
  title: 'CLI',
  description:
    'The gio command runs, inspects and packages GioJS apps. It ships with @gio.js/server; ' +
    'create-giojs scaffolds new ones.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>CLI</h1>
      <p className="page-subtitle">
        The <code>gio</code> command runs, inspects and packages GioJS apps. It ships with{' '}
        <code>@gio.js/server</code>; <code>create-giojs</code> scaffolds new ones.
      </p>
      <PmTabs command={`npx gio --help`} />

      <h2 id="commands">Commands</h2>
      <table>
        <thead>
          <tr><th>Command</th><th>What it does</th></tr>
        </thead>
        <tbody>
          <tr><td><a href="/docs/cli/dev"><code>gio dev</code></a></td><td>Start the development server: file watcher, error overlay, live reload</td></tr>
          <tr><td><a href="/docs/cli/start"><code>gio start</code></a></td><td>Start the production server</td></tr>
          <tr><td><a href="/docs/cli/build"><code>gio build</code></a></td><td>Explain deploys: there is no build step</td></tr>
          <tr><td><a href="/docs/cli/build-standalone"><code>gio build standalone</code></a></td><td>Package a self-contained deploy directory</td></tr>
          <tr><td><a href="/docs/cli/export"><code>gio export</code></a></td><td>Render the app to static HTML in <code>out/</code></td></tr>
          <tr><td><a href="/docs/cli/routes"><code>gio routes</code></a></td><td>List every route the app serves</td></tr>
          <tr><td><a href="/docs/cli/typegen"><code>gio typegen</code></a></td><td>Write <code>.gio/routes.d.ts</code> without starting the server</td></tr>
          <tr><td><a href="/docs/cli/doctor"><code>gio doctor</code></a></td><td>Check the environment and project, with a fix for each problem</td></tr>
          <tr><td><a href="/docs/cli/info"><code>gio info</code></a></td><td>Print versions and environment details for bug reports</td></tr>
          <tr><td><a href="/docs/cli/cache-explain"><code>gio cache explain</code></a></td><td>Explain how the cache served a URL</td></tr>
          <tr><td><a href="/docs/cli/bench"><code>gio bench</code></a></td><td>Load-test a running server</td></tr>
          <tr><td><a href="/docs/cli/migrate"><code>gio migrate</code></a></td><td>Migrate a Next.js app (runs <code>create-giojs migrate</code>)</td></tr>
          <tr><td><a href="/docs/cli/add"><code>gio add</code></a></td><td>Add starter features to the app (runs <code>create-giojs add</code>)</td></tr>
          <tr><td><a href="/docs/cli/help"><code>gio help</code></a></td><td>The command list, one command&apos;s options, <code>--version</code></td></tr>
          <tr><td><a href="/docs/cli/giojs-server"><code>giojs-server</code></a></td><td>Start the server with the caller&apos;s <code>NODE_ENV</code>; <code>--check-config</code> validates the configuration</td></tr>
          <tr><td><a href="/docs/create-giojs"><code>create-giojs</code></a></td><td>Scaffold a new app (<code>npm create giojs@latest</code>)</td></tr>
        </tbody>
      </table>
      <CodeBlock lang="bash" code={`gio --help             # the command list
gio help dev           # one command's options (same as: gio dev --help)
gio --version          # CLI, server binary and @gio.js/core package versions (-v)`} />
      <p>
        In a project, run <code>gio</code> through your package manager (<code>npx gio</code>,{' '}
        <code>pnpm gio</code>) or from a <code>package.json</code> script. A mistyped command
        or option is an error with a suggestion (<code>gio strat</code> →{' '}
        <em>did you mean <code>gio start</code>?</em>), never a silently started server.{' '}
        <code>gio</code> with no command prints the help and exits with code 2.
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
      <p>
        Every command keeps this contract, including the ones that parse their own options
        (<code>gio build standalone</code>, <code>gio bench</code>, <code>gio migrate</code>{' '}
        and <code>gio add</code>): a usage error exits with <code>2</code> before the command
        does anything.
      </p>
      <p>
        <code>gio --version</code> prints package versions, read from the installed{' '}
        <code>package.json</code> files: <code>gio</code> is <code>@gio.js/server</code>&apos;s
        version, the server binary its platform package&apos;s (a binary from{' '}
        <code>GIO_SERVER_BIN</code> or a repository build prints its path instead), and{' '}
        <code>@gio.js/core</code> its own. It never runs the binary. See{' '}
        <a href="/docs/cli/help#version"><code>gio --version</code></a>.
      </p>

      <h2 id="dev">gio dev</h2>
      <CodeBlock lang="bash" code={`gio dev [--port <port>] [--host <ip>] [--open]`} />
      <p>
        Starts the server with <code>NODE_ENV=development</code> and prints the local and
        network URLs once the worker is ready. The listen address comes from{' '}
        <code>--port</code> / <code>--host</code> (or <code>GIO_PORT</code> /{' '}
        <code>GIO_HOST</code>), then <code>PORT</code> - from the environment or the{' '}
        <code>.env</code> files - then <code>gio.toml</code>, then <code>0.0.0.0:3000</code>.
        See <a href="/docs/cli/dev"><code>gio dev</code></a>.
      </p>
      <h3 id="dev-mode-file-watching">Dev mode file watching</h3>
      <p>
        The whole project is watched: changes in <code>app/</code>, source files elsewhere and
        root config files restart the Node worker and reload open tabs, and edits under{' '}
        <code>public/</code> only reload the browser. A <code>gio.toml</code> edit restarts
        the worker too, but its new settings do not apply: the Rust server reads{' '}
        <code>gio.toml</code> once, at startup, so stop <code>gio dev</code> and run it
        again. <code>node_modules</code>, hidden
        directories and build output are never watched. The rules, and the{' '}
        <code>[dev] watch</code> / <code>watch_ignore</code> keys, are on the{' '}
        <a href="/docs/cli/dev#file-watching"><code>gio dev</code> page</a>.
      </p>

      <h2 id="start">gio start</h2>
      <CodeBlock lang="bash" code={`gio start [--port <port>] [--host <ip>] [--open]

PORT=8080 gio start          # hosting platforms that assign the port`} />
      <p>
        The same with <code>NODE_ENV=production</code>, whatever <code>NODE_ENV</code> the
        shell has. There is no build step before it. Both commands stay in the foreground and
        exit with the server&apos;s code. See <a href="/docs/cli/start"><code>gio start</code></a>.
      </p>

      <h2 id="build">gio build</h2>
      <CodeBlock lang="bash" code={`gio build                                          # explains: normal deploys have no build step
gio build standalone [--out <dir>] [--target <platform>]`} />
      <p>
        <a href="/docs/cli/build-standalone"><code>gio build standalone</code></a> packages the
        app into one directory - the Rust binary, the whole Node side bundled into{' '}
        <code>worker.js</code>, prebuilt chunks, <code>public/</code> and{' '}
        <code>gio.toml</code> - that runs anywhere Node is installed with{' '}
        <code>node run.mjs</code>. See <a href="/docs/cli/build"><code>gio build</code></a>{' '}
        and <a href="/docs/standalone">Standalone Deploys</a>.
      </p>

      <h2 id="export">gio export</h2>
      <CodeBlock lang="bash" code={`gio export       # → out/`} />
      <p>
        Renders every page to static HTML with the client chunks that hydrate it, for static
        hosts, without the Rust server. <code>GIO_APP_DIR</code> and <code>GIO_OUT_DIR</code>{' '}
        override the input and output directories. See{' '}
        <a href="/docs/cli/export"><code>gio export</code></a> and{' '}
        <a href="/docs/static-export">Static Export</a>.
      </p>

      <h2 id="routes">gio routes</h2>
      <CodeBlock lang="bash" code={`gio routes [--json]`} />
      <p>
        Lists every URL the app serves - pages with their layouts and loading / error /
        not-found files, route handlers with their methods, WebSocket handlers and metadata
        routes - discovered exactly as the server discovers them, without starting it. See{' '}
        <a href="/docs/cli/routes"><code>gio routes</code></a>.
      </p>

      <h2 id="typegen">gio typegen</h2>
      <CodeBlock lang="bash" code={`gio typegen && tsc --noEmit`} />
      <p>
        Writes <code>.gio/routes.d.ts</code> and <code>.gio/css-modules.d.ts</code>, the
        declarations behind typed <code>href()</code>, <code>PageProps</code> and CSS Module
        imports, for CI or a project with no server running. Your{' '}
        <code>tsconfig.json</code> must list <code>&quot;.gio/routes.d.ts&quot;</code> in{' '}
        <code>include</code>. See <a href="/docs/cli/typegen"><code>gio typegen</code></a>.
      </p>

      <h2 id="doctor">gio doctor</h2>
      <CodeBlock lang="bash" code={`gio doctor [--dev | --prod] [--json]`} />
      <p>
        Checks Node.js, the platform binary, package versions, <code>gio.toml</code> (with
        the server&apos;s own validation), <code>tsconfig.json</code>, the session secret,
        the port, trusted proxies and the cache directory, and prints a fix for every
        problem. Exits <code>1</code> when a check fails. See{' '}
        <a href="/docs/cli/doctor"><code>gio doctor</code></a>.
      </p>

      <h2 id="info">gio info</h2>
      <CodeBlock lang="bash" code={`gio info [--json]`} />
      <p>
        Prints the OS, Node.js and package manager versions, the server binary in use and the
        installed <code>@gio.js/*</code> versions. See{' '}
        <a href="/docs/cli/info"><code>gio info</code></a>.
      </p>

      <h2 id="cache-explain">gio cache explain</h2>
      <CodeBlock lang="bash" code={`gio cache explain <url-or-path> [--base <url>]`} />
      <p>
        Requests the URL and decodes its <code>X-Gio-Cache</code> header. A path goes to the
        local server at the address it listens on, or to <code>--base</code>. See{' '}
        <a href="/docs/cli/cache-explain"><code>gio cache explain</code></a>.
      </p>

      <h2 id="bench">gio bench</h2>
      <CodeBlock lang="bash" code={`gio bench <url-or-path> [--connections 32] [--duration 10] [--warmup 2]
gio bench --suite /,/posts/1 [--base <url>]`} />
      <p>
        A zero-dependency load generator. See <a href="/docs/cli/bench"><code>gio bench</code></a>{' '}
        and <a href="/docs/benchmarks">Benchmarks</a>.
      </p>

      <h2 id="migrate">gio migrate</h2>
      <CodeBlock lang="bash" code={`gio migrate ./my-next-app [--dry-run] [-y] [--config <file>]`} />
      <p>
        Migrates a Next.js project in place and writes <code>MIGRATION_REPORT.md</code>, by
        running <code>create-giojs migrate</code> (the installed one, else the same version
        through <code>npx</code> / <code>pnpm dlx</code> / <code>bunx</code>). See{' '}
        <a href="/docs/cli/migrate"><code>gio migrate</code></a> and the{' '}
        <a href="/docs/migration">Migration Guide</a>.
      </p>

      <h2 id="add">gio add</h2>
      <CodeBlock lang="bash" code={`gio add tailwind auth [--dry-run] [--force]`} />
      <p>
        Adds <a href="/docs/starter-features">starter features</a> (<code>tailwind</code>,{' '}
        <code>api</code>, <code>auth</code>, <code>db</code>, <code>docker</code>,{' '}
        <code>ci</code>) by running <code>create-giojs add</code>. See{' '}
        <a href="/docs/cli/add"><code>gio add</code></a>.
      </p>

      <h2 id="environment">Environment variables</h2>
      <table>
        <thead>
          <tr><th>Variable</th><th>Used by</th><th>Effect</th></tr>
        </thead>
        <tbody>
          <tr><td><code>GIO_SERVER_BIN</code></td><td><code>dev</code>, <code>start</code>, <code>build standalone</code>, <code>doctor</code>, <code>info</code>, <code>cache explain</code>, <code>bench</code>, <code>--version</code>, <code>giojs-server</code></td><td>Use this <code>giojs-server</code> binary instead of the installed platform package (a source build, a custom target)</td></tr>
          <tr><td><code>GIO_APP_DIR</code></td><td>all</td><td>The <code>app/</code> directory; the project root is its parent</td></tr>
          <tr><td><code>GIO_PORT</code> / <code>PORT</code> / <code>GIO_HOST</code></td><td><code>dev</code>, <code>start</code>, <code>cache explain</code>, <code>bench</code>, <code>doctor</code></td><td>The listen address (<code>--port</code> / <code>--host</code> set the <code>GIO_*</code> ones)</td></tr>
          <tr><td><code>NODE_ENV</code></td><td><code>export</code>, <code>routes</code>, <code>typegen</code>, <code>doctor</code>, <code>giojs-server</code></td><td><code>development</code> selects development mode and the <code>.env.development*</code> files; <code>gio dev</code> / <code>gio start</code> set it themselves</td></tr>
          <tr><td><code>GIO_ENV_FILES</code></td><td>all that read <code>.env</code> files</td><td><code>0</code> loads no <code>.env</code> files, <code>1</code> loads them whatever <code>[env] files</code> says; any other value is the error the server refuses to start with (<code>gio doctor</code> reports it)</td></tr>
          <tr><td><code>GIO_OUT_DIR</code>, <code>GIO_SITE_URL</code></td><td><code>export</code></td><td>The output directory; the site origin for <code>sitemap.xml</code></td></tr>
          <tr><td><code>GIO_STANDALONE_SERVER_BIN</code></td><td><code>build standalone</code></td><td>The binary to package, over <code>--target</code></td></tr>
        </tbody>
      </table>
      <p>
        Every variable the server itself reads is listed under{' '}
        <a href="/docs/env-vars">Environment Variables</a>.
      </p>

      <h2 id="missing-binary">When the server binary is missing</h2>
      <p>
        The Rust server ships as an optional dependency picked by OS and CPU (
        <code>@gio.js/server-linux-x64</code>, <code>-linux-x64-musl</code>,{' '}
        <code>-darwin-arm64</code>, <code>-darwin-x64</code>, <code>-win32-x64</code>). When it
        is missing, every command that needs it says which package to install, for your
        package manager:
      </p>
      <CodeBlock lang="text" code={`gio: the GioJS server binary for linux-x64 is not installed.

  Install it:  npm install --save-optional @gio.js/server-linux-x64@0.1.0-beta.8

  @gio.js/server ships its Rust binary in @gio.js/server-linux-x64, an optional
  dependency picked by OS and CPU. It is usually missing because:
    - optional dependencies were skipped (--no-optional, --omit=optional,
      or omit=optional in .npmrc)
    - the lockfile was written on another OS and left this platform out:
      delete node_modules and the lockfile, then install again
    - node_modules was copied from another machine or OS
  Or point GIO_SERVER_BIN at a giojs-server binary you built.`} />
      <p>
        Linux on ARM64 has no prebuilt binary yet: build one with{' '}
        <code>cargo build --release -p giojs-server</code> (Rust 1.89 or newer) and point{' '}
        <code>GIO_SERVER_BIN</code> at it, or run the app in a linux-x64 container. A{' '}
        <code>GIO_SERVER_BIN</code> that points at a missing file is reported as such.{' '}
        <code>gio export</code>, <code>gio routes</code>, <code>gio typegen</code>,{' '}
        <code>gio migrate</code> and <code>gio add</code> do not need the binary.
      </p>

      <h2 id="giojs-server">giojs-server</h2>
      <p>
        The <code>giojs-server</code> bin starts the server with no command parsing: it keeps
        the caller&apos;s <code>NODE_ENV</code> and passes its arguments to the binary, as the
        scripts of scaffolded projects use it (
        <code>cross-env NODE_ENV=development giojs-server</code>). See{' '}
        <a href="/docs/cli/giojs-server"><code>giojs-server</code></a>.
      </p>
      <h3 id="check-config">giojs-server --check-config</h3>
      <CodeBlock lang="bash" code={`giojs-server --check-config
{"cacheDir":"/srv/app/.gio/cache/pages","configFile":"gio.toml","envFiles":[".env"],"envFilesDisabledBy":null,
 "errors":[],"listen":{"host":"0.0.0.0","port":3000,"portSource":"default","tls":false},"mode":"production",
 "ok":true,"proxyHeaders":"x-forwarded","rateLimitRules":0,"sessionGuards":1,"sessionSecret":"valid",...}`} />
      <p>
        Loads the <code>.env</code> files and <code>gio.toml</code> exactly as startup does,
        runs the same validation, prints a JSON report and exits - <code>0</code> when the
        server would start, <code>1</code> with the reasons in <code>errors</code> - without
        binding a port or starting a worker. The fields are described on the{' '}
        <a href="/docs/cli/giojs-server#check-config"><code>giojs-server</code> page</a>.
      </p>

      <h2 id="create-giojs">create-giojs</h2>
      <CodeBlock lang="bash" code={`npm create giojs@latest [directory] -- [options]`} />
      <p>
        Scaffolds a new project, asking on a terminal for whatever the flags leave open:
        language (<code>--ts</code> / <code>--js</code>), server app or static site (
        <code>--server</code> / <code>--static</code>), starter features (
        <code>--tailwind</code>, <code>--api</code>, <code>--auth</code>, <code>--db</code>,{' '}
        <code>--docker</code>, <code>--ci</code>), and whether to install. Every flag, prompt
        and exit code is on <a href="/docs/create-giojs"><code>create-giojs</code></a>.
      </p>
      <h3 id="create-giojs-add">Adding features to an existing app</h3>
      <p>
        Adds starter features to an existing project without overwriting files you changed;{' '}
        <code>gio add</code> runs it. See <a href="/docs/create-giojs#add"><code>create-giojs add</code></a>.
      </p>
    </>
  );
}
