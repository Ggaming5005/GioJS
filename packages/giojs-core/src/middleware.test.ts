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
      guards: [{ path: '/admin', requireCookie: '', redirectTo: '/' }],
    });
    expect(rules.rewrites).toEqual([{ from: '/ok', to: '/target' }]);
    expect(rules.guards).toBeUndefined();
    expect(warnings).toHaveLength(2);
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
