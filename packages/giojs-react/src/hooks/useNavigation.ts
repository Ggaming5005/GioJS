/**
 * packages/giojs-react/src/hooks/useNavigation.ts
 *
 * Router hooks: usePathname, useParams, useSearchParams and useRouter. The
 * first three read the navigation context @gio.js/core provides on both
 * sides from the same route info, so they are safe in server rendering
 * (including the server-only root layout) and hydrate without a mismatch;
 * after a soft navigation they return the new page's values. useRouter's
 * methods are no-ops on the server.
 */
import { useMemo } from 'react';
import { useNavigationState } from '../navigation-context.js';
import {
  back,
  forward,
  navigate,
  prefetch,
  refresh,
  type NavigateOptions,
} from '../navigation.js';
import type { GioRegisteredRoutes, RouteParamsOf } from '../typed-href.js';

/**
 * The routed path of the current page, without query or hash. With i18n the
 * locale prefix is not part of it (see useLocale); after a `[[rewrites]]`
 * rule it is the path the page was rendered for.
 */
export function usePathname(): string {
  return useNavigationState().pathname;
}

type ParamsFor<T> = T extends keyof GioRegisteredRoutes ? RouteParamsOf<T> : T;

/**
 * The matched route's dynamic segment values. Pass a registered pattern for
 * typed params - `useParams<'/posts/:id'>().id` - or a params shape.
 */
export function useParams<
  T extends Record<string, string> | (keyof GioRegisteredRoutes & string) = Record<string, string>,
>(): ParamsFor<T> {
  return useNavigationState().params as ParamsFor<T>;
}

/** URLSearchParams without the mutating methods. */
export type ReadonlyURLSearchParams = Omit<URLSearchParams, 'append' | 'delete' | 'set' | 'sort'>;

class ReadonlySearchParams extends URLSearchParams {
  override append(): never {
    throw readonlyError();
  }
  override delete(): never {
    throw readonlyError();
  }
  override set(): never {
    throw readonlyError();
  }
  override sort(): never {
    throw readonlyError();
  }
}

function readonlyError(): Error {
  return new Error(
    'useSearchParams() is read-only: build a new URLSearchParams(searchParams) and navigate to it',
  );
}

/**
 * The current page's query, read-only. To change it, navigate:
 * `router.push('?' + new URLSearchParams(...))`.
 */
export function useSearchParams(): ReadonlyURLSearchParams {
  const { search } = useNavigationState();
  return useMemo(() => new ReadonlySearchParams(search), [search]);
}

export type RouterNavigateOptions = Omit<NavigateOptions, 'replace'>;

export interface GioRouter {
  /** Soft-navigate to `href`, adding a history entry. */
  push(href: string, options?: RouterNavigateOptions): Promise<void>;
  /** Soft-navigate to `href`, replacing the current history entry. */
  replace(href: string, options?: RouterNavigateOptions): Promise<void>;
  back(): void;
  forward(): void;
  /** Re-fetch the current page (bypassing the prefetch cache) and re-render it in place. */
  refresh(): Promise<void>;
  /** Fetch `href` into the prefetch cache. */
  prefetch(href: string): void;
}

const router: GioRouter = Object.freeze({
  push: (href: string, options?: RouterNavigateOptions) =>
    navigate(href, { ...options, replace: false }),
  replace: (href: string, options?: RouterNavigateOptions) =>
    navigate(href, { ...options, replace: true }),
  back,
  forward,
  refresh,
  prefetch,
});

/** The client router. The same object on every render (safe in effect deps). */
export function useRouter(): GioRouter {
  return router;
}
