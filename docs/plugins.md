# GioJS Plugin API

GioJS plugins extend the framework without touching core. There are two independent surfaces:

- **Node plugins** (`GioNodePlugin`) - intercept HTTP requests and responses in the Node SSR layer
- **Rust plugins** (`GioPlugin`) - add Tower middleware and axum routes to the Rust HTTP layer

Most plugins only need the Node surface. The Rust surface is for advanced middleware (auth header
inspection at the edge, custom route namespaces) that benefits from running before the IPC round-trip.

---

## Node Plugin Interface

### `GioNodePlugin`

```typescript
import type { GioNodePlugin } from '@gio.js/core';

export interface GioNodePlugin {
  name: string;     // unique plugin identifier
  version: string;  // semver string

  // Called before SSR. Return IPCRequest to continue, IPCResponse to short-circuit.
  onRequest?: (req: IPCRequest) => Promise<IPCRequest | IPCResponse>;

  // Called after SSR completes. Modify or replace the response.
  onResponse?: (req: IPCRequest, res: IPCResponse) => Promise<IPCResponse>;

  // Called when a Node worker process starts - in every worker of a pool,
  // and again after a respawn (see "Worker pools" below).
  onStartup?: () => Promise<void>;

  // Called when a Node worker shuts down (SIGTERM, server shutdown) - in every worker.
  onShutdown?: () => Promise<void>;
}
```

`IPCRequest`/`IPCResponse` are the wire shapes the hooks receive and return; both are exported
from `@gio.js/core` (`import type { IPCRequest, IPCResponse } from '@gio.js/core'`) for helpers
that build or inspect them. Annotate your plugin object as `GioNodePlugin` and the hook
parameters and return types are inferred.

**Hook behaviour:**

| Hook | When called | Short-circuit? |
|---|---|---|
| `onRequest` | Before route matching and SSR | Yes - return `IPCResponse` to skip SSR |
| `onResponse` | After SSR, before sending to Rust | No - must return modified response |
| `onStartup` | When each Node worker process starts (every worker of a pool, and again after a respawn) | - |
| `onShutdown` | When each Node worker shuts down (`SIGTERM`, server shutdown) | - |

Plugins run in **registration order** for `onRequest`/`onResponse`/`onStartup`. `onShutdown` runs in **reverse** registration order (last-in, first-out).

**Worker pools:** Node plugins run inside the render worker, and with `[server] workers = N`
every worker is its own Node process with its own plugin instances. `onStartup` therefore runs in
each of the N workers at once, and again in a worker the server respawns after a crash; `onShutdown`
runs in each worker as it stops. A hook that must happen once - a database migration, a scheduler
or cron job, a queue consumer - does not belong in `onStartup` as is: run it outside the server
(a release step, a separate process), or guard it. Each worker gets `GIO_WORKER_INDEX` (`"0"` for
the first worker - the only one by default) and `GIO_WORKER_COUNT` (the pool size), so
`process.env.GIO_WORKER_INDEX === '0'` keeps a job to one worker per server - still make it
idempotent, since worker 0 can be respawned, and take a lock (in the database, say) when several
server instances run.

**Cookies:** `IPCResponse.headers` holds one value per header name, so set cookies through the
optional `setCookies: string[]` field instead - each entry is sent as its own `Set-Cookie` header.
Append to it in `onResponse` (`setCookies: [...(res.setCookies ?? []), 'a=1; Path=/']`) so cookies
set by the page are kept. A response that sets cookies is never cached or shared between requests.

Cookies set by the page (`getServerSideProps` headers) or a route handler `Response` arrive in
`res.setCookies`, **not** in `res.headers['set-cookie']` - earlier releases put them in the headers
map. A plugin that strips or rewrites cookies must work on `setCookies`: set `setCookies: []` to
strip them, or map over it to add attributes such as `Secure`. Deleting `res.headers['set-cookie']`
no longer removes them.

**Error behaviour:** If any hook throws, the error is caught, logged to stderr, and a `500 Internal Server Error` is returned. The Node process never crashes due to a plugin error.

**Caching and personalization:** the Rust page cache keys renders by method, path (locale included),
and query - never by anything an `onRequest` plugin derives from the visitor. GioJS protects the common case:
request headers a plugin adds, changes or removes (e.g. an auth plugin setting `x-user-id` from the
session cookie; names match case-insensitively) count as credentials, so a page whose
`getServerSideProps` reads them is rendered per request and never cached, exactly like reading
`ctx.cookies`. Two things stay the plugin's
responsibility:

- An `IPCResponse` returned from `onRequest` is sent as-is, including its `cacheable` /
  `cacheMaxAge`. Set `cacheable: false` on anything that depends on the visitor.
- Rewriting `req.path` or `req.query` per visitor (A/B buckets, per-user redirects) is invisible
  to the cache key; a page reached that way that exports `revalidate` would be cached under the
  original URL for everyone. Route per visitor with a redirect, or keep such pages uncached.

---

## Registering Plugins via `gio.config.ts`

Create a `gio.config.ts` file in your project root (next to `gio.toml`):

```typescript
// gio.config.ts
import { defineConfig } from '@gio.js/core';
import { myPlugin } from 'my-giojs-plugin';

export default defineConfig({
  plugins: [myPlugin],
});
```

`gio.config.ts` is **optional** - if absent, the server starts with no plugins. It is
checked at boot: an unknown key (`plugin:`) or a plugin without a `name` stops the worker
with an error naming the file.

---

## Auth Plugin Example

The in-repo `packages/giojs-auth-example` package shows an auth plugin built on
`createSessionStorage` (see the Authentication docs): requests under a protected
prefix need a session carrying a user id, or get 403. Written against the published
package, it looks like this:

```typescript
import type { GioNodePlugin, SessionStorage } from '@gio.js/core';

export function createAuthPlugin({ sessions, prefix = '/admin' }: {
  sessions: SessionStorage;
  prefix?: string;
}): GioNodePlugin {
  // '/admin/' and 'admin' mean '/admin'; '/' protects every path.
  const trimmed = prefix.replace(/^\/+|\/+$/g, '');
  const base = trimmed === '' ? '' : `/${trimmed}`;
  return {
    name: 'giojs-auth-example',
    version: '0.1.0',

    async onRequest(req) {
      // Segment-aware: /admin and /admin/x, not /administrator.
      const isProtected = base === '' || req.path === base || req.path.startsWith(`${base}/`);
      if (!isProtected) return req;
      // Tampered, expired, or foreign cookies read as an empty session.
      if (sessions.getSession(req).has('userId')) return req;  // authenticated
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
}
```

Pair it with a `require_session` guard on the same paths: the guard verifies the
session's signature and expiry in Rust before Node is involved, and the plugin
checks what is inside it.

Plugins run only when a request reaches the worker. A page that exports
`revalidate` is cached by Rust (the cache key holds no cookies) and later
requests are answered from the cache without calling `onRequest` - so anyone the
guard lets through gets it. For checks that differ per user (roles, revocation),
either drop `revalidate` from the protected pages or read the session in the page
itself: reading it marks the render personal, and personal renders are never
cached.

`examples/auth-demo` wires guard and plugin together with a login form, a
session-reading dashboard, and logout:

```bash
# Start server with the auth-demo app (DEMO_PASSWORD comes from examples/auth-demo/.env;
# in development the server generates an ephemeral GIO_SESSION_SECRET)
GIO_APP_DIR=examples/auth-demo/app NODE_ENV=development cargo run -p giojs-server

# Without a session -> 302 to /login (the Rust guard)
curl -i http://localhost:3000/admin/dashboard

# Log in, keeping the session cookie, then visit the dashboard -> 200
curl -i -c jar.txt -d 'name=Ada&password=gio-demo' http://localhost:3000/api/login
curl -i -b jar.txt http://localhost:3000/admin/dashboard
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
