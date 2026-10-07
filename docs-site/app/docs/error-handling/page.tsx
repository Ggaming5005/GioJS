import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Error Handling',
  description: '404 and error UI per folder, with special files.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Error Handling</h1>
      <p className="page-subtitle">404 and error UI per folder, with special files.</p>

      <p>Two special files control the non-happy paths. Both may sit in any folder of <code>app/</code>:</p>
      <ul>
        <li><strong>not-found.tsx</strong> - rendered with status 404 when a page calls <code>notFound()</code>; the one in <code>app/</code> also answers unmatched URLs</li>
        <li><strong>error.tsx</strong> - rendered with status 500 when a render throws, and an error boundary in the browser</li>
      </ul>
      <p>
        For a page, the nearest file at or above its folder applies - route groups and
        dynamic folders included - and it renders inside the layouts of its own folder and
        the folders above it. Without any, GioJS serves clean built-in pages instead.
      </p>

      <h2 id="not-found">Not found</h2>
      <p>
        Call <code>notFound()</code> from <code>@gio.js/core</code> in{' '}
        <code>getServerSideProps</code> or while rendering, or return{' '}
        <code>{'{ notFound: true }'}</code> from <code>getServerSideProps</code> (see{' '}
        <a href="/docs/fetching-data">Fetching Data</a>). The response is a 404 with the
        nearest <code>not-found.tsx</code>:
      </p>
      <CodeBlock lang="text" code={`app/
  not-found.tsx          # unmatched URLs, and pages with no closer file
  shop/
    layout.tsx
    not-found.tsx        # /shop/* pages that call notFound() - inside shop/layout.tsx
    [id]/page.tsx`} />
      <CodeBlock lang="tsx" title="app/not-found.tsx" code={`export default function NotFound() {
  return <div><h1>404</h1><p>Page not found.</p></div>;
}`} />
      <p>
        URLs that match no route always get the <code>app/not-found.tsx</code> - they belong
        to no folder. A 404 is never cached, even on a page that exports{' '}
        <code>revalidate</code>: it can depend on anything <code>getServerSideProps</code>{' '}
        read, and a cached 404 would outlive the content appearing. When a cached page starts
        answering 404 - its data was deleted - the background revalidation that sees the 404
        evicts the cached copy, so the deleted page is not served for the rest of the
        stale-while-revalidate window. A <code>route.ts</code> handler that calls{' '}
        <code>notFound()</code> answers <code>{'{ "error": "Not Found" }'}</code> with
        status 404.
      </p>

      <h2 id="errors">Errors</h2>
      <p>
        When a page, its <code>getServerSideProps</code>, or a layout below the{' '}
        <code>error.tsx</code>&apos;s folder throws, the nearest <code>error.tsx</code>{' '}
        renders with status 500. An <code>error.tsx</code> does <em>not</em> catch errors of
        the layout in its own folder - it renders inside that layout - so those go to the{' '}
        <code>error.tsx</code> of a parent folder (the Next.js rule). An error in{' '}
        <code>app/layout.tsx</code> itself gets the built-in error page.
      </p>
      <p>
        The error page receives the failure via props as{' '}
        <code>{'{ error: { message, digest }, reset }'}</code> (the Next.js shape). In
        development <code>message</code> is the real error message; in production
        it is always the generic <code>Internal Server Error</code>, so nothing
        from the exception can leak into the page. <code>digest</code> is a short
        random error reference in both modes - show it so users can quote it:
      </p>
      <CodeBlock lang="tsx" title="app/error.tsx" code={`import type { ErrorPageProps } from '@gio.js/core';

export default function Error({ error, reset }: ErrorPageProps) {
  return (
    <div>
      <h1>Something went wrong</h1>
      {process.env.NODE_ENV === 'development' && <pre>{error.message}</pre>}
      {error.digest && <p>Error reference: <code>{error.digest}</code></p>}
      {reset && <button onClick={reset}>Try again</button>}
    </div>
  );
}`} />

      <h3 id="in-the-browser">In the browser</h3>
      <p>
        Every <code>error.tsx</code> is also a React error boundary in the hydrated page, so
        it ships in the client bundle of the pages below it (like a layout - importing
        server-only code from one rejects those bundles). When rendering throws after
        hydration - say an event handler sets state that a component cannot render - the
        nearest boundary replaces just its segment, and the layouts above it stay
        interactive. <code>reset()</code> renders the segment again. Errors thrown by event
        handlers themselves, outside rendering, are not render errors and never reach a
        boundary.
      </p>
      <p>
        In the browser, too, <code>message</code> is real only in development. In production
        it is the generic <code>Application Error</code>, and there is no{' '}
        <code>digest</code>: the boundary only ever sees an error thrown in the browser. That
        includes a part the server could not finish while streaming - React renders it again
        in the browser, and the boundary catches only what fails there. The server&apos;s
        failure is in the server log under its own digest; in the browser React reports it
        as a recoverable error on the console, never to the boundary. A{' '}
        <code>notFound()</code> that runs in the browser reaches the nearest boundary as{' '}
        <code>Not Found</code>; <code>not-found.tsx</code> files are server-only.
      </p>
      <div className="callout">
        <strong>Upgrading:</strong> <code>error.tsx</code> used to render only on the server.
        It is now client code, bundled into every page below its folder (<code>app/error.tsx</code>{' '}
        into every page) - so it must be browser-safe like a page component. An existing{' '}
        <code>error.tsx</code> that imports server-only code (a <code>*.server.ts</code>{' '}
        module, <code>server-only</code>, a Node builtin, a server-side logger) costs those
        pages their client bundles: they are still server-rendered but no longer hydrate, and
        the build log names the <code>error.tsx</code>. Report errors from it through a{' '}
        <code>route.ts</code> instead.
      </div>
      <p>
        <code>reset</code> exists only on a boundary caught in the browser: the 500 page the
        server renders is static HTML - link the user home or ask them to reload there.
      </p>

      <h3 id="streaming-and-loadingtsx">Streaming and loading.tsx</h3>
      <p>
        A failure is answered with a 404 or 500 page only while nothing has been sent yet.
        Under a <code>loading.tsx</code> that means: if the page throws (or calls{' '}
        <code>notFound()</code>) before it suspends, the response is still the error or
        not-found page, exactly as without the <code>loading.tsx</code>. Once the page has
        suspended, the status and the loading UI are on their way; an error after that is
        handled by React like any Suspense boundary - the browser renders the segment
        itself, and if it fails there too, the nearest <code>error.tsx</code> boundary shows
        it. So a page that suspends and <em>then</em> throws answers 200 under a{' '}
        <code>loading.tsx</code>, where without one it would have failed the whole render
        with a 500. A cacheable page, rendered completely before it is sent, gets the same
        answer as when it streams. Errors inside your own <code>&lt;Suspense&gt;</code>{' '}
        boundaries always get that client-side recovery; only a <code>notFound()</code>{' '}
        there still answers 404 while nothing has been sent. A render that recovered this
        way is never cached, even on a page with <code>revalidate</code> - with partial
        prerendering, its shell is not stored either.
      </p>

      <h2 id="production-error-responses">Production error responses</h2>
      <p>
        A production response never carries an error message or stack. Without
        an <code>app/error.tsx</code>, a failed render is answered with a plain
        page naming only the status and the error reference. The real message
        and stack are logged server-side under the same digest, so a user
        report finds the exact failure - and its <code>requestId</code> finds
        every other log line of that request (see{' '}
        <a href="/docs/observability">Observability</a>):
      </p>
      <CodeBlock lang="bash" code={`{"level":"error","msg":"ssr render failed","requestId":"0b8e3c52-7a1d-4f0e-9c3b-5d2a6e8f1a47","path":"/posts/7","digest":"3f9a1c0b7e2d","error":"connect ECONNREFUSED 10.0.0.5:5432","stack":"Error: connect ECONNREFUSED ..."}`} />
      <p>
        Production means anything other than <code>NODE_ENV=development</code>{' '}
        when the server starts: unset and <code>test</code> are production too.
        The Rust server makes this decision once and starts the Node worker with
        the matching <code>NODE_ENV</code>, so the two halves always agree.
      </p>

      <h2 id="development-error-overlay">Development error overlay</h2>
      <p>
        In development, SSR render errors - plus browser window errors and
        unhandled promise rejections - open a full-screen overlay instead of a
        bare 500. The overlay parses the stack, and for the topmost frame in
        your project it shows a <strong>codeframe</strong>: the failing line
        with four lines of context on each side, fetched from the dev-only{' '}
        <code>/_gio/devtools/codeframe</code> endpoint (reads are confined to
        source files inside the project root, checked after resolving
        symlinks).
      </p>
      <p>
        Every <code>file:line</code> in the stack is a link -{' '}
        <strong>clicking it opens the file at that line in your editor</strong>{' '}
        via <code>/_gio/devtools/open-in-editor</code>. The editor command comes
        from the first non-empty of <code>GIO_EDITOR</code>,{' '}
        <code>VISUAL</code>, <code>EDITOR</code>, defaulting to{' '}
        <code>code</code>; VS Code-family editors (code, cursor, windsurf,
        codium) get the <code>-g file:line</code> goto form, everything else a
        plain <code>file:line</code> argument.
      </p>
      <CodeBlock lang="bash" code={`# examples
GIO_EDITOR=cursor npm run dev
GIO_EDITOR="subl -w" npm run dev`} />
      <div className="callout">
        The overlay, the codeframe endpoint, and open-in-editor exist only in
        dev mode - none of it is compiled into production responses.
      </div>
      <p>
        Both endpoints only answer to localhost hosts, on connections from
        this machine. The codeframe endpoint
        refuses cross-site requests; open-in-editor takes same-origin{' '}
        <code>POST</code> only. The SSR error page follows the same rule: for
        any other host it leaves out the error message and stack (the
        terminal still logs them). If you open the dev server through a LAN
        IP or hostname, add it to <code>[dev] allowed_hosts</code> in{' '}
        <code>gio.toml</code> (see{' '}
        <a href="/docs/configuration">Configuration</a>) or error details,
        codeframes and editor links will not work from there.
      </p>

      <h2 id="static-export">Static export</h2>
      <p>
        <code>gio export</code> writes your <code>app/not-found.tsx</code> (or the built-in
        default) to <code>out/404.html</code>, which static hosts like Cloudflare Pages,
        GitHub Pages, and Netlify serve with a real 404 status for unknown URLs - without
        it, many hosts fall back to the home page with a 200. Pages that call{' '}
        <code>notFound()</code> at export time are skipped - nothing is written for them -
        and a page that fails to render is listed with its error reference instead of
        being exported as an error page. That includes an error caught by a{' '}
        <code>&lt;Suspense&gt;</code> or <code>loading.tsx</code> boundary: an exported page
        never hydrates, so the browser could never recover the boundary and its fallback
        would stay on screen.
      </p>

      <h2 id="api-routes">API routes</h2>
      <p>
        Errors thrown in <code>route.ts</code> handlers are logged server-side and
        answered with a JSON <code>500</code>,{' '}
        <code>{'{ "error": "Internal Server Error", "digest": "..." }'}</code> -
        internal details never reach the client; the digest matches the log
        line. A handler that calls <code>notFound()</code> gets a JSON <code>404</code>.
        Requests for methods a handler file doesn&apos;t export get{' '}
        <code>405</code> with an <code>Allow</code> header.
      </p>
    </>
  );
}
