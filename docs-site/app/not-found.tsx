/**
 * docs-site/app/not-found.tsx
 *
 * Rendered for unmatched paths: by the server with status 404, and exported
 * to out/404.html so Cloudflare Pages serves a real 404 for unknown URLs
 * instead of falling back to the home page.
 */
import React from 'react';

export default function NotFound(): React.JSX.Element {
  return (
    <main className="lp" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', padding: '2rem' }}>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.8rem', letterSpacing: '0.2em', opacity: 0.6, marginBottom: '0.75rem' }}>
          HTTP 404
        </div>
        <h1 style={{ fontFamily: 'Fraunces, serif', fontSize: '2.4rem', margin: '0 0 0.75rem' }}>
          Page not found
        </h1>
        <p style={{ opacity: 0.75, maxWidth: '32rem', margin: '0 auto 1.75rem' }}>
          This page doesn&apos;t exist or was moved. The docs index is the best
          place to find what you were looking for.
        </p>
        <p>
          <a className="lp-btn lp-btn--primary" href="/docs/getting-started">Open the docs</a>{' '}
          <a className="lp-btn lp-btn--ghost" href="/">Go home</a>
        </p>
      </div>
    </main>
  );
}
