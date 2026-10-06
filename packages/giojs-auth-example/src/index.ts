/**
 * giojs-auth-example/src/index.ts
 *
 * Reference auth plugin for the GioNodePlugin interface, built on
 * @gio.js/core sessions: requests under a protected prefix need a session
 * (createSessionStorage) carrying a user id, or get 403 Forbidden.
 *
 * Pair it with a `require_session` guard on the same paths. The guard runs
 * in Rust and checks the session's signature and expiry before Node is
 * involved; this plugin decrypts the session and checks what is inside it,
 * which is where app rules (roles, revocation) belong.
 */
import type { GioNodePlugin } from '../../giojs-core/src/plugin.ts';
import type { IPCRequest, IPCResponse } from '../../giojs-core/src/context.ts';
import type { SessionStorage } from '../../giojs-core/src/session.ts';

export interface AuthPluginOptions {
  /** The app's session storage (the one its login route commits). */
  sessions: SessionStorage;
  /** Path prefix to protect, without a trailing slash. Defaults to `/admin`. */
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

export function createAuthPlugin(options: AuthPluginOptions): GioNodePlugin {
  const prefix = options.prefix ?? '/admin';
  const userKey = options.userKey ?? 'userId';
  // Segment-aware: /admin and /admin/x are protected, /administrator is not.
  const isProtected = (path: string): boolean => path === prefix || path.startsWith(`${prefix}/`);

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
