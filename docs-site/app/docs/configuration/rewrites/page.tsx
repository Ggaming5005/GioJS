import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[[rewrites]]',
  description: 'Serve another route under the requested URL: the browser keeps its address, routing and the cache see the target.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[[rewrites]]</h1>
      <p className="page-subtitle">
        Serve another route under the requested URL: the browser keeps its address, routing and the
        cache see the target.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[[rewrites]]
from = "/latest"
to = "/posts/newest"`} />

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'from', type: 'string', required: true, description: <>The path pattern: literal segments, <code>:param</code> and a final <code>*rest</code>. Must start with <code>/</code>.</> },
        { key: 'to', type: 'string', required: true, description: <>The path of the route to serve, starting with <code>/</code>. It may use the pattern&apos;s captures by name.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The request is routed as if the client had asked for <code>to</code>: the page, its{' '}
          <code>getServerSideProps</code> and the page cache key all use the target path. The query
          string is kept.
        </li>
        <li>
          Rewrites run after guards and redirects, and the first matching rule wins (gio.toml
          before <code>middleware.ts</code>).
        </li>
        <li>
          Guards and <a href="/docs/configuration/headers"><code>[[headers]]</code></a> rules match
          the requested path, not the target: protect and decorate the URL people see.
        </li>
        <li>
          A target inside <code>/_gio</code> answers <code>404</code>: the rewrite cannot reach the
          server&apos;s own endpoints.
        </li>
      </ul>

      <h3 id="invalid-rules">Invalid rules</h3>
      <p>A rule that cannot be compiled stops startup with the file, line and reason, and <code>--check-config</code> reports it under <code>errors</code>:</p>
      <CodeBlock lang="text" code={`gio.toml:7: invalid [[rewrites]] entry for "/a/:id": target references unknown capture 'slug'`} />

      <h2 id="examples">Examples</h2>
      <h3 id="a-friendly-url-for-a-dynamic-route">A friendly URL for a dynamic route</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[rewrites]]
from = "/u/:user"
to = "/users/:user/profile"`} />
      <p>
        <code>/u/alice</code> renders <code>app/users/[user]/profile/page.tsx</code> with{' '}
        <code>user = &quot;alice&quot;</code>, and the address bar keeps <code>/u/alice</code>. A
        capture is always a whole segment: <code>/@:user</code> would be a literal segment.
      </p>

      <h3 id="serve-old-urls-from-new-pages">Serve old URLs from new pages</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[rewrites]]
from = "/guide/*rest"
to = "/docs/*rest"`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>Only paths on this server: rewrites do not proxy to another host.</li>
        <li>Prefer a <a href="/docs/configuration/redirects">redirect</a> when the old URL should disappear from search engines and bookmarks.</li>
        <li>A <code>public/</code> file at the requested path is not served once a rewrite matched it.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/middleware">Middleware</a></li>
        <li><a href="/docs/configuration/redirects"><code>[[redirects]]</code></a>, <a href="/docs/configuration/headers"><code>[[headers]]</code></a> and <a href="/docs/configuration/guards"><code>[[guards]]</code></a></li>
        <li><a href="/docs/file-conventions/dynamic-routes">Dynamic routes</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <><code>*rest</code> matches zero segments and rules match the canonical path.</> },
        { version: 'v0.1.0-beta.6', changes: 'Introduced.' },
      ]} />
    </>
  );
}
