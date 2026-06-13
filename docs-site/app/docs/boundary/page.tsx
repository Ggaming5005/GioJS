import React from 'react';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Architecture</div>
      <h1>The Rust ⇄ Node Boundary</h1>
      <p className="page-subtitle">A single persistent IPC connection carries SSR requests to Node.</p>
      <p>Rust talks to a single long-lived Node worker over a Unix socket (Linux/macOS) or named pipe (Windows), using a length-prefixed JSON protocol. There is no per-request process spawn.</p>
      <div className="callout">Routing, caching, and compression all happen in Rust before Node is ever consulted — the boundary is crossed only for a cache-missed dynamic render.</div>
    </>
  );
}
