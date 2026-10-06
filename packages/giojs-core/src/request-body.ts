/**
 * giojs-core/src/request-body.ts
 *
 * Request-body parsing rules for route.ts handlers. `GioRequest.json()`
 * parses only bodies declared as JSON: a cross-site HTML form can send
 * `text/plain` or form-encoded bodies without a CORS preflight, so a handler
 * that parsed whatever arrived would accept a forged "JSON" request that a
 * real JSON content type (which forces a preflight) would have stopped.
 */

/** `application/json` or any `application/*+json` (parameters ignored). */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return mime === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mime);
}

/**
 * Thrown by `GioRequest.json()` when the request is not declared as JSON.
 * A handler may catch it; uncaught, the route-handler wrapper answers
 * 415 Unsupported Media Type instead of a 500.
 */
export class UnsupportedMediaTypeError extends Error {
  /**
   * Brand for cross-instance detection: route files load in their own module
   * namespace, so `instanceof` fails across the boundary (see sse.ts).
   */
  public readonly __gioUnsupportedMediaType = true;
  public readonly status = 415;

  constructor(public readonly contentType: string | undefined) {
    super(
      `request body must be sent as application/json (got ${
        contentType === undefined || contentType === '' ? 'no content-type' : contentType
      })`,
    );
    this.name = 'UnsupportedMediaTypeError';
  }
}

/** Cross-module-instance detection (see `__gioUnsupportedMediaType`). */
export function isUnsupportedMediaTypeError(value: unknown): value is UnsupportedMediaTypeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __gioUnsupportedMediaType?: unknown }).__gioUnsupportedMediaType === true
  );
}
