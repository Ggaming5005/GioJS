/**
 * giojs-core/src/not-found.ts
 *
 * notFound(): abort the current page and answer 404 with the nearest
 * not-found.* file. Thrown from getServerSideProps or during render; the
 * renderer recognizes the error by its brand, never by message or class.
 *
 * Browser-safe (no imports): a page component that calls notFound() while
 * rendering ships this module in its client bundle.
 */

// Symbol.for, not a module-local symbol: app modules load in their own tsx
// namespace (and client bundles carry their own copy), so the thrower's
// module instance is rarely the renderer's.
const NOT_FOUND_BRAND = Symbol.for('gio.notFound');

/** What notFound() throws. Only isNotFoundError() should look at it. */
class NotFoundError extends Error {
  readonly [NOT_FOUND_BRAND] = true;

  constructor() {
    super('notFound() was called');
    this.name = 'NotFoundError';
  }
}

/**
 * Stop rendering this page and respond 404 with the nearest not-found.*
 * at or above the page's folder (inside the layouts that apply there), or
 * the built-in 404 page. Works in getServerSideProps and during render;
 * returning `{ notFound: true }` from getServerSideProps does the same.
 */
export function notFound(): never {
  throw new NotFoundError();
}

/** Whether `value` was thrown by notFound() (from any copy of this module). */
export function isNotFoundError(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[NOT_FOUND_BRAND] === true
  );
}
