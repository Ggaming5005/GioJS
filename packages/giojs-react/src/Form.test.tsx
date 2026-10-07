// @vitest-environment jsdom
/**
 * packages/giojs-react/src/Form.test.tsx
 *
 * <GioForm> against jsdom with a mocked fetch: server rendering yields a
 * plain `<form method="post">` that works without JavaScript; a hydrated
 * submit posts the fields (submitter included, multipart when asked) and is
 * pending until the answer is shown - a redirect's target pushed under its
 * own URL, an action's re-render (422 + actionData) swapped in place. A
 * second submit while pending is ignored. Answers the router cannot render
 * fall back to a native submission, except a 2xx (never sent twice) and a
 * network failure (reported, form kept). Submissions it must not touch
 * (GET, other targets, other origins, reloadDocument) stay native.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';

// @ts-expect-error React 19 act() environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type FormModule = typeof import('./Form.tsx');

const listeners: Array<[string, EventListenerOrEventListenerObject]> = [];
const realAddEventListener = window.addEventListener.bind(window);

let mod: FormModule;
let container: HTMLDivElement;
let root: Root;
let assigned: string[];
let nativeSubmits: Array<HTMLElement | null>;

interface FetchCall {
  url: string;
  init: RequestInit;
}

function pageResponse(opts: {
  main: string;
  status?: number;
  url?: string;
  actionData?: unknown;
  title?: string;
}): Response {
  const envelope = JSON.stringify({
    props: opts.actionData === undefined ? {} : { actionData: opts.actionData },
    path: '/contact',
    pattern: '/contact',
    entry: '',
  });
  const html =
    `<!DOCTYPE html><html><head><title>${opts.title ?? 'Contact'}</title></head><body>` +
    `<div id="__gio"><main>${opts.main}</main></div>` +
    `<script id="__gio_props" type="application/json">${envelope}</script></body></html>`;
  const res = new Response(html, {
    status: opts.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
  if (opts.url !== undefined) {
    Object.defineProperty(res, 'url', { value: new URL(opts.url, window.location.href).href });
    Object.defineProperty(res, 'redirected', { value: true });
  }
  return res;
}

/** fetch answering POSTs with `answer`; resolves only when `gate` does, if given. */
function serve(answer: () => Response | Promise<Response>, gate?: Promise<void>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      if (gate !== undefined) await gate;
      return answer();
    }),
  );
  return calls;
}

/** Lets the submission's fetch + render chain finish. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
  });
}

function render(element: React.ReactElement): HTMLFormElement {
  act(() => root.render(element));
  const form = container.querySelector('form');
  if (form === null) throw new Error('GioForm rendered no form');
  return form;
}

/** Click a submit button: jsdom fires the submit event with it as submitter. */
function click(selector: string): void {
  const button = container.querySelector<HTMLElement>(selector);
  if (button === null) throw new Error(`no ${selector}`);
  act(() => button.click());
}

const mainText = (): string | null => document.querySelector('#__gio main')?.textContent ?? null;

/**
 * A client runtime keeping everything in #__gio but its <main> - where the
 * page's own content is. The form's React root lives outside, as a form
 * kept by the persistent root would.
 */
function installRuntime(): void {
  (window as unknown as Record<string, unknown>)['__GIO_RUNTIME__'] = {
    prepare: async () => undefined,
    commit: (content: Element | null) => {
      const next = content?.querySelector('main');
      if (next) document.querySelector('#__gio main')?.replaceWith(document.importNode(next, true));
    },
  };
}

beforeEach(async () => {
  vi.spyOn(window, 'addEventListener').mockImplementation(((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    listeners.push([type, listener]);
    realAddEventListener(type, listener, options);
  }) as typeof window.addEventListener);
  history.replaceState(null, '', '/contact');
  document.body.innerHTML = '<div id="__gio"><main>form page</main></div>';
  container = document.createElement('div');
  document.body.appendChild(container);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  assigned = [];
  nativeSubmits = [];
  const realLocation = window.location;
  vi.stubGlobal('location', {
    get href() { return realLocation.href; },
    get origin() { return realLocation.origin; },
    get protocol() { return realLocation.protocol; },
    get pathname() { return realLocation.pathname; },
    get search() { return realLocation.search; },
    get hash() { return realLocation.hash; },
    assign: (url: string) => assigned.push(url),
    replace: (url: string) => assigned.push(`replace:${url}`),
    reload: () => assigned.push('reload'),
  });
  // jsdom implements no form navigation: record native submissions.
  vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(function (
    this: HTMLFormElement,
    submitter?: HTMLElement | null,
  ) {
    nativeSubmits.push(submitter ?? null);
  });
  installRuntime();
  vi.resetModules();
  mod = await import('./Form.tsx');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  window.dispatchEvent(new Event('pagehide'));
  for (const [type, listener] of listeners.splice(0)) window.removeEventListener(type, listener);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>)['__GIO_RUNTIME__'];
});

function Status(): React.JSX.Element {
  const { pending, lastResult } = mod.useGioFormState();
  return (
    <output>
      {pending ? 'pending' : 'idle'}:{lastResult === null ? 'none' : `${lastResult.status}:${JSON.stringify(lastResult.data ?? null)}`}
    </output>
  );
}

const statusText = (): string | null => container.querySelector('output')?.textContent ?? null;

describe('GioForm server rendering', () => {
  it('renders a real form posting to the page itself, no JavaScript needed', async () => {
    const { GioForm } = await import('./Form.tsx');
    const html = renderToString(
      <GioForm className="c" encType="multipart/form-data">
        <input name="email" />
        <button type="submit">Send</button>
      </GioForm>,
    );
    expect(html).toMatch(/^<form class="c" enctype="multipart\/form-data" method="post">/i);
    // No action attribute: the browser posts to the document's own URL.
    expect(html).not.toContain('action=');
    expect(html).toContain('<input name="email"/>');

    const elsewhere = renderToString(<GioForm action="/api/subscribe">x</GioForm>);
    expect(elsewhere).toContain('action="/api/subscribe"');
  });

  it('renders function children with the idle state', async () => {
    const { GioForm } = await import('./Form.tsx');
    const html = renderToString(<GioForm>{({ pending }) => (pending ? 'busy' : 'ready')}</GioForm>);
    expect(html).toContain('ready');
  });
});

describe('GioForm submission', () => {
  it('posts the fields and submitter, is pending, then follows a redirect with the router', async () => {
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    const calls = serve(() => pageResponse({ main: 'thanks page', url: '/thanks', title: 'Thanks' }), gate);
    const onSuccess = vi.fn();
    render(
      <mod.GioForm onSuccess={onSuccess}>
        <input name="email" defaultValue="a@b.c" />
        <button type="submit" name="intent" value="subscribe">Go</button>
        <Status />
      </mod.GioForm>,
    );
    click('button');
    expect(statusText()).toBe('pending:none');
    expect(container.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/contact');
    expect(calls[0]?.init.method).toBe('POST');
    const body = calls[0]?.init.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).toString()).toBe('email=a%40b.c&intent=subscribe');

    open();
    await settle();
    expect(window.location.pathname).toBe('/thanks');
    expect(mainText()).toBe('thanks page');
    expect(document.title).toBe('Thanks');
    expect(statusText()).toBe('idle:200:null');
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, status: 200, redirected: true, url: '/thanks' }),
    );
    expect(nativeSubmits).toEqual([]);
  });

  it('swaps in the re-rendered page with its actionData, keeping the URL and the form', async () => {
    serve(() => pageResponse({ main: 'Email is required', status: 422, actionData: { errors: { email: 'required' } } }));
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const form = render(
      <mod.GioForm onError={onError} onSuccess={onSuccess}>
        <input name="email" aria-invalid="true" />
        <button type="submit">Go</button>
        <Status />
      </mod.GioForm>,
    );
    const input = form.querySelector('input');
    if (input === null) throw new Error('no input');
    input.value = 'typed';
    const push = vi.spyOn(history, 'pushState');
    // Browsers focus the clicked button.
    container.querySelector('button')?.focus();
    click('button');
    await settle();
    expect(mainText()).toBe('Email is required');
    expect(window.location.pathname).toBe('/contact');
    expect(push).not.toHaveBeenCalled();
    expect(statusText()).toBe('idle:422:{"errors":{"email":"required"}}');
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, status: 422, data: { errors: { email: 'required' } } }),
    );
    expect(onSuccess).not.toHaveBeenCalled();
    // The form (and what was typed) survived; focus went to the invalid field.
    expect(container.querySelector('input')).toBe(input);
    expect(input.value).toBe('typed');
    expect(document.activeElement).toBe(input);
    expect(nativeSubmits).toEqual([]);
  });

  it('ignores a second submit while the first is pending', async () => {
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    const calls = serve(() => pageResponse({ main: 'saved', actionData: { saved: true } }), gate);
    render(
      <mod.GioForm>
        <button type="submit">Go</button>
      </mod.GioForm>,
    );
    click('button');
    click('button');
    click('button');
    expect(calls).toHaveLength(1);
    open();
    await settle();
    click('button');
    await settle();
    expect(calls).toHaveLength(2);
  });

  it('falls back to a native submission for an error answer that is not a page', async () => {
    serve(() => new Response('413 Payload Too Large', { status: 413, headers: { 'content-type': 'text/plain' } }));
    const onError = vi.fn();
    render(
      <mod.GioForm onError={onError} encType="multipart/form-data">
        <button type="submit" name="intent" value="upload">Go</button>
      </mod.GioForm>,
    );
    click('button');
    await settle();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ ok: false, status: 413 }));
    expect(nativeSubmits).toHaveLength(1);
    expect(nativeSubmits[0]).toBe(container.querySelector('button'));
    expect(mainText()).toBe('form page');
  });

  it('never re-sends a 2xx answer that is not a page: onSuccess gets the response', async () => {
    serve(() => Response.json({ id: 7 }, { status: 201 }));
    const onSuccess = vi.fn();
    render(
      <mod.GioForm onSuccess={onSuccess}>
        <button type="submit">Go</button>
        <Status />
      </mod.GioForm>,
    );
    click('button');
    await settle();
    expect(nativeSubmits).toEqual([]);
    expect(assigned).toEqual([]);
    const result = onSuccess.mock.calls[0]?.[0] as { status: number; response: Response };
    expect(result.status).toBe(201);
    expect(await result.response.json()).toEqual({ id: 7 });
    expect(statusText()).toBe('idle:201:null');
  });

  it('reports a network failure and keeps the form as it is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const onError = vi.fn();
    render(
      <mod.GioForm onError={onError}>
        <button type="submit">Go</button>
        <Status />
      </mod.GioForm>,
    );
    click('button');
    await settle();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ ok: false, status: 0, error: expect.any(TypeError) }));
    expect(nativeSubmits).toEqual([]);
    expect(assigned).toEqual([]);
    expect(statusText()).toBe('idle:0:null');
  });

  it('resubmits natively on deployment skew (refused before the action ran)', async () => {
    serve(() => new Response(null, { status: 409, headers: { 'x-gio-action': 'hard-reload' } }));
    render(
      <mod.GioForm>
        <button type="submit">Go</button>
      </mod.GioForm>,
    );
    click('button');
    await settle();
    expect(nativeSubmits).toHaveLength(1);
  });

  it('loads a redirect target the router cannot render', async () => {
    serve(() => {
      const res = new Response('{}', { headers: { 'content-type': 'application/json' } });
      Object.defineProperty(res, 'url', { value: new URL('/api/done', window.location.href).href });
      Object.defineProperty(res, 'redirected', { value: true });
      return res;
    });
    render(
      <mod.GioForm>
        <button type="submit">Go</button>
        <Status />
      </mod.GioForm>,
    );
    click('button');
    await settle();
    expect(assigned).toEqual(['/api/done']);
    expect(nativeSubmits).toEqual([]);
    // The page is going away: it stays pending, so nothing is sent twice.
    expect(statusText()).toBe('pending:none');
  });

  it('sends multipart FormData (files included) when the enctype asks for it', async () => {
    const calls = serve(() => pageResponse({ main: 'uploaded' }));
    const form = render(
      <mod.GioForm encType="multipart/form-data" action="/upload?x=1">
        <input type="file" name="doc" />
        <input name="title" defaultValue="Report" />
        <button type="submit">Go</button>
      </mod.GioForm>,
    );
    const fileInput = form.querySelector<HTMLInputElement>('input[type=file]');
    if (fileInput === null) throw new Error('no file input');
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    Object.defineProperty(fileInput, 'files', { value: [file] });
    click('button');
    await settle();
    expect(calls[0]?.url).toBe('/upload?x=1');
    const body = calls[0]?.init.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('title')).toBe('Report');
  });

  it('honors the submitter formaction and resets after success when asked', async () => {
    const calls = serve(() => pageResponse({ main: 'deleted', actionData: { ok: true } }));
    const form = render(
      <mod.GioForm resetOnSuccess>
        <input name="note" />
        <button type="submit" formAction="/notes/delete">Delete</button>
      </mod.GioForm>,
    );
    const input = form.querySelector('input');
    if (input === null) throw new Error('no input');
    input.value = 'typed';
    click('button');
    await settle();
    expect(calls[0]?.url).toBe('/notes/delete');
    expect(input.value).toBe('');
  });

  it('leaves GET forms, other targets, other origins and reloadDocument to the browser', async () => {
    const calls = serve(() => pageResponse({ main: 'x' }));
    const cases: React.ReactElement[] = [
      <mod.GioForm key="get"><button type="submit" formMethod="get">Go</button></mod.GioForm>,
      <mod.GioForm key="target" target="_blank"><button type="submit">Go</button></mod.GioForm>,
      <mod.GioForm key="origin" action="https://elsewhere.example/hook"><button type="submit">Go</button></mod.GioForm>,
      <mod.GioForm key="reload" reloadDocument><button type="submit">Go</button></mod.GioForm>,
    ];
    for (const element of cases) {
      render(element);
      let prevented: boolean | null = null;
      // Runs after React's handler (a root listener): records whether it
      // took the submission over, then stops jsdom's unimplemented navigation.
      const spy = (e: Event): void => {
        prevented = e.defaultPrevented;
        e.preventDefault();
      };
      realAddEventListener('submit', spy);
      click('button');
      window.removeEventListener('submit', spy);
      expect(calls, String(element.key)).toHaveLength(0);
      expect(prevented, String(element.key)).toBe(false);
    }
  });

  it('drops pages prefetched before the mutation', async () => {
    const nav = await import('./navigation.ts');
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      fetched.push(`${init.method ?? 'GET'} ${String(input)}`);
      return pageResponse({ main: String(input) });
    }));
    nav.prefetch('/inbox');
    await settle();
    render(
      <mod.GioForm>
        <button type="submit">Go</button>
      </mod.GioForm>,
    );
    click('button');
    await settle();
    await act(() => nav.navigate('/inbox'));
    // The prefetched /inbox predates the POST: the navigation fetches it again.
    expect(fetched).toEqual(['GET /inbox', 'POST /contact', 'GET /inbox']);
  });

  it("lets the app's onSubmit cancel the submission", async () => {
    const calls = serve(() => pageResponse({ main: 'x' }));
    render(
      <mod.GioForm onSubmit={e => e.preventDefault()}>
        <button type="submit">Go</button>
      </mod.GioForm>,
    );
    click('button');
    await settle();
    expect(calls).toHaveLength(0);
  });
});

describe('useGioFormState', () => {
  it('is idle outside a GioForm', () => {
    render(<form><Status /></form>);
    expect(statusText()).toBe('idle:none');
  });
});
