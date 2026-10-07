/**
 * docs-site/app/layout.tsx
 *
 * Root layout - provides <html>, <head>, and <body>. Presence of this file
 * tells giojs-core to skip the wrapWithDocument fallback.
 *
 * Titles, descriptions and social cards come from the metadata API: the
 * site-wide values here, with the title template every page's title goes
 * through ('Caching | GioJS Docs'); the docs layout adds a per-page title
 * and canonical URL, and a page's own `export const metadata` wins over both.
 * This layout is never hydrated, so its head script (THEME_SCRIPT) runs
 * once, before first paint.
 */
import React from 'react';
import type { Metadata } from '@gio.js/core';
import { THEME_SCRIPT } from '../components/ThemeToggle.tsx';
import { SITE_DESCRIPTION, SITE_OPEN_GRAPH } from '../components/site-metadata.ts';

interface RootLayoutProps {
  children: React.ReactNode;
  path?: string;
}

export const metadata: Metadata = {
  title: { default: 'GioJS Documentation', template: '%s | GioJS Docs' },
  description: SITE_DESCRIPTION,
  openGraph: SITE_OPEN_GRAPH,
  twitter: {
    card: 'summary_large_image',
    title: 'GioJS - the Rust-powered React framework',
    description:
      'Self-hosted React at Vercel speed. HTTP/2, image optimization, ISR caching, and compression in one binary.',
    images: '/public/og.png',
  },
  themeColor: '#0b0a09',
};

export default function RootLayout({ children }: RootLayoutProps): React.JSX.Element {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/svg+xml" href="/public/giojs-logo.svg" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;1,9..144,500;1,9..144,600&family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
        />
        <link rel="stylesheet" href={`/public/globals.css?v=${process.env.GIO_ASSET_VERSION ?? 'dev'}`} />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
