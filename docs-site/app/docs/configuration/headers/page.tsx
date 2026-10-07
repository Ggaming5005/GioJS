import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[[headers]]',
  description: 'Response headers stamped on every response to matching paths, redirects included.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[[headers]]</h1>
      <p className="page-subtitle">
        Response headers stamped on every response to matching paths, redirects included.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[[headers]]
path = "/api/*rest"
[headers.headers]
cache-control = "no-store"
access-control-allow-origin = "https://app.example.com"`} />
      <p>
        Each rule is a <code>[[headers]]</code> table with a <code>path</code> and a{' '}
        <code>[headers.headers]</code> table of names and values. For headers on every response,
        see <a href="/docs/configuration/security"><code>[security.headers]</code></a>.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'path', type: 'string', required: true, description: <>The path pattern: literal segments, <code>:param</code> and a final <code>*rest</code> (<code>/*rest</code> covers the whole site, root included).</> },
        { key: 'headers', type: 'table', required: true, zero: <>An empty value removes a default security header</>, description: <>Header name to value. Names and values are validated at startup.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          Header rules do not short-circuit: every rule whose <code>path</code> matches adds its
          headers. When two set the same header, the later one wins, and{' '}
          <code>middleware.ts</code> rules come after gio.toml&apos;s.
        </li>
        <li>
          A rule&apos;s value replaces the response&apos;s own value for that header - one set by a
          route handler or <code>getServerSideProps</code> included - except <code>set-cookie</code>,
          which is added next to the response&apos;s cookies.
        </li>
        <li>
          Rules match the path the client requested (before any rewrite), and are also stamped on
          the redirects that <a href="/docs/configuration/redirects"><code>[[redirects]]</code></a>{' '}
          and <a href="/docs/configuration/guards"><code>[[guards]]</code></a> answer with, so
          security headers cover those too.
        </li>
        <li>
          They win over the default security headers and the CSP, and an empty value removes such a
          default (<code>x-frame-options = &quot;&quot;</code>) for the rule&apos;s paths. For any
          other header an empty value is sent as an empty header.
        </li>
        <li>
          A <code>Cache-Control</code> from a rule replaces the one GioJS computes for pages.
        </li>
        <li>
          A <code>public/</code> file answered at the site root also gets the rules for its{' '}
          <code>/public/...</code> URL; the requested URL&apos;s rules win on a conflict. Rust&apos;s
          own <code>/_gio</code> endpoints get none.
        </li>
      </ul>

      <h3 id="invalid-rules">Invalid rules</h3>
      <p>A rule with an invalid header name or value, or a bad pattern, is skipped with a startup warning (<code>invalid header rule skipped</code>), and <code>--check-config</code> lists it under <code>warnings</code>:</p>
      <CodeBlock lang="text" code={`[[headers]] /x: invalid header name: bad header`} />

      <h2 id="examples">Examples</h2>
      <h3 id="let-partners-embed-one-section">Let partners embed one section</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[headers]]
path = "/embed/*rest"
[headers.headers]
x-frame-options = ""
content-security-policy = "frame-ancestors https://partner.example.com"`} />

      <h3 id="long-caching-for-a-versioned-folder">Long caching for a versioned folder</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[headers]]
path = "/assets/v2/*rest"
[headers.headers]
cache-control = "public, max-age=31536000, immutable"`} />

      <h3 id="two-rules-in-one-file">Two rules in one file</h3>
      <p>Each <code>[headers.headers]</code> belongs to the <code>[[headers]]</code> table right above it:</p>
      <CodeBlock lang="toml" title="gio.toml" code={`[[headers]]
path = "/admin/*rest"
[headers.headers]
x-robots-tag = "noindex"

[[headers]]
path = "/feed.xml"
[headers.headers]
content-type = "application/rss+xml; charset=utf-8"`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>No conditions on query, cookies or methods: a rule matches on the path alone.</li>
        <li>The rules are compiled once at startup; restart after editing them.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/middleware#header-rules">Middleware: Header rules</a></li>
        <li><a href="/docs/configuration/security"><code>[security]</code></a> - headers on every response</li>
        <li><a href="/docs/headers">Headers reference</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Rules also apply to redirect and guard responses and match the requested path rather than a rewritten one; a <code>set-cookie</code> rule adds its cookie instead of replacing the response&apos;s. <code>*rest</code> matches zero segments.</> },
        { version: 'v0.1.0-beta.6', changes: 'Introduced.' },
      ]} />
    </>
  );
}
