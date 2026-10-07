/**
 * giojs-core/src/route-params.ts
 *
 * Type-level route params, shared by the page, getServerSideProps and
 * route.ts types (app-types.ts). Types only - nothing here exists at runtime.
 *
 * The registry is the global `GioJS.RegisteredRoutes` interface: empty
 * here, filled by the generated .gio/routes.d.ts (typed-routes.ts) through
 * declaration merging. A global rather than a module export because two
 * packages read it - @gio.js/react's href()/useParams() and these types -
 * and neither package depends on the other: a global merges no matter
 * which of them a project can resolve.
 *
 * With routes registered, a pattern argument must be one of them (typos
 * fail, editors autocomplete) and its params come from the registry.
 * Before the first server start writes the file - or in a project that
 * does not include it - any pattern is accepted and its params are parsed
 * from the pattern itself, by the same rules the generator uses.
 */

declare global {
  namespace GioJS {
    /** Route pattern → params of every page and route.ts (.gio/routes.d.ts). */
    interface RegisteredRoutes {}
  }
}

type RegisteredPattern = keyof GioJS.RegisteredRoutes & string;

/**
 * A route pattern as the router writes it: `/posts/:id`, `/docs/*slug`,
 * `/shop/*path?`. The registered patterns once .gio/routes.d.ts is
 * included, any string before that.
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
 * Params parsed from a pattern string: `:name` and `*name` are strings (a
 * catch-all is one string with '/' separators), `*name?` is optional, and
 * a pattern without dynamic segments takes none.
 */
export type ParamsFromPattern<Pattern extends string> = string extends Pattern
  ? Record<string, string>
  : keyof PatternSegments<Pattern> extends never
    ? Record<string, never>
    : Simplify<PatternSegments<Pattern>>;

/** The params of a route pattern: from the registry when registered, else parsed. */
export type RouteParamsOf<Pattern extends string> = Pattern extends RegisteredPattern
  ? GioJS.RegisteredRoutes[Pattern]
  : ParamsFromPattern<Pattern>;

/**
 * What the route-typed generics accept: a route pattern (`'/posts/:id'`) or
 * a params shape (`{ id: string }`).
 */
export type RouteOrParams = RoutePattern | object;

/**
 * Resolves a RouteOrParams argument to the params object.
 *
 * A conditional type, so TypeScript leaves it unresolved while `Route` is
 * still a type parameter: in generic code (`<P extends { id: string }>(req:
 * ActionArgs<P>)`) `req.params.id` typechecks, but `req.params` is a
 * `ParamsOf<P>`, not a `P` - annotate with `ActionArgs<P>['params']`.
 */
export type ParamsOf<Route> = Route extends string ? RouteParamsOf<Route> : Route;

type CatchAllName<Segment extends string> = Segment extends `*${infer Name}?`
  ? Name
  : Segment extends `*${infer Name}`
    ? Name
    : never;

/** The names of a pattern's catch-all segments (`*name`, `*name?`). */
type CatchAllNames<Pattern extends string> = Pattern extends `${infer Head}/${infer Rest}`
  ? CatchAllName<Head> | CatchAllNames<Rest>
  : CatchAllName<Pattern>;

type WithArrayCatchAlls<Params, Names> = {
  [K in keyof Params]: K extends Names ? Params[K] | string[] : Params[K];
};

/**
 * The params of one getStaticPaths entry: those of the route, except that
 * `gio export` also takes a catch-all as an array of segments
 * (`{ slug: ['guides', 'setup'] }` for `/docs/*slug`), as Next.js does.
 */
export type StaticParamsOf<Route> = Route extends string
  ? WithArrayCatchAlls<RouteParamsOf<Route>, CatchAllNames<Route>>
  : Route;
