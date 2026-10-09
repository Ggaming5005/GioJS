import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable, StartupWarnings } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[server]',
  description:
    'The listener, connection limits and timeouts, request body limit, reverse proxies, request ids, ' +
    'render workers and skew protection of the Rust server.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[server]</h1>
      <p className="page-subtitle">
        The listener, connection limits and timeouts, request body limit, reverse proxies, request
        ids, render workers and skew protection of the Rust server.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[server]
host = "0.0.0.0"
port = 3000
trusted_proxies = ["10.0.0.0/8"]   # your load balancer
workers = "auto"`} />
      <p>
        Every key is optional and a partial table keeps the defaults for the rest. TLS has its own
        table, <a href="/docs/configuration/server-tls"><code>[server.tls]</code></a>.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'host', type: 'string', default: '"0.0.0.0"', env: 'GIO_HOST', description: <>The IP address to bind: <code>0.0.0.0</code> (every interface), <code>127.0.0.1</code> (this machine only), or IPv6 in brackets (<code>[::]</code>, <code>[::1]</code>). A hostname such as <code>localhost</code> is a startup error. See <a href="/docs/configuration#listen-address">Listen address</a>.</> },
        { key: 'port', type: 'integer', default: '3000', env: 'GIO_PORT, then PORT', description: <>The port to bind, 0 to 65535. <code>GIO_PORT</code> wins, then <code>PORT</code> (set by Heroku, Render, Railway, Fly.io and Cloud Run), then this key. The startup log names where the port came from.</> },
        { key: 'http2', type: 'boolean', default: 'true', zero: <>HTTP/1.1 only</>, description: <>Serve HTTP/2 as well as HTTP/1.1. Without TLS a client must speak HTTP/2 with prior knowledge (h2c); browsers only use HTTP/2 over TLS. With <code>[server.tls]</code> on, <code>false</code> also drops <code>h2</code> from the TLS handshake (ALPN), so clients settle on HTTP/1.1.</> },
        { key: 'max_body_bytes', type: 'integer', default: '2097152', zero: <>No limit of its own; the 64 MiB worker message cap (about 48 MiB of binary body) is the ceiling. Warns.</>, description: <>Largest request body, in bytes (2 MiB). A bigger one is answered <code>413 Payload Too Large</code> before any handler runs. Every body is buffered in memory before the worker sees it, so raising this raises memory per request.</> },
        { key: 'max_connections', type: 'integer', default: '10000', zero: <>Unlimited. Warns.</>, description: <>Concurrent TCP connections. At the cap the server stops accepting, and new clients wait in the kernel backlog until a connection closes. Upgraded WebSockets do not count here (<a href="/docs/configuration/websocket"><code>[websocket] max_connections</code></a> caps them). Keep <code>ulimit -n</code> above it.</> },
        { key: 'tls_handshake_timeout_secs', type: 'integer', default: '10', zero: 'No deadline', description: <>Deadline for a TLS handshake when <a href="/docs/configuration/server-tls"><code>[server.tls]</code></a> is on. A client that stalls is disconnected.</> },
        { key: 'header_read_timeout_secs', type: 'integer', default: '10', zero: 'No deadline', description: <>Deadline for receiving a complete request head (the slowloris guard). It also bounds how long a new connection may wait for its first request and, because the timer restarts while an HTTP/1.1 connection is idle, it is the HTTP/1.1 keep-alive idle timeout.</> },
        { key: 'request_body_timeout_secs', type: 'integer', default: '30', zero: 'No deadline', description: <>Deadline for receiving a whole request body. A client that sends it too slowly gets <code>408 Request Timeout</code>.</> },
        { key: 'render_timeout_secs', type: 'integer', default: '30', zero: <>No deadline. Warns.</>, description: <>Deadline for the Node worker&apos;s answer: a whole buffered response, the head of a streamed one, and every gap between its chunks. Past it the request gets <code>504</code>, or a streamed body ends where it is. Server-sent event streams are not bounded by it.</> },
        { key: 'idle_timeout_secs', type: 'integer', default: '60', zero: 'Never closed for idleness', description: <>Close a connection with no request in flight for this long (gracefully, with GOAWAY, for HTTP/2). In practice it reaps HTTP/2 connections; HTTP/1.1 ones are closed by <code>header_read_timeout_secs</code> first. Streaming and SSE responses count as in flight.</> },
        { key: 'http2_max_concurrent_streams', type: 'integer', default: '250', zero: 'No limit advertised', description: <>Concurrent requests (streams) one HTTP/2 connection may carry.</> },
        { key: 'http2_keep_alive_interval_secs', type: 'integer', default: '20', zero: 'No pings', description: <>Send an HTTP/2 PING this often; a peer that does not answer within <code>http2_keep_alive_timeout_secs</code> is closed.</> },
        { key: 'http2_keep_alive_timeout_secs', type: 'integer', default: '20', zero: 'No pings', description: <>How long a PING may go unanswered. Setting either keep-alive key to <code>0</code> turns the pings off.</> },
        { key: 'trusted_proxies', type: 'string[]', default: '[]', zero: <>Empty: trust nobody. A <code>/0</code> entry warns.</>, description: <>Reverse proxies (IPs or CIDR blocks, IPv4 and IPv6) whose forwarding headers name the client, scheme and host. A malformed entry is a startup error. See <a href="/docs/configuration#reverse-proxies">Reverse proxies &amp; client IPs</a>.</> },
        { key: 'proxy_headers', type: 'string', default: '"x-forwarded"', description: <><code>&quot;x-forwarded&quot;</code> reads <code>X-Forwarded-For</code>, <code>-Proto</code> and <code>-Host</code>; <code>&quot;forwarded&quot;</code> reads the RFC 7239 <code>Forwarded</code> header. Exactly one family is read, and only from a trusted proxy.</> },
        { key: 'accept_request_id', type: 'boolean', default: 'true', zero: <>Every id is generated here</>, description: <>Keep a valid <code>X-Request-Id</code> a trusted proxy sends. Turn it off behind proxies that pass a client&apos;s own header through (AWS ALB, Google Cloud&apos;s load balancer). See <a href="/docs/configuration#request-ids">Request IDs</a>.</> },
        { key: 'skew_protection', type: 'boolean', default: 'true', zero: <>The <code>x-deployment-id</code> header is ignored. Warns.</>, description: <>Answer a client navigation or prefetch from another deployment (its <code>x-deployment-id</code> differs from the server&apos;s) with <code>409</code> and <code>x-gio-action: hard-reload</code>, so the browser loads the new version with a full page load.</> },
        { key: 'workers', type: 'integer | "auto"', default: '1', description: <>Node render processes: a count from 1 to 64, or <code>&quot;auto&quot;</code> for one per CPU core, at most 8. Development always runs one. See <a href="/docs/configuration#render-workers">Render workers</a>.</> },
        { key: 'rate_limit_max_buckets', type: 'integer', default: '100000', zero: <>Unlimited. Warns when <code>[[rate_limits]]</code> rules exist.</>, description: <>Live <a href="/docs/configuration/rate-limits"><code>[[rate_limits]]</code></a> buckets kept across all rules and clients. Past it, refilled buckets are dropped first, then the least recently seen.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>Refusals before any handler runs.</strong> A body over{' '}
          <code>max_body_bytes</code> gets <code>413 Payload Too Large</code> with{' '}
          <code>x-gio-refused: unread</code>, which tells <code>&lt;GioForm&gt;</code> the
          submission never reached the app. A body that arrives too slowly gets{' '}
          <code>408 Request Timeout</code>.
        </li>
        <li>
          <strong>Keep-alive hint.</strong> HTTP/1.1 responses carry{' '}
          <code>Keep-Alive: timeout=N</code>, where N is the smaller of{' '}
          <code>header_read_timeout_secs</code> and <code>idle_timeout_secs</code>, so clients stop
          reusing a connection before the server closes it.
        </li>
        <li>
          <strong>Long responses are never cut by the connection deadlines.</strong> Streaming SSR,
          SSE streams, streamed route handler bodies and WebSockets stay open as long as they run.
          Only <code>render_timeout_secs</code> applies to a stream, between its chunks.
        </li>
        <li>
          <strong>Skew protection</strong> only looks at requests that carry{' '}
          <code>x-deployment-id</code>, which only the GioJS client runtime sends (soft navigations
          and prefetches). A full page load never gets a <code>409</code>.
        </li>
        <li>
          <strong>The client</strong> resolved through <code>trusted_proxies</code> is what rate
          limits, prefetch budgets, the metrics allowlist, <code>req.ip</code> /{' '}
          <code>ctx.ip</code> and the logs use.
        </li>
      </ul>

      <h3 id="startup-warnings">Startup warnings</h3>
      <p>
        Loosening one of these keys logs one <code>warn</code> line at startup, and{' '}
        <code>giojs-server --check-config</code> (and <code>gio doctor</code>) report the same text
        under <code>warnings</code>:
      </p>
      <StartupWarnings rows={[
        { when: <><code>max_body_bytes = 0</code></>, text: "[server] max_body_bytes = 0: request bodies have no limit of their own - each is buffered in memory up to the worker's 64 MiB message cap" },
        { when: <><code>max_body_bytes</code> above 50331648 (48 MiB)</>, text: '[server] max_body_bytes = 60000000 is more than a worker message can carry: binary bodies above 48 MiB (base64-encoded to the 64 MiB message cap) still get a 413' },
        { when: <><code>max_connections = 0</code></>, text: '[server] max_connections = 0: concurrent connections are unlimited - a connection flood can exhaust file descriptors and memory' },
        { when: <><code>trusted_proxies</code> has a <code>/0</code></>, text: '[server] trusted_proxies includes 0.0.0.0/0: any client of that family can pick its own IP, rate-limit bucket and request id - list only your proxies\' addresses' },
        { when: <><code>skew_protection = false</code></>, text: "[server] skew_protection = false: a browser still running an older deployment's code keeps navigating without a reload, against pages and actions that may no longer match it" },
        { when: <><code>render_timeout_secs = 0</code></>, text: '[server] render_timeout_secs = 0: a render that never answers holds its connection and a worker slot indefinitely' },
        { when: <><code>rate_limit_max_buckets = 0</code> with rate limit rules</>, text: '[server] rate_limit_max_buckets = 0: rate-limit buckets are never evicted - clients rotating addresses grow memory without bound' },
      ]} />
      <p>
        The other timeouts can be set to <code>0</code> without a warning. Each one you lift
        gives slow or idle clients a way to hold connections open: keep them on when GioJS faces
        the internet directly.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="listen-on-this-machine-only">Listen on this machine only</h3>
      <p>Behind a reverse proxy on the same host, bind the loopback address so nothing else can reach the port:</p>
      <CodeBlock lang="toml" title="gio.toml" code={`[server]
host = "127.0.0.1"
port = 3000
trusted_proxies = ["127.0.0.1", "::1"]`} />

      <h3 id="accept-larger-uploads">Accept larger uploads</h3>
      <p>
        Raise the body limit and give slow uploads more time. Bodies are buffered in memory, so
        keep the limit near the largest upload you expect:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[server]
max_body_bytes = 26214400        # 25 MiB
request_body_timeout_secs = 120`} />

      <h3 id="behind-a-load-balancer">Behind a load balancer</h3>
      <p>
        Trust the balancer&apos;s address range, keep its idle timeout below the server&apos;s, and
        let it set request ids only if it always sets its own:
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[server]
trusted_proxies = ["10.0.0.0/8"]
accept_request_id = false          # the balancer passes a client's X-Request-Id through
header_read_timeout_secs = 75      # above the balancer's 60 s upstream idle timeout
idle_timeout_secs = 75`} />

      <h3 id="render-on-every-core">Render on every core</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[server]
workers = "auto"                   # one Node worker per core, at most 8`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          The environment wins over the file for the address: <code>GIO_HOST</code> over{' '}
          <code>host</code>, <code>GIO_PORT</code> then <code>PORT</code> over <code>port</code>.
          A plain <code>HOST</code> variable is not read. A malformed value stops startup.
        </li>
        <li>
          <code>workers = 0</code>, a negative count or more than 64 stops startup (
          <code>workers = 0: expected 1 to 64, or &quot;auto&quot;</code>).
        </li>
        <li>
          With <code>max_body_bytes = 0</code> a body is still refused with <code>413</code> once
          it cannot fit in one 64 MiB worker message. A binary body is base64-encoded on the way,
          so about 48 MiB is the real ceiling.
        </li>
        <li>
          Proxies that pool upstream connections longer than <code>header_read_timeout_secs</code>{' '}
          (nginx <code>keepalive</code>, ingress-nginx and AWS ALB default to 60 seconds) can reuse a
          connection as GioJS closes it and answer <code>502</code>. Keep the proxy&apos;s idle
          timeout below it, or raise both timeouts as in the example above.
        </li>
      </ul>
      <h3 id="not-configurable">Not configurable</h3>
      <ul>
        <li>
          <strong>Path canonicalization.</strong> Repeated and trailing slashes collapse and
          escapes of unreserved characters are decoded before any rule, rate limit or route
          sees the path; a path with a <code>.</code> or <code>..</code> segment or a malformed{' '}
          <code>%</code> escape gets <code>400</code>. Every matcher then agrees on one spelling.
        </li>
        <li>
          <strong>The <code>/_gio</code> namespace is closed.</strong> A path under it that is not
          a built-in endpoint answers <code>404</code> from Rust and never reaches the app.
        </li>
        <li>
          <strong>Request id validation.</strong> An incoming <code>X-Request-Id</code> is only
          kept when it matches <code>^[A-Za-z0-9._:-]{'{'}1,128{'}'}$</code>, so it is always safe
          to log and echo.
        </li>
        <li>
          <strong>The worker message cap</strong> (64 MiB per request) is fixed: it bounds what one
          request can cost the Node worker whatever <code>max_body_bytes</code> says.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/configuration/server-tls"><code>[server.tls]</code></a> - terminate TLS in GioJS</li>
        <li><a href="/docs/configuration/rate-limits"><code>[[rate_limits]]</code></a> - per-client request budgets</li>
        <li><a href="/docs/configuration#connection-limits">Connection limits</a>, <a href="/docs/configuration#reverse-proxies">Reverse proxies</a> and <a href="/docs/configuration#render-workers">Render workers</a> on the overview</li>
        <li><a href="/docs/deployment">Proxies, Sizing &amp; Scaling</a> - per-proxy settings</li>
        <li><a href="/docs/guides/security-switches">Turning Protections On and Off</a></li>
        <li><a href="/docs/env-vars">Environment variables</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <><code>host</code> and <code>port</code> default to <code>0.0.0.0:3000</code> and honor <code>GIO_HOST</code>, <code>GIO_PORT</code> and <code>PORT</code>. Added the connection limits and timeouts, <code>render_timeout_secs</code>, <code>workers</code>, <code>trusted_proxies</code>, <code>proxy_headers</code>, <code>accept_request_id</code>, <code>skew_protection</code> and <code>rate_limit_max_buckets</code>. <code>max_body_bytes = 0</code> means no limit of its own (it used to refuse every body). Loosened limits log a startup warning, once. With TLS, <code>http2 = false</code> offers only HTTP/1.1 in ALPN (it used to offer <code>h2</code> too, and clients that picked it could not connect).</> },
        { version: 'v0.1.0-beta.5', changes: <>Added <code>max_body_bytes</code>.</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced with <code>host</code>, <code>port</code> and <code>http2</code>.</> },
      ]} />
    </>
  );
}
