import React from 'react';
import type { LayoutProps, Metadata } from '@gio.js/core';
import Navbar from '@/components/layout/Navbar';
import Footer from '@/components/layout/Footer';
// Global styles: bundled, hashed and linked in <head> by GioJS - no <link>
// needed. Its fonts are self-hosted from public/fonts/ (see gio.toml).
import './globals.css';

// The title and description of every page: a page's own `metadata` (or
// generateMetadata) title fills the template, e.g. 'About | {{PROJECT_NAME}}'.
export const metadata: Metadata = {
  title: { default: "{{PROJECT_NAME}}", template: "%s | {{PROJECT_NAME}}" },
  description: 'A GioJS application.',
};

export default function RootLayout({ children }: LayoutProps): React.JSX.Element {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/public/giojs-logo.svg" type="image/svg+xml" />
      </head>
      <body>
        <Navbar />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
