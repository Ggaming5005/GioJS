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

// Static routes take no params; routes whose params are all optional (an
// optional catch-all, `*slug?`) may omit the argument.
type HrefArgs<P extends keyof GioRegisteredRoutes> =
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

export function href<P extends keyof GioRegisteredRoutes & string>(
  pattern: P,
  ...args: HrefArgs<P>
): string;
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
