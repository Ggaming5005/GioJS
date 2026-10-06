/**
 * giojs-core/src/server-only.ts
 *
 * `import '@gio.js/core/server-only'` marks a module as server-only. On the
 * server it is a no-op. The client build (client-build.ts) resolves the
 * import to a marker and refuses to emit any route bundle in which the
 * marker is still live after tree-shaking - naming the import chain - so a
 * secret-holding module can never reach the browser by accident.
 */
export {};
