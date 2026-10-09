import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[server.tls]',
  description: 'Terminate TLS in the GioJS server itself, from a PEM certificate chain and private key.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[server.tls]</h1>
      <p className="page-subtitle">
        Terminate TLS in the GioJS server itself, from a PEM certificate chain and private key.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[server]
port = 443

[server.tls]
enabled = true
cert_path = "/etc/letsencrypt/live/example.com/fullchain.pem"
key_path  = "/etc/letsencrypt/live/example.com/privkey.pem"`} />
      <p>
        TLS is off by default: most deployments terminate it in a reverse proxy, load balancer or
        CDN. Turn it on when the server faces clients directly.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'enabled', type: 'boolean', default: 'false', zero: 'Plain HTTP', description: <>Serve HTTPS on <code>[server] host</code> and <code>port</code>. The listener then speaks only TLS: there is no second port for plain HTTP and no redirect from it.</> },
        { key: 'cert_path', type: 'string', description: <>The certificate chain, PEM-encoded: the server certificate first, then the intermediates (a Let&apos;s Encrypt <code>fullchain.pem</code>). Required when <code>enabled = true</code>.</> },
        { key: 'key_path', type: 'string', description: <>The private key, PEM-encoded: PKCS#8 (<code>BEGIN PRIVATE KEY</code>), PKCS#1 RSA (<code>BEGIN RSA PRIVATE KEY</code>) or SEC1 EC (<code>BEGIN EC PRIVATE KEY</code>). Required when <code>enabled = true</code>.</> },
      ]} />
      <p>
        Relative paths resolve against the directory the server is started from, not the project
        root; absolute paths avoid surprises. The handshake deadline is{' '}
        <a href="/docs/configuration/server"><code>[server] tls_handshake_timeout_secs</code></a>{' '}
        (10 seconds).
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The certificate and key are loaded and checked at startup, before the Node worker
          starts. Any problem stops the server, and <code>giojs-server --check-config</code>{' '}
          reports the same error without starting it.
        </li>
        <li>
          TLS 1.2 and 1.3 are accepted, and ALPN offers <code>h2</code> and{' '}
          <code>http/1.1</code>.
        </li>
        <li>
          With TLS on, every response carries{' '}
          <code>Strict-Transport-Security: max-age=31536000</code> unless{' '}
          <a href="/docs/security#hsts"><code>[security] hsts</code></a> says
          otherwise, requests that reach the server directly have the scheme <code>https</code>{' '}
          (<code>req.scheme</code>, <code>ctx.scheme</code>), and <code>/_gio/health</code> reports{' '}
          <code>&quot;tls&quot;: true</code>.
        </li>
      </ul>

      <h3 id="errors">Errors</h3>
      <p>Startup stops with one of these after <code>giojs-server: configuration error:</code>:</p>
      <table>
        <thead>
          <tr><th>Message</th><th>Cause</th></tr>
        </thead>
        <tbody>
          <tr><td><code>TLS enabled but cert_path not set in gio.toml</code></td><td><code>enabled = true</code> without <code>cert_path</code> (<code>key_path</code> likewise).</td></tr>
          <tr><td><code>TLS enabled but cert not found at &lt;path&gt;</code></td><td>The file cannot be opened (<code>key not found</code> for the key).</td></tr>
          <tr><td><code>Failed to parse cert at &lt;path&gt;: ...</code></td><td>A PEM block in the certificate file is malformed (<code>Failed to parse key</code> for the key).</td></tr>
          <tr><td><code>No private key found at &lt;path&gt;</code></td><td>The key file holds no PKCS#8, PKCS#1 or SEC1 key (a certificate passed as the key, a file that is not PEM).</td></tr>
          <tr><td><code>Invalid TLS certificate/key: ...</code></td><td>The key does not match the certificate, the certificate is unusable, or the certificate file holds no certificate at all (<code>Invalid TLS certificate/key: peer sent no certificates</code>).</td></tr>
        </tbody>
      </table>

      <h2 id="examples">Examples</h2>
      <h3 id="a-self-signed-certificate-for-local-https">A self-signed certificate for local HTTPS</h3>
      <CodeBlock lang="bash" code={`openssl req -x509 -newkey rsa:2048 -nodes -days 30 \\
  -keyout certs/key.pem -out certs/cert.pem -subj "/CN=localhost"`} />
      <CodeBlock lang="toml" title="gio.toml" code={`[server]
host = "127.0.0.1"
port = 3443

[server.tls]
enabled = true
cert_path = "certs/cert.pem"   # relative to the directory the server starts in
key_path  = "certs/key.pem"`} />
      <CodeBlock lang="bash" code={`curl -k https://127.0.0.1:3443/_gio/health
# {"cacheEntries":0,...,"status":"ok","tls":true,...}`} />

      <h3 id="tls-terminated-by-a-proxy">TLS terminated by a proxy</h3>
      <p>
        Leave <code>[server.tls]</code> off, trust the proxy so its{' '}
        <code>X-Forwarded-Proto: https</code> counts, and send HSTS yourself - GioJS cannot see that
        the site is HTTPS-only:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[server]
trusted_proxies = ["127.0.0.1"]

[security]
hsts = true`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          The certificate is read once, at startup. After renewing it (certbot, acme.sh), restart
          the server.
        </li>
        <li>
          A plain <code>http://</code> request to the TLS port fails the handshake; nothing
          redirects it. Put a redirecting proxy on port 80 if you need one.
        </li>
        <li>
          The handshake offers <code>h2</code> and <code>http/1.1</code> in ALPN, or only{' '}
          <code>http/1.1</code> with <a href="/docs/configuration/server"><code>[server] http2 = false</code></a>.
        </li>
        <li>
          Binding port 443 needs privileges: run behind a proxy, grant the binary{' '}
          <code>CAP_NET_BIND_SERVICE</code>, or map the port in your container runtime.
        </li>
      </ul>
      <h3 id="not-configurable">Not configurable</h3>
      <ul>
        <li>Protocol versions (TLS 1.2 and 1.3) and cipher suites are rustls&apos; safe defaults.</li>
        <li>Client certificates (mutual TLS) are not requested.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/configuration/server"><code>[server]</code></a> - <code>tls_handshake_timeout_secs</code> and the listen address</li>
        <li><a href="/docs/security#hsts"><code>[security] hsts</code></a></li>
        <li><a href="/docs/deployment">Proxies, Sizing &amp; Scaling</a></li>
        <li><a href="/docs/guides/production-checklist">Production Checklist</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>The certificate and key are checked at startup before the worker starts, every problem is reported at once, and <code>--check-config</code> runs the same check. HSTS is sent by default while TLS is on. <code>[server] http2 = false</code> drops <code>h2</code> from ALPN (it used to be offered anyway, and clients that picked it could not connect).</> },
        { version: 'v0.1.0-beta.1', changes: 'Introduced.' },
      ]} />
    </>
  );
}
