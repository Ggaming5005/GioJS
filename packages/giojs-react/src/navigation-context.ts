/**
 * packages/giojs-react/src/navigation-context.ts
 *
 * The navigation state the hooks read. @gio.js/core provides it - around
 * the whole document during SSR (ssr.ts), around the hydrated tree in the
 * browser (client-runtime.ts, from the envelope's route info, refreshed on
 * every soft navigation) - so server and client render the same values.
 * The packages share the context object through a global symbol; the key
 * must match @gio.js/core's navigation-context.ts.
 */
import { createContext, useContext, type Context } from 'react';

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

export function navigationContext(): Context<GioNavigationState | null> {
  const registry = globalThis as Record<symbol, unknown>;
  let context = registry[CONTEXT_KEY] as Context<GioNavigationState | null> | undefined;
  if (context === undefined) {
    context = createContext<GioNavigationState | null>(null);
    context.displayName = 'GioNavigation';
    registry[CONTEXT_KEY] = context;
  }
  return context;
}

const EMPTY_PARAMS: Record<string, string> = Object.freeze({});

/**
 * The provided state. Outside a GioJS-rendered tree (a component rendered
 * on its own, in a unit test or a separate root) there is no hydration to
 * keep consistent: the browser's URL, or the site root on the server.
 */
export function useNavigationState(): GioNavigationState {
  const state = useContext(navigationContext());
  if (state !== null) return state;
  const inBrowser = typeof window !== 'undefined';
  return {
    pathname: inBrowser ? window.location.pathname : '/',
    params: EMPTY_PARAMS,
    search: inBrowser ? window.location.search : '',
    locale: '',
    pattern: '',
  };
}
