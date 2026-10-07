/**
 * packages/giojs-react/src/typed-href.ts
 *
 * Typed route href builder. GioRegisteredRoutes is empty here and populated
 * by the generated <projectRoot>/.gio/routes.d.ts via declaration merging,
 * so href('/posts/:id', { id }) autocompletes registered patterns and
 * typechecks params with zero annotations in app code.
 *
 * The generated file fills the global `GioJS.RegisteredRoutes`, the one
 * registry this package and @gio.js/core's page types (PageProps,
 * GsspContext) both read - a global, because neither package depends on
 * the other. @gio.js/core declares the same empty interface; declarations
 * merge.
 *
 * Before the file exists (the first server start or `gio typegen` writes
 * it) - or in a project whose tsconfig leaves it out - any pattern is
 * accepted and its params are parsed from the pattern itself, by the rules
 * @gio.js/core's route-params.ts and the generator use.
 */

declare global {
  namespace GioJS {
    /** Route pattern → params of every page and route.ts (.gio/routes.d.ts). */
    interface RegisteredRoutes {}
  }
}

/** The registered routes; augmenting this interface directly works too. */
export interface GioRegisteredRoutes extends GioJS.RegisteredRoutes {}

type RegisteredPattern = keyof GioRegisteredRoutes & string;

/**
 * What href() and useParams() accept: the registered patterns once
 * .gio/routes.d.ts is included (a typo fails tsc), any string before that.
 */
export type RoutePattern = [RegisteredPattern] extends [never] ? string : RegisteredPattern;

type SegmentParams<Segment extends string> = Segment extends `:${infer Name}`
  ? { [K in Name]: string }
  : Segment extends `*${infer Name}?`
    ? { [K in Name]?: string }
    : Segment extends `*${infer Name}`
      ? { [K in Name]: string }
      : unknown;

type PatternSegments<Pattern extends string> = Pattern extends `${infer Head}/${infer Rest}`
  ? SegmentParams<Head> & PatternSegments<Rest>
  : SegmentParams<Pattern>;

// `& {}` makes editors show the flattened object, not `Simplify<...>`.
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Params parsed from a pattern string, the same type @gio.js/core's
 * ParamsFromPattern gives: `:name` and `*name` are strings, `*name?` is
 * optional, and a pattern without dynamic segments takes none.
 */
type ParamsFromPattern<Pattern extends string> = string extends Pattern
  ? Record<string, string>
  : keyof PatternSegments<Pattern> extends never
    ? Record<string, never>
    : Simplify<PatternSegments<Pattern>>;

/** The params of a route pattern: from the registry when registered, else parsed. */
export type RouteParamsOf<P extends string> = P extends RegisteredPattern
  ? GioRegisteredRoutes[P]
  : ParamsFromPattern<P>;

// Static routes take no params; routes whose params are all optional (an
// optional catch-all, `*slug?`) may omit the argument.
type HrefArgs<P extends string> =
  RouteParamsOf<P> extends Record<string, never>
    ? []
    : {} extends RouteParamsOf<P>
      ? [params?: RouteParamsOf<P>]
      : [params: RouteParamsOf<P>];

function encodeSegmentValue(value: string, isCatchAll: boolean): string {
  // Catch-all values may span segments; encode each one, keep the separators.
  if (isCatchAll) {
    return value.split('/').map(encodeURIComponent).join('/');
  }
  return encodeURIComponent(value);
}

// NoInfer: P comes from the pattern alone. Inferred from the params too, a
// wrong params object widened P to a union that accepted it.
export function href<P extends RoutePattern>(pattern: P, ...args: HrefArgs<NoInfer<P>>): string;
export function href(pattern: string, params?: Record<string, string>): string {
  const paramValues = params ?? {};
  const segments: string[] = [];
  for (const segment of pattern.split('/')) {
    const isCatchAll = segment.startsWith('*');
    if (!isCatchAll && !segment.startsWith(':')) {
      segments.push(segment);
      continue;
    }
    const isOptional = isCatchAll && segment.endsWith('?');
    const value = paramValues[isOptional ? segment.slice(1, -1) : segment.slice(1)] ?? '';
    // An empty optional catch-all is the bare parent: '/shop', not '/shop/'.
    if (isOptional && value === '') continue;
    segments.push(encodeSegmentValue(value, isCatchAll));
  }
  const url = segments.join('/');
  return url === '' ? '/' : url;
}
