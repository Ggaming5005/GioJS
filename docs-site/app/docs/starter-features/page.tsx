import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Getting Started</div>
      <h1>Starter Features</h1>
      <p className="page-subtitle">
        Start a new app with Tailwind, forms, login, a database, Docker and CI already wired up,
        or add them to an existing app with one command.
      </p>

      <h2>When you create an app</h2>
      <p>
        <code>create-giojs</code> asks which features to add (space toggles, enter confirms).
        Flags skip the question:
      </p>
      <CodeBlock lang="bash" code={`npm create giojs@latest my-app -- --tailwind --auth --db
npm create giojs@latest my-app -- --features tailwind,api,auth,db,docker,ci`} />
      <p>
        Features work with both the TypeScript and the JavaScript template. A static site
        (<code>--static</code>) can take <code>tailwind</code> and <code>ci</code>; the others
        need the GioJS server, so they are refused there.
      </p>

      <h2>In an existing app</h2>
      <CodeBlock lang="bash" code={`npx create-giojs add tailwind
npx create-giojs add auth db --dry-run   # show what would change
npx create-giojs add docker --cwd ./my-app`} />
      <ul>
        <li>
          <strong>Your changes win.</strong> If a file a new feature adds already exists with
          different content (or a <code>package.json</code> script is already set to something
          else), nothing at all is written: the command lists each conflict with a diff of what
          it would change. Merge it by hand, or rerun with <code>--force</code> to overwrite.
        </li>
        <li>
          <strong>Safe to run again.</strong> A feature whose files all exist is already set
          up: your edits to them (the login page, say) are kept and listed, and nothing else
          changes - so <code>add auth db</code> after customizing auth just adds the database.
          Additions merge into what is there: <code>gio.toml</code> keys go into the existing
          table, <code>[[guards]]</code> entries are added once per path, and{' '}
          <code>.env.example</code> / <code>.gitignore</code> lines are added only when missing.
        </li>
        <li>
          The language, the build target and the package manager are read from the project
          (<code>tsconfig.json</code>, a <code>gio export</code> build script, the lockfile).
          Install the new dependencies afterwards - the command prints the exact command.
        </li>
      </ul>

      <h2>The features</h2>
      <table>
        <thead>
          <tr><th>Feature</th><th>What it adds</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>tailwind</code></td>
            <td>
              Tailwind CSS v4 through its CLI: <code>app/tailwind.css</code> builds into{' '}
              <code>app/tailwind.out.css</code>, which the root layout imports.{' '}
              <code>npm run dev</code> runs the watcher next to the server; build and start build
              the stylesheet first. See <a href="/docs/guides/tailwind">the Tailwind guide</a>.
            </td>
          </tr>
          <tr>
            <td><code>api</code></td>
            <td>
              <code>app/api/guestbook/route.ts</code> (GET/POST JSON with <code>req.json()</code>{' '}
              validation: 201, 400, 415, 422) and <code>app/guestbook/page.tsx</code>, a page
              action rendered with <code>&lt;GioForm&gt;</code>: it works without JavaScript,
              answers invalid input with 422 and <code>actionData</code>, and redirects after
              success. See <a href="/docs/forms">Forms</a> and{' '}
              <a href="/docs/route-handlers">Route Handlers</a>.
            </td>
          </tr>
          <tr>
            <td><code>auth</code></td>
            <td>
              Cookie sessions (<code>lib/session.server.ts</code>), a login page whose action
              checks demo credentials in constant time, a logout route, and{' '}
              <code>/dashboard</code> protected by a <code>require_session</code> guard and{' '}
              <code>/login</code> rate-limited in <code>gio.toml</code>. See{' '}
              <a href="/docs/guides/authentication-example">the authentication example</a>.
            </td>
          </tr>
          <tr>
            <td><code>db</code></td>
            <td>
              SQLite with Drizzle ORM on Node&apos;s built-in <code>node:sqlite</code> (Node
              22.16+): a schema, SQL migrations with a seed, <code>lib/db.server.ts</code>, and a{' '}
              <code>/notes</code> page that lists and adds rows. See{' '}
              <a href="/docs/guides/database">the database example</a>.
            </td>
          </tr>
          <tr>
            <td><code>docker</code></td>
            <td>
              A multi-stage <code>Dockerfile</code> built with <code>gio build standalone</code>{' '}
              (a slim, non-root runtime image with a health check), <code>.dockerignore</code>{' '}
              and <code>docker-compose.yml</code>. See{' '}
              <a href="/docs/guides/docker">Deploying with Docker</a>.
            </td>
          </tr>
          <tr>
            <td><code>ci</code></td>
            <td>
              <code>.github/workflows/ci.yml</code>: installs with your package manager,
              typechecks (TypeScript), runs the tests when there is a <code>test</code> script,
              and builds the standalone folder (or the static export), kept as an artifact.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Each feature also adds a short note to the project&apos;s <code>AGENTS.md</code>, so
        coding agents know where it lives.
      </p>
    </>
  );
}
