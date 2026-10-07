import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio start',
  description:
    'Run the GioJS server in production mode. There is no build step: routes and client ' +
    'bundles are built at startup, pages render on demand and are cached in Rust.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio start</h1>
      <p className="page-subtitle">
        Run the GioJS server in production mode. There is no build step: routes and client
        bundles are built at startup, pages render on demand and are cached in Rust.
      </p>
      <PmTabs command={`npx gio start`} />
      <CodeBlock lang="bash" code={`gio start [--port <port>] [--host <ip>] [--open]`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        {
          name: '-p, --port <port>',
          type: 'number',
          default: '3000',
          description: <>The port, <code>0</code>-<code>65535</code>, passed to the server as <code>GIO_PORT</code> (which outranks <code>PORT</code> and <code>[server] port</code>; without the flag those decide, then <code>3000</code>).</>,
        },
        {
          name: '-H, --host <ip>',
          type: 'string',
          default: '0.0.0.0',
          description: <>The IP address to bind, passed as <code>GIO_HOST</code> (over <code>[server] host</code>). IPv4, or IPv6 with or without brackets; <code>localhost</code> means <code>127.0.0.1</code>. Host names are a usage error.</>,
        },
        {
          name: '--open',
          type: 'boolean',
          default: 'false',
          description: 'Open the local URL in a browser once the app is ready.',
        },
        {
          name: '-h, --help',
          type: 'boolean',
          description: <>Print the command&apos;s help and exit with <code>0</code>.</>,
        },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <p>
        <code>gio start</code> works like <a href="/docs/cli/dev#behavior"><code>gio dev</code></a>{' '}
        (binary lookup, listen address from <code>--check-config</code>, ready banner, exit
        code passed through) with <code>NODE_ENV=production</code>, whatever the shell has.
        In production:
      </p>
      <ul>
        <li>
          The <code>.env.production.local</code>, <code>.env.local</code>,{' '}
          <code>.env.production</code> and <code>.env</code> files load. Variables already in
          the environment win.
        </li>
        <li>
          Error pages show an error reference (the digest in the log line) instead of the
          message, stack and code frame development shows.
        </li>
        <li>
          <code>require_session</code> guards need <code>GIO_SESSION_SECRET</code>; without
          it every guarded request is denied.
        </li>
        <li>
          <code>[server] workers</code> applies, and nothing is watched. The dev endpoints
          (<code>/_gio/devtools</code>, the error overlay) do not exist.
        </li>
      </ul>
      <CodeBlock lang="text" code={`  GioJS 0.1.0-beta.8 (production)
  - Local:    http://localhost:3000
  - Network:  http://10.0.0.12:3000`} />
      <p>
        Ctrl+C and <code>SIGTERM</code> start a graceful shutdown: the server stops
        accepting, drains in-flight requests, ends open event streams and gives each worker
        time to run plugin <code>onShutdown</code> hooks. On Unix <code>gio</code> forwards
        the signal to the server; on Windows the console delivers Ctrl+C to both. If{' '}
        <code>gio</code> itself is killed outright, the server notices its stdin pipe close
        and shuts down instead of lingering on the port.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="a-platform-that-assigns-the-port">A platform that assigns the port</h3>
      <CodeBlock lang="bash" code={`PORT=8080 gio start`} />
      <p>
        Hosting platforms set <code>PORT</code>; <code>gio start</code> needs nothing else.
        A <code>--port</code> flag would override it.
      </p>

      <h3 id="behind-a-reverse-proxy">Behind a reverse proxy on the same machine</h3>
      <CodeBlock lang="bash" code={`gio start --host 127.0.0.1 --port 3000`} />
      <p>
        Bind loopback so only the proxy can connect, and list the proxy in{' '}
        <code>[server] trusted_proxies</code> (see{' '}
        <a href="/docs/configuration#reverse-proxies">Reverse proxies &amp; client IPs</a>).
      </p>

      <h3 id="check-before-starting">Check the configuration before starting</h3>
      <CodeBlock lang="bash" code={`gio doctor --prod && gio start`} />
      <p>
        <a href="/docs/cli/doctor"><code>gio doctor --prod</code></a> exits with{' '}
        <code>1</code> on a problem that would break production, such as a missing{' '}
        <code>GIO_SESSION_SECRET</code> for <code>require_session</code> guards. The server
        does not refuse to start over that: it starts and denies every guarded request, and
        logs an error only when the secret is set but invalid.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <code>gio start</code> needs <code>node_modules</code> (the Node worker runs your
          app from source through <code>tsx</code>). To deploy one folder without{' '}
          <code>node_modules</code>, use{' '}
          <a href="/docs/cli/build-standalone"><code>gio build standalone</code></a>.
        </li>
        <li>
          Scaffolded apps run <code>cross-env NODE_ENV=production giojs-server</code> from{' '}
          <code>npm start</code>; it starts the same server without the ready banner (see{' '}
          <a href="/docs/cli/giojs-server"><code>giojs-server</code></a>).
        </li>
        <li>
          The client code is bundled at every start, and the deployment id is derived from
          the app&apos;s code, so a restart of changed code invalidates the old cache entries
          on its own.
        </li>
        <li>
          Exit codes: <code>0</code> after a clean shutdown, <code>1</code> when the server
          fails to start or exits with an error, <code>2</code> for a usage error.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/guides/deploying">Deploying</a> and the <a href="/docs/guides/production-checklist">Production Checklist</a></li>
        <li><a href="/docs/cli/dev"><code>gio dev</code></a></li>
        <li><a href="/docs/cli/build-standalone"><code>gio build standalone</code></a></li>
        <li><a href="/docs/configuration">gio.toml</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: 'Introduced.',
        },
      ]} />
    </>
  );
}
