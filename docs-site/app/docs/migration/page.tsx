import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../components/PmTabs.tsx';

export const metadata: Metadata = {
  title: 'Migration Guide',
  description:
    'Move a Next.js app (pages or app router) to GioJS with one command, then work through a ' +
    'report of what needs a human.',
};

export const revalidate = false;

export default function MigrationPage(): React.JSX.Element {
  return (
    <>
      <h1>Migration Guide</h1>
      <p className="page-subtitle">
        Move a Next.js app (pages or app router) to GioJS with one command, then work through a
        report of what needs a human.
      </p>

      <h2 id="run-the-migration">Run the migration</h2>
      <p>Commit your work first - the migration edits files in place. From the project root:</p>
      <PmTabs command={`npm create giojs@latest -- migrate            # current directory
npx create-giojs migrate ./my-next-app         # same thing, explicit directory`} />
      <p>
        It prints a summary of every move and edit and asks before writing anything. Preview the
        full diff without touching a file, or skip the prompt (CI, scripts):
      </p>
      <PmTabs command={`npx create-giojs migrate --dry-run   # summary + diff of every change, writes nothing
npx create-giojs migrate --yes       # apply without asking (required when there is no terminal)
npx create-giojs migrate --help`} />
      <p>
        The <code>gio-migrate</code> bin of the same package runs the same command
        (<code>npx -p create-giojs gio-migrate</code>). Afterwards:
      </p>
      <PmTabs command={`npm install          # next is swapped for @gio.js/server + @gio.js/react
npx tsc --noEmit     # catches what the migration could not see
npm run dev`} />

      <h2 id="migration-reportmd">MIGRATION_REPORT.md</h2>
      <p>
        The migration writes <code>MIGRATION_REPORT.md</code> to the project root: every file
        moved, every change with its <code>file:line</code>, the converted configuration, and a
        checklist of TODOs. Each TODO is also a <code>// TODO(gio-migrate): ...</code> comment
        above the code it is about, so <code>grep -rn "TODO(gio-migrate)" .</code> finds them
        too. Nothing that needs a decision is changed silently.
      </p>

      <h2 id="pages-app">pages/ → app/</h2>
      <p>
        GioJS uses the app router conventions (layouts, route groups, catch-alls,
        <code> not-found</code>/<code>error</code>/<code>loading</code> files), so an app router
        project keeps its structure (<code>src/app/</code> moves to <code>app/</code> - GioJS
        reads it from the project root). A pages router project is moved file by file, and
        relative imports in moved files are rewritten to match:
      </p>
      <table>
        <thead>
          <tr><th>Next.js</th><th>GioJS</th></tr>
        </thead>
        <tbody>
          <tr><td><code>pages/index.tsx</code></td><td><code>app/page.tsx</code></td></tr>
          <tr><td><code>pages/about.tsx</code>, <code>pages/about/index.tsx</code></td><td><code>app/about/page.tsx</code></td></tr>
          <tr><td><code>pages/[id].tsx</code>, <code>pages/[...slug].tsx</code></td><td><code>app/[id]/page.tsx</code>, <code>app/[...slug]/page.tsx</code></td></tr>
          <tr><td><code>pages/_app.tsx</code> + <code>pages/_document.tsx</code></td><td><a href="/docs/file-conventions/layout"><code>app/layout.tsx</code></a> - the document's <code>&lt;Html&gt;</code>, <code>&lt;Head&gt;</code> and <code>&lt;body&gt;</code> markup carried over, global CSS linked, originals kept as a comment</td></tr>
          <tr><td><code>pages/404.tsx</code> / <code>pages/500.tsx</code></td><td><a href="/docs/file-conventions/not-found"><code>app/not-found.tsx</code></a> / <a href="/docs/file-conventions/error"><code>app/error.tsx</code></a></td></tr>
          <tr><td><code>pages/api/x.ts</code></td><td><code>app/api/x/route.ts</code>, with a TODO sketching the <code>GET</code>/<code>POST</code> exports that replace the <code>(req, res)</code> handler</td></tr>
        </tbody>
      </table>
      <p>
        A file is never moved onto an existing one: it stays where it is with a TODO. Next.js
        <code> middleware.ts</code> is renamed to <code>middleware.next.ts</code> - GioJS loads
        <code> middleware.ts</code> as declarative rules (see Middleware) - and flagged for porting.
      </p>
      <p>
        Next.js accepts JSX in <code>.js</code> files; GioJS compiles JSX only in
        <code> .jsx</code>/<code>.tsx</code> files, so every <code>.js</code> file with JSX is
        renamed to <code>.jsx</code> (<code>pages/index.js</code> → <code>app/page.jsx</code>,
        <code> components/Nav.js</code> → <code>components/Nav.jsx</code>) and imports that spell
        out the <code>.js</code> extension are updated. Files without JSX keep their name.
      </p>
      <p>
        Catch-all params differ in shape: Next passes <code>[...slug]</code> as an array
        (<code>['a', 'b']</code>), GioJS as the <code>'/'</code>-joined string
        (<code>'a/b'</code>) - in page props, <a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a>'s
        <code> params</code>, <a href="/docs/hooks/use-params"><code>useParams()</code></a> and route handlers alike. Code in a
        catch-all route that reads them gets a TODO to use <code>.split('/')</code>.
      </p>

      <h2 id="code-transforms">Code transforms</h2>
      <p>
        Source files are parsed with the TypeScript compiler (so JSX text, strings and comments
        are never mistaken for code) and edited in place - formatting and comments survive.
      </p>
      <table>
        <thead>
          <tr><th>Next.js</th><th>GioJS</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>next/link</code> (default, named or aliased import)</td>
            <td><a href="/docs/components/gio-link"><code>GioLink</code></a>; <code>legacyBehavior</code>/<code>passHref</code> removed (a child <code>&lt;a&gt;</code> is unwrapped onto the link), <code>as</code> becomes <a href="/docs/functions/href"><code>href</code></a>, <code>prefetch</code> becomes <code>prefetch="viewport"</code>; object hrefs, <code>shallow</code>, <code>locale</code> and unsupported props get a TODO</td>
          </tr>
          <tr>
            <td><code>next/image</code>, <code>next/legacy/image</code></td>
            <td><a href="/docs/components/gio-image"><code>GioImage</code></a>; <code>fill</code>, <code>priority</code>, <code>sizes</code>, <code>quality</code>, <code>placeholder</code> kept, legacy <code>layout</code> mapped; static image imports, loaders and missing width/height get a TODO</td>
          </tr>
          <tr>
            <td><code>next/router</code> <code>useRouter()</code></td>
            <td><a href="/docs/hooks/use-router"><code>useRouter</code></a> from <code>@gio.js/react</code> (<code>push</code>, <code>replace</code>, <code>back</code>, <code>forward</code>, <code>prefetch</code>, <code>refresh</code>); <code>router.query</code> → <a href="/docs/hooks/use-search-params"><code>useSearchParams()</code></a> + <code>useParams()</code> merged in a <code>useMemo</code> (it keeps its identity until the URL changes, like <code>router.query</code>, so effects that depend on it don't re-run every render), <code>pathname</code>/<code>asPath</code> → <a href="/docs/hooks/use-pathname"><code>usePathname()</code></a>, <code>reload()</code> → <code>window.location.reload()</code>; <code>router.events</code> and other unsupported APIs get a TODO</td>
          </tr>
          <tr>
            <td><code>next/navigation</code></td>
            <td>
              The hooks move to <code>@gio.js/react</code> unchanged, <a href="/docs/functions/not-found"><code>notFound</code></a> to{' '}
              <code>@gio.js/core</code>. <code>redirect()</code>/<code>permanentRedirect()</code> become{' '}
              <code>redirect</code> from <code>@gio.js/core</code>, which returns the redirect instead of
              throwing it: <code>redirect(url)</code> as a statement becomes{' '}
              <a href="/docs/functions/redirect"><code>throw redirect(url)</code></a> (<code>redirect(url, 308)</code> for a permanent one) -
              what <code>getServerSideProps</code>, <a href="/docs/page-exports/generate-metadata"><code>generateMetadata</code></a>, page actions and the
              helpers they call may throw. <code>return redirect(url)</code> becomes{' '}
              <code>throw redirect(url)</code> too, except directly in{' '}
              <code>getServerSideProps</code> or a page action, the only places that read a returned
              redirect (a guard helper&apos;s caller would take it for a value, and{' '}
              <code>generateMetadata</code> would merge it as metadata). Directly in a route handler
              it becomes a 307/308 <code>Response</code>; while rendering a component or in a hook
              it gets a TODO (redirect from{' '}
              <code>getServerSideProps</code>, or <a href="/docs/functions/navigate"><code>navigate()</code></a> in the browser)
            </td>
          </tr>
          <tr>
            <td><code>next/head</code></td>
            <td>Plain <code>&lt;title&gt;</code>/<code>&lt;meta&gt;</code>/<code>&lt;link&gt;</code> - React 19 hoists them into <code>&lt;head&gt;</code></td>
          </tr>
          <tr>
            <td><code>next/script</code></td>
            <td>Plain <code>&lt;script&gt;</code> (<code>async</code> for the default strategy, inline bodies as <code>dangerouslySetInnerHTML</code>); other strategies and <code>onLoad</code> get a TODO</td>
          </tr>
          <tr>
            <td><code>next/dynamic</code></td>
            <td><code>React.lazy</code>; the <code>loading</code> and <code>ssr: false</code> options get a TODO (render inside <code>&lt;Suspense&gt;</code>)</td>
          </tr>
          <tr>
            <td><code>next/font</code></td>
            <td>A same-shape stand-in object plus a <a href="/docs/configuration/fonts"><code>[[fonts]]</code></a> snippet for <code>gio.toml</code> in the report</td>
          </tr>
          <tr>
            <td><code>getStaticProps</code></td>
            <td><code>getServerSideProps</code> plus <a href="/docs/page-exports/revalidate"><code>export const revalidate</code></a> (its <code>revalidate</code> value, or <code>false</code> - cache until the next deploy); <a href="/docs/page-exports/get-static-paths"><code>getStaticPaths</code></a> is kept for <a href="/docs/cli/export"><code>gio export</code></a>, and <code>generateStaticParams</code> gets a <code>getStaticPaths</code> next to it</td>
          </tr>
          <tr>
            <td><code>export const metadata</code> / <code>generateMetadata</code></td>
            <td>
              Kept - GioJS reads both on pages and layouts, with the same field names, title
              templates and root-to-page merge (see Metadata &amp; SEO); the <code>Metadata</code>{' '}
              type now comes from <code>@gio.js/core</code>. Fields GioJS does not render get a TODO
              naming them: <code>applicationName</code>, <code>generator</code>,{' '}
              <code>referrer</code>, <code>creator</code>, <code>publisher</code>,{' '}
              <code>category</code>, <code>verification</code> and the like with their{' '}
              <code>other: {'{ name: content }'}</code> replacement; <code>viewport</code>,{' '}
              <code>appleWebApp</code>, <code>appLinks</code>, <code>itunes</code>,{' '}
              <code>facebook</code>, <code>alternates.types</code>, <code>icons.other</code> and Open
              Graph article fields as having no equivalent. <code>generateMetadata</code> gets GioJS's{' '}
              <code>(ctx, {'{ props }'})</code> signature: <code>params</code> is unchanged,{' '}
              <code>searchParams</code> becomes <code>query: searchParams</code>, an unused{' '}
              <code>parent</code> is dropped and a used one gets a TODO (segments merge on their own)
            </td>
          </tr>
          <tr>
            <td><code>'use client'</code> / <code>'use server'</code></td>
            <td>
              Removed - every GioJS page hydrates. <code>&lt;form action={'{serverAction}'}&gt;</code>{' '}
              becomes <a href="/docs/components/gio-form"><code>&lt;GioForm&gt;</code></a>, which posts to the page&apos;s own URL, and each
              Server Action gets a TODO to move into that page&apos;s{' '}
              <code>export async function action(req)</code> (a non-form one into a{' '}
              <a href="/docs/file-conventions/route"><code>route.ts</code></a> handler); the report sketches the result. A button&apos;s{' '}
              <code>formAction={'{serverAction}'}</code> becomes{' '}
              <code>name="intent" value="serverAction"</code> for the page&apos;s action to branch on,
              and its <code>&lt;form&gt;</code> becomes a <code>&lt;GioForm&gt;</code> as well. A client
              function as a form action is React 19&apos;s own and stays
            </td>
          </tr>
          <tr>
            <td><code>next/cache</code></td>
            <td>
              <a href="/docs/functions/revalidate-path"><code>revalidatePath</code></a>/<code>revalidateTag</code> from <code>@gio.js/core</code>{' '}
              (<code>'layout'</code> becomes <code>{"{ type: 'prefix' }"}</code>, a route pattern such
              as <code>/posts/[id]</code> gets a TODO, and so does each <code>revalidateTag</code>: it
              purges the pages that declare the tag with <code>export const tags</code>).{' '}
              <code>unstable_cache(fn)</code> becomes{' '}
              <code>fn</code> and <code>'use cache'</code> is removed, both with a TODO: GioJS caches
              whole pages (<code>export const revalidate</code> and <code>export const tags</code>),
              and <code>fetch()</code>&apos;s <code>next</code> options are flagged - Node&apos;s{' '}
              <code>fetch</code> has no data cache. <code>noStore()</code> calls are removed, and{' '}
              <code>export const dynamic = 'force-static'</code> on a page becomes{' '}
              <code>export const revalidate = false</code> (on a layout it gets a TODO: GioJS reads{' '}
              <code>revalidate</code> from pages only, so each page below it needs the export)
            </td>
          </tr>
          <tr>
            <td>Metadata files</td>
            <td>
              <a href="/docs/file-conventions/sitemap"><code>app/sitemap.ts</code></a>, <a href="/docs/file-conventions/robots"><code>app/robots.ts</code></a> and <a href="/docs/file-conventions/manifest"><code>app/manifest.ts</code></a>{' '}
              are kept: GioJS serves them at the same URLs from the same return shapes (sitemap{' '}
              <code>images</code>/<code>videos</code> and <code>generateSitemaps</code> get a TODO).
              Next linked the manifest from every page on its own; GioJS renders that{' '}
              <code>&lt;link rel="manifest"&gt;</code> from metadata only, so{' '}
              <code>app/manifest.ts</code> gets a TODO to add{' '}
              <code>manifest: '/manifest.webmanifest'</code> to the root layout&apos;s metadata.
              The static files Next serves from <code>app/</code> - <code>favicon.ico</code>,{' '}
              <code>robots.txt</code>, <code>sitemap.xml</code>, <code>manifest.json</code>,{' '}
              <code>icon.png</code>, <code>opengraph-image.png</code>, ... - move to{' '}
              <a href="/docs/file-conventions/public-folder"><code>public/</code></a>; images and the manifest get a TODO to reference them from{' '}
              <a href="/docs/page-exports/metadata"><code>metadata</code></a> (<code>icons</code>, <code>openGraph.images</code>,{' '}
              <code>manifest</code>), which Next did implicitly
            </td>
          </tr>
          <tr>
            <td><code>next/server</code> in route handlers</td>
            <td><code>NextResponse.json</code>/<code>redirect</code> → <code>Response</code>, <code>NextRequest</code> → <code>GioRequest</code>; <code>request.nextUrl</code>, <code>headers.get()</code>, <code>text()</code> and the <code>{'{ params }'}</code> argument get a TODO (GioJS passes a <code>GioRequest</code> with plain objects, <code>json()</code> and <code>formData()</code>)</td>
          </tr>
          <tr>
            <td>CSS imports</td>
            <td>GioJS does not bundle CSS imports: in the root layout an <code>app/</code> stylesheet becomes a <code>&lt;link&gt;</code>, elsewhere the import is commented out with a TODO</td>
          </tr>
        </tbody>
      </table>
      <p>
        <code>package.json</code> drops <code>next</code> for <code>@gio.js/server</code> and
        <code> @gio.js/react</code> (plus <code>@gio.js/core</code> when the migrated code
        imports it; React moves to 19), its <code>next dev</code>/<code>next start</code>
        scripts run the GioJS server, and it gets <code>"type": "module"</code>, like every
        GioJS app: GioJS loads app files as ES modules and <code>@gio.js/react</code> ships ES
        modules only, so without it every page importing <code>@gio.js/react</code> fails to
        load. That makes Node treat every <code>.js</code> file as an ES module, so CommonJS
        files (<code>module.exports</code>/<code>require</code>, such as
        <code> postcss.config.js</code> or <code>tailwind.config.js</code>) are renamed to
        <code> .cjs</code>, and a file mixing <code>import</code>/<code>export</code> with
        <code> module.exports</code> gets a TODO. <code>tsconfig.json</code> gets
        <code> "jsx": "react-jsx"</code> - <code>"preserve"</code> would leave JSX untransformed -
        loses the <code>next</code> plugin, and includes <code>.gio/routes.d.ts</code> for typed
        routes.
      </p>

      <h2 id="nextconfig-giotoml">next.config → gio.toml</h2>
      <p>
        The config is read statically (it is never executed). Redirects, rewrites and headers
        become the <code>gio.toml</code> rules the Rust server evaluates before routing, with the
        path syntax converted: <code>:slug</code> stays, <code>:path*</code> and a trailing
        <code> (.*)</code> or <code>:path(.*)</code> become the catch-all <code>*path</code>
        (<code>source: '/(.*)'</code>, the usual site-wide headers rule, becomes
        <code> path = "/*rest"</code>).
      </p>
      <CodeBlock lang="toml" code={`# redirects() { return [{ source: '/blog/:path*', destination: '/news/:path*', permanent: true }] }
[[redirects]]
from = "/blog/*path"
to = "/news/*path"
status = 308          # permanent: true → 308, false → 307 (statusCode is kept)

[[headers]]
path = "/*path"
headers = { "X-Frame-Options" = "DENY" }`} />
      <ul>
        <li><code>images.remotePatterns</code>/<code>domains</code> → <code>[[images.remote_patterns]]</code>, <code>deviceSizes</code>/<code>imageSizes</code> → <a href="/docs/configuration/images"><code>[images] allowed_widths</code></a></li>
        <li><code>i18n</code> → <a href="/docs/configuration/i18n"><code>[i18n]</code></a> (<code>localeDetection: false</code> → path detection only)</li>
        <li><code>output: 'export'</code> → the build script runs <code>gio export</code>; <code>env</code> → a <code>.env</code> hint</li>
        <li>
          A rule GioJS would match differently is skipped with a TODO instead of approximated:
          <code> has</code>/<code>missing</code> conditions, regex or optional parameters, external
          destinations, query strings in destinations, a root catch-all rewrite
          (<code>/(.*)</code>, <code>/:path*</code>) outside <code>beforeFiles</code> - Next ran it
          only after checking pages and public files, GioJS would rewrite every request - and
          image <code>pathname</code> globs with
          a single <code>*</code> (one segment in Next.js; a <code>gio.toml</code> pattern's
          <code> *</code> matches at any depth, which would widen what the image proxy fetches).
          The one exception is a catch-all Next requires to be non-empty
          (<code>/blog/:path+</code>, <code>/blog/(.*)</code>): it becomes
          <code> /blog/*path</code>, which also matches <code>/blog</code> itself, with a TODO
          comment saying so
        </li>
        <li>
          <code>experimental.serverActions</code> points at page actions (<code>bodySizeLimit</code>{' '}
          → <a href="/docs/configuration/server"><code>[server] max_body_bytes</code></a>, <code>allowedOrigins</code> →{' '}
          <a href="/docs/configuration/security-csrf"><code>[security.csrf] trusted_origins</code></a>), <code>experimental.ppr</code> at{' '}
          <a href="/docs/page-exports/shell"><code>export const shell = 'cache'</code></a>; typed routes need no flag
        </li>
        <li><code>basePath</code>, <code>trailingSlash</code>, <code>webpack</code>, other <code>experimental</code> flags and the rest are listed in the report - GioJS compiles with esbuild, so webpack and SWC options don't apply</li>
      </ul>
      <p>
        An existing <code>gio.toml</code> is never overwritten. New tables are merged into it when
        no table or key would be defined twice; otherwise the converted sections go to
        <code> gio.migrated.toml</code> (not loaded by GioJS) for you to merge by hand. To convert
        just the config: <code>npx create-giojs migrate --config next.config.js</code>.
      </p>

      <h2 id="server-actions-page-actions">Server Actions → page actions</h2>
      <p>
        A form&apos;s Server Action becomes the page&apos;s <a href="/docs/page-exports/action"><code>action</code></a> export: a POST to
        the page runs it, and <code>&lt;GioForm&gt;</code> (which the migration already put in
        place of the <code>&lt;form&gt;</code>) posts to it - with or without JavaScript:
      </p>
      <CodeBlock lang="tsx" code={`// Next.js
async function createPost(formData: FormData) {
  'use server';
  await db.posts.create({ title: String(formData.get('title')) });
  redirect('/posts');
}
// <form action={createPost}>...</form>

// GioJS - app/posts/new/page.tsx
import { redirect, type ActionArgs, type WithActionData } from '@gio.js/core';
import { GioForm } from '@gio.js/react';

export async function action(req: ActionArgs) {
  const title = String((await req.formData()).get('title') ?? '');
  if (title === '') return { status: 422, data: { error: 'Title is required' } };
  await db.posts.create({ title });
  return redirect('/posts');
}

export default function NewPost({ actionData }: WithActionData<typeof action>) {
  return (
    <GioForm>
      <input name="title" />
      {actionData?.error && <p role="alert">{actionData.error}</p>}
      <button>Create</button>
    </GioForm>
  );
}`} />
      <p>
        <code>useFormStatus()</code> becomes <a href="/docs/hooks/use-gio-form-state"><code>useGioFormState()</code></a>, values passed with{' '}
        <code>.bind()</code> become hidden inputs, and <code>useActionState</code>&apos;s result is
        the page&apos;s <code>actionData</code> prop. The migration flags each of these.
      </p>

      <h2 id="what-needs-a-human">What needs a human</h2>
      <ul>
        <li>
          <strong>async Server Components</strong> - every GioJS page hydrates, so data loading
          moves into <code>getServerSideProps</code> (flagged on async pages and layouts)
        </li>
        <li>
          <strong>Providers in the root layout</strong> - the root <code>app/layout</code> is
          server-only HTML and never hydrates: context providers and interactive components go in
          a nested layout or the pages (flagged)
        </li>
        <li>
          <strong>Server Actions</strong> - the forms already post through{' '}
          <code>&lt;GioForm&gt;</code>; move each action&apos;s body into the page&apos;s{' '}
          <code>export async function action(req)</code> (fields from{' '}
          <code>await req.formData()</code>, answer with <code>redirect(url)</code> or{' '}
          <code>{'{ status: 422, data }'}</code> to re-render with <code>actionData</code> - see Forms
          and Mutations). Actions called from code become <code>route.ts</code> handlers called
          with <code>fetch()</code>
        </li>
        <li>
          <strong>Middleware</strong> - declarative redirects, rewrites, headers, and session or
          cookie guards move to <a href="/docs/file-conventions/middleware"><code>middleware.ts</code></a> (<a href="/docs/functions/define-middleware"><code>defineMiddleware</code></a> from{' '}
          <code>@gio.js/core</code>) or <code>gio.toml</code>, and run in the Rust layer before
          routing. Imperative request interception belongs in a Node plugin
          (<code>GioNodePlugin</code> with an <code>onRequest</code> hook)
        </li>
        <li>
          <strong>Unsupported app router files</strong> - <code>template</code>, parallel
          (<code>@slot</code>) and intercepting routes, generated (<code>.tsx</code>){' '}
          <code>icon</code>/<code>opengraph-image</code>/<code>twitter-image</code> files (GioJS has
          no image generation: put a rendered image in <code>public/</code>) and nested{' '}
          <code>sitemap.ts</code> files (only <code>app/sitemap.ts</code> is served) are listed in
          the report
        </li>
        <li>
          <strong>Data caching</strong> - <code>unstable_cache</code>, <code>'use cache'</code> and{' '}
          <code>fetch()</code> cache options become page caching: <code>export const revalidate</code>{' '}
          plus <code>export const tags</code> for the pages <a href="/docs/functions/revalidate-tag"><code>revalidateTag()</code></a> should purge
        </li>
      </ul>

      <div className="callout">
        Run <code>npx tsc --noEmit</code> after migrating: types imported from <code>next</code>
        (<code>NextPage</code>, <code>GetStaticProps</code>, <code>NextApiRequest</code>, ...)
        are flagged but not rewritten - only <code>Metadata</code> and{' '}
        <code>MetadataRoute</code>, which <code>@gio.js/core</code> exports under the same names,
        are - and the compiler points at every place that still uses them.
      </div>
    </>
  );
}
