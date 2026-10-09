/**
 * giojs-auth-example/src/index.ts
 *
 * Reference auth plugin for the GioNodePlugin interface, built on
 * @gio.js/core sessions: requests under a protected prefix need a session
 * (createSessionStorage) carrying a user id, or get 403 Forbidden.
 *
 * Pair it with a `require_session` guard on the same paths. The guard runs
 * in Rust and checks the session's signature and expiry before Node is
 * involved; this plugin decrypts the session and checks what is inside it.
 *
 * Plugins run only when a request reaches the worker: a cached page (one
 * that exports `revalidate`) is served by Rust without calling onRequest,
 * to anyone the guard lets through - the cache key holds no cookies. So
 * when the check differs per user (roles, revocation), a protected page
 * must not export `revalidate`, or must read the session itself, which
 * marks the render personal and keeps it out of the cache.
 */
import type { GioNodePlugin, IPCRequest, IPCResponse, SessionStorage } from '@gio.js/core';

export interface AuthPluginOptions {
  /** The app's session storage (the one its login route commits). */
  sessions: SessionStorage;
  /**
   * Path prefix to protect, segment-aware (`/admin` covers `/admin` and
   * `/admin/x`, not `/administrator`). Leading and trailing slashes are
   * normalized; `/` protects every path. Defaults to `/admin`.
   */
  prefix?: string;
  /** Session key that must be set for a request to pass. Defaults to `userId`. */
  userKey?: string;
}

function forbidden(id: string): IPCResponse {
  return {
    id,
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: 'Forbidden',
    cacheable: false,
    cacheMaxAge: 0,
  };
}

/** `/admin/` and `admin` become `/admin`; `/` and `` become `` (every path). */
function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `/${trimmed}`;
}

export function createAuthPlugin(options: AuthPluginOptions): GioNodePlugin {
  const prefix = normalizePrefix(options.prefix ?? '/admin');
  const userKey = options.userKey ?? 'userId';
  const isProtected = (path: string): boolean =>
    prefix === '' || path === prefix || path.startsWith(`${prefix}/`);

  return {
    name: 'giojs-auth-example',
    version: '0.1.0',

    async onRequest(req: IPCRequest): Promise<IPCRequest | IPCResponse> {
      if (!isProtected(req.path)) return req;
      // Tampered, expired, or foreign cookies read as an empty session.
      const session = options.sessions.getSession(req);
      return session.has(userKey) ? req : forbidden(req.id);
    },
  };
}
