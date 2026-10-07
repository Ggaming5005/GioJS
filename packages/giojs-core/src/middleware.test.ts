/**
 * giojs-core/src/middleware.test.ts
 *
 * Unit tests for the middleware rules shape helper, the strict validation
 * applied to a project's middleware.ts default export, and the loader that
 * refuses a file it cannot load.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { defineMiddleware, middlewareRulesOrThrow, validateMiddlewareRules } from './middleware.ts';
import { loadMiddlewareRules } from './middleware-loader.ts';

describe('defineMiddleware', () => {
  it('returns the rules unchanged', () => {
    const rules = {
      redirects: [{ from: '/old', to: '/new', status: 301 as const }],
      guards: [{ path: '/admin', requireCookie: 'session', redirectTo: '/' }],
    };
    expect(defineMiddleware(rules)).toBe(rules);
  });
});

describe('validateMiddlewareRules', () => {
  it('accepts a fully-formed rules object without problems', () => {
    const { rules, problems } = validateMiddlewareRules({
      redirects: [{ from: '/blog/:slug', to: '/posts/:slug', status: 308 }],
      rewrites: [{ from: '/docs/*rest', to: '/guide/*rest' }],
      headers: [{ path: '/docs', headers: { 'x-frame-options': 'DENY' } }],
      guards: [{ path: '/admin', requireCookie: 'session', redirectTo: '/' }],
    });
    expect(problems).toEqual([]);
    expect(rules.redirects).toEqual([{ from: '/blog/:slug', to: '/posts/:slug', status: 308 }]);
    expect(rules.rewrites).toEqual([{ from: '/docs/*rest', to: '/guide/*rest' }]);
    expect(rules.headers).toEqual([{ path: '/docs', headers: { 'x-frame-options': 'DENY' } }]);
    expect(rules.guards).toEqual([{ path: '/admin', requireCookie: 'session', redirectTo: '/' }]);
  });

  it('returns empty rules for undefined and null exports', () => {
    expect(validateMiddlewareRules(undefined)).toEqual({ rules: {}, problems: [] });
    expect(validateMiddlewareRules(null)).toEqual({ rules: {}, problems: [] });
  });

  it('refuses a non-object export and unknown sections', () => {
    expect(validateMiddlewareRules('not rules').problems).toEqual([
      'the default export must be an object - export default defineMiddleware({ ... })',
    ]);
    expect(validateMiddlewareRules({ guard: [] }).problems).toEqual([
      'unknown key "guard" - did you mean "guards"?',
    ]);
  });

  it('accepts session guards with and without a cookie name', () => {
    const { rules, problems } = validateMiddlewareRules({
      guards: [
        { path: '/admin/*rest', requireSession: true, redirectTo: '/login' },
        { path: '/staff', requireSession: true, requireCookie: 'staff_session', redirectTo: '/' },
        { path: '/beta', requireSession: false, requireCookie: 'beta', redirectTo: '/' },
      ],
    });
    expect(problems).toEqual([]);
    expect(rules.guards).toEqual([
      { path: '/admin/*rest', requireSession: true, redirectTo: '/login' },
      { path: '/staff', requireSession: true, requireCookie: 'staff_session', redirectTo: '/' },
      { path: '/beta', requireCookie: 'beta', redirectTo: '/' },
    ]);
  });

  it('refuses a guard whose path the server could not match', () => {
    // Rust used to skip these with a warning, leaving the path open.
    const { rules, problems } = validateMiddlewareRules({
      guards: [
        { path: 'members/*rest', requireSession: true, redirectTo: '/login' },
        { path: '/a/*rest/c', requireSession: true, redirectTo: '/login' },
        { requireSession: true, redirectTo: '/login' },
      ],
    });
    expect(rules.guards).toBeUndefined();
    expect(problems).toEqual([
      'guards[0] ("members/*rest"): path must start with "/"',
      'guards[1] ("/a/*rest/c"): path a catch-all (*rest) must be the last segment',
      'guards[2]: path must be a non-empty string',
    ]);
  });

  it('refuses a guard with a missing or malformed requirement', () => {
    const { rules, problems } = validateMiddlewareRules({
      guards: [
        { path: '/a', redirectTo: '/login' },
        { path: '/b', requireSession: false, redirectTo: '/login' },
        { path: '/c', requireSession: 'true', redirectTo: '/login' },
        { path: '/d', requireSession: true, requireCookie: '', redirectTo: '/login' },
        { path: '/e', requireCookie: 42, redirectTo: '/login' },
        { path: '/f', requireSession: true, redirectTo: 'login' },
        { path: '/g', requireSession: true },
      ],
    });
    expect(rules.guards).toBeUndefined();
    expect(problems).toEqual([
      'guards[0] ("/a"): names no requirement: set requireSession: true or requireCookie',
      'guards[1] ("/b"): names no requirement: set requireSession: true or requireCookie',
      'guards[2] ("/c"): requireSession must be true or false',
      'guards[3] ("/d"): requireCookie must be a non-empty string',
      'guards[4] ("/e"): requireCookie must be a non-empty string',
      'guards[5] ("/f"): redirectTo must be a path starting with "/" (got "login")',
      'guards[6] ("/g"): redirectTo must be a path starting with "/"',
    ]);
  });

  it('treats unknown keys as typos with the closest valid key', () => {
    const { problems } = validateMiddlewareRules({
      guards: [
        // The typo would otherwise downgrade a session check to cookie presence.
        { path: '/staff', requireCookie: 'staff', require_session: true, redirectTo: '/login' },
      ],
      redirects: [{ from: '/a', to: '/b', stauts: 301 }],
    });
    expect(problems).toEqual([
      'redirects[0] ("/a"): unknown key "stauts" - did you mean "status"?',
      'guards[0] ("/staff"): unknown key "require_session" - did you mean "requireSession"?',
    ]);
  });

  it('refuses redirects and rewrites the server could not compile', () => {
    const { rules, problems } = validateMiddlewareRules({
      redirects: [
        { from: '/a', to: '/b', status: 200 },
        { from: '/u/:id', to: '/users/:slug' },
        { from: '/c', to: 'https://example.com/c' },
        { from: '/ok', to: '/fine' },
      ],
      rewrites: [{ from: '/only-from' }, { from: 'x', to: '/y' }],
    });
    expect(rules.redirects).toEqual([{ from: '/ok', to: '/fine' }]);
    expect(problems).toEqual([
      'redirects[0] ("/a"): status must be 301, 302, 307 or 308 (got 200)',
      'redirects[1] ("/u/:id"): to references ":slug", which from does not capture',
      'redirects[2] ("/c"): to must be a path starting with "/" (got "https://example.com/c")',
      'rewrites[0] ("/only-from"): to must be a non-empty string',
      'rewrites[1] ("x"): from must start with "/"',
    ]);
  });

  it('refuses targets a browser reads as another site', () => {
    // `//evil.com` and `/\evil.com` start with "/", but as a Location they
    // are protocol-relative URLs: the visitor would land on evil.com.
    const { rules, problems } = validateMiddlewareRules({
      guards: [
        { path: '/a', requireSession: true, redirectTo: '//evil.com' },
        { path: '/b', requireSession: true, redirectTo: '/\\evil.com' },
        { path: '/c', requireSession: true, redirectTo: '/login?next=//x' },
      ],
      redirects: [{ from: '/old', to: '/\t/evil.com' }],
      rewrites: [{ from: '/r', to: '//evil.com' }],
    });
    expect(rules.guards).toEqual([{ path: '/c', requireSession: true, redirectTo: '/login?next=//x' }]);
    const offSite = '(a browser reads a leading // or /\\ as one) - redirect to another site from a route handler';
    expect(problems).toEqual([
      `redirects[0] ("/old"): to "/\t/evil.com" is another site ${offSite}`,
      `rewrites[0] ("/r"): to "//evil.com" is another site ${offSite}`,
      `guards[0] ("/a"): redirectTo "//evil.com" is another site ${offSite}`,
      `guards[1] ("/b"): redirectTo "/\\evil.com" is another site ${offSite}`,
    ]);
  });

  it('refuses header rules the server could not stamp', () => {
    const { problems } = validateMiddlewareRules({
      headers: [
        { path: '/x', headers: { 'x-count': 3 } },
        { path: '/y', headers: { 'bad name': 'v', 'x-line': 'a\nb' } },
        { path: '/z' },
      ],
    });
    expect(problems).toEqual([
      'headers[0] ("/x"): the value of x-count must be a string',
      'headers[1] ("/y"): invalid header name "bad name"',
      'headers[1] ("/y"): the value of x-line must be visible ASCII (no line breaks)',
      'headers[2] ("/z"): headers must be an object of header names to values',
    ]);
  });

  it('refuses sections that are not arrays and entries that are not objects', () => {
    expect(validateMiddlewareRules({ headers: { path: '/x' } }).problems).toEqual(['headers must be an array']);
    expect(validateMiddlewareRules({ redirects: ['not-a-rule', { from: '/a', to: '/b' }] }).problems).toEqual([
      'redirects[0] must be an object',
    ]);
  });
});

describe('middlewareRulesOrThrow', () => {
  it('names the source and lists every problem', () => {
    expect(() =>
      middlewareRulesOrThrow({ guards: [{ path: 'admin', redirectTo: '/' }] }, '/app/middleware.ts'),
    ).toThrow(
      '/app/middleware.ts is invalid - no rule loads until every problem is fixed:\n' +
        '  - guards[0] ("admin"): path must start with "/"\n' +
        '  - guards[0] ("admin"): names no requirement: set requireSession: true or requireCookie',
    );
  });
});

describe('loadMiddlewareRules', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function project(source: string): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'gio-middleware-'));
    await writeFile(join(root, 'middleware.ts'), source);
    return root;
  }

  it('loads valid rules and yields none without a file', async () => {
    const dir = await project(
      "export default { guards: [{ path: '/admin/*rest', requireSession: true, redirectTo: '/login' }] };",
    );
    expect(await loadMiddlewareRules(dir)).toEqual({
      guards: [{ path: '/admin/*rest', requireSession: true, redirectTo: '/login' }],
    });
    expect(await loadMiddlewareRules(join(dir, 'missing'))).toEqual({});
  });

  it('throws when the file throws while loading - its guards must not vanish', async () => {
    // It used to warn and return no rules: /admin then answered 200.
    const dir = await project(
      "export default { guards: [{ path: '/admin/*rest', requireSession: true, redirectTo: '/login' }] };\n" +
        "throw new Error('boom');\n",
    );
    await expect(loadMiddlewareRules(dir)).rejects.toThrow(
      `${join(dir, 'middleware.ts')} failed to load: boom`,
    );
  });

  it('throws on a file without a default export', async () => {
    const dir = await project("export const middleware = { guards: [] };\n");
    await expect(loadMiddlewareRules(dir)).rejects.toThrow(/has no default export/);
  });

  it('throws on a rule that cannot be enforced', async () => {
    const dir = await project(
      "export default { guards: [{ path: 'members/*rest', requireSession: true, redirectTo: '/login' }] };\n",
    );
    await expect(loadMiddlewareRules(dir)).rejects.toThrow(/guards\[0\] \("members\/\*rest"\): path must start with "\/"/);
  });
});
