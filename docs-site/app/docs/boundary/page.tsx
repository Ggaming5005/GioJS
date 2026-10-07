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
    </>
  );
}
