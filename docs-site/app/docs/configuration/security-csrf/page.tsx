import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable, StartupWarnings } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[security.csrf]',
  description:
    'Cross-site request protection: unsafe requests from other sites are refused in Rust before ' +
    'the body is read or any app code runs.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[security.csrf]</h1>
      <p className="page-subtitle">
        Cross-site request protection: unsafe requests from other sites are refused in Rust before
        the body is read or any app code runs.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[security.csrf]
trusted_origins = ["https://admin.example.com"]
exempt = ["/api/webhooks/*rest", "/auth/callback/apple"]`} />
      <p>
        On by default with no configuration. It covers every method except <code>GET</code>,{' '}
        <code>HEAD</code>, <code>OPTIONS</code> and <code>TRACE</code> - page actions, route
        handlers, form posts - and its two lists also apply to the{' '}
        <a href="/docs/configuration/security-websocket">WebSocket origin check</a>.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'enabled', type: 'boolean', default: 'true', zero: <>No check on unsafe methods. Warns.</>, description: <>Check unsafe requests. <code>false</code> lets any website send form posts and other state-changing requests with your visitors&apos; cookies; only turn it off when every form carries its own CSRF token. The WebSocket origin check stays on.</> },
        { key: 'trusted_origins', type: 'string[]', default: '[]', description: <>Other origins allowed to send unsafe requests and open WebSockets, as <code>scheme://host[:port]</code> (<code>https://admin.example.com</code>). The scheme is <code>http</code> or <code>https</code>; a path, query or user info is a startup error. A missing port is the scheme&apos;s default.</> },
        { key: 'exempt', type: 'string[]', default: '[]', description: <>Paths that skip the check entirely, for endpoints other sites call on purpose: webhooks that send an <code>Origin</code>, OAuth/OIDC <code>response_mode=form_post</code> callbacks (Sign in with Apple, Microsoft Entra ID), SAML assertion consumer services, 3-D Secure returns. Patterns use the <a href="/docs/middleware#pattern-language">rule syntax</a> (<code>/api/webhooks/*rest</code>, <code>/hooks/:id</code>) and match the canonical path.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <p>Each unsafe request is judged on headers browsers attach, in this order:</p>
      <table>
        <thead>
          <tr><th>Request</th><th>Result</th></tr>
        </thead>
        <tbody>
          <tr><td>Path listed in <code>exempt</code></td><td>Not checked</td></tr>
          <tr><td><code>Origin</code> listed in <code>trusted_origins</code></td><td>Allowed</td></tr>
          <tr><td><code>Sec-Fetch-Site: same-origin</code> or <code>none</code> (typed URL, bookmark)</td><td>Allowed</td></tr>
          <tr><td><code>Sec-Fetch-Site: cross-site</code> or <code>same-site</code></td><td><code>403</code></td></tr>
          <tr><td>No <code>Sec-Fetch-Site</code>, <code>Origin</code> names the host the client addressed</td><td>Allowed</td></tr>
          <tr><td>No <code>Sec-Fetch-Site</code>, any other <code>Origin</code> (<code>null</code> included)</td><td><code>403</code></td></tr>
          <tr><td>Neither header (curl, server-to-server webhooks)</td><td>Allowed: not sent by a browser page, so not forgeable by one</td></tr>
        </tbody>
      </table>
      <ul>
        <li>
          The host the client addressed is the <code>Host</code> header, or a trusted proxy&apos;s{' '}
          <code>X-Forwarded-Host</code> / <code>Forwarded: host=</code> (see{' '}
          <a href="/docs/configuration/server"><code>[server] trusted_proxies</code></a>).
        </li>
        <li>
          A refused request gets <code>403</code> with <code>Cache-Control: no-store</code> and a
          plain-text body naming the keys to change:
        </li>
      </ul>
      <CodeBlock lang="text" code={`403 Forbidden: cross-site POST blocked by CSRF protection - the browser sent it from https://evil.example (cross-site).
If that origin is yours, add it to [security.csrf] trusted_origins in gio.toml; to accept cross-site requests on a path (webhooks, OAuth/OIDC form_post or SAML callbacks, 3-D Secure payment returns), add the path to [security.csrf] exempt.`} />
      <ul>
        <li>
          Each refused origin is logged once at <code>warn</code> level (up to 64 distinct ones),
          then at <code>debug</code>, so a page looping forged requests cannot flood the log.
        </li>
        <li>
          Rust&apos;s own <code>/_gio</code> endpoints are not covered: they have their own checks
          (the revalidation endpoint uses a bearer token).
        </li>
      </ul>

      <h3 id="startup-warnings">Startup warnings</h3>
      <StartupWarnings rows={[
        { when: <><code>enabled = false</code></>, text: "[security.csrf] enabled = false: any website can send form posts and other unsafe requests to this server with your visitors' cookies - prefer listing origins in [security.csrf] trusted_origins, or public endpoints in [security.csrf] exempt" },
      ]} />

      <h3 id="errors">Errors</h3>
      <ul>
        <li><code>[security.csrf] trusted_origins entry &quot;admin.example.com&quot; is not an origin such as &quot;https://admin.example.com&quot; (scheme http or https, no path)</code></li>
        <li><code>[security.csrf] exempt entry &quot;api/webhooks&quot;: pattern must start with &apos;/&apos;: api/webhooks</code></li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="an-admin-app-on-another-origin">An admin app on another origin</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[security.csrf]
trusted_origins = ["https://admin.example.com", "http://localhost:5173"]`} />

      <h3 id="sign-in-with-apple-form-post-callback">Sign in with Apple form_post callback</h3>
      <p>
        Apple posts the user&apos;s browser back to your callback from its own site, so the
        browser labels the request <code>cross-site</code>. Exempt the path; the handler verifies
        the <code>state</code> and the token itself:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[security.csrf]
exempt = ["/auth/callback/apple"]`} />

      <h3 id="forms-with-their-own-tokens">Forms with their own tokens</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[security.csrf]
enabled = false          # every form posts a token the app verifies (logs a warning)`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          The check runs before the body is read, before rules, routing and Node - a forged request
          never costs a render. It runs inside rate limiting, so forged requests still use up
          budget.
        </li>
        <li>
          Behind a proxy that rewrites <code>Host</code> to an internal name, every same-origin
          browser request looks cross-origin. Pass the host through (nginx{' '}
          <code>proxy_set_header Host $host</code>), or list the proxy in{' '}
          <code>trusted_proxies</code> so its <code>X-Forwarded-Host</code> counts.
        </li>
        <li>
          Keep <code>GET</code> handlers free of side effects and keep session cookies{' '}
          <code>SameSite=Lax</code>: the check covers unsafe methods only.
        </li>
      </ul>
      <h3 id="not-configurable">Not configurable</h3>
      <ul>
        <li>
          <code>Sec-Fetch-Site: same-site</code> is refused like <code>cross-site</code>: a sibling
          subdomain can be controlled by someone else. List such origins in{' '}
          <code>trusted_origins</code>.
        </li>
        <li>Requests with neither <code>Sec-Fetch-Site</code> nor <code>Origin</code> always pass.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/security#csrf">Security guide: CSRF protection</a></li>
        <li><a href="/docs/configuration/security-websocket"><code>[security.websocket]</code></a></li>
        <li><a href="/docs/configuration/security"><code>[security]</code></a></li>
        <li><a href="/docs/forms">Forms &amp; Mutations</a></li>
        <li><a href="/docs/guides/security-switches">Turning Protections On and Off</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced, on by default. <code>enabled = false</code> logs a startup warning.</> },
      ]} />
    </>
  );
}
