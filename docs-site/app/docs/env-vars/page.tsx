import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'Environment Variables',
  description:
    'Every environment variable the GioJS server, render worker, gio CLI and create-giojs read: defaults, who reads it, and how it ranks against gio.toml.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Environment Variables</h1>
      <p className="page-subtitle">
        Every environment variable the GioJS server, render worker, <code>gio</code> CLI and{' '}
        <code>create-giojs</code> read: defaults, who reads it, and how it ranks against{' '}
        <code>gio.toml</code>.
      </p>
      <CodeBlock lang="bash" code={`# A second instance on another port, with JSON logs, from the project root
GIO_PORT=4000 GIO_LOG_FORMAT=json npx gio start`} />
      <p>
        This page is the reference. For how to give your own app its configuration (the{' '}
        <code>.env</code> files, <code>GIO_PUBLIC_*</code> in the browser, secrets), read the{' '}
        <a href="/docs/guides/environment-variables">Environment Variables guide</a>.
      </p>

      <h2 id="reference">Reference</h2>
      <p>
        &quot;Read by&quot; names the process that looks at the variable: the Rust{' '}
        <strong>server</strong> (<code>giojs-server</code>, which <code>gio dev</code> and{' '}
        <code>gio start</code> run), the Node <strong>worker</strong> it spawns (your pages,
        route handlers and plugins run there and inherit the server&apos;s environment), the{' '}
        <strong>gio CLI</strong>, <code>gio export</code>, <code>gio build standalone</code>,
        the <strong>testing kit</strong> (<code>@gio.js/core/testing</code>) and{' '}
        <strong>create-giojs</strong>. An empty value counts as unset everywhere except where
        the row says otherwise.
      </p>
      <table>
        <thead>
          <tr><th>Variable</th><th>Default</th><th>Read by</th><th>gio.toml key it overrides</th></tr>
        </thead>
        <tbody>
          <tr><td><a href="#gio-host"><code>GIO_HOST</code></a></td><td><code>[server] host</code>, else <code>0.0.0.0</code></td><td>server, gio CLI</td><td><code>[server] host</code></td></tr>
          <tr><td><a href="#gio-port"><code>GIO_PORT</code></a></td><td>unset</td><td>server, gio CLI</td><td><code>[server] port</code> (and <code>PORT</code>)</td></tr>
          <tr><td><a href="#port"><code>PORT</code></a></td><td>unset</td><td>server, gio CLI</td><td><code>[server] port</code></td></tr>
          <tr><td><a href="#gio-app-dir"><code>GIO_APP_DIR</code></a></td><td><code>./app</code></td><td>server, worker, gio CLI, export, standalone, testing kit</td><td>-</td></tr>
          <tr><td><a href="#gio-public-dir"><code>GIO_PUBLIC_DIR</code></a></td><td><code>public/</code> next to <code>app/</code></td><td>server</td><td>-</td></tr>
          <tr><td><a href="#gio-cache-dir"><code>GIO_CACHE_DIR</code></a></td><td><code>.gio/cache/pages</code></td><td>server, <code>gio doctor</code></td><td><code>[cache] disk_path</code></td></tr>
          <tr><td><a href="#gio-image-cache-dir"><code>GIO_IMAGE_CACHE_DIR</code></a></td><td><code>.gio/cache/images</code></td><td>server</td><td>-</td></tr>
          <tr><td><a href="#gio-fonts-dir"><code>GIO_FONTS_DIR</code></a></td><td><code>.gio/fonts</code></td><td>server</td><td>-</td></tr>
          <tr><td><a href="#gio-static-dir"><code>GIO_STATIC_DIR</code></a></td><td><code>.gio/build/static</code></td><td>server</td><td>-</td></tr>
          <tr><td><a href="#node-env"><code>NODE_ENV</code></a></td><td>unset (production)</td><td>server, worker, every CLI command</td><td>-</td></tr>
          <tr><td><a href="#gio-env-files"><code>GIO_ENV_FILES</code></a></td><td>unset</td><td>server, export, standalone, testing kit, gio CLI</td><td><code>[env] files</code></td></tr>
          <tr><td><a href="#gio-session-secret"><code>GIO_SESSION_SECRET</code></a></td><td>unset (dev: ephemeral)</td><td>server, worker, <code>gio doctor</code></td><td>-</td></tr>
          <tr><td><a href="#gio-revalidate-token"><code>GIO_REVALIDATE_TOKEN</code></a></td><td>unset</td><td>server</td><td><code>[revalidate] token</code></td></tr>
          <tr><td><a href="#gio-site-url"><code>GIO_SITE_URL</code></a></td><td>unset</td><td>worker, export</td><td>-</td></tr>
          <tr><td><a href="#gio-deployment-id"><code>GIO_DEPLOYMENT_ID</code></a></td><td>content-derived</td><td>server</td><td>-</td></tr>
          <tr><td><a href="#gio-public"><code>GIO_PUBLIC_*</code></a></td><td>-</td><td>client bundles (worker, export, standalone)</td><td>-</td></tr>
          <tr><td><a href="#gio-log-format"><code>GIO_LOG_FORMAT</code></a></td><td><code>[logging] format</code>, else <code>text</code></td><td>server</td><td><code>[logging] format</code></td></tr>
          <tr><td><a href="#rust-log"><code>RUST_LOG</code></a></td><td><code>info</code></td><td>server</td><td>-</td></tr>
          <tr><td><a href="#gio-log-level"><code>GIO_LOG_LEVEL</code></a></td><td><code>info</code></td><td>worker</td><td>-</td></tr>
          <tr><td><a href="#gio-editor"><code>GIO_EDITOR</code>, <code>VISUAL</code>, <code>EDITOR</code></a></td><td><code>code</code></td><td>server (dev)</td><td>-</td></tr>
          <tr><td><a href="#gio-exit-on-stdin-eof"><code>GIO_EXIT_ON_STDIN_EOF</code></a></td><td>unset</td><td>server, worker</td><td>-</td></tr>
          <tr><td><a href="#gio-socket-path"><code>GIO_SOCKET_PATH</code>, <code>GIO_WS_SOCKET_PATH</code></a></td><td>per instance</td><td>server, worker</td><td>-</td></tr>
          <tr><td><a href="#gio-server-bin"><code>GIO_SERVER_BIN</code></a></td><td>installed platform binary</td><td>gio CLI, <code>createTestServer</code></td><td>-</td></tr>
          <tr><td><a href="#gio-standalone-server-bin"><code>GIO_STANDALONE_SERVER_BIN</code></a></td><td>installed platform binary</td><td><code>gio build standalone</code></td><td>-</td></tr>
          <tr><td><a href="#gio-out-dir"><code>GIO_OUT_DIR</code></a></td><td><code>./out</code></td><td><code>gio export</code></td><td>-</td></tr>
          <tr><td><a href="#npm-config-user-agent"><code>npm_config_user_agent</code></a></td><td>set by your package manager</td><td>create-giojs, <code>gio migrate</code>, <code>gio add</code></td><td>-</td></tr>
          <tr><td><a href="#no-color"><code>NO_COLOR</code></a></td><td>unset</td><td>create-giojs <code>migrate</code></td><td>-</td></tr>
          <tr><td><a href="#gio-worker-index"><code>GIO_WORKER_INDEX</code>, <code>GIO_WORKER_COUNT</code></a></td><td>set by the server</td><td>your code</td><td>-</td></tr>
          <tr><td><a href="#gio-export"><code>GIO_EXPORT</code></a></td><td>set by <code>gio export</code></td><td>your code, the worker</td><td>-</td></tr>
        </tbody>
      </table>

      <h3 id="precedence">Precedence over gio.toml</h3>
      <p>
        Where a variable and a <code>gio.toml</code> key set the same thing, the variable
        wins, so a deploy can change it without editing the file:
      </p>
      <ul>
        <li><code>GIO_PORT</code> &gt; <code>PORT</code> &gt; <code>[server] port</code> &gt; <code>3000</code>. The startup log line <code>GioJS listening on ...</code> carries <code>port_from</code>, the source that won.</li>
        <li><code>GIO_HOST</code> &gt; <code>[server] host</code> &gt; <code>0.0.0.0</code>.</li>
        <li><code>GIO_CACHE_DIR</code> &gt; <code>[cache] disk_path</code>.</li>
        <li><code>GIO_REVALIDATE_TOKEN</code> &gt; <code>[revalidate] token</code>.</li>
        <li><code>GIO_LOG_FORMAT</code> &gt; <code>[logging] format</code>.</li>
        <li><code>GIO_ENV_FILES</code> &gt; <code>[env] files</code>.</li>
      </ul>
      <p>
        Variables already in the real environment also win over the{' '}
        <a href="/docs/configuration#env-files"><code>.env</code> files</a>, which the server
        loads at startup before it reads <code>gio.toml</code>. A variable set in a{' '}
        <code>.env</code> file counts like one set in the shell for everything on this page,
        except <code>NODE_ENV</code> and <code>GIO_ENV_FILES</code>, which decide which files
        load and so must come from the real environment.
      </p>

      <h2 id="listen-address-and-directories">Listen address and directories</h2>

      <h3 id="gio-host">GIO_HOST</h3>
      <p>
        The address the server binds, overriding <code>[server] host</code>. It must be an IP
        address: <code>0.0.0.0</code> (every interface), <code>127.0.0.1</code> (this machine
        only), or IPv6 in brackets (<code>[::]</code>, <code>[::1]</code>). A host name or a
        value with a port stops startup with{' '}
        <code>invalid GIO_HOST=&quot;localhost&quot;: expected an IP address such as 0.0.0.0 ...</code>.{' '}
        <code>gio dev -H</code> and <code>gio start -H</code> set it. The testing kit&apos;s{' '}
        <code>createTestServer()</code> sets it to <code>127.0.0.1</code>.
      </p>

      <h3 id="gio-port">GIO_PORT</h3>
      <p>
        The port the server listens on, overriding <code>PORT</code> and{' '}
        <code>[server] port</code>. A value that is not a port number (0-65535) stops startup;
        an empty one falls through to <code>PORT</code>. <code>gio dev -p</code> and{' '}
        <code>gio start -p</code> set it, and <code>gio cache explain</code> and{' '}
        <code>gio bench</code> read it (with the <code>.env</code> files) to find the local
        server.
      </p>

      <h3 id="port">PORT</h3>
      <p>
        The port hosting platforms assign (Heroku, Render, Railway, Fly.io, Cloud Run). The
        server honors it after <code>GIO_PORT</code> and before <code>gio.toml</code>, so the
        same app runs unchanged on those platforms. The health check in the Dockerfile
        that <code>create-giojs add docker</code> writes reads it too.
      </p>

      <h3 id="gio-app-dir">GIO_APP_DIR</h3>
      <p>
        The <code>app/</code> directory, relative to the working directory or absolute.
        Default <code>./app</code>. Its parent is the project root: <code>gio.toml</code>,{' '}
        <code>public/</code>, the <code>.env</code> files and <code>.gio/</code> are found
        there, so a server started from another directory still finds the whole project. If
        there is no <code>gio.toml</code> next to <code>app/</code>, the server reads{' '}
        <code>gio.toml</code> from the working directory instead. The worker, the{' '}
        <code>gio</code> commands that read routes (<code>routes</code>,{' '}
        <code>typegen</code>, <code>doctor</code>), <code>gio export</code>,{' '}
        <code>gio build standalone</code> and <code>renderPage()</code> all follow it.
      </p>

      <h3 id="gio-public-dir">GIO_PUBLIC_DIR</h3>
      <p>
        The directory served at the site root and under <code>/public/*</code> (see{' '}
        <a href="/docs/endpoints#public-files">Endpoints</a>). Default: <code>public/</code>{' '}
        in the project root.
      </p>

      <h3 id="gio-cache-dir">GIO_CACHE_DIR</h3>
      <p>
        The page cache&apos;s disk directory, overriding <code>[cache] disk_path</code>. Unlike
        the key, it may point outside the project (an absolute path, or one relative to the
        server&apos;s working directory). It may not be, contain or sit inside{' '}
        <code>app/</code> or <code>public/</code>: startup refuses that with{' '}
        <code>GIO_CACHE_DIR: ...</code>. With CSP nonces on, the nonce placeholder is
        persisted in its <code>meta/</code> folder.
      </p>

      <h3 id="gio-image-cache-dir">GIO_IMAGE_CACHE_DIR</h3>
      <p>
        Where <code>/_gio/image</code> stores the images it has resized and encoded. Default{' '}
        <code>.gio/cache/images</code> in the project root; a relative value resolves against
        the working directory. Not created when <code>[images] enabled = false</code>.
      </p>

      <h3 id="gio-fonts-dir">GIO_FONTS_DIR</h3>
      <p>
        Where the server writes the <code>[[fonts]]</code> files it downloads or copies, and
        the generated <code>fonts.css</code>, served under <code>/_gio/fonts/</code>. Default{' '}
        <code>.gio/fonts</code> in the project root.
      </p>

      <h3 id="gio-static-dir">GIO_STATIC_DIR</h3>
      <p>
        The built client assets (route chunks and stylesheets) served under{' '}
        <code>/_next/static/</code>. Default <code>.gio/build/static</code> in the project
        root, where the worker writes them. A standalone bundle&apos;s <code>run.mjs</code>{' '}
        points it at the bundle&apos;s own <code>static/</code> folder.
      </p>

      <h2 id="mode-and-env-files">Mode and .env files</h2>

      <h3 id="node-env">NODE_ENV</h3>
      <p>
        Decides the runtime mode. Exactly <code>development</code> means development (file
        watcher, <code>/_gio/devtools</code>, error details, the{' '}
        <code>.env.development*</code> files); any other value, unset and <code>test</code>{' '}
        included, means production. The server spawns the worker with{' '}
        <code>NODE_ENV</code> set to the mode it decided, replacing what the worker would
        have inherited, so the two can never disagree. <code>gio dev</code> sets it to{' '}
        <code>development</code> and <code>gio start</code> to <code>production</code>,
        whatever the shell says; <code>gio export</code> keeps <code>development</code> and
        turns anything else into <code>production</code>; a standalone{' '}
        <code>run.mjs</code> defaults it to <code>production</code>. A{' '}
        <code>NODE_ENV</code> line in a <code>.env</code> file is ignored with a warning.
      </p>

      <h3 id="gio-env-files">GIO_ENV_FILES</h3>
      <p>
        <code>0</code> or <code>false</code> loads no <code>.env</code> files;{' '}
        <code>1</code> or <code>true</code> loads them; unset or empty leaves it to{' '}
        <code>[env] files</code> in <code>gio.toml</code> (default <code>true</code>). Any
        other value stops startup:{' '}
        <code>GIO_ENV_FILES=&quot;yes&quot; must be 0 (skip them) or 1 (load them)</code>.
        The server, <code>gio export</code>, <code>gio build standalone</code>, the testing
        kit and the <code>gio</code> CLI&apos;s own fallback reader all follow it. Use it on
        platforms that inject the whole environment and must ignore a stray file in the
        image.
      </p>

      <h2 id="secrets">Secrets</h2>

      <h3 id="gio-session-secret">GIO_SESSION_SECRET</h3>
      <p>
        The key material for <a href="/docs/authentication">encrypted cookie sessions</a>{' '}
        (<code>createSessionStorage()</code>) and for <code>require_session</code> guards,
        which the server verifies in Rust. Comma-separated to rotate: each entry (trimmed,
        empty entries ignored) must be at least 32 bytes; the first signs and encrypts, all
        of them verify.
      </p>
      <ul>
        <li>Production, unset: <code>createSessionStorage()</code> throws, and <code>require_session</code> guards deny every request.</li>
        <li>An entry shorter than 32 bytes: the server logs <code>invalid session secret - require_session guards deny every request</code> with a command that generates a good one.</li>
        <li>Development, unset: the server generates an ephemeral secret for this run and passes it to the worker (with <code>GIO_SESSION_SECRET_EPHEMERAL=1</code>), so sessions work and reset on restart.</li>
        <li>Tests: when neither the environment nor a <code>.env</code> file sets it, <code>renderPage()</code> and <code>callRoute()</code> set a random one for the test process. A <code>createTestServer()</code> server does not get it.</li>
      </ul>
      <p>
        <code>gio doctor</code> reports a missing or invalid secret when the app has{' '}
        <code>require_session</code> guards.
      </p>

      <h3 id="gio-revalidate-token">GIO_REVALIDATE_TOKEN</h3>
      <p>
        The bearer token of <a href="/docs/endpoints#post-gio-revalidate"><code>POST /_gio/revalidate</code></a>.
        Setting it (or <code>[revalidate] token</code>) is what creates the endpoint; without
        either, the path answers <code>404</code>. It wins over the <code>gio.toml</code> key,
        is trimmed, and must be at least 32 bytes, or startup stops with{' '}
        <code>the revalidation token (GIO_REVALIDATE_TOKEN) is N bytes; at least 32 are required</code>.
      </p>

      <h2 id="rendering">Rendering</h2>

      <h3 id="gio-site-url">GIO_SITE_URL</h3>
      <p>
        The site&apos;s absolute origin (<code>https://example.com</code>), read by the
        worker. It is the <code>metadataBase</code> when no layout or page sets one, so
        relative Open Graph, canonical and alternate URLs become absolute; it resolves the
        relative URLs <code>app/sitemap.ts</code> and <code>app/robots.ts</code> return; and{' '}
        <code>gio export</code> generates <code>sitemap.xml</code> only when it is set. A
        relative URL with no base logs a warning. GioJS never builds absolute URLs from the
        request&apos;s <code>Host</code> header: a cached page would carry whatever host the
        first visitor sent.
      </p>

      <h3 id="gio-deployment-id">GIO_DEPLOYMENT_ID</h3>
      <p>
        Pins the deployment ID instead of deriving it. Used as given, trimmed and cut to 64
        characters. The derived ID is a hash of the client build, the app&apos;s server-side
        sources and the <code>gio.toml</code> settings pages render with, so it already
        changes with every code change and stays the same across restarts of the same code.
        Pin it when several instances must agree and their builds may differ byte for byte,
        and change it with every deploy: it keys the page cache, and it is what clients send
        in <a href="/docs/headers#x-deployment-id"><code>x-deployment-id</code></a>.
      </p>

      <h3 id="gio-public">GIO_PUBLIC_*</h3>
      <p>
        Every variable whose name starts with <code>GIO_PUBLIC_</code> is inlined into the
        client bundles where code reads <code>process.env.GIO_PUBLIC_X</code>, with the value
        it had when the bundles were built: at server start for <code>gio dev</code> and{' '}
        <code>gio start</code>, at build time for <code>gio export</code> and{' '}
        <code>gio build standalone</code> (frozen into the output). In the browser,{' '}
        <code>process.env</code> holds only these, <code>NODE_ENV</code> and{' '}
        <code>GIO_EXPORT</code>; any other <code>process.env.X</code> is{' '}
        <code>undefined</code>. The prefix is fixed. See{' '}
        <a href="/docs/guides/environment-variables#variables-in-the-browser-gio-public">Variables in the browser</a>.
      </p>

      <h2 id="logging">Logging</h2>

      <h3 id="gio-log-format">GIO_LOG_FORMAT</h3>
      <p>
        <code>json</code> or <code>text</code> (any case): the server&apos;s log format,
        overriding <code>[logging] format</code>. <code>json</code> writes one JSON object per
        line in the worker&apos;s shape (<code>ts</code>, <code>level</code>,{' '}
        <code>msg</code>, <code>target</code>, span fields such as <code>request_id</code>).
        Any other value is ignored with the warning{' '}
        <code>ignoring GIO_LOG_FORMAT=...: expected &quot;json&quot; or &quot;text&quot;</code>.
        The worker always logs JSON.
      </p>

      <h3 id="rust-log">RUST_LOG</h3>
      <p>
        The server&apos;s log filter, in <code>tracing</code>&apos;s <code>EnvFilter</code>{' '}
        syntax: a level (<code>warn</code>, <code>debug</code>) or per-module directives
        (<code>info,giojs_server::ipc=debug</code>). Default <code>info</code>.
      </p>

      <h3 id="gio-log-level">GIO_LOG_LEVEL</h3>
      <p>
        The worker&apos;s minimum log level: <code>debug</code>, <code>info</code>,{' '}
        <code>warn</code> or <code>error</code>. Default <code>info</code>; any other value
        means <code>info</code>. Read on every log call, so it applies to your plugins&apos;
        and route handlers&apos; framework log lines too.
      </p>

      <h2 id="development-and-processes">Development and processes</h2>

      <h3 id="gio-editor">GIO_EDITOR, VISUAL, EDITOR</h3>
      <p>
        The editor the dev error overlay&apos;s file links open (
        <code>POST /_gio/devtools/open-in-editor</code>). The first one set to a non-empty
        value wins, in that order; default <code>code</code>. VS Code-family editors get{' '}
        <code>-g file:line</code>. Read per request, development only.
      </p>

      <h3 id="gio-exit-on-stdin-eof">GIO_EXIT_ON_STDIN_EOF</h3>
      <p>
        <code>1</code>: shut down gracefully when standard input reaches end-of-file. Launchers
        that hold a stdin pipe open (<code>gio</code>, a standalone <code>run.mjs</code>)
        set it, so a launcher killed outright (SIGKILL, the OOM killer) never leaves the
        server on the port. The server sets it on every worker for the same reason. Ignored
        when stdin is a terminal or <code>/dev/null</code>.
      </p>

      <h3 id="gio-socket-path">GIO_SOCKET_PATH, GIO_WS_SOCKET_PATH</h3>
      <p>
        The paths of the two Rust-to-Node IPC endpoints (HTTP and WebSocket traffic). Default:
        a per-instance <code>.gio/ipc-&lt;pid&gt;-&lt;random&gt;.sock</code> and{' '}
        <code>.gio/ws-&lt;pid&gt;-&lt;random&gt;.sock</code> on Unix, unique named pipes on
        Windows. A value you set wins; in a <a href="/docs/configuration#render-workers">worker pool</a>{' '}
        the other workers get it with a <code>-w&lt;N&gt;</code> suffix. The server passes the
        resolved paths to the worker. You rarely need them: <code>createTestServer()</code>{' '}
        sets its own so a test server never collides with a dev server in the same project.
      </p>

      <h2 id="tooling">CLI, build and testing</h2>

      <h3 id="gio-server-bin">GIO_SERVER_BIN</h3>
      <p>
        An explicit <code>giojs-server</code> binary for the <code>gio</code> CLI and{' '}
        <code>createTestServer()</code>, instead of the platform package{' '}
        <code>@gio.js/server</code> installed. Use it for a binary you built with{' '}
        <code>cargo build -p giojs-server</code>. A path that does not exist is an error, not
        a fallback. <code>gio --version</code> and <code>gio doctor</code> say when it is in
        use.
      </p>

      <h3 id="gio-standalone-server-bin">GIO_STANDALONE_SERVER_BIN</h3>
      <p>
        The server binary <code>gio build standalone</code> copies into the bundle, overriding{' '}
        <code>--target</code>; for cross-building with a binary you built yourself. A path
        that does not exist stops the build. See{' '}
        <a href="/docs/standalone#cross-building-for-another-platform">Cross-building</a>.
      </p>

      <h3 id="gio-out-dir">GIO_OUT_DIR</h3>
      <p>
        Where <code>gio export</code> writes the static site. Default <code>./out</code>.
      </p>

      <h3 id="npm-config-user-agent">npm_config_user_agent</h3>
      <p>
        Set by npm, pnpm, yarn and bun for the scripts and <code>create</code> packages they
        run. A new app is installed with the package manager you ran{' '}
        <code>create-giojs</code> with (<code>--pm</code> overrides it); in an existing
        project, <code>create-giojs add</code> and <code>migrate</code> go by the
        project&apos;s lockfile first. <code>gio add</code> and <code>gio migrate</code> read
        it to choose how to run <code>create-giojs</code> (npx, pnpm dlx or bunx).
      </p>

      <h3 id="no-color">NO_COLOR</h3>
      <p>
        Any value turns off the colored diff of <code>create-giojs migrate</code>. Color is
        also off when stdout is not a terminal.
      </p>

      <h2 id="set-by-giojs">Set by GioJS</h2>
      <p>The server and the CLI set these for your code to read. A value you set is replaced.</p>

      <h3 id="gio-worker-index">GIO_WORKER_INDEX, GIO_WORKER_COUNT</h3>
      <p>
        In each Node worker: its position in the pool (<code>&quot;0&quot;</code> for the
        first) and the pool size (<code>[server] workers</code>; development always runs one).
        A plugin&apos;s <code>onStartup</code> runs in every worker, so gate one-time jobs on{' '}
        <code>process.env.GIO_WORKER_INDEX === &apos;0&apos;</code>.
      </p>

      <h3 id="gio-export">GIO_EXPORT</h3>
      <p>
        <code>&quot;1&quot;</code> while <code>gio export</code> renders, in the exporter and
        in the client bundles it builds (<code>&quot;0&quot;</code> in bundles the server
        builds). <code>cspNonce()</code> returns <code>undefined</code> under it, and{' '}
        <code>&lt;GioImage&gt;</code> renders its plain <code>src</code>.
      </p>

      <h3 id="internal-variables">Internal variables</h3>
      <p>
        The server and the launchers pass these between the processes. Do not set them; they
        are listed so you can recognize them in a process listing.
      </p>
      <table>
        <thead>
          <tr><th>Variable</th><th>What it carries</th></tr>
        </thead>
        <tbody>
          <tr><td><code>GIO_IPC_TOKEN</code></td><td>The per-start secret the worker proves itself with on the IPC sockets.</td></tr>
          <tr><td><code>GIO_IMAGE_CONFIG</code>, <code>GIO_CSS_CONFIG</code></td><td><code>[images]</code> and <code>[css]</code> as JSON, for <code>&lt;GioImage&gt;</code> srcsets and the stylesheet build. Both are hashed into the derived deployment ID.</td></tr>
          <tr><td><code>GIO_CSP_NONCE_PLACEHOLDER</code></td><td>The secret placeholder the worker renders where a CSP nonce goes; the server swaps it for a fresh nonce per response.</td></tr>
          <tr><td><code>GIO_SESSION_SECRET_EPHEMERAL</code></td><td><code>1</code> when <code>GIO_SESSION_SECRET</code> is the dev server&apos;s generated one.</td></tr>
          <tr><td><code>GIO_BUILD_ID</code>, <code>GIO_REUSE_BUILD</code></td><td>Let pool workers load the first worker&apos;s client build instead of bundling again.</td></tr>
          <tr><td><code>GIO_NODE_SCRIPT</code>, <code>GIO_TSX_PKG</code>, <code>GIO_PNPM_ROOT</code>, <code>NODE_PATH</code></td><td>How to start the worker: its entry script (<code>packages/giojs-core/src/index.ts</code> by default, a bundle&apos;s <code>worker.js</code> in standalone) and the <code>tsx</code> loader that runs it.</td></tr>
          <tr><td><code>GIO_STANDALONE</code></td><td><code>1</code> in a standalone bundle: the worker runs on plain <code>node</code>.</td></tr>
          <tr><td><code>GIO_UPDATE_SCHEMA</code></td><td>For contributors: <code>GIO_UPDATE_SCHEMA=1 cargo test -p giojs-server json_schema</code> regenerates <code>gio.schema.json</code>.</td></tr>
          <tr><td><code>VITEST</code></td><td>Set by vitest; the testing kit adjusts module loading under it and removes it from a <code>createTestServer()</code> server&apos;s environment.</td></tr>
        </tbody>
      </table>

      <h2 id="examples">Examples</h2>

      <h3 id="run-on-a-platform-that-assigns-the-port">Run on a platform that assigns the port</h3>
      <p>
        Nothing to configure: the platform sets <code>PORT</code>, and the server binds{' '}
        <code>0.0.0.0</code> by default.
      </p>
      <CodeBlock lang="bash" code={`PORT=8080 npx gio start
# ... GioJS listening on 0.0.0.0:8080 ... port_from="PORT"`} />

      <h3 id="production-environment">A production environment</h3>
      <CodeBlock lang="bash" title=".env.production.local" code={`GIO_SESSION_SECRET=8Jx2...a-32-byte-or-longer-random-value
GIO_REVALIDATE_TOKEN=Hq9v...another-32-byte-or-longer-value
GIO_SITE_URL=https://example.com
GIO_PUBLIC_API_URL=https://api.example.com
GIO_LOG_FORMAT=json`} />
      <p>
        Generate each secret with{' '}
        <code>node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;base64url&apos;))&quot;</code>.
        In a container, pass them as real environment variables and set{' '}
        <code>GIO_ENV_FILES=0</code> so no file in the image can change them.
      </p>

      <h3 id="rotate-the-session-secret">Rotate the session secret</h3>
      <CodeBlock lang="bash" code={`# New secret first: it signs from now on. The old one still verifies
# existing cookies until they expire; then drop it.
GIO_SESSION_SECRET="$NEW_SECRET,$OLD_SECRET" npx gio start`} />

      <h3 id="run-a-server-from-another-directory">Run a server from another directory</h3>
      <CodeBlock lang="bash" code={`# gio.toml, public/ and .env files are read from /srv/site
GIO_APP_DIR=/srv/site/app GIO_CACHE_DIR=/var/cache/site giojs-server`} />

      <h3 id="one-job-per-pool">Run a startup job once per pool</h3>
      <CodeBlock lang="ts" title="gio.config.ts" code={`import { defineConfig } from '@gio.js/core';

export default defineConfig({
  plugins: [
    {
      name: 'warm-up',
      version: '1.0.0',
      async onStartup() {
        if (process.env.GIO_WORKER_INDEX !== '0') return;
        console.log(\`warming caches (pool of \${process.env.GIO_WORKER_COUNT})\`);
      },
    },
  ],
});`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          The server reads its variables, and the <code>.env</code> files, once at
          startup, and the worker inherits that environment: restart the server after
          changing one.
        </li>
        <li>
          The <code>GIO_PUBLIC_</code> prefix is fixed and cannot be configured: it is the
          line between values that may reach every visitor and values that must not. A
          secret given that prefix is public.
        </li>
        <li>
          Startup never prints values: the <code>.env</code> loader logs file names, parse
          errors name the file and line, and <code>giojs-server --check-config</code> reports
          whether <code>GIO_SESSION_SECRET</code> is set and valid
          (<code>sessionSecret</code>), never its value.
        </li>
        <li>
          Relative directory values (<code>GIO_CACHE_DIR</code>,{' '}
          <code>GIO_IMAGE_CACHE_DIR</code>, <code>GIO_FONTS_DIR</code>,{' '}
          <code>GIO_STATIC_DIR</code>, <code>GIO_PUBLIC_DIR</code>) resolve against the
          server&apos;s working directory, not the project root.
        </li>
        <li>
          <code>giojs-server --check-config</code> and <code>gio doctor</code> load the{' '}
          <code>.env</code> files and apply these variables exactly as startup does, so they
          show the address, cache directory and secrets the real server would use.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/guides/environment-variables">Environment Variables guide</a> - <code>.env</code> files, server-only values and <code>GIO_PUBLIC_*</code></li>
        <li><a href="/docs/configuration#env-files">.env files</a> and <a href="/docs/configuration#listen-address">Listen address</a> in the <code>gio.toml</code> reference</li>
        <li><a href="/docs/file-conventions/env-files">.env files</a> (file convention) and <a href="/docs/configuration/env"><code>[env]</code></a></li>
        <li><a href="/docs/authentication">Authentication</a> - <code>GIO_SESSION_SECRET</code> in use</li>
        <li><a href="/docs/caching#from-outside-post-giorevalidate">On-demand revalidation</a> - <code>GIO_REVALIDATE_TOKEN</code> in use</li>
        <li><a href="/docs/observability">Observability</a> - <code>GIO_LOG_FORMAT</code>, <code>RUST_LOG</code>, <code>GIO_LOG_LEVEL</code></li>
        <li><a href="/docs/endpoints">Endpoints</a>, <a href="/docs/headers">Headers</a> and <a href="/docs/typescript">TypeScript</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              The server decides the mode from <code>NODE_ENV</code> and sets it on the
              worker. New: <code>GIO_HOST</code>, <code>GIO_PORT</code> and <code>PORT</code>{' '}
              (precedence <code>GIO_PORT</code> &gt; <code>PORT</code> &gt;{' '}
              <code>gio.toml</code>), <code>GIO_ENV_FILES</code>, <code>GIO_PUBLIC_DIR</code>,{' '}
              <code>GIO_SESSION_SECRET</code>, <code>GIO_REVALIDATE_TOKEN</code>,{' '}
              <code>GIO_LOG_FORMAT</code>, <code>GIO_WORKER_INDEX</code> /{' '}
              <code>GIO_WORKER_COUNT</code>, <code>GIO_EXIT_ON_STDIN_EOF</code>,{' '}
              <code>GIO_SERVER_BIN</code>; <code>GIO_PUBLIC_*</code> inlined into client
              bundles; <code>.env</code> files loaded at startup.
            </>
          ),
        },
        { version: 'v0.1.0-beta.6', changes: <><code>GIO_DEPLOYMENT_ID</code> pins the (now content-derived) deployment ID; <code>GIO_EDITOR</code> / <code>VISUAL</code> / <code>EDITOR</code> for open-in-editor.</> },
        { version: 'v0.1.0-beta.3', changes: <><code>GIO_SITE_URL</code> makes the exported <code>sitemap.xml</code> absolute.</> },
      ]} />
    </>
  );
}
