/**
 * giojs-core/src/cookies.test.ts
 *
 * Cookie parsing/serialization (secure defaults, RFC 6265 validation,
 * header-injection attempts) and HMAC-signed values (rotation, tampering).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseCookies, serializeCookie, signValue, unsignValue } from './cookies.ts';

const SECRET = 'cookie-test-secret-0123456789abcdefghij';
const OLD_SECRET = 'cookie-test-secret-old-0123456789abcdefg';

const savedNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv;
});

describe('parseCookies', () => {
  it('parses pairs, trims whitespace, and keeps the first occurrence', () => {
    expect(parseCookies(' a=1;b = two ; a=3; flag; =x')).toEqual({ a: '1', b: 'two' });
  });

  it('keeps "=" inside values', () => {
    expect(parseCookies('token=abc==; x=1')).toEqual({ token: 'abc==', x: '1' });
  });

  it('returns an empty object for absent or empty headers', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });
});

describe('serializeCookie', () => {
  it('applies the secure defaults in production', () => {
    process.env.NODE_ENV = 'production';
    expect(serializeCookie('theme', 'dark')).toBe('theme=dark; Path=/; HttpOnly; Secure; SameSite=Lax');
  });

  it('treats an unset NODE_ENV as production (Secure on)', () => {
    delete process.env.NODE_ENV;
    expect(serializeCookie('theme', 'dark')).toContain('; Secure');
  });

  it('omits Secure in development and allows an explicit opt-out', () => {
    process.env.NODE_ENV = 'development';
    expect(serializeCookie('theme', 'dark')).toBe('theme=dark; Path=/; HttpOnly; SameSite=Lax');
    process.env.NODE_ENV = 'production';
    expect(serializeCookie('theme', 'dark', { secure: false })).not.toContain('Secure');
  });

  it('serializes every attribute', () => {
    process.env.NODE_ENV = 'production';
    const cookie = serializeCookie('id', 'v1', {
      path: '/app',
      domain: 'example.com',
      maxAge: 3600,
      expires: new Date(Date.UTC(2037, 9, 21, 7, 28, 0)),
      httpOnly: false,
      sameSite: 'none',
      partitioned: true,
    });
    expect(cookie).toBe(
      'id=v1; Max-Age=3600; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Domain=example.com; Path=/app; Secure; SameSite=None; Partitioned',
    );
    expect(serializeCookie('id', 'v', { sameSite: 'strict', secure: false })).toContain('; SameSite=Strict');
  });

  it('allows empty and quoted values (deletion, RFC 6265 DQUOTE form)', () => {
    expect(serializeCookie('gone', '', { maxAge: 0, secure: false })).toBe('gone=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax');
    expect(serializeCookie('q', '"abc"', { secure: false })).toMatch(/^q="abc"; /);
  });

  it.each([
    ['CRLF header injection', 'x\r\nSet-Cookie: admin=1'],
    ['attribute injection via ;', 'x; Domain=evil.com'],
    ['whitespace', 'a b'],
    ['comma', 'a,b'],
    ['backslash', 'a\\b'],
    ['a stray quote', 'a"b'],
    ['non-ASCII', 'café'],
    ['NUL', 'a\0b'],
  ])('rejects a value with %s', (_label, value) => {
    expect(() => serializeCookie('name', value)).toThrow(TypeError);
  });

  it.each([['', 'empty'], ['a=b', 'equals'], ['a b', 'space'], ['a;b', 'semicolon'], ['a\nb', 'newline'], ['(x)', 'separators']])(
    'rejects the cookie name %j (%s)',
    name => {
      expect(() => serializeCookie(name, 'v')).toThrow(/invalid cookie name/);
    },
  );

  it('rejects injectable or malformed attributes', () => {
    expect(() => serializeCookie('a', 'b', { path: '/x; Domain=evil.com' })).toThrow(/invalid path/);
    expect(() => serializeCookie('a', 'b', { path: 'relative' })).toThrow(/invalid path/);
    expect(() => serializeCookie('a', 'b', { domain: 'evil.com; Secure' })).toThrow(/invalid domain/);
    expect(() => serializeCookie('a', 'b', { maxAge: 1.5 })).toThrow(/maxAge/);
    expect(() => serializeCookie('a', 'b', { maxAge: Number.NaN })).toThrow(/maxAge/);
    expect(() => serializeCookie('a', 'b', { expires: new Date('nope') })).toThrow(/expires/);
    expect(() => serializeCookie('a', 'b', { sameSite: 'Lax' as 'lax' })).toThrow(/sameSite/);
  });

  it('rejects combinations browsers silently drop', () => {
    expect(() => serializeCookie('a', 'b', { sameSite: 'none', secure: false })).toThrow(/requires secure/);
    expect(() => serializeCookie('a', 'b', { partitioned: true, secure: false })).toThrow(/requires secure/);
    expect(() => serializeCookie('__Secure-a', 'b', { secure: false })).toThrow(/__Secure-/);
    expect(() => serializeCookie('__Host-a', 'b', { secure: true, path: '/x' })).toThrow(/__Host-/);
    expect(() => serializeCookie('__Host-a', 'b', { secure: true, domain: 'example.com' })).toThrow(/__Host-/);
    expect(serializeCookie('__Host-a', 'b', { secure: true })).toBe('__Host-a=b; Path=/; HttpOnly; Secure; SameSite=Lax');
  });
});

describe('signValue / unsignValue', () => {
  it('round-trips, keeping the value readable', () => {
    const signed = signValue('user-42', SECRET);
    expect(signed).toMatch(/^user-42\.[A-Za-z0-9_-]{43}$/);
    expect(unsignValue(signed, SECRET)).toBe('user-42');
  });

  it('handles values containing dots and empty values', () => {
    expect(unsignValue(signValue('a.b.c', SECRET), SECRET)).toBe('a.b.c');
    expect(unsignValue(signValue('', SECRET), SECRET)).toBe('');
  });

  it('rejects a changed value, a changed signature, and malformed input', () => {
    const signed = signValue('user-42', SECRET);
    expect(unsignValue(signed.replace('user-42', 'user-43'), SECRET)).toBeNull();
    const last = signed.at(-2) === 'A' ? 'B' : 'A';
    expect(unsignValue(`${signed.slice(0, -2)}${last}${signed.at(-1)}`, SECRET)).toBeNull();
    expect(unsignValue('no-signature', SECRET)).toBeNull();
    expect(unsignValue('user-42.', SECRET)).toBeNull();
    expect(unsignValue('user-42.!!!', SECRET)).toBeNull();
    expect(unsignValue(`${signed}AA`, SECRET)).toBeNull();
  });

  it('rejects a non-canonical signature spelling', () => {
    const signed = signValue('v', SECRET);
    // The 43rd character carries 2 padding bits; flipping them must not verify.
    const lastChar = signed.at(-1) as string;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const twin = alphabet[alphabet.indexOf(lastChar) ^ 1] as string;
    expect(unsignValue(`${signed.slice(0, -1)}${twin}`, SECRET)).toBeNull();
  });

  it('rotates keys: the first secret signs, every secret verifies', () => {
    const old = signValue('v', OLD_SECRET);
    expect(unsignValue(old, [SECRET, OLD_SECRET])).toBe('v');
    expect(unsignValue(old, [SECRET])).toBeNull();
    expect(signValue('v', [SECRET, OLD_SECRET])).toBe(signValue('v', SECRET));
  });

  it('requires secrets of at least 32 bytes', () => {
    expect(() => signValue('v', 'short')).toThrow(/32 bytes/);
    expect(() => signValue('v', [])).toThrow(/at least one secret/);
    expect(() => unsignValue('v.x', [SECRET, 'short'])).toThrow(/secret #2/);
  });
});
