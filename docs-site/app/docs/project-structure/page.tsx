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
    layout.tsx        # root layout (wraps every page)
    page.tsx          # the / route
    about/page.tsx    # the /about route
    posts/[id]/page.tsx  # dynamic route -> /posts/:id
  components/          # your shared components
  public/              # static assets served as-is
  gio.toml             # server configuration`} />
      <h2>The app directory</h2>
      <p>Routes are folders. A page.tsx (or .jsx) makes a folder a route; a layout.tsx wraps the pages beneath it. Dynamic segments use [brackets] ([...slug] and [[...slug]] for catch-alls), (group) folders organize routes without adding a URL segment, and _private folders are never routable.</p>
      <h2>public/</h2>
      <p>Files in public/ are served directly by the Rust layer - images, stylesheets, fonts. Static files never touch Node. Files answer at the site root as well as under /public/*: public/robots.txt is both /robots.txt and /public/robots.txt, so favicon.ico, manifest.json, apple-touch-icon.png, and .well-known/ files land where browsers and crawlers look for them. <code>gio export</code> writes public/ to both places in out/ too.</p>
      <ul>
        <li>A public file wins over a page with the same path (the Next.js precedence). In a static export, where a public file and a rendered page would need the same output file (public/index.html and app/page.tsx), the page is kept and the export lists the file as skipped.</li>
        <li>Not served at the root: dotfiles (except under .well-known/), symlinks, and a top-level public/_gio/ (the server&apos;s internal namespace). These stay reachable under /public/* only. Directory listings are never served.</li>
        <li>Guards, header rules, and <code>[[rate_limits]]</code> written for a file&apos;s /public/... URL also apply at its root URL, so protecting /public/members/* protects /members/* too. Redirects and rewrites match only the URL requested - see <a href="/docs/middleware">Middleware</a>.</li>
        <li>Root-served files use <code>Cache-Control: public, max-age=0, must-revalidate</code> with Last-Modified, so browsers revalidate instead of keeping an old copy after a deploy.</li>
        <li>The set of root-served files is indexed at startup, so the request path never pays a filesystem lookup. In development, edits to public/ refresh the index; in production, files added after startup need a restart.</li>
      </ul>
    </>
  );
}
