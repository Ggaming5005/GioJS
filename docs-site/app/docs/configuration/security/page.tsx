import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable, StartupWarnings } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[security]',
  description:
    'Default response headers, HSTS and Content-Security-Policy with per-response nonces, stamped by ' +
    'the Rust server on every response.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[security]</h1>
      <p className="page-subtitle">
        Default response headers, HSTS and Content-Security-Policy with per-response nonces,
        stamped by the Rust server on every response.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[security]
hsts = true
csp = "default-src 'self'; script-src 'self' 'nonce-{nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'"

[security.headers]
permissions-policy = "camera=(), microphone=(), geolocation=()"`} />
      <p>
        Cross-site request protection has its own tables:{' '}
        <a href="/docs/configuration/security-csrf"><code>[security.csrf]</code></a> and{' '}
        <a href="/docs/configuration/security-websocket"><code>[security.websocket]</code></a>.
        The <a href="/docs/security">Security guide</a> explains each protection in depth.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'default_headers', type: 'boolean', default: 'true', zero: <>The three built-in headers are not sent. Warns.</>, description: <>Send <code>X-Content-Type-Options: nosniff</code>, <code>X-Frame-Options: SAMEORIGIN</code> and <code>Referrer-Policy: strict-origin-when-cross-origin</code> on every response. <code>false</code> drops all three; <code>[security.headers]</code> entries are still sent and HSTS keeps its own setting. Turning them off brings back MIME sniffing of uploads, framing by other sites (clickjacking) and full URLs in cross-origin referrers.</> },
        { key: 'headers', type: 'table', default: '{}', zero: <>An empty value removes that header</>, description: <>The <code>[security.headers]</code> table: header name to value. A name that is a default replaces it (<code>x-frame-options = &quot;DENY&quot;</code>), an empty value removes it, and any other name is added to every response (<code>permissions-policy</code>, <code>cross-origin-opener-policy</code>, ...). <code>content-security-policy</code>, <code>content-security-policy-report-only</code> and <code>strict-transport-security</code> are refused here: use <code>csp</code>, <code>csp_report_only</code> and <code>hsts</code>.</> },
        { key: 'hsts', type: 'boolean | string | table', zero: <><code>false</code> or <code>&quot;&quot;</code>: never sent, even with TLS</>, description: <><code>Strict-Transport-Security</code>. Unset: <code>max-age=31536000</code> only while <a href="/docs/configuration/server-tls"><code>[server.tls]</code></a> is on. <code>true</code>: <code>max-age=31536000</code> on every response (TLS terminated by a proxy). A string is sent as written. A table builds the value from the keys below.</> },
        { key: 'hsts.max_age', type: 'integer', default: '31536000', description: <>Seconds browsers remember the policy (one year).</> },
        { key: 'hsts.include_subdomains', type: 'boolean', default: 'false', description: <>Adds <code>includeSubDomains</code>: every subdomain must serve HTTPS too.</> },
        { key: 'hsts.preload', type: 'boolean', default: 'false', description: <>Adds <code>preload</code>, for submission to the browsers&apos; preload lists.</> },
        { key: 'csp', type: 'string', zero: <>Unset or <code>&quot;&quot;</code>: no policy</>, description: <><code>Content-Security-Policy</code>. Every <code>{'{nonce}'}</code> is replaced with a fresh 192-bit nonce per response, which every inline script GioJS writes carries. Line breaks and runs of spaces collapse to one space, so a multi-line TOML string works.</> },
        { key: 'csp_report_only', type: 'string', zero: <>Unset or <code>&quot;&quot;</code>: no policy</>, description: <><code>Content-Security-Policy-Report-Only</code>, same syntax as <code>csp</code>. Browsers report violations without blocking. Both may be set; they share the response&apos;s nonce.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The headers are added as each response leaves the server - pages, cache hits, route
          handlers, static and <code>public/</code> files, redirects, errors and the{' '}
          <code>/_gio</code> endpoints - and are never stored in the page cache, so a change to this
          section reaches cached pages at the next restart.
        </li>
        <li>
          A header the response already has wins: one set by a route handler, by{' '}
          <code>getServerSideProps</code> or by a <a href="/docs/configuration/headers"><code>[[headers]]</code></a>{' '}
          rule. A response header with an empty value removes the default from that response only.
        </li>
        <li><code>X-Powered-By</code> is always removed.</li>
        <li>
          While a policy uses <code>{'{nonce}'}</code>, every page is answered{' '}
          <code>Cache-Control: private, no-cache</code> without an ETag: a shared cache replaying a
          page would hand every visitor the same nonce. The page cache itself keeps working - the
          nonce is substituted into each response, cache hits included.
        </li>
        <li>
          While nonces are on, a dynamic response that sets its own <code>Content-Encoding</code>{' '}
          cannot be checked for the nonce placeholder and is replaced with a <code>500</code>; let
          GioJS compress it instead.
        </li>
      </ul>

      <h3 id="startup-warnings">Startup warnings</h3>
      <StartupWarnings rows={[
        { when: <><code>default_headers = false</code></>, text: '[security] default_headers = false: responses no longer carry x-content-type-options, x-frame-options or referrer-policy (MIME sniffing, clickjacking and full-URL referrers are back) unless [security.headers] sets them' },
      ]} />
      <p>
        Startup also logs one <code>security policy</code> line listing the default header names,
        whether a CSP, report-only CSP and nonces are on, and the CSRF and WebSocket settings.
      </p>

      <h3 id="errors">Errors</h3>
      <p>These stop startup (and fail <code>--check-config</code>):</p>
      <ul>
        <li><code>[security.headers] &quot;bad name&quot; is not a valid header name</code>, and <code>[security.headers] x-foo: invalid header value</code>.</li>
        <li><code>[security.headers] cannot set content-security-policy - use [security] csp instead</code> (likewise for <code>hsts</code> and <code>csp_report_only</code>).</li>
        <li><code>[security] csp: invalid header value</code> for a policy that cannot be a header value (a control character).</li>
        <li>An unknown key anywhere in the section, an <code>hsts</code> table included: <code>unknown key `security.hsts.preloadd` - did you mean `security.hsts.preload`?</code></li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="let-partners-frame-one-section">Let partners frame one section</h3>
      <p>Keep <code>X-Frame-Options</code> everywhere else, and remove it under <code>/embed</code> with a header rule:</p>
      <CodeBlock lang="toml" title="gio.toml" code={`[[headers]]
path = "/embed/*rest"
[headers.headers]
x-frame-options = ""`} />

      <h3 id="hsts-behind-a-tls-proxy">HSTS behind a TLS proxy</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[security]
hsts = { max_age = 63072000, include_subdomains = true }`} />

      <h3 id="roll-out-a-csp-in-report-only-mode">Roll out a CSP in report-only mode</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[security]
csp_report_only = """
  default-src 'self';
  script-src 'self' 'nonce-{nonce}' 'strict-dynamic';
  style-src 'self' 'unsafe-inline';
  object-src 'none'
"""`} />
      <p>
        When the browser console stays quiet, rename the key to <code>csp</code>. Inline scripts
        you write need <code>nonce={'{cspNonce()}'}</code>; see{' '}
        <a href="/docs/functions/csp-nonce"><code>cspNonce</code></a>.
      </p>

      <h3 id="a-cdn-sets-the-headers">A CDN sets the headers</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[security]
default_headers = false        # the CDN adds nosniff, frame options and referrer policy

[security.headers]
x-content-type-options = "nosniff"   # keep this one from the origin anyway`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <code>hsts</code> unset and <code>hsts = false</code> differ: unset still sends HSTS while{' '}
          <code>[server.tls]</code> is on; <code>false</code> never does.
        </li>
        <li>
          Header names in <code>[security.headers]</code> are case-insensitive and values are
          trimmed.
        </li>
        <li>
          Only enable <code>include_subdomains</code> and <code>preload</code> when every subdomain
          serves HTTPS: browsers keep the policy for <code>max_age</code> seconds.
        </li>
      </ul>
      <h3 id="not-configurable">Not configurable</h3>
      <ul>
        <li>
          <strong>CSP stays opt-in.</strong> A policy only you can write (your script and image
          origins), and nonces make every page private, so CDN caching and ETags are lost while it
          is on. See <a href="/docs/guides/content-security-policy">Content Security Policy</a>.
        </li>
        <li>
          <strong>Production errors show only a digest.</strong> A failed render answers a generic
          page with a short error reference; the message and stack go to the server log under the
          same digest.
        </li>
        <li>The nonce length (192 bits) and the removal of <code>X-Powered-By</code>.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/security">Security guide</a></li>
        <li><a href="/docs/configuration/security-csrf"><code>[security.csrf]</code></a> and <a href="/docs/configuration/security-websocket"><code>[security.websocket]</code></a></li>
        <li><a href="/docs/configuration/headers"><code>[[headers]]</code></a> - per-path response headers</li>
        <li><a href="/docs/guides/content-security-policy">Content Security Policy</a> and <a href="/docs/functions/csp-nonce"><code>cspNonce</code></a></li>
        <li><a href="/docs/guides/security-switches">Turning Protections On and Off</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced: default security headers, <code>headers</code>, <code>hsts</code>, <code>csp</code> and <code>csp_report_only</code> with per-response nonces, and <code>default_headers</code>, which logs a warning when turned off.</> },
      ]} />
    </>
  );
}
