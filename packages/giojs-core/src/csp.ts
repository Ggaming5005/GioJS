/**
 * giojs-core/src/csp.ts
 *
 * Content-Security-Policy nonces on the Node side. When gio.toml's
 * `[security] csp` contains `{nonce}`, Rust spawns the worker with a secret
 * placeholder (GIO_CSP_NONCE_PLACEHOLDER). Pages are cached and PPR shells
 * replayed, so a render cannot know the nonce of the response that will
 * carry it: every inline script renders with the placeholder, and Rust
 * replaces it with a fresh per-response nonce - in the body and in the CSP
 * header - on every serve. The placeholder never reaches a browser.
 */

/** Exactly what Rust generates: 32 lowercase hex characters. */
const PLACEHOLDER_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The nonce for inline `<script>` / `<style>` tags in pages and layouts, or
 * `undefined` when the app has no nonce-based CSP. It is meant for `nonce`
 * attributes only: the value is a secret placeholder that the server swaps
 * for the response's real nonce, so pass it straight to the attribute
 * (`<script nonce={cspNonce()}>`) and never derive anything else from it
 * (hash it, slice it, or encode it, and the server can no longer find it).
 * The server replaces it in the headers and the body of every dynamic
 * response, whatever the content type; a response that sets its own
 * Content-Encoding cannot be checked and is refused (500) while nonces are
 * on. The placeholder rotates with a new GIO_DEPLOYMENT_ID, a new standalone
 * build or a change to the gio.toml settings pages render with (not with a
 * code-only redeploy) - delete `<cache dir>/meta/csp-nonce-placeholder-*` and
 * restart to rotate it.
 * Read per call (cheap), so tests and static export see the current
 * environment.
 */
export function cspNonce(): string | undefined {
  const placeholder = process.env.GIO_CSP_NONCE_PLACEHOLDER;
  // Static export has no server to substitute it: no nonces there.
  if (process.env.GIO_EXPORT === '1') return undefined;
  return placeholder !== undefined && PLACEHOLDER_PATTERN.test(placeholder)
    ? placeholder
    : undefined;
}

/** ` nonce="…"` for framework-written inline tags, or '' without nonces. */
export function nonceAttr(): string {
  const nonce = cspNonce();
  return nonce === undefined ? '' : ` nonce="${nonce}"`;
}
