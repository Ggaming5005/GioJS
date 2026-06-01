import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function ConfigurationPage(): React.JSX.Element {
  return (
    <>
      <h1>Configuration</h1>
      <p className="page-subtitle">
        All GioJS configuration lives in <code>gio.toml</code> at the project root.
        Every field is optional — defaults are production-ready.
      </p>

      <h2>Full reference</h2>
      <CodeBlock lang="toml" code={`[app]
name = "my-app"
router = "app"          # "app" | "pages"

[server]
host = "0.0.0.0"        # bind address
port = 3000

[server.tls]
enabled = false         # set true to terminate TLS in GioJS directly
cert = "/path/to/cert.pem"
key  = "/path/to/key.pem"

[cache]
memory_mb = 128         # in-process LRU size

[cache.redis]
enabled = false
url     = "redis://localhost:6379"
prefix  = "gio:prod:"

[compression]
enabled = true          # brotli + gzip negotiation

[[images.remotePatterns]]
hostname = "images.example.com"
protocol = "https"

[[redirects]]
source      = "/old-path"
destination = "/new-path"
permanent   = true

[[rewrites]]
source      = "/api/:path*"
destination = "http://internal-api/:path*"`} />

      <h2>Environment variables</h2>
      <p>Environment variables override <code>gio.toml</code> at runtime:</p>
      <table>
        <thead>
          <tr><th>Variable</th><th>Description</th><th>Default</th></tr>
        </thead>
        <tbody>
          <tr><td><code>PORT</code></td><td>HTTP listen port</td><td>3000</td></tr>
          <tr><td><code>NODE_ENV</code></td><td>Runtime mode</td><td>development</td></tr>
          <tr><td><code>GIO_CACHE_REDIS_URL</code></td><td>Redis connection URL</td><td>unset</td></tr>
          <tr><td><code>GIO_SOCKET_PATH</code></td><td>IPC socket path (Linux/macOS)</td><td>/tmp/giojs.sock</td></tr>
          <tr><td><code>RUST_LOG</code></td><td>Rust log level (info/debug/trace)</td><td>info</td></tr>
        </tbody>
      </table>

      <h2>Static page caching</h2>
      <p>
        Export <code>revalidate</code> from any page module to control caching:
      </p>
      <CodeBlock lang="typescript" code={`// Cache forever (ISR: never revalidate)
export const revalidate = false;

// Cache for 60 seconds, then revalidate
export const revalidate = 60;

// Never cache (default when not set)
// (omit the export)`} />
      <div className="callout">
        <code>revalidate = false</code> maps to a one-year TTL (31536000 seconds) in the
        Rust cache layer — the standard sentinel for "cache indefinitely."
      </div>
    </>
  );
}
