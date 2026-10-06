/**
 * giojs-core/src/cookies.ts
 *
 * Cookie primitives for app code: parsing the Cookie request header and
 * serializing Set-Cookie values with secure defaults, plus HMAC-signed
 * values. Serialization validates every part against RFC 6265 and throws on
 * anything that could not be sent verbatim - a value carrying `;` or CR/LF
 * would otherwise let request data inject extra attributes or headers.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { isDevMode } from './mode.ts';

export interface CookieOptions {
  /** Defaults to `/`. */
  path?: string;
  /** Omitted by default (a host-only cookie). */
  domain?: string;
  /** Lifetime in whole seconds; `0` deletes the cookie. Omitted = session cookie. */
  maxAge?: number;
  expires?: Date;
  /** Defaults to true: page scripts cannot read the cookie. */
  httpOnly?: boolean;
  /**
   * Defaults to true in production and false in development (NODE_ENV,
   * as decided by the Rust server). Pass `false` explicitly to serve a
   * production build over plain http.
   */
  secure?: boolean;
  /** Defaults to `lax`. `none` requires `secure`. */
  sameSite?: 'lax' | 'strict' | 'none';
  /** CHIPS partitioned cookie. Requires `secure`. */
  partitioned?: boolean;
}

// RFC 6265 4.1.1: cookie-name is an RFC 2616 token; cookie-octet excludes
// CTLs, whitespace, DQUOTE, comma, semicolon and backslash.
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE = /^(?:[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*|"[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*")$/;
// path-value: any CHAR except CTLs or ";".
const COOKIE_PATH = /^\/[\x20-\x3A\x3C-\x7E]*$/;
const COOKIE_DOMAIN = /^\.?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** True when `name` is a valid RFC 6265 cookie name. */
export function isValidCookieName(name: string): boolean {
  return COOKIE_NAME.test(name);
}

/** Parse a Cookie header into name → value (first occurrence wins). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined || header === '') return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== '' && cookies[name] === undefined) {
      cookies[name] = part.slice(eq + 1).trim();
    }
  }
  return cookies;
}

/**
 * Build one Set-Cookie header value. Defaults: `Path=/`, `HttpOnly`,
 * `SameSite=Lax`, and `Secure` in production. Values are not encoded -
 * encode anything outside the cookie-octet set yourself (for example with
 * `encodeURIComponent`); an invalid name, value or attribute throws.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!isValidCookieName(name)) {
    throw new TypeError(`invalid cookie name ${JSON.stringify(name)}: RFC 6265 allows only token characters`);
  }
  if (!COOKIE_VALUE.test(value)) {
    throw new TypeError(
      `invalid value for cookie "${name}": only RFC 6265 cookie-octets are allowed ` +
        '(no whitespace, quotes, commas, semicolons or backslashes) - encode it first, e.g. with encodeURIComponent',
    );
  }
  const path = options.path ?? '/';
  const secure = options.secure ?? !isDevMode();
  const sameSite = options.sameSite ?? 'lax';
  const httpOnly = options.httpOnly ?? true;

  if (!COOKIE_PATH.test(path)) {
    throw new TypeError(`invalid path for cookie "${name}": must start with "/" and contain no control characters or ";"`);
  }
  if (options.domain !== undefined && !COOKIE_DOMAIN.test(options.domain)) {
    throw new TypeError(`invalid domain for cookie "${name}": ${JSON.stringify(options.domain)}`);
  }
  if (sameSite !== 'lax' && sameSite !== 'strict' && sameSite !== 'none') {
    throw new TypeError(`invalid sameSite for cookie "${name}": expected 'lax', 'strict' or 'none'`);
  }
  // Browsers drop these combinations silently; failing here names the cause.
  if (sameSite === 'none' && !secure) {
    throw new TypeError(`cookie "${name}": sameSite 'none' requires secure`);
  }
  if (options.partitioned === true && !secure) {
    throw new TypeError(`cookie "${name}": partitioned requires secure`);
  }
  if (name.startsWith('__Secure-') && !secure) {
    throw new TypeError(`cookie "${name}": the __Secure- prefix requires secure`);
  }
  if (name.startsWith('__Host-') && (!secure || path !== '/' || options.domain !== undefined)) {
    throw new TypeError(`cookie "${name}": the __Host- prefix requires secure, path "/" and no domain`);
  }

  let cookie = `${name}=${value}`;
  if (options.maxAge !== undefined) {
    if (!Number.isInteger(options.maxAge)) {
      throw new TypeError(`invalid maxAge for cookie "${name}": expected whole seconds`);
    }
    cookie += `; Max-Age=${options.maxAge}`;
  }
  if (options.expires !== undefined) {
    if (!(options.expires instanceof Date) || Number.isNaN(options.expires.getTime())) {
      throw new TypeError(`invalid expires for cookie "${name}": expected a valid Date`);
    }
    cookie += `; Expires=${options.expires.toUTCString()}`;
  }
  if (options.domain !== undefined) cookie += `; Domain=${options.domain}`;
  cookie += `; Path=${path}`;
  if (httpOnly) cookie += '; HttpOnly';
  if (secure) cookie += '; Secure';
  cookie += `; SameSite=${sameSite === 'lax' ? 'Lax' : sameSite === 'strict' ? 'Strict' : 'None'}`;
  if (options.partitioned === true) cookie += '; Partitioned';
  return cookie;
}

// ── Secrets ──────────────────────────────────────────────────────────────────

/** Minimum secret length in UTF-8 bytes (a 256-bit key's worth). */
export const MIN_SECRET_BYTES = 32;

export const SECRET_GENERATE_HINT =
  'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"';

/**
 * Normalize a secret list: the first entry signs, all verify. Each must be
 * at least 32 bytes - short secrets are rejected rather than stretched.
 */
export function normalizeSecrets(secrets: string | readonly string[], what: string): string[] {
  const list = typeof secrets === 'string' ? [secrets] : [...secrets];
  if (list.length === 0) {
    throw new TypeError(`${what}: at least one secret is required`);
  }
  list.forEach((secret, index) => {
    if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
      throw new TypeError(
        `${what}: secret #${index + 1} is shorter than ${MIN_SECRET_BYTES} bytes. Generate one with:\n  ${SECRET_GENERATE_HINT}`,
      );
    }
  });
  return list;
}

/** HKDF-SHA256 (empty salt) of a secret, 32 bytes for `info`. */
export function deriveKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), info, 32));
}

/**
 * Decode an unpadded base64url string, or null when it is not the
 * canonical encoding of `length` bytes. Canonical-only, so one MAC has
 * exactly one accepted spelling (the Rust verifier is equally strict).
 */
export function decodeBase64urlExact(text: string, length: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== text) return null;
  return bytes;
}

// ── Signed values ────────────────────────────────────────────────────────────

const SIGN_INFO = 'gio-signed-value';
const MAC_BYTES = 32;

/**
 * `value.<base64url HMAC-SHA256>` with a key derived from the first secret.
 * Signing proves integrity, not secrecy: the value stays readable. Signed
 * values are cookie-safe whenever `value` is.
 */
export function signValue(value: string, secrets: string | readonly string[]): string {
  const [secret] = normalizeSecrets(secrets, 'signValue');
  const mac = createHmac('sha256', deriveKey(secret as string, SIGN_INFO)).update(value, 'utf8').digest();
  return `${value}.${mac.toString('base64url')}`;
}

/**
 * The original value when `signed` carries a valid signature from any of
 * `secrets` (key rotation: old secrets keep verifying), otherwise null.
 * Signatures are compared in constant time.
 */
export function unsignValue(signed: string, secrets: string | readonly string[]): string | null {
  const list = normalizeSecrets(secrets, 'unsignValue');
  const dot = signed.lastIndexOf('.');
  if (dot === -1) return null;
  const value = signed.slice(0, dot);
  const provided = decodeBase64urlExact(signed.slice(dot + 1), MAC_BYTES);
  if (provided === null) return null;
  let valid = false;
  for (const secret of list) {
    const expected = createHmac('sha256', deriveKey(secret, SIGN_INFO)).update(value, 'utf8').digest();
    // No early exit: every secret is tried whatever the outcome.
    if (timingSafeEqual(expected, provided)) valid = true;
  }
  return valid ? value : null;
}
