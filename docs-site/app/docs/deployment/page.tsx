import React from 'react';

export const revalidate = false;

interface DeploymentOption {
  title: string;
  description: string;
  guide: string;
  when: string;
}

const OPTIONS: DeploymentOption[] = [
  {
    title: 'Linux systemd',
    description: 'Run GioJS as a systemd service on any Linux VPS or bare metal server. Survives reboots, logs to journald, supports nginx as a TLS reverse proxy.',
    guide: '/docs/deployment#linux',
    when: 'Linux VPS or bare metal, long-running service',
  },
  {
    title: 'Docker',
    description: 'Multi-stage Dockerfile keeps the final image small (~80MB) by building Rust and Node separately.',
    guide: '/docs/deployment#docker',
    when: 'Containerized, single instance or scaling',
  },
  {
    title: 'Kubernetes',
    description: 'Deployment, Service, Ingress, and HPA YAMLs. Uses a readinessProbe on /_gio/health and scales on CPU utilization.',
    guide: '/docs/deployment#kubernetes',
    when: 'Kubernetes, multi-instance behind a load balancer',
  },
  {
    title: 'Windows NSSM',
    description: 'Run GioJS as a Windows Service using NSSM. Survives reboots, writes to Event Viewer, and can be managed with PowerShell cmdlets.',
    guide: '/docs/deployment#windows',
    when: 'Windows Server host',
  },
];

export default function DeploymentPage(): React.JSX.Element {
  return (
    <>
      <h1>Deployment</h1>
      <p className="page-subtitle">
        GioJS ships as two processes: the <code>giojs-server</code> Rust binary (HTTP, routing,
        caching) and a Node.js worker (React SSR). Both start automatically.
      </p>

      <p>
        The simplest deploy is a standalone folder: <code>gio build standalone</code> packages
        the server binary and a bundled worker into one directory that runs with{' '}
        <code>node run.mjs</code> on any server that has only Node installed - see{' '}
        <a href="/docs/standalone">Standalone Deploys</a>. The methods below run the app from
        source instead, which keeps <code>npm update</code> as your upgrade path.
      </p>

      <h2>Before deploying</h2>
      <ol>
        <li>Typecheck your app with <code>tsc --noEmit</code> - there is no separate build step; the server compiles and scans routes at startup</li>
        <li>Ensure Node.js 20+ is installed on the target host</li>
        <li>Place the <code>giojs-server</code> binary and your app directory on the host</li>
        <li>Set <code>NODE_ENV=production</code></li>
      </ol>

      <h2>Choose a deployment method</h2>
      <table>
        <thead>
          <tr><th>Method</th><th>When to use</th></tr>
        </thead>
        <tbody>
          {OPTIONS.map(opt => (
            <tr key={opt.title}>
              <td><strong>{opt.title}</strong></td>
              <td>{opt.when}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {OPTIONS.map(opt => (
        <section key={opt.title}>
          <h2>{opt.title}</h2>
          <p>{opt.description}</p>
          <p>
            Full guide: <code>docs/deployment/{opt.title.toLowerCase().replace(/\s+/g, '-')}.md</code>
            {' '}in the repository.
          </p>
        </section>
      ))}

      <h2>Static files</h2>
      <p>
        Ship <code>public/</code> next to <code>app/</code>. Rust serves its files at the
        site root (<code>/robots.txt</code>, <code>/favicon.ico</code>,{' '}
        <code>/.well-known/...</code>) and under <code>/public/*</code>, ahead of the page cache
        and the Node worker. Dotfiles (other than <code>.well-known/</code>), symlinks, and a
        top-level <code>public/_gio/</code> are served under <code>/public/*</code> only. The
        root-served set is indexed at startup, so add files as part of the deploy - files
        copied in while the server runs are picked up on the next restart (they are reachable
        under <code>/public/*</code> immediately). Point <code>GIO_PUBLIC_DIR</code> elsewhere
        if your assets live outside the project.
      </p>
      <p>
        Guards, header rules, and <code>[[rate_limits]]</code> for <code>/public/*</code> paths
        cover the root URL of the same file as well. A static export (<code>gio export</code>)
        copies <code>public/</code> into <code>out/</code> at both places, so static hosts serve
        the same URLs.
      </p>

      <h2>Health check</h2>
      <p>
        <code>/_gio/health</code> returns JSON and always answers 200 - cached and static
        content keeps serving even while the Node worker is respawning, during which{' '}
        <code>nodeReady</code> is <code>false</code>. Readiness probes should read that field.
        Use it for readiness probes, load balancer health checks, and uptime monitors:
      </p>
      <pre>
        <code>{`{
  "status": "ok",
  "http2": true,
  "tls": false,
  "deploymentId": "abc12345",
  "nodeReady": true,
  "cacheEntries": 42,
  "uptimeSecs": 3600
}`}</code>
      </pre>

      <h2>Behind a reverse proxy or load balancer</h2>
      <p>
        GioJS closes an HTTP/1.1 keep-alive connection after{' '}
        <code>header_read_timeout_secs</code> (10 seconds by default) without a new request,
        and any connection after <code>idle_timeout_secs</code> (60 seconds) with nothing in
        flight. Proxies that pool upstream connections (nginx <code>upstream</code>{' '}
        keep-alive, ingress-nginx, AWS ALB) keep them idle for 60 seconds by default and
        ignore the <code>Keep-Alive</code> hint, so they can reuse a connection at the moment
        GioJS closes it and answer that request with a 502. Either keep the proxy&apos;s
        upstream idle timeout below 10 seconds, or raise both GioJS deadlines above the
        proxy&apos;s. The proxy reads every request head in full, so a longer head deadline
        behind it costs nothing:
      </p>
      <pre>
        <code>{`[server]
header_read_timeout_secs = 65   # above a 60s ALB / ingress-nginx idle timeout
idle_timeout_secs = 65`}</code>
      </pre>
      <p>
        A plain <code>proxy_pass</code> with no <code>upstream</code> keep-alive opens a fresh
        connection per request and needs neither. See{' '}
        <a href="/docs/configuration">Configuration</a> for every connection limit.
      </p>

      <h2>Multi-instance deployments</h2>
      <p>
        The page cache is per-instance (in-memory LRU plus a local disk tier) - there is no
        shared cache backend yet. When running multiple instances (Kubernetes, multiple VMs),
        set <code>GIO_DEPLOYMENT_ID</code> to the same value on every instance so they agree
        on the deployment ID. By default the ID is derived from the app&apos;s content, so
        identical builds already agree - pinning it explicitly protects you when pods roll
        out at different times:
      </p>
      <pre>
        <code>{`GIO_DEPLOYMENT_ID=release-2026-09-06`}</code>
      </pre>
    </>
  );
}
