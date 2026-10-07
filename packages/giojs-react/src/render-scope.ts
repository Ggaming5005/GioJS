/**
 * packages/giojs-react/src/render-scope.ts
 *
 * Where a server render is (core's render-scope.ts provides it): inside the
 * #__gio tree the browser hydrates, or in HTML that never hydrates, where
 * effects never run. null in the browser and outside a GioJS render. The
 * packages share the context object through a global symbol; the key must
 * match @gio.js/core's render-scope.ts.
 */
import { createContext, type Context } from 'react';

export interface GioRenderScope {
  /** Inside the #__gio tree the browser hydrates. */
  hydrating: boolean;
  /** The CSP nonce for inline scripts, when the page's CSP uses one. */
  nonce?: string;
}

const CONTEXT_KEY = Symbol.for('gio.render-scope');

export function renderScopeContext(): Context<GioRenderScope | null> {
  const registry = globalThis as Record<symbol, unknown>;
  let context = registry[CONTEXT_KEY] as Context<GioRenderScope | null> | undefined;
  if (context === undefined) {
    context = createContext<GioRenderScope | null>(null);
    context.displayName = 'GioRenderScope';
    registry[CONTEXT_KEY] = context;
  }
  return context;
}
