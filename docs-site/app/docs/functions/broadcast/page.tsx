import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'broadcast',
  description:
    'Send a message to every WebSocket in a room, from a wsHandler or from any route handler.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>broadcast</h1>
      <p className="page-subtitle">
        Send a message to every WebSocket in a room, from a <code>wsHandler</code> or from any
        route handler.
      </p>
      <CodeBlock lang="ts" code={`import { broadcast } from '@gio.js/core';

broadcast('lobby', JSON.stringify({ text: 'Deploy finished' }));`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Parameter" rows={[
        {
          name: 'room',
          type: 'string',
          required: true,
          description: (
            <>
              The room sockets joined with <code>socket.join(room)</code>: a non-empty string of
              at most 256 bytes.
            </>
          ),
        },
        {
          name: 'data',
          type: 'string | Uint8Array',
          required: true,
          description: (
            <>
              A string goes out as a text frame; a <code>Uint8Array</code> (a{' '}
              <code>Buffer</code> too) as a binary frame.
            </>
          ),
        },
        {
          name: 'options.except',
          type: 'string',
          description: (
            <>A socket id (<code>socket.id</code>) to leave out - usually the sender.</>
          ),
        },
      ]} />
      <h3 id="returns">Returns</h3>
      <p>
        <code>boolean</code>: <code>true</code> when the message was handed to the server,{' '}
        <code>false</code> when no WebSocket server is connected - WebSockets are off (
        <code>[websocket] enabled = false</code>), the code runs under{' '}
        <code>gio export</code> or the test kit&apos;s <code>callRoute</code>, or the worker is
        restarting. A <code>false</code> message is dropped, like one sent to an empty room.{' '}
        <code>true</code> does not mean anyone received it: a room with no members takes the
        message silently.
      </p>
      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          Room membership lives in the Rust server, so a broadcast crosses to it as one frame
          however many sockets it reaches - including sockets handled by other workers of a
          pool.
        </li>
        <li>A socket receives broadcasts only once its <code>wsHandler</code> has accepted it.</li>
        <li>
          Delivery is best-effort, like any WebSocket send: under heavy backpressure messages
          are dropped rather than buffered without bound.
        </li>
      </ul>
      <h3 id="errors">Errors</h3>
      <p>
        An empty or non-string <code>room</code> throws a <code>TypeError</code>; a name over
        256 bytes throws a <code>RangeError</code>.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="a-chat-room">A chat room, with an HTTP publish endpoint</h3>
      <CodeBlock lang="ts" title="app/api/rooms/[room]/route.ts" code={`import { broadcast, type GioRequest, type GioSocket } from '@gio.js/core';

// WebSocket: ws://host/api/rooms/lobby
export function wsHandler(socket: GioSocket) {
  const room = socket.params.room as string;
  socket.join(room);
  socket.on('message', (text) => broadcast(room, String(text), { except: socket.id }));
}

// HTTP: POST /api/rooms/lobby publishes to everyone in the room.
export function POST(req: GioRequest<'/api/rooms/:room'>) {
  const { text } = req.json<{ text: string }>();
  const delivered = broadcast(req.params.room, JSON.stringify({ text, at: Date.now() }));
  return { delivered };
}`} />
      <p>
        With one browser connected to <code>/api/rooms/lobby</code>, a{' '}
        <code>POST</code> of <code>{'{"text":"hello"}'}</code> answers{' '}
        <code>{'{"delivered":true}'}</code> and the socket receives{' '}
        <code>{'{"text":"hello","at":...}'}</code>.
      </p>
      <h3 id="binary-data">Binary data</h3>
      <CodeBlock lang="ts" code={`const frame = new Uint8Array([1, 2, 3]);
broadcast('telemetry', frame);   // a binary frame; clients get a Blob or ArrayBuffer`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Per server process.</strong> Rooms do not span GioJS instances. Behind a
          load balancer, relay messages through a shared bus (Redis, NATS, Postgres{' '}
          <code>LISTEN</code>) and call <code>broadcast</code> on each instance.
        </li>
        <li>
          <strong>Room limits.</strong> A socket can be in up to 100 rooms;{' '}
          <code>socket.join</code> throws beyond that. Rooms disappear when their last member
          leaves.
        </li>
        <li>
          <strong>Not the same as <code>socket.broadcast(data)</code></strong>, which sends to
          every socket connected to the same path, the sender included.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/websockets#rooms">WebSockets: Rooms</a></li>
        <li><a href="/docs/page-exports/ws-handler">wsHandler</a></li>
        <li><a href="/docs/hooks/use-web-socket">useWebSocket</a></li>
        <li><a href="/docs/configuration/websocket">[websocket]</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: <>Introduced, with <code>socket.join</code> / <code>socket.leave</code> rooms.</>,
        },
      ]} />
    </>
  );
}
