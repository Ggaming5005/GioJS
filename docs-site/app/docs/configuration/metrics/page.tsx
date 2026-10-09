import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable, StartupWarnings } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[metrics]',
  description:
    'The Prometheus endpoint /_gio/metrics: off until the section exists, then answering this machine ' +
    'only unless a token or an IP allowlist says who else may scrape it.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[metrics]</h1>
      <p className="page-subtitle">
        The Prometheus endpoint <code>/_gio/metrics</code>: off until the section exists, then
        answering this machine only unless a token or an IP allowlist says who else may scrape it.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[metrics]
token = "a-long-random-secret"         # Authorization: Bearer <token>
ip_allowlist = ["10.0.0.5", "10.1.0.0/16"]`} />
      <p>
        <a href="/docs/observability#metrics">Observability</a> lists the series it exposes. The
        endpoint is served by Rust and never waits for the Node worker.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'enabled', type: 'boolean', default: 'true', zero: <><code>/_gio/metrics</code> answers <code>404</code></>, description: <>Serve the endpoint. The default applies once a <code>[metrics]</code> section exists: with no section at all, metrics are off.</> },
        { key: 'token', type: 'string', default: '""', description: <>Require <code>Authorization: Bearer &lt;token&gt;</code>, compared in constant time. A missing or wrong token gets <code>401</code>.</> },
        { key: 'ip_allowlist', type: 'string[]', default: '[]', zero: <>Empty with no <code>token</code>: loopback clients only. A <code>/0</code> entry with no token warns.</>, description: <>Client IPs or CIDR blocks allowed to scrape; anyone else gets <code>403</code>. The client is the one <a href="/docs/configuration/server"><code>[server] trusted_proxies</code></a> resolves, never the proxy. A malformed entry stops startup.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <table>
        <thead>
          <tr><th>Configuration</th><th>Who may scrape</th></tr>
        </thead>
        <tbody>
          <tr><td>No <code>[metrics]</code> section, or <code>enabled = false</code></td><td>Nobody: <code>404</code></td></tr>
          <tr><td>Neither <code>token</code> nor <code>ip_allowlist</code></td><td>Loopback clients only; others get <code>403</code></td></tr>
          <tr><td><code>token</code> only</td><td>Any client with the token; without it <code>401</code></td></tr>
          <tr><td><code>ip_allowlist</code> only</td><td>Listed clients; others <code>403</code></td></tr>
          <tr><td>Both</td><td>Listed clients that also send the token</td></tr>
        </tbody>
      </table>
      <ul>
        <li>
          The answer is <code>text/plain; version=0.0.4</code>, the Prometheus text format.
        </li>
        <li>
          In loopback-only mode, a request that carries <code>X-Forwarded-For</code>,{' '}
          <code>Forwarded</code> or <code>X-Real-IP</code> from a peer outside{' '}
          <code>trusted_proxies</code> is refused: a reverse proxy on the same machine would
          otherwise make every client look local. A proxy that sends none of those headers still
          does, so list a local proxy in <code>trusted_proxies</code>. Startup says so whenever
          metrics are loopback-only and <code>trusted_proxies</code> is empty.
        </li>
        <li>
          A trusted proxy whose forwarding header does not name a client (<code>unknown</code>) gets{' '}
          <code>403</code> from the allowlist: an unknown client is never admitted.
        </li>
      </ul>

      <h3 id="startup-warnings">Startup warnings</h3>
      <StartupWarnings rows={[
        { when: <><code>ip_allowlist</code> has a <code>/0</code> and no <code>token</code> is set</>, text: "[metrics] ip_allowlist includes 0.0.0.0/0 and no token is set: /_gio/metrics is open to every client of that family - set [metrics] token, or list only your scrapers' addresses" },
      ]} />

      <h2 id="examples">Examples</h2>
      <h3 id="scrape-from-the-same-machine">Scrape from the same machine</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[metrics]`} />
      <CodeBlock lang="bash" code={`curl http://127.0.0.1:3000/_gio/metrics`} />

      <h3 id="scrape-with-a-token">Scrape with a token</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[metrics]
token = "a-long-random-secret"`} />
      <CodeBlock lang="yaml" title="prometheus.yml" code={`scrape_configs:
  - job_name: giojs
    metrics_path: /_gio/metrics
    authorization:
      credentials: a-long-random-secret
    static_configs:
      - targets: ["app.internal:3000"]`} />

      <h3 id="open-to-everyone">Open to everyone</h3>
      <p>Say so explicitly - startup then warns:</p>
      <CodeBlock lang="toml" title="gio.toml" code={`[metrics]
ip_allowlist = ["0.0.0.0/0", "::/0"]`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <code>gio.toml</code> holds the token in plain text; error messages and{' '}
          <code>--check-config</code> never print it.
        </li>
        <li>Metrics are per server instance; scrape every instance.</li>
        <li>
          A malformed entry (<code>&quot;10.0.0.0/33&quot;</code>) is a startup error:{' '}
          <code>invalid ip_allowlist entry &quot;10.0.0.0/33&quot;: expected an IP address or CIDR block such as &quot;10.0.0.1&quot;, &quot;10.0.0.0/8&quot; or &quot;fd00::/8&quot;</code>.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/observability#metrics">Observability: Metrics</a></li>
        <li><a href="/docs/configuration/health"><code>[health]</code></a></li>
        <li><a href="/docs/endpoints">Endpoints</a></li>
        <li><a href="/docs/configuration#health-and-metrics">Health &amp; metrics on the overview</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Without a <code>token</code> or <code>ip_allowlist</code> the endpoint answers loopback clients only (it used to answer everyone, with a warning). <code>ip_allowlist</code> accepts CIDR blocks, checks the client behind trusted proxies, and a malformed entry stops startup. An allowlist open to everyone with no token logs a warning.</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced with <code>enabled</code>, <code>token</code> and <code>ip_allowlist</code>.</> },
      ]} />
    </>
  );
}
