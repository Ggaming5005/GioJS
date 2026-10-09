/**
 * giojs-core/src/auth-example.test.ts
 *
 * The reference auth plugin (packages/giojs-auth-example): which paths its
 * prefix protects, and which sessions it lets through. It lives with the
 * core tests because the example package has no test runner of its own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IPCRequest, IPCResponse } from './context.ts';
import type { GioNodePlugin } from './plugin.ts';
import { createSessionStorage, type SessionStorage } from './session.ts';

interface AuthPluginModule {
  createAuthPlugin(options: { sessions: SessionStorage; prefix?: string; userKey?: string }): GioNodePlugin;
}

// Loaded at runtime: a static import would pull the example (outside this
// package's rootDir) into `tsc --noEmit`.
const { createAuthPlugin } = (await import(
  new URL('../../giojs-auth-example/src/index.ts', import.meta.url).href
)) as AuthPluginModule;

const SECRET = 'auth-example-test-secret-0123456789abcdef';
const OTHER_SECRET = 'auth-example-test-secret-other-0123456789';

const savedNodeEnv = process.env.NODE_ENV;
beforeEach(() => {
  process.env.NODE_ENV = 'production';
});
afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv;
});

function request(path: string, cookie?: string): IPCRequest {
  return {
    id: 'req-1',
    method: 'GET',
    path,
    params: {},
    query: {},
    headers: cookie === undefined ? {} : { cookie },
    body: null,
    bodyBase64: false,
    deploymentId: 'test',
    locale: 'en',
  };
}

function sessionCookie(data: Record<string, unknown>, secret = SECRET): string {
  const storage = createSessionStorage({ secrets: secret });
  const session = storage.getSession(null);
  for (const [key, value] of Object.entries(data)) session.set(key, value);
  return storage.commitSession(session).split(';')[0] as string;
}

const sessions = createSessionStorage({ secrets: SECRET });

/** True when the plugin let the request through unchanged. */
async function passes(prefix: string | undefined, path: string, cookie?: string): Promise<boolean> {
  const plugin = createAuthPlugin(prefix === undefined ? { sessions } : { sessions, prefix });
  const req = request(path, cookie);
  const result = await plugin.onRequest?.(req);
  if (result === req) return true;
  expect((result as IPCResponse).status).toBe(403);
  expect((result as IPCResponse).cacheable).toBe(false);
  return false;
}

describe('createAuthPlugin prefix', () => {
  it('protects the prefix and its subpaths, segment-aware', async () => {
    expect(await passes('/admin', '/admin')).toBe(false);
    expect(await passes('/admin', '/admin/x')).toBe(false);
    expect(await passes('/admin', '/admin/x/y')).toBe(false);
    expect(await passes('/admin', '/administrator')).toBe(true);
    expect(await passes('/admin', '/')).toBe(true);
    expect(await passes(undefined, '/admin/x')).toBe(false);
  });

  it('normalizes leading and trailing slashes', async () => {
    for (const prefix of ['/admin/', '/admin//', 'admin', 'admin/']) {
      expect(await passes(prefix, '/admin'), prefix).toBe(false);
      expect(await passes(prefix, '/admin/x'), prefix).toBe(false);
      expect(await passes(prefix, '/administrator'), prefix).toBe(true);
    }
  });

  it('protects every path for "/" or an empty prefix', async () => {
    for (const prefix of ['/', '', '//']) {
      expect(await passes(prefix, '/'), prefix).toBe(false);
      expect(await passes(prefix, '/anything/at/all'), prefix).toBe(false);
    }
  });
});

describe('createAuthPlugin sessions', () => {
  it('passes a valid session carrying a user id', async () => {
    expect(await passes('/admin', '/admin/x', sessionCookie({ userId: 'u_1' }))).toBe(true);
  });

  it('forbids a missing, empty, or user-less session', async () => {
    expect(await passes('/admin', '/admin/x')).toBe(false);
    expect(await passes('/admin', '/admin/x', 'gio_session=')).toBe(false);
    expect(await passes('/admin', '/admin/x', sessionCookie({ theme: 'dark' }))).toBe(false);
  });

  it('forbids forged, tampered, and foreign-secret sessions', async () => {
    expect(await passes('/admin', '/admin/x', 'gio_session=valid')).toBe(false);
    const good = sessionCookie({ userId: 'u_1' });
    const tampered = `${good.slice(0, -2)}${good.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(await passes('/admin', '/admin/x', tampered)).toBe(false);
    expect(await passes('/admin', '/admin/x', sessionCookie({ userId: 'u_1' }, OTHER_SECRET))).toBe(false);
  });

  it('honors a custom userKey', async () => {
    const plugin = createAuthPlugin({ sessions, userKey: 'accountId' });
    const withUserId = request('/admin', sessionCookie({ userId: 'u_1' }));
    expect(((await plugin.onRequest?.(withUserId)) as IPCResponse).status).toBe(403);
    const withAccount = request('/admin', sessionCookie({ accountId: 'a_1' }));
    expect(await plugin.onRequest?.(withAccount)).toBe(withAccount);
  });
});
