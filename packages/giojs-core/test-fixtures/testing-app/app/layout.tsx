import React from 'react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Testing kit fixture</title>
      </head>
      <body>{children}</body>
    </html>
  );
}
