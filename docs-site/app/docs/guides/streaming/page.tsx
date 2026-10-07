import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'Streaming',
  description:
    'Send the first bytes of a page before all of it is ready: loading.tsx and Suspense, ' +
    'cached PPR shells, streamed route handler bodies and Server-Sent Events.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Streaming</h1>
      <p className="page-subtitle">
        Send the first bytes of a page before all of it is ready: <code>loading.tsx</code> and
        Suspense, cached PPR shells, streamed route handler bodies and Server-Sent Events.
      </p>

      <p>
        Streaming lets the browser start painting while the slow parts of a response are
        still being produced. GioJS streams in four places, all through the same Rust server,
        which forwards each chunk the moment the Node worker writes it:
      </p>
      <table>
        <thead>
          <tr><th>What</th><th>How you opt in</th><th>Section</th></tr>
        </thead>
        <tbody>
          <tr><td>A page that suspends</td><td><code>loading.tsx</code> or <code>&lt;Suspense&gt;</code> on a page without <code>revalidate</code></td><td><a href="#streaming-pages">Streaming pages</a></td></tr>
          <tr><td>A cached page with personal parts</td><td><code>export const shell = &apos;cache&apos;</code> next to <code>revalidate</code></td><td><a href="#partial-prerendering">Partial prerendering</a></td></tr>
          <tr><td>A route handler body</td><td>Return a <code>Response</code> with a <code>ReadableStream</code></td><td><a href="#streaming-route-handlers">Streaming route handlers</a></td></tr>
          <tr><td>A live feed</td><td>Return a <code>GioEventStream</code></td><td><a href="#server-sent-events">Server-Sent Events</a></td></tr>
        </tbody>
      </table>

      <h2 id="streaming-pages">Streaming pages</h2>
      <p>
        A page renders with React&apos;s streaming renderer. When a component suspends - it
        reads a pending promise with <code>use()</code>, or is a <code>React.lazy</code>{' '}
        component still loading - React sends everything around it at once with the nearest
        Suspense fallback in its place, and streams the real content into the same response
        when it is ready. The browser shows the fallback, then swaps the content in without
        a request of its own.
      </p>
      <p>Whether a page response streams depends on whether it can be shared:</p>
      <ul>
        <li>
          <strong>Pages without <code>revalidate</code></strong> (and personalized pages,
          which are never cached) stream: chunked, <code>Cache-Control: private, no-cache</code>,{' '}
          <code>X-Gio-Cache: bypass</code>.
        </li>
        <li>
          <strong>Pages with <code>revalidate</code></strong> render completely before anything
          is sent, so the whole page can be stored in the page cache and served with a{' '}
          <code>Content-Length</code>. Suspense still works there; it just resolves on the
          server first. To stream a cached page, use{' '}
          <a href="#partial-prerendering">partial prerendering</a>.
        </li>
        <li>
          <code>HEAD</code> requests, <a href="/docs/static-export">static export</a>, and a
          server with a Node plugin that has an <code>onResponse</code> hook (it needs the
          whole body) render completely too.
        </li>
      </ul>

      <h3 id="page-level-streaming-with-loading-tsx">Page-level streaming with loading.tsx</h3>
      <p>
        A <a href="/docs/file-conventions/loading"><code>loading.tsx</code></a> wraps everything
        below its folder in a Suspense boundary. While the page suspends, the layouts above
        the folder and the loading UI are sent at once:
      </p>
      <CodeBlock lang="tsx" title="app/dashboard/loading.tsx" code={`export default function Loading() {
  return <p>Loading dashboard…</p>;
}`} />
      <CodeBlock lang="tsx" title="app/dashboard/page.tsx" code={`import React, { use } from 'react';
import { cached, loadStats } from '../../lib/stats';

export default function Dashboard(): React.JSX.Element {
  // Suspends the whole page: dashboard/loading.tsx shows until it resolves.
  const stats = use(cached('stats', loadStats));
  return (
    <main>
      <h1>Dashboard</h1>
      <p>{stats.orders} orders today</p>
    </main>
  );
}`} />
      <CodeBlock lang="ts" title="lib/stats.ts" code={`export interface Stats { orders: number }

export async function loadStats(): Promise<Stats> {
  const res = await fetch('https://api.example.com/stats');
  return res.json();
}

// One promise per key for a few seconds. When a component suspends in the
// browser, React renders again from its Suspense boundary and must get the
// same promise back - a new one every render would suspend forever.
const pending = new Map<string, Promise<unknown>>();
export function cached<T>(key: string, load: () => Promise<T>, ttlMs = 5000): Promise<T> {
  let promise = pending.get(key) as Promise<T> | undefined;
  if (promise === undefined) {
    promise = load();
    pending.set(key, promise);
    setTimeout(() => pending.delete(key), ttlMs);
  }
  return promise;
}`} />
      <div className="callout warning">
        A component that creates a new promise on every render and reads it with{' '}
        <code>use()</code> inside the same Suspense boundary streams fine from the server, but
        never hydrates in the browser: each retry creates a new promise and suspends again.
        Either cache the promise (as above), or create it in a component{' '}
        <em>above</em> the boundary and pass it down (next section). The cache lives in the
        worker&apos;s memory and is shared by every request, so key it by everything the data
        depends on and never put one visitor&apos;s data in it.
      </div>
      <p>
        <code>getServerSideProps</code> runs before rendering starts, so the loading UI does not
        cover it: if your slow work is there, the page waits for it before the first byte. Move
        slow, non-essential reads into the component tree to stream them.
      </p>

      <h3 id="granular-streaming-with-suspense">Granular streaming with Suspense</h3>
      <p>
        Wrap only the slow part in your own <code>&lt;Suspense&gt;</code> and the rest of the
        page goes out with the first chunk. Start the work in the page and read it in a child
        inside the boundary - the page itself never suspends, so the promise is created once:
      </p>
      <CodeBlock lang="tsx" title="app/orders/page.tsx" code={`import React, { Suspense, use } from 'react';
import { loadActivity } from '../../lib/activity';

export default function Orders(): React.JSX.Element {
  const activity = loadActivity(); // started now, read below
  return (
    <main>
      <h1>Orders</h1>
      <Suspense fallback={<p>Loading activity…</p>}>
        <Activity items={activity} />
      </Suspense>
    </main>
  );
}

function Activity({ items }: { items: Promise<string[]> }): React.JSX.Element {
  const list = use(items);
  return <ul>{list.map((item) => <li key={item}>{item}</li>)}</ul>;
}`} />
      <p>
        Sibling boundaries stream independently, each as soon as its data arrives; nested
        boundaries reveal detail step by step. Every boundary the server could not finish
        before the response ended is finished by React in the browser.
      </p>

      <h3 id="data-in-the-browser">Data in the browser</h3>
      <p>
        GioJS has no React Server Components: every page is server-rendered and then
        hydrated, so a component that suspends runs again in the browser during hydration.
        The data function it calls must work there too - a <code>fetch</code> to a public API
        or to one of your own <a href="/docs/route-handlers">route handlers</a>, not a database
        client. Only <code>GIO_PUBLIC_*</code> variables exist in the browser, so build such
        URLs from one of those. Data that must stay on the server belongs in{' '}
        <a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a>,
        which runs only there.
      </p>

      <h3 id="status-codes-and-errors">Status codes and errors</h3>
      <p>
        The status code and headers go out with the first chunk, so they are decided by what
        happened before the first suspension:
      </p>
      <ul>
        <li>
          A page that throws, or calls <a href="/docs/functions/not-found"><code>notFound()</code></a>,
          before it suspends still answers <code>500</code> or <code>404</code> with the nearest{' '}
          <a href="/docs/file-conventions/error"><code>error.tsx</code></a> or <a href="/docs/file-conventions/not-found"><code>not-found.tsx</code></a>.
        </li>
        <li>
          After it has suspended the <code>200</code> is on its way. A later error is handled
          like in any Suspense boundary: React renders that segment in the browser, and if it
          fails there too, the nearest <code>error.tsx</code> boundary shows it. Production
          responses carry only a digest (<code>data-dgst</code>), never the message.
        </li>
        <li>
          A <a href="/docs/functions/redirect"><code>redirect()</code></a> from{' '}
          <code>getServerSideProps</code> runs before rendering, so it is a real redirect - except
          on a cached PPR shell, which was sent first (see{' '}
          <a href="#partial-prerendering">below</a>).
        </li>
      </ul>
      <p>
        See <a href="/docs/error-handling#streaming-and-loadingtsx">Error Handling</a> for the
        details.
      </p>

      <h2 id="partial-prerendering">Partial prerendering</h2>
      <p>
        A cached page is fast but the same for everyone; a streamed page is personal but
        renders on every request. Partial prerendering (PPR) combines them: everything before
        the first pending Suspense boundary - the <em>shell</em> - is stored in the page cache
        and sent instantly, and the Suspense content (the <em>holes</em>) renders per request
        and streams in behind it. Opt in with{' '}
        <a href="/docs/page-exports/shell"><code>shell = &apos;cache&apos;</code></a> next to{' '}
        <code>revalidate</code>:
      </p>
      <CodeBlock lang="tsx" title="app/storefront/page.tsx" code={`import React, { Suspense, use } from 'react';
import type { GsspContext } from '@gio.js/core';
import { cartFor, type CartItem } from '../../lib/cart';

export const revalidate = 60;
export const shell = 'cache';

export async function getServerSideProps(ctx: GsspContext) {
  // Runs for every request, with that visitor's cookies.
  return { props: { who: ctx.cookies['who'] ?? 'guest' } };
}

export default function Storefront({ who }: { who: string }): React.JSX.Element {
  const cart = cartFor(who);
  return (
    <main>
      <h1>Storefront</h1>{/* shell: cached, the same for everyone */}
      <Suspense fallback={<p>Loading your cart…</p>}>
        <Cart cart={cart} />{/* hole: rendered per request */}
      </Suspense>
    </main>
  );
}

function Cart({ cart }: { cart: Promise<CartItem[]> }): React.JSX.Element {
  const items = use(cart);
  return <p>{items.length} items in your cart</p>;
}`} />
      <p>
        The shell must render the same bytes for every visitor; only content inside a
        boundary that actually suspends may depend on the visitor. A <code>loading.tsx</code>{' '}
        is a shell edge too. Responses say what happened in <code>X-Gio-Cache</code>:{' '}
        <code>ppr; shell=stored</code>, <code>ppr; shell=hit</code> or{' '}
        <code>ppr; shell=stale; ...</code>. The contract, what is checked before a shell is
        stored, and how a per-visitor redirect reaches a visitor after the shell was sent
        are in <a href="/docs/caching-layers#partial-prerendering-ppr">Caching Layers</a>.
      </p>

      <h2 id="streaming-route-handlers">Streaming route handlers</h2>
      <p>
        A <a href="/docs/file-conventions/route"><code>route.ts</code></a> handler that returns
        a <code>Response</code> whose body is a <code>ReadableStream</code> streams it chunk by
        chunk: model output token by token, a large export, a generated file. Produce chunks in{' '}
        <code>pull()</code> so a slow client slows the producer down, and stop in{' '}
        <code>cancel()</code>:
      </p>
      <CodeBlock lang="ts" title="app/api/report/route.ts" code={`// A CSV export written row by row: the client starts receiving it at once.
async function* rows(): AsyncGenerator<string> {
  yield 'id,total\\n';
  for (let id = 1; id <= 5; id++) {
    await new Promise((resolve) => setTimeout(resolve, 300)); // a database page
    yield \`\${id},\${id * 10}\\n\`;
  }
}

export function GET(): Response {
  const source = rows();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await source.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await source.return(undefined); // the client went away: stop reading
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="report.csv"',
    },
  });
}`} />
      <CodeBlock lang="bash" code={`$ curl -N http://localhost:3000/api/report     # rows arrive 300 ms apart
id,total
1,10
2,20
...`} />
      <ul>
        <li>
          Status, headers and every <code>Set-Cookie</code> are sent before the first chunk,
          so they must be final when you return the <code>Response</code>.
        </li>
        <li>
          A body that is already complete and at most 1 MiB is sent buffered, with a{' '}
          <code>Content-Length</code>; anything else streams with chunked encoding.
        </li>
        <li>
          When the client stops reading, the server stops pulling once about 1 MiB is waiting
          for it, so a large download never piles up in memory.
        </li>
        <li>
          A streamed route body has no idle limit: it ends when you close the stream or the
          client leaves. The handler must still return its <code>Response</code> within{' '}
          <code>[server] render_timeout_secs</code> (30 seconds).
        </li>
        <li>
          A <code>text/html</code> body is passed through as written: GioJS injects its head
          scripts into page renders only.
        </li>
      </ul>
      <p>
        More in <a href="/docs/route-handlers#streaming-responses">Route Handlers</a>.
      </p>

      <h2 id="server-sent-events">Server-Sent Events</h2>
      <p>
        <a href="/docs/functions/gio-event-stream"><code>GioEventStream</code></a> from{' '}
        <code>@gio.js/core</code> is the shortest way to push events to a browser. Its
        callback gets a <code>stream</code> with <code>send(data, event?, id?)</code> and{' '}
        <code>close()</code>, and returns a cleanup function that runs when the client
        disconnects:
      </p>
      <CodeBlock lang="ts" title="app/api/ticker/route.ts" code={`import { GioEventStream } from '@gio.js/core';

export function GET(): GioEventStream {
  return new GioEventStream((stream) => {
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      stream.send({ n, at: Date.now() }, 'tick', String(n));
    }, 1000);
    return () => clearInterval(timer); // the client disconnected
  });
}`} />
      <CodeBlock lang="text" code={`$ curl -N http://localhost:3000/api/ticker
id: 1
event: tick
data: {"n":1,"at":1791392165346}

id: 2
...`} />
      <CodeBlock lang="tsx" title="components/Ticker.tsx" code={`import React, { useEffect, useState } from 'react';

export function Ticker(): React.JSX.Element {
  const [n, setN] = useState(0);
  useEffect(() => {
    const source = new EventSource('/api/ticker');
    source.addEventListener('tick', (event) => setN(JSON.parse(event.data).n));
    return () => source.close();
  }, []);
  return <p>{n} ticks</p>;
}`} />
      <ul>
        <li>
          <code>data</code> is sent as JSON on one <code>data:</code> line; line breaks in{' '}
          <code>event</code> and <code>id</code> are stripped, so neither can inject fields.
        </li>
        <li>
          Event streams are never compressed (that would hold events back), get{' '}
          <code>Cache-Control: no-cache</code>, and are not bounded by{' '}
          <code>render_timeout_secs</code>.
        </li>
        <li>
          <code>send()</code> does not wait for the client. While more than 8 MiB is waiting
          to reach the server, further events are dropped with a warning, so a stalled client
          cannot exhaust the worker&apos;s memory. Use a <code>ReadableStream</code> body with
          a <code>text/event-stream</code> content type when every event must arrive.
        </li>
        <li>
          An open stream counts toward <code>[server] max_connections</code> and keeps its
          worker busy for load balancing until it ends.
        </li>
      </ul>
      <p>
        For two-way messages, use <a href="/docs/websockets">WebSockets</a>.
      </p>

      <h2 id="shutdown">What happens at shutdown</h2>
      <p>
        On <code>SIGTERM</code> or Ctrl+C the server stops accepting connections, closes idle
        keep-alive connections, and gives what is in flight up to 8 seconds to finish:
      </p>
      <ul>
        <li>
          <strong>Event streams</strong> (<code>GioEventStream</code> and any route handler
          answering <code>text/event-stream</code>) are ended cleanly the moment shutdown
          starts, and their producers are cancelled in the worker. Browsers&apos;{' '}
          <code>EventSource</code> reconnects on its own - to the new process once it is up.
        </li>
        <li>
          <strong>Page renders and other streamed bodies</strong> (downloads, exports) are
          left to finish. One still running after the drain has its connection reset, so the
          client sees a failed transfer instead of a short file that looks complete.
        </li>
        <li>
          <strong>WebSockets</strong> are closed with <code>1001</code>.
        </li>
      </ul>
      <p>
        Give your process manager at least the drain time plus the workers&apos; shutdown
        grace before it kills the server - the <a href="/docs/guides/deploying">Deploying</a>{' '}
        recipes do.
      </p>

      <h2 id="what-can-break-streaming">What can break streaming</h2>
      <ul>
        <li>
          <strong>Reverse proxies</strong> that buffer responses hold every chunk until the
          end. With nginx, set <code>proxy_buffering off</code> for the app (see{' '}
          <a href="/docs/guides/deploying#nginx">the nginx recipe</a>).
        </li>
        <li>
          <strong>CDNs</strong> differ: some pass chunks through, some buffer. Cached pages
          are not streamed anyway; check streamed ones through the CDN.
        </li>
        <li>
          <strong>Compression</strong> (gzip or Brotli) applies to streamed pages and route
          bodies as they stream - their length is unknown, so <code>[compression]
          min_size_bytes</code> does not hold them back. Event streams are never compressed.
        </li>
        <li>
          <strong>Checking it:</strong> <code>curl -N</code> prints chunks as they arrive. A
          page that streams answers with <code>transfer-encoding: chunked</code> (over
          HTTP/1.1) and its fallback appears in the HTML before its content.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/file-conventions/loading"><code>loading.tsx</code></a> and <a href="/docs/layouts-and-pages#loading-ui">Loading UI</a></li>
        <li><a href="/docs/caching-layers#partial-prerendering-ppr">Partial prerendering</a> and the <a href="/docs/page-exports/shell"><code>shell</code></a> export</li>
        <li><a href="/docs/route-handlers#streaming-responses">Route Handlers: streaming responses</a></li>
        <li><a href="/docs/functions/gio-event-stream"><code>GioEventStream</code></a></li>
        <li><a href="/docs/error-handling#streaming-and-loadingtsx">Error Handling: streaming</a></li>
        <li><a href="/docs/configuration/server"><code>[server] render_timeout_secs</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              Per-folder <code>loading.tsx</code>. Streamed route handler bodies with
              backpressure. Event streams end at shutdown. <code>render_timeout_secs</code>{' '}
              replaces the fixed 30-second worker deadline. PPR pages hydrate as soon as
              their props arrive.
            </>
          ),
        },
        { version: 'v0.1.0-beta.7', changes: <>Partial prerendering (<code>shell = &apos;cache&apos;</code>).</> },
      ]} />
    </>
  );
}
