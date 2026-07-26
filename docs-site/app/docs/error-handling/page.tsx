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
