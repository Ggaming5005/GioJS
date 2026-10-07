/**
 * giojs-core/src/render-scope.ts
 *
 * Which part of a server render a component is in: the #__gio tree the
 * browser hydrates, or HTML that never hydrates - the root layout around it,
 * a page without a client bundle, a not-found or error page. Effects never
 * run in the latter, so a component that needs the browser there renders a
 * small inline script instead (`<Animate>`), nonced for the page's CSP.
 *
 * ssr.ts provides `{ hydrating: false }` around the whole document and
 * `{ hydrating: true }` around a hydrating #__gio boundary. The browser
 * provides nothing: a hydrated tree reads null, exactly what the server
 * rendered inside the boundary in effect, so nothing that branches on it can
 * mismatch. The context lives under a global symbol (as navigation-context.ts
 * does); @gio.js/react's render-scope.ts uses the same key.
 *
 * Browser-safe: imports only React.
 */
import React from 'react';

export interface GioRenderScope {
  /** Inside the #__gio tree the browser hydrates. */
  hydrating: boolean;
  /** The CSP nonce for inline scripts, when the page's CSP uses one. */
  nonce?: string;
}

const CONTEXT_KEY = Symbol.for('gio.render-scope');

export function renderScopeContext(): React.Context<GioRenderScope | null> {
  const registry = globalThis as Record<symbol, unknown>;
  let context = registry[CONTEXT_KEY] as React.Context<GioRenderScope | null> | undefined;
  if (context === undefined) {
    context = React.createContext<GioRenderScope | null>(null);
    context.displayName = 'GioRenderScope';
    registry[CONTEXT_KEY] = context;
  }
  return context;
}

/** Wrap `children` in the render scope provider. */
export function withRenderScope(scope: GioRenderScope, children: React.ReactNode): React.ReactElement {
  return React.createElement(renderScopeContext().Provider, { value: scope }, children);
}
