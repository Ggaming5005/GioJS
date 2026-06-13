/**
 * docs-site/app/layout.tsx
 *
 * Root layout — provides <html>, <head>, and <body>. Presence of this file
 * tells giojs-core to skip the wrapWithDocument fallback.
 */
import React from 'react';

interface RootLayoutProps {
  children: React.ReactNode;
  path?: string;
}

export default function RootLayout({ children }: RootLayoutProps): React.JSX.Element {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>GioJS Documentation</title>
        <meta name="description" content="GioJS — the Rust-powered React framework. Self-hosted React at Vercel speed: HTTP/2, image optimization, ISR caching, and compression in compiled Rust." />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/svg+xml" href="/public/giojs-logo.svg" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <meta name="theme-color" content="#0b0a09" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="GioJS" />
        <meta property="og:url" content="https://giojs.com" />
        <meta property="og:title" content="GioJS — the Rust-powered React framework" />
        <meta property="og:description" content="Self-hosted React at Vercel speed. HTTP/2, image optimization, ISR caching, and compression in compiled Rust — deploy anywhere." />
        <meta property="og:image" content="https://giojs.com/public/og.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="GioJS — self-hosted React at Vercel speed" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="GioJS — the Rust-powered React framework" />
        <meta name="twitter:description" content="Self-hosted React at Vercel speed. HTTP/2, image optimization, ISR caching, and compression in one binary." />
        <meta name="twitter:image" content="https://giojs.com/public/og.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;1,9..144,500;1,9..144,600&family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
        />
        <link rel="stylesheet" href="/public/globals.css" />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
