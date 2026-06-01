# GioJS Deployment Adapters

GioJS ships as two processes: the `giojs-server` Rust binary (handles HTTP, routing, caching, compression) and a Node.js worker (React SSR). Both start automatically when you run `giojs-server`.

## Which adapter to use

| Situation | Recommended adapter |
|-----------|---------------------|
| Linux VPS or bare metal, long-running service | [Linux systemd](linux-systemd.md) |
| Containerized, single instance or scaling | [Docker](docker.md) |
| Kubernetes, multi-instance with shared cache | [Kubernetes](kubernetes.md) |
| Windows Server host | [Windows NSSM](windows-nssm.md) |

## Memory advantage

GioJS keeps memory flat under sustained load because Rust owns the HTTP layer — cache hits never allocate in Node. Self-hosted Next.js allocates in the Node event loop for every request, including cache hits.

See `benchmarks/memory-stability.md` for measured numbers comparing GioJS vs self-hosted Next.js 15 under 50 concurrent connections for 60 seconds.

## Before deploying

1. Run `gio build` to produce `.gio/manifest.json` and the compiled static assets
2. Ensure Node 20+ is installed on the target host
3. Place the `giojs-server` binary and your app directory on the host
4. Set `NODE_ENV=production`

## Common environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Set to `production` for production | `development` |
| `PORT` | Server port | `3000` |
| `GIO_SOCKET_PATH` | Unix socket path (Linux/macOS only) | `/tmp/giojs.sock` |
| `GIO_CACHE_REDIS_URL` | Redis URL for multi-instance cache | unset |

## Health check

`/_gio/health` returns JSON and is always available — use it for readiness probes and uptime monitors:

```json
{
  "status": "ok",
  "deploymentId": "abc12345",
  "nodeReady": true,
  "cacheSize": "12MB",
  "uptime": 3600
}
```
