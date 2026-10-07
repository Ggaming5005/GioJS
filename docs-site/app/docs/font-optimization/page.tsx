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
        List each font file in <code>gio.toml</code>. At startup the server downloads every
        file it does not have yet into <code>.gio/fonts/</code>, serves it from{' '}
        <code>/_gio/fonts/</code>, and injects a <code>&lt;link rel=&quot;preload&quot;&gt;</code>{' '}
        per file plus a generated <code>@font-face</code> stylesheet into every page&apos;s{' '}
        <code>&lt;head&gt;</code> - visitors never make a request to a third-party font CDN.
      </p>
      <CodeBlock lang="toml" code={`[[fonts]]
family = "Inter"
url    = "https://example.com/fonts/inter-latin-400.woff2"
weight = 400          # default 400
style  = "normal"     # default "normal"

[[fonts]]
family = "Inter"
url    = "https://example.com/fonts/inter-latin-700.woff2"
weight = 700`} />
      <p>Then use the family in your CSS:</p>
      <CodeBlock lang="css" code={`/* app/globals.css */
body {
  font-family: 'Inter', system-ui, sans-serif;
}`} />
      <ul>
        <li>
          <code>url</code> is an absolute URL of a WOFF2 file. Each entry is one file - one
          weight and style of one family - stored as{' '}
          <code>&lt;family&gt;-&lt;weight&gt;-&lt;style&gt;.woff2</code>. Files are only
          downloaded when missing, so later starts reuse them.
        </li>
        <li>
          The download happens before the server starts listening, and a failed download
          stops startup. A fresh container or a new standalone folder downloads again on its
          first start, so the host needs outbound HTTPS to the font&apos;s URL then - or keep{' '}
          <code>.gio/fonts/</code> on a persistent volume (<code>GIO_FONTS_DIR</code> points
          it elsewhere).
        </li>
        <li>
          The faces use <code>font-display: swap</code>. The <code>.woff2</code> files are
          served as immutable; the generated <code>/_gio/fonts/fonts.css</code> is rewritten
          from <code>gio.toml</code> on every start under the same URL, so it is served with{' '}
          <code>Cache-Control: public, max-age=0, must-revalidate</code> and revalidated via
          Last-Modified.
        </li>
      </ul>
      <div className="callout">
        Fonts you already ship as files need no <code>[[fonts]]</code> entry: put them in{' '}
        <code>public/</code> and write the <code>@font-face</code> rule in your CSS yourself.
      </div>
    </>
  );
}
