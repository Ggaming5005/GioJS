/**
 * giojs-core/src/action.ts
 *
 * Page actions: a page module's `export async function action(req)` answers
 * POSTs to the page's own URL - an HTML form that works without JavaScript.
 * It receives the route.ts request (GioRequest, `formData()` included) and
 * returns one of:
 *
 *  - a web `Response`, sent as is (the action owns status, headers, body);
 *  - `redirect(url)` - 303 See Other by default, the Post/Redirect/Get hop
 *    that keeps a reload from resubmitting the form;
 *  - `{ status?, data, headers? }` (an object with a `data` key and no keys
 *    besides those three), or any other value as the data itself: the page
 *    re-renders with it as the `actionData` prop (and `ctx.actionData` in
 *    getServerSideProps), status 200 unless given - 422 for validation errors.
 *
 * Only POST runs an action: it is all an HTML form can send besides GET, and
 * named per-method handlers are what route.ts is for. Action answers and the
 * page they re-render are never cached (ssr.ts; Rust also never stores a
 * non-GET response).
 *
 * redirect() and notFound() may also be thrown, from the action or anything
 * it calls. getServerSideProps may return or throw redirect() too, so one
 * guard (`requireUser()`) serves pages and actions alike.
 */
import type { GioRequest } from './context.ts';
import type { GsspResponseHeaders } from './router.ts';
import type { ParamsOf, RouteOrParams } from './route-params.ts';

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** What redirect() returns (or throws). Only the renderer should look inside. */
export interface ActionRedirect {
  /**
   * Brand for cross-instance detection: app modules load in their own tsx
   * namespace, so the caller's copy of this module is rarely the
   * renderer's (see request-body.ts).
   */
  readonly __gioRedirect: true;
  readonly location: string;
  readonly status: number;
  readonly headers?: GsspResponseHeaders;
}

export interface RedirectInit {
  /** 301, 302, 303 (the default), 307 or 308. */
  status?: number;
  /** Sent with the redirect - e.g. `set-cookie` from commitSession(). */
  headers?: GsspResponseHeaders;
}

/**
 * Answer the action (or getServerSideProps) with a redirect:
 * `return redirect('/thanks')`. The default 303 makes the browser GET the
 * target, so a reload there never repeats the POST. Pass
 * `{ status, headers }` (or just a status) for anything else; a URL built
 * from user input must be checked first - an unvalidated `?next=`
 * parameter is an open redirect.
 */
export function redirect(url: string, init: number | RedirectInit = {}): ActionRedirect {
  const { status = 303, headers } = typeof init === 'number' ? { status: init } : init;
  if (typeof url !== 'string' || url === '') {
    throw new TypeError('redirect() needs a non-empty URL');
  }
  // A Location header value cannot carry control characters; CR/LF would
  // be header injection.
  if (/[\u0000-\u001f\u007f]/.test(url)) {
    throw new TypeError('redirect() URL contains control characters');
  }
  if (!REDIRECT_STATUSES.has(status)) {
    throw new TypeError(`redirect() status must be 301, 302, 303, 307 or 308 (got ${String(status)})`);
  }
  return {
    __gioRedirect: true,
    location: url,
    status,
    ...(headers !== undefined ? { headers } : {}),
  };
}

/** Whether `value` came from redirect() (from any copy of this module). */
export function isActionRedirect(value: unknown): value is ActionRedirect {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __gioRedirect?: unknown }).__gioRedirect === true
  );
}

/** The `{ status, data, headers }` form of an action result. */
export interface ActionDataResult<Data = unknown> {
  /** 2xx or 4xx/5xx; default 200. Use 422 for validation errors. */
  status?: number;
  data: Data;
  /** Sent with the re-rendered page - e.g. a flash cookie. */
  headers?: GsspResponseHeaders;
}

/**
 * The request a page action receives: route.ts's request, typed params -
 * `ActionArgs<'/posts/:id'>` or `ActionArgs<{ id: string }>`.
 */
export interface ActionArgs<Route extends RouteOrParams = Record<string, string>>
  extends Omit<GioRequest, 'params'> {
  params: ParamsOf<Route>;
}

/** Everything a page action may return. */
export type ActionResult<Data = unknown> =
  | Response
  | ActionRedirect
  | ActionDataResult<Data>
  | Data
  | undefined
  | null;

/** A page module's `action` export. */
// The args parameter is bivariant on purpose: an action typed with narrower
// params (ActionArgs<{ id: string }>) must still fit the page module type.
export type PageAction = {
  bivarianceHack(req: ActionArgs): unknown;
}['bivarianceHack'];

type DataOf<R> = R extends Response | ActionRedirect
  ? never
  : R extends undefined | null | void
    ? null
    : R extends { data: infer D }
      ? // Optional keys only: TS widens a union of returned object literals
        // with `key?: never` for the other members' keys.
        Record<never, never> extends Omit<R, 'status' | 'data' | 'headers'>
        ? D
        : R
      : R;

/**
 * The `actionData` a page receives from its action:
 * `({ actionData }: { actionData?: ActionData<typeof action> })`.
 * Responses and redirects never re-render, so they are left out; an action
 * that returns nothing yields `null`.
 */
export type ActionData<A> = A extends (...args: never[]) => infer R ? DataOf<Awaited<R>> : never;

/** Page props with the action's result: `WithActionData<typeof action, { posts: Post[] }>`. */
export type WithActionData<A, Props extends object = Record<never, never>> = Props & {
  /** Present only on the render that answers a POST to this page. */
  actionData?: ActionData<A>;
};

/** What an action asked for: an answer of its own, or a re-render of the page. */
export type ActionOutcome =
  | { kind: 'response'; response: Response }
  | { kind: 'redirect'; redirect: ActionRedirect }
  | { kind: 'render'; status: number; data: unknown; headers?: GsspResponseHeaders };

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['status', 'data', 'headers']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{ data }` plus at most `status` / `headers` - anything else is plain data. */
function isDataEnvelope(value: unknown): value is ActionDataResult {
  return isRecord(value) && 'data' in value && Object.keys(value).every(k => ENVELOPE_KEYS.has(k));
}

/**
 * The status a re-render may answer with. A 1xx/3xx (a redirect without a
 * Location) or a 204/205/304 (no body) cannot carry the page.
 */
function renderStatus(status: unknown): number {
  if (
    typeof status === 'number' &&
    Number.isInteger(status) &&
    ((status >= 200 && status <= 299 && status !== 204 && status !== 205) ||
      (status >= 400 && status <= 599))
  ) {
    return status;
  }
  throw new TypeError(
    `action returned status ${String(status)} - a re-render answers 2xx (not 204/205) or 4xx/5xx; ` +
      'use redirect() for 3xx, or return a Response',
  );
}

/** Classify an action's return value (or a thrown redirect()). */
export function actionOutcome(result: unknown): ActionOutcome {
  if (result instanceof Response) return { kind: 'response', response: result };
  if (isActionRedirect(result)) return { kind: 'redirect', redirect: result };
  if (isDataEnvelope(result)) {
    const headers = result.headers;
    return {
      kind: 'render',
      status: result.status === undefined ? 200 : renderStatus(result.status),
      data: result.data,
      ...(headers !== undefined ? { headers } : {}),
    };
  }
  return { kind: 'render', status: 200, data: result ?? null };
}
