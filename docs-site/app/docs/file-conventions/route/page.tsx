import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'route.ts',
  description:
    'A file whose exported GET, POST, PUT, PATCH and DELETE functions answer HTTP requests to its folder\'s URL, plus an optional WebSocket handler.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>route.ts</h1>
      <p className="page-subtitle">
        A file whose exported <code>GET</code>, <code>POST</code>, <code>PUT</code>,{' '}
        <code>PATCH</code> and <code>DELETE</code> functions answer HTTP requests to its
        folder&apos;s URL, plus an optional WebSocket handler.
      </p>
      <CodeBlock lang="ts" title="app/api/posts/route.ts" code={`import type { GioRequest } from '@gio.js/core';

export function GET(req: GioRequest) {
  return { posts: [], page: req.query.page ?? '1' };
}

export async function POST(req: GioRequest) {
  const { title } = req.json<{ title: string }>();
  return Response.json({ created: title }, { status: 201 });
}`} />

      <h2 id="reference">Reference</h2>
      <h3 id="file-name-and-location">File name and location</h3>
      <p>
        <code>route.ts</code> or <code>route.js</code> (<code>.ts</code> wins when both
        exist), in <code>app/</code> or any folder below it except{' '}
        <a href="/docs/file-conventions/private-folders">private folders</a>. Its URL comes
        from the folder path like a <a href="/docs/file-conventions/page">page</a>&apos;s,{' '}
        <a href="/docs/file-conventions/dynamic-routes">dynamic segments</a> and{' '}
        <a href="/docs/file-conventions/route-groups">route groups</a> included:{' '}
        <code>app/api/items/[id]/route.ts</code> answers <code>/api/items/:id</code>.
      </p>

      <h3 id="exports">Exports</h3>
      <PropsTable kind="Field" rows={[
        { name: 'GET', type: '(req: GioRequest) => unknown', description: <>Answers <code>GET</code>, and <code>HEAD</code> (the body is dropped). May return a <a href="/docs/functions/gio-event-stream"><code>GioEventStream</code></a> to send Server-Sent Events.</> },
        { name: 'POST', type: '(req: GioRequest) => unknown', description: <>Answers <code>POST</code>.</> },
        { name: 'PUT', type: '(req: GioRequest) => unknown', description: <>Answers <code>PUT</code>.</> },
        { name: 'PATCH', type: '(req: GioRequest) => unknown', description: <>Answers <code>PATCH</code>.</> },
        { name: 'DELETE', type: '(req: GioRequest) => unknown', description: <>Answers <code>DELETE</code>.</> },
        { name: 'wsHandler', type: '(socket: GioSocket) => void | boolean | Promise<void | boolean>', description: <>Accepts WebSocket connections to the same URL. See <a href="/docs/page-exports/ws-handler"><code>wsHandler</code></a>.</> },
      ]} />
      <p>
        Handlers may be <code>async</code>. Type one for its route with{' '}
        <code>{'RouteHandler<\'/api/items/:id\'>'}</code>, which types <code>req.params</code>.
        Other exports are ignored. The request object and everything a handler can return are
        described on <a href="/docs/page-exports/http-methods">HTTP methods</a>.
      </p>

      <h3 id="return-values">Return values</h3>
      <table>
        <thead><tr><th>The handler returns</th><th>The response</th></tr></thead>
        <tbody>
          <tr><td>A <code>Response</code></td><td>Sent as it is: status, headers, body (a <code>ReadableStream</code> body streams). Without a <code>Content-Type</code> it gets <code>text/plain</code>.</td></tr>
          <tr><td>A <code>GioEventStream</code> (<code>GET</code> only)</td><td>A <code>text/event-stream</code> connection.</td></tr>
          <tr><td><code>null</code> or <code>undefined</code></td><td><code>204</code> with no body.</td></tr>
          <tr><td>Any other value</td><td><code>200</code>, <code>application/json; charset=utf-8</code>, the value as JSON. A string becomes a JSON string (<code>&quot;hello&quot;</code>).</td></tr>
        </tbody>
      </table>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>Other methods.</strong> A method the file does not export gets{' '}
          <code>405</code>, <code>{'{"error":"Method Not Allowed"}'}</code> and an{' '}
          <code>Allow</code> header listing what it does export (with <code>HEAD</code> when{' '}
          <code>GET</code> is there). <code>OPTIONS</code> cannot be exported and gets the same{' '}
          <code>405</code>.
        </li>
        <li>
          <strong>Errors.</strong> <code>notFound()</code> answers <code>404</code>{' '}
          <code>{'{"error":"Not Found"}'}</code>. <code>req.json()</code> or{' '}
          <code>req.formData()</code> on a body sent with another content type answers{' '}
          <code>415</code>, and a form body that does not parse <code>400</code>. A JSON body
          that does not parse makes <code>req.json()</code> throw a <code>SyntaxError</code>:
          catch it to answer <code>400</code> yourself. Any other thrown error answers{' '}
          <code>500</code>{' '}
          <code>{'{"error":"Internal Server Error","digest":"..."}'}</code>, with the details in
          the log under that digest.
        </li>
        <li>
          <strong>Never cached.</strong> Handler responses are not stored or coalesced, and
          GioJS adds no <code>Cache-Control</code> to them: set your own when you want one.
        </li>
        <li>
          <strong>Before your code runs</strong>, the Rust server applies guards, redirects,
          rewrites, rate limits, CSRF protection (a cross-site <code>POST</code>,{' '}
          <code>PUT</code>, <code>PATCH</code> or <code>DELETE</code> gets <code>403</code>)
          and the body limit (<code>[server] max_body_bytes</code>, 2 MiB by default).
        </li>
        <li>
          <strong>Import errors.</strong> A <code>route.ts</code> that throws while it is
          imported answers <code>500</code> to every method, and closes WebSocket connections
          with <code>1011</code>, until it is fixed. <code>gio routes</code> marks it{' '}
          <code>(failed to load)</code>.
        </li>
      </ul>

      <h3 id="next-to-a-page">Next to a page</h3>
      <p>
        A <code>route.ts</code> may sit in the same folder as a <code>page.tsx</code>. The
        file answers the methods it exports; the page answers <code>GET</code> and{' '}
        <code>HEAD</code> (and <code>POST</code> with an <code>action</code>) unless the{' '}
        <code>route.ts</code> exports them too. A page and a <code>route.ts</code> in{' '}
        <em>different</em> folders that answer the same URLs (for example in two route
        groups) stop startup with an error naming both files.
      </p>

      <h3 id="matching">Matching</h3>
      <p>
        Pages and <code>route.ts</code> files are matched together, the most specific pattern
        winning segment by segment (see{' '}
        <a href="/docs/file-conventions/dynamic-routes#matching-order">matching order</a>). So
        a catch-all <code>app/api/[...path]/route.ts</code> never takes a URL that a more
        specific page or <code>route.ts</code> answers.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="a-dynamic-route-handler">A dynamic route handler</h3>
      <CodeBlock lang="ts" title="app/api/items/[id]/route.ts" code={`import { notFound } from '@gio.js/core';
import type { RouteHandler } from '@gio.js/core';
import { db } from '../../../../lib/db';

export const GET: RouteHandler<'/api/items/:id'> = async (req) => {
  const item = await db.items.find(req.params.id);
  if (item === undefined) notFound();
  return item;
};

export const DELETE: RouteHandler<'/api/items/:id'> = async (req) => {
  await db.items.remove(req.params.id);
  return null; // 204
};`} />

      <h3 id="reject-a-malformed-json-body">Reject a malformed JSON body</h3>
      <CodeBlock lang="ts" title="app/api/comments/route.ts" code={`import { isUnsupportedMediaTypeError } from '@gio.js/core';
import type { GioRequest } from '@gio.js/core';

export function POST(req: GioRequest) {
  let input: unknown;
  try {
    input = req.json();
  } catch (error) {
    if (isUnsupportedMediaTypeError(error)) throw error; // GioJS answers 415
    // A body that is not JSON, or no body at all.
    return Response.json({ error: 'send a JSON body' }, { status: 400 });
  }
  const text = (input as { text?: unknown } | null)?.text;
  if (typeof text !== 'string') {
    return Response.json({ error: 'text is required' }, { status: 422 });
  }
  return Response.json({ saved: text }, { status: 201 });
}`} />

      <h3 id="a-response-with-headers">A response with its own headers</h3>
      <CodeBlock lang="ts" title="app/api/export/route.ts" code={`export function GET() {
  const csv = 'id,name\\n1,Ada\\n';
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="users.csv"',
      'cache-control': 'private, max-age=60',
    },
  });
}`} />

      <h3 id="a-webhook-from-another-site">A webhook another site posts to</h3>
      <p>
        Server-to-server webhooks carry no browser headers, so CSRF protection lets them
        through. An endpoint that browsers on other sites post to on purpose (an OAuth{' '}
        <code>form_post</code> callback) must be listed in{' '}
        <a href="/docs/configuration/security-csrf"><code>[security.csrf] exempt</code></a>.
      </p>
      <CodeBlock lang="ts" title="app/api/webhooks/stripe/route.ts" code={`import type { GioRequest } from '@gio.js/core';
import { verifyStripeSignature } from '../../../../lib/stripe';

export async function POST(req: GioRequest) {
  const signature = req.headers['stripe-signature'];
  if (signature === undefined || req.body === null || !verifyStripeSignature(req.body, signature)) {
    return new Response('bad signature', { status: 400 });
  }
  // ... handle the event
  return null;
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          There is no <code>route.tsx</code>: a route file returns data, not JSX.
        </li>
        <li>
          Unlike Next.js, the handler gets a <code>GioRequest</code> (with <code>params</code>,{' '}
          <code>query</code>, lowercased <code>headers</code>, <code>cookies</code> and the
          body), not a web <code>Request</code>, and it may return plain values. Headers are
          lowercased.
        </li>
        <li>
          <code>export const revalidate</code> and other page exports do nothing in a{' '}
          <code>route.ts</code>.
        </li>
        <li>
          <code>route.ts</code> files are imported once at startup, and their methods are read
          then. In development a change restarts the worker, which imports them again.
        </li>
        <li>
          <code>gio export</code> skips route handlers: a static site has no server to run
          them.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/route-handlers">Route Handlers</a> - the guide (request object, cookies, SSE, streaming).</li>
        <li><a href="/docs/page-exports/http-methods">HTTP methods</a> and <a href="/docs/page-exports/ws-handler"><code>wsHandler</code></a></li>
        <li><a href="/docs/functions/request-errors">Request errors</a>, <a href="/docs/functions/not-found"><code>notFound</code></a></li>
        <li><a href="/docs/websockets">WebSockets</a>, <a href="/docs/file-conventions/page">page.tsx</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Matched with pages by one precedence rule. A file that throws while it is imported answers <code>500</code>. <code>notFound()</code> answers a JSON <code>404</code>. <code>req.json()</code> requires a JSON content type (<code>415</code>). <code>RouteHandler</code> type. WebSocket handlers in dynamic folders.</> },
        { version: 'v0.1.0-beta.5', changes: <>HTTP method handlers (<code>GET</code>, <code>POST</code>, <code>PUT</code>, <code>PATCH</code>, <code>DELETE</code>), <code>405</code> with <code>Allow</code>, SSE from <code>GET</code>.</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced for <code>wsHandler</code> exports; <code>route.ts</code> or <code>route.js</code>.</> },
      ]} />
    </>
  );
}
