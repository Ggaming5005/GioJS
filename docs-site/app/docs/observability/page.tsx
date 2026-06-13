import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Deployment</div>
      <h1>Observability</h1>
      <p className="page-subtitle">Health checks, Prometheus metrics, and the dev dashboard.</p>
      <p>Two endpoints are served directly by Rust:</p>
      <ul>
        <li><strong>/_gio/health</strong> — liveness probe, always on</li>
        <li><strong>/_gio/metrics</strong> — Prometheus metrics, opt-in via [metrics] in gio.toml</li>
      </ul>
      <CodeBlock lang="toml" code={`[metrics]
enabled = true
token = "a-long-random-secret"   # secure it for production`} />
      <h2>Dev dashboard</h2>
      <p>In development, /_gio/devtools shows live request logs, route manifest, cache stats, a memory sparkline, and IPC latency — generated entirely in Rust.</p>
    </>
  );
}
