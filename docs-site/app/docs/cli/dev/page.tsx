import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio dev',
  description:
    'Run the GioJS server in development mode: the project is watched, edits restart the ' +
    'Node worker and reload open tabs, and errors show in an overlay.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio dev</h1>
      <p className="page-subtitle">
        Run the GioJS server in development mode: the project is watched, edits restart the
        Node worker and reload open tabs, and errors show in an overlay.
      </p>
      <PmTabs command={`npx gio dev`} />
      <CodeBlock lang="bash" code={`gio dev [--port <port>] [--host <ip>] [--open]`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        {
          name: '-p, --port <port>',
          type: 'number',
          default: '3000',
          description: <>The port to listen on, <code>0</code>-<code>65535</code>. Passed to the server as <code>GIO_PORT</code>, which outranks <code>PORT</code> and <code>[server] port</code>; without the flag those decide, then <code>3000</code>. Anything else is a usage error.</>,
        },
        {
          name: '-H, --host <ip>',
          type: 'string',
          default: '0.0.0.0',
          description: <>The IP address to bind, passed as <code>GIO_HOST</code> (over <code>[server] host</code>). <code>0.0.0.0</code> listens on every IPv4 interface, <code>127.0.0.1</code> on this machine only. IPv6 works with or without brackets (<code>::</code>, <code>[::]</code>, <code>::1</code>); <code>GIO_HOST</code> always receives it bracketed. <code>localhost</code> is the one name accepted and means <code>127.0.0.1</code>; other host names are a usage error, because the server binds IP addresses only.</>,
        },
        {
          name: '--open',
          type: 'boolean',
          default: 'false',
          description: <>Open the local URL in the default browser once the app is ready (<code>open</code> on macOS, <code>cmd /c start</code> on Windows, <code>xdg-open</code> elsewhere). If no browser can be started, <code>gio</code> prints the URL instead.</>,
        },
        {
          name: '-h, --help',
          type: 'boolean',
          description: <>Print the command&apos;s help and exit with <code>0</code>.</>,
        },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ol>
        <li>
          Finds the server binary (<code>GIO_SERVER_BIN</code>, else the{' '}
          <code>@gio.js/server-&lt;platform&gt;</code> package). Without one it prints which
          package to install and exits with <code>1</code> (see{' '}
          <a href="/docs/cli#missing-binary">When the server binary is missing</a>).
        </li>
        <li>
          Asks the binary where it will listen (<a href="/docs/cli/giojs-server#check-config"><code>giojs-server --check-config</code></a>),
          so the address comes from the same sources the server uses: <code>GIO_PORT</code>{' '}
          / <code>GIO_HOST</code> (which <code>--port</code> / <code>--host</code> set), then{' '}
          <code>PORT</code> - each from the environment or, when the environment does not set
          it, the <code>.env</code> files - then <code>gio.toml</code>&apos;s{' '}
          <code>[server]</code> table, then <code>0.0.0.0:3000</code>.
        </li>
        <li>
          Starts the server with <code>NODE_ENV=development</code>, whatever the shell had,
          and with <code>GIO_EXIT_ON_STDIN_EOF=1</code> and a stdin pipe it never writes:
          if the <code>gio</code> process dies, even by <code>SIGKILL</code>, the server sees
          the pipe close and shuts down instead of holding the port.
        </li>
        <li>
          Polls <code>/_gio/health</code> until it reports the Node worker ready (or, with{' '}
          <code>[health] enabled = false</code>, until anything answers), then prints the
          banner below and opens the browser for <code>--open</code>.
        </li>
        <li>
          Stays in the foreground until the server exits, and exits with the server&apos;s
          exit code (<code>1</code> if the server was killed by a signal).
          Ctrl+C and <code>SIGTERM</code> shut the server down gracefully.
        </li>
      </ol>
      <CodeBlock lang="text" code={`  GioJS 0.1.0-beta.8 (dev)
  - Local:    http://localhost:3000
  - Network:  http://192.168.1.20:3000`} />
      <p>
        <code>Network</code> lists one URL per non-internal IPv4 address when the server
        listens on every interface. With a loopback host it says{' '}
        <code>not exposed (listening on loopback only; use --host 0.0.0.0)</code>. The banner
        is skipped when the configuration has an error (the server prints it and exits{' '}
        <code>1</code>) and when the port is <code>0</code>.
      </p>

      <h3 id="development-mode">What development mode changes</h3>
      <p>
        The mode is the server&apos;s, and the Node worker always runs in the same one. In
        development:
      </p>
      <ul>
        <li>
          The <code>.env.development.local</code>, <code>.env.local</code>,{' '}
          <code>.env.development</code> and <code>.env</code> files load (see{' '}
          <a href="/docs/guides/environment-variables">Environment Variables</a>).
        </li>
        <li>
          Render errors show in the error overlay with a code frame and an open-in-editor
          link, and <code>/_gio/devtools</code> serves the dev dashboard. Both answer only
          local hosts unless <code>[dev] allowed_hosts</code> lists more (see{' '}
          <a href="/docs/configuration#dev-endpoints-allowed-hosts">Dev endpoints</a>);{' '}
          <code>[dev] devtools = false</code> turns them off.
        </li>
        <li>
          <code>require_session</code> guards work without <code>GIO_SESSION_SECRET</code>:
          the server generates an ephemeral secret, so sessions reset when it restarts.
        </li>
        <li>
          One render worker, whatever <code>[server] workers</code> says: every edit restarts
          it with a fresh build.
        </li>
        <li>The project is watched (next section).</li>
      </ul>

      <h3 id="file-watching">File watching</h3>
      <p>
        The whole project is watched, not just <code>app/</code>. A change under{' '}
        <code>app/</code>, in <code>components/</code>, <code>lib/</code>,{' '}
        <code>src/</code>, <code>hooks/</code>, or to <code>gio.toml</code>,{' '}
        <code>gio.config.ts</code>, <code>middleware.ts</code> or{' '}
        <code>tsconfig.json</code> clears the page cache, re-transforms app CSS, restarts the
        Node worker and reloads open tabs. Edits under <code>public/</code> refresh which
        files are served at the site root and reload the browser without a restart.
      </p>
      <ul>
        <li>
          Any change under <code>app/</code> restarts the worker. Elsewhere only these
          extensions do: <code>.ts .tsx .js .jsx .mjs .cjs .mts .cts .json .css .toml</code>,
          plus directories created, deleted or moved. Databases, logs and uploads the app
          writes into the project never restart the worker that wrote them.
        </li>
        <li>
          Never watched: <code>node_modules/</code> at any depth, hidden directories such as{' '}
          <code>.git/</code> and <code>.gio/</code> (except <code>.well-known/</code>), and the
          top-level <code>out/</code>, <code>dist/</code>, <code>build/</code>,{' '}
          <code>target/</code>, <code>standalone/</code> and <code>coverage/</code>. Editor
          scratch files (<code>~</code> backups, <code>.swp</code> / <code>.swx</code>,{' '}
          <code>4913</code>, <code>.#</code> locks) are ignored.
        </li>
        <li>
          <code>[dev] watch_ignore</code> globs exclude more (data files with a source
          extension, like <code>data/*.json</code>), and <code>[dev] watch = false</code>{' '}
          turns the watcher off.
        </li>
        <li>
          Ignored directories are kept out of the watch registration, so a large{' '}
          <code>node_modules/</code> does not use up Linux inotify watches. If a project hits
          the limit anyway, the server logs which directory went unwatched; raise{' '}
          <code>fs.inotify.max_user_watches</code>.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="pick-a-port-and-open-the-browser">Pick a port and open the browser</h3>
      <CodeBlock lang="bash" code={`gio dev --port 4000 --open`} />

      <h3 id="only-this-machine">Listen on this machine only</h3>
      <CodeBlock lang="bash" code={`$ gio dev --host 127.0.0.1

  GioJS 0.1.0-beta.8 (dev)
  - Local:    http://localhost:3000
  - Network:  not exposed (listening on loopback only; use --host 0.0.0.0)`} />

      <h3 id="from-a-package-json-script">From a package.json script</h3>
      <CodeBlock lang="json" title="package.json" code={`{
  "scripts": {
    "dev": "gio dev",
    "start": "gio start"
  }
}`} />
      <p>
        Starters made by <code>create-giojs</code> run the server through{' '}
        <code>cross-env NODE_ENV=development giojs-server</code> instead (see{' '}
        <a href="/docs/cli/giojs-server"><code>giojs-server</code></a>); both start the same
        server. With the Tailwind feature, keep <code>npm run dev</code>: it runs the Tailwind
        watcher next to the server, which <code>gio dev</code> alone does not.
      </p>

      <h3 id="a-mistyped-option">A mistyped option</h3>
      <CodeBlock lang="text" code={`$ gio dev --prot 4000
gio: unknown option "--prot" - did you mean --port?
Run \`gio dev --help\` for usage.
$ echo $?
2`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <code>NODE_ENV</code> from the shell is ignored: <code>gio dev</code> always runs
          development and <a href="/docs/cli/start"><code>gio start</code></a> always runs
          production. <code>NODE_ENV</code> in a <code>.env</code> file is ignored too.
        </li>
        <li>
          There is no build step before the server starts. Routes and client bundles are
          built at startup into <code>.gio/build</code>, and <code>.gio/routes.d.ts</code> is
          rewritten.
        </li>
        <li>
          The server binds its port only once the first worker is ready, so a request never
          reaches a server that cannot render yet.
        </li>
        <li>
          Exit codes: <code>0</code> after a clean shutdown, <code>1</code> for a missing
          binary or when the server fails (its own code is passed through), <code>2</code> for
          a usage error.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/cli/start"><code>gio start</code></a> - the same command in production mode</li>
        <li><a href="/docs/cli/doctor"><code>gio doctor</code></a> - check the setup when <code>gio dev</code> will not start</li>
        <li><a href="/docs/configuration#listen-address">Listen address</a> and <a href="/docs/configuration#dev-watcher">dev watcher</a> settings in <code>gio.toml</code></li>
        <li><a href="/docs/installation">Installation</a></li>
        <li><a href="/docs/cli">CLI overview</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: <>Introduced. Before, <code>gio</code> with no command started the server in whatever mode <code>NODE_ENV</code> named.</>,
        },
      ]} />
    </>
  );
}
