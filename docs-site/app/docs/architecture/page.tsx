import React from 'react';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Architecture</div>
      <h1>How GioJS Works</h1>
      <p className="page-subtitle">Rust owns the hot path. Node does what it is best at: rendering React.</p>
      <p>GioJS splits responsibilities across two layers. The compiled Rust server handles everything performance-critical; Node handles React SSR and the npm ecosystem.</p>
      <ul>
        <li><strong>Rust</strong> - HTTP/2, TLS, routing, compression, image optimization, ISR cache, static files, middleware</li>
        <li><strong>Node</strong> - React rendering via renderToReadableStream, getServerSideProps, your app logic</li>
      </ul>
      <p>A request only reaches Node if it is a dynamic SSR route that missed the cache. Everything else is served entirely from Rust.</p>

      <h2>Node workers</h2>
      <p>The Rust server spawns the Node side itself and talks to it over a local socket (a Unix socket, or a named pipe on Windows) carrying length-prefixed JSON frames. Each worker proves it was started by this server with a per-worker token before it gets any traffic. The server supervises its workers: one that crashes is respawned with backoff, and only the requests it had in flight fail (with a 503) - cached and static content keeps serving throughout.</p>
      <p>By default there is one worker. With <code>[server] workers = N</code> (or <code>&quot;auto&quot;</code>) the server runs a pool, so renders use several CPU cores:</p>
      <ul>
        <li><strong>Dispatch</strong> - each request goes to the ready worker with the fewest requests in flight (open streams included), ties taken in turn. A worker that is respawning is skipped. Everything a request starts - a streamed body, an SSE stream, a Partial Prerendering hole render - stays on its worker.</li>
        <li><strong>One build</strong> - the first worker bundles the client code and records the result in <code>.gio/build/manifest.json</code>; the rest start once it is ready and load that manifest, so they never race on the same files. A worker that cannot load it fails its boot and is retried; it never rebuilds under the workers serving.</li>
        <li><strong>WebSockets</strong> - each connection is pinned to one worker, which runs its handler. Rooms live in the Rust server, so <code>broadcast(room, ...)</code> from any worker reaches sockets on all of them.</li>
        <li><strong>Shared server state</strong> - the page cache, revalidation, middleware rules and rate limits live in Rust, so they behave the same whichever worker handles a request. Module-level state in your app is per worker, and Node plugins&apos; <code>onStartup</code> / <code>onShutdown</code> hooks run in every worker.</li>
      </ul>
      <p>See <a href="/docs/configuration">Configuration</a> for the setting and <a href="/docs/deployment">Deployment</a> for sizing a pool.</p>
    </>
  );
}
