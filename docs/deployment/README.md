# GioJS Deployment Adapters

GioJS ships as two processes: the `giojs-server` Rust binary (handles HTTP, routing, caching, compression) and a Node.js worker (React SSR). Both start automatically when you run `giojs-server`.

## Which adapter to use

Step-by-step recipes live on the docs site: [Deploying](https://giojs.com/docs/guides/deploying) (Docker, Fly.io, Railway, Render, systemd with nginx or Caddy) and the [production checklist](https://giojs.com/docs/guides/production-checklist). This file is the reference they point to, kept in sync with https://giojs.com/docs/deployment.

| Situation | Recommended adapter |
|-----------|---------------------|
| Linux VPS or bare metal, long-running service | [Linux systemd](https://giojs.com/docs/guides/deploying#vps) |
| Containerized, single instance or scaling | [Docker](https://giojs.com/docs/guides/deploying#docker) |
| Managed platform | [Fly.io](https://giojs.com/docs/guides/deploying#fly), [Railway](https://giojs.com/docs/guides/deploying#railway), [Render](https://giojs.com/docs/guides/deploying#render) |
| Kubernetes, multi-instance behind a load balancer | [Kubernetes](kubernetes.md) |
| Windows Server host | [Windows NSSM](windows-nssm.md) |

## Memory advantage

GioJS keeps memory flat under sustained load because Rust owns the HTTP layer - cache hits never allocate in Node. Self-hosted Next.js allocates in the Node event loop for every request, including cache hits.

See `benchmarks/memory-stability.md` for measured numbers comparing GioJS vs self-hosted Next.js 15 under 50 concurrent connections for 60 seconds.

## Before deploying

1. Ensure Node 20+ is installed on the target host
2. Place the `giojs-server` binary and your app directory on the host
3. Set `NODE_ENV=production`

There is no build step for server apps - route discovery and client bundles happen at server startup. Static sites are pre-rendered with `gio export` instead and need no server at all.

The listen address comes from the `[server]` section of `gio.toml` (default `0.0.0.0:3000`). The environment overrides it without editing the file: `GIO_PORT`, then `PORT` (the variable Heroku, Render, Railway, Fly.io and Cloud Run set), win over `[server] port`, and `GIO_HOST` over `[server] host`.

## Common environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Set to `production` for production | production behavior unless set to `development` |
| `GIO_APP_DIR` | Path to the `app/` directory | `app` |
| `PORT` / `GIO_PORT` | Listen port, overriding `[server] port` (`GIO_PORT` wins) | `[server] port`, else `3000` |
| `GIO_CACHE_DIR` | Page cache directory, overriding `[cache] disk_path` | `.gio/cache/pages` |
| `GIO_DEPLOYMENT_ID` | Pin the deployment ID (otherwise content-derived from the build) | unset |
| `GIO_SOCKET_PATH` | IPC socket path (Unix socket; named pipe on Windows) | per-instance `.gio/ipc-<pid>-<rand>.sock` |
| `GIO_REVALIDATE_TOKEN` | Bearer token (32+ bytes) that enables `POST /_gio/revalidate` for on-demand cache purges | unset (endpoint disabled) |
| `RUST_LOG` | Rust log filter (`info`, `debug`, `trace`) | `info` |
| `GIO_LOG_FORMAT` | `json` for one JSON object per server log line (overrides `[logging] format`), ready for Loki/Datadog/CloudWatch | `text` |

## Process supervision

Stop the server with `SIGTERM`: it stops accepting, closes idle keep-alive connections, lets in-flight requests finish (8 s at most), then gives each Node worker a few seconds to run its plugin shutdown hooks and exit before taking it down. A server killed without warning (`SIGKILL`, the OOM killer, a crash) never leaves a worker running: each worker's stdin is a pipe the server holds open, and the worker exits when it reads end-of-file. `gio` and a standalone `run.mjs` launch the server the same way (piped stdin plus `GIO_EXIT_ON_STDIN_EOF=1`), so killing the launcher stops the server and frees the port.

## Sizing: render workers

A server renders on one Node worker by default. When uncached renders are the bottleneck, run a pool - `[server] workers = N`, or `"auto"` for one per CPU core (at most 8):

```toml
[server]
workers = 4
```

Requests go to the ready worker with the fewest in flight (open SSE streams and streaming responses count until they end), a crashed worker fails only its own in-flight requests while the others serve, and only the first worker builds the client bundles - a worker that cannot load that build fails its boot and is retried rather than rebuilding under the others. Each worker is a full Node process with its own copy of the app, so budget one worker's RSS (often 100-200 MB) per worker and size container memory limits for the whole pool; `"auto"` counts CPUs, not memory. Module-level state is per worker, and so are Node plugin hooks: `onStartup` runs in every worker and again on each respawn, so keep one-time jobs (migrations, schedulers, queue consumers) out of it or run them only where `GIO_WORKER_INDEX` is `"0"`, idempotently. Dev mode always runs one worker. `/_gio/metrics` exposes `gio_worker_in_flight` and `gio_worker_restarts_total` per worker; `gio_memory_bytes` is the Rust process only, so read worker RSS from `ps`/`top` or your container metrics.

## Multi-instance deployments

Each instance keeps its own page cache (memory + disk) - there is no shared/distributed cache yet; cross-instance cache coherence is on the roadmap. To keep caches and version-skew detection consistent across instances of the same build, set `GIO_DEPLOYMENT_ID` to the same value (e.g. the release SHA) on every instance.

On-demand purges are per instance too: `revalidateTag()` / `revalidatePath()` purge only the instance whose worker calls them, so a CMS webhook should call `POST /_gio/revalidate` on every instance by its own address, not once through the load balancer. That holds even for instances sharing one disk cache directory (`GIO_CACHE_DIR`, default `.gio/cache/pages`): they serve the pages each other stored, but each keeps its own memory cache.

## Behind a reverse proxy or load balancer

GioJS closes an HTTP/1.1 keep-alive connection after `header_read_timeout_secs` (10s by default) without a new request, and any connection after `idle_timeout_secs` (60s) with nothing in flight. A proxy or load balancer that pools upstream connections and keeps them idle for longer can reuse one at the moment GioJS closes it, and answers that request with a 502. Proxies ignore the `Keep-Alive: timeout=N` hint GioJS sends, so line the timeouts up yourself. Either:

- keep the proxy's upstream idle timeout below 10s: `keepalive_timeout 5s;` in an nginx `upstream` block, or `upstream-keepalive-timeout: "5"` in the ingress-nginx controller ConfigMap; or
- raise both GioJS deadlines above the proxy's timeout. AWS ALB keeps target connections for its idle timeout (60s by default), and ingress-nginx and nginx `upstream` keep-alive default to 60s:

  ```toml
  [server]
  header_read_timeout_secs = 65
  idle_timeout_secs = 65
  ```

  The proxy reads each request head in full before forwarding it, so the longer head deadline costs nothing as long as clients can reach GioJS only through the proxy.

A plain `proxy_pass` with no `upstream { keepalive }` block, as in the [systemd guide](https://giojs.com/docs/guides/deploying#nginx), opens a fresh upstream connection per request and needs neither. See *Connection limits* on the configuration docs page for every connection setting.

### Client IPs, HTTPS and request IDs

Behind a proxy every connection comes from the proxy: without configuration, `[[rate_limits]]` put all visitors in one bucket, the `[metrics] ip_allowlist` sees only the proxy, and `req.ip` / `ctx.ip` are the proxy's address. List the proxy in `trusted_proxies` and GioJS reads the real client from its forwarding headers - and ignores those headers from everyone else:

```toml
[server]
trusted_proxies = ["127.0.0.1", "::1"]   # IPs and CIDR blocks; default [] = trust nobody
# proxy_headers = "forwarded"            # if the proxy sends RFC 7239 Forwarded instead of X-Forwarded-*
# accept_request_id = false              # if the proxy passes a client's X-Request-Id through
```

The client IP is the first address in `X-Forwarded-For` that is not a trusted proxy, reading from the right. Entries left of it are never read - not even checked for being well-formed - so whatever a client sends in its own `X-Forwarded-For` through a proxy that appends to it changes nothing. From a trusted proxy, `X-Forwarded-Proto` sets the scheme and `X-Forwarded-Host` the host; GioJS takes the last value, the one the nearest proxy wrote. Whatever the proxy:

- **Trust only the proxy**, and make sure clients cannot reach GioJS directly (bind `127.0.0.1`, or firewall the port).
- **Forward `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`**, with the proxy setting Proto and Host rather than passing a client's values through. Appending is fine (HAProxy's `http-request add-header` works as well as `set-header`); in a chain of proxies, have the inner one pass the outer one's value on.
- **Keep the `Host` header** (or set `X-Forwarded-Host`). The host is client-supplied unless the proxy only routes your own domains to GioJS: never base a security decision on `req.host` / `ctx.host`.
- **Decide who sets `X-Request-Id`.** GioJS adopts a valid id from a trusted proxy. Most proxies pass a client's header through instead of setting one: make the proxy set or strip it, or set `accept_request_id = false` so GioJS generates every id.

| Proxy | What to configure |
|-------|-------------------|
| nginx | `proxy_set_header Host $host;` `X-Forwarded-For $proxy_add_x_forwarded_for;` `X-Forwarded-Proto $scheme;` `X-Forwarded-Host $host;` `X-Request-Id $request_id;` - see the [systemd guide](https://giojs.com/docs/guides/deploying#nginx). `trusted_proxies = ["127.0.0.1", "::1"]` on the same host. |
| Caddy | `reverse_proxy 127.0.0.1:3000` already sets the three forwarding headers, keeps `Host`, and ignores spoofed ones. It passes a client's `X-Request-Id` through: add `header_up X-Request-Id {http.request.uuid}` inside the `reverse_proxy` block. Trust Caddy's address. |
| Traefik | Sets the three forwarding headers and keeps `Host` by default. It passes a client's `X-Request-Id` through: strip it with a headers middleware (`customRequestHeaders: { X-Request-Id: "" }`) or set `accept_request_id = false`. Trust the network Traefik connects from (in Docker, e.g. `"172.16.0.0/12"`). |
| AWS ALB | Appends `X-Forwarded-For`, sets `X-Forwarded-Proto`, keeps `Host`. It neither sets nor removes `X-Request-Id` and `X-Forwarded-Host`, so a client's own arrive as if the ALB sent them: set `accept_request_id = false`, and treat the host as client-supplied. Trust your VPC CIDR, e.g. `"10.0.0.0/16"`. |
| Google Cloud HTTPS LB | Appends the client IP *and its own forwarding-rule IP* to `X-Forwarded-For`: trust that public IP plus Google's proxy ranges `"35.191.0.0/16"` and `"130.211.0.0/22"`. Like ALB it passes a client's `X-Request-Id` and `X-Forwarded-Host` through: set `accept_request_id = false`. |
| Kubernetes ingress-nginx | Trust the pod CIDR the controller runs in. Its `X-Request-ID` deliberately reuses one the client sent; set `accept_request_id = false` unless a client-chosen id is fine in your logs. |
| Cloudflare | Trust Cloudflare's published IP ranges (cloudflare.com/ips). It does not set `X-Request-Id`: set `accept_request_id = false`, or remove the header with a Transform Rule. |

Every response carries `X-Request-Id`. A valid incoming id (`^[A-Za-z0-9._:-]{1,128}$`) from a trusted proxy is kept (unless `accept_request_id = false`), so the proxy's id follows the request; anything else is replaced by a generated UUID. The same id is on the server's log lines for the request (`request{request_id=...}`, kept at any `RUST_LOG` level) and on every JSON line the Node worker logs while handling it (`"requestId"`).

Two security settings depend on the proxy too (see the *Security* docs page):

- **Pass the original `Host` through** (`proxy_set_header Host $host;` in nginx). CSRF protection and the WebSocket origin check compare the browser's `Origin` with the `Host` GioJS receives; a proxy that rewrites it to an internal name makes every same-origin form post and WebSocket look cross-origin (403). If it cannot be passed through, list the public origin in `[security.csrf] trusted_origins`.
- **HSTS is opt-in when the proxy terminates TLS.** GioJS only sends `Strict-Transport-Security` on its own when `[server.tls]` is enabled; behind a TLS proxy set `[security] hsts = true` in `gio.toml` (or add the header in the proxy).

## Health check

`/_gio/health` returns JSON and is on unless `[health] enabled = false` turns it into a `404` (point probes at a page of your own then) - use it for readiness probes and uptime monitors:

```json
{
  "status": "ok",
  "http2": true,
  "tls": false,
  "deploymentId": "abc12345",
  "nodeReady": true,
  "workers": { "configured": 1, "ready": 1 },
  "cacheEntries": 42,
  "uptimeSecs": 3600
}
```

It always returns `200` - cached and static content still serves while the Node worker respawns, so probe logic that needs the SSR worker should read the `nodeReady` field (`false` while no worker is ready - with a pool, only when every worker is respawning) rather than the status code. `workers` counts the configured and ready workers.
