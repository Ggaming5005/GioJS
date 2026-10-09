import React from 'react';
import type { Metadata } from '@gio.js/core';

export const metadata: Metadata = {
  title: 'How GioJS Works',
  description: 'Rust owns the hot path. Node does what it is best at: rendering React.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>How GioJS Works</h1>
      <p className="page-subtitle">Rust owns the hot path. Node does what it is best at: rendering React.</p>
      <p>GioJS splits responsibilities across two layers. The compiled Rust server handles everything performance-critical; Node handles React SSR and the npm ecosystem.</p>
      <ul>
        <li><strong>Rust</strong> - HTTP/2, TLS, routing, compression, image optimization, ISR cache, static files, middleware</li>
        <li><strong>Node</strong> - React rendering via renderToReadableStream, getServerSideProps, your app logic</li>
      </ul>
      <p>A request only reaches Node if it is a dynamic SSR route that missed the cache. Everything else is served entirely from Rust.</p>

      <h2 id="the-life-of-a-request">The life of a request</h2>
      <p>
        Every request passes the same layers in the Rust server, in this order. A layer that
        can answer on its own - a refusal, a redirect, a cache hit - does, and nothing after it
        runs:
      </p>
      <ol>
        <li><strong>Client identity</strong> - the client&apos;s address and scheme are resolved (through <code>[server] trusted_proxies</code>), the request gets its <code>X-Request-Id</code>, and repeated <code>cookie</code> fields are joined.</li>
        <li><strong>Path hygiene</strong> - the path is made canonical; dot segments, a raw <code>\</code> or a broken <code>%</code> escape get <code>400</code>, and unknown <code>/_gio/</code> paths <code>404</code>.</li>
        <li><strong>Locale</strong> - with <a href="/docs/i18n"><code>[i18n]</code></a>, the locale is detected and its prefix removed from the path.</li>
        <li><strong>Deployment skew</strong> - a client navigation from another deployment gets <code>409</code> and reloads in full.</li>
        <li><strong>Rate limits</strong> - <a href="/docs/configuration/rate-limits"><code>[[rate_limits]]</code></a> rules answer <code>429</code> past their budget.</li>
        <li><strong>CSRF</strong> - a cross-site <code>POST</code>, <code>PUT</code>, <code>PATCH</code> or <code>DELETE</code> gets <code>403</code>, before its body is read.</li>
        <li><strong>Rules</strong> - guards, redirects and rewrites from <code>gio.toml</code> and <a href="/docs/file-conventions/middleware"><code>middleware.ts</code></a>.</li>
        <li><strong>Prefetch budget</strong> - prefetch requests past the per-client budget get <code>429</code>.</li>
        <li><strong>Routing</strong> - built-in <code>/_gio</code> endpoints, build assets, fonts and <a href="/docs/file-conventions/public-folder"><code>public/</code></a> files are served from Rust; a page or route handler goes to the page cache, and only on a miss (or for anything personal) to a Node worker.</li>
      </ol>
      <p>
        On the way out, the response gets its security headers (and CSP nonces), its{' '}
        <code>X-Gio-Cache</code> status and its compression. Each of these protections has a
        switch in <code>gio.toml</code>; see{' '}
        <a href="/docs/guides/security-switches">Turning Protections On and Off</a>.
      </p>

      <h2 id="node-workers">Node workers</h2>
      <p>The Rust server spawns the Node side itself and talks to it over a local socket (a Unix socket, or a named pipe on Windows) carrying length-prefixed JSON frames. Each worker proves it was started by this server with a per-worker token before it gets any traffic. The server supervises its workers: one that crashes is respawned with backoff, and only the requests it had in flight fail (with a 503) - cached and static content keeps serving throughout.</p>
      <p>By default there is one worker. With <code>[server] workers = N</code> (or <code>&quot;auto&quot;</code>) the server runs a pool, so renders use several CPU cores:</p>
      <ul>
        <li><strong>Dispatch</strong> - each request goes to the ready worker with the fewest requests in flight (open streams included), ties taken in turn. A worker that is respawning is skipped. Everything a request starts - a streamed body, an SSE stream, a Partial Prerendering hole render - stays on its worker.</li>
        <li><strong>One build</strong> - the first worker bundles the client code and records the result in <code>.gio/build/manifest.json</code>; the rest start once it is ready and load that manifest, so they never race on the same files. A worker that cannot load it fails its boot and is retried; it never rebuilds under the workers serving.</li>
        <li><strong>WebSockets</strong> - each connection is pinned to one worker, which runs its handler. Rooms live in the Rust server, so <a href="/docs/functions/broadcast"><code>broadcast(room, ...)</code></a> from any worker reaches sockets on all of them.</li>
        <li><strong>Shared server state</strong> - the page cache, revalidation, middleware rules and rate limits live in Rust, so they behave the same whichever worker handles a request. Module-level state in your app is per worker, and Node plugins&apos; <code>onStartup</code> / <code>onShutdown</code> hooks run in every worker.</li>
      </ul>
      <p>See <a href="/docs/configuration/server">[server]</a> for the setting and <a href="/docs/deployment">Deployment</a> for sizing a pool.</p>

      <h2 id="further-reading">Further reading</h2>
      <ul>
        <li><a href="/docs/boundary">The Rust ⇄ Node Boundary</a> - the protocol between the server and its workers</li>
        <li><a href="/docs/caching-layers">Caching Layers</a> - the page cache and partial prerendering</li>
        <li><a href="/docs/guides/streaming">Streaming</a> - how streamed pages, route bodies and events cross</li>
        <li><a href="/docs/known-issues">Known Limitations</a></li>
      </ul>
    </>
  );
}
