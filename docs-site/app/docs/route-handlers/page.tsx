import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Route Handlers</h1>
      <p className="page-subtitle">API endpoints, Server-Sent Events, and WebSockets with route.ts files.</p>

      <p>
        A <code>route.ts</code> (or <code>route.js</code>) file turns its folder into a
        server endpoint. Export a function per HTTP method - <code>GET</code>,{' '}
        <code>POST</code>, <code>PUT</code>, <code>PATCH</code>, <code>DELETE</code>:
      </p>
      <CodeBlock lang="ts" code={`// app/api/notes/[id]/route.ts
import type { GioRequest } from '@gio.js/core';

export async function POST(req: GioRequest) {
  const { text } = req.json<{ text: string }>();
  const user = req.cookies['session'];       // parsed Cookie header
  const id = req.params['id'];               // from the [id] segment
  return { saved: text, id };                // → application/json, 200
}`} />

      <h2>The request object</h2>
      <p>
        Handlers receive a <code>GioRequest</code>: <code>method</code>, <code>path</code>,{' '}
        <code>params</code>, <code>query</code>, lowercased <code>headers</code>, parsed{' '}
        <code>cookies</code>, the raw <code>body</code> (<code>bodyBase64</code> is true for
        binary bodies), and a <code>json()</code> helper.
      </p>

      <h2>What you can return</h2>
      <ul>
        <li>Any JSON-serializable value - sent as <code>application/json</code> with status 200.</li>
        <li>A web-standard <code>Response</code> - its status, headers, and body pass through.</li>
        <li><code>null</code> / <code>undefined</code> - 204 No Content.</li>
        <li>A <code>GioEventStream</code> (GET only) - switches the connection to SSE.</li>
      </ul>
      <CodeBlock lang="ts" code={`export function DELETE() {
  return new Response('gone', { status: 202, headers: { 'X-Reason': 'cleanup' } });
}`} />

      <h2>Server-Sent Events</h2>
      <CodeBlock lang="ts" code={`// app/ticker/route.ts
import { GioEventStream } from '@gio.js/core';

export function GET() {
  return new GioEventStream((stream) => {
    const t = setInterval(() => stream.send({ time: Date.now() }), 1000);
    return () => clearInterval(t);           // runs when the client disconnects
  });
}`} />

      <h2>Rules</h2>
      <ul>
        <li>Handler responses are never cached or coalesced - every request runs your code.</li>
        <li>Requests for methods you didn&apos;t export get <code>405</code> with an <code>Allow</code> header.</li>
        <li>A GET without a GET handler falls through to a sibling <code>page.tsx</code> if one exists.</li>
        <li>Pages only answer GET/HEAD - mutations belong in route handlers.</li>
        <li>A thrown error is logged server-side and answered with a JSON 500 (no internals leaked).</li>
        <li>Export <code>wsHandler</code> from the same file for WebSockets - see the WebSockets page.</li>
      </ul>
    </>
  );
}
