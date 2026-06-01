# GioJS Plugin API

GioJS plugins extend the framework without touching core. There are two independent surfaces:

- **Node plugins** (`GioNodePlugin`) — intercept HTTP requests and responses in the Node SSR layer
- **Rust plugins** (`GioPlugin`) — add Tower middleware and axum routes to the Rust HTTP layer

Most plugins only need the Node surface. The Rust surface is for advanced middleware (auth header
inspection at the edge, custom route namespaces) that benefits from running before the IPC round-trip.

---

## Node Plugin Interface

### `GioNodePlugin`

```typescript
import type { GioNodePlugin } from 'giojs-core/src/plugin.ts';

export interface GioNodePlugin {
  name: string;     // unique plugin identifier
  version: string;  // semver string

  // Called before SSR. Return IPCRequest to continue, IPCResponse to short-circuit.
  onRequest?: (req: IPCRequest) => Promise<IPCRequest | IPCResponse>;

  // Called after SSR completes. Modify or replace the response.
  onResponse?: (req: IPCRequest, res: IPCResponse) => Promise<IPCResponse>;

  // Called once at Node process startup.
  onStartup?: () => Promise<void>;

  // Called on SIGTERM before Node exits.
  onShutdown?: () => Promise<void>;
}
```

**Hook behaviour:**

| Hook | When called | Short-circuit? |
|---|---|---|
| `onRequest` | Before route matching and SSR | Yes — return `IPCResponse` to skip SSR |
| `onResponse` | After SSR, before sending to Rust | No — must return modified response |
| `onStartup` | Once at Node process startup | — |
| `onShutdown` | On `SIGTERM` | — |

Plugins run in **registration order** for `onRequest`/`onResponse`/`onStartup`. `onShutdown` runs in **reverse** registration order (last-in, first-out).

**Error behaviour:** If any hook throws, the error is caught, logged to stderr, and a `500 Internal Server Error` is returned. The Node process never crashes due to a plugin error.

---

## Registering Plugins via `gio.config.ts`

Create a `gio.config.ts` file in your project root (next to `gio.toml`):

```typescript
// gio.config.ts
import { myPlugin } from 'my-giojs-plugin';
import type { GioConfig } from 'giojs-core/src/config-loader.ts';

export default {
  plugins: [myPlugin],
} satisfies GioConfig;
```

`gio.config.ts` is **optional** — if absent, the server starts with no plugins.

---

## Auth Plugin Example

The `giojs-auth-example` package shows a minimal auth plugin that protects `/admin/*` routes:

```typescript
// packages/giojs-auth-example/src/index.ts
import type { GioNodePlugin } from 'giojs-core/src/plugin.ts';
import type { IPCRequest, IPCResponse } from 'giojs-core/src/context.ts';

export const authPlugin: GioNodePlugin = {
  name: 'giojs-auth-example',
  version: '0.1.0',

  async onRequest(req: IPCRequest): Promise<IPCRequest | IPCResponse> {
    if (!req.path.startsWith('/admin')) return req;  // not a protected route
    const cookie = req.headers['cookie'] ?? '';
    if (cookie.includes('session=valid')) return req;  // authenticated
    return {
      id: req.id,
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Forbidden',
      cacheable: false,
      cacheMaxAge: 0,
    };
  },
};
```

To try the demo:

```bash
# Start server with the auth-demo app
GIO_APP_DIR=examples/auth-demo/app NODE_ENV=development cargo run -p giojs-server

# Without cookie → 403
curl -i http://localhost:3000/admin/dashboard

# With cookie → 200
curl -i -H "Cookie: session=valid" http://localhost:3000/admin/dashboard
```

---

## Rust Plugin Interface

For plugins that need to run before the IPC round-trip (e.g., JWT header validation, custom route
namespaces), implement the `GioPlugin` trait from the `giojs-plugin` crate:

```rust
use giojs_plugin::{GioPlugin, MiddlewareFn, PluginError, PluginStartupCtx};
use std::sync::Arc;

pub struct MyPlugin;

impl GioPlugin for MyPlugin {
    fn name(&self) -> &'static str { "my-plugin" }
    fn version(&self) -> &'static str { "0.1.0" }

    // Optional: add Tower middleware (runs on every request)
    fn middleware(&self) -> Option<MiddlewareFn> {
        Some(Arc::new(|router| {
            router.layer(tower_http::trace::TraceLayer::new_for_http())
        }))
    }

    // Optional: add axum routes
    fn routes(&self) -> axum::Router {
        use axum::routing::get;
        axum::Router::new()
            .route("/plugin/status", get(|| async { "ok" }))
    }

    fn on_startup(&self, ctx: &PluginStartupCtx) -> Result<(), PluginError> {
        // ctx.cache is available; ctx.dev_mode indicates dev vs. prod
        Ok(())
    }
}
```

Rust plugins are registered programmatically in a future `gio.config.rs` integration. In the
current release (v1), they are registered directly in `main.rs` via `PluginRegistry::register()`.

---

## Version Compatibility

The `GioNodePlugin` interface and `GioPlugin` trait are considered **stable** from P5.4 onward.
Breaking changes require a major version bump and a migration guide in `CHANGELOG.md`.

Minor additions (new optional hook fields, new `PluginStartupCtx` fields) are non-breaking.
