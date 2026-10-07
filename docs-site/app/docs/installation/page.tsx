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
      <p>The scaffolder asks a few questions with arrow-key prompts:</p>
      <CodeBlock lang="bash" code={`npm create giojs@latest
# or: pnpm create giojs   yarn create giojs   bun create giojs`} />
      <ul>
        <li><strong>Project name</strong> - also the folder; it must be a valid npm package name, and a sanitized default is offered</li>
        <li><strong>Language</strong> - TypeScript or JavaScript</li>
        <li>
          <strong>Server app or Static site</strong> - a server app has everything (SSR,
          caching, route handlers, actions, WebSockets); a static site builds to plain HTML
          with <code>gio export</code> (see <a href="/docs/static-export">Static Export</a>)
        </li>
        <li>
          <strong>Features</strong> - optional starters added on top: Tailwind CSS, an API
          route and form example, authentication, a database, a Dockerfile and a CI workflow
        </li>
      </ul>
      <p>
        It then installs dependencies with the package manager you ran it with and creates a
        git repository with a first commit (when git is available and the folder is not
        already inside a repository). Start the dev server:
      </p>
      <CodeBlock lang="bash" code={`cd my-app
npm run dev        # http://localhost:3000`} />
      <p>
        Edits restart the server&apos;s render worker and reload the browser. The dev server
        also serves the error overlay and the dashboard at <code>/_gio/devtools</code>.
      </p>

      <h3>Without prompts</h3>
      <p>
        Pass a directory and flags to skip the questions - useful in scripts and CI, where
        the scaffolder never waits for input when stdin is not a terminal:
      </p>
      <CodeBlock lang="bash" code={`npm create giojs@latest my-app -- --ts --server --tailwind --auth
npm create giojs@latest . -- --yes          # current (empty) folder, all defaults

npm create giojs@latest -- --help           # every option`} />
      <table>
        <thead>
          <tr><th>Flag</th><th>Effect</th></tr>
        </thead>
        <tbody>
          <tr><td><code>--ts</code> / <code>--js</code></td><td>Language</td></tr>
          <tr><td><code>--server</code> / <code>--static</code></td><td>Server app or static site</td></tr>
          <tr><td><code>--tailwind</code>, <code>--api</code>, <code>--auth</code>, <code>--db</code>, <code>--docker</code>, <code>--ci</code></td><td>Add starter features (or <code>--features tailwind,auth</code>)</td></tr>
          <tr><td><code>--pm &lt;npm|pnpm|yarn|bun&gt;</code></td><td>Package manager for the install and the printed next steps (default: the one that ran the command)</td></tr>
          <tr><td><code>--no-install</code></td><td>Skip installing dependencies</td></tr>
          <tr><td><code>--no-git</code></td><td>Skip <code>git init</code> and the first commit</td></tr>
          <tr><td><code>--force</code></td><td>Scaffold into a non-empty folder (refused by default)</td></tr>
          <tr><td><code>-y</code>, <code>--yes</code></td><td>Accept the defaults for every question not answered by a flag</td></tr>
          <tr><td><code>-h</code>, <code>--help</code> / <code>-v</code>, <code>--version</code></td><td>Usage / the scaffolder&apos;s version</td></tr>
        </tbody>
      </table>
      <p>With npm, put the flags after <code>--</code>; pnpm, Yarn and Bun pass them straight through.</p>

      <h3>Starter recipes</h3>
      <p>Each feature has a guide explaining what it adds and how to take it further:</p>
      <ul>
        <li><a href="/docs/guides/tailwind">Tailwind CSS</a></li>
        <li><a href="/docs/guides/authentication-example">Authentication example</a> - login, logout and a guarded page on <a href="/docs/authentication">encrypted cookie sessions</a></li>
        <li><a href="/docs/guides/database">Database example</a> - SQLite with server-only data access</li>
        <li><a href="/docs/guides/docker">Docker</a> - a production image from a standalone build</li>
      </ul>
      <p>
        Add a feature to an existing app later with{' '}
        <code>npx create-giojs add &lt;feature&gt;</code>; it never overwrites files you
        changed.
      </p>

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
