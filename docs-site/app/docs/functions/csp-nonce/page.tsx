import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'cspNonce',
  description:
    'The Content-Security-Policy nonce for the inline scripts you render, when [security] csp uses {nonce}.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>cspNonce</h1>
      <p className="page-subtitle">
        The Content-Security-Policy nonce for the inline scripts you render, when{' '}
        <code>[security] csp</code> uses <code>{'{nonce}'}</code>.
      </p>
      <CodeBlock lang="tsx" code={`import { cspNonce } from '@gio.js/core';

<script nonce={cspNonce()} dangerouslySetInnerHTML={{ __html: 'window.dataLayer = []' }} />`} />

      <h2 id="reference">Reference</h2>
      <p><code>cspNonce()</code> takes no arguments.</p>
      <h3 id="returns">Returns</h3>
      <p>
        <code>string | undefined</code>. A string - 32 lowercase hex characters - when{' '}
        <code>[security] csp</code> or <code>csp_report_only</code> contains{' '}
        <code>{'{nonce}'}</code>; <code>undefined</code> when neither does, during{' '}
        <code>gio export</code>, and in the browser.
      </p>
      <h3 id="behavior">Behavior</h3>
      <p>
        The string is not the nonce itself but a secret placeholder. Pages are cached and
        partial-prerendering shells replayed, so a render cannot know the nonce of the
        response that will carry it. The worker renders the placeholder; the Rust server
        replaces every occurrence with the response&apos;s fresh nonce - in the headers and the
        body of every dynamic response, cache hits included - just before sending it.
        The placeholder never reaches a browser.
      </p>
      <ul>
        <li>Every response gets a new random nonce of 192 bits (32 base64 characters).</li>
        <li>
          Pages, route handlers and event streams are all rewritten, whatever their content
          type. <code>public/</code> files and build assets are served untouched.
        </li>
        <li>
          While nonces are on, a dynamic response that sets its own{' '}
          <code>Content-Encoding</code> cannot be searched and is refused with a{' '}
          <code>500</code>; let GioJS compress it instead.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="an-inline-script-in-the-root-layout">An inline script in the root layout</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[security]
csp = "default-src 'self'; script-src 'self' 'nonce-{nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'"`} />
      <CodeBlock lang="tsx" title="app/layout.tsx" code={`import { cspNonce } from '@gio.js/core';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script
          nonce={cspNonce()}
          dangerouslySetInnerHTML={{
            __html: "document.documentElement.dataset.theme = localStorage.getItem('theme') ?? 'light';",
          }}
        />
        <script nonce={cspNonce()} async src="https://analytics.example.com/script.js" />
      </head>
      <body>{children}</body>
    </html>
  );
}`} />
      <p>
        The response carries the same nonce in its header and in both tags, for example{' '}
        <code>{"Content-Security-Policy: ... script-src 'self' 'nonce-p849UZ8c5U9tiKEsDNv+B31bEFGrqj+z' ..."}</code>{' '}
        and <code>{'<script nonce="p849UZ8c5U9tiKEsDNv+B31bEFGrqj+z">'}</code> - and a new
        one on the next request, even when the page comes from the cache.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Pass it straight to a <code>nonce</code> attribute.</strong> Hash, slice or
          encode the value and the server can no longer find it to replace.
        </li>
        <li>
          <strong>Use it in server-rendered markup.</strong> In the browser it returns{' '}
          <code>undefined</code>, so the root layout - which never hydrates - is the place for
          inline scripts.
        </li>
        <li>
          <strong>Framework scripts are covered already:</strong> the hydration bootstrap,
          React&apos;s streaming scripts, the deployment script, the critical-CSS loader and the
          development overlay all carry the nonce without your help.
        </li>
        <li>
          <strong>Styles.</strong> Keep <code>{"style-src 'self' 'unsafe-inline'"}</code>:{' '}
          <code>style</code> props cannot carry a nonce.
        </li>
        <li>
          <strong>CSP stays opt-in.</strong> A nonce is per response, so pages served with one
          are sent <code>private, no-cache</code> without an <code>ETag</code>: CDNs and
          browsers stop caching them, while the server&apos;s own page cache keeps working.
        </li>
        <li>
          <strong>Rotation.</strong> The placeholder changes with a new{' '}
          <code>GIO_DEPLOYMENT_ID</code>, a new standalone build or a change to the{' '}
          <code>gio.toml</code> settings pages render with - not with a code-only redeploy.
          To rotate it by hand, delete <code>meta/csp-nonce-placeholder-*</code> in the page
          cache directory (<code>.gio/cache/pages</code> unless <code>[cache] disk_path</code>{' '}
          or <code>GIO_CACHE_DIR</code> moves it) and restart.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/security#csp">Security: Content-Security-Policy</a></li>
        <li><a href="/docs/guides/content-security-policy">Content Security Policy guide</a></li>
        <li><a href="/docs/configuration/security">[security]</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
