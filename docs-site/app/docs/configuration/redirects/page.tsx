import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[[redirects]]',
  description: 'Redirect rules evaluated in Rust before routing, with :param and *rest captures substituted into the target.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[[redirects]]</h1>
      <p className="page-subtitle">
        Redirect rules evaluated in Rust before routing, with <code>:param</code> and{' '}
        <code>*rest</code> captures substituted into the target.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[[redirects]]
from = "/blog/:slug"
to = "/posts/:slug"
status = 301`} />
      <p>
        One table per rule. The same rules can also come from{' '}
        <a href="/docs/file-conventions/middleware"><code>middleware.ts</code></a>; see{' '}
        <a href="/docs/middleware">Middleware</a> for how the sources combine, and{' '}
        <a href="/docs/guides/redirecting">Redirecting</a> for the other ways to redirect.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'from', type: 'string', required: true, description: <>The path pattern: literal segments, <code>:param</code> (one segment) and a final <code>*rest</code> (the rest of the path, possibly empty). Must start with <code>/</code>.</> },
        { key: 'to', type: 'string', required: true, description: <>The target path. It must start with <code>/</code> - a redirect stays on this site - and may use the pattern&apos;s captures by name, in any order.</> },
        { key: 'status', type: 'integer', default: '302', description: <><code>301</code> or <code>308</code> (permanent; browsers and search engines remember it), <code>302</code> or <code>307</code> (temporary). <code>307</code> and <code>308</code> keep the method and body.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          Rules match the canonical request path (repeated and trailing slashes collapsed,
          unreserved escapes decoded). The first matching rule wins.
        </li>
        <li>
          The original query string is appended to the target as it was sent:{' '}
          <code>/blog/hello?ref=x</code> goes to <code>/posts/hello?ref=x</code>.
        </li>
        <li>
          An empty <code>*rest</code> contributes nothing: with{' '}
          <code>/old/*rest</code> to <code>/new/*rest</code>, <code>/old</code> goes to{' '}
          <code>/new</code>.
        </li>
        <li>
          Redirects run after guards and before rewrites, gio.toml rules before{' '}
          <code>middleware.ts</code> ones. A guard on the same path therefore wins.
        </li>
        <li>
          The answer is the status with a <code>Location</code> header and an empty body, marked{' '}
          <code>X-Gio-Cache: bypass</code>. <a href="/docs/configuration/headers"><code>[[headers]]</code></a>{' '}
          rules for the requested path are stamped on it.
        </li>
        <li>Rust&apos;s own <code>/_gio</code> endpoints are never redirected.</li>
      </ul>

      <h3 id="invalid-rules">Invalid rules</h3>
      <p>
        A rule that cannot be compiled is skipped with a startup warning (
        <code>invalid redirect rule skipped</code>, with the rule&apos;s <code>from</code> and the
        error), and the server still starts. <code>giojs-server --check-config</code> lists the
        same problems under <code>warnings</code>:
      </p>
      <CodeBlock lang="text" code={`[[redirects]] /old: pattern must start with '/': https://example.com/new
[[redirects]] /old: redirect status must be 301, 302, 307, or 308 (got 303)
[[redirects]] /a/:id: target references unknown capture 'slug'`} />
      <p>A misspelled key (<code>stauts</code>) is a startup error, like everywhere in <code>gio.toml</code>.</p>

      <h2 id="examples">Examples</h2>
      <h3 id="move-a-section">Move a section</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[redirects]]
from = "/docs/v1/*rest"
to = "/docs/*rest"
status = 308`} />

      <h3 id="reorder-captures">Reorder captures</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[redirects]]
from = "/u/:user/p/:post"
to = "/p/:post/by/:user"     # /u/alice/p/42 -> /p/42/by/alice`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Redirects to another site are not supported here: <code>to</code> must be a path. Redirect
          from a <a href="/docs/file-conventions/route">route handler</a> or with{' '}
          <a href="/docs/functions/redirect"><code>redirect()</code></a> for that.
        </li>
        <li>No query, header or cookie conditions: a rule matches on the path alone.</li>
        <li>The rules are compiled once at startup; restart after editing them.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/middleware">Middleware</a> and <a href="/docs/middleware#pattern-language">Pattern language</a></li>
        <li><a href="/docs/configuration/rewrites"><code>[[rewrites]]</code></a>, <a href="/docs/configuration/headers"><code>[[headers]]</code></a> and <a href="/docs/configuration/guards"><code>[[guards]]</code></a></li>
        <li><a href="/docs/functions/define-middleware"><code>defineMiddleware</code></a></li>
        <li><a href="/docs/guides/redirecting">Redirecting</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <><code>*rest</code> matches zero segments, rules match the canonical path, header rules are stamped on redirect responses, and <code>--check-config</code> lists skipped rules.</> },
        { version: 'v0.1.0-beta.6', changes: 'Introduced.' },
      ]} />
    </>
  );
}
