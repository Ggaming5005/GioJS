import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Examples',
  description: 'Reference apps showing common GioJS patterns.',
};

export const revalidate = false;

interface Example {
  /** The heading's id (its #anchor). */
  id: string;
  title: string;
  description: string;
  features: string[];
}

const EXAMPLES: Example[] = [
  {
    id: 'basic-app',
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
    id: 'auth-demo',
    title: 'Auth demo (examples/auth-demo)',
    description: 'A complete login flow on encrypted cookie sessions: a require_session guard verifies the session in Rust, and an auth plugin checks what is inside it.',
    features: [
      'lib/session.server.ts creating the session storage (createSessionStorage)',
      'Login form posting to a route.ts that checks DEMO_PASSWORD and commits the session',
      '[[guards]] require_session = true on /admin/*rest in gio.toml',
      'Dashboard reading the session in getServerSideProps (personalized, never cached)',
      'Logout route destroying the session cookie',
      'gio.config.ts registering createAuthPlugin (plugin onRequest returning 403)',
    ],
  },
  {
    id: 'docs-site',
    title: 'This documentation site',
    description: 'The site you are reading right now is a GioJS app (docs-site/ in the repository), exported to static HTML and served from a static host.',
    features: [
      'Nested layouts (root layout + docs layout)',
      'All pages static with revalidate = false, exported with the GioJS exporter',
      'A landing page at / and the docs under /docs, plus generated llms.txt and sitemap.xml',
      'Sidebar, breadcrumbs and prev/next links derived from one nav data file per area',
      'Search (Ctrl/Cmd K) over an index the build writes, matched in the browser',
      'Server-rendered syntax highlighting and copy buttons on code blocks',
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
        <section key={ex.id}>
          <h2 id={ex.id}>{ex.title}</h2>
          <p>{ex.description}</p>
          <ul>
            {ex.features.map(f => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </section>
      ))}

      <h2 id="common-patterns">Common patterns</h2>

      <h3 id="static-page-with-layout">Static page with layout</h3>
      <CodeBlock lang="typescript" title="app/about/page.tsx" code={`import React from 'react';

export const revalidate = false;

export default function AboutPage(): React.JSX.Element {
  return <h1>About us</h1>;
}`} />

      <h3 id="dynamic-page-with-data-fetching">Dynamic page with data fetching</h3>
      <CodeBlock lang="typescript" title="app/posts/[id]/page.tsx" code={`import React from 'react';
import type { GetServerSideProps } from '@gio.js/core';

interface Props {
  post: { title: string; body: string };
}

export const revalidate = 3600; // revalidate every hour

export const getServerSideProps: GetServerSideProps<Props, '/posts/:id'> = async (ctx) => {
  const post = await fetch(\`https://api.example.com/posts/\${ctx.params.id}\`)
    .then(r => r.json());
  return { props: { post } };
};

export default function PostPage({ post }: Props): React.JSX.Element {
  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
    </article>
  );
}`} />

      <h3 id="redirect">Redirect</h3>
      <CodeBlock lang="typescript" code={`export async function getServerSideProps() {
  return {
    redirect: { destination: '/new-path', permanent: false },
  };
}

export default function Page() { return null; }`} />
    </>
  );
}
