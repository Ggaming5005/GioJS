import React from 'react';
// Imported CSS: bundled into the root stylesheet every page links first.
import './root.css';

// A realistic <head>. It also keeps small pages such as /cached above the
// 1 KiB compression threshold that the CSP phase's gzip check relies on.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="description"
          content="GioJS integration fixture: every page renders inside this root layout, which imports the global stylesheet the route stylesheet build bundles and links."
        />
        <meta name="theme-color" content="#0b0a09" />
        <meta name="color-scheme" content="light dark" />
        <meta name="robots" content="noindex, nofollow" />
        <meta property="og:title" content="GioJS integration fixture" />
        <meta property="og:description" content="Exercises the Rust server and the Node worker end to end." />
      </head>
      <body>{children}</body>
    </html>
  );
}
