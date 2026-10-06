import React from 'react';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Font Optimization</h1>
      <p className="page-subtitle">Self-host any font as WOFF2 with correct preload headers.</p>
      <p>The giojs-font layer downloads and self-hosts fonts as WOFF2, then injects the correct preload and stylesheet links into your HTML - no third-party font CDN.</p>
      <div className="callout">Self-hosted fonts are served from /_gio/fonts, eliminating a render-blocking round-trip to an external host. The .woff2 files are cached as immutable; the generated /_gio/fonts/fonts.css is rewritten from gio.toml on every start under the same URL, so it is served with <code>Cache-Control: public, max-age=0, must-revalidate</code> and revalidated via Last-Modified.</div>
    </>
  );
}
