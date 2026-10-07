import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable, StartupWarnings } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[websocket]',
  description: 'WebSocket routes (route.ts files that export wsHandler): the switch, the connection cap and server pings.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[websocket]</h1>
      <p className="page-subtitle">
        WebSocket routes (<code>route.ts</code> files that export <code>wsHandler</code>): the
        switch, the connection cap and server pings.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[websocket]
max_connections = 5000
ping_interval_secs = 25`} />
      <p>
        The Origin check on upgrades lives in{' '}
        <a href="/docs/configuration/security-websocket"><code>[security.websocket]</code></a>. The{' '}
        <a href="/docs/websockets">WebSockets guide</a> covers handlers, rooms and the client.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'enabled', type: 'boolean', default: 'true', zero: <>Upgrades are answered <code>501</code></>, description: <>Accept WebSocket upgrades and connect them to the worker&apos;s <code>wsHandler</code>s. Off, no socket is ever opened. The <a href="/docs/configuration/security-websocket">origin check</a> still runs first, so a cross-site upgrade gets its <code>403</code> instead.</> },
        { key: 'max_connections', type: 'integer', default: '1000', zero: <>Unlimited. Warns.</>, description: <>Open WebSockets across the server. A socket over the cap is accepted and immediately closed with <code>1013</code> (try again later), reason <code>too many connections</code>, which clients read as a reason to back off and retry.</> },
        { key: 'ping_interval_secs', type: 'integer', default: '30', zero: 'No server pings', description: <>Ping every socket this often, so a peer that vanished is noticed when the ping cannot be sent and the socket is closed. The first ping goes out one interval after the connection opens.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          Open sockets are not counted by{' '}
          <a href="/docs/configuration/server"><code>[server] max_connections</code></a>, and the
          connection timeouts in <code>[server]</code> never close them.
        </li>
        <li>
          A path whose module exports no <code>wsHandler</code> closes the socket with{' '}
          <code>4404</code>; an async handler whose promise rejects closes it with <code>1011</code>. See{' '}
          <a href="/docs/websockets#close-codes">Close codes</a>.
        </li>
        <li>
          If the server cannot connect to the worker&apos;s WebSocket channel at startup, it logs{' '}
          <code>WS IPC connect failed - WebSocket disabled</code> and answers upgrades{' '}
          <code>501</code> as if <code>enabled</code> were <code>false</code>.
        </li>
      </ul>

      <h3 id="startup-warnings">Startup warnings</h3>
      <StartupWarnings rows={[
        { when: <><code>max_connections = 0</code> while enabled</>, text: '[websocket] max_connections = 0: WebSocket connections are unlimited - every open socket holds memory and a file descriptor' },
      ]} />

      <h2 id="examples">Examples</h2>
      <h3 id="no-websockets">No WebSockets</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[websocket]
enabled = false`} />

      <h3 id="behind-a-proxy-with-a-60-second-idle-timeout">Behind a proxy with a 60-second idle timeout</h3>
      <p>Pings keep the connection busy, so the proxy does not close a quiet socket:</p>
      <CodeBlock lang="toml" title="gio.toml" code={`[websocket]
ping_interval_secs = 25`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <code>0</code> means unlimited for <code>max_connections</code> and no pings for{' '}
          <code>ping_interval_secs</code>. To refuse WebSockets, use <code>enabled = false</code>.
        </li>
        <li>
          Each open socket holds a file descriptor: keep the process limit (<code>ulimit -n</code>)
          above <code>[server] max_connections</code> plus this cap.
        </li>
        <li>In a worker pool each socket stays on one worker; room broadcasts reach sockets on every worker.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/websockets">WebSockets</a></li>
        <li><a href="/docs/page-exports/ws-handler"><code>wsHandler</code></a>, <a href="/docs/functions/broadcast"><code>broadcast</code></a> and <a href="/docs/hooks/use-web-socket"><code>useWebSocket</code></a></li>
        <li><a href="/docs/configuration/security-websocket"><code>[security.websocket]</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <><code>max_connections = 0</code> means unlimited (it closed every socket with <code>1013</code>) and logs a startup warning; <code>ping_interval_secs = 0</code> means no pings (it crashed every connection).</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced with <code>enabled</code>, <code>max_connections</code> and <code>ping_interval_secs</code>.</> },
      ]} />
    </>
  );
}
