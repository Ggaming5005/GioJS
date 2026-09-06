import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Error Handling</h1>
      <p className="page-subtitle">Custom 404 and 500 pages with special files.</p>

      <p>Two special files at the root of <code>app/</code> control the non-happy paths:</p>
      <ul>
        <li><strong>not-found.tsx</strong> - rendered with status 404 for unmatched routes</li>
        <li><strong>error.tsx</strong> - rendered with status 500 when a page render throws</li>
      </ul>
      <p>
        Both render through your normal layout pipeline (root layout included),
        server-side. If neither exists, GioJS serves clean built-in pages instead.
      </p>

      <CodeBlock lang="tsx" code={`// app/not-found.tsx
export default function NotFound() {
  return <div><h1>404</h1><p>Page not found.</p></div>;
}`} />

      <p>
        The error page receives the failure via props. The message is worth
        showing only in development:
      </p>
      <CodeBlock lang="tsx" code={`// app/error.tsx
export default function Error({ error }: { error?: { message: string } }) {
  return (
    <div>
      <h1>Something went wrong</h1>
      {process.env.NODE_ENV === 'development' && <pre>{error?.message}</pre>}
    </div>
  );
}`} />

      <h2>Development error overlay</h2>
      <p>
        In development, SSR render errors - plus browser window errors and
        unhandled promise rejections - open a full-screen overlay instead of a
        bare 500. The overlay parses the stack, and for the topmost frame in
        your project it shows a <strong>codeframe</strong>: the failing line
        with four lines of context on each side, fetched from the dev-only{' '}
        <code>/_gio/devtools/codeframe</code> endpoint (reads are confined to
        source files inside the project root).
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

      <h2>Static export</h2>
      <p>
        <code>gio export</code> writes your 404 page (or the built-in default) to{' '}
        <code>out/404.html</code>, which static hosts like Cloudflare Pages, GitHub
        Pages, and Netlify serve with a real 404 status for unknown URLs - without
        it, many hosts fall back to the home page with a 200.
      </p>

      <h2>API routes</h2>
      <p>
        Errors thrown in <code>route.ts</code> handlers are logged server-side and
        answered with a JSON <code>500</code> - internal details never reach the
        client. Requests for methods a handler file doesn&apos;t export get{' '}
        <code>405</code> with an <code>Allow</code> header.
      </p>
    </>
  );
}
