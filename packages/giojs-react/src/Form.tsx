/**
 * packages/giojs-react/src/Form.tsx
 *
 * <GioForm>: a form that posts to a page action (or route.ts) with
 * progressive enhancement. It renders a real `<form method="post">` - no
 * `action` attribute unless given, so without JavaScript the browser posts
 * to the page's own URL and shows the answer. Once hydrated it intercepts
 * the submit, sends the same body with fetch (the submitter's name/value
 * included, multipart when the form's enctype says so) and shows the answer
 * through the client router (navigation.ts submitForm): a redirect's target
 * or the action's re-render is swapped in like a soft navigation, inside the
 * persistent root, so state outside what changed - typed input included -
 * survives.
 *
 * Answers the router cannot render fall back to what the browser would do,
 * without ever running the action twice: a redirect to another site or to
 * a non-GioJS page is loaded (a GET). A refusal that comes before the action
 * runs - the server's 413 for an upload over max_body_bytes, a 429 from its
 * rate limiter, a deployment-skew 409 - is submitted again natively, so the
 * browser shows it with its real status. Every other answer that is not a
 * page may come after the action ran (a 500 when it threw past its writes,
 * a 504 while it is still running, a Response of its own): it goes to
 * onSuccess / onError with the response and is never sent again - nor is a
 * network failure, which leaves the form as it is, input intact.
 *
 * While a submission is pending, further submits are ignored and the form
 * carries aria-busy. useGioFormState() exposes { pending, lastResult } to
 * anything inside the form; children may also be a function of that state.
 */
import React from 'react';
import { submitForm, type FormSubmitOutcome } from './navigation.js';

/** How the last submission ended. */
export interface GioFormResult {
  /** The final status was 2xx. */
  ok: boolean;
  /**
   * The final response's status (after redirects); 0 when the request
   * failed. For a redirect the browser follows on its own (another site, a
   * page the router could not fetch), the submission's own 2xx.
   */
  status: number;
  /**
   * Path + query of the final response - the page now shown, after a
   * redirect. A redirect to another site gives its absolute URL.
   */
  url: string;
  /** The action answered with a redirect. */
  redirected: boolean;
  /** The `actionData` of the page the answer rendered, if any. */
  data?: unknown;
  /** The answer when it was not a GioJS page (e.g. an action's JSON Response). */
  response?: Response;
  /** Why the request failed (network error). */
  error?: unknown;
}

export interface GioFormState {
  /** A submission is in flight. */
  pending: boolean;
  /** The last finished submission, null before the first. */
  lastResult: GioFormResult | null;
}

export interface GioFormProps
  extends Omit<React.FormHTMLAttributes<HTMLFormElement>, 'action' | 'method' | 'onError' | 'children'> {
  /** Where to post. Default: the current page's URL (its action). */
  action?: string | undefined;
  /** After a 2xx answer (a redirect's target included). */
  onSuccess?: ((result: GioFormResult) => void) | undefined;
  /** After a non-2xx answer (a 422 re-render included) or a failed request. */
  onError?: ((result: GioFormResult) => void) | undefined;
  /** Reset the form's fields after a successful submission that kept it on screen. */
  resetOnSuccess?: boolean | undefined;
  /** Never intercept: always a native, full page submission (downloads, for one). */
  reloadDocument?: boolean | undefined;
  children?: React.ReactNode | ((state: GioFormState) => React.ReactNode);
}

const IDLE: GioFormState = { pending: false, lastResult: null };

const FormStateContext = React.createContext<GioFormState>(IDLE);

/**
 * The state of the enclosing <GioForm>: `pending` while its submission is
 * in flight (disable the button, show a spinner), and how the last one
 * ended. Outside a GioForm it is always idle.
 */
export function useGioFormState(): GioFormState {
  return React.useContext(FormStateContext);
}

/**
 * Error statuses that mean the server refused the request unread - its 413
 * for a body over max_body_bytes, a 429 from its rate limiter - so handing
 * the browser the same submission cannot repeat the action.
 */
const REFUSED_UNREAD: ReadonlySet<number> = new Set([413, 429]);

type Submitter = HTMLButtonElement | HTMLInputElement;

/** onSubmit's event, whichever @types/react names it (FormEvent / SubmitEvent). */
type FormSubmitEvent = Parameters<NonNullable<React.FormHTMLAttributes<HTMLFormElement>['onSubmit']>>[0];

function asSubmitter(element: HTMLElement | null | undefined): Submitter | null {
  return element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element : null;
}

/** An attribute the submitter overrides the form's with (formaction, formmethod, ...). */
function override(form: HTMLFormElement, submitter: Submitter | null, attr: string): string | null {
  if (submitter !== null && submitter.hasAttribute(`form${attr}`)) return submitter.getAttribute(`form${attr}`);
  // getAttribute, not form.action: a field named "action" shadows the property.
  return form.getAttribute(attr);
}

/** The form's fields as the browser would send them, submitter included. */
function formBody(form: HTMLFormElement, submitter: Submitter | null, enctype: string): FormData | URLSearchParams {
  // new FormData(form) never includes buttons; the clicked one is sent too.
  const data = new FormData(form);
  if (submitter !== null && submitter.name !== '') data.append(submitter.name, submitter.value);
  if (enctype === 'multipart/form-data') return data;
  // The default encoding: a file field sends just its name, as browsers do.
  const params = new URLSearchParams();
  for (const [name, value] of data) params.append(name, typeof value === 'string' ? value : value.name);
  return params;
}

function resultOf(outcome: Exclude<FormSubmitOutcome, { kind: 'reload' | 'superseded' }>, url: string): GioFormResult {
  if (outcome.kind === 'failed') return { ok: false, status: 0, url, redirected: false, error: outcome.error };
  const base = {
    ok: outcome.status >= 200 && outcome.status <= 299,
    status: outcome.status,
    url: outcome.url,
    redirected: outcome.redirected,
  };
  if (outcome.kind === 'shown') return outcome.actionData === undefined ? base : { ...base, data: outcome.actionData };
  if (outcome.kind === 'response') return { ...base, response: outcome.response };
  return base;
}

export const GioForm = React.forwardRef<HTMLFormElement, GioFormProps>(function GioForm(
  { action, onSubmit, onSuccess, onError, resetOnSuccess, reloadDocument, children, ...rest },
  ref,
) {
  const [state, setState] = React.useState<GioFormState>(IDLE);
  const pendingRef = React.useRef(false);
  // Set around our own native re-submission, so the handler lets it through.
  const nativeRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Submit for real, the way the browser would without JavaScript. */
  function submitNatively(form: HTMLFormElement, submitter: Submitter | null): void {
    nativeRef.current = true;
    try {
      if (typeof form.requestSubmit === 'function') {
        if (submitter !== null && submitter.form === form) form.requestSubmit(submitter);
        else form.requestSubmit();
        return;
      }
      if (submitter !== null && submitter.name !== '') {
        const field = document.createElement('input');
        field.type = 'hidden';
        field.name = submitter.name;
        field.value = submitter.value;
        form.appendChild(field);
      }
      // The prototype's: a field named "submit" shadows form.submit.
      HTMLFormElement.prototype.submit.call(form);
    } finally {
      nativeRef.current = false;
    }
  }

  async function send(form: HTMLFormElement, submitter: Submitter | null, url: URL, enctype: string): Promise<void> {
    pendingRef.current = true;
    setState(prev => ({ pending: true, lastResult: prev.lastResult }));
    const target = url.pathname + url.search;
    const focusedAtSubmit = document.activeElement;
    const outcome = await submitForm(target, formBody(form, submitter, enctype));
    const finish = (lastResult: GioFormResult | null): void => {
      pendingRef.current = false;
      if (mountedRef.current) setState(prev => ({ pending: false, lastResult: lastResult ?? prev.lastResult }));
    };
    if (outcome.kind === 'superseded') {
      finish(null);
      return;
    }
    if (outcome.kind === 'reload') {
      // The server refused it before the action ran: the new build gets it.
      finish(null);
      submitNatively(form, submitter);
      return;
    }
    const result = resultOf(outcome, target);
    if (outcome.kind === 'loading') {
      if (outcome.download) {
        // The browser saves the file and this page stays.
        finish(result);
      } else {
        // The page is going away; stay pending so nothing is sent twice -
        // unless the back/forward cache brings it back.
        const restored = (event: PageTransitionEvent): void => {
          if (!event.persisted) return;
          window.removeEventListener('pageshow', restored);
          finish(result);
        };
        window.addEventListener('pageshow', restored);
      }
      (result.ok ? onSuccess : onError)?.(result);
      return;
    }
    finish(result);
    if (result.ok) {
      if (resetOnSuccess === true && form.isConnected) form.reset();
      onSuccess?.(result);
      return;
    }
    onError?.(result);
    if (outcome.kind === 'response') {
      // Refused unread: the browser may send it again to show the answer.
      // Anything else is never re-sent - the action may already have run.
      if (REFUSED_UNREAD.has(outcome.status)) submitNatively(form, submitter);
      return;
    }
    // A re-render with errors: start keyboard and screen-reader users at
    // the first field it marked invalid, unless the page moved focus itself.
    const active = document.activeElement;
    const focusKept = active === focusedAtSubmit || active === null || active === document.body;
    if (outcome.kind === 'shown' && form.isConnected && focusKept) {
      form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }
  }

  function handleSubmit(event: FormSubmitEvent): void {
    if (nativeRef.current) return;
    // A submit while one is in flight is dropped, before the app hears of it.
    if (pendingRef.current) {
      event.preventDefault();
      return;
    }
    onSubmit?.(event);
    if (event.defaultPrevented || reloadDocument === true) return;
    const form = event.currentTarget;
    const submitter = asSubmitter((event.nativeEvent as SubmitEvent).submitter);
    // Left to the browser: another target, a GET (or dialog) submission,
    // anything not posted to this origin.
    const target = override(form, submitter, 'target');
    if (target !== null && target !== '' && target !== '_self') return;
    if ((override(form, submitter, 'method') ?? 'get').toLowerCase() !== 'post') return;
    let url: URL;
    try {
      url = new URL(override(form, submitter, 'action') ?? '', window.location.href);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) return;
    event.preventDefault();
    const enctype = (override(form, submitter, 'enctype') ?? '').toLowerCase();
    void send(form, submitter, url, enctype);
  }

  const content = typeof children === 'function' ? children(state) : children;
  return (
    <FormStateContext.Provider value={state}>
      <form
        {...rest}
        ref={ref}
        method="post"
        action={action}
        aria-busy={state.pending ? true : rest['aria-busy']}
        onSubmit={handleSubmit}
      >
        {content}
      </form>
    </FormStateContext.Provider>
  );
});
