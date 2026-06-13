import React from 'react';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">API Reference</div>
      <h1>Functions</h1>
      <p className="page-subtitle">Server-side functions and page exports.</p>
      <h2>getServerSideProps(ctx)</h2>
      <p>Async data loader. Receives a context with <code>params</code>, <code>query</code>, and <code>locale</code>, and returns <code>props</code> or a <code>redirect</code>.</p>
      <h2>export const revalidate</h2>
      <p>A number (seconds), or false to cache indefinitely. Controls the ISR cache TTL for the page.</p>
    </>
  );
}
