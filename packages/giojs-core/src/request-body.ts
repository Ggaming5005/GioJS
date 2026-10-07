/**
 * giojs-core/src/request-body.ts
 *
 * Request-body parsing rules for route.ts handlers and page actions.
 * `GioRequest.json()` parses only bodies declared as JSON: a cross-site HTML
 * form can send `text/plain` or form-encoded bodies without a CORS
 * preflight, so a handler that parsed whatever arrived would accept a forged
 * "JSON" request that a real JSON content type (which forces a preflight)
 * would have stopped. `GioRequest.formData()` likewise parses only the two
 * form encodings, through the web-standard (undici) Request.formData().
 */

/** `application/json` or any `application/*+json` (parameters ignored). */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return mime === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mime);
}

/**
 * Thrown by `GioRequest.json()` when the request is not declared as JSON
 * (and by `formData()` when it is not declared as a form).
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

  constructor(
    public readonly contentType: string | undefined,
    /** What the handler asked to parse: json() or formData(). */
    expected: 'json' | 'form' = 'json',
  ) {
    super(
      `request body must be sent as ${
        expected === 'json'
          ? 'application/json'
          : 'application/x-www-form-urlencoded or multipart/form-data'
      } (got ${contentType === undefined || contentType === '' ? 'no content-type' : contentType})`,
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

/** `application/x-www-form-urlencoded` or `multipart/form-data` (parameters ignored). */
export function isFormContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return mime === 'application/x-www-form-urlencoded' || mime === 'multipart/form-data';
}

/**
 * Thrown by `GioRequest.formData()` for a body that claims a form encoding
 * but does not parse as one (a broken multipart body, a missing boundary).
 * Uncaught, it answers 400 Bad Request instead of a 500.
 */
export class MalformedBodyError extends Error {
  /** Brand for cross-instance detection (see UnsupportedMediaTypeError). */
  public readonly __gioMalformedBody = true;
  public readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'MalformedBodyError';
  }
}

/** Cross-module-instance detection (see `__gioMalformedBody`). */
export function isMalformedBodyError(value: unknown): value is MalformedBodyError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __gioMalformedBody?: unknown }).__gioMalformedBody === true
  );
}

/**
 * Parse a forwarded request body as FormData: urlencoded fields as strings,
 * multipart file parts as `File` objects. The body arrives whole - Rust has
 * already enforced `[server] max_body_bytes` (413 above it) - as UTF-8 text
 * or base64, and is turned back into its exact bytes first, so binary file
 * contents survive.
 */
export async function parseFormData(
  body: string | null,
  bodyBase64: boolean,
  contentType: string | undefined,
): Promise<FormData> {
  if (!isFormContentType(contentType)) throw new UnsupportedMediaTypeError(contentType, 'form');
  // A form with no successful controls still posts; an empty multipart body
  // is not parseable, but it means the same thing.
  if (body === null || body === '') return new FormData();
  const bytes = Buffer.from(body, bodyBase64 ? 'base64' : 'utf8');
  try {
    return await new Request('http://gio.invalid/', {
      method: 'POST',
      body: bytes,
      headers: { 'content-type': contentType ?? '' },
    }).formData();
  } catch (err) {
    throw new MalformedBodyError(
      `request body is not valid ${(contentType ?? '').split(';')[0]?.trim()}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
