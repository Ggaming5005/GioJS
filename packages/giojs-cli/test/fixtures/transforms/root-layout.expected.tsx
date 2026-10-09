import type { Metadata } from '@gio.js/core';
import { Providers } from './providers';

// TODO(gio-migrate): next/font: self-host "Inter" with a gio.toml [[fonts]] entry (see MIGRATION_REPORT.md) and apply font-family: 'Inter' in CSS - className/variable are now empty
const inter = { className: '', variable: '', style: { fontFamily: "'Inter'" } };
// TODO(gio-migrate): next/font: self-host "Roboto Mono" with a gio.toml [[fonts]] entry (see MIGRATION_REPORT.md) and apply font-family: 'Roboto Mono' in CSS - className/variable are now empty
const mono = { className: '', variable: '', style: { fontFamily: "'Roboto Mono'" } };

export const metadata: Metadata = {
  title: 'My app',
  description: 'Migrated from Next.js',
};

// TODO(gio-migrate): the root layout is server-only HTML in GioJS (never hydrated): <Providers> render but won't handle events or provide context in the browser - move interactive parts and providers into a nested layout or the pages
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={mono.variable}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="/globals.css" />
      </head>
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
