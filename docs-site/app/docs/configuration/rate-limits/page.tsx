import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable, StartupWarnings } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[[rate_limits]]',
  description:
    'Token-bucket request budgets per client and path, enforced in Rust before routing: a refused ' +
    'request gets 429 and never reaches Node.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[[rate_limits]]</h1>
      <p className="page-subtitle">
        Token-bucket request budgets per client and path, enforced in Rust before routing: a refused
        request gets <code>429</code> and never reaches Node.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[[rate_limits]]
path = "/api/*rest"
per_ip = 100
window_seconds = 60
burst = 20

[[rate_limits]]
path = "/api/login"
per_ip = 5
window_seconds = 60
burst = 0`} />
      <p>There are no rate limits by default. Each table is one rule; add as many as you need.</p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'path', type: 'string', required: true, description: <>The paths the rule covers, in the <a href="/docs/middleware#pattern-language">pattern syntax</a> the other path rules use: literal segments, <code>:param</code> for one segment, and a trailing <code>*rest</code> catch-all (<code>/api/*rest</code>, which also covers <code>/api</code> itself). Without a catch-all the match is exact (<code>/api/login</code>). The older spellings still work: <code>/api/*</code> is the same as <code>/api/*rest</code>, and <code>/api*</code> covers every path starting with <code>/api</code> (<code>/apiary</code> too). A path that cannot be parsed stops startup.</> },
        { key: 'per_ip', type: 'integer', default: '100', zero: <>No refill: only <code>burst</code> requests, ever</>, description: <>Requests per <code>window_seconds</code> per client: the bucket refills at this rate.</> },
        { key: 'window_seconds', type: 'integer', default: '60', zero: <>Treated as 1 second</>, description: <>The window <code>per_ip</code> is counted over.</> },
        { key: 'burst', type: 'integer', default: '20', description: <>Extra requests on top of <code>per_ip</code>: a new client&apos;s bucket holds <code>per_ip + burst</code> tokens.</> },
        { key: 'key_header', type: 'string', description: <>Key buckets on this request header&apos;s value (an API key) as well as the client. Case-insensitive name; the first 64 bytes of the value count. A request without the header uses the client&apos;s own bucket.</> },
        { key: 'max_keys_per_client', type: 'integer', default: '64', zero: <>Unlimited. Warns.</>, description: <>With <code>key_header</code>: distinct header values one client may hold a budget for. Further values share the client&apos;s own bucket, so rotating the header cannot mint fresh budgets. Raise it, or set <code>0</code>, for an API gateway whose many keys arrive from one address.</> },
      ]} />
      <p>
        The total number of live buckets is capped by{' '}
        <a href="/docs/configuration/server"><code>[server] rate_limit_max_buckets</code></a>{' '}
        (100000).
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>One rule per request.</strong> The rule whose segments cover most of the path
          before its wildcard wins; on a tie an exact rule beats a wildcard, then more literal text
          beats a <code>:param</code> (<code>/users/me</code> over <code>/users/:id</code>). Above,{' '}
          <code>/api/login</code> uses its own rule and every other <code>/api</code> path the
          general one.
        </li>
        <li>
          <strong>Before the rules.</strong> Limits run before the CSRF check, guards, redirects
          and rewrites, so a flood of refused or redirected requests still spends budget. With <code>[i18n]</code> on, they match the path without
          its locale prefix: a <code>/api/*rest</code> rule also covers <code>/de/api/x</code>.
        </li>
        <li>
          <strong>Canonical paths.</strong> Requests are matched with repeated and trailing slashes
          collapsed and unreserved escapes decoded, so <code>/api/login/</code>,{' '}
          <code>//api//login</code> and <code>/api/%6Cogin</code> share one bucket.
        </li>
        <li>
          <strong>A client</strong> is an IPv4 address or an IPv6 /64 (IPv6 hosts control a whole
          /64), after <code>[server] trusted_proxies</code> resolution.
        </li>
        <li>
          <strong>Headers.</strong> An admitted response carries <code>X-RateLimit-Limit</code>,
          the bucket&apos;s size (<code>per_ip + burst</code>), and{' '}
          <code>X-RateLimit-Remaining</code>, the requests left in it (at most the limit). A
          refused one looks like this, for a <code>per_ip = 3</code>, <code>burst = 0</code>{' '}
          rule (other headers left out):
        </li>
      </ul>
      <CodeBlock lang="text" code={`HTTP/1.1 429 Too Many Requests
content-type: application/json
retry-after: 20
x-ratelimit-limit: 3
x-ratelimit-remaining: 0
x-gio-refused: unread

{"error":"rate limit exceeded"}`} />
      <ul>
        <li>
          <code>Retry-After</code> is <code>window_seconds / per_ip</code> (at least 1): the time one
          token takes to come back. <code>x-gio-refused: unread</code> tells{' '}
          <code>&lt;GioForm&gt;</code> the submission never reached the app.
        </li>
        <li>
          Rust&apos;s own <code>/_gio</code> endpoints are not limited, except{' '}
          <code>/_gio/image</code>, the most expensive one. A <code>public/</code> file answered at the
          site root is also held to rules written for its <code>/public/...</code> URL, charged once.
        </li>
        <li>Each refusal is logged at <code>warn</code> with the client, path and rule, and counted in the metrics.</li>
      </ul>

      <h3 id="startup-errors">Startup errors</h3>
      <p>
        A <code>path</code> that cannot be parsed stops startup, and{' '}
        <a href="/docs/cli/giojs-server#check-config"><code>--check-config</code></a> reports it: one
        that does not start with <code>/</code>, a <code>*rest</code> that is not the last segment, or
        a <code>*</code> anywhere but the end.
      </p>
      <CodeBlock lang="text" code={`gio.toml:12: invalid \`rate_limits[1].path\`: path "api/*rest" must start with '/'`} />

      <h3 id="startup-warnings">Startup warnings</h3>
      <StartupWarnings rows={[
        { when: <><code>max_keys_per_client = 0</code> on a rule with <code>key_header</code></>, text: '[[rate_limits]] /api/*: max_keys_per_client = 0 - one client can mint a fresh budget for every key_header value it sends' },
        { when: <><code>[server] rate_limit_max_buckets = 0</code> with any rule</>, text: '[server] rate_limit_max_buckets = 0: rate-limit buckets are never evicted - clients rotating addresses grow memory without bound' },
      ]} />

      <h2 id="examples">Examples</h2>
      <h3 id="slow-down-login-attempts">Slow down login attempts</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[rate_limits]]
path = "/login"
per_ip = 10
window_seconds = 900      # 10 per 15 minutes
burst = 0`} />

      <h3 id="per-api-key-budgets">Per API key budgets</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[rate_limits]]
path = "/api/*rest"
per_ip = 600
window_seconds = 60
key_header = "x-api-key"
max_keys_per_client = 256   # a partner's gateway sends many keys from one address`} />

      <h3 id="protect-the-image-optimizer">Protect the image optimizer</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[[rate_limits]]
path = "/_gio/image"
per_ip = 120
window_seconds = 60`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <code>per_ip = 0</code> is not an off switch: with <code>burst = 0</code> it refuses every
          request to the path. Remove the rule to stop limiting.
        </li>
        <li>
          Buckets that have refilled are dropped every minute; a new bucket starts full, so nothing
          is lost.
        </li>
        <li>
          Limits are per server instance. Behind a load balancer each instance counts on its own.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/configuration#rate-limits">Rate limits on the overview</a></li>
        <li><a href="/docs/configuration/server"><code>[server]</code></a> - <code>trusted_proxies</code> and <code>rate_limit_max_buckets</code></li>
        <li><a href="/docs/configuration/prefetch"><code>[prefetch]</code></a> - budgets for prefetch requests</li>
        <li><a href="/docs/observability#metrics">Metrics</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Added <code>max_keys_per_client</code>. <code>path</code> takes the rule pattern syntax (<code>:param</code>, <code>*rest</code>; a <code>/api/*rest</code> rule used to match nothing), and a path that cannot be parsed stops startup. Paths match the canonical request path, and <code>/api/*</code> also covers <code>/api</code>. Clients are resolved through trusted proxies, and the bucket store is capped by <code>[server] rate_limit_max_buckets</code>. <code>X-RateLimit-Limit</code> is <code>per_ip + burst</code> (it was <code>per_ip</code>, below what <code>X-RateLimit-Remaining</code> could show), and a refusal carries <code>X-Gio-Cache: bypass</code>.</> },
        { version: 'v0.1.0-beta.6', changes: <><code>/_gio/image</code> honors the rules.</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced with <code>path</code>, <code>per_ip</code>, <code>window_seconds</code>, <code>burst</code> and <code>key_header</code>.</> },
      ]} />
    </>
  );
}
