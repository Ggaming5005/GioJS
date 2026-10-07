import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Route Handlers',
  description: 'API endpoints, Server-Sent Events, and WebSockets with route.ts files.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Route Handlers</h1>
      <p className="page-subtitle">API endpoints, Server-Sent Events, and WebSockets with route.ts files.</p>

      <p>
        A <a href="/docs/file-conventions/route"><code>route.ts</code></a> (or <code>route.js</code>) file turns its folder into a
        server endpoint. Export a function per HTTP method - <code>GET</code>,{' '}
        <code>POST</code>, <code>PUT</code>, <code>PATCH</code>, <code>DELETE</code>:
      </p>
      <CodeBlock lang="ts" title="app/api/notes/[id]/route.ts" code={`import type { GioRequest } from '@gio.js/core';

export async function POST(req: GioRequest<'/api/notes/:id'>) {
  const { text } = req.json<{ text: string }>();
  const user = req.cookies['session'];       // parsed Cookie header
  const id = req.params.id;                  // from the [id] segment: string
  return { saved: text, id };                // → application/json, 200
}`} />
      <p>
        The route pattern in <code>{"GioRequest<'/api/notes/:id'>"}</code> types{' '}
        <code>req.params</code>; it is checked against the routes the server discovered (the
        generated <code>.gio/routes.d.ts</code>), so a typo fails <code>tsc</code>. A params
        shape (<code>{'GioRequest<{ id: string }>'}</code>) works too, and plain{' '}
        <code>GioRequest</code> types them as <code>{'Record<string, string>'}</code> (each one{' '}
        <code>string | undefined</code> under <code>noUncheckedIndexedAccess</code>, which the
        TypeScript starter enables). To type
        the whole handler, use <code>RouteHandler</code> - its return type admits everything
        the server accepts:
      </p>
      <CodeBlock lang="ts" code={`import type { RouteHandler } from '@gio.js/core';

export const GET: RouteHandler<'/api/notes/:id'> = async (req) => {
  const note = await db.notes.find(req.params.id);
  return note ?? new Response('gone', { status: 410 });
};`} />

      <h2 id="the-request-object">The request object</h2>
      <p>
        Handlers receive a <code>GioRequest</code>: <code>method</code>, <code>path</code>,{' '}
        <code>params</code>, <code>query</code>, lowercased <code>headers</code>, parsed{' '}
        <code>cookies</code>, the raw <code>body</code> (<code>bodyBase64</code> is true for
        binary bodies), and the <code>json()</code> and <code>formData()</code> helpers.
      </p>
      <p>
        It also says who is asking: <code>ip</code> is the client&apos;s address,{' '}
        <code>scheme</code> (<code>&apos;https&apos;</code> or <code>&apos;http&apos;</code>) and{' '}
        <code>host</code> are what the client used, and <code>requestId</code> is the
        request&apos;s <code>X-Request-Id</code>, also on every log line for the request.
        Behind a reverse proxy these describe the visitor only when the proxy is listed in{' '}
        <a href="/docs/configuration/server"><code>[server] trusted_proxies</code></a> - otherwise <code>ip</code> is the proxy&apos;s
        address (see <a href="/docs/configuration">Configuration</a>). Use{' '}
        <code>req.ip</code>, never the <code>x-forwarded-for</code> header: any client can
        send that header, while <code>req.ip</code> only honors it from trusted proxies.{' '}
        <code>req.host</code>, on the other hand, is whatever the client sent unless your
        proxy pins it - fine for display, never for a security decision.
      </p>
      <CodeBlock lang="ts" title="app/api/audit/route.ts" code={`import type { GioRequest } from '@gio.js/core';

export async function POST(req: GioRequest) {
  await audit.record({ ip: req.ip, requestId: req.requestId, action: req.json() });
  return { ok: true };
}`} />
      <p>
        <code>json()</code> parses only bodies sent with{' '}
        <code>Content-Type: application/json</code> (or <code>application/*+json</code>). For
        anything else it throws <a href="/docs/functions/request-errors"><code>UnsupportedMediaTypeError</code></a>, which becomes a{' '}
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
      <p>
        <code>await req.formData()</code> is the form counterpart: it parses{' '}
        <code>application/x-www-form-urlencoded</code> and <code>multipart/form-data</code>{' '}
        bodies into a web-standard <code>FormData</code> (file fields are <code>File</code>{' '}
        objects), answers <code>415</code> for any other content type and <code>400</code> for a
        body that does not parse (<code>MalformedBodyError</code>). Bodies are limited by{' '}
        <code>[server] max_body_bytes</code> (413 above it). For forms that post to a page,
        a page <code>action</code> is usually simpler than a route handler - see{' '}
        <a href="/docs/forms">Forms and Mutations</a>.
      </p>

      <h2 id="what-you-can-return">What you can return</h2>
      <ul>
        <li>Any JSON-serializable value - sent as <code>application/json</code> with status 200.</li>
        <li>A web-standard <code>Response</code> - its status, headers, and body pass through. Binary bodies (images, files) are supported, and a <code>ReadableStream</code> body streams (see below).</li>
        <li><code>null</code> / <code>undefined</code> - 204 No Content.</li>
        <li>A <a href="/docs/functions/gio-event-stream"><code>GioEventStream</code></a> (GET only) - switches the connection to SSE.</li>
      </ul>
      <CodeBlock lang="ts" code={`export function DELETE() {
  return new Response('gone', { status: 202, headers: { 'X-Reason': 'cleanup' } });
}`} />

      <h2 id="setting-cookies">Setting cookies</h2>
      <p>
        Append one <code>Set-Cookie</code> per cookie - each is sent as its own header,
        byte-for-byte (cookies are never comma-joined, so <code>Expires</code> dates stay
        intact). Other repeated headers such as <code>Link</code> or{' '}
        <code>WWW-Authenticate</code> are combined into one comma-separated value.
      </p>
      <CodeBlock lang="ts" title="app/api/login/route.ts" code={`import { serializeCookie, type GioRequest } from '@gio.js/core';
import { sessions } from '../../../lib/session.server.ts';

export async function POST(req: GioRequest) {
  const user = await login(req.json());
  const session = sessions.getSession(req);
  session.set('userId', user.id);
  const headers = new Headers({ Location: '/dashboard' });
  headers.append('Set-Cookie', sessions.commitSession(session));
  headers.append('Set-Cookie', serializeCookie('theme', user.theme, { httpOnly: false }));
  return new Response(null, { status: 303, headers });
}`} />
      <p>
        <a href="/docs/functions/cookies"><code>serializeCookie</code></a> applies secure defaults (<code>HttpOnly</code>,{' '}
        <code>SameSite=Lax</code>, <code>Secure</code> in production) and refuses values that
        could inject attributes; sessions are covered in{' '}
        <a href="/docs/authentication">Authentication</a>.
      </p>

      <h2 id="server-sent-events">Server-Sent Events</h2>
      <CodeBlock lang="ts" title="app/ticker/route.ts" code={`import { GioEventStream } from '@gio.js/core';

export function GET() {
  return new GioEventStream((stream) => {
    const t = setInterval(() => stream.send({ time: Date.now() }), 1000);
    return () => clearInterval(t);           // runs when the client disconnects
  });
}`} />

      <h2 id="streaming-responses">Streaming responses</h2>
      <p>
        Return a <code>Response</code> whose body is a <code>ReadableStream</code> and the
        client receives each chunk as you produce it - an LLM token stream, a large export, an
        event stream written by hand:
      </p>
      <CodeBlock lang="ts" title="app/api/chat/route.ts" code={`import type { GioRequest } from '@gio.js/core';

export async function POST(req: GioRequest) {
  const { prompt } = req.json<{ prompt: string }>();
  const tokens = await llm.stream(prompt);           // AsyncIterable<string>
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async pull(controller) {
      const { done, value } = await tokens.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    cancel() {
      tokens.return?.();                            // the client went away
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}`} />
      <CodeBlock lang="ts" code={`// app/api/progress/route.ts - Server-Sent Events from a plain Response
export function GET() {
  let timer: ReturnType<typeof setInterval>;
  const body = new ReadableStream({
    start(controller) {
      let n = 0;
      timer = setInterval(() => controller.enqueue(\`data: \${JSON.stringify({ n: ++n })}\\n\\n\`), 1000);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}`} />
      <ul>
        <li>
          Status, headers and every <code>Set-Cookie</code> go out before the first chunk, so
          they must be final when you return the <code>Response</code>.
        </li>
        <li>
          A body that is already complete when you return it - a string, a buffer, JSON, a
          stream that closes without waiting - and is at most 1 MiB is sent buffered, with a{' '}
          <code>Content-Length</code> (unless it is compressed: a compressed body&apos;s size is
          only known once it is sent, so it goes out chunked). Anything else streams with chunked
          encoding. A{' '}
          <code>text/event-stream</code> body always streams, is never compressed (compression
          would hold events back), and gets <code>Cache-Control: no-cache</code> unless you set
          one.
        </li>
        <li>
          Chunks may be <code>Uint8Array</code> or strings (sent as UTF-8); binary bodies arrive
          byte-for-byte.
        </li>
        <li>
          Backpressure reaches your stream: when the client reads slowly, the server stops
          pulling once about 1 MiB is waiting for it, so a large download never piles up in
          memory. Produce chunks in <code>pull()</code> (as above) to benefit.
        </li>
        <li>
          When the client disconnects, the stream is cancelled - your <code>cancel()</code>{' '}
          runs, so stop timers and upstream requests there.
        </li>
        <li>
          A streamed body has no time limit: it ends when you close the stream or the client
          leaves. When the server shuts down, a <code>text/event-stream</code> body is ended and
          cancelled at once (an <code>EventSource</code> reconnects), so it never holds up a
          deploy. Any other streamed body - a download, an export - is left to finish within the
          8-second shutdown drain; one still running after it has its connection reset, so the
          client sees a failed download, never a short file that looks complete. If your stream
          errors midway, the response ends early (the status is already sent).
        </li>
        <li>
          A streamed <code>text/html</code> body is sent exactly as you write it - an htmx
          fragment or a page without a <code>&lt;head&gt;</code> arrives chunk by chunk. GioJS
          injects its head scripts into page streams only.
        </li>
        <li>
          <code>HEAD</code> requests cancel a streaming body instead of sending it. While a
          plugin with an <code>onResponse</code> hook is installed, bodies are buffered so the
          hook can see them - except event streams, which stream and skip the hook.
        </li>
      </ul>
      <p>
        <code>GioEventStream</code> (above) remains the shortest way to write SSE: it frames
        events for you and runs your cleanup on disconnect. The{' '}
        <a href="/docs/guides/streaming">Streaming</a> guide covers streamed pages and what
        happens to open streams at shutdown.
      </p>

      <h2 id="rules">Rules</h2>
      <ul>
        <li>Handler responses are never cached or coalesced - every request runs your code.</li>
        <li>Requests for methods you didn&apos;t export get <code>405</code> with an <code>Allow</code> header.</li>
        <li>
          A GET without a GET handler falls through to a sibling <code>page.tsx</code> if one
          exists, and so does a POST without a POST handler - to the page&apos;s{' '}
          <code>action</code>.
        </li>
        <li>
          When a page and a route.ts in different folders both match a URL, the more specific
          pattern owns it (see Layouts &amp; Pages): <code>app/blog/about/page.tsx</code> wins
          /blog/about over <code>app/blog/[slug]/route.ts</code>, and a route.ts that is more
          specific than a matching page answers every method itself (405 for those it does
          not export).
        </li>
        <li>
          Pages answer GET/HEAD, and POST when they export an <code>action</code> (see{' '}
          <a href="/docs/forms">Forms and Mutations</a>); PUT/PATCH/DELETE belong in route
          handlers.
        </li>
        <li>A thrown error is logged server-side and answered with a JSON 500 (no internals leaked).</li>
        <li>
          A <code>route.ts</code> that throws while it is imported (a module-scope check, a
          missing <code>GIO_SESSION_SECRET</code>) answers that JSON 500 for every method
          (<code>OPTIONS</code> included), and its URL stays its own - no sibling page or 404
          takes it over. A WebSocket connection to it is closed with <code>1011</code>, not the{' '}
          <code>4404</code> of a path with no <a href="/docs/page-exports/ws-handler"><code>wsHandler</code></a>. The log names the file
          and the error, once at startup and per request under the response&apos;s{' '}
          <code>digest</code>; in development the response carries the error too.
        </li>
        <li>
          Cross-site <code>POST</code>/<code>PUT</code>/<code>PATCH</code>/<code>DELETE</code>{' '}
          requests are refused with 403 before your handler runs (CSRF protection). Endpoints
          other sites post to on purpose - OAuth/OIDC <code>form_post</code> and SAML
          callbacks, payment (3-D Secure) returns, webhooks that send an <code>Origin</code> - go
          in <a href="/docs/configuration/security-csrf"><code>[security.csrf] exempt</code></a> - see <a href="/docs/security">Security</a>.
        </li>
        <li>
          Export <code>wsHandler</code> from the same file for WebSockets (with the same
          dynamic segments), and publish to WebSocket rooms from any handler with{' '}
          <a href="/docs/functions/broadcast"><code>broadcast(room, data)</code></a> - see <a href="/docs/websockets">WebSockets</a>.
        </li>
      </ul>
    </>
  );
}
