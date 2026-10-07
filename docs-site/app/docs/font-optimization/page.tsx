import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Font Optimization</h1>
      <p className="page-subtitle">Self-host any font as WOFF2 with correct preload headers.</p>
      <p>The giojs-font layer self-hosts fonts as WOFF2, then injects the correct preload and stylesheet links into your HTML - no third-party font CDN.</p>
      <h2>Declare fonts in gio.toml</h2>
      <p>
        Add one <code>[[fonts]]</code> entry per <code>.woff2</code> file. Projects created with{' '}
        <code>create-giojs</code> ship theirs in <code>public/fonts/</code>:
      </p>
      <CodeBlock lang="toml" code={`[[fonts]]
family = "Fraunces"
url = "/public/fonts/fraunces-400-normal.woff2"   # a file in public/

[[fonts]]
family = "Fraunces"
url = "/public/fonts/fraunces-400-italic.woff2"
style = "italic"            # default "normal"

[[fonts]]
family = "Inter"
url = "https://example.com/fonts/inter-600.woff2"  # downloaded once
weight = 600                # default 400`} />
      <ul>
        <li>
          A <code>url</code> without a scheme names a file in <code>public/</code>, written the
          way it is served: <code>/public/fonts/a.woff2</code> and <code>/fonts/a.woff2</code>{' '}
          are both <code>public/fonts/a.woff2</code>. It is copied at every start, so the server
          needs no network and an edited file takes effect on restart. A missing file stops the
          server at startup with its path.
        </li>
        <li>
          An <code>https://</code> URL is downloaded on the first start and kept in{' '}
          <code>.gio/fonts/</code> (<code>GIO_FONTS_DIR</code> overrides it); a failed download
          or an error status stops the server at startup rather than serving an error page as
          the font.
        </li>
        <li>
          Use the family in your CSS as usual:{' '}
          <code>font-family: &apos;Fraunces&apos;, Georgia, serif;</code>
        </li>
      </ul>
      <div className="callout">Self-hosted fonts are served from /_gio/fonts, eliminating a render-blocking round-trip to an external host. Every page gets a <code>&lt;link rel=&quot;preload&quot;&gt;</code> per font and the generated <code>/_gio/fonts/fonts.css</code> with its <code>@font-face</code> rules (<code>font-display: swap</code>). The .woff2 files are cached as immutable; fonts.css is rewritten from gio.toml on every start under the same URL, so it is served with <code>Cache-Control: public, max-age=0, must-revalidate</code> and revalidated via Last-Modified.</div>
      <h2>Static export</h2>
      <p>
        <code>[[fonts]]</code> is applied by the Rust server, so <code>gio export</code> does not
        see it. A static site declares its fonts with <code>@font-face</code> in an imported
        stylesheet instead; the <a href="/docs/css">CSS pipeline</a> bundles the files its{' '}
        <code>url()</code>s name with hashed names:
      </p>
      <CodeBlock lang="css" code={`/* app/globals.css */
@font-face {
  font-family: 'Fraunces';
  src: url('../public/fonts/fraunces-400-normal.woff2') format('woff2');
  font-weight: 400;
  font-display: swap;
}`} />
    </>
  );
}
