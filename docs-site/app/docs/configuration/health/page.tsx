import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[health]',
  description: 'The /_gio/health endpoint load balancers and gio start poll: on by default, with a switch for the details it reports.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[health]</h1>
      <p className="page-subtitle">
        The <code>/_gio/health</code> endpoint load balancers and <code>gio start</code> poll: on by
        default, with a switch for the details it reports.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[health]
details = false     # only {"status":"ok","nodeReady":...}`} />

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'enabled', type: 'boolean', default: 'true', zero: <><code>/_gio/health</code> answers <code>404</code></>, description: <>Serve the endpoint. Turn it off when your platform probes another URL and you want no extra public endpoint.</> },
        { key: 'details', type: 'boolean', default: 'true', zero: <>Only <code>status</code> and <code>nodeReady</code></>, description: <>Report the deployment id, worker topology, cache size and uptime. Off, the answer keeps what a probe needs, so the deployment id and worker count are not public.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <p>The endpoint answers <code>200</code> from Rust while the process runs, without waiting for the worker:</p>
      <CodeBlock lang="json" code={`{
  "cacheEntries": 0,
  "deploymentId": "495ddeb861e730d0",
  "http2": true,
  "nodeReady": true,
  "status": "ok",
  "tls": false,
  "uptimeSecs": 0,
  "workers": { "configured": 1, "ready": 1 }
}`} />
      <ul>
        <li>
          <code>nodeReady</code> is <code>false</code> while no render worker is ready - during the
          respawn of the only worker, or of every worker in a pool. Cached and static content still
          serves, so the status stays <code>200</code>: readiness probes should read the field.
        </li>
        <li>With <code>details = false</code> the body is <code>{'{"nodeReady":true,"status":"ok"}'}</code>.</li>
        <li>
          The endpoint is never rate-limited and no <code>gio.toml</code> or{' '}
          <code>middleware.ts</code> rule applies to it.
        </li>
      </ul>
      <p>No key in this section logs a warning.</p>

      <h2 id="examples">Examples</h2>
      <h3 id="a-kubernetes-readiness-probe">A Kubernetes readiness probe</h3>
      <p>
        The status is always <code>200</code>, so use the HTTP check for liveness and read{' '}
        <code>nodeReady</code> for readiness (the app image has Node, so no extra tool is needed):
      </p>
      <CodeBlock lang="yaml" title="deployment.yaml" code={`livenessProbe:
  httpGet: { path: /_gio/health, port: 3000 }
readinessProbe:
  exec:
    command:
      - node
      - -e
      - "fetch('http://127.0.0.1:3000/_gio/health').then(r => r.json()).then(h => process.exit(h.nodeReady ? 0 : 1), () => process.exit(1))"`} />

      <h3 id="hide-the-deployment-id">Hide the deployment id</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`[health]
details = false`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          With <code>enabled = false</code>, <code>gio dev</code>, <code>gio start</code> and the
          testing kit cannot read readiness from it, and treat any answer from the server as ready.
        </li>
        <li>The deployment id is also visible in every page (<code>window.__GIO_DEPLOYMENT_ID__</code>): <code>details = false</code> keeps it off this endpoint only.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/deployment#health-check">Deployment: Health check</a></li>
        <li><a href="/docs/configuration/metrics"><code>[metrics]</code></a></li>
        <li><a href="/docs/endpoints">Endpoints</a></li>
        <li><a href="/docs/cli/start"><code>gio start</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced the section with <code>enabled</code> and <code>details</code>. The endpoint reports <code>workers: {'{ configured, ready }'}</code>.</> },
        { version: 'v0.1.0-beta.6', changes: <>The endpoint reports <code>deploymentId</code>, <code>nodeReady</code>, <code>cacheEntries</code> and <code>uptimeSecs</code>.</> },
        { version: 'v0.1.0-beta.1', changes: <><code>/_gio/health</code> introduced, not configurable.</> },
      ]} />
    </>
  );
}
