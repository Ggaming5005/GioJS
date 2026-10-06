/**
 * giojs-core/src/session.test.ts
 *
 * Encrypted cookie sessions: roundtrips, tampering, expiry, key rotation,
 * the 4096-byte limit, secret handling per runtime mode, and the fixed
 * token vectors crates/giojs-server/src/session_token.rs verifies too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStorage, openSessionToken, sealSessionToken } from './session.ts';

const SECRET = 'session-test-secret-0123456789abcdefghij';
const OLD_SECRET = 'session-test-secret-old-0123456789abcdefg';

/** The Set-Cookie value's `name=value` part, as a browser would send it back. */
function cookieHeader(setCookie: string): string {
  return setCookie.split(';')[0] as string;
}

const savedEnv = { ...process.env };
let stderr: string[] = [];

beforeEach(() => {
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    stderr.push(String(chunk));
    return true;
  });
  delete process.env.GIO_SESSION_SECRET;
  delete process.env.GIO_SESSION_SECRET_EPHEMERAL;
  process.env.NODE_ENV = 'production';
  const store = globalThis as unknown as Record<symbol, unknown>;
  delete store[Symbol.for('gio.session.devSecret')];
  delete store[Symbol.for('gio.session.devSecretWarned')];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.env = { ...savedEnv };
});

describe('createSessionStorage', () => {
  it('roundtrips session data through an encrypted cookie', () => {
    const storage = createSessionStorage<{ userId: string; roles: string[] }>({ secrets: SECRET });
    const session = storage.getSession(undefined);
    expect(session.isNew).toBe(true);
    session.set('userId', 'u_1');
    session.set('roles', ['admin']);
    const setCookie = storage.commitSession(session);

    expect(setCookie).toMatch(/^gio_session=v1\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; Max-Age=604800; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(setCookie).not.toContain('u_1');

    const restored = storage.getSession(cookieHeader(setCookie));
    expect(restored.isNew).toBe(false);
    expect(restored.get('userId')).toBe('u_1');
    expect(restored.get('roles')).toEqual(['admin']);
    expect(restored.data).toEqual({ userId: 'u_1', roles: ['admin'] });
  });

  it('accepts an interface as the session shape and types get/set by key', () => {
    interface User {
      userId: string;
      visits?: number;
    }
    const storage = createSessionStorage<User>({ secrets: SECRET });
    const session = storage.getSession(null);
    session.set('userId', 'u_9');
    session.set('visits', 2);
    // @ts-expect-error - wrong value type for the key
    session.set('visits', 'two');
    // @ts-expect-error - unknown key
    session.get('role');
    const userId: string | undefined = session.get('userId');
    expect(userId).toBe('u_9');
  });

  it('supports has, unset and set(undefined)', () => {
    const storage = createSessionStorage({ secrets: SECRET });
    const session = storage.getSession(null);
    session.set('a', 1);
    session.set('b', 2);
    expect(session.has('a')).toBe(true);
    session.unset('a');
    session.set('b', undefined);
    expect(session.has('a')).toBe(false);
    expect(session.data).toEqual({});
  });

  it('keeps a "__proto__" key as plain data', () => {
    const storage = createSessionStorage({ secrets: SECRET });
    const session = storage.getSession(null);
    session.set('__proto__', { polluted: true });
    const restored = storage.getSession(cookieHeader(storage.commitSession(session)));
    expect(restored.get('__proto__')).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('reads the cookie from every supported source', () => {
    const storage = createSessionStorage({ secrets: SECRET });
    const session = storage.getSession(null);
    session.set('userId', 'u_2');
    const header = `other=1; ${cookieHeader(storage.commitSession(session))}`;
    const token = header.split('gio_session=')[1] as string;

    expect(storage.getSession(header).get('userId')).toBe('u_2');
    expect(storage.getSession({ cookies: { gio_session: token } }).get('userId')).toBe('u_2');
    expect(storage.getSession({ headers: { cookie: header } }).get('userId')).toBe('u_2');
    expect(storage.getSession(new Request('http://x/', { headers: { cookie: header } })).get('userId')).toBe('u_2');
    expect(storage.getSession({ headers: {} }).isNew).toBe(true);
  });

  it('reads ctx.cookies (what marks a getServerSideProps render personalized)', () => {
    const storage = createSessionStorage({ secrets: SECRET });
    let read = false;
    const ctx = {
      headers: { cookie: 'gio_session=x' },
      get cookies() {
        read = true;
        return { gio_session: 'x' };
      },
    };
    storage.getSession(ctx);
    expect(read).toBe(true);
  });

  it('honors cookieName, maxAge and cookie options', () => {
    const storage = createSessionStorage({
      secrets: SECRET,
      cookieName: 'app_sess',
      maxAge: 60,
      cookie: { secure: false, sameSite: 'strict', path: '/app' },
    });
    const setCookie = storage.commitSession(storage.getSession(null));
    expect(setCookie).toMatch(/^app_sess=v1\..*; Max-Age=60; Path=\/app; HttpOnly; SameSite=Strict$/);
    expect(storage.commitSession(storage.getSession(null), { maxAge: 5 })).toContain('; Max-Age=5;');
    expect(storage.destroySession()).toBe(
      'app_sess=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/app; HttpOnly; SameSite=Strict',
    );
  });

  it('rejects invalid options at creation time', () => {
    expect(() => createSessionStorage({ secrets: SECRET, cookieName: 'bad name' })).toThrow(/cookieName/);
    expect(() => createSessionStorage({ secrets: SECRET, maxAge: 0 })).toThrow(/maxAge/);
    expect(() => createSessionStorage({ secrets: SECRET, maxAge: 1.5 })).toThrow(/maxAge/);
    expect(() => createSessionStorage({ secrets: SECRET, cookie: { sameSite: 'none', secure: false } })).toThrow(
      /requires secure/,
    );
    const storage = createSessionStorage({ secrets: SECRET });
    expect(() => storage.commitSession(storage.getSession(null), { maxAge: -1 })).toThrow(/maxAge/);
  });

  it('accepts hardened cookie options in development (Secure by default there too)', () => {
    process.env.NODE_ENV = 'development';
    const host = createSessionStorage({ secrets: SECRET, cookieName: '__Host-sess' });
    const session = host.getSession(null);
    session.set('userId', 'u_9');
    const setCookie = host.commitSession(session);
    expect(setCookie).toMatch(/^__Host-sess=v1\..*; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(host.getSession(cookieHeader(setCookie)).get('userId')).toBe('u_9');
    expect(host.destroySession()).toContain('; Secure');

    const crossSite = createSessionStorage({ secrets: SECRET, cookie: { sameSite: 'none' } });
    expect(crossSite.destroySession()).toContain('; Secure; SameSite=None');
  });

  it('never throws for cookie names that are Object.prototype members', () => {
    for (const cookieName of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const storage = createSessionStorage({ secrets: SECRET, cookieName });
      for (const source of [undefined, '', 'a=1', { cookies: {} }, { headers: {} }]) {
        expect(storage.getSession(source).isNew).toBe(true);
      }
      const session = storage.getSession(null);
      session.set('userId', 'u_10');
      const header = cookieHeader(storage.commitSession(session));
      expect(storage.getSession(`other=1; ${header}`).get('userId')).toBe('u_10');
    }
  });
});

describe('tampering, expiry and foreign tokens', () => {
  function committed(storage = createSessionStorage({ secrets: SECRET })): string {
    const session = storage.getSession(null);
    session.set('userId', 'u_3');
    return cookieHeader(storage.commitSession(session));
  }

  it('reads tampered tokens as an empty new session, never throwing', () => {
    const storage = createSessionStorage({ secrets: SECRET });
    const header = committed(storage);
    const [name, token] = header.split('=') as [string, string];
    const [version, exp, payload, mac] = token.split('.') as [string, string, string, string];
    const flip = (text: string, at: number): string =>
      `${text.slice(0, at)}${text[at] === 'A' ? 'B' : 'A'}${text.slice(at + 1)}`;
    const tampered = [
      `${version}.${exp}.${flip(payload, 20)}.${mac}`,
      `${version}.${exp}.${payload}.${flip(mac, 5)}`,
      `${version}.${Number(exp) + 1000}.${payload}.${mac}`,
      `v2.${exp}.${payload}.${mac}`,
      `${version}.0${exp}.${payload}.${mac}`,
      `${version}.${exp}.${payload}`,
      `${version}.${exp}.${payload}.${mac}.extra`,
      'garbage',
      '....',
      `${version}.${exp}..${mac}`,
    ];
    for (const value of tampered) {
      const session = storage.getSession(`${name}=${value}`);
      expect(session.isNew, value).toBe(true);
      expect(session.data).toEqual({});
    }
  });

  it('expires sessions at their exp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const storage = createSessionStorage({ secrets: SECRET, maxAge: 60 });
    const header = committed(storage);
    vi.setSystemTime(new Date('2030-01-01T00:00:59Z'));
    expect(storage.getSession(header).get('userId')).toBe('u_3');
    vi.setSystemTime(new Date('2030-01-01T00:01:00Z'));
    expect(storage.getSession(header).isNew).toBe(true);
  });

  it('rejects tokens minted under another secret or cookie name', () => {
    const header = committed();
    expect(createSessionStorage({ secrets: OLD_SECRET }).getSession(header).isNew).toBe(true);
    // Same secret, different cookie: a user session cannot be replayed as an admin one.
    const admin = createSessionStorage({ secrets: SECRET, cookieName: 'admin_session' });
    expect(admin.getSession(`admin_session=${header.split('=')[1] as string}`).isNew).toBe(true);
  });

  it('rotates keys: old-secret sessions stay valid, new commits use the first secret', () => {
    const oldHeader = committed(createSessionStorage({ secrets: OLD_SECRET }));
    const rotated = createSessionStorage({ secrets: [SECRET, OLD_SECRET] });
    const session = rotated.getSession(oldHeader);
    expect(session.get('userId')).toBe('u_3');
    const renewed = cookieHeader(rotated.commitSession(session));
    expect(createSessionStorage({ secrets: SECRET }).getSession(renewed).get('userId')).toBe('u_3');
    expect(createSessionStorage({ secrets: OLD_SECRET }).getSession(renewed).isNew).toBe(true);
  });

  it('rejects a payload that decrypts to non-object JSON', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    for (const data of [[1, 2], null, 'text']) {
      const token = sealSessionToken(data as unknown as Record<string, unknown>, {
        cookieName: 'gio_session',
        secret: SECRET,
        exp,
      });
      expect(openSessionToken(token, { cookieName: 'gio_session', secrets: [SECRET], now: exp - 1 })).toBeNull();
    }
  });
});

describe('cookie size limit', () => {
  it('throws a clear error past 4096 bytes', () => {
    const storage = createSessionStorage({ secrets: SECRET });
    const session = storage.getSession(null);
    session.set('blob', 'x'.repeat(2900));
    expect(storage.commitSession(session).length).toBeLessThan(4200);
    session.set('blob', 'x'.repeat(3100));
    expect(() => storage.commitSession(session)).toThrow(/over the 4096-byte browser limit/);
  });

  it('ignores oversized incoming cookies', () => {
    const storage = createSessionStorage({ secrets: SECRET });
    expect(storage.getSession(`gio_session=v1.${'9'.repeat(5000)}`).isNew).toBe(true);
  });
});

describe('secrets', () => {
  it('reads GIO_SESSION_SECRET, comma-separated for rotation', () => {
    process.env.GIO_SESSION_SECRET = OLD_SECRET;
    const old = createSessionStorage();
    const s = old.getSession(null);
    s.set('k', 'v');
    const header = cookieHeader(old.commitSession(s));
    process.env.GIO_SESSION_SECRET = ` ${SECRET} , ${OLD_SECRET} ,`;
    const rotated = createSessionStorage();
    expect(rotated.getSession(header).get('k')).toBe('v');
    expect(createSessionStorage({ secrets: SECRET }).getSession(cookieHeader(rotated.commitSession(s))).get('k')).toBe('v');
  });

  it('requires at least 32 bytes per secret', () => {
    expect(() => createSessionStorage({ secrets: 'too-short' })).toThrow(/shorter than 32 bytes/);
    expect(() => createSessionStorage({ secrets: [SECRET, 'too-short'] })).toThrow(/secret #2/);
    process.env.GIO_SESSION_SECRET = `${SECRET},short`;
    expect(() => createSessionStorage()).toThrow(/GIO_SESSION_SECRET: secret #2/);
  });

  it('throws in production without a secret, showing how to generate one', () => {
    for (const nodeEnv of ['production', 'test', undefined]) {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      expect(() => createSessionStorage()).toThrow(/GIO_SESSION_SECRET is not set[\s\S]*randomBytes\(32\)/);
    }
  });

  it('uses one ephemeral secret per process in development, with a single warning', () => {
    process.env.NODE_ENV = 'development';
    const a = createSessionStorage();
    const b = createSessionStorage();
    const s = a.getSession(null);
    s.set('k', 'v');
    expect(b.getSession(cookieHeader(a.commitSession(s))).get('k')).toBe('v');
    const warnings = stderr.filter(line => line.includes('ephemeral development secret'));
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0] as string)).toMatchObject({ level: 'warn' });
  });

  it('warns when the dev server handed over an ephemeral secret', () => {
    process.env.NODE_ENV = 'development';
    process.env.GIO_SESSION_SECRET = SECRET;
    process.env.GIO_SESSION_SECRET_EPHEMERAL = '1';
    createSessionStorage();
    expect(stderr.join('')).toMatch(/dev server generated an ephemeral session secret/);
  });

  it('stays quiet with a real secret', () => {
    process.env.NODE_ENV = 'development';
    process.env.GIO_SESSION_SECRET = SECRET;
    createSessionStorage();
    expect(stderr).toEqual([]);
  });

  it('warns when explicit secrets sign with a key the Rust guards do not have', () => {
    // require_session guards verify with GIO_SESSION_SECRET only.
    process.env.GIO_SESSION_SECRET = `${SECRET},${OLD_SECRET}`;
    createSessionStorage({ secrets: SECRET });
    createSessionStorage({ secrets: [OLD_SECRET, 'unrelated-but-long-enough-0123456789abcdef'] });
    expect(stderr).toEqual([]);

    createSessionStorage({ cookieName: 'admin_session', secrets: ['another-secret-0123456789abcdefghijklmn', SECRET] });
    const warnings = stderr.filter(line => line.includes('require_session guards verify only with GIO_SESSION_SECRET'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('admin_session');
  });

  it('does not warn about explicit secrets when GIO_SESSION_SECRET is unset', () => {
    createSessionStorage({ secrets: SECRET });
    expect(stderr).toEqual([]);
  });
});

// The same literals are verified in crates/giojs-server/src/session_token.rs:
// keep the two in sync when the format changes.
describe('cross-language token vectors', () => {
  const VECTOR_SECRET = 'gio-test-vector-secret-a-0123456789abcdef';
  const OTHER_SECRET = 'gio-test-vector-secret-b-0123456789abcdef';
  const IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const NOW = 1_760_000_000;
  const VALID =
    'v1.4102444800.AAECAwQFBgcICQoLulSFE6juicZYkyz2zL_R94C1c0ZStIFLFSdMJqWsx8KOH636qj_eybdLmR95gANU.pr8iwxUtYILoEPgE-oRgAoi3LwNLjDoZSC0zlskJc5M';
  const EXPIRED =
    'v1.1700000000.AAECAwQFBgcICQoLulSFE6juicZYkyz2zL_R94C1c0ZStIFLFSdMJqWsx8J6XUCOUuq0m3oD4liTnyEg.OLt5UBtgtgTwmLash43NDFDm_ETiuJCSe5t66dzzFLE';
  const TAMPERED = VALID.replace('ulSFE6', 'ulSFE7');
  const open = (token: string, secrets: string[], cookieName = 'gio_session') =>
    openSessionToken(token, { cookieName, secrets, now: NOW });

  it('seals deterministically with a fixed IV', () => {
    const data = { userId: 'u_42', role: 'admin' };
    expect(sealSessionToken(data, { cookieName: 'gio_session', secret: VECTOR_SECRET, exp: 4102444800, iv: IV })).toBe(VALID);
    expect(sealSessionToken(data, { cookieName: 'gio_session', secret: VECTOR_SECRET, exp: 1700000000, iv: IV })).toBe(EXPIRED);
  });

  it('opens only the valid vector', () => {
    expect(open(VALID, [VECTOR_SECRET])).toEqual({ userId: 'u_42', role: 'admin' });
    expect(open(VALID, [OTHER_SECRET, VECTOR_SECRET])).toEqual({ userId: 'u_42', role: 'admin' });
    expect(open(EXPIRED, [VECTOR_SECRET])).toBeNull();
    expect(open(TAMPERED, [VECTOR_SECRET])).toBeNull();
    expect(open(VALID, [OTHER_SECRET])).toBeNull();
    expect(open(VALID, [VECTOR_SECRET], 'other_session')).toBeNull();
  });
});
