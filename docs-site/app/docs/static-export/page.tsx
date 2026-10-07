import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../components/PmTabs.tsx';

export const metadata: Metadata = {
  title: 'Static Export',
  description:
    'Pre-render your whole app to plain HTML and deploy it free to any static host - ' +
    'Cloudflare Pages, GitHub Pages, Netlify, or an S3 bucket. Static when you can, server ' +
    'when you must.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Static Export</h1>
      <p className="page-subtitle">
        Pre-render your whole app to plain HTML and deploy it free to any static
        host - Cloudflare Pages, GitHub Pages, Netlify, or an S3 bucket. Static when
        you can, server when you must.
      </p>

      <h2 id="choose-at-create-time">Choose at create time</h2>
      <p>
        When you scaffold a project, pick <strong>Static site</strong> at the prompt.
        That wires <code>npm run build</code> to the exporter (after a{' '}
        <code>tsc --noEmit</code> typecheck in TypeScript projects), drops the production
        server scripts, and declares the starter&apos;s fonts with <code>@font-face</code> in{' '}
        <code>app/globals.css</code> instead of <code>[[fonts]]</code> (below).
      </p>
      <CodeBlock lang="bash" code={`npm create giojs@latest
# ? Which language?      › TypeScript / JavaScript
# ? What are you building? › Server app / Static site`} />
      <p>You can also pass it non-interactively:</p>
      <PmTabs command={`npm create giojs@latest my-site -- --static`} />

      <h2 id="build">Build</h2>
      <p>
        Develop with <code>npm run dev</code> as usual. When you're ready to ship,
        export to the <code>out/</code> folder:
      </p>
      <PmTabs command={`npm run build      # runs: gio export  →  ./out`} />
      <p>
        Every static route is rendered through the real SSR pipeline, so what you see
        in dev is what you get in <code>out/</code>. <code>getServerSideProps</code>
        runs at build time and its data is baked into the HTML. The export loads the
        project's <code>.env</code> files first, with the same{' '}
        <a href="/docs/configuration">precedence</a> as the server (<code>production</code>{' '}
        mode unless <code>NODE_ENV=development</code>).
      </p>
      <p>
        Every export also writes <code>out/404.html</code> - your{` `}
        <code>app/not-found.tsx</code> if you have one, otherwise the built-in 404
        page - so static hosts return a real 404 for unknown URLs instead of
        falling back to the home page.
      </p>
      <p>
        The export runs in production mode, like the server: React&apos;s production
        build, and no error messages or stacks in the HTML (dev mode only with{' '}
        <code>NODE_ENV=development</code>). A page that fails to render is skipped
        and listed with an error reference; the matching log line on stderr has the
        message and stack.
      </p>

      <h2 id="interactive-pages">Interactive pages</h2>
      <p>
        Exported pages hydrate exactly like served ones. The exporter builds the
        client bundles in production mode into <code>out/_next/static/chunks/</code> and
        every page carries the same hydration envelope and bootstrap script the server
        renders, so state, effects, event handlers, and <code>GioLink</code> soft
        navigation all work on a static host.
      </p>
      <ul>
        <li>
          <code>GIO_PUBLIC_*</code> values are frozen into the bundles (and the HTML) at
          export time - re-export after changing them.
        </li>
        <li>
          Props come from the build-time <code>getServerSideProps</code> run; they ship in
          the page as JSON, so never return secrets from it.
        </li>
        <li>
          A route whose bundle fails to build, or is rejected for importing server-only
          code, still exports as plain HTML (no client JS), and the exporter lists it with
          the reason.
        </li>
        <li>
          Soft navigation fetches the target page&apos;s HTML (<code>/about</code> →{' '}
          <code>out/about/index.html</code>); a URL that was never exported falls back to a
          full page load, so the host&apos;s <code>404.html</code> shows with a real 404.
        </li>
        <li>
          Serve <code>out/</code> at the domain root: pages reference their chunks as{' '}
          <code>/_next/static/chunks/...</code>.
        </li>
      </ul>

      <h2 id="public-and-robotstxt">public/ and robots.txt</h2>
      <p>
        <code>public/</code> is copied into <code>out/</code> twice, matching the server: at
        the site root, so <code>/favicon.ico</code>, <code>/robots.txt</code>,{' '}
        <code>/manifest.json</code>, and <code>/.well-known/...</code> resolve on any static
        host, and under <code>out/public/</code> for links written as{' '}
        <code>/public/...</code>.
      </p>
      <ul>
        <li>
          The root copy skips what the server never serves at the root: dotfiles (except
          under <code>.well-known/</code>), symlinks, and a top-level <code>_gio/</code>.
        </li>
        <li>
          A rendered page keeps its output file: <code>public/index.html</code> next to{' '}
          <code>app/page.tsx</code> stays at <code>/public/index.html</code> only, and the
          exporter lists it as skipped.
        </li>
        <li>
          <code>app/sitemap.ts</code>, <code>app/robots.ts</code> and{' '}
          <code>app/manifest.ts</code> are written as <code>sitemap.xml</code>,{' '}
          <code>robots.txt</code> and <code>manifest.webmanifest</code> (see{' '}
          <a href="/docs/metadata">Metadata &amp; SEO</a>); set <code>GIO_SITE_URL</code> so
          their relative URLs become absolute. Without those modules the exporter generates{' '}
          <code>robots.txt</code> (and <code>sitemap.xml</code> listing every exported page
          when <code>GIO_SITE_URL</code> is set).
        </li>
        <li>
          Either way, a <code>public/</code> file of the same name wins - as on the server -
          and a module it shadows is listed as skipped.
        </li>
        <li>
          Page <code>metadata</code> / <code>generateMetadata</code> run at export time; relative
          Open Graph and canonical URLs resolve against <code>metadataBase</code> or{' '}
          <code>GIO_SITE_URL</code>.
        </li>
      </ul>

      <h2 id="dynamic-routes">Dynamic routes</h2>
      <p>
        A dynamic route like <code>app/posts/[id]/page.tsx</code> needs to know which
        paths to render. Export <code>getStaticPaths</code> to list them:
      </p>
      <CodeBlock lang="tsx" code={`export async function getStaticPaths() {
  const posts = await db.posts.all();
  return { paths: posts.map((p) => ({ params: { id: String(p.id) } })) };
}`} />
      <p>
        Catch-all params take the same <code>/</code>-joined string the page receives (an
        array of segments works too), and an optional catch-all exports its bare parent when the
        param is omitted or empty:
      </p>
      <CodeBlock lang="tsx" title="app/docs/[[...slug]]/page.tsx" code={`export function getStaticPaths() {
  return {
    paths: [
      { params: {} },                        // out/docs/index.html
      { params: { slug: 'guides/setup' } },  // out/docs/guides/setup/index.html
      { params: { slug: ['api', 'ref'] } },  // out/docs/api/ref/index.html
    ],
  };
}`} />
      <p>
        Entries missing a required param, or whose values contain empty, <code>.</code> or{' '}
        <code>..</code> segments or a backslash, are skipped with a reason instead of being
        written - nothing is ever written outside <code>out/</code>.
      </p>
      <div className="callout">
        Dynamic routes without <code>getStaticPaths</code> are skipped with a warning -
        they can only be served by the GioJS server.
      </div>

      <h2 id="what-cant-be-static">What can't be static</h2>
      <p>The exporter skips anything that needs a live server, and tells you what it skipped:</p>
      <ul>
        <li><code>route.ts</code> handlers and Server-Sent Events</li>
        <li>WebSocket (<code>wsHandler</code>) routes</li>
        <li>ISR revalidation (<code>export const revalidate</code> - there's no server to revalidate on)</li>
        <li>
          Runtime image optimization via <code>/_gio/image</code>: <code>GioImage</code>{' '}
          renders its plain <code>src</code> in an export (no <code>srcset</code>), so ship
          pre-sized images
        </li>
        <li>
          <code>gio.toml</code> settings the Rust server applies, such as{' '}
          <code>[[fonts]]</code>: declare fonts with <code>@font-face</code> in an imported
          stylesheet instead - <code>url()</code>s to files next to it (or{' '}
          <code>../public/fonts/x.woff2</code>) are bundled with hashed names
        </li>
      </ul>
      <p>If you need any of those, use <strong>Server</strong> mode instead.</p>

      <h2 id="deploy">Deploy</h2>
      <p>
        <code>out/</code> is a self-contained static site - no runtime required. Drop it
        on any static host:
      </p>
      <CodeBlock lang="bash" code={`# Cloudflare Pages / Netlify: build command "npm run build", output dir "out"
# GitHub Pages: push ./out to a gh-pages branch
# Or serve locally to check:
npx serve out`} />
    </>
  );
}
