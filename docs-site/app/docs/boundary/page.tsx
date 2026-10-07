import React from 'react';
import type { Metadata } from '@gio.js/core';

export const metadata: Metadata = {
  title: 'The Rust ⇄ Node Boundary',
  description: 'Persistent IPC connections carry cache-missed requests to the Node workers.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>The Rust ⇄ Node Boundary</h1>
      <p className="page-subtitle">Persistent IPC connections carry cache-missed requests to the Node workers.</p>
      <p>
        Rust talks to each long-lived Node worker over its own Unix socket (Linux/macOS) or
        named pipe (Windows), using a versioned, length-prefixed JSON protocol. There is no
        per-request process spawn. With a{' '}
        <a href="/docs/configuration#render-workers">worker pool</a>, every worker has its own
        connection and each request goes to the least busy one.
      </p>
      <ul>
        <li><strong>Authenticated</strong> - a worker proves with a per-worker token that this server started it, and the protocol version is checked at the handshake, so a mismatched <code>@gio.js/core</code> fails loudly instead of misbehaving.</li>
        <li><strong>Streaming</strong> - personalized pages and streamed route responses cross as chunk frames while React produces them; Rust splices its head and body injections into the stream.</li>
        <li><strong>Binary-safe</strong> - request bodies and binary route responses cross byte-for-byte; a request too large for one frame is answered with <code>413</code>.</li>
        <li><strong>Cancellable</strong> - a client disconnect or timeout aborts the render in Node instead of finishing work nobody reads.</li>
      </ul>
      <div className="callout">Routing, caching, compression and the security checks all happen in Rust before Node is ever consulted - the boundary is crossed only for a cache-missed render, a route handler, an action, or a WebSocket message.</div>

      <h2 id="what-crosses-the-boundary">What crosses the boundary</h2>
      <table>
        <thead>
          <tr><th>Request</th><th>Answered by</th></tr>
        </thead>
        <tbody>
          <tr><td>A page cache hit, a static file, a <code>public/</code> file, a font, an optimized image</td><td>Rust alone</td></tr>
          <tr><td>A guard, redirect, rewrite or header rule; CSRF, rate-limit and path checks; <code>/_gio/health</code>, <code>/_gio/metrics</code>, <code>/_gio/revalidate</code></td><td>Rust alone</td></tr>
          <tr><td>A cache miss, a personalized page, a page action, a route handler</td><td>A Node worker, over the render connection</td></tr>
          <tr><td>A WebSocket message</td><td>The worker that accepted the socket, over a second connection</td></tr>
        </tbody>
      </table>

      <h2 id="the-handshake">The handshake</h2>
      <p>
        The server starts each worker with a fresh random token and the path of its socket
        (under <code>.gio/</code>). The worker listens there, builds the client bundles (or
        loads the first worker&apos;s build), discovers the routes, and sends a{' '}
        <code>ready</code> frame. Neither side ever sends the raw token: each sends a proof
        derived from it and its role, so an endpoint that captures one proof cannot answer
        with the other. The <code>ready</code> frame carries:
      </p>
      <ul>
        <li>the protocol version - a server and a <code>@gio.js/core</code> that speak different versions refuse to work together, with an error that says to update both;</li>
        <li>the route manifest, which Rust loads into its router;</li>
        <li>the rules from <code>middleware.ts</code>, which Rust compiles and enforces;</li>
        <li>a hash of the client build and the app&apos;s server sources, which becomes the deployment ID.</li>
      </ul>
      <p>
        Rust answers with an <code>ack</code> carrying the deployment ID, and only then sends
        traffic. The server tries to connect for up to 60 attempts while a worker boots.
      </p>

      <h2 id="frames">Frames</h2>
      <p>
        Every message is a 4-byte big-endian length followed by that many bytes of JSON, at
        most 64 MiB. Requests are multiplexed by id over the one connection, so a slow render
        never blocks the others. A request body that is not valid UTF-8 crosses base64-encoded,
        which limits binary bodies to about 48 MiB.
      </p>
      <table>
        <thead>
          <tr><th>Frame</th><th>Direction</th><th>Purpose</th></tr>
        </thead>
        <tbody>
          <tr><td>request</td><td>Rust → Node</td><td>Method, path, params, query, headers, body, locale, client IP and request id</td></tr>
          <tr><td>response</td><td>Node → Rust</td><td>Status, headers, cookies, body, and whether and for how long Rust may cache it</td></tr>
          <tr><td><code>chunk</code>, <code>shell_end</code>, <code>chunk_end</code></td><td>Node → Rust</td><td>A streamed body, and where a PPR shell ends</td></tr>
          <tr><td><code>sse_chunk</code>, <code>sse_done</code></td><td>Node → Rust</td><td>Server-Sent Events</td></tr>
          <tr><td><code>flow</code></td><td>Rust → Node</td><td>Pause and resume a streamed body (backpressure)</td></tr>
          <tr><td><code>cancel</code>, <code>sse_close</code></td><td>Rust → Node</td><td>The client went away or the deadline passed: stop the work</td></tr>
          <tr><td><code>revalidate</code>, <code>revalidate_ack</code></td><td>Both</td><td><code>revalidateTag()</code> and <code>revalidatePath()</code> purges, confirmed by Rust</td></tr>
        </tbody>
      </table>

      <h2 id="deadlines-and-limits">Deadlines and limits</h2>
      <ul>
        <li>
          A worker must answer within <code>[server] render_timeout_secs</code> (30 seconds by
          default): the whole buffered response, the head of a streamed one, and every gap
          between page chunks. Past it the client gets <code>504</code> and the worker a{' '}
          <code>cancel</code>. Route-handler streams and event streams have no idle limit.
        </li>
        <li>
          A response that does not parse gets a <code>500</code> at once. A request too large
          for one frame gets <code>413</code> without touching the connection.
        </li>
        <li>
          Event-stream and WebSocket data frames are dropped, with a warning, while more than 8
          MiB is waiting to be written to Rust, so a stalled consumer cannot grow the
          worker&apos;s memory without bound. Response frames are never dropped.
        </li>
      </ul>

      <h2 id="when-a-worker-fails">When a worker fails</h2>
      <p>
        A worker that crashes fails only the requests it had in flight, with <code>503</code>,
        and is restarted with backoff while the other workers - and every cached page - keep
        serving. Its WebSockets close with <code>1001</code>. The worker also watches the
        stdin pipe the server holds: if the server dies outright (<code>SIGKILL</code>, the
        OOM killer), the pipe closes and the worker exits instead of lingering. On a normal
        stop each worker gets 6 seconds to run plugin shutdown hooks.
      </p>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/architecture">How GioJS Works</a></li>
        <li><a href="/docs/caching-layers">Caching Layers</a></li>
        <li><a href="/docs/guides/streaming">Streaming</a></li>
        <li><a href="/docs/endpoints">Endpoints &amp; Headers</a></li>
      </ul>
    </>
  );
}
