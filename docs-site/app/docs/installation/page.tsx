import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Getting Started</div>
      <h1>Installation</h1>
      <p className="page-subtitle">Scaffold a new GioJS app in seconds, or add it to an existing project.</p>

      <h2>System requirements</h2>
      <ul>
        <li>Node.js 20 or newer</li>
        <li>
          Linux x64 (glibc or musl/Alpine), macOS (Intel or Apple Silicon), or Windows x64.
          Linux arm64 has no prebuilt server binary yet - see{' '}
          <a href="/docs/known-issues">Known Limitations</a>.
        </li>
        <li>No Rust toolchain: the server binary for your platform is installed from npm</li>
      </ul>

      <h2>Create a new app</h2>
      <p>The scaffolder asks a few questions:</p>
      <CodeBlock lang="bash" code={`npm create giojs@latest
# or: pnpm create giojs   yarn create giojs   bun create giojs`} />
      <ul>
        <li><strong>Project name</strong> - also the folder (default <code>my-giojs-app</code>)</li>
        <li><strong>Language</strong> - TypeScript or JavaScript</li>
        <li>
          <strong>Server app or Static site</strong> - a server app has everything (SSR,
          caching, route handlers, actions, WebSockets); a static site builds to plain HTML
          with <code>gio export</code> (see <a href="/docs/static-export">Static Export</a>)
        </li>
        <li>
          <strong>Install dependencies</strong> - with the package manager you ran it with,
          which is also the one the printed next steps use
        </li>
      </ul>
      <p>
        It then creates a git repository with a first commit (when git is available and the
        folder is not already inside a repository). Start the dev server:
      </p>
      <CodeBlock lang="bash" code={`cd my-giojs-app
npm run dev        # http://localhost:3000`} />
      <p>
        Edits restart the server&apos;s render worker and reload the browser. The dev server
        also serves the error overlay and the dashboard at <code>/_gio/devtools</code>.
      </p>

      <h3>Options</h3>
      <p>
        Pass the directory as the first argument and flags after it to skip the questions -
        anything you pass is not asked. With npm, put the flags after <code>--</code>; pnpm,
        Yarn and Bun pass them straight through.
      </p>
      <CodeBlock lang="bash" code={`npm create giojs@latest my-app -- --ts --server
npm create giojs@latest my-app -- --js --static --no-git
npm create giojs@latest . -- --yes          # current (empty) folder, all defaults

npm create giojs@latest -- --help           # every option`} />
      <table>
        <thead>
          <tr><th>Flag</th><th>Effect</th></tr>
        </thead>
        <tbody>
          <tr><td><code>[directory]</code></td><td>Where the app goes (<code>.</code> = the current directory); the npm package name comes from its name</td></tr>
          <tr><td><code>--ts</code> / <code>--js</code></td><td>Language (default: TypeScript)</td></tr>
          <tr><td><code>--server</code> / <code>--static</code></td><td>Server app (default) or static site (<code>npm run build</code> exports to <code>out/</code>)</td></tr>
          <tr><td><code>--pm &lt;npm|pnpm|yarn|bun&gt;</code></td><td>Package manager for the install and the printed next steps (default: the one that ran the command)</td></tr>
          <tr><td><code>--install</code> / <code>--no-install</code></td><td>Install dependencies (default: install)</td></tr>
          <tr><td><code>--git</code> / <code>--no-git</code></td><td><code>git init</code> and a first commit (default: on)</td></tr>
          <tr><td><code>-f</code>, <code>--force</code></td><td>Scaffold into a directory that is not empty (refused by default)</td></tr>
          <tr><td><code>-y</code>, <code>--yes</code></td><td>Accept the defaults for every question not answered by a flag</td></tr>
          <tr><td><code>-h</code>, <code>--help</code> / <code>-v</code>, <code>--version</code></td><td>Usage / the scaffolder&apos;s version</td></tr>
        </tbody>
      </table>
      <ul>
        <li>
          <strong>Directory.</strong> A directory name that is not a valid npm package name
          (<code>My App</code>) gets a sanitized default (<code>my-app</code>) - offered at the
          prompt, or used directly with a note.
        </li>
        <li>
          <strong>Existing files.</strong> A directory that is not empty is refused, with a list
          of what is in it, unless you pass <code>--force</code> (template files then overwrite
          files of the same name). A fresh clone&apos;s <code>.git</code>,{' '}
          <code>README.md</code> and <code>LICENSE</code>, and editor folders, don&apos;t count.
        </li>
        <li>
          <strong>Git.</strong> When git is installed and the directory is not already inside a
          repository (a monorepo, for example), the scaffold runs <code>git init</code> and
          commits the files. After <code>--force</code>, the commit holds only what the scaffold
          created: files that were already in the directory (a <code>.env</code>, say) stay
          untracked and are listed for you to review. A failed commit - no{' '}
          <code>user.name</code> configured, say - leaves the repository and prints a note; it
          never fails the scaffold.
        </li>
        <li>
          <strong>Scripts and CI.</strong> Without a terminal (piped stdin, CI) nothing is asked:
          every option you did not pass takes its default, so a scripted run never hangs.
          Unknown flags are an error with a did-you-mean hint.
        </li>
        <li>
          <strong>Ctrl+C</strong> at any question exits without writing anything.
        </li>
      </ul>

      <h3>What you get</h3>
      <p>
        A small app that uses the framework&apos;s own features: file-based routes with a dynamic{' '}
        <code>posts/[id]</code> route (<code>getServerSideProps</code> plus{' '}
        <code>getStaticPaths</code>), the <a href="/docs/metadata">metadata API</a> for titles and
        descriptions, global CSS imported from <code>app/layout</code> through the{' '}
        <a href="/docs/css">CSS pipeline</a>, fonts self-hosted from <code>public/fonts/</code>{' '}
        with <a href="/docs/font-optimization"><code>[[fonts]]</code></a>, a{' '}
        <code>.gitignore</code>, an <code>.env.example</code>, and an <code>AGENTS.md</code> for
        coding agents. See <a href="/docs/project-structure">Project Structure</a>.
      </p>
      <p>
        A static site is the same app with <code>npm run build</code> wired to{' '}
        <code>gio export</code> and its fonts declared with <code>@font-face</code> in{' '}
        <code>app/globals.css</code>, since an export has no server to apply{' '}
        <code>[[fonts]]</code>.
      </p>

      <h3>Starter recipes</h3>
      <p>Guides for common additions, explaining what each adds and how to take it further:</p>
      <ul>
        <li><a href="/docs/guides/tailwind">Tailwind CSS</a></li>
        <li><a href="/docs/guides/authentication-example">Authentication example</a> - login, logout and a guarded page on <a href="/docs/authentication">encrypted cookie sessions</a></li>
        <li><a href="/docs/guides/database">Database example</a> - SQLite with server-only data access</li>
        <li><a href="/docs/guides/docker">Docker</a> - a production image from a standalone build</li>
      </ul>

      <h2>Add GioJS to an existing project</h2>
      <p>Install the packages:</p>
      <CodeBlock lang="bash" code={`npm install @gio.js/server @gio.js/core @gio.js/react react react-dom cross-env
npm install -D typescript @types/react @types/react-dom @types/node`} />
      <p>Add the scripts and an <code>app/</code> directory with a root layout and a page:</p>
      <CodeBlock lang="json" code={`{
  "type": "module",
  "scripts": {
    "dev": "cross-env NODE_ENV=development giojs-server",
    "build": "tsc --noEmit",
    "start": "cross-env NODE_ENV=production giojs-server"
  }
}`} />
      <CodeBlock lang="tsx" code={`// app/layout.tsx
import type { LayoutProps, Metadata } from '@gio.js/core';

export const metadata: Metadata = { title: 'My App' };

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
}

// app/page.tsx
export default function Home() {
  return <h1>Hello from GioJS</h1>;
}`} />
      <p>
        A <code>gio.toml</code> is optional - every setting has a production-ready default.
        For typed routes, add <code>&quot;.gio/routes.d.ts&quot;</code> to the{' '}
        <code>include</code> list of your <code>tsconfig.json</code> (the server writes it
        at startup), and add <code>.gio/</code> to <code>.gitignore</code>. Coming from
        Next.js? <code>npm create giojs@latest -- migrate</code> converts the project - see{' '}
        <a href="/docs/migration">Migrating from Next.js</a>.
      </p>

      <div className="docs-pager">
        <a className="prev" href="/docs/getting-started">
          <span className="dir">Previous</span>
          <span className="label">← Introduction</span>
        </a>
        <a className="next" href="/docs/project-structure">
          <span className="dir">Next</span>
          <span className="label">Project Structure →</span>
        </a>
      </div>
    </>
  );
}
