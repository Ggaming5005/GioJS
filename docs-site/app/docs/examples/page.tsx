import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

interface Example {
  title: string;
  description: string;
  features: string[];
}

const EXAMPLES: Example[] = [
  {
    title: 'Basic app (examples/basic-app)',
    description: 'A small app-router app touring the core features: pages, a dynamic route, an SSE endpoint, and a WebSocket endpoint, with a gio.toml exercising rate limits, i18n, and fonts.',
    features: [
      'Home page with a hydrated useState counter',
      'Static /about page and dynamic /posts/[id] page',
      '/ticker route.ts streaming Server-Sent Events via GioEventStream',
      '/chat route.ts exporting a wsHandler WebSocket echo handler',
      'gio.toml with [websocket], [[rate_limits]], [i18n], and [[fonts]] sections',
    ],
  },
  {
    title: 'Auth demo (examples/auth-demo)',
    description: 'Demonstrates the GioNodePlugin interface: an onRequest hook protects /admin/* routes by checking for a session=valid cookie and returning 403 Forbidden otherwise.',
    features: [
      'gio.config.ts registering the auth plugin via the plugins array',
      'Plugin onRequest hook that short-circuits with a 403 response',
      'Protected /admin/dashboard page reachable only with the session cookie',
    ],
  },
  {
    title: 'This documentation site',
    description: 'The site you are reading right now is a GioJS app. It was built as part of the P3.7 dogfooding phase to validate that GioJS can serve real-world docs sites with layout nesting and static caching.',
    features: [
      'Nested layouts (root layout + docs layout)',
      'All pages static with revalidate = false',
      'Redirect from / to /docs/getting-started',
      'Sidebar with server-side active link highlighting',
      'Mobile hamburger navigation (vanilla JS, no hydration)',
      'Copy-to-clipboard on code blocks',
    ],
  },
];

export default function ExamplesPage(): React.JSX.Element {
  return (
    <>
      <h1>Examples</h1>
      <p className="page-subtitle">
        Reference apps showing common GioJS patterns.
      </p>

      {EXAMPLES.map(ex => (
        <section key={ex.title}>
          <h2>{ex.title}</h2>
          <p>{ex.description}</p>
          <ul>
            {ex.features.map(f => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </section>
      ))}

      <h2>Common patterns</h2>

      <h3>Static page with layout</h3>
      <CodeBlock lang="typescript" code={`// app/about/page.tsx
import React from 'react';

export const revalidate = false;

export default function AboutPage(): React.JSX.Element {
  return <h1>About us</h1>;
}`} />

      <h3>Dynamic page with data fetching</h3>
      <CodeBlock lang="typescript" code={`// app/posts/[id]/page.tsx
import React from 'react';

interface Props {
  post: { title: string; body: string };
}

export const revalidate = 3600; // revalidate every hour

export async function getServerSideProps(ctx: {
  params: Record<string, string>;
}) {
  const post = await fetch(\`https://api.example.com/posts/\${ctx.params.id}\`)
    .then(r => r.json());
  return { post };
}

export default function PostPage({ post }: Props): React.JSX.Element {
  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
    </article>
  );
}`} />

      <h3>Redirect</h3>
      <CodeBlock lang="typescript" code={`export async function getServerSideProps() {
  return {
    redirect: { destination: '/new-path', permanent: false },
  };
}

export default function Page() { return null; }`} />
    </>
  );
}
