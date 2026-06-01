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
        <meta name="description" content="GioJS — the Rust-powered Next.js runtime. Docs, API reference, migration guide, and deployment guides." />
        <link rel="stylesheet" href="/globals.css" />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
