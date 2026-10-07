import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>WebSockets</h1>
      <p className="page-subtitle">Routed, authenticated, full-duplex connections with rooms.</p>
      <p>
        Export a <code>wsHandler</code> from a <code>route.ts</code> to accept WebSocket
        connections at that path. Patterns follow the same rules as pages - dynamic{' '}
        <code>[segments]</code>, <code>[...catchAll]</code>, <code>[[...optional]]</code> and{' '}
        <code>(groups)</code> - and the matched segments arrive in <code>socket.params</code>.
        WebSockets run over their own IPC pipe, so neither they nor HTTP requests block each
        other.
      </p>
      <CodeBlock lang="ts" code={`// app/chat/[room]/route.ts  →  ws://host/chat/lobby
import { broadcast, type GioSocket } from '@gio.js/core';

export function wsHandler(socket: GioSocket) {
  const room = socket.params.room;           // 'lobby'
  socket.join(room);
  socket.on('message', (text) => broadcast(room, \`\${socket.id}: \${text}\`));
  socket.on('close', (code, reason) => console.log('left', room, code, reason));
}`} />

      <h2>The socket</h2>
      <table>
        <thead>
          <tr><th>Member</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>id</code></td><td>Unique connection id.</td></tr>
          <tr><td><code>path</code>, <code>params</code>, <code>query</code></td><td>The URL the client connected to, its dynamic segments, and its query string.</td></tr>
          <tr><td><code>headers</code></td><td>A fixed subset of the upgrade request&apos;s headers, lowercase: <code>cookie</code>, <code>authorization</code>, <code>user-agent</code>, <code>accept-language</code>, <code>origin</code> and <code>x-request-id</code>.</td></tr>
          <tr><td><code>cookies</code></td><td>The <code>Cookie</code> header, parsed.</td></tr>
          <tr><td><code>ip</code></td><td>The client&apos;s address - behind a proxy only when it is listed in <code>[server] trusted_proxies</code>, like <code>req.ip</code>.</td></tr>
          <tr><td><code>requestId</code></td><td>The upgrade request&apos;s <code>X-Request-Id</code>, on every log line.</td></tr>
          <tr><td><code>send(data)</code></td><td>A string sends a text frame, a <code>Buffer</code> a binary frame.</td></tr>
          <tr><td><code>close(code?, reason?)</code></td><td>Close the connection (default 1000).</td></tr>
          <tr><td><code>on(&apos;message&apos; | &apos;close&apos;, fn)</code></td><td>Text frames arrive as strings, binary frames as <code>Buffer</code>.</td></tr>
          <tr><td><code>join(room)</code>, <code>leave(room)</code>, <code>rooms</code></td><td>Room membership (below).</td></tr>
          <tr><td><code>broadcast(data)</code></td><td>Send to every socket connected to the same path, this one included.</td></tr>
        </tbody>
      </table>

      <h2>Authenticating connections</h2>
      <p>
        The handler runs once per connection and decides whether to keep it. Return{' '}
        <code>false</code> (or resolve to <code>false</code>) to reject: the connection closes
        with code <code>4401</code> and reason <code>unauthorized</code>. Call{' '}
        <code>socket.close(code, reason)</code> to reject with your own code. A handler that
        throws closes the connection with <code>1011</code>. Anything else accepts it - for an
        async handler, when its promise resolves.
      </p>
      <ul>
        <li>
          Until the handler accepts, the socket receives nothing from{' '}
          <code>socket.broadcast()</code> or room broadcasts (even rooms it already joined),
          so a client you are about to reject never sees other members&apos; traffic. Your own{' '}
          <code>socket.send()</code> reaches it, e.g. to ask for a token.
        </li>
        <li>
          Messages that arrive before the handler registers a <code>&apos;message&apos;</code>{' '}
          listener are held and delivered to it, in order. Once a listener exists, messages
          reach it as they arrive - even while an async handler is still deciding - so
          register yours after the check unless it is the check (below). A client that sends
          more than 256 messages or 1 MiB before anyone listens is closed with{' '}
          <code>1008</code>; messages held for 10 seconds by a handler that neither listens nor
          finishes are dropped.
        </li>
        <li>
          Keep an async handler to the decision: start long-lived work (a feed loop) without
          awaiting it, since a handler that never resolves never accepts.
        </li>
      </ul>
      <CodeBlock lang="ts" code={`// app/live/route.ts
import type { GioSocket } from '@gio.js/core';
import { sessions } from '../../lib/session.server.ts';

export async function wsHandler(socket: GioSocket) {
  const session = sessions.getSession(socket);        // reads socket.cookies
  const userId = session.get('userId');
  if (userId === undefined) return false;             // → close 4401 'unauthorized'

  const user = await db.users.find(userId);
  if (user.banned) return socket.close(4403, 'forbidden');

  socket.join(\`user:\${userId}\`);
  socket.on('message', (msg) => handle(user, msg));
}`} />
      <p>
        Browsers send the page&apos;s cookies with the upgrade request but cannot set other
        headers on a WebSocket, so a session cookie is the natural credential. Other clients
        can send <code>Authorization</code>. Without a cookie, have the client send a token as
        its first message and await it - give the wait a deadline, or a client that never
        sends one keeps its socket open:
      </p>
      <CodeBlock lang="ts" code={`// app/feed/route.ts  - the client sends its token first
import type { GioSocket } from '@gio.js/core';

export async function wsHandler(socket: GioSocket) {
  const token = await new Promise<string | null>((resolve) => {
    socket.on('message', (data) => resolve(String(data)));
    setTimeout(() => resolve(null), 5_000);
  });
  const user = token === null ? null : await verifyToken(token);
  if (user === null) return false;                    // → close 4401

  socket.join(\`user:\${user.id}\`);
  socket.on('message', (msg) => handle(user, msg));   // later messages
}`} />
      <p>
        That first listener stays registered and sees later messages too (resolving an
        already-resolved promise does nothing). Avoid tokens in the URL
        (<code>socket.query.token</code>) unless they are short-lived: URLs end up in logs.
      </p>
      <p>
        The upgrade itself always completes before your handler runs, so a rejected client
        sees the connection open and then close with your code - which is exactly what a
        browser can observe (it never sees the HTTP status of a failed upgrade).
      </p>

      <h2>Rooms</h2>
      <p>
        <code>socket.join(room)</code> adds a socket to a named room; it leaves with{' '}
        <code>socket.leave(room)</code> or when it disconnects. <code>broadcast(room, data)</code>{' '}
        sends to every member - from a <code>wsHandler</code>, or from any route handler, so an
        HTTP request can publish to WebSocket clients:
      </p>
      <CodeBlock lang="ts" code={`// app/api/rooms/[room]/route.ts
import { broadcast, type GioRequest } from '@gio.js/core';

export function POST(req: GioRequest) {
  const delivered = broadcast(req.params.room, JSON.stringify(req.json()));
  return { delivered };
}

// Everyone but the sender:
socket.on('message', (msg) => broadcast(room, msg, { except: socket.id }));`} />
      <ul>
        <li>Strings go out as text frames, <code>Uint8Array</code>/<code>Buffer</code> as binary frames.</li>
        <li>
          Membership lives in the Rust server, so a broadcast crosses to it once, however many
          sockets it reaches. Rooms disappear when their last member leaves.
        </li>
        <li>A room name is any non-empty string up to 256 bytes; a socket can be in up to 100 rooms (<code>join</code> throws beyond either).</li>
        <li>
          <code>broadcast</code> returns <code>false</code> when no WebSocket server is
          connected (<code>[websocket] enabled = false</code>, or for the moment the worker
          restarts). Delivery is best-effort, like any WebSocket send: under heavy
          backpressure, messages are dropped rather than buffered without bound.
        </li>
        <li>
          Rooms are per server process. Running several GioJS instances behind a load balancer
          needs a shared bus (Redis, NATS, Postgres <code>LISTEN</code>) that each instance
          relays to its local rooms.
        </li>
      </ul>

      <h2>Close codes</h2>
      <table>
        <thead>
          <tr><th>Code</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td><code>1000</code></td><td>Normal close (<code>socket.close()</code>).</td></tr>
          <tr><td><code>1001</code></td><td>The server is shutting down, or the worker restarted (its sockets&apos; state is gone): reconnect.</td></tr>
          <tr><td><code>1008</code></td><td>Too many messages (256, or 1 MiB) before the handler listened or accepted the connection.</td></tr>
          <tr><td><code>1011</code></td><td>The <code>wsHandler</code> threw.</td></tr>
          <tr><td><code>1013</code></td><td><code>[websocket] max_connections</code> reached: try again later.</td></tr>
          <tr><td><code>4401</code></td><td>The handler rejected the connection (returned <code>false</code>).</td></tr>
          <tr><td><code>4404</code></td><td>No <code>route.ts</code> exports a <code>wsHandler</code> for this path.</td></tr>
        </tbody>
      </table>
      <p>
        Use 4000-4499 for refusals that retrying will not fix (like HTTP 4xx) and 4500-4999
        for transient ones: <code>useWebSocket</code> reconnects on the latter only.
      </p>

      <h2>On the client: useWebSocket</h2>
      <CodeBlock lang="tsx" code={`'use client';
import { useWebSocket } from '@gio.js/react';

export function Chat({ room }: { room: string }) {
  const { send, lastMessage, readyState, isReconnecting } = useWebSocket(\`/chat/\${room}\`, {
    reconnect: { maxAttempts: 20, initialDelayMs: 500, maxDelayMs: 30_000 },
    queueWhileDisconnected: true,        // buffer sends until (re)connected
    onMessage: (msg) => appendToLog(msg), // every message, in order
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); send(text); }}>
      {isReconnecting ? 'Reconnecting…' : readyState === WebSocket.OPEN ? 'Live' : 'Connecting…'}
      <p>{String(lastMessage ?? '')}</p>
    </form>
  );
}`} />
      <ul>
        <li>Relative URLs resolve against the page (<code>ws:</code> or <code>wss:</code> to match). Binary frames arrive as <code>ArrayBuffer</code>.</li>
        <li>
          After an unintended close it reconnects with exponential backoff and jitter (on by
          default; <code>reconnect: false</code> turns it off). The backoff starts over only
          after a connection stays open for <code>minUptimeMs</code> (default 5 s): the server
          refuses after the upgrade (<code>1013</code> at <code>max_connections</code>,{' '}
          <code>1011</code>), so a socket that opens and is closed right away keeps backing off
          and counts toward <code>maxAttempts</code>. It does not reconnect after{' '}
          <code>1000</code> or a 4000-4499 close, after <code>close()</code>, or once unmounted;{' '}
          <code>shouldReconnect(event)</code> replaces that policy, and{' '}
          <code>reconnect()</code> opens a fresh connection.
        </li>
        <li>
          <code>send()</code> returns <code>false</code> when the message was dropped: the socket
          is not open and queueing is off (or its 100-message queue is full).
        </li>
        <li>
          <code>lastMessage</code> drives renders, but React may batch two quick messages into
          one render - use <code>onMessage</code> when every message matters.
        </li>
        <li>Returns <code>readyState</code> (<code>-1</code> during SSR), <code>reconnectAttempts</code> and <code>isReconnecting</code>; the hook is a no-op on the server.</li>
      </ul>

      <h2>Origin check</h2>
      <p>
        Browsers let any website open a WebSocket to your server with your users&apos; cookies
        attached. GioJS refuses upgrade requests whose <code>Origin</code> is another site
        (403, before the upgrade); same-origin pages, origins listed in{' '}
        <code>[security.csrf] trusted_origins</code>, and clients that send no{' '}
        <code>Origin</code> connect normally. The check stays on when{' '}
        <code>[security.csrf] enabled = false</code>; <code>[security.websocket] check_origin</code>{' '}
        switches it. See <a href="/docs/security">Security</a>.
      </p>

      <h2>Limits</h2>
      <p>
        <code>[websocket]</code> in <code>gio.toml</code> sets <code>max_connections</code>{' '}
        (default 1000; further connections close with 1013) and{' '}
        <code>ping_interval_secs</code> (default 30), the keep-alive ping that also reaps dead
        peers. See <a href="/docs/configuration">Configuration</a>.
      </p>
    </>
  );
}
