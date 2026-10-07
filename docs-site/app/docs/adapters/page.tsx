import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Deployment &amp; Operations</div>
      <h1>Adapters</h1>
      <p className="page-subtitle">Run the same app on Docker, systemd, a Windows Service, or Kubernetes.</p>
      <p>
        GioJS needs no platform adapter: the server is a single binary plus its Node worker,
        so deploying is running one process. Point a reverse proxy at it, or expose it
        directly - it speaks HTTP/2 and can terminate TLS itself. The same app runs
        unchanged everywhere Node 20+ runs and a server binary exists:
      </p>
      <CodeBlock lang="bash" code={`npm start                  # from source: cross-env NODE_ENV=production giojs-server
node standalone/run.mjs    # a standalone build: no node_modules on the host`} />
      <ul>
        <li><a href="/docs/guides/deploying#docker">Docker</a>, and platforms that build a Dockerfile: <a href="/docs/guides/deploying#fly">Fly.io</a>, <a href="/docs/guides/deploying#railway">Railway</a>, <a href="/docs/guides/deploying#render">Render</a></li>
        <li><a href="/docs/guides/deploying#vps">systemd</a> on a Linux server, behind nginx or Caddy</li>
        <li>Kubernetes and Windows Server (NSSM): <code>docs/deployment/</code> in the repository</li>
        <li>Any static host, for sites with no server features: <a href="/docs/static-export">static export</a></li>
      </ul>
    </>
  );
}
