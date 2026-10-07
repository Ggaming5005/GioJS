/**
 * giojs-core/src/action.test.ts
 *
 * Page actions (action.ts + their dispatch in ssr.ts): a POST to a page runs
 * its `action` export, whose Response or redirect() is the answer and whose
 * data re-renders the page (actionData prop, ctx.actionData, the given
 * status) - never cacheable, whatever `revalidate` says. formData() parses
 * urlencoded and multipart bodies (files as File objects, binary bytes
 * intact) and answers 415/400 for bodies that are not forms. Pages without
 * an action keep answering mutations with 405 + Allow.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderRoute } from './ssr.ts';
import { actionOutcome, isActionRedirect, redirect, type ActionData, type ActionArgs } from './action.ts';
import { isMalformedBodyError, isUnsupportedMediaTypeError, parseFormData } from './request-body.ts';
import { NodePluginRegistry } from './plugin.ts';
import type { IPCRequest, IPCResponse } from './context.ts';
import type {
  GsspContext,
  HandlerEntry,
  LayoutEntry,
  PageModule,
  RouteHandlerFn,
  RouteModule,
} from './router.ts';

const noLayouts = new Map<string, LayoutEntry>();

function post(
  path: string,
  body: string | null,
  contentType = 'application/x-www-form-urlencoded',
  extra: Partial<IPCRequest> = {},
): IPCRequest {
  return {
    id: 'req-1',
    method: 'POST',
    path,
    params: {},
    query: {},
    headers: body === null ? {} : { 'content-type': contentType },
    body,
    bodyBase64: false,
    deploymentId: 'test-deploy',
    locale: 'en',
    ...extra,
  };
}

/** A page rendering its actionData as JSON (plus whatever `overrides` add). */
function routeWith(pattern: string, overrides: Partial<PageModule>): Map<string, RouteModule> {
  return new Map([
    [
      pattern,
      {
        filePath: '/fake/page.tsx',
        urlPattern: pattern,
        dir: pattern.slice(1),
        load: async (): Promise<PageModule> => ({
          default: function FormPage(props: Record<string, unknown>) {
            return React.createElement(
              'pre',
              { id: 'out' },
              JSON.stringify({ actionData: props['actionData'] ?? 'none', title: props['title'] ?? '' }),
            );
          },
          ...overrides,
        }),
      },
    ],
  ]);
}

async function send(
  req: IPCRequest,
  routes: Map<string, RouteModule>,
  extras: Parameters<typeof renderRoute>[6] = {},
  registry?: NodePluginRegistry,
): Promise<IPCResponse> {
  const result = await renderRoute(
    req,
    routes,
    noLayouts,
    registry,
    undefined,
    new Map([['/contact', '/_next/static/chunks/contact.js']]),
    extras,
  );
  if (!('status' in result)) throw new Error(`expected a buffered response, got ${JSON.stringify(result)}`);
  return result;
}

/** The `{ actionData, title }` the page printed. */
function printed(res: IPCResponse): { actionData: unknown; title: string } {
  const match = /<pre id="out">([^<]*)<\/pre>/.exec(res.body);
  if (match === null) throw new Error(`no page output in ${res.body}`);
  return JSON.parse(match[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as {
    actionData: unknown;
    title: string;
  };
}

/** The props the hydration envelope carries. */
function envelopeProps(res: IPCResponse): Record<string, unknown> {
  const match = /<script id="__gio_props" type="application\/json">(.*?)<\/script>/.exec(res.body);
  if (match === null) throw new Error('no envelope');
  return (JSON.parse(match[1]!) as { props: Record<string, unknown> }).props;
}

describe('redirect()', () => {
  it('defaults to 303 See Other and is recognized by its brand', () => {
    const r = redirect('/thanks');
    expect(r).toMatchObject({ location: '/thanks', status: 303 });
    expect(isActionRedirect(r)).toBe(true);
    expect(isActionRedirect({ location: '/x', status: 303 })).toBe(false);
    // Another copy of the module (app modules load in their own namespace).
    expect(isActionRedirect({ __gioRedirect: true, location: '/x', status: 303 })).toBe(true);
  });

  it('takes a status or { status, headers }', () => {
    expect(redirect('/a', 307).status).toBe(307);
    expect(redirect('/a', { status: 301, headers: { 'set-cookie': 'a=1' } })).toMatchObject({
      status: 301,
      headers: { 'set-cookie': 'a=1' },
    });
  });

  it('refuses non-redirect statuses, empty URLs and header injection', () => {
    expect(() => redirect('/a', 200)).toThrow(/301, 302, 303, 307 or 308/);
    expect(() => redirect('/a', 304)).toThrow(TypeError);
    expect(() => redirect('')).toThrow(/non-empty/);
    expect(() => redirect('/a\r\nset-cookie: x=1')).toThrow(/control characters/);
  });
});

describe('actionOutcome', () => {
  it('reads { status, data, headers } as the envelope and anything else as data', () => {
    expect(actionOutcome({ status: 422, data: { errors: { email: 'bad' } } })).toEqual({
      kind: 'render',
      status: 422,
      data: { errors: { email: 'bad' } },
    });
    expect(actionOutcome({ data: [1] })).toEqual({ kind: 'render', status: 200, data: [1] });
    // An extra key makes the whole object the data.
    expect(actionOutcome({ data: 1, ok: true })).toEqual({
      kind: 'render',
      status: 200,
      data: { data: 1, ok: true },
    });
    expect(actionOutcome({ saved: true })).toEqual({ kind: 'render', status: 200, data: { saved: true } });
    expect(actionOutcome(undefined)).toEqual({ kind: 'render', status: 200, data: null });
    expect(actionOutcome('done')).toEqual({ kind: 'render', status: 200, data: 'done' });
  });

  it('refuses statuses a re-rendered page cannot carry', () => {
    for (const status of [100, 204, 205, 301, 303, 304, 600, 200.5, '422']) {
      expect(() => actionOutcome({ status, data: null }), String(status)).toThrow(TypeError);
    }
    for (const status of [200, 201, 400, 409, 422, 500, 503]) {
      expect(actionOutcome({ status, data: null })).toMatchObject({ status });
    }
  });

  it('types actionData from the action', () => {
    async function action(req: ActionArgs<{ id: string }>) {
      if (req.params.id === 'r') return redirect('/');
      if (req.params.id === 'x') return new Response('raw');
      if (req.params.id === 'e') return { status: 422, data: { errors: { name: 'required' } } };
      return { saved: true as const };
    }
    const data: ActionData<typeof action> = { errors: { name: 'required' } };
    const other: ActionData<typeof action> = { saved: true };
    // @ts-expect-error - Responses and redirects never reach the page.
    const wrong: ActionData<typeof action> = new Response('raw');
    expect([data, other, wrong].length).toBe(3);
    const nothing: ActionData<() => Promise<void>> = null;
    expect(nothing).toBeNull();
  });
});

describe('parseFormData', () => {
  it('parses urlencoded fields, repeated names and UTF-8', async () => {
    const form = await parseFormData('a=1&b=%E2%9C%93&a=2&msg=hi+there', false, 'application/x-www-form-urlencoded; charset=UTF-8');
    expect(form.getAll('a')).toEqual(['1', '2']);
    expect(form.get('b')).toBe('✓');
    expect(form.get('msg')).toBe('hi there');
  });

  it('parses multipart fields and files as File objects', async () => {
    const boundary = '----gio-test';
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHello\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="doc"; filename="note.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\nfile contents\r\n--${boundary}--\r\n`;
    const form = await parseFormData(body, false, `multipart/form-data; boundary=${boundary}`);
    expect(form.get('title')).toBe('Hello');
    const file = form.get('doc');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('note.txt');
    expect((file as File).type).toBe('text/plain');
    expect(await (file as File).text()).toBe('file contents');
  });

  it('keeps binary file bytes that crossed the boundary as base64', async () => {
    const boundary = 'b';
    const bytes = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="img"; filename="x.bin"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n'),
      Buffer.from([0xff, 0x00, 0xfe, 0x80]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const form = await parseFormData(bytes.toString('base64'), true, `multipart/form-data; boundary=${boundary}`);
    const file = form.get('img') as File;
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0xff, 0x00, 0xfe, 0x80]);
  });

  it('reads an absent body as an empty form', async () => {
    expect([...(await parseFormData(null, false, 'multipart/form-data; boundary=x'))]).toEqual([]);
    expect([...(await parseFormData('', false, 'application/x-www-form-urlencoded'))]).toEqual([]);
  });

  it('refuses bodies not declared as forms (415) and broken ones (400)', async () => {
    for (const contentType of [undefined, 'application/json', 'text/plain', 'multipart/mixed; boundary=x']) {
      const err: unknown = await parseFormData('a=1', false, contentType).catch((e: unknown) => e);
      expect(isUnsupportedMediaTypeError(err), String(contentType)).toBe(true);
      expect((err as Error).message).toContain('multipart/form-data');
    }
    const broken: unknown = await parseFormData('garbage', false, 'multipart/form-data; boundary=x').catch(
      (e: unknown) => e,
    );
    expect(isMalformedBodyError(broken)).toBe(true);
  });
});

describe('page action dispatch', () => {
  it('answers 405 with Allow when the page exports no action', async () => {
    const res = await send(post('/contact', 'a=1'), routeWith('/contact', {}));
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET, HEAD');
  });

  it('runs only for POST: other mutations get a 405 naming POST', async () => {
    let calls = 0;
    const routes = routeWith('/contact', { action: () => { calls += 1; return null; } });
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await send({ ...post('/contact', 'a=1'), method }, routes);
      expect(res.status, method).toBe(405);
      expect(res.headers['allow']).toBe('GET, HEAD, POST');
    }
    expect(calls).toBe(0);
  });

  it('hands the action the request: form data, params, cookies, headers', async () => {
    let seen: { name: FormDataEntryValue | null; params: Record<string, string>; cookie: string | undefined } | null = null;
    const routes = new Map<string, RouteModule>([
      [
        '/posts/:id',
        {
          filePath: '/fake/page.tsx',
          urlPattern: '/posts/:id',
          dir: 'posts/[id]',
          load: async () => ({
            default: () => React.createElement('p', null, 'post'),
            action: async (req: ActionArgs) => {
              seen = {
                name: (await req.formData()).get('name'),
                params: req.params,
                cookie: req.cookies['sid'],
              };
              return null;
            },
          }),
        },
      ],
    ]);
    const req = post('/posts/7', 'name=Gio');
    req.headers['cookie'] = 'sid=abc';
    const res = await send(req, routes);
    expect(res.status).toBe(200);
    expect(seen).toEqual({ name: 'Gio', params: { id: '7' }, cookie: 'abc' });
  });

  it('sends a returned Response as is, binary bodies and cookies included', async () => {
    const headers = new Headers({ 'content-type': 'application/octet-stream' });
    headers.append('set-cookie', 'a=1');
    headers.append('set-cookie', 'b=2');
    const routes = routeWith('/contact', {
      action: () => new Response(new Uint8Array([0xff, 0x01]), { status: 201, headers }),
    });
    const res = await send(post('/contact', 'x=1'), routes);
    expect(res.status).toBe(201);
    expect(res.bodyBase64).toBe(true);
    expect(Buffer.from(res.body, 'base64')).toEqual(Buffer.from([0xff, 0x01]));
    expect(res.setCookies).toEqual(['a=1', 'b=2']);
    expect(res.cacheable).toBe(false);
  });

  it('answers redirect() with a 303 (or the given status) and its cookies', async () => {
    const routes = routeWith('/contact', {
      action: () => redirect('/thanks', { headers: { 'set-cookie': ['flash=sent; Path=/', 'x=1'] } }),
    });
    const res = await send(post('/contact', 'x=1'), routes);
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe('/thanks');
    expect(res.setCookies).toEqual(['flash=sent; Path=/', 'x=1']);
    expect(res.body).toBe('');
    expect(res.cacheable).toBe(false);

    const permanent = await send(post('/contact', 'x=1'), routeWith('/contact', { action: () => redirect('/new', 308) }));
    expect(permanent.status).toBe(308);
  });

  it('treats a thrown redirect() like a returned one', async () => {
    const routes = routeWith('/contact', {
      action: () => {
        throw redirect('/login');
      },
    });
    const res = await send(post('/contact', 'x=1'), routes);
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe('/login');
  });

  it('re-renders the page with plain data as actionData, status 200', async () => {
    const routes = routeWith('/contact', {
      action: async req => ({ received: (await req.formData()).get('msg') }),
    });
    const res = await send(post('/contact', 'msg=hello'), routes);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(printed(res).actionData).toEqual({ received: 'hello' });
    // The hydrated tree gets the same prop.
    expect(envelopeProps(res)['actionData']).toEqual({ received: 'hello' });
  });

  it('re-renders with { status: 422, data } and its headers', async () => {
    const routes = routeWith('/contact', {
      action: () => ({
        status: 422,
        data: { errors: { email: 'Enter a valid email' } },
        headers: { 'set-cookie': 'attempts=1', 'x-form': 'invalid' },
      }),
    });
    const res = await send(post('/contact', 'email=nope'), routes);
    expect(res.status).toBe(422);
    expect(printed(res).actionData).toEqual({ errors: { email: 'Enter a valid email' } });
    expect(res.setCookies).toEqual(['attempts=1']);
    expect(res.headers['x-form']).toBe('invalid');
  });

  it('gives getServerSideProps ctx.actionData and keeps an actionData prop it returns', async () => {
    const seen: unknown[] = [];
    const gssp = async (ctx: GsspContext) => {
      seen.push(ctx.actionData);
      return { props: { title: `method=${ctx.method}` } };
    };
    const routes = routeWith('/contact', { action: () => ({ ok: 1 }), getServerSideProps: gssp });
    const res = await send(post('/contact', 'x=1'), routes);
    expect(printed(res)).toEqual({ actionData: { ok: 1 }, title: 'method=POST' });

    const shaped = routeWith('/contact', {
      action: () => ({ ok: 1 }),
      getServerSideProps: async ctx => ({ props: { actionData: { shaped: ctx.actionData } } }),
    });
    expect(printed(await send(post('/contact', 'x=1'), shaped)).actionData).toEqual({ shaped: { ok: 1 } });

    // A GET never carries one.
    await send({ ...post('/contact', null), method: 'GET' }, routes);
    expect(seen).toEqual([{ ok: 1 }, undefined]);
  });

  it('never makes an action answer or its re-render cacheable', async () => {
    const routes = routeWith('/contact', { revalidate: 60, action: () => ({ ok: true }) });
    const rendered = await send(post('/contact', 'x=1'), routes);
    expect(rendered.cacheable).toBe(false);
    expect(rendered.cacheMaxAge).toBe(0);
    expect(rendered.status).toBe(200);
    // The same page's GET is still cached.
    const get = await send({ ...post('/contact', null), method: 'GET' }, routes);
    expect(get.cacheable).toBe(true);
    expect(get.cacheMaxAge).toBe(60);

    for (const action of [() => redirect('/x'), () => new Response('ok'), () => ({ status: 422, data: 1 })]) {
      const res = await send(post('/contact', 'x=1'), routeWith('/contact', { revalidate: false, action }));
      expect(res.cacheable).toBe(false);
      expect(res.cacheMaxAge).toBe(0);
    }
  });

  it('is never streamed, even where page renders stream', async () => {
    const routes = routeWith('/contact', { action: () => ({ ok: true }) });
    const result = await renderRoute(post('/contact', 'x=1'), routes, noLayouts, undefined, undefined, undefined, {
      streaming: true,
    });
    expect('type' in result).toBe(false);
  });

  it('answers 415 for a body formData() cannot read and 400 for a broken one', async () => {
    const routes = routeWith('/contact', { action: async req => ({ n: [...(await req.formData())].length }) });
    const json = await send(post('/contact', '{"a":1}', 'application/json'), routes);
    expect(json.status).toBe(415);
    expect(JSON.parse(json.body)).toMatchObject({ error: 'Unsupported Media Type' });
    const broken = await send(post('/contact', 'garbage', 'multipart/form-data; boundary=x'), routes);
    expect(broken.status).toBe(400);
    expect(JSON.parse(broken.body)).toMatchObject({ error: 'Bad Request' });
  });

  it('answers notFound() with a 404 and a throw with the error page', async () => {
    const notFoundErr = Object.assign(new Error('nf'), { [Symbol.for('gio.notFound')]: true });
    const missing = await send(post('/contact', 'x=1'), routeWith('/contact', { action: () => { throw notFoundErr; } }));
    expect(missing.status).toBe(404);

    const errorPage = {
      default: ({ error }: { error: { digest: string } }) => React.createElement('p', null, `failed ${error.digest}`),
    } as unknown as PageModule;
    const boom = await send(
      post('/contact', 'x=1'),
      routeWith('/contact', { action: () => { throw new Error('db down'); } }),
      { specialPages: { error: async () => errorPage } },
    );
    expect(boom.status).toBe(500);
    expect(boom.body).toContain('failed ');
    expect(boom.body).not.toContain('db down');
  });

  it('refuses action headers that are not header values', async () => {
    const routes = routeWith('/contact', {
      action: () => ({ data: 1, headers: { 'x-n': 5 } as unknown as Record<string, string> }),
    });
    const res = await renderRoute(post('/contact', 'x=1'), routes, noLayouts);
    expect('error' in res && res.error).toBe(true);
  });

  it('keeps the headers of an action whose re-render becomes a redirect, a 404 or an error page', async () => {
    const action = () => ({ data: { saved: true }, headers: { 'set-cookie': 'flash=1; Path=/', 'x-action': 'ran' } });
    const redirected = await send(
      post('/contact', 'x=1'),
      routeWith('/contact', {
        action,
        getServerSideProps: async ctx => (ctx.actionData ? { redirect: { destination: '/done' } } : { props: {} }),
      }),
    );
    expect(redirected.status).toBe(302);
    expect(redirected.headers['location']).toBe('/done');
    expect(redirected.setCookies).toEqual(['flash=1; Path=/']);
    expect(redirected.headers['x-action']).toBe('ran');

    const missing = await send(
      post('/contact', 'x=1'),
      routeWith('/contact', { action, getServerSideProps: async () => ({ notFound: true }) }),
    );
    expect(missing.status).toBe(404);
    expect(missing.setCookies).toEqual(['flash=1; Path=/']);

    const errorPage = { default: () => React.createElement('p', null, 'failed') } as unknown as PageModule;
    const failed = await send(
      post('/contact', 'x=1'),
      routeWith('/contact', {
        action,
        getServerSideProps: async () => {
          throw new Error('render broke');
        },
      }),
      { specialPages: { error: async () => errorPage } },
    );
    expect(failed.status).toBe(500);
    expect(failed.setCookies).toEqual(['flash=1; Path=/']);
    // The page's own content-type wins over nothing the action said.
    expect(failed.headers['content-type']).toContain('text/html');
  });

  it('runs onResponse plugins on the action answer', async () => {
    const registry = new NodePluginRegistry();
    registry.register({
      name: 'stamp',
      version: '1.0.0',
      onResponse: async (_req, res) => ({ ...res, headers: { ...res.headers, 'x-stamped': '1' } }),
    });
    const res = await send(post('/contact', 'x=1'), routeWith('/contact', { action: () => redirect('/') }), {}, registry);
    expect(res.headers['x-stamped']).toBe('1');
  });
});

describe('page actions next to a route.ts', () => {
  function handlers(pattern: string, methods: Record<string, RouteHandlerFn>): Map<string, HandlerEntry> {
    return new Map([[pattern, { filePath: '/fake/route.ts', urlPattern: pattern, methods: new Map(Object.entries(methods)) }]]);
  }

  it('gives route.ts handlers formData() too, with the same 415/400 answers', async () => {
    const routes = new Map<string, RouteModule>();
    const echo = handlers('/api/form', { POST: async req => Object.fromEntries(await req.formData()) });
    const ok = await send(post('/api/form', 'a=1&b=2'), routes, { handlers: echo });
    expect(JSON.parse(ok.body)).toEqual({ a: '1', b: '2' });
    expect((await send(post('/api/form', 'a', 'text/plain'), routes, { handlers: echo })).status).toBe(415);
    const broken = await send(post('/api/form', 'x', 'multipart/form-data; boundary=q'), routes, { handlers: echo });
    expect(broken.status).toBe(400);
  });

  it('lets the same-folder route.ts keep the POST it exports', async () => {
    const routes = routeWith('/contact', { action: () => ({ from: 'action' }) });
    const res = await send(post('/contact', 'x=1'), routes, {
      handlers: handlers('/contact', { POST: () => ({ from: 'route' }) }),
    });
    expect(JSON.parse(res.body)).toEqual({ from: 'route' });
  });

  it('passes a POST the route.ts does not export to the page action', async () => {
    const routes = routeWith('/contact', { action: () => ({ from: 'action' }) });
    const res = await send(post('/contact', 'x=1'), routes, {
      handlers: handlers('/contact', { DELETE: () => null }),
    });
    expect(res.status).toBe(200);
    expect(printed(res).actionData).toEqual({ from: 'action' });

    // Without an action, the 405 names the page's methods and the route.ts's.
    const none = await send(post('/contact', 'x=1'), routeWith('/contact', {}), {
      handlers: handlers('/contact', { DELETE: () => null }),
    });
    expect(none.status).toBe(405);
    expect(none.headers['allow']).toBe('GET, HEAD, DELETE');
  });

  it("answers other methods with a 405 listing both files' methods", async () => {
    const routes = routeWith('/contact', { action: () => null });
    const put = await send({ ...post('/contact', 'x=1'), method: 'PUT' }, routes, {
      handlers: handlers('/contact', { DELETE: () => null }),
    });
    expect(put.status).toBe(405);
    expect(put.headers['allow']).toBe('GET, HEAD, POST, DELETE');
    // A route.ts more specific than any page keeps its own 405.
    const api = await send({ ...post('/api/form', 'x=1'), method: 'PUT' }, new Map(), {
      handlers: handlers('/api/form', { POST: () => null }),
    });
    expect(api.headers['allow']).toBe('POST');
  });
});

describe('redirect() in getServerSideProps', () => {
  const get = (path: string): IPCRequest => ({ ...post(path, null), method: 'GET' });

  it('answers a returned redirect() like an action redirect', async () => {
    const res = await send(
      get('/contact'),
      routeWith('/contact', {
        getServerSideProps: async () => redirect('/login', { headers: { 'set-cookie': 'next=/contact; Path=/' } }),
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe('/login');
    expect(res.setCookies).toEqual(['next=/contact; Path=/']);
    expect(res.body).toBe('');
    expect(res.cacheable).toBe(false);
  });

  it('answers a thrown redirect() - from a shared helper - instead of failing the render', async () => {
    const requireUser = (cookies: Record<string, string>): string => {
      if (cookies['sid'] === undefined) throw redirect('/login', 307);
      return cookies['sid'];
    };
    const routes = routeWith('/contact', {
      revalidate: 60,
      getServerSideProps: async ctx => ({ props: { title: requireUser(ctx.cookies) } }),
    });
    const res = await send(get('/contact'), routes);
    expect(res.status).toBe(307);
    expect(res.headers['location']).toBe('/login');
    expect(res.cacheable).toBe(false);

    const signedIn = get('/contact');
    signedIn.headers['cookie'] = 'sid=ada';
    expect(printed(await send(signedIn, routes)).title).toBe('ada');
  });
});

describe('redirects answering a GioForm submission', () => {
  const formPost = (path: string, body: string): IPCRequest => {
    const req = post(path, body);
    req.headers['x-gio-form'] = '1';
    return req;
  };

  it('name the target in x-gio-redirect on a 204, cookies kept, instead of a 3xx fetch would follow', async () => {
    const routes = routeWith('/checkout', {
      action: () =>
        redirect('https://pay.example/session/1', { headers: { 'set-cookie': 'order=1; Path=/', 'x-order': '1' } }),
    });
    const res = await send(formPost('/checkout', 'x=1'), routes);
    expect(res.status).toBe(204);
    expect(res.headers['x-gio-redirect']).toBe('https://pay.example/session/1');
    expect(res.headers['location']).toBeUndefined();
    expect(res.headers['x-order']).toBe('1');
    expect(res.setCookies).toEqual(['order=1; Path=/']);
    expect(res.body).toBe('');
    expect(res.cacheable).toBe(false);

    // A plain form post (no JavaScript) gets the real 303.
    const plain = await send(post('/checkout', 'x=1'), routes);
    expect(plain.status).toBe(303);
    expect(plain.headers['location']).toBe('https://pay.example/session/1');
  });

  it('covers redirect Responses, getServerSideProps redirects and route.ts handlers too', async () => {
    const asResponse = await send(
      formPost('/contact', 'x=1'),
      routeWith('/contact', { action: () => Response.redirect('https://idp.example/authorize', 302) }),
    );
    expect(asResponse.status).toBe(204);
    expect(asResponse.headers['x-gio-redirect']).toBe('https://idp.example/authorize');
    expect(asResponse.bodyBase64).toBeUndefined();

    const fromGssp = await send(
      formPost('/contact', 'x=1'),
      routeWith('/contact', {
        action: () => ({ saved: true }),
        getServerSideProps: async () => ({ redirect: { destination: '/done', permanent: false } }),
      }),
    );
    expect(fromGssp.status).toBe(204);
    expect(fromGssp.headers['x-gio-redirect']).toBe('/done');

    const handlerRoutes = new Map<string, RouteModule>();
    const fromHandler = await send(formPost('/api/subscribe', 'x=1'), handlerRoutes, {
      handlers: new Map([
        [
          '/api/subscribe',
          {
            filePath: '/fake/route.ts',
            urlPattern: '/api/subscribe',
            methods: new Map<string, RouteHandlerFn>([['POST', () => Response.redirect('https://example.com/ok', 303)]]),
          },
        ],
      ]),
    });
    expect(fromHandler.status).toBe(204);
    expect(fromHandler.headers['x-gio-redirect']).toBe('https://example.com/ok');
  });

  it('leave 307/308 (they repeat the POST) and every other answer alone', async () => {
    const repost = await send(formPost('/contact', 'x=1'), routeWith('/contact', { action: () => redirect('/v2', 307) }));
    expect(repost.status).toBe(307);
    expect(repost.headers['location']).toBe('/v2');

    const invalid = await send(
      formPost('/contact', 'x=1'),
      routeWith('/contact', { action: () => ({ status: 422, data: { error: 'bad' } }) }),
    );
    expect(invalid.status).toBe(422);
    expect(printed(invalid).actionData).toEqual({ error: 'bad' });
  });
});
