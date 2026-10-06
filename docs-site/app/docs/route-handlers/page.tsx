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
      <p>
        <code>json()</code> parses only bodies sent with{' '}
        <code>Content-Type: application/json</code> (or <code>application/*+json</code>). For
        anything else it throws <code>UnsupportedMediaTypeError</code>, which becomes a{' '}
        <code>415 Unsupported Media Type</code> response unless you catch it - a form on
        another site can send <code>text/plain</code> without a CORS preflight, so a handler
        must not treat it as JSON. <code>req.body</code> always holds the raw body:
      </p>
      <CodeBlock lang="ts" code={`import { isUnsupportedMediaTypeError, type GioRequest } from '@gio.js/core';

export function POST(req: GioRequest) {
  try {
    return { saved: req.json<{ text: string }>().text };
  } catch (err) {
    if (!isUnsupportedMediaTypeError(err)) throw err;
    return { saved: new URLSearchParams(req.body ?? '').get('text') };  // form post
  }
}`} />

      <h2>What you can return</h2>
      <ul>
        <li>Any JSON-serializable value - sent as <code>application/json</code> with status 200.</li>
        <li>A web-standard <code>Response</code> - its status, headers, and body pass through. Binary bodies (images, files) are supported.</li>
        <li><code>null</code> / <code>undefined</code> - 204 No Content.</li>
        <li>A <code>GioEventStream</code> (GET only) - switches the connection to SSE.</li>
      </ul>
      <CodeBlock lang="ts" code={`export function DELETE() {
  return new Response('gone', { status: 202, headers: { 'X-Reason': 'cleanup' } });
}`} />

      <h2>Setting cookies</h2>
      <p>
        Append one <code>Set-Cookie</code> per cookie - each is sent as its own header,
        byte-for-byte (cookies are never comma-joined, so <code>Expires</code> dates stay
        intact). Other repeated headers such as <code>Link</code> or{' '}
        <code>WWW-Authenticate</code> are combined into one comma-separated value.
      </p>
      <CodeBlock lang="ts" code={`// app/api/login/route.ts
import type { GioRequest } from '@gio.js/core';

export async function POST(req: GioRequest) {
  const { session, csrf } = await login(req.json());
  const headers = new Headers({ Location: '/dashboard' });
  headers.append('Set-Cookie', \`session=\${session}; Path=/; HttpOnly; Secure; SameSite=Lax\`);
  headers.append('Set-Cookie', \`csrf=\${csrf}; Path=/; Secure; SameSite=Strict\`);
  return new Response(null, { status: 303, headers });
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
        <li>
          When a page and a route.ts in different folders both match a URL, the more specific
          pattern owns it (see Layouts &amp; Pages): <code>app/blog/about/page.tsx</code> wins
          /blog/about over <code>app/blog/[slug]/route.ts</code>, and a route.ts that is more
          specific than a matching page answers every method itself (405 for those it does
          not export).
        </li>
        <li>Pages only answer GET/HEAD - mutations belong in route handlers.</li>
        <li>A thrown error is logged server-side and answered with a JSON 500 (no internals leaked).</li>
        <li>
          Cross-site <code>POST</code>/<code>PUT</code>/<code>PATCH</code>/<code>DELETE</code>{' '}
          requests are refused with 403 before your handler runs (CSRF protection). Webhook
          endpoints called by other sites go in <code>[security.csrf] exempt</code> - see{' '}
          <a href="/docs/security">Security</a>.
        </li>
        <li>Export <code>wsHandler</code> from the same file for WebSockets - see the WebSockets page.</li>
      </ul>
    </>
  );
}
