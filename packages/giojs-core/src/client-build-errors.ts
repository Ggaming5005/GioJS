/**
 * giojs-core/src/client-build-errors.ts
 *
 * Why each route's client bundle was rejected in the latest build. Kept out
 * of client-build.ts so the SSR renderer can read it without importing
 * esbuild (the standalone worker bundle ships without it).
 */

const routeBuildErrors = new Map<string, string>();

export function clearClientBuildErrors(): void {
  routeBuildErrors.clear();
}

export function recordClientBuildError(pattern: string, message: string): void {
  routeBuildErrors.set(pattern, message);
}

/**
 * The client build error that left `pattern` without hydration, if any. The
 * dev renderer hands it to the error overlay so a broken bundle is visible in
 * the browser, not only in the server log.
 */
export function clientBuildErrorFor(pattern: string): string | undefined {
  return routeBuildErrors.get(pattern);
}
