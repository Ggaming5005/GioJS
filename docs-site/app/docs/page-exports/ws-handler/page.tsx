import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'wsHandler',
  description: 'Accept WebSocket connections at the path of a route.ts, and decide per connection whether to keep each one.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>wsHandler</h1>
      <p className="page-subtitle">
        Accept WebSocket connections at the path of a <code>route.ts</code>, and decide per
        connection whether to keep each one.
      </p>
      <CodeBlock lang="ts" title="app/chat/[room]/route.ts" code={`import { broadcast, type GioSocket } from '@gio.js/core';

export function wsHandler(socket: GioSocket) {
  const room = socket.params.room ?? 'lobby';    // ws://host/chat/news → 'news'
  socket.join(room);
  socket.send(\`welcome to \${room}\`);
  socket.on('message', (text) => broadcast(room, String(text)));
}`} />
      <p>
        The Rust server completes the WebSocket upgrade and hands each connection to the Node
        worker over a pipe of its own, so sockets and HTTP requests never wait on each other.
        The worker finds the <code>route.ts</code> whose pattern matches the path - with the
        same rules as pages: <code>[id]</code>, <code>[...slug]</code>,{' '}
        <code>[[...slug]]</code>, <code>(group)</code> folders - and calls its{' '}
        <code>wsHandler</code> once for the connection.
      </p>

      <h2 id="reference">Reference</h2>
      <h3 id="parameters">Parameters</h3>
      <p><code>socket</code> (<code>GioSocket</code>) is the connection:</p>
      <PropsTable kind="Field" rows={[
        { name: 'id', type: 'string', description: <>Unique connection id (for <code>{'broadcast(room, data, { except })'}</code>).</> },
        { name: 'path', type: 'string', description: <>The URL path the client connected to. <code>routeId</code> is the same value.</> },
        { name: 'params', type: 'Record<string, string>', description: <>The dynamic segments of the matched <code>route.ts</code>.</> },
        { name: 'query', type: 'Record<string, string>', description: 'The query string of the upgrade request.' },
        { name: 'headers', type: 'Record<string, string>', description: <>A fixed subset of the upgrade request&apos;s headers, lowercase: <code>cookie</code>, <code>authorization</code>, <code>user-agent</code>, <code>accept-language</code>, <code>origin</code> and <code>x-request-id</code>.</> },
        { name: 'cookies', type: 'Record<string, string>', description: <>The <code>Cookie</code> header, parsed; <code>sessions.getSession(socket)</code> reads it.</> },
        { name: 'ip', type: 'string | undefined', description: <>The client&apos;s address, behind <code>[server] trusted_proxies</code>.</> },
        { name: 'requestId', type: 'string | undefined', description: <>The upgrade request&apos;s <code>X-Request-Id</code>.</> },
        { name: 'rooms', type: 'ReadonlySet<string>', description: 'The rooms this socket joined.' },
        { name: 'send(data)', type: 'void', description: <>A string sends a text frame, a <code>Buffer</code> a binary frame.</> },
        { name: 'close(code?, reason?)', type: 'void', description: <>Closes the connection (default <code>1000</code>). Use <code>4000</code>-<code>4999</code> for your own codes.</> },
        { name: "on('message', fn)", type: 'void', description: <>Text frames arrive as strings, binary frames as <code>Buffer</code>.</> },
        { name: "on('close', fn)", type: 'void', description: <><code>(code, reason)</code> once the connection is gone.</> },
        { name: 'join(room) / leave(room)', type: 'void', description: <>Room membership. A room name is a non-empty string of up to 256 bytes, and a socket joins at most 100 rooms; <code>join</code> throws past either limit.</> },
        { name: 'broadcast(data)', type: 'void', description: 'Sends to every accepted socket connected to the same path, this one included.' },
      ]} />

      <h3 id="returns">Returns</h3>
      <table>
        <thead><tr><th>The handler</th><th>The connection</th></tr></thead>
        <tbody>
          <tr><td>returns or resolves to <code>false</code></td><td>Closed with <code>4401</code> <code>unauthorized</code>.</td></tr>
          <tr><td>returns anything else, or resolves</td><td>Accepted.</td></tr>
          <tr><td>throws or rejects</td><td>Closed with <code>1011</code> <code>internal error</code>; the error is logged.</td></tr>
          <tr><td>calls <code>socket.close(code, reason)</code></td><td>Closed with your code.</td></tr>
        </tbody>
      </table>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>Before it is accepted</strong> a socket receives no route or room
          broadcasts, even from rooms it already joined; its own <code>socket.send()</code>{' '}
          reaches it (to ask for a token, say).
        </li>
        <li>
          <strong>Early messages</strong> that arrive before any <code>&apos;message&apos;</code>{' '}
          listener exists are held and delivered to the first one, in order - up to 256
          messages or 1 MiB; past that the connection closes with <code>1008</code>. Messages
          held for 10 seconds by a handler that neither listens nor finishes are dropped.
        </li>
        <li>
          <strong>No handler.</strong> A connection to a path whose <code>route.ts</code>{' '}
          exports no <code>wsHandler</code> (or with no <code>route.ts</code> at all) closes
          with <code>4404</code> <code>no websocket handler</code>. One to a{' '}
          <code>route.ts</code> that threw while it was imported closes with <code>1011</code>{' '}
          and <code>internal error (digest ...)</code>.
        </li>
        <li>
          <strong>Server-side limits</strong> come from <code>[websocket]</code> in gio.toml:{' '}
          <code>enabled</code>, <code>max_connections</code> (further connections close with{' '}
          <code>1013</code>) and <code>ping_interval_secs</code>. A shutdown or a worker
          restart closes every socket with <code>1001</code>.
        </li>
        <li>
          <strong>Origin check.</strong> An upgrade whose <code>Origin</code> is another site
          is refused with <code>403</code> before the handler runs, unless the origin is in{' '}
          <code>[security.csrf] trusted_origins</code> or{' '}
          <code>[security.websocket] check_origin = false</code>.
        </li>
      </ul>

      <h3 id="types">Types</h3>
      <p>
        <code>WsHandler</code> is <code>{'(socket: GioSocket) => void | boolean | Promise<void | boolean>'}</code>.
        Both are exported from <code>@gio.js/core</code>.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="authenticate-with-the-session-cookie">Authenticate with the session cookie</h3>
      <CodeBlock lang="ts" title="app/live/route.ts" code={`import type { GioSocket } from '@gio.js/core';
import { sessions } from '../../lib/session.server.ts';
import { db } from '../../lib/db.server.ts';
import { handle } from '../../lib/live.server.ts';

export async function wsHandler(socket: GioSocket) {
  const userId = sessions.getSession(socket).get('userId');
  if (userId === undefined) return false;               // close 4401 'unauthorized'

  const user = await db.users.find(userId);
  if (user.banned) return socket.close(4403, 'forbidden');

  socket.join(\`user:\${userId}\`);
  socket.on('message', (msg) => handle(user, msg));
}`} />

      <h3 id="wait-for-a-token-message">Wait for a token message</h3>
      <CodeBlock lang="ts" title="app/feed/route.ts" code={`import type { GioSocket } from '@gio.js/core';
import { verifyToken } from '../../lib/tokens.server.ts';

export async function wsHandler(socket: GioSocket) {
  const token = await new Promise<string | null>((resolve) => {
    socket.on('message', (data) => resolve(String(data)));
    setTimeout(() => resolve(null), 5_000);             // never wait forever
  });
  const user = token === null ? null : await verifyToken(token);
  if (user === null) return false;                    // close 4401 'unauthorized'

  socket.send('accepted');
  return true;
}`} />

      <h3 id="publish-from-an-http-request">Publish from an HTTP request</h3>
      <CodeBlock lang="ts" title="app/api/rooms/[room]/route.ts" code={`import { broadcast, type RouteHandler } from '@gio.js/core';

export const POST: RouteHandler<'/api/rooms/:room'> = (req) => {
  const delivered = broadcast(req.params.room, JSON.stringify(req.json()));
  return { delivered };                                 // false: no WebSocket server connected
};`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Keep an async handler to the decision: a handler that never resolves never accepts.
          Start long-running work without awaiting it.
        </li>
        <li>
          Browsers cannot set headers on a WebSocket, so a cookie (or a first message) is the
          credential. Avoid long-lived tokens in the URL: URLs end up in logs.
        </li>
        <li>
          Rooms and connections are per server instance. Across instances, relay through a
          shared bus (Redis, NATS, Postgres <code>LISTEN</code>).
        </li>
        <li>
          On the client, <a href="/docs/hooks/use-web-socket"><code>useWebSocket</code></a>{' '}
          reconnects with backoff, but not after <code>1000</code> or a{' '}
          <code>4000</code>-<code>4499</code> close: use <code>4500</code>-<code>4999</code> for
          refusals a retry may fix.
        </li>
        <li>
          The same <code>route.ts</code> can also export{' '}
          <a href="/docs/page-exports/http-methods">HTTP method handlers</a>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/websockets">WebSockets</a> - the guide, with close codes</li>
        <li><a href="/docs/functions/broadcast"><code>broadcast</code></a></li>
        <li><a href="/docs/hooks/use-web-socket"><code>useWebSocket</code></a></li>
        <li><a href="/docs/configuration/websocket"><code>[websocket]</code></a> and <a href="/docs/configuration/security-websocket"><code>[security.websocket]</code></a></li>
        <li><a href="/docs/file-conventions/route"><code>route.ts</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Page routing for WebSocket paths (<code>socket.params</code>); <code>path</code>, <code>query</code>, <code>headers</code>, <code>cookies</code>, <code>ip</code> and <code>requestId</code> on the socket; return <code>false</code> to reject (<code>4401</code>); async handlers decide the connection; rooms; <code>4404</code> for a path without a handler.</> },
        { version: 'v0.1.0-beta.5', changes: <>Binary frames arrive as a <code>Buffer</code> and <code>send()</code> accepts one; connections survive worker restarts.</> },
        { version: 'v0.1.0-beta.1', changes: 'Introduced.' },
      ]} />
    </>
  );
}
