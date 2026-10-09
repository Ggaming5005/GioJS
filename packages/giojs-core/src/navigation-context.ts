/**
 * giojs-core/src/navigation-context.ts
 *
 * The navigation state @gio.js/react's hooks read (usePathname, useParams,
 * useSearchParams, useLocale): ssr.ts provides it around the whole document
 * (root layout included), client-runtime.ts around the hydrated #__gio tree,
 * from the same route info carried in the hydration envelope - identical
 * values on both sides, so nothing that reads it can cause a hydration
 * mismatch.
 *
 * @gio.js/core and @gio.js/react are separate packages (and separate copies
 * in a bundle), so the context object lives under a global symbol: whichever
 * side asks first creates it, every later caller gets the same object.
 * @gio.js/react's navigation-context.ts uses the same key.
 *
 * Browser-safe: imports only React.
 */
import React from 'react';

/** The page being rendered, as the router matched it. */
export interface GioNavigationState {
  /** The routed path (after locale-prefix stripping and rewrites), no query. */
  pathname: string;
  /** Dynamic segment values of the matched route. */
  params: Record<string, string>;
  /** The query string with its `?`, or ''. */
  search: string;
  /** The request locale ('' without i18n). */
  locale: string;
  /** The matched route pattern ('/posts/:id'); '' for not-found/error pages. */
  pattern: string;
}

const CONTEXT_KEY = Symbol.for('gio.navigation-context');

export function navigationContext(): React.Context<GioNavigationState | null> {
  const registry = globalThis as Record<symbol, unknown>;
  let context = registry[CONTEXT_KEY] as React.Context<GioNavigationState | null> | undefined;
  if (context === undefined) {
    context = React.createContext<GioNavigationState | null>(null);
    context.displayName = 'GioNavigation';
    registry[CONTEXT_KEY] = context;
  }
  return context;
}

/** Wrap `children` in the navigation provider. */
export function withNavigation(state: GioNavigationState, children: React.ReactNode): React.ReactElement {
  return React.createElement(navigationContext().Provider, { value: state }, children);
}

/**
 * The query string for the decoded query map Rust sends (one value per key -
 * the last one wins). Re-encoded so `new URLSearchParams(search)` returns
 * exactly the decoded values.
 */
export function searchFromQuery(query: Record<string, string>): string {
  const encoded = new URLSearchParams(query).toString();
  return encoded === '' ? '' : `?${encoded}`;
}
