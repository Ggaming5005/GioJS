import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Styling &amp; Assets</div>
      <h1>Font Optimization</h1>
      <p className="page-subtitle">Self-host any font as WOFF2 with correct preload headers.</p>
      <p>
        List each font file in <code>gio.toml</code>. At startup the server puts every file in{' '}
        <code>.gio/fonts/</code>, serves it from <code>/_gio/fonts/</code>, and injects a{' '}
        <code>&lt;link rel=&quot;preload&quot;&gt;</code> per file plus a generated{' '}
        <code>@font-face</code> stylesheet into every page&apos;s <code>&lt;head&gt;</code> -
        visitors never make a request to a third-party font CDN.
      </p>

      <h2>Declare fonts in gio.toml</h2>
      <p>
        Add one <code>[[fonts]]</code> entry per <code>.woff2</code> file - one weight and style
        of one family. Projects created with <code>create-giojs</code> ship their fonts in{' '}
        <code>public/fonts/</code> and declare them like this:
      </p>
      <CodeBlock lang="toml" code={`[[fonts]]
family = "Fraunces"
url = "/public/fonts/fraunces-400-normal.woff2"   # a file in public/

[[fonts]]
family = "Fraunces"
url = "/public/fonts/fraunces-400-italic.woff2"
style = "italic"            # default "normal"

[[fonts]]
family = "JetBrains Mono"
url = "/public/fonts/jetbrains-mono-400-normal.woff2"

[[fonts]]
family = "JetBrains Mono"
url = "/public/fonts/jetbrains-mono-600-normal.woff2"
weight = 600                # default 400`} />
      <p>Then use the family in your CSS:</p>
      <CodeBlock lang="css" code={`/* app/globals.css */
body {
  font-family: 'Fraunces', Georgia, serif;
}`} />

      <h2 id="local-and-remote">Local files and remote URLs</h2>
      <p>A <code>url</code> takes one of two forms:</p>
      <ul>
        <li>
          A <code>url</code> without a scheme names a file in <code>public/</code>, written the
          way it is served: <code>/public/fonts/a.woff2</code> and <code>/fonts/a.woff2</code>{' '}
          are both <code>public/fonts/a.woff2</code>. It is read at every start, so the server
          needs no network, and served under a name with a hash of its content (
          <code>fraunces-400-normal-1a2b3c4d.woff2</code>): an edited file gets a new URL on
          restart, so browsers and CDNs that cached the old one pick it up. A missing file stops
          the server at startup with its path.
        </li>
        <li>
          <strong>A remote URL</strong> such as{' '}
          <code>https://cdn.example.com/inter-latin-400.woff2</code> - downloaded on the first
          start and reused after that (an existing file is never fetched again). The download
          happens before the server starts listening, and a failed download or an error status
          stops startup rather than saving an error page as the font. A fresh container or a new
          standalone folder downloads again on its first start, so the host needs outbound HTTPS
          to that URL then - or keep <code>.gio/fonts/</code> on a persistent volume. A file in{' '}
          <code>public/</code> avoids both.
        </li>
      </ul>
      <p>
        <code>GIO_FONTS_DIR</code> points the font folder somewhere other than{' '}
        <code>.gio/fonts/</code>.
      </p>
      <div className="callout">Self-hosted fonts are served from /_gio/fonts, eliminating a render-blocking round-trip to an external host. Every page gets a <code>&lt;link rel=&quot;preload&quot;&gt;</code> per font and the generated <code>/_gio/fonts/fonts.css</code> with its <code>@font-face</code> rules (<code>font-display: swap</code>). The .woff2 files are cached as immutable (a URL never gets new content); fonts.css is rewritten from gio.toml on every start under the same URL, so it is served with <code>Cache-Control: public, max-age=0, must-revalidate</code> and revalidated via Last-Modified.</div>
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
