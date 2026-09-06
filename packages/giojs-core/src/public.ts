/**
 * giojs-core/src/public.ts
 *
 * Public API surface of @gio.js/core — the package entrypoint for app code
 * (route handlers, plugins). The worker executable stays in index.ts and is
 * launched by file path, never through this module.
 */
export { GioEventStream, isGioEventStream } from './sse.ts';
export type { SseStream, SseCleanupFn } from './sse.ts';
export type { GioRequest, GioSocket } from './context.ts';
export type { GioNodePlugin } from './plugin.ts';
