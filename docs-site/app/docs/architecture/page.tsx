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
        <li><strong>Rust</strong> — HTTP/2, TLS, routing, compression, image optimization, ISR cache, static files, middleware</li>
        <li><strong>Node</strong> — React rendering via renderToReadableStream, getServerSideProps, your app logic</li>
      </ul>
      <p>A request only reaches Node if it is a dynamic SSR route that missed the cache. Everything else is served entirely from Rust.</p>
    </>
  );
}
