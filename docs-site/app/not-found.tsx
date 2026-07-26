/**
 * docs-site/app/not-found.tsx
 *
 * Rendered for unmatched paths: by the server with status 404, and exported
 * to out/404.html so Cloudflare Pages serves a real 404 for unknown URLs
 * instead of falling back to the home page. Fully self-contained inline
 * styles — no dependency on the landing page's scoped CSS, since 404.html is
 * served on its own.
 */
import React from 'react';

const btnBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0.7rem 1.3rem',
  borderRadius: '10px',
  fontWeight: 650,
  fontSize: '0.95rem',
  textDecoration: 'none',
  border: '1px solid transparent',
};

export default function NotFound(): React.JSX.Element {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem 1.25rem',
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: '30rem', width: '100%' }}>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.75rem',
            letterSpacing: '0.2em',
            opacity: 0.55,
            marginBottom: '0.75rem',
          }}
        >
          HTTP 404
        </div>
        <h1
          style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: 'italic',
            fontWeight: 600,
            fontSize: 'clamp(2rem, 9vw, 2.8rem)',
            lineHeight: 1.05,
            letterSpacing: '-0.02em',
            margin: '0 0 0.75rem',
          }}
        >
          Page not found
        </h1>
        <p style={{ opacity: 0.75, lineHeight: 1.6, margin: '0 0 1.75rem' }}>
          This page doesn&apos;t exist or was moved. The docs index is the best
          place to find what you were looking for.
        </p>
        <div
          style={{
            display: 'flex',
            gap: '0.75rem',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <a
            href="/docs/getting-started"
            style={{ ...btnBase, background: 'var(--accent)', color: '#fff' }}
          >
            Open the docs
          </a>
          <a
            href="/"
            style={{
              ...btnBase,
              borderColor: 'var(--border)',
              color: 'var(--text)',
            }}
          >
            Go home
          </a>
        </div>
      </div>
    </main>
  );
}
