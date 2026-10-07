/**
 * packages/giojs-cli/src/next-config-converter.ts
 *
 * Converts next.config.{js,mjs,cjs,ts} to gio.toml sections. The config is
 * parsed with the TypeScript compiler API and evaluated statically (object
 * and array literals, strings, numbers, booleans, `const` references and the
 * returned value of `async redirects() { return [...] }`) - user code is
 * never executed. Whatever cannot be converted exactly becomes a
 * `# TODO(gio-migrate):` comment and a report entry; a rule that would
 * match differently in GioJS is skipped rather than approximated more
 * broadly (a `has` condition dropped from a redirect would apply it to
 * every request). The one deliberate exception: a catch-all Next requires
 * to be non-empty (`/blog/:path+`, `/blog/(.*)`) becomes `/blog/*path`,
 * which adds only `/blog` itself, and says so in a TODO comment above it.
 *
 * An existing gio.toml is never overwritten: new tables are merged in when
 * that is provably safe (no table or key defined twice), otherwise the
 * result goes to gio.migrated.toml for the user to merge by hand.
 */
import ts from 'typescript';
import { parseErrors, parseSource, propertyName, TODO_MARKER } from './migrate-edits.js';

export const CONFIG_FILES = ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts'];
export const MIGRATED_TOML = 'gio.migrated.toml';
const MERGE_MARKER = '# ── Migrated from Next.js by create-giojs migrate';

/** A value the static evaluator could not resolve; `text` is its source. */
class Unknown {
  constructor(readonly text: string) {}
}

type Value = string | number | boolean | null | undefined | Value[] | { [key: string]: Value } | Unknown;

export interface ConfigNote {
  message: string;
}

export interface TomlTable {
  /** `images`, `i18n`, ... for `[name]`; keys in order. */
  name: string;
  keys: Array<[string, string]>;
}

export interface TomlArrayEntry {
  /** `redirects`, `images.remote_patterns`, ... for `[[name]]`. */
  name: string;
  keys: Array<[string, string]>;
  /** Comment lines (without `# `) written above the entry. */
  comments: string[];
}

export interface ConvertedConfig {
  tables: TomlTable[];
  entries: TomlArrayEntry[];
  /** TODO comments for the toml file (not tied to an entry). */
  todos: string[];
  /** What was converted, for the report. */
  converted: string[];
  /** Informational notes (no action needed or done elsewhere). */
  notes: string[];
  /** `output: 'export'` - the package.json build script becomes gio export. */
  staticExport: boolean;
  /** Keys of next.config `env`, for the .env hint. */
  envKeys: string[];
}

export interface TomlResult {
  /** gio.toml or gio.migrated.toml. */
  target: string;
  content: string;
  /** Previous gio.toml content when merged in place. */
  before?: string;
  mode: 'created' | 'merged' | 'separate';
  /** Why a separate file was written instead of merging. */
  reason?: string;
}

// ── static evaluation ───────────────────────────────────────────────────────

function evaluate(node: ts.Node | undefined, sf: ts.SourceFile, depth = 0): Value {
  if (node === undefined) return undefined;
  if (depth > 20) return new Unknown(node.getText(sf));
  const next = (n: ts.Node | undefined): Value => evaluate(n, sf, depth + 1);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) {
    return next(node.expression);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node)) {
    if (node.text === 'undefined') return undefined;
    const init = findConst(node.text, sf);
    return init !== undefined ? next(init) : new Unknown(node.text);
  }
  if (ts.isArrayLiteralExpression(node)) {
    const out: Value[] = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        const spread = next(element.expression);
        if (Array.isArray(spread)) out.push(...spread);
        else out.push(new Unknown(element.getText(sf)));
      } else {
        out.push(next(element));
      }
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: { [key: string]: Value } = {};
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const spread = next(prop.expression);
        if (isRecord(spread)) Object.assign(out, spread);
        else out['...'] = new Unknown(prop.getText(sf));
        continue;
      }
      const key = prop.name !== undefined ? propertyName(prop.name) : undefined;
      if (key === undefined) continue;
      if (ts.isPropertyAssignment(prop)) out[key] = next(prop.initializer);
      else if (ts.isShorthandPropertyAssignment(prop)) out[key] = next(prop.name);
      else if (ts.isMethodDeclaration(prop)) out[key] = returnedValue(prop, sf, depth);
    }
    return out;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return returnedValue(node, sf, depth);
  if (ts.isAwaitExpression(node)) return next(node.expression);
  return new Unknown(node.getText(sf));
}

/** The value a function returns, when it is one expression or a single `return`. */
function returnedValue(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile, depth: number): Value {
  const body = fn.body;
  if (body === undefined) return new Unknown(fn.getText(sf));
  if (!ts.isBlock(body)) return evaluate(body, sf, depth + 1);
  const returns = body.statements.filter(ts.isReturnStatement);
  if (returns.length !== 1) return new Unknown(fn.getText(sf));
  return evaluate((returns[0] as ts.ReturnStatement).expression, sf, depth + 1);
}

function findConst(name: string, sf: ts.SourceFile): ts.Expression | undefined {
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl.initializer;
    }
  }
  return undefined;
}

function isRecord(value: Value): value is { [key: string]: Value } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Unknown);
}

function describe(value: Value): string {
  if (value instanceof Unknown) return value.text.replace(/\s+/g, ' ').slice(0, 80);
  return JSON.stringify(value) ?? String(value);
}

/**
 * The exported config object: `module.exports = X` / `export default X`,
 * through `const` references, plugin wrappers (`withMDX(config)`) and
 * `(phase) => config` functions.
 */
function findConfigObject(sf: ts.SourceFile, notes: string[]): Value {
  let exported: ts.Expression | undefined;
  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement)) exported = statement.expression;
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      statement.expression.left.getText(sf) === 'module.exports'
    ) {
      exported = statement.expression.right;
    }
  }
  let node: ts.Expression | undefined = exported;
  for (let i = 0; i < 10 && node !== undefined; i++) {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
    if (ts.isIdentifier(node)) {
      node = findConst(node.text, sf);
      continue;
    }
    if (ts.isCallExpression(node)) {
      notes.push(`the config is wrapped in ${node.expression.getText(sf)}(...): that plugin's own settings were not converted`);
      node = node.arguments[node.arguments.length - 1];
      continue;
    }
    break;
  }
  if (node === undefined) return undefined;
  const value = evaluate(node, sf);
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && isRecord(value)) {
    notes.push('the config is a function of the build phase: converted the object it returns');
  }
  return value;
}

// ── path patterns ───────────────────────────────────────────────────────────

/**
 * Convert a Next.js (path-to-regexp) path to the gio.toml rule syntax:
 * literal segments, `:param`, and a trailing `*rest` catch-all that also
 * matches zero segments. Returns an error string for anything GioJS would
 * match differently.
 */
export function convertPath(path: string, kind: 'source' | 'destination'): { path: string; note?: string } | { error: string } {
  if (kind === 'destination' && /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    return { error: 'external destination - GioJS rules only target paths on this site' };
  }
  if (!path.startsWith('/')) return { error: 'path does not start with "/"' };
  if (path.includes('?') && kind === 'destination') return { error: 'destination has a query string - GioJS keeps the request query verbatim and cannot add to it' };
  if (path.includes('#')) return { error: 'path has a fragment' };
  const segments = path.split('/').filter(s => s !== '');
  const out: string[] = [];
  let note: string | undefined;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string;
    const last = i === segments.length - 1;
    // `/(.*)` and `/:name(.*)` as the last segment: "the rest of the path".
    // Next matches `/(.*)` on every path including `/`, exactly like
    // `/*rest`; below a prefix (`/blog/(.*)`) it needs the slash, so
    // `/blog` itself is the one extra path the catch-all matches.
    const rest = last ? /^(?::([A-Za-z_][A-Za-z0-9_]*))?\(\.\*\)$/.exec(segment) : null;
    if (rest !== null && (rest[1] !== undefined || kind === 'source')) {
      const taken = new Set(segments.map(s => /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(s)?.[1]));
      let name = rest[1] ?? 'rest';
      for (let n = 2; rest[1] === undefined && taken.has(name); n++) name = `rest${n}`;
      out.push(`*${name}`);
      if (kind === 'source' && out.length > 1) {
        note = `"${segment}" became "*${name}", which also matches /${out.slice(0, -1).join('/')} itself (Next.js required something after the slash)`;
      }
      continue;
    }
    const param = /^:([A-Za-z_][A-Za-z0-9_]*)([*+?]?)$/.exec(segment);
    if (param !== null) {
      const [, name, modifier] = param as unknown as [string, string, string];
      if (modifier === '') {
        out.push(`:${name}`);
        continue;
      }
      if (modifier === '?') return { error: `optional segment "${segment}" has no gio.toml equivalent - write two rules, with and without it` };
      if (!last) return { error: `catch-all "${segment}" must be the last segment in gio.toml rules` };
      out.push(`*${name}`);
      if (modifier === '+' && kind === 'source') note = `"${segment}" (one or more segments) became "*${name}", which also matches zero segments`;
      continue;
    }
    if (/[:()*+?{}\\[\]]/.test(segment)) {
      return { error: `segment "${segment}" uses a regex, wildcard or partial-segment parameter - gio.toml rules match whole segments only` };
    }
    out.push(segment);
  }
  return { path: '/' + out.join('/'), ...(note !== undefined ? { note } : {}) };
}

/** Capture names a converted pattern defines. */
function captures(path: string): Set<string> {
  return new Set(path.split('/').filter(s => s.startsWith(':') || s.startsWith('*')).map(s => s.slice(1)));
}

// ── conversion ──────────────────────────────────────────────────────────────

const tomlString = (value: string): string => JSON.stringify(value);

const NO_EQUIVALENT_NEEDED: Record<string, string> = {
  reactStrictMode: 'StrictMode is up to your components in GioJS',
  swcMinify: 'GioJS minifies production client bundles with esbuild',
  poweredByHeader: 'GioJS never sends X-Powered-By',
  compress: 'the Rust server compresses responses itself',
  generateEtags: 'the Rust server sets ETags itself',
};

const NOT_CONVERTED: Record<string, string> = {
  webpack: 'GioJS bundles with esbuild - a custom webpack config does not apply; port what it does (aliases → tsconfig paths, loaders → esbuild-compatible imports)',
  experimental: 'experimental.* flags have no GioJS equivalent',
  transpilePackages: 'esbuild transpiles dependencies as needed - nothing to configure',
  serverExternalPackages: 'the Node worker loads node_modules packages directly - nothing to configure',
  pageExtensions: 'GioJS pages are page.tsx/page.jsx/page.js, route handlers route.ts/route.js',
  assetPrefix: 'serve from a CDN by putting it in front of the GioJS server',
  distDir: 'GioJS has no build directory (.gio/ holds generated files)',
  compiler: 'compiler.* (SWC transforms) has no GioJS equivalent; esbuild compiles TypeScript/JSX',
  eslint: 'run ESLint yourself (npx eslint .)',
  typescript: 'GioJS does not type-check: run tsc --noEmit',
  generateBuildId: 'GioJS derives the deployment ID from the build content (GIO_DEPLOYMENT_ID pins one)',
  sassOptions: 'Sass is not compiled by GioJS - compile to CSS first',
  modularizeImports: 'no GioJS equivalent',
  productionBrowserSourceMaps: 'no GioJS equivalent',
  onDemandEntries: 'no GioJS equivalent',
  httpAgentOptions: 'no GioJS equivalent',
  staticPageGenerationTimeout: 'no GioJS equivalent',
  cacheHandler: 'GioJS caches pages in Rust (memory + disk); no custom handler',
  logging: 'set gio.toml [logging] format instead',
};

export function convertConfigSource(source: string, fileName: string): ConvertedConfig {
  const result: ConvertedConfig = { tables: [], entries: [], todos: [], converted: [], notes: [], staticExport: false, envKeys: [] };
  const sf = parseSource(fileName, source);
  if (parseErrors(sf).length > 0) {
    result.todos.push(`${fileName} could not be parsed - convert it by hand`);
    return result;
  }
  const config = findConfigObject(sf, result.notes);
  if (!isRecord(config)) {
    result.todos.push(`could not find a static config object in ${fileName}${config instanceof Unknown ? ` (${describe(config)})` : ''} - convert it by hand`);
    return result;
  }

  for (const [key, value] of Object.entries(config)) {
    switch (key) {
      case 'redirects':
        convertRedirects(value, result);
        break;
      case 'rewrites':
        convertRewrites(value, result);
        break;
      case 'headers':
        convertHeaders(value, result);
        break;
      case 'images':
        convertImages(value, result);
        break;
      case 'i18n':
        convertI18n(value, result);
        break;
      case 'basePath':
        result.todos.push(`basePath ${describe(value)}: GioJS serves the app from the site root - mount it under the sub-path in your reverse proxy, or move app/ into a folder of that name`);
        break;
      case 'trailingSlash':
        if (value === true) result.todos.push('trailingSlash: true - GioJS does not add trailing slashes; links should use the canonical paths');
        break;
      case 'output':
        if (value === 'export') {
          result.staticExport = true;
          result.converted.push("output: 'export' → `gio export` (static HTML in out/)");
        } else if (value === 'standalone') {
          result.converted.push("output: 'standalone' → `gio build standalone` (self-contained deploy directory)");
        } else {
          result.todos.push(`output: ${describe(value)} has no GioJS equivalent`);
        }
        break;
      case 'env':
        if (isRecord(value)) result.envKeys.push(...Object.keys(value));
        result.todos.push('env: move these values to .env - GioJS loads .env files, and only GIO_PUBLIC_* variables reach browser code');
        break;
      case '...':
        result.todos.push(`config spreads another object (${describe(value)}): convert its settings by hand`);
        break;
      default:
        if (key in NO_EQUIVALENT_NEEDED) result.notes.push(`${key}: ${NO_EQUIVALENT_NEEDED[key] as string}`);
        else if (key in NOT_CONVERTED) result.todos.push(`${key}: ${NOT_CONVERTED[key] as string}`);
        else result.todos.push(`${key}: not converted - no gio.toml equivalent known`);
    }
  }
  return result;
}

function ruleConditions(rule: { [key: string]: Value }, label: string): string | undefined {
  if (rule['has'] !== undefined || rule['missing'] !== undefined) {
    return `${label} has has/missing conditions, which gio.toml rules can't express - skipped so it doesn't apply to every request; use a [[guards]] entry, middleware.ts or getServerSideProps`;
  }
  if (rule['basePath'] === false || rule['locale'] === false) {
    return `${label} sets basePath/locale: false - review it by hand`;
  }
  return undefined;
}

function convertRedirects(value: Value, result: ConvertedConfig): void {
  if (!Array.isArray(value)) {
    result.todos.push(`redirects could not be read statically (${describe(value)}) - add [[redirects]] entries by hand`);
    return;
  }
  for (const rule of value) {
    if (!isRecord(rule) || typeof rule['source'] !== 'string' || typeof rule['destination'] !== 'string') {
      result.todos.push(`redirect ${describe(rule)} could not be read statically - add it by hand`);
      continue;
    }
    const label = `redirect ${rule['source']} → ${rule['destination']}`;
    const condition = ruleConditions(rule, label);
    if (condition !== undefined) {
      result.todos.push(condition);
      continue;
    }
    const from = convertPath(rule['source'], 'source');
    const to = convertPath(rule['destination'], 'destination');
    if ('error' in from || 'error' in to) {
      result.todos.push(`${label} skipped: ${'error' in from ? from.error : (to as { error: string }).error}`);
      continue;
    }
    const missing = [...captures(to.path)].filter(c => !captures(from.path).has(c));
    if (missing.length > 0) {
      result.todos.push(`${label} skipped: the destination uses ${missing.map(m => `:${m}`).join(', ')}, which the source doesn't capture`);
      continue;
    }
    // Next: permanent → 308, temporary → 307 (method-preserving); statusCode overrides.
    let status = rule['permanent'] === true ? 308 : 307;
    if (typeof rule['statusCode'] === 'number') status = rule['statusCode'];
    if (![301, 302, 307, 308].includes(status)) {
      result.todos.push(`${label} skipped: status ${status} - gio.toml redirects use 301, 302, 307 or 308`);
      continue;
    }
    result.entries.push({
      name: 'redirects',
      keys: [['from', tomlString(from.path)], ['to', tomlString(to.path)], ['status', String(status)]],
      comments: from.note !== undefined ? [`${TODO_MARKER} ${from.note}`] : [],
    });
    result.converted.push(`${label} → [[redirects]] ${from.path} → ${to.path} (${status})`);
  }
}

function convertRewrites(value: Value, result: ConvertedConfig): void {
  let rules: Value[];
  // Next checks pages and public files before every rewrite but beforeFiles.
  let beforeFiles = new Set<Value>();
  if (Array.isArray(value)) {
    rules = value;
  } else if (isRecord(value)) {
    beforeFiles = new Set(Array.isArray(value['beforeFiles']) ? value['beforeFiles'] : []);
    rules = [
      ...(Array.isArray(value['beforeFiles']) ? value['beforeFiles'] : []),
      ...(Array.isArray(value['afterFiles']) ? value['afterFiles'] : []),
    ];
    if (Array.isArray(value['fallback']) && value['fallback'].length > 0) {
      result.todos.push(`${value['fallback'].length} fallback rewrite(s) skipped: GioJS rewrites run before routing, so a fallback rewrite would shadow your pages - add them by hand if they are safe`);
    }
    if (Array.isArray(value['afterFiles']) && value['afterFiles'].length > 0) {
      result.notes.push('afterFiles rewrites became plain [[rewrites]]: GioJS checks rewrites before routing, so a rewrite whose source matches an existing page now wins over it');
    }
  } else {
    result.todos.push(`rewrites could not be read statically (${describe(value)}) - add [[rewrites]] entries by hand`);
    return;
  }
  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule['source'] !== 'string' || typeof rule['destination'] !== 'string') {
      result.todos.push(`rewrite ${describe(rule)} could not be read statically - add it by hand`);
      continue;
    }
    const label = `rewrite ${rule['source']} → ${rule['destination']}`;
    const condition = ruleConditions(rule, label);
    if (condition !== undefined) {
      result.todos.push(condition);
      continue;
    }
    const from = convertPath(rule['source'], 'source');
    const to = convertPath(rule['destination'], 'destination');
    if ('error' in to && /^[a-z][a-z0-9+.-]*:\/\//i.test(rule['destination'])) {
      result.todos.push(`${label} skipped: GioJS rewrites are internal - proxy external URLs from your reverse proxy or a route.ts handler that fetch()es it`);
      continue;
    }
    if ('error' in from || 'error' in to) {
      result.todos.push(`${label} skipped: ${'error' in from ? from.error : (to as { error: string }).error}`);
      continue;
    }
    const missing = [...captures(to.path)].filter(c => !captures(from.path).has(c));
    if (missing.length > 0) {
      result.todos.push(`${label} skipped: the destination uses ${missing.map(m => `:${m}`).join(', ')}, which the source doesn't capture`);
      continue;
    }
    if (/^\/\*[^/]*$/.test(from.path) && !beforeFiles.has(rule)) {
      result.todos.push(`${label} skipped: Next.js checked pages and public files before it, but GioJS rewrites run before routing, so ${from.path} would rewrite every request - move the fallback into a catch-all page (app/[...path]/page.tsx)`);
      continue;
    }
    result.entries.push({
      name: 'rewrites',
      keys: [['from', tomlString(from.path)], ['to', tomlString(to.path)]],
      comments: from.note !== undefined ? [`${TODO_MARKER} ${from.note}`] : [],
    });
    result.converted.push(`${label} → [[rewrites]] ${from.path} → ${to.path}`);
  }
}

function convertHeaders(value: Value, result: ConvertedConfig): void {
  if (!Array.isArray(value)) {
    result.todos.push(`headers could not be read statically (${describe(value)}) - add [[headers]] entries by hand`);
    return;
  }
  for (const rule of value) {
    if (!isRecord(rule) || typeof rule['source'] !== 'string' || !Array.isArray(rule['headers'])) {
      result.todos.push(`header rule ${describe(rule)} could not be read statically - add it by hand`);
      continue;
    }
    const label = `headers for ${rule['source']}`;
    const condition = ruleConditions(rule, label);
    if (condition !== undefined) {
      result.todos.push(condition);
      continue;
    }
    const path = convertPath(rule['source'], 'source');
    if ('error' in path) {
      result.todos.push(`${label} skipped: ${path.error}`);
      continue;
    }
    const pairs: string[] = [];
    let unreadable = false;
    for (const header of rule['headers']) {
      if (!isRecord(header) || typeof header['key'] !== 'string' || typeof header['value'] !== 'string') {
        unreadable = true;
        continue;
      }
      pairs.push(`${tomlString(header['key'])} = ${tomlString(header['value'])}`);
    }
    if (unreadable) result.todos.push(`${label}: some headers could not be read statically - add them by hand`);
    if (pairs.length === 0) continue;
    result.entries.push({
      name: 'headers',
      keys: [['path', tomlString(path.path)], ['headers', `{ ${pairs.join(', ')} }`]],
      comments: path.note !== undefined ? [`${TODO_MARKER} ${path.note}`] : [],
    });
    result.converted.push(`${label} → [[headers]] ${path.path} (${pairs.length} header${pairs.length === 1 ? '' : 's'})`);
  }
}

/**
 * Next's trailing `**` pathname glob → GioJS's trailing-`*` prefix match.
 * A single `*` (one segment in Next.js) has no exact equivalent: GioJS's
 * `*` matches at any depth, and this allowlist decides what the image
 * proxy fetches, so such a pattern is skipped rather than widened.
 */
function convertPathname(pathname: string): { pathname: string } | { error: string } {
  if (!pathname.includes('*')) return { pathname };
  const multi = /^(.*\/)\*\*$/.exec(pathname);
  if (multi !== null && !(multi[1] as string).includes('*')) return { pathname: `${multi[1] as string}*` };
  const single = /^(.*\/)\*$/.exec(pathname);
  if (single !== null && !(single[1] as string).includes('*')) {
    return {
      error: `pathname "${pathname}" allows one segment in Next.js, but a gio.toml "*" matches at any depth - add pathname = "${pathname}" by hand if every depth below ${single[1] as string} is fine to proxy`,
    };
  }
  return { error: `pathname "${pathname}" uses a glob gio.toml can't express (only a trailing * prefix match)` };
}

function convertImages(value: Value, result: ConvertedConfig): void {
  if (!isRecord(value)) {
    result.todos.push(`images could not be read statically (${describe(value)})`);
    return;
  }
  const keys: Array<[string, string]> = [];
  const widths = [
    ...(Array.isArray(value['deviceSizes']) ? value['deviceSizes'] : []),
    ...(Array.isArray(value['imageSizes']) ? value['imageSizes'] : []),
  ].filter((w): w is number => typeof w === 'number' && Number.isInteger(w) && w > 0);
  if (widths.length > 0) {
    const sorted = [...new Set(widths)].sort((a, b) => a - b);
    keys.push(['allowed_widths', `[${sorted.join(', ')}]`]);
    result.converted.push(`images.deviceSizes/imageSizes → [images] allowed_widths (${sorted.length} widths)`);
  }
  if (keys.length > 0) result.tables.push({ name: 'images', keys });

  const patterns: Value[] = Array.isArray(value['remotePatterns']) ? value['remotePatterns'] : [];
  for (const pattern of patterns) {
    if (!isRecord(pattern) || typeof pattern['hostname'] !== 'string') {
      result.todos.push(`images.remotePatterns entry ${describe(pattern)} could not be read statically - add it by hand`);
      continue;
    }
    const hostname = pattern['hostname'];
    if (pattern['port'] !== undefined && pattern['port'] !== '') {
      result.todos.push(`remote image pattern ${hostname}:${String(pattern['port'])} skipped: gio.toml remote_patterns have no port`);
      continue;
    }
    if (pattern['search'] !== undefined) {
      result.todos.push(`remote image pattern ${hostname} skipped: gio.toml remote_patterns can't restrict the query string`);
      continue;
    }
    const protocol = typeof pattern['protocol'] === 'string' ? pattern['protocol'].replace(/:$/, '') : 'https';
    const entryKeys: Array<[string, string]> = [['protocol', tomlString(protocol)], ['hostname', tomlString(hostname)]];
    const comments: string[] = [];
    if (pattern['protocol'] === undefined) comments.push(`${TODO_MARKER} Next.js allowed http and https here; gio.toml patterns name one protocol (https)`);
    if (typeof pattern['pathname'] === 'string') {
      const converted = convertPathname(pattern['pathname']);
      if ('error' in converted) {
        // Dropping the pathname would allow more of the host than before.
        result.todos.push(`remote image pattern ${hostname} skipped: ${converted.error}`);
        continue;
      }
      entryKeys.push(['pathname', tomlString(converted.pathname)]);
    }
    result.entries.push({ name: 'images.remote_patterns', keys: entryKeys, comments });
    result.converted.push(`images.remotePatterns ${hostname} → [[images.remote_patterns]]`);
  }
  const domains: Value[] = Array.isArray(value['domains']) ? value['domains'] : [];
  for (const domain of domains) {
    if (typeof domain !== 'string') continue;
    result.entries.push({
      name: 'images.remote_patterns',
      keys: [['protocol', tomlString('https')], ['hostname', tomlString(domain)]],
      comments: [],
    });
    result.converted.push(`images.domains ${domain} → [[images.remote_patterns]] (https)`);
  }
  if (value['unoptimized'] === true) result.todos.push('images.unoptimized: pass unoptimized on each <GioImage> (there is no global switch)');
  if (value['loader'] !== undefined || value['loaderFile'] !== undefined) result.todos.push('images.loader: GioJS optimizes images itself through /_gio/image - custom loaders do not apply');
  if (value['formats'] !== undefined) result.notes.push('images.formats: GioJS negotiates AVIF/WebP from the Accept header');
  if (value['dangerouslyAllowSVG'] === true) result.notes.push('images.dangerouslyAllowSVG: GioImage serves SVGs as-is, without the optimizer');
}

function convertI18n(value: Value, result: ConvertedConfig): void {
  if (!isRecord(value) || !Array.isArray(value['locales'])) {
    result.todos.push(`i18n could not be read statically (${describe(value)}) - add an [i18n] table by hand`);
    return;
  }
  const locales = value['locales'].filter((l): l is string => typeof l === 'string');
  const keys: Array<[string, string]> = [['locales', `[${locales.map(tomlString).join(', ')}]`]];
  if (typeof value['defaultLocale'] === 'string') keys.push(['default_locale', tomlString(value['defaultLocale'])]);
  if (value['localeDetection'] === false) keys.push(['detect_from', '["path"]']);
  result.tables.push({ name: 'i18n', keys });
  result.converted.push(`i18n → [i18n] (${locales.length} locales${value['localeDetection'] === false ? ', path detection only' : ''})`);
  if (value['domains'] !== undefined) result.todos.push('i18n.domains: domain-based locales are not supported - GioJS detects the locale from the path prefix, cookie and Accept-Language');
}

// ── toml output ─────────────────────────────────────────────────────────────

function renderSections(config: ConvertedConfig, includeTables: boolean): string[] {
  const lines: string[] = [];
  for (const todo of config.todos) lines.push(`# ${TODO_MARKER} ${todo}`);
  if (config.todos.length > 0) lines.push('');
  if (includeTables) {
    for (const table of config.tables) {
      lines.push(`[${table.name}]`, ...table.keys.map(([k, v]) => `${k} = ${v}`), '');
    }
  }
  for (const entry of config.entries) {
    lines.push(...entry.comments.map(c => `# ${c}`), `[[${entry.name}]]`, ...entry.keys.map(([k, v]) => `${k} = ${v}`), '');
  }
  return lines;
}

/** A complete gio.toml for a project that has none. */
export function buildToml(config: ConvertedConfig, appName: string): string {
  return [
    '# gio.toml - generated by create-giojs migrate from next.config.',
    '# Reference: https://giojs.com/docs/configuration',
    '',
    '[app]',
    `name = ${tomlString(appName)}`,
    '',
    '[server]',
    'host = "0.0.0.0"',
    'port = 3000',
    'http2 = true',
    '',
    ...renderSections(config, true),
  ].join('\n').replace(/\n+$/, '\n');
}

interface TomlLayout {
  /** Line index of each `[table]` header. */
  tables: Map<string, number>;
  arrayTables: Set<string>;
  /** Top-level keys (before the first header), first segment of dotted keys. */
  rootKeys: Set<string>;
  lines: string[];
}

function scanToml(text: string): TomlLayout {
  const lines = text.split('\n');
  const layout: TomlLayout = { tables: new Map(), arrayTables: new Set(), rootKeys: new Set(), lines };
  let inRoot = true;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    const array = /^\[\[\s*([^\]]+?)\s*\]\]/.exec(line);
    const table = array === null ? /^\[\s*([^\]]+?)\s*\]/.exec(line) : null;
    if (array !== null) {
      layout.arrayTables.add(array[1] as string);
      inRoot = false;
    } else if (table !== null) {
      layout.tables.set(table[1] as string, i);
      inRoot = false;
    } else if (inRoot) {
      const key = /^([A-Za-z0-9_-]+)\s*[.=]/.exec(line);
      if (key !== null) layout.rootKeys.add(key[1] as string);
    }
  }
  return layout;
}

/** Keys defined directly under the `[name]` header (up to the next header). */
function tableKeys(layout: TomlLayout, name: string): Set<string> {
  const keys = new Set<string>();
  const start = layout.tables.get(name);
  if (start === undefined) return keys;
  for (let i = start + 1; i < layout.lines.length; i++) {
    const line = (layout.lines[i] as string).trim();
    if (line.startsWith('[')) break;
    const key = /^([A-Za-z0-9_-]+)\s*[.=]/.exec(line);
    if (key !== null) keys.add(key[1] as string);
  }
  return keys;
}

/**
 * Merge the converted sections into an existing gio.toml when no table or
 * key would be defined twice; otherwise return the reason it is unsafe.
 */
export function mergeToml(existing: string, config: ConvertedConfig): { content: string } | { conflict: string } {
  if (existing.includes(MERGE_MARKER)) return { conflict: 'gio.toml already contains a previous migration' };
  const layout = scanToml(existing);
  const inserts = new Map<number, string[]>();
  const appendTables: TomlTable[] = [];
  for (const table of config.tables) {
    if (layout.rootKeys.has(table.name) || layout.arrayTables.has(table.name)) {
      return { conflict: `gio.toml defines ${table.name} in a form the migration can't extend` };
    }
    const header = layout.tables.get(table.name);
    if (header === undefined) {
      appendTables.push(table);
      continue;
    }
    const present = tableKeys(layout, table.name);
    const clash = table.keys.find(([k]) => present.has(k));
    if (clash !== undefined) return { conflict: `gio.toml already sets [${table.name}] ${clash[0]}` };
    inserts.set(header, table.keys.map(([k, v]) => `${k} = ${v}`));
  }
  for (const entry of config.entries) {
    const [parent, child] = entry.name.includes('.') ? entry.name.split('.') as [string, string] : [undefined, entry.name];
    if (parent === undefined) {
      if (layout.rootKeys.has(child) || layout.tables.has(child)) return { conflict: `gio.toml defines ${child} as a table, not [[${child}]]` };
    } else if (tableKeys(layout, parent).has(child) || layout.tables.has(entry.name)) {
      return { conflict: `gio.toml sets ${entry.name} inline - add the converted entries to it by hand` };
    }
  }

  const lines = [...layout.lines];
  for (const [header, keyLines] of [...inserts].sort((a, b) => b[0] - a[0])) {
    lines.splice(header + 1, 0, ...keyLines);
  }
  let content = lines.join('\n').replace(/\n*$/, '\n');
  const sections = renderSections({ ...config, tables: appendTables }, true);
  if (sections.length > 0 || inserts.size > 0) {
    content += `\n${MERGE_MARKER} (keys added to existing tables are listed in MIGRATION_REPORT.md) ──\n\n${sections.join('\n')}`;
  }
  return { content: content.replace(/\n+$/, '\n') };
}

/**
 * Where the converted config goes: a new gio.toml, merged into the
 * existing one, or a separate gio.migrated.toml when merging is unsafe.
 */
export function planToml(existing: string | undefined, config: ConvertedConfig, appName: string): TomlResult {
  if (existing === undefined) {
    return { target: 'gio.toml', content: buildToml(config, appName), mode: 'created' };
  }
  const nothing = config.tables.length === 0 && config.entries.length === 0 && config.todos.length === 0;
  if (nothing) return { target: 'gio.toml', content: existing, before: existing, mode: 'merged' };
  const merged = mergeToml(existing, config);
  if ('content' in merged) return { target: 'gio.toml', content: merged.content, before: existing, mode: 'merged' };
  return {
    target: MIGRATED_TOML,
    content: [
      `# Converted from next.config by create-giojs migrate. Not loaded by GioJS:`,
      `# ${merged.conflict}, so merge these sections into gio.toml by hand.`,
      '',
      ...renderSections(config, true),
    ].join('\n').replace(/\n+$/, '\n'),
    mode: 'separate',
    reason: merged.conflict,
  };
}
