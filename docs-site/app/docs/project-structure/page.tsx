import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Getting Started</div>
      <h1>Project Structure</h1>
      <p className="page-subtitle">A tour of the files and folders in a GioJS app.</p>
      <p>A new project is intentionally small. Everything is driven by file conventions under app/.</p>
      <CodeBlock lang="text" code={`my-app/
  app/
    layout.tsx           # root layout: imports ./globals.css, exports metadata
    globals.css          # global styles (the CSS pipeline bundles and minifies them)
    (site)/              # route group: no URL segment
      layout.tsx         # the site's navigation and footer - hydrated, so its links soft-navigate
      page.tsx           # the / route
      about/page.tsx     # the /about route
      posts/[id]/page.tsx  # dynamic route -> /posts/:id
    not-found.tsx        # 404 page
    error.tsx            # error page
  components/            # your shared components (layout/SiteShell, layout/Navbar, layout/Footer)
  public/                # static files, served at the site root and under /public/
    fonts/               # the self-hosted .woff2 files gio.toml's [[fonts]] name
  gio.toml               # server configuration (fonts, images, security, ...)
  .env.example           # the environment variables the app reads - copy to .env.local
  .gitignore             # node_modules/, .gio/, .env*.local, build output
  AGENTS.md              # how the framework works, for coding agents
  package.json           # dev / build / start scripts
  tsconfig.json          # includes .gio/routes.d.ts for typed routes
  .gio/                  # generated at startup (route types, client build, caches) - not committed`} />

      <h2>The app directory</h2>
      <p>Routes are folders. A page.tsx (or .jsx) makes a folder a route; a layout.tsx wraps the pages beneath it. Dynamic segments use [brackets] ([...slug] and [[...slug]] for catch-alls), (group) folders organize routes without adding a URL segment, and _private folders are never routable. Any folder can also hold not-found, error and loading files for its part of the tree - see <a href="/docs/layouts-and-pages">Layouts &amp; Pages</a> and <a href="/docs/file-conventions">File Conventions</a>.</p>

      <h2>The root layout</h2>
      <p>
        <code>app/layout.tsx</code> renders the <code>&lt;html&gt;</code> document every
        page shares. It imports the global stylesheet and exports the site&apos;s default{' '}
        <a href="/docs/metadata">metadata</a> - a title template that each page&apos;s own{' '}
        <code>metadata</code> fills in:
      </p>
      <CodeBlock lang="tsx" code={`// app/layout.tsx
import type { LayoutProps, Metadata } from '@gio.js/core';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'My App', template: '%s | My App' },
  description: 'A GioJS application.',
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>{children}</body>
    </html>
  );
}`} />
      <p>
        The root layout is server-rendered HTML that never hydrates: put interactive
        components and context providers in a nested layout or the pages. That is why the
        starter&apos;s navigation lives in <code>app/(site)/layout.tsx</code>: a{' '}
        <code>GioLink</code> there prefetches and soft-navigates, while in the root layout it
        would be a plain link. The 404 and error pages sit outside the group and render the
        same <code>SiteShell</code> themselves. CSS can be
        imported from any page, layout or component, including CSS Modules - see{' '}
        <a href="/docs/css">CSS &amp; Styling</a>.
      </p>

      <h2>gio.toml</h2>
      <p>
        Server configuration, read once at startup. Every key is optional and an unknown key
        stops the server with a hint, so typos never go unnoticed. The starter self-hosts its
        fonts through <code>[[fonts]]</code>: the <code>.woff2</code> files ship in{' '}
        <code>public/fonts/</code>, are copied into <code>.gio/fonts/</code> at every start
        (no network needed) and are served from <code>/_gio/fonts</code> with preload links,
        instead of loading from a third-party CDN on every visit:
      </p>
      <CodeBlock lang="toml" code={`#:schema ./node_modules/@gio.js/server/gio.schema.json
[app]
name = "my-app"

[server]
host = "0.0.0.0"
port = 3000   # the PORT or GIO_PORT env var overrides it
http2 = true

[images]
allowed_widths = [640, 828, 1080, 1200, 1920]
quality = 80

[[fonts]]
family = "Fraunces"
url = "/public/fonts/fraunces-400-normal.woff2"

[[fonts]]
family = "Fraunces"
url = "/public/fonts/fraunces-400-italic.woff2"
style = "italic"

[[fonts]]
family = "JetBrains Mono"
url = "/public/fonts/jetbrains-mono-400-normal.woff2"

[[fonts]]
family = "JetBrains Mono"
url = "/public/fonts/jetbrains-mono-600-normal.woff2"
weight = 600`} />
      <p>
        The <code>#:schema</code> line gives editors autocomplete and inline docs. A font{' '}
        <code>url</code> can also be an <code>https://</code> address, downloaded on the
        first start - see <a href="/docs/font-optimization">Font Optimization</a> and{' '}
        <a href="/docs/configuration">gio.toml Configuration</a>.
      </p>

      <h2>.env.example and .gitignore</h2>
      <p>
        <code>.env.example</code> lists the variables the app reads, with comments - copy it
        to <code>.env.local</code> for your own values. <code>.env*.local</code> files and{' '}
        <code>.gio/</code> are git-ignored. (The scaffolder&apos;s package carries the file as{' '}
        <code>_gitignore</code>, because npm drops files named <code>.gitignore</code> from
        published packages, and renames it when it creates your project.) See{' '}
        <a href="/docs/guides/environment-variables">Environment Variables</a>.
      </p>

      <h2>public/</h2>
      <p>Files in public/ are served directly by the Rust layer - images, stylesheets, fonts. Static files never touch Node. Files answer at the site root as well as under /public/*: public/robots.txt is both /robots.txt and /public/robots.txt, so favicon.ico, manifest.json, apple-touch-icon.png, and .well-known/ files land where browsers and crawlers look for them. <code>gio export</code> writes public/ to both places in out/ too.</p>
      <ul>
        <li>A public file wins over a page with the same path (the Next.js precedence). In a static export, where a public file and a rendered page would need the same output file (public/index.html and app/page.tsx), the page is kept and the export lists the file as skipped.</li>
        <li>Not served at the root: dotfiles (except under .well-known/), symlinks, and a top-level public/_gio/ (the server&apos;s internal namespace). These stay reachable under /public/* only. Directory listings are never served.</li>
        <li>Guards, header rules, and <code>[[rate_limits]]</code> written for a file&apos;s /public/... URL also apply at its root URL, so protecting /public/members/* protects /members/* too, and /_gio/image serves the file only to visitors those guards admit. Redirects and rewrites match only the URL requested - see <a href="/docs/middleware">Middleware</a>.</li>
        <li>Root-served files use <code>Cache-Control: public, max-age=0, must-revalidate</code> with Last-Modified, so browsers revalidate instead of keeping an old copy after a deploy.</li>
        <li>The set of root-served files is indexed at startup, so the request path never pays a filesystem lookup. In development, edits to public/ refresh the index; in production, files added after startup need a restart.</li>
      </ul>

      <h2>Optional files</h2>
      <ul>
        <li><code>middleware.ts</code> - redirects, rewrites, headers and guards in TypeScript (<a href="/docs/middleware">Middleware</a>)</li>
        <li><code>gio.config.ts</code> - Node plugins (<a href="/docs/configuration">Configuration</a>)</li>
        <li><code>app/sitemap.ts</code>, <code>app/robots.ts</code>, <code>app/manifest.ts</code> - generated SEO files (<a href="/docs/metadata">Metadata &amp; SEO</a>)</li>
        <li><code>route.ts</code> in any folder - an API endpoint (<a href="/docs/route-handlers">Route Handlers</a>)</li>
      </ul>

      <div className="docs-pager">
        <a className="prev" href="/docs/installation">
          <span className="dir">Previous</span>
          <span className="label">← Installation</span>
        </a>
        <a className="next" href="/docs/guides/environment-variables">
          <span className="dir">Next</span>
          <span className="label">Environment Variables →</span>
        </a>
      </div>
    </>
  );
}
