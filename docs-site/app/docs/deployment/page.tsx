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
        content keeps serving even while the Node worker is respawning. <code>nodeReady</code>{' '}
        is <code>false</code> while no worker is ready (with a worker pool, only when every
        worker is down at once), and <code>workers</code> counts the ready ones. Readiness
        probes should read <code>nodeReady</code>.
        Use it for readiness probes, load balancer health checks, and uptime monitors:
      </p>
      <pre>
        <code>{`{
  "status": "ok",
  "http2": true,
  "tls": false,
  "deploymentId": "abc12345",
  "nodeReady": true,
  "workers": { "configured": 2, "ready": 2 },
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
      <p>
        Keep the original <code>Host</code> header (<code>proxy_set_header Host $host;</code>{' '}
        in nginx): CSRF protection and the WebSocket origin check compare the browser&apos;s{' '}
        <code>Origin</code> with it, so a proxy that rewrites it makes same-origin form posts
        and WebSockets fail with 403. And when the proxy terminates TLS, GioJS does not send{' '}
        <code>Strict-Transport-Security</code> by itself - set <code>[security] hsts = true</code>.
        See <a href="/docs/security">Security</a>.
      </p>

      <h3>Client IPs, HTTPS and request IDs</h3>
      <p>
        Behind a proxy, every connection comes from the proxy, so rate limits would put all
        visitors in one bucket and <code>req.ip</code> would be the proxy&apos;s address.
        List the proxy in <code>trusted_proxies</code> and GioJS reads the real client from
        the headers it adds (see{' '}
        <a href="/docs/configuration">Reverse proxies &amp; client IPs</a> for the exact
        rules). Whatever the proxy, get four things right:
      </p>
      <ul>
        <li>
          <strong>Trust only the proxy.</strong> Put its address (or the private range it
          connects from) in <code>trusted_proxies</code>, and make sure clients cannot reach
          GioJS directly - bind to <code>127.0.0.1</code> or firewall the port.
        </li>
        <li>
          <strong>Forward <code>X-Forwarded-For</code>, <code>X-Forwarded-Proto</code> and{' '}
          <code>X-Forwarded-Host</code></strong>, with the proxy setting Proto and Host
          rather than passing a client&apos;s values through. Appending is fine: GioJS reads{' '}
          <code>X-Forwarded-For</code> from the right and takes the last Proto and Host
          value, the one the nearest proxy wrote (HAProxy&apos;s <code>add-header</code>{' '}
          works as well as <code>set-header</code>).
        </li>
        <li>
          <strong>Keep the <code>Host</code> header</strong> (or set{' '}
          <code>X-Forwarded-Host</code>), so the host GioJS sees is the one the browser used.
          It is still client-supplied unless the proxy only routes your own domains to
          GioJS - never base a security decision on <code>req.host</code>.
        </li>
        <li>
          <strong>Decide who sets <code>X-Request-Id</code>.</strong> GioJS adopts a valid id
          from a trusted proxy. If yours passes a client&apos;s header through instead of
          setting one (most do), make it set or strip the header, or set{' '}
          <code>accept_request_id = false</code> so GioJS generates every id.
        </li>
      </ul>
      <p>nginx (on the same machine):</p>
      <pre>
        <code>{`location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Forwarded-Host $host;
    proxy_set_header   X-Request-Id $request_id;   # nginx's own id becomes GioJS's
}

# gio.toml
[server]
host = "127.0.0.1"
trusted_proxies = ["127.0.0.1", "::1"]`}</code>
      </pre>
      <p>
        Caddy&apos;s <code>reverse_proxy</code> sets all three forwarding headers and keeps{' '}
        <code>Host</code> by default, and Traefik does the same for its routers - both drop
        forwarding headers sent by untrusted clients. Neither sets an{' '}
        <code>X-Request-Id</code>, so a client&apos;s own would pass straight through: have
        Caddy set one, and have Traefik strip it (a headers middleware with{' '}
        <code>customRequestHeaders: {'{'} X-Request-Id: &quot;&quot; {'}'}</code>) or turn
        adoption off:
      </p>
      <pre>
        <code>{`# Caddyfile
example.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Request-Id {http.request.uuid}
    }
}

# gio.toml - Caddy on the same host; for Traefik in Docker, trust the
# network it connects from instead, e.g. ["172.16.0.0/12"]
[server]
trusted_proxies = ["127.0.0.1", "::1"]
# accept_request_id = false   # Traefik without the strip middleware`}</code>
      </pre>
      <p>
        Cloud load balancers connect from addresses inside your network: trust that range.
        AWS ALB appends to <code>X-Forwarded-For</code>, sets <code>X-Forwarded-Proto</code>{' '}
        and keeps <code>Host</code>; Google Cloud&apos;s HTTPS load balancer appends both the
        client IP <em>and its own forwarding-rule IP</em>, so add that public IP and
        Google&apos;s proxy ranges (<code>35.191.0.0/16</code>, <code>130.211.0.0/22</code>).
        Neither sets <code>X-Request-Id</code> or <code>X-Forwarded-Host</code>, nor can
        either remove them, so a client&apos;s own values arrive as if the load balancer had
        sent them. Turn request-id adoption off, and treat the host as client-supplied:
      </p>
      <pre>
        <code>{`# gio.toml behind AWS ALB (your VPC CIDR) or Google Cloud LB
[server]
trusted_proxies   = ["10.0.0.0/16"]
accept_request_id = false   # the LB would pass a client's X-Request-Id through`}</code>
      </pre>
      <p>
        In Kubernetes, trust the pod CIDR the ingress controller runs in. ingress-nginx sends
        an <code>X-Request-ID</code>, but it deliberately reuses one the client sent; keep{' '}
        <code>accept_request_id</code> on only if a client-chosen id is acceptable in your
        logs. Behind Cloudflare, trust Cloudflare&apos;s published IP ranges; it does not set{' '}
        <code>X-Request-Id</code> either, so turn adoption off or remove the header with a
        Transform Rule.
      </p>
      <p>
        Every response carries <code>X-Request-Id</code>, and the same id is on the server and
        worker log lines for the request - see{' '}
        <a href="/docs/observability">Observability</a>.
      </p>

      <h2>Process supervision</h2>
      <p>
        One GioJS server is two processes: the Rust server (the one your supervisor -
        systemd, Docker, Kubernetes, PM2 - starts) and the Node worker it spawns and
        restarts on its own (one worker per <code>[server] workers</code>, each
        supervised on its own). Send the server <code>SIGTERM</code> to stop: it stops
        accepting, closes idle keep-alive connections at once, lets in-flight requests
        finish (8 seconds at most), then gives every worker a few seconds to run its
        plugin shutdown hooks and exit before taking whatever is left down with it.
      </p>
      <p>
        A server that dies without that chance - <code>SIGKILL</code>, the OOM killer, a
        crash, a container runtime that kills only the main process - never leaves a
        worker behind. Each worker&apos;s stdin is a pipe the server holds open and never
        writes; the operating system closes it however the server dies, and the worker
        reads end-of-file and exits within moments (Windows uses a job object for the
        same guarantee). Launchers apply the same scheme one level up: <code>gio</code>{' '}
        and a standalone <code>run.mjs</code> start the server with a piped stdin and{' '}
        <code>GIO_EXIT_ON_STDIN_EOF=1</code>, so killing the launcher outright stops the
        server and frees the port too.
      </p>
      <div className="callout">
        In a container, run the server (or <code>run.mjs</code>) as the main process so
        your runtime&apos;s stop signal reaches it - and keep{' '}
        <code>GIO_EXIT_ON_STDIN_EOF</code> unset when you start the server binary
        directly: with stdin attached to <code>/dev/null</code> or a terminal it is
        ignored anyway, but it exists for launchers that hold the pipe.
      </div>

      <h2 id="sizing">Sizing</h2>
      <p>
        By default a server renders on one Node worker, which keeps memory low and is
        plenty for sites where most traffic is cache hits and static files - Rust serves
        those on all cores without touching Node. When renders are the bottleneck (many
        uncached or personalized pages, slow <code>getServerSideProps</code>, CPU-heavy
        route handlers), run a worker pool:
      </p>
      <pre>
        <code>{`[server]
workers = "auto"   # one per CPU core, at most 8 - or an exact count`}</code>
      </pre>
      <ul>
        <li>
          <strong>Memory.</strong> Each worker is a full Node process holding its own copy
          of your app, React and any in-memory data - budget the RSS of one worker (often
          100-200 MB, more for large apps) times the worker count, plus the Rust server.
          In a container, set the memory limit for the whole pool; <code>&quot;auto&quot;</code>{' '}
          counts the CPUs the container may use, not its memory.
        </li>
        <li>
          <strong>CPU.</strong> More workers than cores only adds memory. Leave a core for
          the Rust server when the box is busy with TLS, compression and images.
        </li>
        <li>
          <strong>State.</strong> Anything a module keeps in memory (a counter, an
          in-process cache, a rate limiter) exists once per worker. Requests from the same
          visitor can land on different workers, so keep shared state outside the process.
        </li>
        <li>
          <strong>Many small instances or one big one.</strong> A pool shares one page
          cache, one image cache and one set of WebSocket rooms; separate instances each
          keep their own. Prefer a pool per machine and scale out with instances beyond it.
        </li>
      </ul>
      <p>
        <code>/_gio/metrics</code> shows each worker&apos;s requests in flight and restart
        count (<code>gio_worker_in_flight</code>, <code>gio_worker_restarts_total</code>),
        which tells you whether a pool is saturated or a worker keeps crashing.
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
