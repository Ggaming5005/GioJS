/**
 * giojs-core/src/middleware.ts
 *
 * Typed shape + helper for a project's middleware.ts rules (redirects,
 * rewrites, response headers, auth guards). The rules are declarative: they
 * travel to the Rust server inside the READY frame and execute in the Rust
 * HTTP layer before routing, so no request can reach Node without passing
 * them. Patterns share the routing conventions: literal segments, :param
 * captures, *rest catch-all.
 */

export interface MiddlewareRedirect {
  from: string;
  to: string;
  /** 301, 302, 307, or 308. The server defaults a missing status to 302. */
  status?: 301 | 302 | 307 | 308;
}

export interface MiddlewareRewrite {
  from: string;
  to: string;
}

export interface MiddlewareHeaderRule {
  path: string;
  headers: Record<string, string>;
}

/**
 * Redirects (302) requests to `path` that lack the credential, before they
 * reach Node. `requireCookie` alone is a presence check. `requireSession`
 * verifies a createSessionStorage cookie's signature and expiry with
 * GIO_SESSION_SECRET - the cookie named by `requireCookie`, or `gio_session`.
 */
export type MiddlewareGuard =
  | { path: string; requireCookie: string; requireSession?: false; redirectTo: string }
  | { path: string; requireSession: true; requireCookie?: string; redirectTo: string };

export interface MiddlewareRules {
  redirects?: MiddlewareRedirect[];
  rewrites?: MiddlewareRewrite[];
  headers?: MiddlewareHeaderRule[];
  guards?: MiddlewareGuard[];
}

/** Identity helper that gives middleware.ts authors the typed shape. */
export function defineMiddleware(rules: MiddlewareRules): MiddlewareRules {
  return rules;
}

/**
 * Wire-only: a guard that names no requirement, which Rust compiles to
 * deny-all. sanitizeMiddlewareRules sends it in place of a malformed guard,
 * so a broken guard keeps its path closed instead of being dropped.
 */
export interface DenyAllGuard {
  path: string;
  redirectTo: string;
}

/** The rules as they travel in the READY frame. */
export interface WireMiddlewareRules extends Omit<MiddlewareRules, 'guards'> {
  guards?: Array<MiddlewareGuard | DenyAllGuard>;
}

export interface SanitizedMiddleware {
  rules: WireMiddlewareRules;
  warnings: string[];
}

const REDIRECT_STATUSES = [301, 302, 307, 308] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(entry => typeof entry === 'string');
}

function sanitizeList<T>(
  value: unknown,
  field: string,
  warnings: string[],
  parse: (entry: Record<string, unknown>) => T | null,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`middleware ${field} must be an array - section ignored`);
    return [];
  }
  const parsed: T[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      warnings.push(`middleware ${field} entry is not an object - entry dropped`);
      continue;
    }
    const result = parse(entry);
    if (result === null) {
      warnings.push(`middleware ${field} entry is malformed - entry dropped`);
      continue;
    }
    parsed.push(result);
  }
  return parsed;
}

const GUARD_KEYS: ReadonlySet<string> = new Set(['path', 'requireCookie', 'requireSession', 'redirectTo']);

type GuardRequirement = { requireSession: true; requireCookie?: string } | { requireCookie: string };

/** A guard entry's requirement, or why it is malformed. */
function guardRequirement(entry: Record<string, unknown>): GuardRequirement | string {
  const unknownKeys = Object.keys(entry).filter(key => !GUARD_KEYS.has(key));
  if (unknownKeys.length > 0) return `unknown key ${unknownKeys.join(', ')}`;
  const requireCookie = entry['requireCookie'];
  const requireSession = entry['requireSession'];
  if (requireSession !== undefined && typeof requireSession !== 'boolean') {
    return 'requireSession must be true or false';
  }
  if (requireCookie !== undefined && !isNonEmptyString(requireCookie)) {
    return 'requireCookie must be a non-empty string';
  }
  if (requireSession === true) {
    return requireCookie === undefined ? { requireSession: true } : { requireSession: true, requireCookie };
  }
  if (requireCookie === undefined) return 'no requirement: set requireSession: true or requireCookie';
  return { requireCookie };
}

/**
 * Defensively validate an untrusted middleware.ts default export. Malformed
 * sections and entries are dropped with a warning instead of throwing -
 * middleware problems must never kill the worker - except guards, which
 * fail closed: a malformed guard becomes a deny-all guard on its path. Rust
 * re-validates patterns and header values at compile time; this pass
 * guarantees only the shape.
 */
export function sanitizeMiddlewareRules(value: unknown): SanitizedMiddleware {
  const warnings: string[] = [];
  const rules: WireMiddlewareRules = {};
  if (!isRecord(value)) {
    if (value !== undefined && value !== null) {
      warnings.push('middleware default export must be an object - all rules ignored');
    }
    return { rules, warnings };
  }

  const redirects = sanitizeList<MiddlewareRedirect>(
    value['redirects'],
    'redirects',
    warnings,
    entry => {
      if (!isNonEmptyString(entry['from']) || !isNonEmptyString(entry['to'])) return null;
      const status = entry['status'];
      if (status === undefined) return { from: entry['from'], to: entry['to'] };
      if (!REDIRECT_STATUSES.includes(status as (typeof REDIRECT_STATUSES)[number])) return null;
      return {
        from: entry['from'],
        to: entry['to'],
        status: status as (typeof REDIRECT_STATUSES)[number],
      };
    },
  );
  if (redirects.length > 0) rules.redirects = redirects;

  const rewrites = sanitizeList<MiddlewareRewrite>(value['rewrites'], 'rewrites', warnings, entry => {
    if (!isNonEmptyString(entry['from']) || !isNonEmptyString(entry['to'])) return null;
    return { from: entry['from'], to: entry['to'] };
  });
  if (rewrites.length > 0) rules.rewrites = rewrites;

  const headers = sanitizeList<MiddlewareHeaderRule>(value['headers'], 'headers', warnings, entry => {
    if (!isNonEmptyString(entry['path']) || !isStringRecord(entry['headers'])) return null;
    return { path: entry['path'], headers: entry['headers'] };
  });
  if (headers.length > 0) rules.headers = headers;

  // A guard with a path is never dropped: anything else wrong with it turns
  // it into a deny-all guard, so a typo cannot leave the path open (gio.toml
  // refuses to start on the same mistakes).
  const guards = sanitizeList<MiddlewareGuard | DenyAllGuard>(value['guards'], 'guards', warnings, entry => {
    const path = entry['path'];
    if (!isNonEmptyString(path)) return null;
    const redirectTo = entry['redirectTo'];
    const target = isNonEmptyString(redirectTo) && redirectTo.startsWith('/') ? redirectTo : null;
    const requirement = guardRequirement(entry);
    if (target !== null && typeof requirement !== 'string') {
      return { path, ...requirement, redirectTo: target };
    }
    const problem = typeof requirement === 'string' ? requirement : 'redirectTo must be a path starting with "/"';
    warnings.push(
      `middleware guard for ${path} is malformed (${problem}) - ` +
        `it denies every request, redirecting to ${target ?? '/'}, until fixed`,
    );
    return { path, redirectTo: target ?? '/' };
  });
  if (guards.length > 0) rules.guards = guards;

  return { rules, warnings };
}
