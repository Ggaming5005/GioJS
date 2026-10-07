import React from 'react';
// Global styles: bundled, hashed and linked in <head> by GioJS - no <link>
// needed. Its fonts are self-hosted from public/fonts/ (see gio.toml).
import './globals.css';

// The title and description of every page: a page's own `metadata` (or
// generateMetadata) title fills the template, e.g. 'About | {{PROJECT_NAME}}'.
/** @type {import('@gio.js/core').Metadata} */
export const metadata = {
  title: { default: "{{PROJECT_NAME}}", template: "%s | {{PROJECT_NAME}}" },
  description: 'A GioJS application.',
};

/** @param {import('@gio.js/core').LayoutProps} props */
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/public/giojs-logo.svg" type="image/svg+xml" />
      </head>
      {/* Server-only HTML: a GioLink here would be a plain link. The site's
          navigation lives in app/(site)/layout, which hydrates. */}
      <body>{children}</body>
    </html>
  );
}
