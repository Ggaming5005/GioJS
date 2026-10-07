import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'useWebSocket',
  description:
    'Open a WebSocket from a component, with automatic reconnects, an optional send queue and every message delivered in order.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>useWebSocket</h1>
      <p className="page-subtitle">
        Open a WebSocket from a component, with automatic reconnects, an optional send queue and
        every message delivered in order.
      </p>
      <CodeBlock lang="tsx" title="app/chat/[room]/chat.tsx" code={`import { useState } from 'react';
import { useWebSocket } from '@gio.js/react';

export function Chat({ room }: { room: string }) {
  const [messages, setMessages] = useState<string[]>([]);
  const { send, readyState } = useWebSocket(\`/chat/\${room}\`, {
    onMessage: (data) => setMessages((list) => [...list, String(data)]),
  });
  return (
    <>
      <p>{readyState === WebSocket.OPEN ? 'Live' : 'Connecting...'}</p>
      <ul>{messages.map((m, i) => <li key={i}>{m}</li>)}</ul>
      <button onClick={() => send('hello')}>Say hello</button>
    </>
  );
}`} />
      <p>
        The server side is a <code>wsHandler</code> export in the <code>route.ts</code> for that
        path - see <a href="/docs/page-exports/ws-handler"><code>wsHandler</code></a> and{' '}
        <a href="/docs/websockets">WebSockets</a>.
      </p>

      <h2 id="reference">Reference</h2>
      <h3 id="parameters">Parameters</h3>
      <PropsTable kind="Parameter" rows={[
        {
          name: 'url',
          type: 'string',
          required: true,
          description: <>Where to connect. A relative URL (<code>/chat/lobby</code>) resolves against the page, with <code>ws:</code> on an <code>http:</code> page and <code>wss:</code> on <code>https:</code>. A new value closes the old socket and opens one to the new URL.</>,
        },
        {
          name: 'options',
          type: 'UseWebSocketOptions',
          default: '{}',
          description: 'See below.',
        },
      ]} />

      <h3 id="options">Options</h3>
      <PropsTable kind="Option" rows={[
        {
          name: 'reconnect',
          type: 'boolean | ReconnectOptions',
          default: 'true',
          description: <>Reconnect after a close the hook did not ask for. <code>false</code> turns it off; an object tunes the backoff.</>,
        },
        {
          name: 'shouldReconnect',
          type: '(event: CloseEvent) => boolean',
          description: <>Decide per close whether to reconnect, replacing the <a href="#reconnecting">default policy</a>. Ignored when <code>reconnect</code> is <code>false</code>.</>,
        },
        {
          name: 'queueWhileDisconnected',
          type: 'boolean | { maxMessages: number }',
          default: 'false',
          description: <>Keep <code>send()</code> calls made while the socket is not open and send them, in order, once it opens. <code>true</code> keeps up to 100.</>,
        },
        {
          name: 'protocols',
          type: 'string | string[]',
          description: <>Subprotocols for the <code>WebSocket</code> constructor, read on each (re)connect.</>,
        },
        {
          name: 'onMessage',
          type: '(data: WebSocketData, event: MessageEvent) => void',
          description: <>Every message, in order. <code>data</code> is a <code>string</code> or an <code>ArrayBuffer</code>.</>,
        },
        {
          name: 'onOpen',
          type: '(event: Event) => void',
          description: 'Each time a connection opens, reconnects included.',
        },
        {
          name: 'onClose',
          type: '(event: CloseEvent) => void',
          description: <>Each time the connection closes, with its <code>code</code> and <code>reason</code>.</>,
        },
      ]} />
      <p>
        The options are read when they are needed, so passing a new object or new callbacks on
        every render never reconnects.
      </p>

      <h3 id="reconnectoptions"><code>ReconnectOptions</code></h3>
      <PropsTable kind="Option" rows={[
        { name: 'maxAttempts', type: 'number', default: 'Infinity', description: 'Consecutive attempts before giving up - ones that fail, and ones that open but close again within minUptimeMs.' },
        { name: 'initialDelayMs', type: 'number', default: '500', description: 'Backoff before the first retry.' },
        { name: 'maxDelayMs', type: 'number', default: '30000', description: 'The longest backoff.' },
        { name: 'minUptimeMs', type: 'number', default: '5000', description: 'How long a connection must stay open before the backoff starts over.' },
      ]} />

      <h3 id="returns">Returns</h3>
      <PropsTable kind="Field" rows={[
        { name: 'send', type: '(data: string | ArrayBufferLike | ArrayBufferView | Blob) => boolean', description: <>Send now, or queue it (with <code>queueWhileDisconnected</code>). <code>false</code> when the message was dropped: not open and not queued, the queue full, or the hook stopped.</> },
        { name: 'lastMessage', type: 'string | ArrayBuffer | null', description: <>The latest message, <code>null</code> before the first. React may batch two quick messages into one render: use <code>onMessage</code> when every one matters.</> },
        { name: 'readyState', type: 'number', description: <><code>0</code> connecting, <code>1</code> open, <code>3</code> closed, as on <code>WebSocket</code>; <code>-1</code> before a socket exists (server rendering).</> },
        { name: 'reconnectAttempts', type: 'number', description: <>Retries since a connection last stayed open <code>minUptimeMs</code>; <code>0</code> while connected.</> },
        { name: 'isReconnecting', type: 'boolean', description: 'Waiting to retry after a drop.' },
        { name: 'close', type: '(code?: number, reason?: string) => void', description: <>Close for good (default code <code>1000</code>): no reconnects until <code>reconnect()</code> or a new <code>url</code>.</> },
        { name: 'reconnect', type: '() => void', description: 'Open a fresh connection now, with the backoff reset.' },
      ]} />
      <p>
        The types are exported as <code>UseWebSocketOptions</code>, <code>ReconnectOptions</code>,{' '}
        <code>UseWebSocketResult</code> and <code>WebSocketData</code>.
      </p>

      <h3 id="reconnecting">Reconnecting</h3>
      <p>
        After an unintended close the hook waits and connects again. Retry <em>n</em> (from 0)
        waits between half and all of <code>min(maxDelayMs, initialDelayMs × 2^n)</code> - with
        the defaults about 0.25-0.5 s, then 0.5-1 s, 1-2 s and so on up to 15-30 s - so clients
        do not all return in the same instant after a server restart.
      </p>
      <table>
        <thead><tr><th>Close code</th><th>Reconnects?</th></tr></thead>
        <tbody>
          <tr><td><code>1000</code> (the server ended the conversation)</td><td>No</td></tr>
          <tr><td><code>4000</code>-<code>4499</code> (the application refused, like an HTTP 4xx: <code>4401</code> from a <code>wsHandler</code> returning <code>false</code>, <code>4404</code> no handler)</td><td>No</td></tr>
          <tr><td><code>1001</code> (server shutdown or worker restart), <code>1006</code> (network loss), <code>1011</code>, <code>1012</code>, <code>1013</code> (over <code>max_connections</code>)</td><td>Yes</td></tr>
          <tr><td><code>4500</code>-<code>4999</code> (transient application errors)</td><td>Yes</td></tr>
        </tbody>
      </table>
      <p>
        It never reconnects after <code>close()</code>, after unmount, or once{' '}
        <code>maxAttempts</code> is reached. The backoff starts over only when a connection
        stayed open for <code>minUptimeMs</code>: a server that accepts the upgrade and closes
        straight away (<code>1013</code>, <code>1011</code>) keeps being backed off from.
      </p>

      <h2 id="examples">Examples</h2>

      <h3 id="sending-json">Sending JSON</h3>
      <CodeBlock lang="tsx" title="app/board/cursor-sync.tsx" code={`import { useWebSocket } from '@gio.js/react';

interface Cursor {
  x: number;
  y: number;
}

export function CursorSync({ onRemote }: { onRemote: (cursor: Cursor) => void }) {
  const { send } = useWebSocket('/board/live', {
    onMessage: (data) => {
      if (typeof data === 'string') onRemote(JSON.parse(data) as Cursor);
    },
  });
  return (
    <div
      className="board"
      onPointerMove={(e) => send(JSON.stringify({ x: e.clientX, y: e.clientY }))}
    />
  );
}`} />

      <h3 id="a-connection-indicator">A connection indicator</h3>
      <CodeBlock lang="tsx" code={`const { readyState, isReconnecting, reconnectAttempts, reconnect } = useWebSocket('/feed', {
  reconnect: { maxAttempts: 10 },
});

if (isReconnecting) return <p>Reconnecting (attempt {reconnectAttempts})...</p>;
if (readyState === WebSocket.CLOSED) return <button onClick={reconnect}>Reconnect</button>;`} />

      <h3 id="queueing-while-offline">Queueing while offline</h3>
      <CodeBlock lang="tsx" code={`const { send } = useWebSocket('/notes/42', { queueWhileDisconnected: { maxMessages: 500 } });

// Sent at once when open; otherwise kept and sent on the next open.
const accepted = send(JSON.stringify({ op: 'insert', text: 'hi' }));
if (!accepted) showWarning('Change not sent');`} />

      <h3 id="a-custom-reconnect-policy">A custom reconnect policy</h3>
      <CodeBlock lang="tsx" code={`useWebSocket('/prices', {
  // Also give up when the server says the market is closed (4503 would otherwise retry).
  shouldReconnect: (event) => event.code !== 1000 && event.code !== 4503 && !(event.code >= 4000 && event.code < 4500),
});`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          The hook does nothing during server rendering (<code>readyState</code> is{' '}
          <code>-1</code>, <code>send</code> returns <code>false</code>); the socket opens after
          the component mounts in the browser. In the server-only root layout it never runs.
        </li>
        <li>
          A message is only ever sent to the URL it was queued for: when <code>url</code>{' '}
          changes (another room), whatever is still queued is dropped.
        </li>
        <li>
          Binary frames always arrive as <code>ArrayBuffer</code> (<code>binaryType</code> is
          fixed), never as <code>Blob</code>.
        </li>
        <li>
          Cookies go with the upgrade request, and the server refuses cross-site upgrades by
          checking <code>Origin</code> (<a href="/docs/configuration/security-websocket"><code>[security.websocket]</code></a>).
        </li>
        <li>
          A worker restart closes every socket with <code>1001</code>, and the hook reconnects;
          room memberships are re-established by your <code>wsHandler</code> when it accepts the
          new connection.
        </li>
        <li>
          <code>readyState</code> never reports <code>2</code> (closing): it moves from{' '}
          <code>1</code> to <code>3</code> when the close completes.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/websockets">WebSockets</a> - the guide: handlers, auth, rooms, close codes.</li>
        <li><a href="/docs/page-exports/ws-handler"><code>wsHandler</code></a> - the server side.</li>
        <li><a href="/docs/functions/broadcast"><code>broadcast</code></a> - send to a room from any route handler.</li>
        <li><a href="/docs/configuration/websocket"><code>[websocket]</code></a> - <code>max_connections</code>, <code>ping_interval_secs</code>.</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: <>Reconnects by default with exponential backoff and jitter (<code>reconnect: false</code> for the old behavior). Added <code>shouldReconnect</code>, <code>queueWhileDisconnected</code>, <code>onMessage</code>, <code>onOpen</code>, <code>onClose</code>, <code>reconnectAttempts</code>, <code>isReconnecting</code> and <code>reconnect()</code>.</>,
        },
        { version: 'v0.1.0-beta.1', changes: 'Introduced.' },
      ]} />
    </>
  );
}
