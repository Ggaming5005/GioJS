/**
 * packages/giojs-react/src/typed-href.ts
 *
 * Typed route href builder. GioRegisteredRoutes is empty here and populated
 * by the generated <projectRoot>/.gio/routes.d.ts via declaration merging,
 * so href('/posts/:id', { id }) autocompletes registered patterns and
 * typechecks params with zero annotations in app code.
 */

export interface GioRegisteredRoutes {}

export type RouteParamsOf<P extends keyof GioRegisteredRoutes> = GioRegisteredRoutes[P];

type HrefArgs<P extends keyof GioRegisteredRoutes> =
  RouteParamsOf<P> extends Record<string, never> ? [] : [params: RouteParamsOf<P>];

function encodeSegmentValue(value: string, isCatchAll: boolean): string {
  // Catch-all values may span segments; encode each one, keep the separators.
  if (isCatchAll) {
    return value.split('/').map(encodeURIComponent).join('/');
  }
  return encodeURIComponent(value);
}

export function href<P extends keyof GioRegisteredRoutes & string>(
  pattern: P,
  ...args: HrefArgs<P>
): string;
export function href(pattern: string, params?: Record<string, string>): string {
  const paramValues = params ?? {};
  return pattern
    .split('/')
    .map(segment => {
      const isCatchAll = segment.startsWith('*');
      if (!isCatchAll && !segment.startsWith(':')) {
        return segment;
      }
      return encodeSegmentValue(paramValues[segment.slice(1)] ?? '', isCatchAll);
    })
    .join('/');
}
