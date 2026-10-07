import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[css]',
  description:
    'How stylesheets are processed: path-served app/*.css, minification of production CSS, and ' +
    'critical CSS inlining.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[css]</h1>
      <p className="page-subtitle">
        How stylesheets are processed: path-served <code>app/*.css</code>, minification of
        production CSS, and critical CSS inlining.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[css]
minify = false              # readable production CSS while debugging`} />
      <p>
        Imported CSS (<code>import &apos;./globals.css&apos;</code>, CSS Modules) is part of the module
        graph and is always bundled by the worker; no key here turns it off. See{' '}
        <a href="/docs/css">CSS &amp; Styling</a>.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'enabled', type: 'boolean', default: 'true', zero: <><code>app/*.css</code> is not served by path</>, description: <>Serve every non-module <code>.css</code> file under <code>app/</code> at its path (<code>app/globals.css</code> at <code>/globals.css</code>), processed by Lightning CSS once at startup and kept in memory. Imported CSS is unaffected. Off, there is also no critical CSS, which is extracted from the path-served <code>globals.css</code>.</> },
        { key: 'minify', type: 'boolean', default: 'true', zero: <>Production CSS stays readable</>, description: <>Minify production CSS: the path-served stylesheets (Lightning CSS) and the bundled route stylesheets (esbuild). Development never minifies. <code>gio build standalone</code> bakes the route stylesheets at build time, so there the <code>gio.toml</code> the build reads decides.</> },
        { key: 'critical_extraction', type: 'boolean', default: 'true', zero: <>No inlined critical CSS</>, description: <>On cached pages that link no imported route stylesheet, inline the rules of <code>app/globals.css</code> the page uses and load the full file without blocking render.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The server hands <code>minify</code> to the Node worker in the{' '}
          <code>GIO_CSS_CONFIG</code> environment variable. It is one of the settings the
          deployment id covers, so changing it drops persisted pages, which link the stylesheets
          it builds.
        </li>
        <li>
          Path-served stylesheets have no content hash in their URL, so they are sent with{' '}
          <code>Cache-Control: public, max-age=0, must-revalidate</code> and a strong ETag.
        </li>
        <li>
          Critical CSS is skipped on pages that import CSS: their stylesheet (often{' '}
          <code>globals.css</code> itself) is already linked, and loading the file a second time
          would let it override the route&apos;s own rules. Under a CSP with nonces, the snippet&apos;s
          inline <code>&lt;style&gt;</code> and its loader script carry the nonce.
        </li>
      </ul>
      <p>No key in this section logs a warning.</p>

      <h2 id="examples">Examples</h2>
      <h3 id="only-imported-css">Only imported CSS</h3>
      <p>An app that imports all of its CSS needs no path-served copies:</p>
      <CodeBlock lang="toml" title="gio.toml" code={`[css]
enabled = false`} />

      <h3 id="debug-production-css">Debug production CSS</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[css]
minify = false
critical_extraction = false`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li><code>*.module.css</code> files are never served by path: their class names only exist in the import pipeline.</li>
        <li>In development, editing a stylesheet re-processes the path-served copies and restarts the worker.</li>
        <li>
          <code>[css] engine</code> from earlier docs is refused: Lightning CSS is the only engine (
          <code>unknown key `css.engine` - Lightning CSS is the only CSS engine. Remove the key</code>).
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/css">CSS &amp; Styling</a> and <a href="/docs/css#stylesheets-served-by-path-legacy">Stylesheets served by path</a></li>
        <li><a href="/docs/file-conventions/css">CSS files</a></li>
        <li><a href="/docs/cli/build-standalone"><code>gio build standalone</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <><code>minify</code> also covers the bundled route stylesheets (the server passes <code>[css]</code> to the worker in <code>GIO_CSS_CONFIG</code>); <code>enabled</code> is documented as covering path-served stylesheets only. <code>engine</code> is rejected.</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced with <code>enabled</code>, <code>minify</code> and <code>critical_extraction</code>.</> },
      ]} />
    </>
  );
}
