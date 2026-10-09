/**
 * giojs-core/src/middleware.ts
 *
 * Typed shape + helper for a project's middleware.ts rules (redirects,
 * rewrites, response headers, auth guards). The rules are declarative: they
 * travel to the Rust server inside the READY frame and execute in the Rust
 * HTTP layer before routing, so no request can reach Node without passing
 * them. Patterns share the routing conventions: literal segments, :param
 * captures, *rest catch-all.
 *
 * Strict like gio.toml: a rule that cannot be enforced as written stops the
 * worker at boot with every problem listed, instead of being dropped and
 * leaving its path open (validateMiddlewareRules).
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

/** The rules as they travel in the READY frame: exactly the validated rules. */
export type WireMiddlewareRules = MiddlewareRules;

export interface ValidatedMiddleware {
  rules: WireMiddlewareRules;
  /** Every problem found, one line each; non-empty means the rules must not load. */
  problems: string[];
}

const REDIRECT_STATUSES = [301, 302, 307, 308] as const;

const SECTION_KEYS = ['redirects', 'rewrites', 'headers', 'guards'] as const;
const REDIRECT_KEYS = ['from', 'to', 'status'] as const;
const REWRITE_KEYS = ['from', 'to'] as const;
const HEADER_RULE_KEYS = ['path', 'headers'] as const;
const GUARD_KEYS = ['path', 'requireCookie', 'requireSession', 'redirectTo'] as const;

// What the Rust server's http crate accepts (HeaderName::from_bytes,
// HeaderValue::from_str): an RFC 9110 token, and visible ASCII or tabs.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** `name` lowercased without `-` and `_`, for typo matching. */
function normalizeKey(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, '');
}

/** Levenshtein distance; keys are short. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** " - did you mean "x"?" for a likely typo of a known key, else "". */
function didYouMean(name: string, known: readonly string[]): string {
  const wanted = normalizeKey(name);
  const best = known
    .map(candidate => ({ candidate, distance: editDistance(wanted, normalizeKey(candidate)) }))
    .sort((a, b) => a.distance - b.distance)[0];
  const limit = Math.max(1, Math.floor(Math.max(name.length, best?.candidate.length ?? 0) / 3));
  return best !== undefined && best.distance <= limit ? ` - did you mean "${best.candidate}"?` : '';
}

function unknownKeys(entry: Record<string, unknown>, known: readonly string[]): string[] {
  return Object.keys(entry)
    .filter(key => !known.includes(key))
    .map(key => `unknown key "${key}"${didYouMean(key, known)}`);
}

/**
 * Why `pattern` is not a rule pattern, or null: it must start with `/`, and
 * a `*rest` catch-all must be the last segment. Mirrors the Rust server's
 * Pattern::compile (crates/giojs-server/src/rules.rs).
 */
function patternProblem(pattern: string): string | null {
  if (!pattern.startsWith('/')) return `must start with "/"`;
  const segments = pattern.split('/').filter(segment => segment.length > 0);
  const catchAll = segments.findIndex(segment => segment.startsWith('*'));
  if (catchAll !== -1 && catchAll !== segments.length - 1) {
    return 'a catch-all (*rest) must be the last segment';
  }
  return null;
}

/** The capture names `pattern` defines (`:id`, `*rest`). */
function captureNames(pattern: string): Set<string> {
  return new Set(
    pattern
      .split('/')
      .filter(segment => segment.startsWith(':') || segment.startsWith('*'))
      .map(segment => segment.slice(1)),
  );
}

/**
 * Why `target` is not a path on this site, or null (Rust's check_site_path).
 * `//evil.com` and `/\\evil.com` start with `/`, but a browser reads them
 * (tabs and line breaks dropped first) as protocol-relative URLs: as a
 * Location they would send the visitor off-site.
 */
function sitePathProblem(key: string, target: string): string | null {
  if (!target.startsWith('/')) return `${key} must be a path starting with "/" (got "${target}")`;
  if (/^\/[\t\n\r]*[/\\]/.test(target)) {
    return `${key} "${target}" is another site (a browser reads a leading // or /\\ as one) - redirect to another site from a route handler`;
  }
  return null;
}

/** Why a redirect or rewrite target is unusable, or null (Rust's Template::compile). */
function targetProblem(to: string, from: string): string | null {
  const notOnSite = sitePathProblem('to', to);
  if (notOnSite !== null) return notOnSite;
  const captures = captureNames(from);
  for (const segment of to.split('/')) {
    if ((segment.startsWith(':') || segment.startsWith('*')) && !captures.has(segment.slice(1))) {
      return `to references "${segment}", which from does not capture`;
    }
  }
  return null;
}

/**
 * Validate an untrusted middleware.ts default export, strictly: every
 * problem is collected - an unknown key (with the closest valid one), a
 * missing or malformed field, a pattern the server cannot match, a guard
 * that names no requirement - and the caller refuses to load rules with
 * any, the way gio.toml refuses to start. A rule dropped with a warning
 * would leave the path it was meant to protect open. `undefined` and
 * `null` (no default export to read) are no rules. The Rust server
 * re-validates the rules it receives and refuses the worker on a problem.
 */
export function validateMiddlewareRules(value: unknown): ValidatedMiddleware {
  const problems: string[] = [];
  const rules: WireMiddlewareRules = {};
  if (value === undefined || value === null) return { rules, problems };
  if (!isRecord(value)) {
    problems.push('the default export must be an object - export default defineMiddleware({ ... })');
    return { rules, problems };
  }
  problems.push(...unknownKeys(value, SECTION_KEYS));

  /** Each entry of section `name`, or a problem with the section's shape. */
  const entries = (name: (typeof SECTION_KEYS)[number]): Array<[string, Record<string, unknown>]> => {
    const section = value[name];
    if (section === undefined) return [];
    if (!Array.isArray(section)) {
      problems.push(`${name} must be an array`);
      return [];
    }
    const out: Array<[string, Record<string, unknown>]> = [];
    section.forEach((entry: unknown, index) => {
      if (isRecord(entry)) out.push([`${name}[${index}]`, entry]);
      else problems.push(`${name}[${index}] must be an object`);
    });
    return out;
  };
  /** Report `problem` for the entry at `at`, naming its pattern when it has one. */
  const report = (at: string, pattern: unknown, problem: string): void => {
    problems.push(`${at}${typeof pattern === 'string' ? ` ("${pattern}")` : ''}: ${problem}`);
  };
  /** A required pattern field: its value, or null after reporting why not. */
  const patternField = (at: string, entry: Record<string, unknown>, key: string): string | null => {
    const pattern = entry[key];
    if (!isNonEmptyString(pattern)) {
      report(at, entry[key], `${key} must be a non-empty string`);
      return null;
    }
    const problem = patternProblem(pattern);
    if (problem !== null) {
      report(at, pattern, `${key} ${problem}`);
      return null;
    }
    return pattern;
  };

  const redirects: MiddlewareRedirect[] = [];
  for (const [at, entry] of entries('redirects')) {
    const before = problems.length;
    for (const problem of unknownKeys(entry, REDIRECT_KEYS)) report(at, entry['from'], problem);
    const from = patternField(at, entry, 'from');
    const to = entry['to'];
    const status = entry['status'];
    if (!isNonEmptyString(to)) report(at, entry['from'], 'to must be a non-empty string');
    else if (from !== null) {
      const problem = targetProblem(to, from);
      if (problem !== null) report(at, from, problem);
    }
    if (status !== undefined && !REDIRECT_STATUSES.includes(status as (typeof REDIRECT_STATUSES)[number])) {
      report(at, entry['from'], `status must be 301, 302, 307 or 308 (got ${JSON.stringify(status)})`);
    }
    if (problems.length === before && from !== null && isNonEmptyString(to)) {
      redirects.push(
        status === undefined
          ? { from, to }
          : { from, to, status: status as (typeof REDIRECT_STATUSES)[number] },
      );
    }
  }
  if (redirects.length > 0) rules.redirects = redirects;

  const rewrites: MiddlewareRewrite[] = [];
  for (const [at, entry] of entries('rewrites')) {
    const before = problems.length;
    for (const problem of unknownKeys(entry, REWRITE_KEYS)) report(at, entry['from'], problem);
    const from = patternField(at, entry, 'from');
    const to = entry['to'];
    if (!isNonEmptyString(to)) report(at, entry['from'], 'to must be a non-empty string');
    else if (from !== null) {
      const problem = targetProblem(to, from);
      if (problem !== null) report(at, from, problem);
    }
    if (problems.length === before && from !== null && isNonEmptyString(to)) rewrites.push({ from, to });
  }
  if (rewrites.length > 0) rules.rewrites = rewrites;

  const headers: MiddlewareHeaderRule[] = [];
  for (const [at, entry] of entries('headers')) {
    const before = problems.length;
    for (const problem of unknownKeys(entry, HEADER_RULE_KEYS)) report(at, entry['path'], problem);
    const path = patternField(at, entry, 'path');
    const map = entry['headers'];
    if (!isRecord(map)) {
      report(at, entry['path'], 'headers must be an object of header names to values');
    } else {
      for (const [name, headerValue] of Object.entries(map)) {
        if (!HEADER_NAME.test(name)) report(at, entry['path'], `invalid header name "${name}"`);
        else if (typeof headerValue !== 'string') {
          report(at, entry['path'], `the value of ${name} must be a string`);
        } else if (!HEADER_VALUE.test(headerValue)) {
          report(at, entry['path'], `the value of ${name} must be visible ASCII (no line breaks)`);
        }
      }
    }
    if (problems.length === before && path !== null && isRecord(map)) {
      headers.push({ path, headers: map as Record<string, string> });
    }
  }
  if (headers.length > 0) rules.headers = headers;

  const guards: MiddlewareGuard[] = [];
  for (const [at, entry] of entries('guards')) {
    const before = problems.length;
    for (const problem of unknownKeys(entry, GUARD_KEYS)) report(at, entry['path'], problem);
    const path = patternField(at, entry, 'path');
    const requirement = guardRequirement(entry);
    if (typeof requirement === 'string') report(at, entry['path'], requirement);
    const redirectTo = entry['redirectTo'];
    if (!isNonEmptyString(redirectTo)) {
      report(at, entry['path'], 'redirectTo must be a path starting with "/"');
    } else {
      const problem = sitePathProblem('redirectTo', redirectTo);
      if (problem !== null) report(at, entry['path'], problem);
    }
    if (problems.length === before && path !== null && typeof requirement !== 'string') {
      guards.push({ path, ...requirement, redirectTo: redirectTo as string });
    }
  }
  if (guards.length > 0) rules.guards = guards;

  return { rules, problems };
}

type GuardRequirement = { requireSession: true; requireCookie?: string } | { requireCookie: string };

/** A guard entry's requirement, or why it names none. */
function guardRequirement(entry: Record<string, unknown>): GuardRequirement | string {
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
  if (requireCookie === undefined) return 'names no requirement: set requireSession: true or requireCookie';
  return { requireCookie };
}

/**
 * The validated rules of `value`, the default export of `source` (the
 * middleware file, or the standalone registry) - or an Error listing every
 * problem, which stops the worker at boot.
 */
export function middlewareRulesOrThrow(value: unknown, source: string): WireMiddlewareRules {
  const { rules, problems } = validateMiddlewareRules(value);
  if (problems.length > 0) {
    throw new Error(
      `${source} is invalid - no rule loads until every problem is fixed:\n` +
        problems.map(problem => `  - ${problem}`).join('\n'),
    );
  }
  return rules;
}
