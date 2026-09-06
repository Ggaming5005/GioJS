# GioJS Deployment Adapters

GioJS ships as two processes: the `giojs-server` Rust binary (handles HTTP, routing, caching, compression) and a Node.js worker (React SSR). Both start automatically when you run `giojs-server`.

## Which adapter to use

| Situation | Recommended adapter |
|-----------|---------------------|
| Linux VPS or bare metal, long-running service | [Linux systemd](linux-systemd.md) |
| Containerized, single instance or scaling | [Docker](docker.md) |
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

The HTTP port is not an environment variable - it comes from the `[server]` section of `gio.toml` (default `3000`).

## Common environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Set to `production` for production | production behavior unless set to `development` |
| `GIO_APP_DIR` | Path to the `app/` directory | `app` |
| `GIO_DEPLOYMENT_ID` | Pin the deployment ID (otherwise content-derived from the build) | unset |
| `GIO_SOCKET_PATH` | IPC socket path (Unix socket; named pipe on Windows) | per-instance `.gio/ipc-<pid>-<rand>.sock` |
| `RUST_LOG` | Rust log filter (`info`, `debug`, `trace`) | `info` |

## Multi-instance deployments

Each instance keeps its own page cache (memory + disk) - there is no shared/distributed cache yet; cross-instance cache coherence is on the roadmap. To keep caches and version-skew detection consistent across instances of the same build, set `GIO_DEPLOYMENT_ID` to the same value (e.g. the release SHA) on every instance.

## Health check

`/_gio/health` returns JSON and is always available - use it for readiness probes and uptime monitors:

```json
{
  "status": "ok",
  "http2": true,
  "tls": false,
  "deploymentId": "abc12345",
  "nodeReady": true,
  "cacheEntries": 42,
  "uptimeSecs": 3600
}
```

It always returns `200` - cached and static content still serves while the Node worker respawns, so probe logic that needs the SSR worker should read the `nodeReady` field (`false` during a worker respawn) rather than the status code.
