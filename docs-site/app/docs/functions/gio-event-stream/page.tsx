import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'GioEventStream',
  description:
    'Answer a route handler with a Server-Sent Events stream: send JSON events until you close it or the client goes away.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>GioEventStream</h1>
      <p className="page-subtitle">
        Answer a route handler with a Server-Sent Events stream: send JSON events until you
        close it or the client goes away.
      </p>
      <CodeBlock lang="ts" title="app/api/ticker/route.ts" code={`import { GioEventStream } from '@gio.js/core';

export function GET() {
  return new GioEventStream((stream) => {
    const timer = setInterval(() => stream.send({ time: Date.now() }), 1000);
    return () => clearInterval(timer);   // runs when the client disconnects
  });
}`} />

      <h2 id="reference">Reference</h2>
      <p>
        <code>new GioEventStream(handler)</code>, returned from a <code>route.ts</code>{' '}
        method handler.
      </p>
      <PropsTable kind="Parameter" rows={[
        {
          name: 'handler',
          type: '(stream: SseStream) => () => void',
          required: true,
          description: (
            <>
              Called once the response has started. It must return - synchronously - a
              cleanup function, which runs when the client disconnects or the server shuts
              the stream down.
            </>
          ),
        },
      ]} />
      <h3 id="sse-stream">SseStream</h3>
      <PropsTable kind="Field" rows={[
        {
          name: 'send(data, event?, id?)',
          type: 'void',
          description: (
            <>
              Writes one event. <code>data</code> is always passed through{' '}
              <code>JSON.stringify</code> - a string arrives quoted - so it fits on one{' '}
              <code>data:</code> line. <code>event</code> sets the event name and{' '}
              <code>id</code> the event id; line breaks are stripped from both.
            </>
          ),
        },
        {
          name: 'close()',
          type: 'void',
          description: <>Ends the response. The cleanup function does not run after it.</>,
        },
      ]} />
      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The response is <code>200</code> with <code>Content-Type: text/event-stream</code>{' '}
          and <code>Cache-Control: no-cache</code>, sent before the handler runs. It is never
          cached, and it stays open until you call <code>close()</code>, the client
          disconnects, or the server shuts down.
        </li>
        <li>
          Each <code>send</code> becomes <code>{'id: <id>\\nevent: <event>\\ndata: <json>\\n\\n'}</code>{' '}
          on the wire (the <code>id</code> and <code>event</code> lines only when given).
        </li>
        <li>
          When the handler throws, the error is logged (<code>sse handler threw</code>) and the
          stream ends - its <code>200</code> is already sent.
        </li>
        <li>
          Under backpressure from a slow server connection, events may be dropped rather than
          buffered without bound (a warning is logged).
        </li>
        <li>
          On shutdown the server ends open event streams instead of waiting for them, so
          they never hold up a deploy.
        </li>
      </ul>

      <h2 id="isgioeventstream">isGioEventStream</h2>
      <CodeBlock lang="ts" code={`isGioEventStream(value: unknown): value is GioEventStream`} />
      <p>
        <code>isGioEventStream()</code> tells whether a value is a{' '}
        <code>GioEventStream</code> - from any copy of <code>@gio.js/core</code>. Route modules
        load in their own module namespace, so <code>instanceof</code> can fail across that
        boundary; the check uses a brand (<code>__gioSse</code>) and the presence of a handler
        function. Use it in plugins or wrappers that pass handler results through.
      </p>
      <CodeBlock lang="ts" code={`import { isGioEventStream } from '@gio.js/core';

function withTiming<T>(handler: () => Promise<T> | T) {
  return async () => {
    const started = Date.now();
    const result = await handler();
    if (!isGioEventStream(result)) console.log('handled in', Date.now() - started, 'ms');
    return result;
  };
}`} />

      <h2 id="examples">Examples</h2>
      <h3 id="named-events-with-ids">Named events with ids, closed by the server</h3>
      <CodeBlock lang="ts" title="app/api/clock/route.ts" code={`import { GioEventStream } from '@gio.js/core';

export function GET() {
  return new GioEventStream((stream) => {
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      stream.send({ n, time: new Date().toISOString() }, 'tick', String(n));
      if (n === 3) {
        clearInterval(timer);   // close() does not call the cleanup
        stream.close();
      }
    }, 200);
    return () => clearInterval(timer);
  });
}`} />
      <CodeBlock lang="text" code={`id: 1
event: tick
data: {"n":1,"time":"2026-10-07T15:19:19.008Z"}

id: 2
event: tick
data: {"n":2,"time":"2026-10-07T15:19:19.209Z"}

id: 3
event: tick
data: {"n":3,"time":"2026-10-07T15:19:19.409Z"}`} />
      <h3 id="read-it-in-the-browser">Read it in the browser</h3>
      <CodeBlock lang="tsx" code={`useEffect(() => {
  const source = new EventSource('/api/clock');
  source.addEventListener('tick', (event) => {
    const { n } = JSON.parse(event.data);   // data is always JSON
    setCount(n);
  });
  return () => source.close();
}, []);`} />
      <p>
        Events sent without a name arrive at <code>source.onmessage</code>. An{' '}
        <code>EventSource</code> reconnects on its own after the stream ends; call{' '}
        <code>source.close()</code> when you do not want it to.
      </p>
      <h3 id="test-it">Test it</h3>
      <CodeBlock lang="ts" code={`import { callRoute } from '@gio.js/core/testing';

const res = await callRoute('/api/clock');
expect(await res.text()).toContain('event: tick');   // waits for close()`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Keep the handler synchronous.</strong> An <code>async</code> handler returns
          a promise instead of the cleanup function, so the cleanup never runs. Start async
          work inside it and return the cleanup right away.
        </li>
        <li>
          <strong>Clean up before <code>close()</code>.</strong> Calling{' '}
          <code>close()</code> forgets the cleanup function, so stop timers and subscriptions
          yourself first.
        </li>
        <li>
          <strong>Open streams hold connections.</strong> Each one counts toward{' '}
          <code>[server] max_connections</code>.
        </li>
        <li>
          <strong>Need full control of the wire format?</strong> Return a{' '}
          <code>Response</code> with a <code>ReadableStream</code> body and{' '}
          <code>Content-Type: text/event-stream</code> instead - it streams chunk by chunk
          too (see <a href="/docs/route-handlers#streaming-responses">Streaming responses</a>).
        </li>
        <li>
          <strong>Static export</strong> skips route handlers, so event streams need the
          server.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/route-handlers#server-sent-events">Route Handlers: Server-Sent Events</a></li>
        <li><a href="/docs/guides/streaming">Streaming</a></li>
        <li><a href="/docs/functions/call-route#event-streams">callRoute: event streams</a></li>
        <li><a href="/docs/functions/broadcast">broadcast</a> - for two-way messaging over WebSockets</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.6', changes: <><code>import {'{ GioEventStream, isGioEventStream }'} from &apos;@gio.js/core&apos;</code> works: the package got a public entry point.</> },
        { version: 'v0.1.0-beta.5', changes: <><code>route.ts</code> method handlers can return a <code>GioEventStream</code>; detection is brand-based.</> },
        { version: 'v0.1.0-beta.1', changes: 'Introduced.' },
      ]} />
    </>
  );
}
