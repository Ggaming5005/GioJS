import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Deployment</div>
      <h1>Static Export</h1>
      <p className="page-subtitle">
        Pre-render your whole app to plain HTML and deploy it free to any static
        host — Cloudflare Pages, GitHub Pages, Netlify, or an S3 bucket. Static when
        you can, server when you must.
      </p>

      <h2>Choose at create time</h2>
      <p>
        When you scaffold a project, pick <strong>Static site</strong> at the prompt.
        That wires <code>npm run build</code> to the exporter and drops the production
        server scripts.
      </p>
      <CodeBlock lang="bash" code={`npm create giojs@latest
# ? Which language?      › TypeScript / JavaScript
# ? What are you building? › Server app / Static site`} />
      <p>You can also pass it non-interactively:</p>
      <CodeBlock lang="bash" code={`npm create giojs@latest my-site -- --static`} />

      <h2>Build</h2>
      <p>
        Develop with <code>npm run dev</code> as usual. When you're ready to ship,
        export to the <code>out/</code> folder:
      </p>
      <CodeBlock lang="bash" code={`npm run build      # runs: gio export  →  ./out`} />
      <p>
        Every static route is rendered through the real SSR pipeline, so what you see
        in dev is what you get in <code>out/</code>. <code>getServerSideProps</code>
        runs at build time and its data is baked into the HTML.
      </p>

      <h2>Dynamic routes</h2>
      <p>
        A dynamic route like <code>app/posts/[id]/page.tsx</code> needs to know which
        paths to render. Export <code>getStaticPaths</code> to list them:
      </p>
      <CodeBlock lang="tsx" code={`export async function getStaticPaths() {
  const posts = await db.posts.all();
  return { paths: posts.map((p) => ({ params: { id: String(p.id) } })) };
}`} />
      <div className="callout">
        Dynamic routes without <code>getStaticPaths</code> are skipped with a warning —
        they can only be served by the GioJS server.
      </div>

      <h2>What can't be static</h2>
      <p>The exporter skips anything that needs a live server, and tells you what it skipped:</p>
      <ul>
        <li><code>route.ts</code> handlers and Server-Sent Events</li>
        <li>WebSocket (<code>wsHandler</code>) routes</li>
        <li>ISR revalidation (<code>export const revalidate</code> — there's no server to revalidate on)</li>
        <li>Runtime image optimization via <code>/_gio/image</code> (use pre-sized images)</li>
      </ul>
      <p>If you need any of those, use <strong>Server</strong> mode instead.</p>

      <h2>Deploy</h2>
      <p>
        <code>out/</code> is a self-contained static site — no runtime required. Drop it
        on any static host:
      </p>
      <CodeBlock lang="bash" code={`# Cloudflare Pages / Netlify: build command "npm run build", output dir "out"
# GitHub Pages: push ./out to a gh-pages branch
# Or serve locally to check:
npx serve out`} />
    </>
  );
}
