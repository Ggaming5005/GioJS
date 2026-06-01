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
    description: 'Multi-stage Dockerfile keeps the final image small (~80MB) by building Rust and Node separately. Includes a docker-compose.yml with optional Redis for shared caching.',
    guide: '/docs/deployment#docker',
    when: 'Containerized, single instance or scaling',
  },
  {
    title: 'Kubernetes',
    description: 'Deployment, Service, Ingress, HPA, and Redis StatefulSet YAMLs. Uses readinessProbe on /_gio/health and scales on CPU utilization.',
    guide: '/docs/deployment#kubernetes',
    when: 'Kubernetes, multi-instance with shared Redis cache',
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

      <h2>Before deploying</h2>
      <ol>
        <li>Run <code>gio build</code> to produce <code>.gio/manifest.json</code> and compiled assets</li>
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

      <h2>Health check</h2>
      <p>
        <code>/_gio/health</code> returns JSON and is always available. Use it for readiness
        probes, load balancer health checks, and uptime monitors:
      </p>
      <pre>
        <code>{`{
  "status": "ok",
  "deploymentId": "abc12345",
  "nodeReady": true,
  "cacheSize": "12MB",
  "uptime": 3600
}`}</code>
      </pre>

      <h2>Multi-instance caching</h2>
      <p>
        When running multiple instances (Kubernetes, multiple VMs), configure Redis so all
        instances share a single ISR cache:
      </p>
      <pre>
        <code>{`[cache.redis]
enabled = true
url     = "redis://redis:6379"
prefix  = "gio:prod:"`}</code>
      </pre>
    </>
  );
}
