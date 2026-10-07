import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'GET, POST, PUT, PATCH, DELETE',
  description:
    'The HTTP method handlers a route.ts exports: what they receive, what they may return, and how each method is answered.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>GET, POST, PUT, PATCH, DELETE</h1>
      <p className="page-subtitle">
        The HTTP method handlers a <code>route.ts</code> exports: what they receive, what they
        may return, and how each method is answered.
      </p>
      <CodeBlock lang="ts" title="app/api/items/[id]/route.ts" code={`import { notFound, type RouteHandler } from '@gio.js/core';
import { db } from '../../../../lib/db.server.ts';

export const GET: RouteHandler<'/api/items/:id'> = async (req) => {
  const item = await db.items.find(req.params.id);
  if (item === null) notFound();                  // {"error":"Not Found"}, 404
  return item;                                    // JSON, 200
};

export const DELETE: RouteHandler<'/api/items/:id'> = async (req) => {
  await db.items.delete(req.params.id);
  return null;                                    // 204
};`} />
      <p>
        A <code>route.ts</code> (or <code>route.js</code>) turns its folder into an endpoint.
        Each named export <code>GET</code>, <code>POST</code>, <code>PUT</code>,{' '}
        <code>PATCH</code> or <code>DELETE</code> that is a function handles that method. They
        can be declared as functions or as constants, sync or async.
      </p>

      <h2 id="reference">Reference</h2>
      <h3 id="parameters">Parameters</h3>
      <p>Each handler receives one <code>{'GioRequest<Route>'}</code>:</p>
      <PropsTable kind="Field" rows={[
        { name: 'method', type: 'string', description: <>The request method. When the <code>GET</code> handler answers a <code>HEAD</code> request, it is <code>&apos;HEAD&apos;</code>.</> },
        { name: 'path', type: 'string', description: 'The routed path, without the query string.' },
        { name: 'params', type: 'ParamsOf<Route>', description: <>The dynamic segments. A catch-all is one <code>/</code>-joined string.</> },
        { name: 'query', type: 'Record<string, string>', description: 'The query string, one value per name: the last one when a name repeats.' },
        { name: 'headers', type: 'Record<string, string>', description: 'The request headers, names lowercase.' },
        { name: 'cookies', type: 'Record<string, string>', description: <>The <code>Cookie</code> header, parsed.</> },
        { name: 'body', type: 'string | null', description: <>The raw body: UTF-8 text, or base64 when <code>bodyBase64</code> is <code>true</code>. <code>null</code> without one.</> },
        { name: 'bodyBase64', type: 'boolean', description: 'Whether body is base64 (a binary upload).' },
        { name: 'json()', type: 'T', description: <>Parses a body sent as <code>application/json</code> or <code>application/*+json</code>. Another content type throws <code>UnsupportedMediaTypeError</code> (<code>415</code> unless caught). An absent or base64 body, or JSON that does not parse, throws a plain error: a <code>500</code> unless you catch it.</> },
        { name: 'formData()', type: 'Promise<FormData>', description: <>Parses <code>application/x-www-form-urlencoded</code> and <code>multipart/form-data</code>; files are <code>File</code> objects. Another content type is a <code>415</code>, a body that does not parse a <code>400</code> (<code>MalformedBodyError</code>).</> },
        { name: 'locale', type: 'string | undefined', description: <>The request locale, with <code>[i18n]</code>.</> },
        { name: 'ip', type: 'string | undefined', description: <>The client&apos;s address; behind a proxy only when it is in <code>[server] trusted_proxies</code>. Never read <code>x-forwarded-for</code> yourself.</> },
        { name: 'scheme, host', type: 'string | undefined', description: <>How the client addressed the server. <code>host</code> is whatever the client sent unless a proxy pins it: fine for display, never for a security decision.</> },
        { name: 'requestId', type: 'string | undefined', description: <>The response&apos;s <code>X-Request-Id</code>, also on every log line.</> },
      ]} />

      <h3 id="returns">Returns</h3>
      <table>
        <thead><tr><th>Return value</th><th>Response</th></tr></thead>
        <tbody>
          <tr><td>A web <code>Response</code></td><td>Its status, headers and body. Binary bodies arrive byte for byte; each <code>Set-Cookie</code> is sent as its own header. Without a <code>Content-Type</code>, <code>text/plain; charset=utf-8</code>. A <code>ReadableStream</code> body streams.</td></tr>
          <tr><td>A <code>GioEventStream</code></td><td>Server-Sent Events (<code>text/event-stream</code>). Meant for <code>GET</code>.</td></tr>
          <tr><td><code>null</code> or <code>undefined</code></td><td><code>204 No Content</code>.</td></tr>
          <tr><td>Any other value</td><td><code>200</code>, the value as JSON (<code>application/json; charset=utf-8</code>).</td></tr>
        </tbody>
      </table>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>HEAD</strong> is answered by the <code>GET</code> handler, without the body.{' '}
          <code>HEAD</code> and <code>OPTIONS</code> cannot be exported: only the five methods
          above are read.
        </li>
        <li>
          <strong>Other methods</strong> answer <code>405</code> with{' '}
          <code>{'{"error":"Method Not Allowed"}'}</code> and an <code>Allow</code> header listing
          what the file exports (plus <code>HEAD</code> when it exports <code>GET</code>).{' '}
          <code>OPTIONS</code> is answered the same way.
        </li>
        <li>
          <strong>A page in the same folder</strong> serves the methods the{' '}
          <code>route.ts</code> does not export: <code>GET</code>/<code>HEAD</code> render the
          page, and <code>POST</code> runs its <a href="/docs/page-exports/action">action</a>. A{' '}
          <code>405</code> from that folder lists both files&apos; methods.
        </li>
        <li>
          <strong>Errors.</strong> <code>notFound()</code> answers <code>404</code>{' '}
          <code>{'{"error":"Not Found"}'}</code>. Any other thrown error answers <code>500</code>{' '}
          <code>{'{"error":"Internal Server Error","digest":"..."}'}</code>; the message and stack
          are logged under the digest, never sent.
        </li>
        <li>
          <strong>A route.ts that throws while it is imported</strong> answers that{' '}
          <code>500</code> for every method, <code>OPTIONS</code> included, and keeps its URL:
          no sibling page or 404 takes over. In development the response carries the import
          error.
        </li>
        <li>
          <strong>Never cached.</strong> Handler responses are not stored or shared between
          requests, and get no default <code>Cache-Control</code> (an event stream gets{' '}
          <code>no-cache</code>). Set one on the <code>Response</code> for browsers and CDNs.
        </li>
        <li>
          <strong>Checks before the handler.</strong> A cross-site <code>POST</code>,{' '}
          <code>PUT</code>, <code>PATCH</code> or <code>DELETE</code> gets <code>403</code> from
          the CSRF check, and a body over <code>[server] max_body_bytes</code> gets{' '}
          <code>413</code>, before your code runs.
        </li>
      </ul>

      <h3 id="types">Types</h3>
      <p>
        <code>RouteHandler</code> (<code>{'RouteHandler<Route>'}</code>) types a whole handler, and{' '}
        <code>GioRequest</code> (<code>{'GioRequest<Route>'}</code>) the request alone.{' '}
        <code>Route</code> is a pattern of your app (<code>{"'/api/items/:id'"}</code>) or a
        params shape (<code>{'{ id: string }'}</code>).
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="create-from-json">Create from JSON</h3>
      <CodeBlock lang="ts" title="app/api/notes/route.ts" code={`import type { GioRequest } from '@gio.js/core';
import { db } from '../../../lib/db.server.ts';

export async function POST(req: GioRequest) {
  const { text } = req.json<{ text: string }>();      // 415 unless sent as JSON
  const note = await db.notes.insert({ text });
  return Response.json(note, { status: 201, headers: { location: \`/api/notes/\${note.id}\` } });
}`} />

      <h3 id="redirect-from-a-handler">Redirect from a handler</h3>
      <p>
        Return a <code>Response</code> with a <code>Location</code> header. A relative URL
        works:
      </p>
      <CodeBlock lang="ts" title="app/api/go/route.ts" code={`export function POST() {
  return new Response(null, { status: 303, headers: { location: '/thanks' } });
}`} />

      <h3 id="server-sent-events">Server-Sent Events</h3>
      <CodeBlock lang="ts" title="app/ticker/route.ts" code={`import { GioEventStream } from '@gio.js/core';

export function GET() {
  return new GioEventStream((stream) => {
    const timer = setInterval(() => stream.send({ time: Date.now() }), 1000);
    return () => clearInterval(timer);            // runs when the client disconnects
  });
}`} />

      <h3 id="set-several-cookies">Set several cookies</h3>
      <CodeBlock lang="ts" title="app/api/prefs/route.ts" code={`import { serializeCookie } from '@gio.js/core';

export function POST() {
  const headers = new Headers();
  headers.append('set-cookie', serializeCookie('theme', 'dark', { httpOnly: false }));
  headers.append('set-cookie', serializeCookie('lang', 'en', { httpOnly: false }));
  return new Response(null, { status: 204, headers });
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <code>redirect()</code> from <code>@gio.js/core</code> is for pages, actions and{' '}
          <code>getServerSideProps</code>. In this release a route handler that returns it
          sends its internal object as JSON with status <code>200</code>, and one that throws
          it answers <code>500</code>: return a <code>Response</code> as above.{' '}
          <code>Response.redirect(&apos;/path&apos;)</code> throws on a relative URL in Node.
        </li>
        <li>
          A redirect answering a <code>&lt;GioForm&gt;</code> submission (a{' '}
          <code>301</code>/<code>302</code>/<code>303</code> to a request with{' '}
          <code>x-gio-form: 1</code>) becomes a <code>204</code> with{' '}
          <code>x-gio-redirect</code>, as it does for page actions.
        </li>
        <li>
          Exporting <code>wsHandler</code> from the same file adds a WebSocket endpoint at the
          same path - see <a href="/docs/page-exports/ws-handler"><code>wsHandler</code></a>.
        </li>
        <li>
          Under <code>gio export</code> route handlers are skipped: a static host has no server
          to run them.
        </li>
        <li>
          CORS is yours to answer: there is no <code>OPTIONS</code> export, so a preflight
          gets <code>405</code>. Add the CORS headers to your responses (or a{' '}
          <code>[[headers]]</code> rule) for simple requests.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/route-handlers">Route Handlers</a> - the guide, with streaming responses</li>
        <li><a href="/docs/file-conventions/route"><code>route.ts</code></a></li>
        <li><a href="/docs/functions/gio-event-stream"><code>GioEventStream</code></a>, <a href="/docs/functions/cookies">cookies</a>, <a href="/docs/functions/request-errors">request body errors</a></li>
        <li><a href="/docs/page-exports/ws-handler"><code>wsHandler</code></a></li>
        <li><a href="/docs/configuration/security-csrf"><code>[security.csrf]</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <><code>notFound()</code> answers a JSON <code>404</code>; <code>req.formData()</code>, <code>req.ip</code>, <code>req.scheme</code>, <code>req.host</code> and <code>req.requestId</code>; <code>json()</code> requires a JSON content type (<code>415</code>); every <code>Set-Cookie</code> of a <code>Response</code> is sent; <code>ReadableStream</code> bodies stream; a <code>route.ts</code> that throws while it is imported answers <code>500</code>; typed with <code>RouteHandler</code>.</> },
        { version: 'v0.1.0-beta.5', changes: 'Introduced: method handlers returning a Response, a GioEventStream, null (204) or JSON, with 405 and Allow for other methods.' },
      ]} />
    </>
  );
}
