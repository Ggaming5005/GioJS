import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[[fonts]]',
  description:
    'Self-hosted WOFF2 fonts: copied from public/ or downloaded once, served from /_gio/fonts with ' +
    'generated @font-face rules and preload links.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[[fonts]]</h1>
      <p className="page-subtitle">
        Self-hosted WOFF2 fonts: copied from <code>public/</code> or downloaded once, served from{' '}
        <code>/_gio/fonts</code> with generated <code>@font-face</code> rules and preload links.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[[fonts]]
family = "Fraunces"
url = "/fonts/fraunces-400-normal.woff2"     # public/fonts/fraunces-400-normal.woff2

[[fonts]]
family = "Fraunces"
url = "/fonts/fraunces-400-italic.woff2"
style = "italic"
preload = false                              # only used below the fold`} />
      <p>
        One table per <code>.woff2</code> file - one weight and style of one family. Use the family
        in your CSS as usual. <a href="/docs/font-optimization">Fonts</a> walks through it.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'family', type: 'string', required: true, description: <>The CSS <code>font-family</code> name the <code>@font-face</code> rule declares.</> },
        { key: 'url', type: 'string', required: true, description: <>A file in <code>public/</code>, written as it is served (<code>/fonts/a.woff2</code> or <code>/public/fonts/a.woff2</code>), or a URL with a scheme (<code>https://...</code>) to download. A path with <code>..</code> is refused.</> },
        { key: 'weight', type: 'integer', default: '400', description: <>The <code>font-weight</code> of this file.</> },
        { key: 'style', type: 'string', default: '"normal"', description: <>The <code>font-style</code> of this file (<code>normal</code>, <code>italic</code>). Reduced to lowercase letters, digits and <code>-</code>.</> },
        { key: 'preload', type: 'boolean', default: 'true', zero: <>No preload link; the <code>@font-face</code> rule stays</>, description: <>Preload the file from every page&apos;s <code>&lt;head&gt;</code>. Turn it off for fonts only used below the fold: the browser then fetches the file when text needs it, instead of competing with the page&apos;s first paint.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          Fonts are fetched at startup, before the worker starts and before the server listens. A
          local file is read on every start and served as{' '}
          <code>&lt;family&gt;-&lt;weight&gt;-&lt;style&gt;-&lt;content hash&gt;.woff2</code>, so an
          edited file gets a new URL. A remote file is downloaded on the first start to{' '}
          <code>&lt;family&gt;-&lt;weight&gt;-&lt;style&gt;.woff2</code> and reused after that.
        </li>
        <li>
          Every page gets one{' '}
          <code>&lt;link rel=&quot;preload&quot; as=&quot;font&quot; type=&quot;font/woff2&quot; crossorigin&gt;</code>{' '}
          per font with <code>preload = true</code>, and a stylesheet link to{' '}
          <code>/_gio/fonts/fonts.css</code>, whose rules use <code>font-display: swap</code>.
        </li>
        <li>
          The <code>.woff2</code> files are served as immutable; <code>fonts.css</code> is rewritten
          on every start under the same URL and sent with{' '}
          <code>Cache-Control: public, max-age=0, must-revalidate</code>.
        </li>
        <li>
          The font links are part of the deployment id: adding, removing or editing a font drops
          persisted pages, which carry the links.
        </li>
        <li>
          The files live in <code>.gio/fonts/</code>; <code>GIO_FONTS_DIR</code> moves them.
        </li>
      </ul>

      <h3 id="errors">Errors</h3>
      <p>Each stops startup and fails <code>--check-config</code>:</p>
      <ul>
        <li><code>[[fonts]] Inter: ./public/fonts/missing.woff2 not found (url = &quot;/fonts/missing.woff2&quot;)</code></li>
        <li><code>[[fonts]] Inter: font url &quot;../secret.woff2&quot; must be an https:// URL or a file under public/ (e.g. &quot;/fonts/inter.woff2&quot;)</code></li>
        <li>A download that fails or answers an error status: <code>font &apos;Inter&apos;: downloading &lt;url&gt; failed</code>. An error page is never saved as the font.</li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="a-family-with-two-weights">A family with two weights</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[fonts]]
family = "JetBrains Mono"
url = "/fonts/jetbrains-mono-400-normal.woff2"

[[fonts]]
family = "JetBrains Mono"
url = "/fonts/jetbrains-mono-600-normal.woff2"
weight = 600`} />
      <CodeBlock lang="css" title="app/globals.css" code={`code {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          A remote font needs outbound network access on the first start of every fresh container
          or standalone folder. A file in <code>public/</code> needs none, and keeping{' '}
          <code>.gio/fonts/</code> on a persistent volume avoids the download.
        </li>
        <li>
          A remote file is never fetched again under the same name: to change it, change its family,
          weight or style, or delete the stored file.
        </li>
        <li>
          <code>gio export</code> does not read <code>[[fonts]]</code>: a static site declares its
          fonts with <code>@font-face</code> in an imported stylesheet.
        </li>
        <li>No key in this section logs a warning.</li>
      </ul>
      <h3 id="not-configurable">Not configurable</h3>
      <ul>
        <li><code>font-display: swap</code>, the WOFF2 format and the <code>/_gio/fonts</code> URL.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/font-optimization">Fonts</a></li>
        <li><a href="/docs/components/gio-font"><code>&lt;GioFont&gt;</code></a></li>
        <li><a href="/docs/file-conventions/public-folder"><code>public/</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Added <code>preload</code>. Local files are copied on every start under a content-hashed name, a missing local file stops startup before the worker starts, and a failed download no longer saves an error page as the font.</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced with <code>family</code>, <code>url</code>, <code>weight</code> and <code>style</code>.</> },
      ]} />
    </>
  );
}
