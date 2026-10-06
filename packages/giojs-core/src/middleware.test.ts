/**
 * giojs-core/src/middleware.test.ts
 *
 * Unit tests for the middleware rules shape helper and the defensive
 * validation applied to a project's middleware.ts default export.
 */
import { describe, it, expect } from 'vitest';
import { defineMiddleware, sanitizeMiddlewareRules } from './middleware.ts';

describe('defineMiddleware', () => {
  it('returns the rules unchanged', () => {
    const rules = {
      redirects: [{ from: '/old', to: '/new', status: 301 as const }],
      guards: [{ path: '/admin', requireCookie: 'session', redirectTo: '/' }],
    };
    expect(defineMiddleware(rules)).toBe(rules);
  });
});

describe('sanitizeMiddlewareRules', () => {
  it('accepts a fully-formed rules object without warnings', () => {
    const { rules, warnings } = sanitizeMiddlewareRules({
      redirects: [{ from: '/old', to: '/new', status: 308 }],
      rewrites: [{ from: '/alias', to: '/cached' }],
      headers: [{ path: '/docs', headers: { 'x-frame-options': 'DENY' } }],
      guards: [{ path: '/admin', requireCookie: 'session', redirectTo: '/' }],
    });
    expect(warnings).toEqual([]);
    expect(rules.redirects).toEqual([{ from: '/old', to: '/new', status: 308 }]);
    expect(rules.rewrites).toEqual([{ from: '/alias', to: '/cached' }]);
    expect(rules.headers).toEqual([{ path: '/docs', headers: { 'x-frame-options': 'DENY' } }]);
    expect(rules.guards).toEqual([{ path: '/admin', requireCookie: 'session', redirectTo: '/' }]);
  });

  it('returns empty rules for undefined and null exports', () => {
    expect(sanitizeMiddlewareRules(undefined)).toEqual({ rules: {}, warnings: [] });
    expect(sanitizeMiddlewareRules(null)).toEqual({ rules: {}, warnings: [] });
  });

  it('warns and ignores a non-object export', () => {
    const { rules, warnings } = sanitizeMiddlewareRules('not rules');
    expect(rules).toEqual({});
    expect(warnings).toHaveLength(1);
  });

  it('drops redirect entries with a disallowed status', () => {
    const { rules, warnings } = sanitizeMiddlewareRules({
      redirects: [
        { from: '/a', to: '/b', status: 200 },
        { from: '/c', to: '/d' },
      ],
    });
    expect(rules.redirects).toEqual([{ from: '/c', to: '/d' }]);
    expect(warnings).toHaveLength(1);
  });

  it('drops entries missing required string fields', () => {
    const { rules, warnings } = sanitizeMiddlewareRules({
      rewrites: [{ from: '/only-from' }, { from: '/ok', to: '/target' }],
      guards: [{ requireCookie: 'session', redirectTo: '/' }],
    });
    expect(rules.rewrites).toEqual([{ from: '/ok', to: '/target' }]);
    // A guard without a path has nothing to protect.
    expect(rules.guards).toBeUndefined();
    expect(warnings).toHaveLength(2);
  });

  it('accepts session guards with and without a cookie name', () => {
    const { rules, warnings } = sanitizeMiddlewareRules({
      guards: [
        { path: '/admin/*rest', requireSession: true, redirectTo: '/login' },
        { path: '/staff', requireSession: true, requireCookie: 'staff_session', redirectTo: '/' },
        { path: '/beta', requireSession: false, requireCookie: 'beta', redirectTo: '/' },
      ],
    });
    expect(warnings).toEqual([]);
    expect(rules.guards).toEqual([
      { path: '/admin/*rest', requireSession: true, redirectTo: '/login' },
      { path: '/staff', requireSession: true, requireCookie: 'staff_session', redirectTo: '/' },
      { path: '/beta', requireCookie: 'beta', redirectTo: '/' },
    ]);
  });

  it('turns a guard with a malformed requirement into a deny-all guard, never dropping it', () => {
    // Rust compiles a guard that names no requirement to deny-all, so each of
    // these keeps its path closed instead of leaving it open.
    const { rules, warnings } = sanitizeMiddlewareRules({
      guards: [
        { path: '/a', redirectTo: '/login' },
        { path: '/b', requireSession: false, redirectTo: '/login' },
        { path: '/c', requireSession: 'true', redirectTo: '/login' },
        { path: '/d', requireSession: true, requireCookie: '', redirectTo: '/login' },
        { path: '/e', requireCookie: 42, redirectTo: '/login' },
        { path: '/f', requireCookie: '', redirectTo: '/login' },
      ],
    });
    expect(rules.guards).toEqual(
      ['/a', '/b', '/c', '/d', '/e', '/f'].map(path => ({ path, redirectTo: '/login' })),
    );
    expect(warnings).toHaveLength(6);
    for (const warning of warnings) expect(warning).toMatch(/denies every request/);
    expect(warnings[2]).toMatch(/requireSession must be true or false/);
  });

  it('treats unknown guard keys as a typo that fails closed', () => {
    const { rules, warnings } = sanitizeMiddlewareRules({
      guards: [
        { path: '/admin/*rest', requireSesion: true, redirectTo: '/login' },
        // The typo would otherwise downgrade a session check to cookie presence.
        { path: '/staff', requireCookie: 'staff', require_session: true, redirectTo: '/login' },
      ],
    });
    expect(rules.guards).toEqual([
      { path: '/admin/*rest', redirectTo: '/login' },
      { path: '/staff', redirectTo: '/login' },
    ]);
    expect(warnings[0]).toMatch(/unknown key requireSesion/);
    expect(warnings[1]).toMatch(/unknown key require_session/);
  });

  it('fails closed to "/" when redirectTo is missing or not a path', () => {
    const { rules, warnings } = sanitizeMiddlewareRules({
      guards: [
        { path: '/a', requireSession: true, redirect_to: '/login' },
        { path: '/b', requireSession: true, redirectTo: 'login' },
        { path: '/c', requireSession: true },
      ],
    });
    expect(rules.guards).toEqual([
      { path: '/a', redirectTo: '/' },
      { path: '/b', redirectTo: '/' },
      { path: '/c', redirectTo: '/' },
    ]);
    expect(warnings).toHaveLength(3);
  });

  it('ignores a section that is not an array', () => {
    const { rules, warnings } = sanitizeMiddlewareRules({ headers: { path: '/x' } });
    expect(rules.headers).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('drops header rules whose headers map has non-string values', () => {
    const { rules, warnings } = sanitizeMiddlewareRules({
      headers: [{ path: '/x', headers: { 'x-count': 3 } }],
    });
    expect(rules.headers).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('drops non-object entries inside a section', () => {
    const { rules, warnings } = sanitizeMiddlewareRules({
      redirects: ['not-a-rule', { from: '/a', to: '/b' }],
    });
    expect(rules.redirects).toEqual([{ from: '/a', to: '/b' }]);
    expect(warnings).toHaveLength(1);
  });
});
