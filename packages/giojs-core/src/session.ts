/**
 * giojs-core/src/session.ts
 *
 * Encrypted cookie sessions. The session data lives in the cookie itself,
 * encrypted and authenticated, so there is no server-side store; the Rust
 * server can still check a session's authenticity and expiry on its own
 * (require_session guards, crates/giojs-server/src/session_token.rs) with
 * the MAC key alone, without decrypting.
 *
 * Token format (internal - may change behind a new version tag):
 *
 *   v1.<exp>.<payload>.<mac>
 *
 *   exp      expiry, unix seconds, decimal without leading zeros
 *   payload  base64url(iv[12] | AES-256-GCM ciphertext | tag[16]) of the
 *            JSON data; AAD = "<cookie name>\nv1.<exp>"
 *   mac      base64url(HMAC-SHA256(macKey, "<cookie name>\nv1.<exp>.<payload>"))
 *
 * base64url is unpadded. Keys are HKDF-SHA256 (empty salt) of each secret
 * with info "gio-session-enc" / "gio-session-mac". Binding the cookie name
 * stops a token minted for one session cookie from being replayed in
 * another that shares the secret. Expired, tampered, or foreign tokens read
 * as an empty new session - never an exception.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  decodeBase64urlExact,
  deriveKey,
  isValidCookieName,
  normalizeSecrets,
  parseCookies,
  serializeCookie,
  SECRET_GENERATE_HINT,
  type CookieOptions,
} from './cookies.ts';
import { logger } from './logger.ts';
import { isDevMode } from './mode.ts';

export const SESSION_SECRET_ENV = 'GIO_SESSION_SECRET';
/** Set by the Rust dev server when it generated GIO_SESSION_SECRET itself. */
const EPHEMERAL_FLAG_ENV = 'GIO_SESSION_SECRET_EPHEMERAL';
const DEFAULT_COOKIE_NAME = 'gio_session';
const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60;
/** Browsers drop cookies whose name + value exceed 4096 bytes. */
const MAX_COOKIE_BYTES = 4096;
const VERSION = 'v1';
const ENC_INFO = 'gio-session-enc';
const MAC_INFO = 'gio-session-mac';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAC_BYTES = 32;
const EXP_PATTERN = /^[1-9][0-9]{0,14}$/;

/**
 * The default session shape. A storage's type parameter may be any object
 * type - interfaces included - whose values are JSON-serializable.
 */
export type SessionData = Record<string, unknown>;

export interface Session<Data extends object = SessionData> {
  /** True when the request carried no valid session (absent, expired, or tampered). */
  readonly isNew: boolean;
  /** A shallow copy of the current data. */
  readonly data: Partial<Data>;
  get<K extends keyof Data & string>(key: K): Data[K] | undefined;
  /** Values must be JSON-serializable. Setting `undefined` unsets the key. */
  set<K extends keyof Data & string>(key: K, value: Data[K]): void;
  unset(key: keyof Data & string): void;
  has(key: keyof Data & string): boolean;
}

export interface SessionStorageOptions {
  /** Defaults to `gio_session`, the cookie `require_session` guards read. */
  cookieName?: string;
  /**
   * Defaults to GIO_SESSION_SECRET (comma-separated for rotation). The first
   * secret encrypts and signs; every secret is accepted when reading, so a
   * new secret can be prepended without logging everyone out.
   */
  secrets?: string | readonly string[];
  /** Session lifetime in seconds, carried in the token and the cookie. Defaults to 7 days. */
  maxAge?: number;
  /** Cookie attributes; the defaults are serializeCookie's. */
  cookie?: Omit<CookieOptions, 'maxAge' | 'expires'>;
}

export interface CommitSessionOptions {
  /** Override the storage's maxAge for this cookie (seconds, > 0). */
  maxAge?: number;
}

/**
 * Anything a cookie header can be read from: a getServerSideProps context
 * or route.ts request (`cookies`), a plugin's IPC request (`headers`), a
 * web Request, or the raw Cookie header.
 */
export type SessionSource =
  | { cookies: Record<string, string> }
  | { headers: Record<string, string | undefined> }
  | { headers: { get(name: string): string | null } }
  | string
  | null
  | undefined;

export interface SessionStorage<Data extends object = SessionData> {
  readonly cookieName: string;
  /** Read the request's session. Never throws for bad cookies: those yield an empty new session. */
  getSession(source: SessionSource): Session<Data>;
  /** Encrypt `session` into a Set-Cookie value. Throws when the cookie would exceed 4096 bytes. */
  commitSession(session: Session<Data>, options?: CommitSessionOptions): string;
  /** A Set-Cookie value that deletes the session cookie. */
  destroySession(): string;
}

interface DerivedKeys {
  enc: Buffer;
  mac: Buffer;
}

class CookieSession<Data extends object> implements Session<Data> {
  // A Map, not an object: keys like "__proto__" stay plain data.
  readonly #values: Map<string, unknown>;
  readonly isNew: boolean;

  constructor(values: Map<string, unknown>, isNew: boolean) {
    this.#values = values;
    this.isNew = isNew;
  }

  get data(): Partial<Data> {
    return Object.fromEntries(this.#values) as Partial<Data>;
  }

  get<K extends keyof Data & string>(key: K): Data[K] | undefined {
    return this.#values.get(key) as Data[K] | undefined;
  }

  set<K extends keyof Data & string>(key: K, value: Data[K]): void {
    if (value === undefined) this.#values.delete(key);
    else this.#values.set(key, value);
  }

  unset(key: keyof Data & string): void {
    this.#values.delete(key);
  }

  has(key: keyof Data & string): boolean {
    return this.#values.has(key);
  }
}

function deriveKeys(secret: string): DerivedKeys {
  return { enc: deriveKey(secret, ENC_INFO), mac: deriveKey(secret, MAC_INFO) };
}

function macFor(key: Buffer, cookieName: string, signed: string): Buffer {
  return createHmac('sha256', key).update(`${cookieName}\n${signed}`, 'utf8').digest();
}

function sealWithKeys(data: SessionData, cookieName: string, keys: DerivedKeys, exp: number, iv: Buffer): string {
  const head = `${VERSION}.${exp}`;
  const cipher = createCipheriv('aes-256-gcm', keys.enc, iv);
  cipher.setAAD(Buffer.from(`${cookieName}\n${head}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const signed = `${head}.${Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url')}`;
  return `${signed}.${macFor(keys.mac, cookieName, signed).toString('base64url')}`;
}

/** Internal: build a token. `iv` is injectable for cross-language test vectors. */
export function sealSessionToken(
  data: SessionData,
  options: { cookieName: string; secret: string; exp: number; iv?: Buffer },
): string {
  const iv = options.iv ?? randomBytes(IV_BYTES);
  return sealWithKeys(data, options.cookieName, deriveKeys(options.secret), options.exp, iv);
}

/**
 * Internal: the data inside a valid, unexpired token, or null. Mirrors the
 * Rust verifier's checks (shape, version, expiry, MAC) before decrypting.
 */
export function openSessionToken(
  token: string,
  options: { cookieName: string; secrets: readonly string[]; now: number },
): SessionData | null {
  return openWithKeys(token, options.cookieName, options.secrets.map(deriveKeys), options.now);
}

function openWithKeys(
  token: string,
  cookieName: string,
  keyring: readonly DerivedKeys[],
  now: number,
): SessionData | null {
  if (token.length > MAX_COOKIE_BYTES) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, expText, payloadText, macText] = parts as [string, string, string, string];
  if (version !== VERSION || !EXP_PATTERN.test(expText)) return null;
  if (now >= Number(expText)) return null;
  const mac = decodeBase64urlExact(macText, MAC_BYTES);
  if (mac === null) return null;

  const signed = `${version}.${expText}.${payloadText}`;
  let keys: DerivedKeys | undefined;
  for (const candidate of keyring) {
    // Constant-time per key; every key is tried, whatever matched.
    if (timingSafeEqual(macFor(candidate.mac, cookieName, signed), mac) && keys === undefined) {
      keys = candidate;
    }
  }
  if (keys === undefined) return null;

  const payload = Buffer.from(payloadText, 'base64url');
  if (payload.length < IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys.enc, payload.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(`${cookieName}\n${version}.${expText}`, 'utf8'));
    decipher.setAuthTag(payload.subarray(payload.length - TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(payload.subarray(IV_BYTES, payload.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
    const data: unknown = JSON.parse(plaintext);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    return data as SessionData;
  } catch {
    return null;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function readCookieHeader(source: SessionSource): Record<string, string> {
  if (source === null || source === undefined) return {};
  if (typeof source === 'string') return parseCookies(source);
  // Prefer `cookies`: on a getServerSideProps context reading it is what
  // marks the render personalized (never cached for everyone).
  if ('cookies' in source && typeof source.cookies === 'object' && source.cookies !== null) {
    return source.cookies;
  }
  if ('headers' in source && typeof source.headers === 'object' && source.headers !== null) {
    const headers = source.headers;
    if (typeof (headers as { get?: unknown }).get === 'function') {
      return parseCookies((headers as { get(name: string): string | null }).get('cookie') ?? undefined);
    }
    return parseCookies((headers as Record<string, string | undefined>)['cookie']);
  }
  return {};
}

// One ephemeral secret per process (Symbol.for: shared even when the module
// is loaded more than once), so every storage in the worker agrees on it.
const DEV_SECRET_KEY = Symbol.for('gio.session.devSecret');
const DEV_WARNED_KEY = Symbol.for('gio.session.devSecretWarned');

function warnOnce(message: string): void {
  const store = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (store[DEV_WARNED_KEY] === true) return;
  store[DEV_WARNED_KEY] = true;
  logger.warn(message);
}

function resolveSecrets(option: string | readonly string[] | undefined): string[] {
  if (option !== undefined) return normalizeSecrets(option, 'createSessionStorage');
  const fromEnv = (process.env[SESSION_SECRET_ENV] ?? '')
    .split(',')
    .map(secret => secret.trim())
    .filter(secret => secret !== '');
  if (fromEnv.length > 0) {
    if (isDevMode() && process.env[EPHEMERAL_FLAG_ENV] === '1') {
      warnOnce(
        `${SESSION_SECRET_ENV} is not set - the dev server generated an ephemeral session secret, ` +
          'so sessions reset when it restarts',
      );
    }
    return normalizeSecrets(fromEnv, SESSION_SECRET_ENV);
  }
  if (!isDevMode()) {
    throw new Error(
      `${SESSION_SECRET_ENV} is not set. Sessions need a secret of at least 32 bytes in production. ` +
        `Generate one with:\n  ${SECRET_GENERATE_HINT}\n` +
        'and set it in the server environment (or a git-ignored .env.production.local). ' +
        'Several comma-separated secrets rotate keys: the first signs, all verify.',
    );
  }
  const store = globalThis as unknown as Record<symbol, string | undefined>;
  store[DEV_SECRET_KEY] ??= randomBytes(32).toString('base64url');
  warnOnce(
    `${SESSION_SECRET_ENV} is not set - using an ephemeral development secret, so sessions reset on restart`,
  );
  return [store[DEV_SECRET_KEY]];
}

/**
 * Create an encrypted cookie session storage. Throws at creation time for
 * a missing secret in production, a secret under 32 bytes, an invalid
 * cookie name, or cookie options that browsers would reject.
 */
export function createSessionStorage<Data extends object = SessionData>(
  options: SessionStorageOptions = {},
): SessionStorage<Data> {
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
  if (!isValidCookieName(cookieName)) {
    throw new TypeError(`createSessionStorage: invalid cookieName ${JSON.stringify(cookieName)}`);
  }
  const maxAge = options.maxAge ?? DEFAULT_MAX_AGE;
  const validMaxAge = (value: number): boolean => Number.isInteger(value) && value > 0;
  if (!validMaxAge(maxAge)) {
    throw new TypeError('createSessionStorage: maxAge must be a positive whole number of seconds');
  }
  const keyring = resolveSecrets(options.secrets).map(deriveKeys);
  const cookieOptions = options.cookie ?? {};
  // Surface bad cookie options now, not on the first login.
  serializeCookie(cookieName, '', cookieOptions);

  return {
    cookieName,

    getSession(source) {
      const token = readCookieHeader(source)[cookieName];
      const data = token === undefined || token === '' ? null : openWithKeys(token, cookieName, keyring, nowSeconds());
      return data === null
        ? new CookieSession<Data>(new Map(), true)
        : new CookieSession<Data>(new Map(Object.entries(data)), false);
    },

    commitSession(session, commitOptions = {}) {
      const lifetime = commitOptions.maxAge ?? maxAge;
      if (!validMaxAge(lifetime)) {
        throw new TypeError('commitSession: maxAge must be a positive whole number of seconds');
      }
      const exp = nowSeconds() + lifetime;
      const token = sealWithKeys(session.data, cookieName, keyring[0] as DerivedKeys, exp, randomBytes(IV_BYTES));
      const size = Buffer.byteLength(cookieName) + 1 + token.length;
      if (size > MAX_COOKIE_BYTES) {
        throw new Error(
          `session cookie "${cookieName}" would be ${size} bytes, over the ${MAX_COOKIE_BYTES}-byte browser limit - ` +
            'keep only small values (like a user id) in the session and look the rest up server-side',
        );
      }
      return serializeCookie(cookieName, token, { ...cookieOptions, maxAge: lifetime });
    },

    destroySession() {
      return serializeCookie(cookieName, '', { ...cookieOptions, maxAge: 0, expires: new Date(0) });
    },
  };
}
