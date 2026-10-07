import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function MigrationPage(): React.JSX.Element {
  return (
    <>
      <h1>Migration Guide</h1>
      <p className="page-subtitle">
        Move a Next.js app (pages or app router) to GioJS with one command, then work through a
        report of what needs a human.
      </p>

      <h2>Run the migration</h2>
      <p>Commit your work first - the migration edits files in place. From the project root:</p>
      <CodeBlock lang="bash" code={`npm create giojs@latest -- migrate            # current directory
npx create-giojs migrate ./my-next-app         # same thing, explicit directory`} />
      <p>
        It prints a summary of every move and edit and asks before writing anything. Preview the
        full diff without touching a file, or skip the prompt (CI, scripts):
      </p>
      <CodeBlock lang="bash" code={`npx create-giojs migrate --dry-run   # summary + diff of every change, writes nothing
npx create-giojs migrate --yes       # apply without asking (required when there is no terminal)
npx create-giojs migrate --help`} />
      <p>
        The <code>gio-migrate</code> bin of the same package runs the same command
        (<code>npx -p create-giojs gio-migrate</code>). Afterwards:
      </p>
      <CodeBlock lang="bash" code={`npm install          # next is swapped for @gio.js/server + @gio.js/react
npx tsc --noEmit     # catches what the migration could not see
npm run dev`} />

      <h2>MIGRATION_REPORT.md</h2>
      <p>
        The migration writes <code>MIGRATION_REPORT.md</code> to the project root: every file
        moved, every change with its <code>file:line</code>, the converted configuration, and a
        checklist of TODOs. Each TODO is also a <code>// TODO(gio-migrate): ...</code> comment
        above the code it is about, so <code>grep -rn "TODO(gio-migrate)" .</code> finds them
        too. Nothing that needs a decision is changed silently.
      </p>

      <h2>pages/ → app/</h2>
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
          <tr><td><code>pages/_app.tsx</code> + <code>pages/_document.tsx</code></td><td><code>app/layout.tsx</code> - the document's <code>&lt;Html&gt;</code>, <code>&lt;Head&gt;</code> and <code>&lt;body&gt;</code> markup carried over, global CSS linked, originals kept as a comment</td></tr>
          <tr><td><code>pages/404.tsx</code> / <code>pages/500.tsx</code></td><td><code>app/not-found.tsx</code> / <code>app/error.tsx</code></td></tr>
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
        (<code>'a/b'</code>) - in page props, <code>getServerSideProps</code>'s
        <code> params</code>, <code>useParams()</code> and route handlers alike. Code in a
        catch-all route that reads them gets a TODO to use <code>.split('/')</code>.
      </p>

      <h2>Code transforms</h2>
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
            <td><code>GioLink</code>; <code>legacyBehavior</code>/<code>passHref</code> removed (a child <code>&lt;a&gt;</code> is unwrapped onto the link), <code>as</code> becomes <code>href</code>, <code>prefetch</code> becomes <code>prefetch="viewport"</code>; object hrefs, <code>shallow</code>, <code>locale</code> and unsupported props get a TODO</td>
          </tr>
          <tr>
            <td><code>next/image</code>, <code>next/legacy/image</code></td>
            <td><code>GioImage</code>; <code>fill</code>, <code>priority</code>, <code>sizes</code>, <code>quality</code>, <code>placeholder</code> kept, legacy <code>layout</code> mapped; static image imports, loaders and missing width/height get a TODO</td>
          </tr>
          <tr>
            <td><code>next/router</code> <code>useRouter()</code></td>
            <td><code>useRouter</code> from <code>@gio.js/react</code> (<code>push</code>, <code>replace</code>, <code>back</code>, <code>forward</code>, <code>prefetch</code>, <code>refresh</code>); <code>router.query</code> → <code>useSearchParams()</code> + <code>useParams()</code> merged in a <code>useMemo</code> (it keeps its identity until the URL changes, like <code>router.query</code>, so effects that depend on it don't re-run every render), <code>pathname</code>/<code>asPath</code> → <code>usePathname()</code>, <code>reload()</code> → <code>window.location.reload()</code>; <code>router.events</code> and other unsupported APIs get a TODO</td>
          </tr>
          <tr>
            <td><code>next/navigation</code></td>
            <td>The hooks move to <code>@gio.js/react</code> unchanged, <code>notFound</code> to <code>@gio.js/core</code>; <code>redirect()</code> gets a TODO (return <code>{'{ redirect }'}</code> from <code>getServerSideProps</code>)</td>
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
            <td>A same-shape stand-in object plus a <code>[[fonts]]</code> snippet for <code>gio.toml</code> in the report</td>
          </tr>
          <tr>
            <td><code>getStaticProps</code></td>
            <td><code>getServerSideProps</code> plus <code>export const revalidate</code> (its <code>revalidate</code> value, or <code>false</code> - cache until the next deploy); <code>getStaticPaths</code> is kept for <code>gio export</code>, and <code>generateStaticParams</code> gets a <code>getStaticPaths</code> next to it</td>
          </tr>
          <tr>
            <td><code>export const metadata</code> / <code>generateMetadata</code></td>
            <td>Left in place with a TODO: GioJS does not read them, so the page would render without its <code>&lt;title&gt;</code> and SEO tags. Render <code>&lt;title&gt;</code>/<code>&lt;meta&gt;</code> in the component instead (React 19 hoists them into <code>&lt;head&gt;</code>); for a static title/description the TODO spells out the tags</td>
          </tr>
          <tr>
            <td><code>'use client'</code> / <code>'use server'</code></td>
            <td>Removed - every GioJS page hydrates; Server Actions get a TODO to become a <code>route.ts</code> handler</td>
          </tr>
          <tr>
            <td><code>next/server</code> in route handlers</td>
            <td><code>NextResponse.json</code>/<code>redirect</code> → <code>Response</code>, <code>NextRequest</code> → <code>GioRequest</code>; <code>request.nextUrl</code>, <code>headers.get()</code> and the <code>{'{ params }'}</code> argument get a TODO (GioJS passes a <code>GioRequest</code> with plain objects)</td>
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

      <h2>next.config → gio.toml</h2>
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
        <li><code>images.remotePatterns</code>/<code>domains</code> → <code>[[images.remote_patterns]]</code>, <code>deviceSizes</code>/<code>imageSizes</code> → <code>[images] allowed_widths</code></li>
        <li><code>i18n</code> → <code>[i18n]</code> (<code>localeDetection: false</code> → path detection only)</li>
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
        <li><code>basePath</code>, <code>trailingSlash</code>, <code>webpack</code>, <code>experimental</code> and the rest are listed in the report - GioJS compiles with esbuild, so webpack and SWC options don't apply</li>
      </ul>
      <p>
        An existing <code>gio.toml</code> is never overwritten. New tables are merged into it when
        no table or key would be defined twice; otherwise the converted sections go to
        <code> gio.migrated.toml</code> (not loaded by GioJS) for you to merge by hand. To convert
        just the config: <code>npx create-giojs migrate --config next.config.js</code>.
      </p>

      <h2>What needs a human</h2>
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
          <strong>Server Actions</strong> - become <code>route.ts</code> handlers called with
          <code> fetch()</code> or a form post
        </li>
        <li>
          <strong>Middleware</strong> - declarative redirects, rewrites, headers, and session or
          cookie guards move to <code>middleware.ts</code> (<code>defineMiddleware</code> from{' '}
          <code>@gio.js/core</code>) or <code>gio.toml</code>, and run in the Rust layer before
          routing. Imperative request interception belongs in a Node plugin
          (<code>GioNodePlugin</code> with an <code>onRequest</code> hook)
        </li>
        <li>
          <strong>Unsupported app router files</strong> - <code>template</code>, parallel
          (<code>@slot</code>) and intercepting routes, generated <code>icon</code>/
          <code>opengraph-image</code>/<code>sitemap</code> files are listed in the report
        </li>
      </ul>

      <div className="callout">
        Run <code>npx tsc --noEmit</code> after migrating: types imported from <code>next</code>
        (<code>NextPage</code>, <code>GetStaticProps</code>, <code>NextApiRequest</code>, ...)
        are flagged but not rewritten, and the compiler points at every place that still uses
        them.
      </div>
    </>
  );
}
