import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'TypeScript',
  description:
    'Set up TypeScript in a GioJS app, type routes from your own folders with .gio/routes.d.ts, and find every type @gio.js/core and @gio.js/react export.',
};

export const revalidate = false;

interface TypeRow {
  name: string;
  description: React.ReactNode;
}

/** One table of exported types; `name` is shown as code. */
function TypeTable({ rows }: { rows: TypeRow[] }): React.JSX.Element {
  return (
    <table className="ref-table">
      <thead>
        <tr><th>Type</th><th>Description</th></tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name}>
            <td><code>{row.name}</code></td>
            <td>{row.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>TypeScript</h1>
      <p className="page-subtitle">
        Set up TypeScript in a GioJS app, type routes from your own folders with{' '}
        <code>.gio/routes.d.ts</code>, and find every type <code>@gio.js/core</code> and{' '}
        <code>@gio.js/react</code> export.
      </p>
      <CodeBlock lang="tsx" title="app/posts/[id]/page.tsx" code={`import type { PageProps } from '@gio.js/core';

export default function Post({ params }: PageProps<'/posts/:id'>) {
  return <h1>Post {params.id}</h1>; // params: { id: string }
}`} />
      <p>
        GioJS runs TypeScript as is: the worker loads <code>.ts</code> and{' '}
        <code>.tsx</code> through <code>tsx</code> and bundles client code with esbuild, so
        there is no compile step and type errors never stop the server. Checking types is
        the job of <code>tsc --noEmit</code>, in your editor and in CI.
      </p>

      <h2 id="tsconfig">tsconfig.json</h2>
      <p>The TypeScript starter ships this file:</p>
      <CodeBlock lang="json" title="tsconfig.json" code={`{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["app", "components", ".gio/routes.d.ts"]
}`} />
      <ul>
        <li>
          <code>&quot;.gio/routes.d.ts&quot;</code> in <code>include</code> turns on{' '}
          <a href="#typed-routes">typed routes</a> and the types of CSS imports.{' '}
          <code>gio doctor</code> warns when it is missing.
        </li>
        <li>
          <code>moduleResolution: &quot;Bundler&quot;</code> matches how esbuild resolves
          imports, and lets TypeScript read the packages&apos; <code>exports</code> maps
          (<code>@gio.js/core/testing</code>, <code>@gio.js/core/server-only</code>).
        </li>
        <li>
          <code>paths</code> and <code>jsx</code> settings are honored when bundling too: the
          client and standalone bundles use the project&apos;s <code>tsconfig.json</code>{' '}
          (or <code>jsconfig.json</code>).
        </li>
      </ul>
      <p>
        Add a script so CI checks types. Run <code>gio typegen</code> first so the route
        types exist on a fresh checkout:
      </p>
      <CodeBlock lang="json" title="package.json" code={`{
  "scripts": {
    "typecheck": "gio typegen && tsc --noEmit"
  }
}`} />
      <p>
        The JavaScript starter (<code>create-giojs --js</code>) uses a{' '}
        <code>jsconfig.json</code> with <code>checkJs: false</code> and types its exports
        through JSDoc: <code>/** @type {'{'}import(&apos;@gio.js/core&apos;).GetServerSideProps&lt;{'{'} post: Post {'}'}, &apos;/posts/:id&apos;&gt;{'}'} */</code>.
      </p>

      <h2 id="typed-routes">Typed routes</h2>
      <p>
        GioJS writes <code>.gio/routes.d.ts</code> from your <code>app/</code> folder: one
        entry per page and <code>route.ts</code>, keyed by its route pattern, in the global{' '}
        <code>GioJS.RegisteredRoutes</code> interface. <code>href()</code>,{' '}
        <code>useParams()</code> and every route-typed type of <code>@gio.js/core</code> read
        it, so a pattern that is not one of your routes fails <code>tsc</code>, editors
        autocomplete patterns, and params need no annotations.
      </p>
      <CodeBlock lang="ts" title=".gio/routes.d.ts" code={`/// <reference path="./css-modules.d.ts" />
declare global {
  namespace GioJS {
    interface RegisteredRoutes {
      '/': Record<string, never>;
      '/api/posts/:id': { id: string };
      '/blog/:slug': { slug: string };
      '/docs/*slug': { slug: string };
      '/shop/*path?': { path?: string };
    }
  }
}
export {};`} />
      <p>
        The file is rewritten at every server start (<code>gio dev</code> restarts on file
        changes, so it stays current) and by <code>gio typegen</code>, which needs no server
        and no secrets: a <code>route.ts</code> that fails to import is still typed. It is
        generated output; keep <code>.gio/</code> out of git.
      </p>

      <h3 id="route-patterns">Route patterns</h3>
      <table>
        <thead>
          <tr><th>Folder</th><th>Pattern</th><th>Params</th></tr>
        </thead>
        <tbody>
          <tr><td><code>app/blog/[slug]/</code></td><td><code>/blog/:slug</code></td><td><code>{'{ slug: string }'}</code></td></tr>
          <tr><td><code>app/docs/[...slug]/</code></td><td><code>/docs/*slug</code></td><td><code>{'{ slug: string }'}</code> - one string, <code>&apos;a/b&apos;</code></td></tr>
          <tr><td><code>app/shop/[[...path]]/</code></td><td><code>/shop/*path?</code></td><td><code>{'{ path?: string }'}</code> - <code>&apos;&apos;</code> at runtime for <code>/shop</code></td></tr>
          <tr><td><code>app/(marketing)/about/</code></td><td><code>/about</code></td><td><code>Record&lt;string, never&gt;</code></td></tr>
        </tbody>
      </table>

      <h3 id="href">href</h3>
      <p>
        <code>href(pattern, params)</code> from <code>@gio.js/react</code> builds a URL from
        a registered pattern, encoding each param (a catch-all keeps its slashes). Static
        routes take no second argument, and an optional catch-all may leave it out:
      </p>
      <CodeBlock lang="ts" code={`import { href } from '@gio.js/react';

href('/blog/:slug', { slug: 'hello world' }); // '/blog/hello%20world'
href('/docs/*slug', { slug: 'a/b c' });       // '/docs/a/b%20c'
href('/shop/*path?');                         // '/shop'
href('/blgo/:slug', { slug: 'x' });           // tsc: not assignable to '/' | '/blog/:slug' | ...`} />

      <h3 id="paramsof">ParamsOf, RouteParamsOf, ParamsFromPattern, StaticParamsOf</h3>
      <p>
        Every route-typed generic of <code>@gio.js/core</code> (<code>PageProps</code>,{' '}
        <code>GetServerSideProps</code>, <code>GsspContext</code>, <code>RouteHandler</code>,{' '}
        <code>GioRequest</code>, <code>ActionArgs</code>, <code>GenerateMetadata</code>,{' '}
        <code>GetStaticPaths</code>) takes a <code>RouteOrParams</code>: a pattern
        (<code>&apos;/blog/:slug&apos;</code>) or a params shape (<code>{'{ slug: string }'}</code>).
        These helpers do the resolving and are exported for your own generics:
      </p>
      <TypeTable rows={[
        { name: 'RoutePattern', description: <>The registered patterns once <code>.gio/routes.d.ts</code> is included, any <code>string</code> before that.</> },
        { name: 'RouteOrParams', description: <>What the route-typed generics accept: <code>RoutePattern | object</code>.</> },
        { name: 'ParamsOf<Route>', description: <>The params of a pattern or, given a params shape, that shape.</> },
        { name: 'RouteParamsOf<Pattern>', description: <>From the registry when the pattern is registered, else parsed from the pattern.</> },
        { name: 'ParamsFromPattern<Pattern>', description: <>Params parsed from the pattern string alone: <code>:name</code> and <code>*name</code> are strings, <code>*name?</code> is optional.</> },
        { name: 'StaticParamsOf<Route>', description: <>The params of one <code>getStaticPaths</code> entry: like <code>ParamsOf</code>, but a catch-all may also be an array of segments.</> },
      ]} />
      <p>
        Before <code>.gio/routes.d.ts</code> exists, these accept any pattern and parse its
        params from the string, so the <code>@gio.js/core</code> types work on a fresh
        checkout. <code>href()</code> and <code>useParams&lt;pattern&gt;()</code> need the
        registry: without it, <code>href(&apos;/blog/:slug&apos;, {'{ slug }'})</code> fails
        with <code>Expected 1 arguments, but got 2</code>.
      </p>

      <h3 id="gioregisteredroutes">GioRegisteredRoutes</h3>
      <p>
        <code>@gio.js/react</code>&apos;s <code>GioRegisteredRoutes</code> extends{' '}
        <code>GioJS.RegisteredRoutes</code>. Routes you added to it by hand still type{' '}
        <code>href()</code>, but not the <code>@gio.js/core</code> types; declare extra
        routes on the global registry instead:
      </p>
      <CodeBlock lang="ts" title="types/routes.d.ts" code={`declare global {
  namespace GioJS {
    interface RegisteredRoutes {
      '/legacy/:id': { id: string };
    }
  }
}
export {};`} />

      <h3 id="css-module-types">CSS Module types</h3>
      <p>
        <code>.gio/routes.d.ts</code> references <code>.gio/css-modules.d.ts</code>, which
        types <code>import styles from &apos;./card.module.css&apos;</code> as{' '}
        <code>{'{ readonly [className: string]: string }'}</code> and a plain{' '}
        <code>import &apos;./globals.css&apos;</code> as a side-effect import. No setup beyond
        the <code>include</code> entry.
      </p>

      <h2 id="reference">Reference</h2>
      <p>
        Every type in these tables is a type-only export: import it with{' '}
        <code>import type</code>. The packages ship declaration files, so{' '}
        <code>tsc --noEmit</code> checks against them without compiling the framework.{' '}
        <code>@gio.js/core</code> also exports three classes, values you can use as types
        too: <a href="/docs/functions/gio-event-stream"><code>GioEventStream</code></a>, and
        the <a href="/docs/functions/request-errors"><code>MalformedBodyError</code> and{' '}
        <code>UnsupportedMediaTypeError</code></a> that <code>req.formData()</code> and{' '}
        <code>req.json()</code> throw.
      </p>

      <h3 id="pages-and-layouts">Pages and layouts</h3>
      <TypeTable rows={[
        { name: 'PageProps<Route>', description: <>Props of a page without <code>getServerSideProps</code>: <code>params</code> and <code>searchParams</code>.</> },
        { name: 'LayoutProps', description: <><code>children</code>, and <code>path</code>: the page&apos;s path without query.</> },
        { name: 'ErrorPageProps', description: <>Props of <code>error.tsx</code>: <code>{'{ error: { message, digest? }, reset? }'}</code>. Same as <code>GioErrorProps</code>.</> },
        { name: 'GioErrorProps, GioErrorInfo', description: <>The error boundary&apos;s props and its <code>error</code>; <code>message</code> is <code>Internal Server Error</code> in production.</> },
        { name: 'NotFoundPageProps', description: <><code>not-found.tsx</code> renders with no props.</> },
      ]} />

      <h3 id="data-fetching">Data fetching</h3>
      <TypeTable rows={[
        { name: 'GetServerSideProps<Props, Route>', description: <>A page&apos;s <code>getServerSideProps</code>; types <code>ctx.params</code> and the result.</> },
        { name: 'GetServerSidePropsContext<Route>, GsspContext<Route>', description: <>Its context: <code>method</code>, <code>path</code>, <code>params</code>, <code>query</code>, <code>headers</code>, <code>cookies</code>, <code>locale</code>, <code>ip</code>, <code>scheme</code>, <code>host</code>, <code>requestId</code>, <code>actionData</code>.</> },
        { name: 'GetServerSidePropsResult<Props>', description: <><code>PropsResult | RedirectResult | NotFoundResult | ActionRedirect</code>.</> },
        { name: 'PropsResult<Props>', description: <><code>{'{ props, headers?, tags? }'}</code>.</> },
        { name: 'RedirectResult', description: <><code>{'{ redirect: { destination, permanent }, headers? }'}</code>.</> },
        { name: 'NotFoundResult', description: <><code>{'{ notFound: true }'}</code>, same as calling <code>notFound()</code>.</> },
        { name: 'GsspResponseHeaders', description: <><code>Record&lt;string, string | string[]&gt;</code>; an array sends one header per value (<code>set-cookie</code>).</> },
        { name: 'InferPageProps<typeof getServerSideProps>', description: <>The props the page renders with, read off its <code>getServerSideProps</code>.</> },
        { name: 'GetStaticPaths<Route>, StaticPathsResult<Route>', description: <><code>getStaticPaths</code> for <code>gio export</code>: <code>{'{ paths: [{ params }] }'}</code>.</> },
      ]} />

      <h3 id="actions-and-forms">Actions and forms</h3>
      <TypeTable rows={[
        { name: 'ActionArgs<Route>', description: <>A page action&apos;s request: the route-handler request with typed <code>params</code>.</> },
        { name: 'ActionResult<Data>', description: <>What an action may return: a <code>Response</code>, <code>redirect()</code>, <code>{'{ status, data, headers }'}</code>, plain data or nothing.</> },
        { name: 'ActionDataResult<Data>', description: <>The <code>{'{ status?, data, headers? }'}</code> form.</> },
        { name: 'ActionData<typeof action>', description: <>The <code>actionData</code> the page receives (responses and redirects left out, nothing becomes <code>null</code>).</> },
        { name: 'WithActionData<typeof action, Props>', description: <><code>Props</code> plus an optional <code>actionData</code>.</> },
        { name: 'PageAction', description: <>The type of a page module&apos;s <code>action</code> export.</> },
        { name: 'ActionRedirect, RedirectInit', description: <>What <code>redirect(url, init)</code> returns, and its second argument (<code>status</code>, <code>headers</code>).</> },
        { name: 'GioFormProps, GioFormResult, GioFormState', description: <>From <code>@gio.js/react</code>: the <code>&lt;GioForm&gt;</code> props, the result its callbacks get, and <code>useGioFormState()</code>&apos;s <code>{'{ pending, lastResult }'}</code>.</> },
      ]} />

      <h3 id="route-handlers-and-realtime">Route handlers and realtime</h3>
      <TypeTable rows={[
        { name: 'RouteHandler<Route>', description: <>A <code>route.ts</code> method handler: <code>(req: GioRequest&lt;Route&gt;) =&gt; unknown</code>.</> },
        { name: 'RouteHandlerFn', description: <>The untyped form the router calls.</> },
        { name: 'GioRequest<Route>', description: <>The request: <code>method</code>, <code>path</code>, <code>params</code>, <code>query</code>, <code>headers</code>, <code>cookies</code>, <code>body</code>, <code>bodyBase64</code>, <code>json()</code>, <code>formData()</code>, <code>ip</code>, <code>scheme</code>, <code>host</code>, <code>requestId</code>, <code>locale</code>.</> },
        { name: 'SseHandler, SseStream, SseCleanupFn', description: <>The callback a <code>GioEventStream</code> runs, the stream it writes to (<code>send</code>, <code>close</code>), and the cleanup function it may return - or resolve to, when it is <code>async</code>.</> },
        { name: 'WsHandler, GioSocket', description: <>A <code>route.ts</code> <code>wsHandler</code> and the socket it gets (<code>send</code>, <code>close</code>, <code>join</code>, <code>leave</code>, <code>on</code>, <code>params</code>, <code>cookies</code>, ...).</> },
        { name: 'BroadcastOptions', description: <><code>broadcast()</code>&apos;s options: <code>{'{ except?: socketId }'}</code>.</> },
        { name: 'UseWebSocketOptions, UseWebSocketResult, ReconnectOptions, WebSocketData', description: <>From <code>@gio.js/react</code>: <code>useWebSocket()</code>&apos;s options, result, backoff settings and message type.</> },
      ]} />

      <h3 id="metadata-types">Metadata</h3>
      <TypeTable rows={[
        { name: 'Metadata', description: <>A page or layout&apos;s <code>metadata</code>: <code>title</code>, <code>description</code>, <code>openGraph</code>, <code>twitter</code>, <code>alternates</code>, <code>robots</code>, <code>icons</code>, <code>themeColor</code>, <code>other</code> and more.</> },
        { name: 'GenerateMetadata<Route>, MetadataContext<Route>, MetadataExtras', description: <><code>generateMetadata(ctx, {'{ props }'})</code> and its two arguments.</> },
        { name: 'TitleTemplate', description: <><code>{'{ default?, template?, absolute? }'}</code>.</> },
        { name: 'OpenGraphMetadata, OpenGraphImage, TwitterMetadata, TwitterImage', description: <>Social cards.</> },
        { name: 'AlternatesMetadata, RobotsMetadata, RobotsDirectives', description: <>Canonical and language URLs, and robots directives.</> },
        { name: 'IconsMetadata, IconDescriptor, ThemeColorDescriptor, MetadataAuthor', description: <>Icons, theme colors and authors.</> },
        { name: 'MetadataRoute.Sitemap, MetadataRoute.Robots, MetadataRoute.Manifest', description: <>Return types of <code>app/sitemap.ts</code>, <code>app/robots.ts</code> and <code>app/manifest.ts</code>.</> },
        { name: 'Sitemap, SitemapEntry, ChangeFrequency, Robots, RobotsRule, Manifest', description: <>The same, by their own names.</> },
        { name: 'JsonLdProps, JsonLdData', description: <>From <code>@gio.js/react</code>: <code>&lt;JsonLd&gt;</code>&apos;s props.</> },
      ]} />

      <h3 id="middleware-config-and-plugins">Middleware, config and plugins</h3>
      <TypeTable rows={[
        { name: 'MiddlewareRules', description: <>What <code>defineMiddleware()</code> takes: <code>redirects</code>, <code>rewrites</code>, <code>headers</code>, <code>guards</code>.</> },
        { name: 'MiddlewareRedirect, MiddlewareRewrite, MiddlewareHeaderRule, MiddlewareGuard', description: <>One rule of each kind.</> },
        { name: 'GioConfig', description: <><code>gio.config.ts</code>&apos;s shape (<code>plugins</code>), what <code>defineConfig()</code> takes.</> },
        { name: 'GioNodePlugin', description: <>A Node plugin: <code>name</code>, <code>version</code>, <code>onRequest</code>, <code>onResponse</code>, <code>onStartup</code>, <code>onShutdown</code>.</> },
        { name: 'IPCRequest, IPCResponse', description: <>The request and response a plugin&apos;s hooks see.</> },
      ]} />

      <h3 id="sessions-cookies-and-revalidation">Sessions, cookies and revalidation</h3>
      <TypeTable rows={[
        { name: 'SessionStorage<Data>, SessionStorageOptions', description: <><code>createSessionStorage()</code>&apos;s result and options.</> },
        { name: 'Session<Data>, SessionData, SessionSource, CommitSessionOptions', description: <>A session, its data, what <code>getSession()</code> reads from (a request, a context, a socket or a cookie header), and <code>commitSession()</code>&apos;s options.</> },
        { name: 'CookieOptions', description: <><code>serializeCookie()</code>&apos;s options, with secure defaults.</> },
        { name: 'RevalidateResult, RevalidatePathOptions', description: <><code>{'{ ok, purged, error? }'}</code> from <code>revalidateTag</code> / <code>revalidatePath</code>, and <code>{'{ type?: \'page\' | \'prefix\' }'}</code>.</> },
      ]} />

      <h3 id="client-router-types">Client router and components</h3>
      <TypeTable rows={[
        { name: 'GioRouter', description: <><code>useRouter()</code>: <code>push</code>, <code>replace</code>, <code>back</code>, <code>forward</code>, <code>refresh</code>, <code>prefetch</code>.</> },
        { name: 'NavigateOptions, RouterNavigateOptions', description: <>Options of <code>navigate()</code> (<code>replace</code>, <code>scroll</code>, <code>transition</code>) and of <code>router.push</code> / <code>replace</code> (the same without <code>replace</code>).</> },
        { name: 'ReadonlyURLSearchParams', description: <><code>useSearchParams()</code>: <code>URLSearchParams</code> without the mutating methods.</> },
        { name: 'TransitionPreset, AnimatePreset', description: <>Names of the view-transition and <code>&lt;Animate&gt;</code> presets.</> },
        { name: 'GioRegisteredRoutes, RouteParamsOf', description: <>The route registry as <code>@gio.js/react</code> sees it, and a registered pattern&apos;s params.</> },
      ]} />

      <h3 id="testing-types">Testing</h3>
      <TypeTable rows={[
        { name: 'RenderPageOptions, RenderPageResult', description: <>From <code>@gio.js/core/testing</code>: <code>renderPage()</code>&apos;s options and result (<code>status</code>, <code>html</code>, <code>props</code>, <code>setCookies</code>, <code>cacheable</code>, ...).</> },
        { name: 'CallRouteOptions, RouteResponse', description: <><code>callRoute()</code>&apos;s options and fetch-like response.</> },
        { name: 'TestRequestOptions, TestRenderError', description: <>The options both share, and a render error.</> },
        { name: 'TestServerOptions, TestServer', description: <><code>createTestServer()</code>&apos;s options and handle (<code>url</code>, <code>port</code>, <code>logs()</code>, <code>close()</code>).</> },
        { name: 'GioVitestPlugin', description: <>From <code>@gio.js/core/vitest</code>: the plugin <code>gioVitest()</code> returns.</> },
      ]} />

      <h2 id="examples">Examples</h2>

      <h3 id="a-typed-page-with-getserversideprops">A typed page with getServerSideProps</h3>
      <CodeBlock lang="tsx" title="app/blog/[slug]/page.tsx" code={`import { notFound } from '@gio.js/core';
import type { GetServerSideProps, InferPageProps, GenerateMetadata } from '@gio.js/core';

interface Post {
  slug: string;
  title: string;
  body: string;
}

const posts: Post[] = [{ slug: 'hello', title: 'Hello', body: 'First post.' }];

export const revalidate = 300;

export const getServerSideProps = (async (ctx) => {
  const post = posts.find((p) => p.slug === ctx.params.slug); // ctx.params: { slug: string }
  if (post === undefined) notFound();
  return { props: { post }, tags: [\`post:\${post.slug}\`] };
}) satisfies GetServerSideProps<{ post: Post }, '/blog/:slug'>;

export const generateMetadata: GenerateMetadata<'/blog/:slug'> = (ctx, { props }) => {
  const post = props?.['post'] as Post | undefined;
  return { title: post?.title ?? ctx.params.slug };
};

export default function BlogPost({ post }: InferPageProps<typeof getServerSideProps>) {
  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
    </article>
  );
}`} />
      <p>
        <code>satisfies</code> keeps the exact return type, so{' '}
        <code>InferPageProps</code> reads <code>{'{ post: Post }'}</code> off it.{' '}
        <code>notFound()</code> returns <code>never</code>, which narrows <code>post</code>.
      </p>

      <h3 id="a-typed-route-handler">A typed route handler</h3>
      <CodeBlock lang="ts" title="app/api/posts/[id]/route.ts" code={`import { notFound } from '@gio.js/core';
import type { RouteHandler } from '@gio.js/core';

const titles: Record<string, string> = { '1': 'Hello' };

export const GET: RouteHandler<'/api/posts/:id'> = (req) => {
  const title = titles[req.params.id];
  if (title === undefined) notFound(); // a JSON 404
  return { id: req.params.id, title };  // 200 application/json
};`} />

      <h3 id="a-typed-action">A typed action</h3>
      <CodeBlock lang="tsx" title="app/subscribe/page.tsx" code={`import { redirect } from '@gio.js/core';
import type { ActionArgs, WithActionData } from '@gio.js/core';
import { GioForm } from '@gio.js/react';

export async function action(req: ActionArgs) {
  const form = await req.formData();
  const email = String(form.get('email') ?? '');
  if (!email.includes('@')) {
    return { status: 422, data: { error: 'Enter a valid email address.' } };
  }
  return redirect('/subscribe/thanks');
}

export default function Subscribe({ actionData }: WithActionData<typeof action>) {
  return (
    <GioForm>
      <input name="email" type="email" />
      {actionData?.error && <p role="alert">{actionData.error}</p>}
      <button type="submit">Subscribe</button>
    </GioForm>
  );
}`} />
      <p>
        <code>actionData</code> is <code>{'{ error: string } | undefined'}</code>: the
        redirect is left out, because it never re-renders the page.
      </p>

      <h3 id="typed-links-and-params">Typed links and params</h3>
      <CodeBlock lang="tsx" title="components/PostNav.tsx" code={`import { GioLink, href, useParams } from '@gio.js/react';

export function PostNav() {
  const { slug } = useParams<'/blog/:slug'>();
  return (
    <nav>
      <GioLink href={href('/blog/:slug', { slug: 'hello' })}>First post</GioLink>
      <span>Reading {slug}</span>
    </nav>
  );
}`} />

      <h3 id="a-typed-sitemap">A typed sitemap</h3>
      <CodeBlock lang="ts" title="app/sitemap.ts" code={`import type { MetadataRoute } from '@gio.js/core';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: '/', changeFrequency: 'daily', priority: 1 },
    { url: '/blog/hello', lastModified: new Date('2026-10-01') },
  ];
}`} />
      <p>
        Relative URLs resolve against <a href="/docs/env-vars#gio-site-url"><code>GIO_SITE_URL</code></a>.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Type errors never stop <code>gio dev</code> or <code>gio start</code>: run{' '}
          <code>tsc --noEmit</code> to see them.
        </li>
        <li>
          A catch-all param is one string with <code>/</code> separators
          (<code>&apos;guides/setup&apos;</code>), in the types and at runtime; only{' '}
          <code>getStaticPaths</code> also accepts an array of segments.
        </li>
        <li>
          <code>process.env</code> values are typed as <code>string | undefined</code> by{' '}
          <code>@types/node</code>; GioJS adds no declarations for your variables.
        </li>
        <li>
          In generic code, <code>ActionArgs&lt;P&gt;[&apos;params&apos;]</code> is a{' '}
          <code>ParamsOf&lt;P&gt;</code>, not a <code>P</code>: TypeScript leaves the
          conditional type unresolved while <code>P</code> is a type parameter.
        </li>
        <li>
          <code>gio.config.ts</code> and <code>middleware.ts</code> are TypeScript too: wrap
          them in <code>defineConfig()</code> and <code>defineMiddleware()</code> for
          completion. Unknown <code>gio.config.ts</code> keys are an error at startup.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/linking-and-navigating#typed-routes">Typed routes</a> in Linking &amp; Navigating</li>
        <li><a href="/docs/functions/href"><code>href</code></a>, <a href="/docs/hooks/use-params"><code>useParams</code></a> and <a href="/docs/cli/typegen"><code>gio typegen</code></a></li>
        <li><a href="/docs/file-conventions/dynamic-routes">Dynamic routes</a> and <a href="/docs/file-conventions/gio-directory">the .gio directory</a></li>
        <li><a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a>, <a href="/docs/page-exports/action"><code>action</code></a> and <a href="/docs/page-exports/generate-metadata"><code>generateMetadata</code></a></li>
        <li><a href="/docs/env-vars">Environment Variables</a>, <a href="/docs/endpoints">Endpoints</a> and <a href="/docs/headers">Headers</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              Types for every file convention (<code>GetServerSideProps</code>,{' '}
              <code>InferPageProps</code>, <code>PageProps</code>, <code>LayoutProps</code>,{' '}
              <code>ErrorPageProps</code>, <code>GetStaticPaths</code>,{' '}
              <code>RouteHandler</code>, <code>Metadata</code>, <code>MetadataRoute</code>,
              ...) and for every exported function&apos;s parameters and results.{' '}
              <code>.gio/routes.d.ts</code> fills the global{' '}
              <code>GioJS.RegisteredRoutes</code>, read by <code>href()</code>,{' '}
              <code>useParams()</code> and the core types; <code>gio typegen</code>.{' '}
              <code>@gio.js/core</code> ships declaration files (no more TS5097).{' '}
              <code>.gio/css-modules.d.ts</code> types CSS imports.
            </>
          ),
        },
        { version: 'v0.1.0-beta.6', changes: <><code>.gio/routes.d.ts</code> and <code>href()</code> introduced, augmenting <code>GioRegisteredRoutes</code>.</> },
      ]} />
    </>
  );
}
